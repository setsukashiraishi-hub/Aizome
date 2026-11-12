// ブロックでつくるモード。ふつうのエディタとは別の画面。
// 左：ブロックの一覧と組み立てる場所（Scratch のような見た目）／右：できたプログラム（言語を選べる）
import * as Blockly from "blockly/core";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { h } from "../core/dom";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { confirmBox, inputBox } from "../ui/dialog";
import { dialog, fs } from "../core/platform";
import { editorTheme, syntaxColors } from "../editor/theme";
import { BLOCK_LANGS, COLORS, setBlockLang, setupBlockly, workspaceToCode, type BlockLang } from "./defs";
import { toolbox } from "./toolbox";

export interface BlocksDeps {
  /** できたコードを実行する（拡張子つきの名前で一時ファイルに書いて ▶ 実行と同じ流れで） */
  run(code: string, ext: string): Promise<void>;
  /** できたコードを、ふつうのエディタの新しいタブで開く */
  openInEditor(code: string, ext: string): void;
}

const STORE = "aizome.blocks.v1";

function load(): { lang: BlockLang; state: object | null } {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const v = JSON.parse(raw);
      if (BLOCK_LANGS.some((l) => l.id === v.lang)) return { lang: v.lang, state: v.state ?? null };
    }
  } catch {
    // 読めなければ、はじめから
  }
  return { lang: "python", state: null };
}

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

class BlocksPage {
  private el: HTMLElement | null = null;
  private ws: Blockly.WorkspaceSvg | null = null;
  private code: EditorView | null = null;
  private langConf = new Compartment();
  private lang: BlockLang = "python";
  private deps: BlocksDeps | null = null;
  private timer: number | undefined;
  private resizeObs: ResizeObserver | null = null;

  get isOpen() {
    return !!this.el;
  }

  setDeps(deps: BlocksDeps) {
    this.deps = deps;
  }

  toggle() {
    if (this.el) this.close();
    else this.open();
  }

  open() {
    if (this.el) return;
    setupBlockly();
    // 変数の名前を聞く小窓などを、ブラウザのものではなくアプリのものにする（アプリの中では prompt が出ないことがあるため）
    Blockly.dialog.setPrompt((message, defaultValue, callback) => {
      void inputBox({ title: message, value: defaultValue, okLabel: "OK" }).then((v) => callback(v));
    });
    Blockly.dialog.setConfirm((message, callback) => {
      void confirmBox("確認", message, "OK").then((ok) => callback(ok));
    });
    Blockly.dialog.setAlert((message, callback) => {
      toast(message, "info", 5000);
      callback?.();
    });
    const saved = load();
    this.lang = saved.lang;
    setBlockLang(this.lang);

    const langSelect = h(
      "select",
      { class: "select blocks-lang", "aria-label": "言語", title: "どの言語のプログラムにするか" },
      ...BLOCK_LANGS.map((l) => h("option", { value: l.id, selected: l.id === this.lang }, l.label)),
    ) as HTMLSelectElement;
    langSelect.addEventListener("change", () => this.setLang(langSelect.value as BlockLang));

    const btn = (iconName: string, text: string, title: string, onclick: () => void, extra = "") =>
      h("button", { class: `btn small ${extra}`, type: "button", title, onclick }, h("span", { html: icon(iconName, 14) }), h("span", {}, text));

    const head = h(
      "div",
      { class: "blocks-head" },
      h("h2", {}, "ブロックでつくる"),
      h("label", { class: "blocks-lang-label" }, "言語", langSelect),
      h("div", { class: "blocks-spacer" }),
      btn("play", "実行", "できたプログラムを動かす（下のターミナルに出ます）", () => void this.run(), "primary"),
      btn("files", "エディタで開く", "できたプログラムを、ふつうのエディタの新しいタブで開く", () => this.openInEditor()),
      btn("copy", "コピー", "できたプログラムをコピー", () => void this.copy()),
      btn("save", "保存", "ブロックをファイルに保存（.aizblocks）", () => void this.saveFile()),
      btn("folder", "開く", "保存したブロックを開く", () => void this.openFile()),
      btn("trash", "ぜんぶ消す", "組み立てたブロックをぜんぶ消す", () => void this.clearAll()),
      h("button", { class: "icon-btn", type: "button", title: "閉じる（Esc）", "aria-label": "閉じる", html: icon("x", 16), onclick: () => this.close() }),
    );
    const area = h("div", { class: "blocks-area" });
    const codeHost = h("div", { class: "blocks-code-host" });
    const codeTitle = h("div", { class: "blocks-code-title" }, this.codeTitle());
    const resizer = h("div", { class: "blocks-resizer", title: "幅を変える" });
    const codePane = h("div", { class: "blocks-code" }, codeTitle, codeHost);
    const body = h("div", { class: "blocks-body" }, area, resizer, codePane);
    this.el = h("div", { class: "blocks-page", role: "dialog", "aria-label": "ブロックでつくる" }, head, body);
    document.body.append(this.el);
    document.addEventListener("keydown", this.onKey, true);

    // 右：できたプログラム（読むだけ）
    this.code = new EditorView({
      parent: codeHost,
      state: EditorState.create({
        doc: "",
        extensions: [lineNumbers(), editorTheme, syntaxColors, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, this.langConf.of([])],
      }),
    });
    void this.loadLanguage();

    // 左：ブロック
    this.ws = Blockly.inject(area, {
      toolbox: toolbox() as unknown as Blockly.utils.toolbox.ToolboxDefinition,
      renderer: "zelos",
      theme: this.theme(),
      grid: { spacing: 24, length: 2, colour: css("--border", "#3a4152"), snap: true },
      zoom: { controls: true, wheel: true, startScale: 0.8, maxScale: 2, minScale: 0.4, scaleSpeed: 1.15 },
      trashcan: true,
      move: { scrollbars: true, drag: true, wheel: false },
      sounds: false,
    });
    // 「関数」のカテゴリに「値を返す」も並べる
    this.ws.registerToolboxCategoryCallback("PROCEDURE", (ws) => {
      const items = (Blockly.Procedures.flyoutCategory as unknown as (w: Blockly.WorkspaceSvg, xml: boolean) => object[])(ws, false);
      return [...items, { kind: "block", type: "aiz_return" }] as Blockly.utils.toolbox.FlyoutItemInfoArray;
    });
    if (saved.state) {
      try {
        Blockly.serialization.workspaces.load(saved.state, this.ws);
      } catch {
        toast("前のブロックを読みこめませんでした。はじめからにします", "warn", 5000);
      }
    } else this.starter();
    this.ws.addChangeListener((e) => {
      if (e.isUiEvent) return;
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.refresh(), 120);
    });
    this.refresh();

    // 幅の変更
    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = codePane.getBoundingClientRect().width;
      const move = (ev: PointerEvent) => {
        codePane.style.width = `${Math.min(Math.max(260, startW - (ev.clientX - startX)), window.innerWidth * 0.7)}px`;
        Blockly.svgResize(this.ws!);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    this.resizeObs = new ResizeObserver(() => this.ws && Blockly.svgResize(this.ws));
    this.resizeObs.observe(area);
  }

  close() {
    if (!this.el) return;
    this.save();
    this.resizeObs?.disconnect();
    this.ws?.dispose();
    this.code?.destroy();
    this.el.remove();
    this.el = null;
    this.ws = null;
    this.code = null;
    document.removeEventListener("keydown", this.onKey, true);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || document.querySelector(".modal-backdrop, .palette-backdrop, .menu, .blocklyWidgetDiv:not(:empty), .blocklyDropDownDiv[style*='display: block']")) return;
    // ブロックの名前を書いている途中などは、Blockly にまかせる
    if ((e.target as HTMLElement | null)?.closest?.(".blocklyHtmlInput")) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  /** はじめて開いたときの見本 */
  private starter() {
    if (!this.ws) return;
    const ws = this.ws;
    Blockly.serialization.workspaces.load(
      {
        variables: [{ name: "回数", id: "v_kaisuu" }],
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: "text_print",
              x: 40,
              y: 40,
              inputs: { TEXT: { shadow: { type: "text", fields: { TEXT: "こんにちは！" } } } },
              next: {
                block: {
                  type: "controls_for",
                  fields: { VAR: { id: "v_kaisuu" } },
                  inputs: {
                    FROM: { shadow: { type: "math_number", fields: { NUM: 1 } } },
                    TO: { shadow: { type: "math_number", fields: { NUM: 3 } } },
                    BY: { shadow: { type: "math_number", fields: { NUM: 1 } } },
                    DO: {
                      block: {
                        type: "text_print",
                        inputs: {
                          TEXT: {
                            block: {
                              type: "text_join",
                              extraState: { itemCount: 2 },
                              inputs: { ADD0: { block: { type: "variables_get", fields: { VAR: { id: "v_kaisuu" } } } }, ADD1: { shadow: { type: "text", fields: { TEXT: " 回目" } } } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      ws,
    );
  }

  private theme(): Blockly.Theme {
    const bg = css("--editor-bg", "#0f1724");
    const panel = css("--panel", "#151d2b");
    const text = css("--text", "#e6e9ef");
    const muted = css("--text-muted", "#9aa3b2");
    // Blockly の色は #rrggbb だけ。縁は少し暗くする
    const shade = (c: string, k: number) =>
      "#" +
      [1, 3, 5]
        .map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * k))
        .map((v) => Math.min(255, v).toString(16).padStart(2, "0"))
        .join("");
    const style = (c: string) => ({ colourPrimary: c, colourSecondary: shade(c, 0.85), colourTertiary: shade(c, 0.7) });
    return Blockly.Theme.defineTheme(`aizome-${Date.now()}`, {
      name: "aizome",
      base: Blockly.Themes.Classic,
      blockStyles: {
        logic_blocks: style(COLORS.logic),
        loop_blocks: style(COLORS.loop),
        math_blocks: style(COLORS.math),
        text_blocks: style(COLORS.text),
        list_blocks: style(COLORS.list),
        variable_blocks: style(COLORS.variable),
        variable_dynamic_blocks: style(COLORS.variable),
        procedure_blocks: style(COLORS.func),
      },
      categoryStyles: {},
      componentStyles: {
        workspaceBackgroundColour: bg,
        toolboxBackgroundColour: panel,
        toolboxForegroundColour: text,
        flyoutBackgroundColour: panel,
        flyoutForegroundColour: muted,
        flyoutOpacity: 0.96,
        scrollbarColour: muted,
        insertionMarkerColour: text,
        insertionMarkerOpacity: 0.3,
        cursorColour: text,
      },
      fontStyle: { family: "'Noto Sans JP', 'Yu Gothic UI', 'Hiragino Sans', sans-serif", size: 11, weight: "bold" },
      startHats: false,
    });
  }

  private ext(): string {
    return BLOCK_LANGS.find((l) => l.id === this.lang)!.ext;
  }

  private codeTitle(): string {
    return `${BLOCK_LANGS.find((l) => l.id === this.lang)!.label} のプログラム`;
  }

  private async loadLanguage() {
    const desc = LanguageDescription.matchFilename(languages, "main" + this.ext());
    if (!desc || !this.code) return;
    const support = await desc.load().catch(() => null);
    if (support && this.code) this.code.dispatch({ effects: this.langConf.reconfigure(support) });
  }

  private setLang(lang: BlockLang) {
    this.lang = lang;
    setBlockLang(lang);
    const title = this.el?.querySelector(".blocks-code-title");
    if (title) title.textContent = this.codeTitle();
    // 読み込みブロックの候補（言語ごと）を作り直すために、一覧を描き直す
    this.ws?.updateToolbox(toolbox() as unknown as Blockly.utils.toolbox.ToolboxDefinition);
    void this.loadLanguage();
    this.refresh();
  }

  private current(): string {
    if (!this.ws) return "";
    try {
      return workspaceToCode(this.ws, this.lang);
    } catch (err) {
      console.error(err);
      return `// プログラムを作れませんでした：${String(err)}\n`;
    }
  }

  private refresh() {
    if (!this.code || !this.ws) return;
    const text = this.current();
    this.code.dispatch({ changes: { from: 0, to: this.code.state.doc.length, insert: text } });
    this.save();
  }

  private save() {
    if (!this.ws) return;
    try {
      localStorage.setItem(STORE, JSON.stringify({ lang: this.lang, state: Blockly.serialization.workspaces.save(this.ws) }));
    } catch {
      // 保存できなくても、使うのはかまわない
    }
  }

  private async run() {
    const code = this.current();
    if (!code.trim()) return toast("まだブロックがありません", "info");
    if (!this.deps) return;
    this.close();
    await this.deps.run(code, this.ext());
  }

  private openInEditor() {
    const code = this.current();
    if (!this.deps) return;
    this.close();
    this.deps.openInEditor(code, this.ext());
  }

  private async copy() {
    try {
      await navigator.clipboard.writeText(this.current());
      toast("プログラムをコピーしました", "success", 2500);
    } catch {
      toast("コピーできませんでした", "warn");
    }
  }

  private async saveFile() {
    if (!this.ws) return;
    const path = await dialog.saveFile("ブロック.aizblocks");
    if (!path) return;
    const data = { app: "aizome-blocks", version: 1, lang: this.lang, state: Blockly.serialization.workspaces.save(this.ws) };
    try {
      await fs.writeFile(/\.aizblocks$/i.test(path) ? path : `${path}.aizblocks`, JSON.stringify(data, null, 2));
      toast("ブロックを保存しました", "success", 2500);
    } catch (err) {
      toast(`保存できませんでした：${String(err)}`, "error");
    }
  }

  private async openFile() {
    const path = await dialog.pickFile([{ name: "ブロック", extensions: ["aizblocks", "json"] }]);
    if (!path || !this.ws) return;
    try {
      const data = JSON.parse(await fs.readFile(path));
      this.ws.clear();
      Blockly.serialization.workspaces.load(data.state ?? data, this.ws);
      if (data.lang && BLOCK_LANGS.some((l) => l.id === data.lang)) {
        (this.el?.querySelector(".blocks-lang") as HTMLSelectElement | null)?.setAttribute("value", data.lang);
        const sel = this.el?.querySelector(".blocks-lang") as HTMLSelectElement | null;
        if (sel) sel.value = data.lang;
        this.setLang(data.lang);
      }
      this.refresh();
    } catch (err) {
      toast(`開けませんでした：${String(err)}`, "error");
    }
  }

  private async clearAll() {
    if (!this.ws || !this.ws.getAllBlocks(false).length) return;
    if (!(await confirmBox("ぜんぶ消す", "組み立てたブロックをぜんぶ消しますか？（消したあとでも Ctrl+Z で戻せます）", "消す", true))) return;
    this.ws?.clear();
  }
}

export const blocksPage = new BlocksPage();
