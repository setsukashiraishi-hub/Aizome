import { toast } from "../ui/toast";
import { settings } from "../core/settings";
import { t } from "../core/i18n";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { TermView } from "./types";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeFromCss() {
  const v = (n: string, fallback: string) => cssVar(n) || fallback;
  // 背景画像があるときは透明にして、パネルの半透明な色を見せる
  const transparent = document.documentElement.classList.contains("has-bg");
  return {
    background: transparent ? "rgba(0, 0, 0, 0)" : v("--term-bg", "#151c30"),
    foreground: v("--text", "#dce3f2"),
    cursor: v("--cursor", "#7cc7d6"),
    cursorAccent: v("--term-bg", "#151c30"),
    selectionBackground: v("--selection", "#2f4a7a"),
    black: v("--ansi-black", "#2a3350"),
    red: v("--ansi-red", "#e2747e"),
    green: v("--ansi-green", "#8fc79a"),
    yellow: v("--ansi-yellow", "#e3c35a"),
    blue: v("--ansi-blue", "#7aa2e8"),
    magenta: v("--ansi-magenta", "#c79be0"),
    cyan: v("--ansi-cyan", "#6fc3d3"),
    white: v("--ansi-white", "#dce3f2"),
    brightBlack: v("--ansi-bright-black", "#5b6787"),
    brightRed: v("--ansi-red", "#e2747e"),
    brightGreen: v("--ansi-green", "#8fc79a"),
    brightYellow: v("--ansi-yellow", "#e3c35a"),
    brightBlue: v("--ansi-blue", "#7aa2e8"),
    brightMagenta: v("--ansi-magenta", "#c79be0"),
    brightCyan: v("--ansi-cyan", "#6fc3d3"),
    brightWhite: v("--ansi-bright-white", "#ffffff"),
  };
}

// path:line(:col)  例: src/main.rs:12:5 / C:\work\a.py:3
const LOC = /((?:[A-Za-z]:)?[\w.\-~/\\]*[\w\-]+\.[A-Za-z0-9]{1,8}):(\d+)(?::(\d+))?/g;
// Python のトレースバック  例: File "app.py", line 12
const PY = /File "([^"]+)", line (\d+)/g;

export function createTermView(opts: { fontSize: number }): TermView {
  const el = document.createElement("div");
  el.className = "term-view";
  const term = new Terminal({
    fontFamily: cssVar("--font-code") || "monospace",
    fontSize: opts.fontSize,
    lineHeight: 1.25,
    cursorBlink: true,
    allowProposedApi: true,
    allowTransparency: true,
    scrollback: 5000,
    theme: themeFromCss(),
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(el);
  // GPU で描画して、たくさん出力しても重くならないようにする（使えない環境ではふつうの描画）
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* WebGL が使えなければそのまま */
  }

  // コピーと貼り付け：文字を選んでいるときの Ctrl+C はコピー（選んでいなければ、ふつうどおり実行を止める）
  const copySelection = () => {
    const text = term.getSelection();
    if (!text) return false;
    void navigator.clipboard?.writeText(text).then(() => toast(t("terminal.copied"), "success", 1500));
    term.clearSelection();
    return true;
  };
  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
      return true;
    } catch {
      return false;
    }
  };
  let tabCb: (() => boolean) | null = null;
  term.attachCustomKeyEventHandler((e) => {
    // Tab：アイゾメの補完で決められれば、それを入れる（決められなければ、シェル自身の補完にまかせる）
    if (e.type === "keydown" && e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing && tabCb?.()) {
      e.preventDefault();
      return false;
    }
    if (e.type !== "keydown" || !settings.get("terminal.smartCopy")) return true;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return true;
    const k = e.key.toLowerCase();
    if (k === "c" && (term.hasSelection() || e.shiftKey)) {
      e.preventDefault();
      copySelection();
      return false;
    }
    if (k === "v") {
      e.preventDefault();
      void pasteClipboard().then((ok) => {
        // 読めなかったときは、シェル側の貼り付けに任せる
        if (!ok) term.input("\x16");
      });
      return false;
    }
    if (k === "a" && e.shiftKey) {
      e.preventDefault();
      term.selectAll();
      return false;
    }
    return true;
  });
  // 右クリック：選んでいればコピー、なければ貼り付け（Windows Terminal と同じ）
  el.addEventListener("contextmenu", (e) => {
    if (!settings.get("terminal.smartCopy")) return;
    e.preventDefault();
    if (!copySelection()) void pasteClipboard();
  });

  let linkCb: ((path: string, line: number, col: number) => void) | null = null;
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links: ILink[] = [];
      const add = (start: number, length: number, path: string, ln: number, col: number) => {
        links.push({
          range: { start: { x: start + 1, y }, end: { x: start + length, y } },
          text: line.slice(start, start + length),
          activate: () => linkCb?.(path, ln, col),
        });
      };
      for (const m of line.matchAll(PY)) add(m.index ?? 0, m[0].length, m[1], Number(m[2]), 1);
      for (const m of line.matchAll(LOC)) {
        if (/^\d+$/.test(m[1]) || m[1].includes("://")) continue;
        add(m.index ?? 0, m[0].length, m[1], Number(m[2]), Number(m[3] ?? 1));
      }
      callback(links.length ? links : undefined);
    },
  });

  return {
    el,
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (d) => term.write(d),
    onInput: (cb) => void term.onData(cb),
    onResize: (cb) => void term.onResize(({ cols, rows }) => cb(cols, rows)),
    onFileLink: (cb) => {
      linkCb = cb;
    },
    fit: () => {
      if (el.offsetParent !== null) {
        try {
          fitAddon.fit();
        } catch {
          /* 非表示中は測れない */
        }
      }
    },
    focus: () => term.focus(),
    clear: () => term.clear(),
    recentText: (maxLines = 300) => {
      const buf = term.buffer.active;
      const end = buf.baseY + buf.cursorY;
      const out: string[] = [];
      for (let i = Math.max(0, end - maxLines); i <= end; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        // 折り返された行はつなげる
        if (line.isWrapped && out.length) out[out.length - 1] += line.translateToString(true);
        else out.push(line.translateToString(true));
      }
      return out.join("\n");
    },
    onTab: (cb) => {
      tabCb = cb;
    },
    lineBeforeCursor: () => {
      const buf = term.buffer.active;
      let y = buf.baseY + buf.cursorY;
      const line = buf.getLine(y);
      if (!line) return null;
      if (line.translateToString(true, buf.cursorX).trim()) return null;
      let text = line.translateToString(false, 0, buf.cursorX);
      // 長い入力が折り返されているときは、前の行もつなげる
      while (buf.getLine(y)?.isWrapped && y > 0) {
        y--;
        text = (buf.getLine(y)?.translateToString(false) ?? "") + text;
      }
      return text;
    },
    cursorRect: () => {
      const screen = (el.querySelector(".xterm-screen") as HTMLElement | null) ?? el;
      const r = screen.getBoundingClientRect();
      const cw = r.width / Math.max(1, term.cols);
      const ch = r.height / Math.max(1, term.rows);
      const buf = term.buffer.active;
      return { left: r.left + buf.cursorX * cw, top: r.top + buf.cursorY * ch, height: ch };
    },
    applyTheme: () => {
      term.options.theme = themeFromCss();
    },
    setFontSize: (px) => {
      term.options.fontSize = px;
      fitAddon.fit();
    },
    dispose: () => term.dispose(),
  };
}
