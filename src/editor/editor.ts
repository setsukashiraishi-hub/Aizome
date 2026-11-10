// CodeMirror 6 を使ったエディタ本体。タブごとに EditorState を持ち、表示中の1つを EditorView に載せる。
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentUnit, LanguageDescription } from "@codemirror/language";
import {
  history,
  redoDepth,
  undoDepth,
  copyLineDown,
  deleteLine,
  indentLess,
  indentMore,
  indentWithTab,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  toggleComment,
  undo,
} from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { snippet } from "@codemirror/autocomplete";
import { ensureSyntaxTree, foldAll, unfoldAll } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import { editorTheme, syntaxColors } from "./theme";
import { docFilename, docId, ghostText, triggerCompletion } from "./ghost";
import { buildLens } from "./buildLens";
import { lineExplanations } from "./explain";
import { smartCompletion } from "./smartComplete";
import { indentFollow } from "./indentFollow";
import { gotoDefinition } from "./gotoDef";
import { zenkakuMarks } from "./zenkaku";
import { langTag } from "./langTag";
import { setValues, valueLens } from "./valueLens";
import type { LineValue, TraceResult } from "../run/trace";
import { autoInfer } from "./autoInfer";
import { scopeGuides } from "./scopeGuides";
import { renameSuggest } from "./renameSuggest";
import { liveCheck } from "./liveCheck";
import { runErrorsField, setRunErrors } from "./runErrors";
import { occurrences, renameAll, symbolAt } from "./rename";
import { settings } from "../core/settings";
import { filenameForLanguage } from "../core/languages";
import type { EditorAction, EditorHost } from "./types";

interface DocEntry {
  state: EditorState;
  filename: string;
  language: string;
  scrollTop: number;
}

const languageSlot = new Compartment();
const configSlot = new Compartment();
const nameSlot = new Compartment();

function configExtensions(): Extension {
  const size = settings.get("editor.fontSize");
  const tab = settings.get("editor.tabSize");
  return [
    EditorState.tabSize.of(tab),
    indentUnit.of(" ".repeat(tab)),
    EditorView.theme({ "&": { fontSize: `${size}px` } }),
    settings.get("editor.wordWrap") ? EditorView.lineWrapping : [],
  ];
}

function detect(filename: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, filenameForLanguage(filename));
}

/** 書き出し用：色の種類を短い名前で（k = キーワード、s = 文字列 …） */
const exportHighlighter = tagHighlighter([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.modifier, tags.self], class: "k" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character, tags.escape], class: "s" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: "c" },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], class: "n" },
  { tag: [tags.function(tags.variableName), tags.function(tags.definition(tags.variableName)), tags.function(tags.propertyName)], class: "f" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], class: "t" },
  { tag: [tags.definition(tags.variableName), tags.propertyName, tags.attributeName], class: "v" },
  { tag: [tags.meta, tags.processingInstruction, tags.annotation], class: "m" },
  { tag: [tags.tagName, tags.heading], class: "k" },
]);

interface Pane {
  el: HTMLElement;
  /** そのがわのファイルの見出し（ファイル名・行の右の表示・実行など） */
  bar: HTMLElement;
  view: EditorView;
  activeId: string | null;
  /** 最近このがわで見たファイル（新しい順） */
  mru: string[];
}

class CodeMirrorHost implements EditorHost {
  private panes: Pane[] = [];
  /** 今さわっているがわ（0 = 左、1 = 右） */
  private cur = 0;
  private root: HTMLElement | null = null;
  private docs = new Map<string, DocEntry>();
  /** 閉じたタブの編集の記録（同じ中身で開き直したら、元に戻すが続けて使える） */
  private closed = new Map<string, DocEntry>();
  private docPane = new Map<string, number>();
  private changeListeners: ((id: string) => void)[] = [];
  private cursorListeners: ((p: { line: number; col: number }) => void)[] = [];
  private focusListeners: ((id: string) => void)[] = [];

  private get view(): EditorView | null {
    return this.panes[this.cur]?.view ?? null;
  }
  private get activeId(): string | null {
    return this.panes[this.cur]?.activeId ?? null;
  }

  /** そのファイルを表示している EditorView（どちらのがわでも） */
  private viewOf(id: string): EditorView | null {
    return this.panes.find((p) => p.activeId === id)?.view ?? null;
  }

  mount(parent: HTMLElement) {
    this.root = parent;
    for (let i = 0; i < 2; i++) this.panes.push(this.makePane(i));
    const bar = document.createElement("div");
    bar.className = "split-resizer";
    bar.setAttribute("role", "separator");
    bar.setAttribute("aria-orientation", "vertical");
    bar.title = "ドラッグで幅を変える／ダブルクリックで半分ずつ";
    this.dragSplit(bar);
    parent.append(this.panes[0].el, bar, this.panes[1].el);
    this.layout();
  }

  /** 左右の幅の割合（左がわ） */
  private applyRatio(r: number) {
    const ratio = Math.min(0.85, Math.max(0.15, r || 0.5));
    this.panes[0].el.style.flex = `${ratio} 1 0`;
    this.panes[1].el.style.flex = `${1 - ratio} 1 0`;
  }

  private dragSplit(bar: HTMLElement) {
    bar.addEventListener("dblclick", () => {
      this.applyRatio(0.5);
      settings.set("ui.splitRatio", 0.5);
    });
    bar.addEventListener("pointerdown", (e) => {
      if (!this.root) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("dragging");
      document.body.classList.add("resizing-x");
      const rect = this.root.getBoundingClientRect();
      let ratio = settings.get("ui.splitRatio");
      const move = (ev: PointerEvent) => {
        ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / Math.max(1, rect.width)));
        this.applyRatio(ratio);
      };
      const up = () => {
        bar.classList.remove("dragging");
        document.body.classList.remove("resizing-x");
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        settings.set("ui.splitRatio", Math.round(ratio * 1000) / 1000);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
  }

  private makePane(idx: number): Pane {
    const el = document.createElement("div");
    el.className = "editor-pane";
    const bar = document.createElement("div");
    bar.className = "pane-bar";
    el.append(bar);
    const pane = { el, bar, activeId: null, mru: [] } as unknown as Pane;
    pane.view = new EditorView({
      parent: el,
      state: EditorState.create({ doc: "" }),
      dispatch: (tr, view) => {
        view.update([tr]);
        const id = pane.activeId;
        if (id) {
          const entry = this.docs.get(id);
          if (entry) entry.state = view.state;
          if (tr.docChanged) this.changeListeners.forEach((l) => l(id));
        }
        if ((tr.selection || tr.docChanged) && this.panes[this.cur] === pane) {
          const pos = this.cursor();
          this.cursorListeners.forEach((l) => l(pos));
        }
      },
    });
    pane.view.dom.style.display = "none";
    el.addEventListener("focusin", () => this.focusPane(idx));
    el.addEventListener("mousedown", () => this.focusPane(idx));
    return pane;
  }

  private focusPane(idx: number) {
    if (this.cur === idx || !this.panes[idx]?.activeId) return;
    this.cur = idx;
    this.markFocus();
    const id = this.panes[idx].activeId!;
    this.focusListeners.forEach((l) => l(id));
    const pos = this.cursor();
    this.cursorListeners.forEach((l) => l(pos));
  }

  private markFocus() {
    this.panes.forEach((p, i) => p.el.classList.toggle("focused", i === this.cur));
  }

  private idsIn(idx: number): string[] {
    return [...this.docPane].filter(([, p]) => p === idx).map(([id]) => id);
  }

  /** 右がわにファイルがあるときだけ左右に分ける */
  private layout() {
    const split = this.idsIn(1).length > 0;
    this.root?.classList.toggle("split", split);
    if (this.panes[1]) this.panes[1].el.hidden = !split;
    // 1 つだけのときは画面いっぱい、並べたときは決めた割合で分ける
    if (split) this.applyRatio(settings.get("ui.splitRatio"));
    else if (this.panes[0]) this.panes[0].el.style.flex = "1 1 0";
    if (!split && this.cur === 1) this.cur = 0;
    this.markFocus();
  }

  /** そのがわにファイルを出す */
  private show(idx: number, id: string) {
    const pane = this.panes[idx];
    const entry = this.docs.get(id);
    if (!pane || !entry) return;
    pane.mru = [id, ...pane.mru.filter((x) => x !== id)];
    if (pane.activeId === id) {
      pane.view.dom.style.display = "";
      return;
    }
    if (pane.activeId) {
      const prev = this.docs.get(pane.activeId);
      if (prev) prev.scrollTop = pane.view.scrollDOM.scrollTop;
    }
    pane.activeId = id;
    pane.view.dom.style.display = "";
    pane.view.setState(entry.state);
    // 開いていない間に変わった設定を反映
    pane.view.dispatch({ effects: configSlot.reconfigure(configExtensions()) });
    requestAnimationFrame(() => {
      pane.view.scrollDOM.scrollTop = entry.scrollTop;
    });
  }

  /** そのがわを空にする（ほかに見ていたファイルがあればそれを出す） */
  private vacate(idx: number, leaving: string) {
    const pane = this.panes[idx];
    pane.mru = pane.mru.filter((x) => x !== leaving);
    if (pane.activeId !== leaving) return;
    const entry = this.docs.get(leaving);
    if (entry) entry.scrollTop = pane.view.scrollDOM.scrollTop;
    pane.activeId = null;
    const next = pane.mru.find((x) => this.docPane.get(x) === idx && this.docs.has(x));
    if (next) this.show(idx, next);
    else pane.view.dom.style.display = "none";
  }

  moveToPane(id: string, side: "right" | "left" | "back"): boolean {
    if (!this.docs.has(id)) return false;
    const from = this.docPane.get(id) ?? 0;
    if (side === "right") {
      if (from === 1) return true;
      const left = this.idsIn(0).filter((x) => x !== id);
      if (!left.length) return false;
      this.docPane.set(id, 1);
      this.vacate(0, id);
      if (!this.panes[0].activeId) this.show(0, left[0]);
      this.show(1, id);
      this.cur = 1;
    } else if (side === "left") {
      // このファイルを左に、今左に出ているファイルを右に
      const other = this.panes[0].activeId && this.panes[0].activeId !== id ? this.panes[0].activeId : this.idsIn(0).find((x) => x !== id);
      if (from === 1) this.vacate(1, id);
      this.docPane.set(id, 0);
      if (other) {
        this.docPane.set(other, 1);
        this.vacate(0, other);
        this.show(1, other);
      } else if (!this.idsIn(1).length) return false;
      this.show(0, id);
      this.cur = 0;
    } else {
      if (from === 1) {
        this.docPane.set(id, 0);
        this.vacate(1, id);
      }
      this.show(0, id);
      this.cur = 0;
    }
    this.layout();
    const view = this.view;
    requestAnimationFrame(() => view?.focus());
    return true;
  }

  unsplit() {
    const right = this.panes[1]?.activeId;
    for (const id of this.idsIn(1)) {
      this.docPane.set(id, 0);
      this.vacate(1, id);
    }
    if (right) this.show(0, right);
    this.cur = 0;
    this.layout();
  }

  isSplit() {
    return this.idsIn(1).length > 0;
  }

  paneOf(id: string) {
    return this.docPane.get(id) ?? 0;
  }

  paneBars() {
    return this.panes.filter((p) => !p.el.hidden).map((p) => ({ id: p.activeId, el: p.bar }));
  }

  visibleIds() {
    return this.panes.map((p) => p.activeId).filter((x): x is string => !!x);
  }

  onFocusDoc(cb: (id: string) => void) {
    this.focusListeners.push(cb);
  }

  private extensions(filename = "", id = ""): Extension[] {
    return [
      nameSlot.of([docFilename.of(filename), docId.of(id)]),
      basicSetup,
      // 元に戻せる回数をほぼ無制限に（保存しても、あいぞめを閉じるまでは戻せる）
      history({ minDepth: 100000, newGroupDelay: 600 }),
      keymap.of([indentWithTab]),
      editorTheme,
      syntaxColors,
      indentFollow(),
      gotoDefinition(),
      ghostText(),
      buildLens(),
      lineExplanations(),
      smartCompletion(),
      zenkakuMarks(),
      langTag(),
      valueLens(),
      autoInfer(),
      liveCheck(),
      scopeGuides(),
      renameSuggest(),
      runErrorsField,
      languageSlot.of([]),
      configSlot.of(configExtensions()),
    ];
  }

  private async loadLanguage(id: string, filename: string) {
    const desc = detect(filename);
    const entry = this.docs.get(id);
    if (!entry) return;
    entry.language = desc?.name ?? "Plain Text";
    if (!desc) return;
    try {
      const support = await desc.load();
      const current = this.docs.get(id);
      if (!current) return;
      const effects = languageSlot.reconfigure(support);
      const view = this.viewOf(id);
      if (view) view.dispatch({ effects });
      else current.state = current.state.update({ effects }).state;
    } catch (err) {
      console.warn("言語の読み込みに失敗しました", filename, err);
    }
  }

  has(id: string) {
    return this.docs.has(id);
  }

  async open(id: string, text: string, filename: string) {
    const kept = this.closed.get(id);
    if (!this.docs.has(id) && kept && kept.state.doc.toString() === text && kept.filename === filename) {
      this.closed.delete(id);
      this.docs.set(id, kept);
      this.docPane.set(id, this.isSplit() ? this.cur : 0);
    } else if (!this.docs.has(id)) {
      const state = EditorState.create({ doc: text, extensions: this.extensions(filename, id) });
      this.docs.set(id, { state, filename, language: detect(filename)?.name ?? "Plain Text", scrollTop: 0 });
      this.docPane.set(id, this.isSplit() ? this.cur : 0);
      void this.loadLanguage(id, filename);
    }
    this.activate(id);
  }

  activate(id: string) {
    if (!this.docs.has(id) || !this.panes.length) return;
    const idx = this.docPane.get(id) ?? 0;
    this.show(idx, id);
    this.cur = idx;
    this.markFocus();
    const view = this.panes[idx].view;
    requestAnimationFrame(() => view.focus());
    const pos = this.cursor();
    this.cursorListeners.forEach((l) => l(pos));
  }

  close(id: string) {
    const idx = this.docPane.get(id) ?? 0;
    this.docPane.delete(id);
    this.vacate(idx, id);
    const entry = this.docs.get(id);
    if (entry) {
      this.closed.delete(id);
      this.closed.set(id, entry);
      // 古いものから忘れる（メモリを使いすぎないように）
      while (this.closed.size > 30) this.closed.delete(this.closed.keys().next().value!);
    }
    this.docs.delete(id);
    // 左が空になったら、右のファイルを左へ
    if (idx === 0 && !this.idsIn(0).length && this.idsIn(1).length) this.unsplit();
    this.layout();
  }

  async rename(oldId: string, newId: string, filename: string) {
    const entry = this.docs.get(oldId);
    if (!entry) return;
    this.docs.delete(oldId);
    entry.filename = filename;
    const effects = nameSlot.reconfigure([docFilename.of(filename), docId.of(newId)]);
    const view = this.viewOf(oldId);
    if (view) {
      view.dispatch({ effects });
      entry.state = view.state;
    } else {
      entry.state = entry.state.update({ effects }).state;
    }
    this.docs.set(newId, entry);
    const idx = this.docPane.get(oldId) ?? 0;
    this.docPane.delete(oldId);
    this.docPane.set(newId, idx);
    for (const p of this.panes) {
      if (p.activeId === oldId) p.activeId = newId;
      p.mru = p.mru.map((x) => (x === oldId ? newId : x));
    }
    await this.loadLanguage(newId, filename);
  }

  peek(id: string, max: number) {
    const state = this.viewOf(id)?.state ?? this.docs.get(id)?.state;
    return state ? state.doc.sliceString(0, Math.min(max, state.doc.length)) : "";
  }

  getText(id?: string) {
    const key = id ?? this.activeId;
    if (!key) return "";
    const view = this.viewOf(key);
    if (view) return view.state.doc.toString();
    return this.docs.get(key)?.state.doc.toString() ?? "";
  }

  setText(id: string, text: string) {
    const apply = (state: EditorState) => {
      const head = Math.min(state.selection.main.head, text.length);
      return { changes: { from: 0, to: state.doc.length, insert: text }, selection: { anchor: head } };
    };
    const view = this.viewOf(id);
    if (view) {
      view.dispatch(apply(view.state));
    } else {
      const entry = this.docs.get(id);
      if (entry) entry.state = entry.state.update(apply(entry.state)).state;
    }
  }

  applyText(text: string) {
    if (!this.view || !this.activeId) return;
    const old = this.view.state.doc.toString();
    if (old === text) return;
    let start = 0;
    while (start < old.length && start < text.length && old[start] === text[start]) start++;
    let endOld = old.length;
    let endNew = text.length;
    while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) {
      endOld--;
      endNew--;
    }
    this.view.dispatch({ changes: { from: start, to: endOld, insert: text.slice(start, endNew) }, userEvent: "input.replace" });
  }

  highlightLines(id: string) {
    const state = this.viewOf(id)?.state ?? this.docs.get(id)?.state;
    if (!state) return [];
    const doc = state.doc;
    const lines: { text: string; cls: string }[][] = [[]];
    const push = (text: string, cls: string) => {
      const parts = text.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1].push({ text: part, cls });
      });
    };
    const tree = ensureSyntaxTree(state, doc.length, 3000);
    if (!tree) {
      push(doc.toString(), "");
      return lines;
    }
    let pos = 0;
    highlightTree(tree, exportHighlighter, (from, to, cls) => {
      if (from > pos) push(doc.sliceString(pos, from), "");
      push(doc.sliceString(from, to), cls.split(" ")[0]);
      pos = to;
    });
    if (pos < doc.length) push(doc.sliceString(pos), "");
    return lines;
  }

  historyDepth() {
    const view = this.view;
    if (!view || !this.activeId) return { undo: 0, redo: 0 };
    return { undo: undoDepth(view.state), redo: redoDepth(view.state) };
  }

  getSelection() {
    if (!this.view || !this.activeId) return "";
    const s = this.view.state.selection.main;
    return this.view.state.sliceDoc(s.from, s.to);
  }

  replaceSelection(text: string) {
    if (!this.view || !this.activeId) return;
    this.view.dispatch(this.view.state.replaceSelection(text));
  }

  insertText(text: string) {
    if (!this.view || !this.activeId) return;
    const pos = this.view.state.selection.main.head;
    this.view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
  }

  showValues(id: string, data: { values: Map<number, LineValue>; raw: TraceResult; time?: number | null } | null) {
    const view = this.viewOf(id);
    if (view) {
      view.dispatch({ effects: setValues.of(data) });
    } else {
      const entry = this.docs.get(id);
      if (entry) entry.state = entry.state.update({ effects: setValues.of(data) }).state;
    }
  }

  showRunErrors(id: string, errors: import("../run/errorExplain").ParsedError[]) {
    const view = this.viewOf(id);
    if (view) view.dispatch({ effects: setRunErrors.of(errors) });
    else {
      const entry = this.docs.get(id);
      if (entry) entry.state = entry.state.update({ effects: setRunErrors.of(errors) }).state;
    }
  }

  symbolAtCursor() {
    const view = this.view;
    if (!view || !this.activeId) return null;
    const sym = symbolAt(view.state, view.state.selection.main.head);
    return sym ? { name: sym.name, count: occurrences(view.state, sym.name).length } : null;
  }

  renameSymbol(name: string, next: string) {
    const view = this.view;
    if (!view || !this.activeId) return 0;
    return renameAll(view, name, next);
  }

  insertSnippet(template: string) {
    const view = this.view;
    if (!view || !this.activeId) return;
    const sel = view.state.selection.main;
    let from = sel.from;
    let to = sel.to;
    const line = view.state.doc.lineAt(from);
    if (template.includes("\n") && sel.empty && line.text.trim()) {
      // 行の途中に複数行を入れると崩れるので、次の行を作ってそこに入れる
      const indent = /^[ \t]*/.exec(line.text)![0];
      view.dispatch({ changes: { from: line.to, insert: "\n" + indent }, selection: { anchor: line.to + 1 + indent.length } });
      from = to = line.to + 1 + indent.length;
    }
    snippet(template)(view, null, from, to);
    view.focus();
  }

  cursor() {
    if (!this.view || !this.activeId) return { line: 0, col: 0 };
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1 };
  }

  goTo(line: number, col = 1) {
    if (!this.view) return;
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const pos = Math.min(l.to, l.from + Math.max(0, col - 1));
    this.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    this.view.focus();
  }

  languageName(id?: string) {
    const key = id ?? this.activeId;
    return key ? this.docs.get(key)?.language ?? "Plain Text" : "";
  }

  focus() {
    this.view?.focus();
  }

  applySettings() {
    for (const p of this.panes) if (p.activeId) p.view.dispatch({ effects: configSlot.reconfigure(configExtensions()) });
  }

  async run(action: EditorAction): Promise<boolean> {
    const view = this.view;
    if (!view || !this.activeId) return false;
    view.focus();
    const simple: Partial<Record<EditorAction, (v: EditorView) => boolean>> = {
      undo,
      redo,
      selectAll,
      toggleComment,
      duplicateLine: copyLineDown,
      deleteLine,
      moveLineUp,
      moveLineDown,
      indentMore,
      indentLess,
      foldAll,
      unfoldAll,
      find: openSearchPanel,
      replace: (v) => {
        openSearchPanel(v);
        // 置換の入力欄にフォーカスを移す
        requestAnimationFrame(() => v.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus());
        return true;
      },
    };
    const fn = simple[action];
    if (fn) return fn(view);
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (action === "copy" || action === "cut") {
      // 何も選んでいなければ、その行全体を対象にする
      const line = view.state.doc.lineAt(sel.head);
      const target = text || line.text + "\n";
      await navigator.clipboard.writeText(target);
      if (action === "cut") {
        view.dispatch(
          text
            ? { changes: { from: sel.from, to: sel.to, insert: "" } }
            : { changes: { from: line.from, to: Math.min(line.to + 1, view.state.doc.length), insert: "" } },
        );
      }
      return true;
    }
    if (action === "paste") {
      try {
        const clip = await navigator.clipboard.readText();
        view.dispatch(view.state.replaceSelection(clip));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  triggerCompletion() {
    if (this.view && this.activeId) triggerCompletion(this.view);
  }

  onChange(cb: (id: string) => void) {
    this.changeListeners.push(cb);
  }

  onCursor(cb: (p: { line: number; col: number }) => void) {
    this.cursorListeners.push(cb);
  }
}

export function createEditorHost(): EditorHost {
  return new CodeMirrorHost();
}
