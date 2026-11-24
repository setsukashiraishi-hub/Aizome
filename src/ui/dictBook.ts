// コード辞書を「本の辞書」のように大きく開く画面。
// 左：目次（分類）／まん中：見出しの一覧／右：選んだ項目のページ（コード・説明・入れる・コピー）
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { h, clear } from "../core/dom";
import { editorTheme, syntaxColors } from "../editor/theme";
import { DICT_LANGUAGES, categories, dictLanguageFor, plainCode, removeUserEntry, searchDict, type DictHit } from "../dict";
import { icon } from "./icons";
import { toast } from "./toast";

export interface DictBookDeps {
  /** 項目をエディタに入れる（ファイルが開いていなければ新しいファイルを作って入れる） */
  insert(hit: DictHit, ext: string): void;
  /** 今のファイルの名前（言語を合わせるため） */
  activeName(): string | null;
  /** 見つからなかった言葉を、サイドバーの辞書で AI に聞く */
  askAi(query: string): void;
  /** サイドバーの小さい辞書に切りかえる */
  toSide(query: string): void;
}

class DictBook {
  private deps: DictBookDeps | null = null;
  private el: HTMLElement | null = null;
  private langId = DICT_LANGUAGES[0].id;
  private category = "";
  private hits: DictHit[] = [];
  private selected = 0;
  private input!: HTMLInputElement;
  private langBox!: HTMLElement;
  private index!: HTMLElement;
  private words!: HTMLElement;
  private page!: HTMLElement;
  private count!: HTMLElement;
  private code: EditorView | null = null;
  private langConf = new Compartment();
  private loadSeq = 0;

  setDeps(deps: DictBookDeps) {
    this.deps = deps;
  }

  get isOpen() {
    return !!this.el?.isConnected;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(query?: string) {
    if (!this.el) this.build();
    if (!this.isOpen) {
      // 今のファイルの言語に合わせて開く
      const lang = dictLanguageFor(this.deps?.activeName() ?? "");
      if (lang && lang.id !== this.langId) this.setLang(lang.id, false);
      document.body.append(this.el!);
      document.addEventListener("keydown", this.onKey, true);
    }
    if (query !== undefined) this.input.value = query;
    this.refresh();
    requestAnimationFrame(() => {
      this.input.focus();
      this.input.select();
    });
  }

  close() {
    this.el?.remove();
    document.removeEventListener("keydown", this.onKey, true);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  private ext() {
    return DICT_LANGUAGES.find((l) => l.id === this.langId)?.exts[0] ?? ".txt";
  }

  private build() {
    this.input = h("input", {
      class: "dictbook-input",
      type: "search",
      placeholder: "やりたいことでひく（例：並べ替え、ファイル 読む、ランダム）",
      spellcheck: "false",
      "aria-label": "コード辞書でひく",
    }) as HTMLInputElement;
    this.input.addEventListener("input", () => this.refresh());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.select(this.selected + (e.key === "ArrowDown" ? 1 : -1), true);
      } else if (e.key === "Enter" && this.hits[this.selected]) {
        e.preventDefault();
        this.insert(this.hits[this.selected]);
      }
    });
    this.langBox = h("div", { class: "dictbook-langs", role: "tablist" });
    for (const l of DICT_LANGUAGES) {
      const b = h("button", { class: "dictbook-lang", type: "button", "data-lang": l.id }, l.label);
      b.addEventListener("click", () => this.setLang(l.id));
      this.langBox.append(b);
    }
    this.index = h("nav", { class: "dictbook-index", "aria-label": "目次" });
    this.count = h("div", { class: "dictbook-count" });
    this.words = h("div", { class: "dictbook-words", role: "listbox" });
    this.page = h("article", { class: "dictbook-page" });

    this.el = h(
      "div",
      { class: "dictbook" },
      h(
        "header",
        { class: "dictbook-head" },
        h(
          "div",
          { class: "dictbook-brand" },
          h("span", { class: "dictbook-mark", html: icon("book", 18) }),
          h("div", {}, h("div", { class: "dictbook-title" }, "コード辞書"), h("div", { class: "dictbook-sub" }, "やりたいことから、書き方をひく")),
        ),
        h("label", { class: "dictbook-search" }, h("span", { class: "dictbook-search-icon", html: icon("search", 16) }), this.input),
        h(
          "button",
          {
            class: "dictbook-tool",
            type: "button",
            title: "エディタを見ながら使えるように、左のサイドバーに小さく出す",
            onclick: () => {
              const q = this.input.value;
              this.close();
              this.deps?.toSide(q);
            },
          },
          h("span", { html: icon("outline", 14) }),
          "横に出す",
        ),
        h("button", { class: "dictbook-close", type: "button", title: "閉じる（Esc）", "aria-label": "閉じる", html: icon("x", 17), onclick: () => this.close() }),
      ),
      this.langBox,
      h(
        "div",
        { class: "dictbook-body" },
        h("aside", { class: "dictbook-side" }, h("div", { class: "dictbook-side-label" }, "目次"), this.index),
        h("section", { class: "dictbook-list" }, this.count, this.words),
        this.page,
      ),
    );
    this.markLang();
  }

  private setLang(id: string, refresh = true) {
    this.langId = id;
    this.category = "";
    this.markLang();
    if (refresh) this.refresh();
  }

  private markLang() {
    this.langBox?.querySelectorAll<HTMLElement>(".dictbook-lang").forEach((b) => b.classList.toggle("active", b.dataset.lang === this.langId));
  }

  private refresh() {
    const q = this.input.value;
    this.hits = searchDict(this.langId, q, this.category || undefined);
    // 言葉で探していないときは、目次（分類）の順に並べる
    this.renderIndex();
    this.renderWords();
    this.select(0, false);
  }

  private renderIndex() {
    clear(this.index);
    const all = searchDict(this.langId, this.input.value);
    const counts = new Map<string, number>();
    for (const hit of all) counts.set(hit.category, (counts.get(hit.category) ?? 0) + 1);
    const row = (cat: string, label: string, n: number) => {
      const b = h(
        "button",
        { class: "dictbook-cat" + (cat === this.category ? " active" : ""), type: "button", disabled: n === 0 },
        h("span", {}, label),
        h("span", { class: "dictbook-cat-n" }, String(n)),
      );
      b.addEventListener("click", () => {
        this.category = cat;
        this.refresh();
      });
      this.index.append(b);
    };
    row("", "すべて", all.length);
    for (const cat of categories(this.langId)) row(cat, cat, counts.get(cat) ?? 0);
  }

  private renderWords() {
    clear(this.words);
    const q = this.input.value.trim();
    const label = DICT_LANGUAGES.find((l) => l.id === this.langId)?.label ?? "";
    this.count.textContent = q ? `「${q}」で ${this.hits.length} 件（${label}）` : `${this.category || "すべて"}：${this.hits.length} 件（${label}）`;
    let last = "";
    this.hits.forEach((hit, i) => {
      // 分類の見出し（言葉で探しているときは、よく合う順なので出さない）
      if (!q && hit.category !== last) {
        last = hit.category;
        this.words.append(h("div", { class: "dictbook-group" }, hit.category));
      }
      const b = h("button", { class: "dictbook-word", type: "button", role: "option", "data-i": String(i) }, h("span", { class: "dictbook-word-title" }, hit.title));
      if (q) b.append(h("span", { class: "dictbook-word-cat" }, hit.category));
      b.addEventListener("click", () => this.select(i, false));
      b.addEventListener("dblclick", () => this.insert(hit));
      this.words.append(b);
    });
    if (!this.hits.length) {
      const box = h("div", { class: "dictbook-empty" }, h("p", {}, q ? `「${q}」は、この辞書（${label}）にはありませんでした。` : "この分類にはまだありません。"));
      if (q) {
        box.append(
          h("p", { class: "dictbook-empty-hint" }, "ほかの言い方（例：「並べる」→「並べ替え」）や、ほかの言語でも探してみてください。"),
          h(
            "button",
            {
              class: "btn small plain",
              type: "button",
              onclick: () => {
                this.close();
                this.deps?.askAi(q);
              },
            },
            h("span", { html: icon("spark", 13) }),
            ` AI に「${q}」の書き方を聞く`,
          ),
        );
      }
      this.words.append(box);
    }
  }

  private select(i: number, scroll: boolean) {
    if (!this.hits.length) {
      this.selected = 0;
      this.renderPage(null);
      return;
    }
    this.selected = Math.max(0, Math.min(this.hits.length - 1, i));
    this.words.querySelectorAll<HTMLElement>(".dictbook-word").forEach((w) => {
      const on = Number(w.dataset.i) === this.selected;
      w.classList.toggle("active", on);
      w.setAttribute("aria-selected", String(on));
      if (on && scroll) w.scrollIntoView({ block: "nearest" });
    });
    this.renderPage(this.hits[this.selected]);
  }

  private renderPage(hit: DictHit | null) {
    clear(this.page);
    if (!hit) {
      this.page.append(h("div", { class: "dictbook-page-empty" }, h("span", { html: icon("book", 40) }), h("p", {}, "左の見出しを選ぶと、ここに書き方が出ます。")));
      return;
    }
    const label = DICT_LANGUAGES.find((l) => l.id === this.langId)?.label ?? "";
    const codeHost = h("div", { class: "dictbook-code" });
    const keys = hit.keys
      .split(/[\s　,、]+/)
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 12);
    const related = this.relatedOf(hit);
    const parts: (HTMLElement | null)[] = [
      h("div", { class: "dictbook-page-meta" }, h("span", { class: "dictbook-badge" }, label), h("span", {}, hit.category)),
      h("h2", { class: "dictbook-page-title" }, hit.title),
      hit.note ? h("p", { class: "dictbook-note" }, hit.note) : null,
      h("div", { class: "dictbook-code-label" }, "書き方"),
      codeHost,
      /⟨[^⟩]+⟩/.test(hit.code) ? h("p", { class: "dictbook-tip" }, "入れたあと Tab を押すと、書き換える場所へ順に移れます。") : null,
      h(
        "div",
        { class: "dictbook-actions" },
        h("button", { class: "btn primary", type: "button", onclick: () => this.insert(hit) }, h("span", { html: icon("plus", 14) }), " エディタに入れる"),
        h("button", { class: "btn plain", type: "button", onclick: () => this.copy(hit) }, h("span", { html: icon("copy", 14) }), " コピー"),
        hit.user
          ? h(
              "button",
              {
                class: "btn plain",
                type: "button",
                onclick: () => {
                  removeUserEntry(hit);
                  toast(`「${hit.title}」を自分の辞書から消しました`, "info");
                  this.refresh();
                },
              },
              "自分の辞書から消す",
            )
          : null,
      ),
      keys.length
        ? h(
            "div",
            { class: "dictbook-keys" },
            h("span", { class: "dictbook-keys-label" }, "この言葉でもひけます"),
            ...keys.map((k) => {
              const b = h("button", { class: "dictbook-key", type: "button" }, k);
              b.addEventListener("click", () => {
                this.input.value = k;
                this.category = "";
                this.refresh();
              });
              return b;
            }),
          )
        : null,
      related.length
        ? h(
            "div",
            { class: "dictbook-related" },
            h("div", { class: "dictbook-code-label" }, `「${hit.category}」のほかの項目`),
            ...related.map((r) => {
              const b = h("button", { class: "dictbook-rel", type: "button" }, r.title);
              b.addEventListener("click", () => this.jumpTo(r));
              return b;
            }),
          )
        : null,
    ];
    this.page.append(...parts.filter((x): x is HTMLElement => !!x));
    this.showCode(codeHost, plainCode(hit.code));
  }

  /** 同じ分類のほかの項目（前後から少し） */
  private relatedOf(hit: DictHit): DictHit[] {
    const same = searchDict(this.langId, "", hit.category);
    const i = same.findIndex((x) => x.title === hit.title);
    return same.filter((x) => x.title !== hit.title).slice(Math.max(0, i - 3), Math.max(0, i - 3) + 6);
  }

  private jumpTo(hit: DictHit) {
    this.input.value = "";
    this.category = hit.category;
    this.refresh();
    const i = this.hits.findIndex((x) => x.title === hit.title);
    if (i >= 0) this.select(i, true);
  }

  private showCode(host: HTMLElement, text: string) {
    if (!this.code) {
      this.code = new EditorView({
        state: EditorState.create({
          doc: text,
          extensions: [editorTheme, syntaxColors, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, this.langConf.of([])],
        }),
      });
    } else {
      this.code.dispatch({ changes: { from: 0, to: this.code.state.doc.length, insert: text } });
    }
    host.append(this.code.dom);
    // 色分け（言語ごとの読み込みはあとから）
    const seq = ++this.loadSeq;
    const desc = LanguageDescription.matchFilename(languages, "main" + this.ext());
    if (!desc) {
      this.code.dispatch({ effects: this.langConf.reconfigure([]) });
      return;
    }
    void desc.load().then((support) => {
      if (seq === this.loadSeq && this.code) this.code.dispatch({ effects: this.langConf.reconfigure(support) });
    });
  }

  private insert(hit: DictHit) {
    this.close();
    this.deps?.insert(hit, this.ext());
  }

  private copy(hit: DictHit) {
    void navigator.clipboard?.writeText(plainCode(hit.code)).then(
      () => toast("コピーしました", "success"),
      () => toast("コピーできませんでした", "warn"),
    );
  }
}

export const dictBook = new DictBook();
