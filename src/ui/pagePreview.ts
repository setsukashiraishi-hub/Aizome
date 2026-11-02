// プレビュー：HTML・Markdown・SVG を、中身（タグや # の文字）ではなく、出来上がったページとして見せる
// 編集中の内容（保存前でも）をそのまま出す。style.css や画像などは、そのファイルのフォルダから読む（アプリの中の aizpv: で配る）
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { h } from "../core/dom";
import { icon } from "./icons";

export type PreviewKind = "html" | "md" | "svg";

export function previewKind(path: string): PreviewKind | null {
  const ext = (/\.[^./\\]+$/.exec(path)?.[0] ?? "").toLowerCase();
  if (ext === ".html" || ext === ".htm" || ext === ".xhtml") return "html";
  if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "md";
  if (ext === ".svg") return "svg";
  return null;
}

/** ページの中に入れる小さなスクリプト：書きかえて読み直しても、スクロールの位置を保つ */
const KEEP_SCROLL =
  `<script>(function(){try{var y=+(location.hash.slice(1)||0);if(y){var go=function(){scrollTo(0,y)};addEventListener("DOMContentLoaded",go);addEventListener("load",go)}}catch(e){}` +
  `var t=0;addEventListener("scroll",function(){clearTimeout(t);t=setTimeout(function(){try{parent.postMessage({aizomeScroll:Math.round(scrollY)},"*")}catch(e){}},80)},{passive:true})})();</script>`;

/** HTML の頭のほう（<head> の直後）に入れる。<!DOCTYPE> より前に入れると表示のしかたが変わるので */
function inject(html: string, add: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + add + html.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + add + html.slice(root.index + root[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype.index + doctype[0].length) + add + html.slice(doctype.index + doctype[0].length);
  return add + html;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MD_CSS = (dark: boolean) => `
:root{color-scheme:${dark ? "dark" : "light"}}
body{margin:0;padding:28px 36px 80px;font:15px/1.8 "Segoe UI","Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif;
  background:${dark ? "#161b26" : "#ffffff"};color:${dark ? "#dfe5f0" : "#1f2430"};max-width:900px}
h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.5em 0 .6em}
h1{font-size:1.9em;padding-bottom:.3em;border-bottom:1px solid ${dark ? "#2c3546" : "#e3e6ec"}}
h2{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid ${dark ? "#2c3546" : "#eceef2"}}
h3{font-size:1.2em}
body>:first-child{margin-top:0}
a{color:${dark ? "#7fb0ff" : "#2156c8"}}
code{font-family:Consolas,"Cascadia Code",Menlo,monospace;font-size:.9em;background:${dark ? "#222a38" : "#f2f4f8"};border-radius:4px;padding:1px 5px}
pre{background:${dark ? "#1d2431" : "#f6f8fb"};border:1px solid ${dark ? "#2c3546" : "#e3e6ec"};border-radius:8px;padding:12px 14px;overflow:auto;line-height:1.55}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:2px 16px;border-left:4px solid ${dark ? "#3b4a66" : "#c9d3e6"};color:${dark ? "#a9b3c5" : "#5a6272"}}
table{border-collapse:collapse;margin:1em 0}
th,td{border:1px solid ${dark ? "#2c3546" : "#d9dde5"};padding:6px 12px}
th{background:${dark ? "#1d2431" : "#f6f8fb"}}
img{max-width:100%}
hr{border:0;border-top:1px solid ${dark ? "#2c3546" : "#e3e6ec"};margin:2em 0}
li{margin:.2em 0}
input[type=checkbox]{margin-right:.4em}
`;

/** iframe に出すページ全体を作る */
export function buildPage(kind: PreviewKind, text: string, title: string, dark: boolean): string {
  if (kind === "html") return inject(text, KEEP_SCROLL);
  if (kind === "svg") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${KEEP_SCROLL}<style>html,body{margin:0;min-height:100%;background:${dark ? "#161b26" : "#fff"}}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}svg{max-width:100%;height:auto}</style></head><body>${text}</body></html>`;
  }
  const body = marked.parse(text, { async: false, gfm: true }) as string;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title>${KEEP_SCROLL}<base target="_blank"><style>${MD_CSS(dark)}</style></head><body>${body}</body></html>`;
}

/** Windows では http://aizpv.localhost/…、ほかは aizpv://localhost/… */
function frameUrl(id: string, version: number, scroll: number): string {
  const win = /Windows/i.test(navigator.userAgent);
  const base = win ? "http://aizpv.localhost" : "aizpv://localhost";
  return `${base}/${encodeURIComponent(id)}/index.html?v=${version}${scroll ? `#${scroll}` : ""}`;
}

export interface PreviewTarget {
  docId: string;
  kind: PreviewKind;
  text: string;
  title: string;
  /** ファイルのフォルダ（まだ保存していなければ null） */
  dir: string | null;
  /** 開いているフォルダ */
  root: string | null;
  /** 保存してあるファイルの場所（ブラウザで開く用） */
  path: string | null;
}

export class PagePreview {
  readonly el: HTMLElement;
  private frame: HTMLIFrameElement;
  private titleEl: HTMLElement;
  private browserBtn: HTMLButtonElement;
  private version = 0;
  private scroll = new Map<string, number>();
  private current: PreviewTarget | null = null;
  private lastHtml = "";

  constructor(private deps: { onClose: () => void; openExternal: (path: string) => void }) {
    this.frame = h("iframe", {
      class: "page-preview-frame",
      title: "プレビュー",
      // ページのスクリプトは動かす（ボタンなど）。アプリの中身には触れられないようにする
      sandbox: "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads",
    }) as HTMLIFrameElement;
    this.titleEl = h("span", { class: "page-preview-title" });
    this.browserBtn = h(
      "button",
      { class: "btn plain small", type: "button", title: "保存してあるファイルを、いつものブラウザで開きます", onclick: () => this.current?.path && this.deps.openExternal(this.current.path) },
      "ブラウザで開く",
    ) as HTMLButtonElement;
    const reload = h("button", { class: "icon-btn small", type: "button", title: "読み直す（となりの CSS や画像を変えたとき）", html: icon("refresh", 14), onclick: () => this.reload() });
    const close = h("button", { class: "icon-btn small", type: "button", title: "プレビューを閉じる (Ctrl+Shift+V)", html: icon("x", 14), onclick: () => this.deps.onClose() });
    const bar = h("div", { class: "page-preview-bar" }, h("span", { html: icon("eye", 13) }), this.titleEl, h("span", { class: "page-preview-gap" }), this.browserBtn, reload, close);
    this.el = h("div", { class: "md-preview page-preview", hidden: true, "aria-label": "プレビュー" }, bar, this.frame);
    window.addEventListener("message", (e) => {
      if (e.source !== this.frame.contentWindow || !this.current) return;
      const y = (e.data as { aizomeScroll?: unknown } | null)?.aizomeScroll;
      if (typeof y === "number") this.scroll.set(this.current.docId, y);
    });
  }

  /** 内容を出す（同じ内容なら何もしない） */
  async show(target: PreviewTarget, dark: boolean): Promise<void> {
    const changedDoc = this.current?.docId !== target.docId;
    this.current = target;
    this.titleEl.textContent = `プレビュー：${target.title}`;
    this.browserBtn.hidden = !(target.kind === "html" && target.path);
    const html = buildPage(target.kind, target.text, target.title, dark);
    if (!changedDoc && html === this.lastHtml) return;
    this.lastHtml = html;
    await this.load(html);
  }

  reload(): void {
    if (this.lastHtml) void this.load(this.lastHtml);
  }

  private async load(html: string): Promise<void> {
    const t = this.current;
    if (!t) return;
    const y = this.scroll.get(t.docId) ?? 0;
    try {
      await invoke("preview_set", { id: t.docId, html, dir: t.dir ?? "", root: t.root });
      this.frame.removeAttribute("srcdoc");
      this.frame.src = frameUrl(t.docId, ++this.version, y);
    } catch {
      // アプリの外（ブラウザでの確認用）では、となりのファイルは読めないが、ページだけは出す
      this.frame.srcdoc = html;
    }
  }
}
