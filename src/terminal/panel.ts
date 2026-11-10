// 下部のターミナルパネル。複数タブ・実行用ターミナル・ファイル位置リンクを扱う
import { pty } from "../core/platform";
import { settings } from "../core/settings";
import { bus } from "../core/events";
import { h, clear } from "../core/dom";
import { icon } from "../ui/icons";
import { t } from "../core/i18n";
import { createTermView } from "./xtermView";
import { toast } from "../ui/toast";
import { menu, type MenuItem } from "../ui/menu";
import type { TermView } from "./types";

interface Session {
  ptyId: number | null;
  name: string;
  view: TermView;
  alive: boolean;
  runner: boolean;
  /** 実行用のとき、どのファイルのものか（ファイルごとに別のタブで実行して比べられる） */
  key?: string;
}

interface Watch {
  ptyId: number;
  start: number;
  lastData: number;
  partial: string;
  lastLine: string;
  repeat: number;
  recent: number[];
  warned: boolean;
  done: boolean;
}

export interface TerminalDeps {
  cwd: () => string | undefined;
  /** 「エラーを日本語で」ボタン */
  explainError?: () => void;
  openLocation: (path: string, line: number, col: number) => void;
  onVisibilityChange: (visible: boolean) => void;
  /** ファイルの実行が終わったとき、その出力（前回と比べるため） */
  /** marked は「値を見る」用の行の印（\u0000AZ行番号\u0000）を残したもの */
  onRunOutput?: (key: string, text: string, marked: string) => void;
  /** 「前回と比べる」ボタン */
  compareRuns?: (key: string | null) => void;
}

const START = "\x1b]633;aizome-start\x07";
const END = "\x1b]633;aizome-end\x07";

/** 出力の文字から、色や画面の操作の記号を取り除く */
function plainText(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[=>78]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\s+$/g, "");
}

export class TerminalPanel {
  readonly el: HTMLElement;
  private tabsEl: HTMLElement;
  private body: HTMLElement;
  private sessions: Session[] = [];
  private active: Session | null = null;
  private counter = 0;
  private visible = false;
  private listening = false;
  private lastRun: { command: string; cwd?: string } | null = null;
  private banner!: HTMLElement;
  /** 実行中のプログラムの見張り（長く動き続ける・同じ出力をくり返す）。実行用のタブごと */
  private watches = new Map<number, Watch>();
  private watchTimer: number | undefined;
  /** 左右に並べて比べている 2 つ */
  private pair: [Session, Session] | null = null;
  private pairBtn!: HTMLButtonElement;
  /** 直前に選んでいたタブ（「並べる」の相手） */
  private previous: Session | null = null;
  private lastRuns = new Map<string, { command: string; cwd?: string }>();
  /** 実行中の出力をためておく（ptyId ごと） */
  private captures = new Map<number, { key: string; text: string | null; tail: string }>();
  private compareBtn!: HTMLButtonElement;
  private compareReady = new Set<string>();
  private shells: { name: string; command: string }[] | null = null;

  constructor(private deps: TerminalDeps) {
    this.tabsEl = h("div", { class: "panel-tabs", role: "tablist" });
    this.body = h("div", { class: "panel-body" });
    const plus = this.button("plus", t("terminal.new"), () => this.newTerminal());
    const pick = this.button("chevronDown", t("terminal.pickShell"), () => void this.pickShell(pick));
    pick.classList.add("narrow");
    this.pairBtn = this.button("sidebar", t("terminal.pair"), () => this.togglePair()) as HTMLButtonElement;
    this.compareBtn = this.button("clock", t("runcmp.button"), () => this.deps.compareRuns?.(this.active?.runner ? (this.active.key ?? null) : null)) as HTMLButtonElement;
    const actions = h(
      "div",
      { class: "panel-actions" },
      this.compareBtn,
      this.pairBtn,
      h("span", { class: "panel-sep" }),
      this.button("stop", t("terminal.interrupt"), () => this.interrupt()),
      this.button("refresh", t("terminal.rerun"), () => void this.rerun()),
      (() => {
        const b = this.button("alert", t("terminal.explainError"), () => this.deps.explainError?.());
        b.classList.add("err-btn");
        return b;
      })(),
      h("span", { class: "panel-sep" }),
      plus,
      pick,
      this.button("trash", t("terminal.kill"), () => this.killActive()),
      this.button("x", t("terminal.hide"), () => this.hide()),
    );
    this.banner = h("div", { class: "panel-banner", hidden: true });
    this.el = h("section", { class: "panel", "aria-label": t("terminal.title") }, h("header", { class: "panel-header" }, this.tabsEl, actions), this.banner, this.body);

    new ResizeObserver(() => this.fitActive()).observe(this.body);
    bus.on("theme:changed", () => this.sessions.forEach((s) => s.view.applyTheme()));
    bus.on("settings:changed", ({ key }) => {
      if (key === "terminal.fontSize") this.sessions.forEach((s) => s.view.setFontSize(settings.get("terminal.fontSize")));
    });
  }

  private button(name: string, label: string, onclick: () => void) {
    return h("button", { class: "icon-btn", title: label, "aria-label": label, onclick, html: icon(name, 15) });
  }

  private async listen() {
    if (this.listening) return;
    this.listening = true;
    await pty.onData(({ id, data }) => {
      this.sessions.find((s) => s.ptyId === id)?.view.write(data);
      const cap = this.captures.get(id);
      if (cap) this.capture(id, cap, data);
      const w = this.watches.get(id);
      if (w) this.watchData(w, data);
    });
    await pty.onExit(({ id, code }) => {
      const s = this.sessions.find((x) => x.ptyId === id);
      if (!s) return;
      s.alive = false;
      s.view.write(`\r\n\x1b[2m${t("terminal.exited", { code: String(code ?? "?") })}\x1b[0m\r\n`);
      this.renderTabs();
    });
  }

  /** 見えない印の間の出力をためて、終わったら知らせる */
  private capture(id: number, cap: { key: string; text: string | null; tail: string }, data: string) {
    let chunk = cap.tail + data;
    cap.tail = "";
    for (;;) {
      if (cap.text === null) {
        const i = chunk.indexOf(START);
        if (i < 0) {
          cap.tail = chunk.slice(-START.length);
          return;
        }
        cap.text = "";
        chunk = chunk.slice(i + START.length);
        continue;
      }
      const j = chunk.indexOf(END);
      if (j < 0) {
        // 印が 2 回に分かれて届いたときのために、最後の少しは残しておく
        const keep = Math.min(chunk.length, END.length - 1);
        cap.text += chunk.slice(0, chunk.length - keep);
        cap.tail = chunk.slice(chunk.length - keep);
        if (cap.text.length > 400_000) cap.text = cap.text.slice(-400_000);
        return;
      }
      cap.text += chunk.slice(0, j);
      this.captures.delete(id);
      // 「値を見る」がどの行の出力かを知らせる見えない印（ESC ] 633;aiz;行番号 BEL）は、文字の印にしてから整える
      const marked = plainText(cap.text.replace(/\x1b\]633;aiz;(\d+)\x07/g, "\u0000AZ$1\u0000"));
      this.deps.onRunOutput?.(cap.key, marked.replace(/\u0000AZ\d+\u0000/g, ""), marked);
      return;
    }
  }

  /** 「前回と比べる」ボタンを、比べられるときだけ目立たせる */
  setCompareReady(key: string, ready: boolean) {
    if (ready) this.compareReady.add(key);
    else this.compareReady.delete(key);
    this.updateCompareBtn();
  }

  private updateCompareBtn() {
    const key = this.active?.runner ? this.active.key : undefined;
    this.compareBtn?.classList.toggle("on", !!key && this.compareReady.has(key));
  }

  get isVisible() {
    return this.visible;
  }

  show() {
    if (!this.visible) {
      this.visible = true;
      this.el.classList.add("open");
      this.deps.onVisibilityChange(true);
    }
    if (!this.sessions.length) void this.newTerminal();
    else requestAnimationFrame(() => {
      this.fitActive();
      this.active?.view.focus();
    });
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.remove("open");
    this.deps.onVisibilityChange(false);
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  /** 実行中のプログラムを止める（Ctrl+C を送る） */
  interrupt() {
    const s = this.active;
    if (s?.alive && s.ptyId !== null) pty.write(s.ptyId, "\x03").catch(() => {});
    s?.view.focus();
  }

  // ───────── 見張り

  private startWatch(ptyId: number) {
    this.hideBanner();
    if (!settings.get("run.watch")) {
      this.watches.delete(ptyId);
      return;
    }
    const now = Date.now();
    this.watches.set(ptyId, { ptyId, start: now, lastData: now, partial: "", lastLine: "", repeat: 0, recent: [], warned: false, done: false });
    if (this.watchTimer === undefined) this.watchTimer = window.setInterval(() => this.watchTick(), 1000);
  }

  private stopWatch(ptyId: number) {
    this.watches.delete(ptyId);
    if (!this.watches.size) {
      window.clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
  }

  private watchData(w: Watch, data: string) {
    w.lastData = Date.now();
    const text = (w.partial + data).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
    // 実行の終わりの印（--- 終了しました …）が出たら見張りをやめる
    if (/--- (終了しました|記録が終わりました|Finished|Recording finished)/.test(text)) {
      w.done = true;
      if (this.banner.dataset.pty === String(w.ptyId)) this.hideBanner();
      this.stopWatch(w.ptyId);
      return;
    }
    const lines = text.split("\n");
    w.partial = lines.pop() ?? "";
    const now = Date.now();
    for (const line of lines) {
      w.recent.push(now);
      if (line === w.lastLine && line.trim()) w.repeat++;
      else {
        w.lastLine = line;
        w.repeat = 0;
      }
    }
    while (w.recent.length && now - w.recent[0] > 3000) w.recent.shift();
    if (w.warned) return;
    if (w.repeat >= 300) this.warn(w, t("watch.repeat", { line: w.lastLine.slice(0, 40) }));
    else if (w.recent.length > 6000) this.warn(w, t("watch.flood"));
  }

  private watchTick() {
    const now = Date.now();
    for (const w of [...this.watches.values()]) {
      if (w.done) {
        this.stopWatch(w.ptyId);
        continue;
      }
      const s = this.sessions.find((x) => x.ptyId === w.ptyId);
      if (!s || !s.alive) {
        this.stopWatch(w.ptyId);
        continue;
      }
      if (w.warned) continue;
      const limit = Math.max(3, settings.get("run.watchSeconds") ?? 15) * 1000;
      if (now - w.start < limit) continue;
      // 最後の行が改行で終わらずに止まっている＝input() で入力を待っている、とみなして知らせない
      if (w.partial.trim() && now - w.lastData > 1200) continue;
      this.warn(w, t("watch.long", { sec: String(Math.round((now - w.start) / 1000)) }));
    }
  }

  private warn(w: Watch, message: string) {
    w.warned = true;
    const s = this.sessions.find((x) => x.ptyId === w.ptyId);
    const b = this.banner;
    clear(b);
    b.dataset.pty = String(w.ptyId);
    const who = s && this.sessions.filter((x) => x.runner).length > 1 ? `［${s.name}］ ` : "";
    b.append(
      h("span", { class: "panel-banner-text" }, "⚠ " + who + message),
      h("button", { class: "btn small danger", type: "button", onclick: () => (this.interruptPty(w.ptyId), this.hideBanner()) }, t("watch.stop")),
      h("button", { class: "btn small plain", type: "button", onclick: () => this.hideBanner() }, t("watch.keep")),
    );
    b.hidden = false;
    this.show();
  }

  private hideBanner() {
    this.banner.hidden = true;
  }

  private interruptPty(ptyId: number) {
    pty.write(ptyId, "\x03").catch(() => {});
  }

  /** 最後に実行したものをもう一度（今のタブがファイルの実行用なら、そのファイルのもの） */
  async rerun() {
    const key = this.active?.runner ? this.active.key : undefined;
    const last = key ? this.lastRuns.get(key) : this.lastRun;
    if (last) await this.run(last.command, last.cwd, key ? { key, name: this.active!.name.replace(/^▷ /, "") } : undefined);
  }

  private async pickShell(anchor: HTMLElement) {
    const shells = (this.shells ??= await pty.shells().catch(() => []));
    const items: MenuItem[] = shells.map((sh) => ({
      type: "action",
      label: sh.name,
      hint: sh.command === (settings.get("terminal.shell") || "") ? t("terminal.default") : undefined,
      run: () => this.newTerminal({ name: shellLabel(sh.command) ? undefined : sh.name, shell: sh.command }),
    }));
    if (shells.length) {
      items.push({ type: "separator" });
      items.push({
        type: "submenu",
        label: t("terminal.setDefault"),
        items: () =>
          shells.map((sh) => ({
            type: "action",
            label: sh.name,
            checked: (settings.get("terminal.shell") || "") === sh.command,
            run: () => settings.set("terminal.shell", sh.command),
          })),
      });
    }
    menu.open(anchor, items.length ? items : [{ type: "note", label: t("terminal.noShells") }]);
  }

  /** PowerShell・コマンドプロンプトのターミナルを新しく開く（Windows だけ） */
  openShell(kind: "powershell" | "cmd") {
    return this.newTerminal({ shell: kind === "cmd" ? "cmd.exe" : "powershell.exe" });
  }

  /** そのシェルで開いたときのタブの名前（「PowerShell 1」「cmd 2」など）。種類がわからないときは「ターミナル 1」 */
  private async tabName(shell: string | undefined): Promise<string> {
    let label = shellLabel(shell ?? "");
    if (!label && !shell && navigator.userAgent.includes("Windows")) {
      // 何も選んでいないときは、pwsh.exe があればそれ、なければ powershell.exe が開く
      const shells = (this.shells ??= await pty.shells().catch(() => []));
      label = shells.some((x) => x.command === "pwsh.exe") ? "PowerShell 7" : "PowerShell";
    }
    const n = String(++this.counter);
    return label ? `${label} ${n}` : t("terminal.tabName", { n });
  }

  async newTerminal(opts: { name?: string; runner?: boolean; cwd?: string; shell?: string; key?: string } = {}): Promise<Session> {
    const shell = opts.shell ?? (settings.get("terminal.shell") || undefined);
    const name = opts.name ?? (await this.tabName(shell));
    await this.listen();
    if (!this.visible) {
      this.visible = true;
      this.el.classList.add("open");
      this.deps.onVisibilityChange(true);
    }
    const view = createTermView({ fontSize: settings.get("terminal.fontSize") });
    const session: Session = {
      ptyId: null,
      name,
      view,
      alive: true,
      runner: !!opts.runner,
      key: opts.key,
    };
    this.sessions.push(session);
    this.body.append(view.el);
    this.select(session);
    view.fit();
    view.onFileLink((p, l, c) => this.deps.openLocation(p, l, c));
    view.onInput((data) => {
      if (session.alive && session.ptyId !== null) pty.write(session.ptyId, data).catch(() => {});
    });
    view.onResize((cols, rows) => {
      if (session.alive && session.ptyId !== null) pty.resize(session.ptyId, cols, rows).catch(() => {});
    });
    try {
      session.ptyId = await pty.spawn({
        cwd: opts.cwd ?? this.deps.cwd(),
        cols: Math.max(view.cols, 20),
        rows: Math.max(view.rows, 5),
        shell,
      });
    } catch (err) {
      session.alive = false;
      view.write(`\x1b[31m${t("terminal.spawnFailed")}\x1b[0m ${String(err)}\r\n`);
    }
    this.renderTabs();
    return session;
  }

  private select(s: Session, focus = true) {
    if (this.active && this.active !== s) this.previous = this.active;
    this.active = s;
    // 並べているときに、並べていないタブを選んだら 1 つの表示に戻す
    if (this.pair && !this.pair.includes(s)) this.pair = null;
    this.layout();
    if (focus) requestAnimationFrame(() => s.view.focus());
  }

  /** 表示の形（1 つ／左右に 2 つ）を反映 */
  private layout() {
    const shown: Session[] = this.pair ? [...this.pair] : this.active ? [this.active] : [];
    for (const x of this.sessions) {
      x.view.el.classList.toggle("active", shown.includes(x));
      x.view.el.classList.toggle("pair-left", !!this.pair && x === this.pair[0]);
      x.view.el.classList.toggle("pair-right", !!this.pair && x === this.pair[1]);
    }
    this.body.classList.toggle("pair", !!this.pair);
    this.updateCompareBtn();
    this.pairBtn?.classList.toggle("on", !!this.pair);
    this.renderTabs();
    requestAnimationFrame(() => shown.forEach((x) => x.view.fit()));
  }

  /** 2 つのターミナルを左右に並べて比べる（今のタブと、その前に見ていたタブ） */
  togglePair() {
    if (this.pair) {
      this.pair = null;
      this.layout();
      return;
    }
    const a = this.active;
    const runners = this.sessions.filter((x) => x !== a);
    const b = this.previous && this.sessions.includes(this.previous) && this.previous !== a ? this.previous : runners[runners.length - 1];
    if (!a || !b) {
      toast(t("terminal.pairNeedTwo"), "info", 5000);
      return;
    }
    this.pair = [b, a];
    this.layout();
  }

  /** ファイル（key）ごとの実行タブを 2 つ並べる。どちらかがなければ何もしない */
  pairKeys(left: string, right: string) {
    const a = this.sessions.find((x) => x.runner && x.key === left);
    const b = this.sessions.find((x) => x.runner && x.key === right);
    if (!a || !b || a === b) return false;
    this.pair = [a, b];
    this.layout();
    return true;
  }

  private close(s: Session) {
    if (s.ptyId !== null && s.alive) pty.kill(s.ptyId).catch(() => {});
    s.view.dispose();
    s.view.el.remove();
    this.sessions = this.sessions.filter((x) => x !== s);
    if (this.pair?.includes(s)) {
      const other = this.pair.find((x) => x !== s)!;
      this.pair = null;
      if (this.active === s) this.active = other;
      this.layout();
    }
    if (this.previous === s) this.previous = null;
    if (this.active === s) {
      const next = this.sessions[this.sessions.length - 1];
      if (next) this.select(next);
      else {
        this.active = null;
        this.hide();
      }
    }
    this.renderTabs();
  }

  clearActive() {
    this.active?.view.clear();
  }

  killActive() {
    if (this.active) this.close(this.active);
  }

  private renderTabs() {
    clear(this.tabsEl);
    for (const s of this.sessions) {
      const tab = h(
        "div",
        {
          class: "panel-tab" + (s === this.active ? " active" : "") + (this.pair?.includes(s) && s !== this.active ? " paired" : "") + (s.alive ? "" : " dead"),
          role: "tab",
          "aria-selected": String(s === this.active),
          tabindex: 0,
          onclick: () => this.select(s),
        },
        h("span", { class: "panel-tab-icon", html: icon(s.runner ? "play" : "terminal", 13) }),
        h("span", { class: "panel-tab-name" }, s.name),
        h("button", {
          class: "tab-close",
          title: t("tabs.close"),
          "aria-label": t("tabs.close"),
          html: icon("x", 12),
          onclick: (e: Event) => {
            e.stopPropagation();
            this.close(s);
          },
        }),
      );
      this.tabsEl.append(tab);
    }
  }

  private fitActive() {
    if (!this.visible) return;
    const list: Session[] = this.pair ? [...this.pair] : this.active ? [this.active] : [];
    for (const x of list) x.view.fit();
  }

  /**
   * 実行用ターミナルでコマンドを流す（なければ作る）。
   * who を渡すと、ファイルごとに別の実行タブを使う（2 つのファイルを同時に実行して比べられる）
   */
  async run(command: string, cwd?: string, who?: { key: string; name: string }) {
    this.lastRun = { command, cwd };
    if (who) this.lastRuns.set(who.key, { command, cwd });
    let s = who
      ? this.sessions.find((x) => x.runner && x.key === who.key && x.alive && x.ptyId !== null)
      : this.sessions.find((x) => x.runner && x.alive && x.ptyId !== null);
    if (!s) {
      // 実行用のコマンドは PowerShell 向けに書いてあるので、Windows の実行タブは PowerShell にする
      const isWindows = navigator.userAgent.includes("Windows");
      const paired = this.pair;
      s = await this.newTerminal({ name: who ? `▷ ${who.name}` : t("terminal.runTab"), runner: true, cwd, shell: isWindows ? "powershell.exe" : undefined, key: who?.key });
      if (paired) {
        this.pair = paired;
        this.layout();
      }
      // シェルのプロンプトが出るまで少し待つ
      await new Promise((r) => setTimeout(r, 350));
    } else {
      this.show();
      if (!this.pair?.includes(s)) this.select(s, false);
      else {
        this.active = s;
        this.layout();
      }
    }
    if (s.ptyId !== null && s.alive) {
      this.startWatch(s.ptyId);
      if (who) this.captures.set(s.ptyId, { key: who.key, text: null, tail: "" });
      await pty.write(s.ptyId, command + "\r");
    }
  }

  /** そのファイルの実行タブがあるか */
  hasRunner(key: string) {
    return this.sessions.some((x) => x.runner && x.key === key && x.alive);
  }

  /** 実行用ターミナル（なければ表示中のもの）の最近の出力 */
  recentOutput(maxLines = 300): string {
    const s = this.active?.runner ? this.active : (this.sessions.find((x) => x.runner) ?? this.active);
    return s ? s.view.recentText(maxLines) : "";
  }

  /** アクティブなターミナルに文字列を送る（拡張機能用） */
  async send(command: string) {
    const s = this.active && this.active.alive ? this.active : await this.newTerminal();
    this.show();
    if (s.ptyId !== null) await pty.write(s.ptyId, command + "\r");
  }
}

/** シェルのコマンドから、タブに出す短い名前を決める（わからなければ null） */
export function shellLabel(command: string): string | null {
  const exe = (command.trim().match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) ?? "").replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "");
  const names: Record<string, string> = { powershell: "PowerShell", pwsh: "PowerShell 7", cmd: "cmd", bash: "Git Bash", wsl: "WSL" };
  if (exe === "bash" && !/git/i.test(command)) return "bash";
  return names[exe] ?? null;
}
