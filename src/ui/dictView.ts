// コード辞書（サイドバー）：やりたいことを日本語で探して、ボタン一つでコードを入れる
import { h, clear } from "../core/dom";
import { settings } from "../core/settings";
import { completer } from "../ai/completer";
import { languageOf } from "../ai/plan";
import type { EditorHost } from "../editor/types";
import {
  DICT_LANGUAGES,
  addUserEntry,
  categories,
  dictLanguageFor,
  plainCode,
  removeUserEntry,
  searchDict,
  toSnippetTemplate,
  type DictHit,
} from "../dict";
import { icon } from "./icons";
import { toast } from "./toast";
import { inputBox } from "./dialog";

export interface DictViewDeps {
  editor: EditorHost;
  activeName: () => string | null;
  hasDoc: () => boolean;
  /** 大きく開く（本の辞書のような画面） */
  openBook: (query?: string) => void;
}

export interface DictView {
  el: HTMLElement;
  /** 開いて、言葉を入れて探す */
  focus(query?: string): void;
  /** 今のファイルに合わせて言語を選び直す */
  syncLanguage(): void;
}

export function createDictView(deps: DictViewDeps): DictView {
  let langId = DICT_LANGUAGES[0].id;
  let auto = true;
  let category = "";
  let selected = 0;
  let hits: DictHit[] = [];
  let aiSeq = 0;

  const langSelect = h(
    "select",
    { class: "select dict-lang", "aria-label": "言語" },
    ...DICT_LANGUAGES.map((l) => h("option", { value: l.id }, l.label)),
  );
  const input = h("input", {
    class: "text-input dict-input",
    type: "search",
    placeholder: "やりたいことで探す（例：並べ替え、ファイル 読む）",
    spellcheck: "false",
    "aria-label": "コード辞書を探す",
  });
  const bigBtn = h("button", { class: "icon-btn", type: "button", title: "辞書を大きく開く", "aria-label": "辞書を大きく開く", html: icon("book", 15) });
  bigBtn.addEventListener("click", () => deps.openBook(input.value));
  const addBtn = h("button", { class: "icon-btn", type: "button", title: "選んでいるコードを自分の辞書に追加", "aria-label": "自分の辞書に追加", html: icon("plus", 15) });
  const chips = h("div", { class: "dict-chips" });
  const list = h("div", { class: "dict-list", role: "listbox" });
  const el = h(
    "div",
    { class: "view dict-view" },
    h("div", { class: "dict-head" }, langSelect, bigBtn, addBtn),
    h("div", { class: "dict-search" }, input),
    chips,
    list,
  );

  const insert = (hit: DictHit) => {
    if (!deps.hasDoc()) {
      toast("ファイルを開いてから入れてください（コピーはできます）", "info");
      return;
    }
    deps.editor.insertSnippet(toSnippetTemplate(hit.code));
    if (/⟨[^⟩]+⟩/.test(hit.code)) toast("Tab で次の書き換える場所へ移動できます", "info", 3500);
  };
  const copy = (hit: DictHit) => {
    void navigator.clipboard?.writeText(plainCode(hit.code)).then(() => toast("コピーしました", "success"));
  };

  function renderChips() {
    clear(chips);
    const all = ["", ...categories(langId)];
    for (const cat of all) {
      chips.append(
        h(
          "button",
          {
            class: "dict-chip" + (cat === category ? " active" : ""),
            type: "button",
            onclick: () => {
              category = cat;
              renderChips();
              render();
            },
          },
          cat || "すべて",
        ),
      );
    }
  }

  function item(hit: DictHit, i: number): HTMLElement {
    const code = h("pre", { class: "dict-code" }, plainCode(hit.code));
    const row = h(
      "div",
      { class: "dict-item" + (i === selected ? " selected" : ""), role: "option", tabindex: -1 },
      h(
        "div",
        { class: "dict-item-head" },
        h("span", { class: "dict-title" }, hit.title),
        h("span", { class: "dict-cat" }, hit.category),
      ),
      code,
      hit.note ? h("p", { class: "dict-note" }, hit.note) : null,
      h(
        "div",
        { class: "dict-actions" },
        h("button", { class: "btn small primary", type: "button", onclick: () => insert(hit) }, "入れる"),
        h("button", { class: "btn small plain", type: "button", onclick: () => copy(hit) }, "コピー"),
        hit.user
          ? h(
              "button",
              {
                class: "btn small plain",
                type: "button",
                onclick: () => {
                  removeUserEntry(hit);
                  renderChips();
                  render();
                },
              },
              "削除",
            )
          : null,
      ),
    );
    row.addEventListener("dblclick", () => insert(hit));
    row.addEventListener("click", () => {
      selected = i;
      list.querySelectorAll(".dict-item").forEach((x, j) => x.classList.toggle("selected", j === i));
    });
    return row;
  }

  function render() {
    hits = searchDict(langId, input.value, category || undefined);
    selected = 0;
    clear(list);
    hits.slice(0, 60).forEach((hit, i) => list.append(item(hit, i)));
    const q = input.value.trim();
    if (!hits.length) {
      list.append(h("p", { class: "view-empty" }, q ? `「${q}」は辞書にありませんでした。` : "この分類にはまだありません。"));
    }
    if (q) {
      // 見つからないとき・ほかの書き方も見たいとき：AI に聞く
      const ask = h("button", { class: "btn small plain dict-ai", type: "button" }, h("span", { html: icon("spark", 13) }), ` AI に「${q}」の書き方を聞く`);
      ask.addEventListener("click", () => void askAi(q, ask));
      list.append(ask);
    }
  }

  async function askAi(q: string, button: HTMLElement) {
    if (!settings.get("ai.enabled")) return toast("AI がオフになっています", "warn");
    const seq = ++aiSeq;
    const label = DICT_LANGUAGES.find((l) => l.id === langId)?.label ?? languageOf(deps.activeName() ?? "");
    button.textContent = "AI が考えています…";
    button.setAttribute("disabled", "");
    try {
      const answer = await completer.ask(
        [
          `${label} で「${q}」をする、短くてわかりやすいコードの例を 1 つ書いてください。`,
          "- コードは ``` で囲んで 1 つだけ。",
          "- コードの前に、何をするコードかを日本語で 1 行（20 文字くらい）で書く。",
          "- 書き換えて使う部分（変数名や値）には、日本語の短いコメントを付ける。",
        ].join("\n"),
        { maxTokens: 500, temperature: 0.2 },
      );
      if (seq !== aiSeq) return;
      const m = /```[^\n]*\n([\s\S]*?)```/.exec(answer);
      const code = (m ? m[1] : answer).replace(/\s+$/, "");
      const title = (answer.split("```")[0].trim().split("\n").pop() ?? "").replace(/^[#*\s-]+/, "").slice(0, 40) || q;
      const hit: DictHit = { lang: langId, category: "AI の答え", title: `✦ ${title}`, keys: q, code, score: 0 };
      const row = item(hit, -1);
      const save = h("button", { class: "btn small plain", type: "button" }, "自分の辞書に保存");
      save.addEventListener("click", () => {
        addUserEntry({ lang: langId, title: title || q, code, keys: q });
        toast("自分の辞書に保存しました", "success");
        save.remove();
        renderChips();
      });
      row.querySelector(".dict-actions")?.append(save);
      button.replaceWith(row);
    } catch (err) {
      button.textContent = "AI につながりませんでした";
      toast(String((err as Error)?.message ?? err), "warn");
    }
  }

  function setLang(id: string) {
    langId = id;
    langSelect.value = id;
    category = "";
    renderChips();
    render();
  }

  langSelect.addEventListener("change", () => {
    auto = false;
    setLang(langSelect.value);
  });
  input.addEventListener("input", () => render());
  input.addEventListener("keydown", (e) => {
    const n = Math.min(hits.length, 60);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(0, Math.min(n - 1, selected + (e.key === "ArrowDown" ? 1 : -1)));
      list.querySelectorAll(".dict-item").forEach((x, j) => {
        x.classList.toggle("selected", j === selected);
        if (j === selected) x.scrollIntoView({ block: "nearest" });
      });
    } else if (e.key === "Enter" && hits[selected]) {
      e.preventDefault();
      insert(hits[selected]);
    }
  });
  addBtn.addEventListener("click", async () => {
    const code = deps.editor.getSelection();
    if (!code.trim()) return toast("辞書に入れたいコードを、エディタで選んでから押してください", "info", 5000);
    const title = await inputBox({ title: "自分の辞書に追加", placeholder: "何をするコードか（例：点数の平均を出す）", okLabel: "追加" });
    if (!title) return;
    addUserEntry({ lang: langId, title, code: code.replace(/\t/g, "    ") });
    toast(`「${title}」を自分の辞書に追加しました`, "success");
    category = "自分の辞書";
    renderChips();
    render();
  });
  el.addEventListener("view:show", () => {
    syncLanguage();
    input.focus();
  });

  function syncLanguage() {
    if (!auto) return;
    const lang = dictLanguageFor(deps.activeName() ?? "");
    if (lang && lang.id !== langId) setLang(lang.id);
  }

  renderChips();
  render();

  return {
    el,
    focus(query?: string) {
      syncLanguage();
      if (query !== undefined) {
        input.value = query;
        render();
      }
      input.focus();
      input.select();
    },
    syncLanguage,
  };
}
