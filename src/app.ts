// アプリ全体の組み立て：レイアウト、タブ、ファイル操作、コマンド、ステータスバー
import { h, clear } from "./core/dom";
import { t } from "./core/i18n";
import { bus } from "./core/events";
import { settings } from "./core/settings";
import { commands, formatKey, installKeybindings } from "./core/commands";
import { fs, dialog, sys, git, appWindow, osIntegration, runtimes, tools, type SysInfo } from "./core/platform";
import { basename, dirname, extname, isInside, join, relative, resolveIn, stripExt } from "./core/paths";
import { LANG_CHOICES, directiveAsComment, guessLanguage, parseDirective, setDirective } from "./core/langDirective";
import { createEditorHost } from "./editor/editor";
import type { EditorHost } from "./editor/types";
import { TerminalPanel } from "./terminal/panel";
import { expandCommand, findRunConfig } from "./terminal/runner";
import { FileTree } from "./ui/fileTree";
import { createExtensionsView } from "./ui/extensionsView";
import { settingsPage } from "./ui/settingsPage";
import { describeAiError, ensureLocalAi, useModelFile } from "./ai/localAi";
import { askAboutMemory, watchAiMemory } from "./ui/aiMemory";
import { startTourIfFirstTime } from "./ui/tour";
import { checkForUpdates, openUpdateDialog, startUpdateChecks, type UpdateDeps } from "./ui/updates";
import type { UpdateInfo } from "./core/platform";
import { applyTheme, listThemes } from "./ui/themes";
import { choose, inputBox } from "./ui/dialog";
import { toast } from "./ui/toast";
import { icon } from "./ui/icons";
import { openCommandPalette, openQuickOpen, quickPick } from "./ui/palette";
import { completer, type AiStatus } from "./ai/completer";
import { ExtensionHost } from "./extensions/host";
import { createSearchView, type SearchView } from "./ui/searchView";
import { createAiChatView, type AiChatView } from "./ui/aiChatView";
import { createDictView, type DictView } from "./ui/dictView";
import { aiRewrite } from "./ui/aiRewrite";
import { renderMarkdown } from "./ui/markdown";
import { PagePreview, previewKind } from "./ui/pagePreview";
import { invoke } from "@tauri-apps/api/core";
import { initAppearance, zoomBy } from "./ui/appearance";
import { menu, type MenuItem } from "./ui/menu";
import { menuDrawer } from "./ui/menuDrawer";
import { createSaveHistory } from "./ui/saveHistory";
import { createFileGroups } from "./ui/fileGroups";
import { exportSettings, importSettings } from "./ui/settingsTransfer";
import { contextMenu, type MenuItem as CtxItem } from "./ui/fileTree";
import { openPrintScreen } from "./ui/printScreen";
import { showDiff } from "./ui/diffView";
import { parseRunErrors } from "./run/errorExplain";
import { checkLangOf } from "./editor/codeCheck";
import { OutlineView } from "./ui/outlineView";
import { buildOutline, currentSymbol, outlineLangOf, type OutlineItem } from "./editor/outline";
import { formatBraces, formatJson, formatPlain, formatPython } from "./editor/format";
import { BUILD_TARGETS, RUN_TOOLS, fillBuild, isUnityScript, javaMainClass, type Toolchain } from "./run/build";
import { exportBody, exportCss, exportDocx, exportHtmlDocument, exportMarkdown, exportText, toBase64, type ExportOptions } from "./ui/exportCode";
import { clipHistory, clipLabel, startClipWatch } from "./core/clipHistory";
import { buildFromJapanese } from "./ui/jpBuildDialog";
import { sampleTemplate } from "./ai/jpBuild";
import { explainError } from "./ai/errorExplain";
import { helpPage } from "./ui/helpPage";
import { listSlash, openSlashPalette } from "./ui/slash";
import { registerBuiltinSlash, showErrorExplanation } from "./ui/slashCommands";
import { countChars } from "./core/jpText";
import { ENCODINGS, encodingById, encodingLabel } from "./core/encodings";
import { INPUT_WRAPPER_PY, presetCount, type InputPreset } from "./run/inputs";
import { editInputPreset } from "./ui/inputPresets";
import { hashText } from "./ai/infer";
import { instrument, parseTraceLog, splitLineOutputs, traceLangOf, type TraceLang } from "./run/instrument";
import { TRACER_PY, busiestLine, enclosingLoops, formatTrace, loopPositions, stepLoop, stepTimes, type TraceResult } from "./run/trace";
import { inferBusy, onInferBusy } from "./editor/inferState";
import { definitionSearchRegex, setDefinitionFallback } from "./editor/definition";

interface Doc {
  id: string;
  path: string | null;
  name: string;
  dirty: boolean;
  /** 文字コード（"utf-8" "shift_jis" など）と BOM・改行コード。保存するときにこのとおり書く */
  encoding: string;
  bom: boolean;
  eol: "crlf" | "lf";
}

/** 新しく保存するファイルの文字コード（設定） */
function defaultEncoding(): { encoding: string; bom: boolean; eol: "crlf" | "lf" } {
  const e = encodingById(settings.get("files.encoding"));
  return { encoding: e.encoding, bom: e.bom, eol: settings.get("files.eol") === "crlf" ? "crlf" : "lf" };
}

type ViewName = "explorer" | "outline" | "search" | "dict" | "ai" | "extensions" | "settings";

export class App {
  private editor: EditorHost = createEditorHost();
  private docs: Doc[] = [];
  private activeId: string | null = null;
  private root: string | null = null;
  private fileIndex: string[] = [];
  private untitledSeq = 0;
  /** 各ファイルを今どの言語（ファイル名）として扱っているか */
  private appliedName = new Map<string, string>();
  private langTimer: number | undefined;
  /** 実行用のコピー → 元のファイル（エラーの場所をクリックしたとき元を開くため） */
  private runCopies = new Map<string, string>();
  private tracePoll: number | undefined;
  /** 「値を見る」の結果があるファイル */
  private valuesShown = new Set<string>();
  private groups!: ReturnType<typeof createFileGroups>;
  private history!: ReturnType<typeof createSaveHistory>;
  /** 「値を見る」の記録（ファイルごと）と、ステップ表示の位置 */
  private traceRaw = new Map<string, TraceResult>();
  private traceStep: { docId: string; line: number; index: number } | null = null;
  private lastRunDir: string | null = null;
  private sys: SysInfo = { os: "unknown", home: "", defaultShell: "", pathSep: "/" };
  private statusItems = new Map<string, { text: string; tooltip?: string }>();

  // DOM
  private el!: HTMLElement;
  private tabsEl!: HTMLElement;
  private editorMount!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private outlineView = new OutlineView((it) => {
    this.editor.goTo(it.line, 1);
    this.editor.focus();
  });
  private outlineItems: OutlineItem[] = [];
  private outlineTimer = 0;
  private askedBlack = false;
  private redoBtn!: HTMLButtonElement;
  private welcomeEl!: HTMLElement;
  private sidebarEl!: HTMLElement;
  private sidebarTitle!: HTMLElement;
  private sidebarActions!: HTMLElement;
  private views = new Map<ViewName, HTMLElement>();
  private activityButtons = new Map<ViewName, HTMLElement>();
  private currentView: ViewName = "explorer";
  private workspaceLabel!: HTMLElement;
  private aiPill!: HTMLElement;
  private inlineBtn!: HTMLElement;

  private renderInlineBtn() {
    const on = settings.get("ai.inline");
    this.inlineBtn.classList.toggle("off", !on);
    this.inlineBtn.textContent = on ? t("inline.on") : t("inline.off");
    this.inlineBtn.title = on ? t("inline.onTitle") : t("inline.offTitle");
    this.inlineBtn.setAttribute("aria-pressed", String(on));
  }
  private statusLeft!: HTMLElement;
  private statusRight!: HTMLElement;
  private explorerEmpty!: HTMLElement;
  private menuButton!: HTMLElement;
  private breadcrumbsEl!: HTMLElement;
  private barsReady = new WeakSet<HTMLElement>();
  private previewEl!: HTMLElement;
  private editorArea!: HTMLElement;
  private previewOn = false;
  private pagePreview!: PagePreview;
  private previewTimer: number | undefined;
  private autoSaveTimer: number | undefined;
  private gitBranch: string | null = null;
  private gitChanges = 0;
  private restoring = false;
  private update: UpdateInfo | null = null;
  private updateDeps: UpdateDeps = {
    confirmQuit: () => this.confirmQuit(),
    onAvailable: (info) => {
      this.update = info;
      this.renderStatus();
    },
  };
  private searchView: SearchView;
  private dictView: DictView;
  private chatView: AiChatView;

  private tree: FileTree;
  private terminal: TerminalPanel;
  private extensions: ExtensionHost;

  constructor(private mountPoint: HTMLElement) {
    this.tree = new FileTree({
      openFile: (p) => void this.openFile(p),
      onRenamed: (from, to) => this.handleRenamed(from, to),
      onDeleted: (p) => this.handleDeleted(p),
      onChanged: () => void this.reindex(),
      unloadRoot: () => void this.unloadFolder(),
      extraMenu: (p, isDir, paths) => (settings.get("ui.fileGroups") ? this.groups.menuItemsFor(p, isDir, paths, (x) => this.tree.isDir(x)) : []),
    });
    this.groups = createFileGroups({
      root: () => this.root,
      openFile: (p) => void this.openFile(p),
      activePath: () => this.activeDoc()?.path ?? null,
      closeFiles: (paths) => {
        for (const d of [...this.docs]) if (d.path && paths.includes(d.path)) void this.closeDoc(d.id);
      },
      openPaths: () => this.docs.map((d) => d.path).filter((p): p is string => !!p),
    });
    this.history = createSaveHistory({
      home: () => this.sys.home,
      activeDoc: () => this.activeDoc() ?? null,
      getText: (id) => this.editor.getText(id),
      applyText: (id, text) => {
        if (id === this.activeId) this.editor.applyText(text);
        else this.editor.setText(id, text);
      },
    });
    this.terminal = new TerminalPanel({
      cwd: () => this.root ?? undefined,
      openLocation: (p, l, c) => void this.openLocation(p, l, c),
      onVisibilityChange: (v) => this.el.classList.toggle("panel-open", v),
      explainError: () => void this.explainLastError(),
      onRunOutput: (key, text, marked) => this.rememberRun(key, text, marked),
      compareRuns: (key) => void this.compareRuns(key),
    });
    this.extensions = new ExtensionHost({
      editor: this.editor,
      activePath: () => this.activeDoc()?.path ?? null,
      root: () => this.root,
      openFile: (p) => this.openFile(p),
      runInTerminal: (cmd) => this.terminal.send(cmd),
      setStatusItem: (key, text, tooltip) => {
        if (text === null) this.statusItems.delete(key);
        else this.statusItems.set(key, { text, tooltip });
        this.renderStatus();
      },
    });
    this.searchView = createSearchView({ root: () => this.root, open: (p, l, c) => void this.openFile(p, l, c) });
    this.chatView = createAiChatView({ editor: this.editor, activeName: () => this.activeDoc()?.name ?? null });
    this.dictView = createDictView({ editor: this.editor, activeName: () => this.activeDoc()?.name ?? null, hasDoc: () => !!this.activeDoc() });
  }

  async start() {
    this.build();
    this.registerCommands();
    this.registerSlashCommands();
    this.watchSideMode();
    this.setupDefinitionSearch();
    installKeybindings();
    this.bindEvents();

    try {
      this.sys = await sys.info();
    } catch (err) {
      console.warn("sys_info", err);
    }
    initAppearance();
    await this.extensions.loadAll();
    applyTheme(settings.get("ui.theme"));

    const last = settings.get("workspace.last");
    if (last && (await fs.exists(last).catch(() => false))) {
      await this.setRoot(last);
      if (settings.get("editor.restoreTabs")) await this.restoreSession();
    } else this.renderExplorerState();
    this.renderTabs();
    this.renderStatus();

    // PC の中の AI を探して、止まっていれば起動する（USB のモデルも探す）
    void ensureLocalAi({ quiet: true });
    let lastRecover = Date.now();
    completer.onStatus((st, detail) => {
      // つながらない・モデルがないときは、1分に1回まで自動で探し直す
      if (st === "error" && /NOT_RUNNING|MODEL_NOT_FOUND|CONNECT_FAILED/.test(detail ?? "") && Date.now() - lastRecover > 60000) {
        lastRecover = Date.now();
        void ensureLocalAi({ quiet: true });
      }
    });

    // ファイルやフォルダを画面にドラッグして開く
    this.setupFileDrop();

    // 「プログラムから開く」や右クリックから渡されたファイルを開く（起動中に渡されたものも）
    const takeOpenPaths = async () => {
      const paths = await osIntegration.takeOpenPaths().catch(() => [] as string[]);
      if (paths.length) await this.openDropped(paths);
    };
    await takeOpenPaths();
    osIntegration.onOpenPaths(() => void takeOpenPaths()).catch(() => {});

    // 新しい版がないか、ときどき調べる
    startUpdateChecks(this.updateDeps);

    // 閉じる前に未保存の確認
    appWindow.onCloseRequested(() => this.confirmQuit()).catch(() => {});
    // ほかのアプリから戻ってきたら Git の状態を更新、離れたら自動保存
    window.addEventListener("focus", () => void this.refreshGit());
    window.addEventListener("blur", () => {
      if (settings.get("editor.autoSave") === "focus") void this.saveAllDirty(true);
    });
    // 見ていないあいだは Git を調べない
    window.setInterval(() => document.hasFocus() && void this.refreshGit(), 30000);
  }

  // ───────────── セッション（開いていたタブの復元）

  private saveSession() {
    if (this.restoring) return;
    settings.set("session.files", this.docs.filter((d) => d.path).map((d) => d.path!));
    settings.set("session.active", this.activeDoc()?.path ?? "");
  }

  private async restoreSession() {
    const files = settings.get("session.files");
    const active = settings.get("session.active");
    this.restoring = true;
    try {
      for (const f of files) {
        if (await fs.exists(f).catch(() => false)) await this.openFile(f);
      }
      if (active && this.docs.some((d) => d.path === active)) this.activate(active);
    } finally {
      this.restoring = false;
      this.saveSession();
    }
  }

  private async confirmQuit(): Promise<boolean> {
    const dirty = this.docs.filter((d) => d.dirty);
    if (!dirty.length) return true;
    const answer = await choose(
      t("quit.title", { n: String(dirty.length) }),
      dirty.map((d) => `・${d.name}`).join("\n"),
      [
        { label: t("common.cancel"), value: "cancel", kind: "plain" },
        { label: t("quit.discard"), value: "discard", kind: "plain" },
        { label: t("quit.saveAll"), value: "save", kind: "primary" },
      ],
      "cancel",
    );
    if (answer === "cancel") return false;
    if (answer === "save") {
      for (const d of dirty) if (!(await this.save(d.id))) return false;
    }
    return true;
  }

  private async saveAllDirty(auto = false) {
    for (const d of this.docs) if (d.dirty && d.path) await this.save(d.id, false, { keepDirective: auto });
  }

  // ───────────── ドラッグ＆ドロップ

  private setupFileDrop() {
    const overlay = h(
      "div",
      { class: "drop-overlay", hidden: true, "aria-hidden": "true" },
      h("div", { class: "drop-box" }, h("span", { html: icon("folderOpen", 28) }), h("strong", {}, t("drop.title")), h("span", {}, t("drop.help"))),
    );
    document.body.append(overlay);
    appWindow
      .onFileDrop(({ type, paths }) => {
        if (type === "enter" || type === "over") overlay.hidden = false;
        else overlay.hidden = true;
        if (type === "drop" && paths.length) void this.openDropped(paths);
      })
      .catch((err) => console.warn("drag-drop", err));
  }

  private async openDropped(paths: string[]) {
    const dirs: string[] = [];
    const files: string[] = [];
    for (const p of paths) {
      const isDir = await fs.isDir(p).catch(() => false);
      (isDir ? dirs : files).push(p);
    }
    // フォルダはワークスペースとして開く（いくつか落とされたら最初の1つ）
    if (dirs.length) await this.openFolder(dirs[0]);
    for (const f of files) {
      const ext = extname(f);
      if (ext === ".gguf") {
        // AI のモデルファイルなら読み込む
        await useModelFile(f);
      } else if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"].includes(ext) && settingsPage.isOpen) {
        // 設定画面を開いているときに画像を落としたら背景にする
        settings.set("look.bgImage", f);
      } else {
        await this.openFile(f);
      }
    }
  }

  // ───────────── Git

  private async refreshGit() {
    if (!this.root) return;
    try {
      const st = await git.status(this.root);
      const files = new Map<string, string>();
      const base = this.root.replace(/\\/g, "/").replace(/\/+$/, "");
      for (const f of st.files) files.set(`${base}/${f.path.replace(/\/+$/, "")}`, f.status);
      this.tree.setGit(files);
      const branch = st.isRepo ? st.branch : null;
      if (branch !== this.gitBranch || files.size !== this.gitChanges) {
        this.gitBranch = branch;
        this.gitChanges = files.size;
        this.renderStatus();
      }
    } catch {
      /* git がなければ表示しない */
    }
  }

  // ───────────── レイアウト

  private build() {
    const button = (name: string, label: string, onclick: () => void, extra = "") =>
      h("button", { class: `icon-btn ${extra}`, title: label, "aria-label": label, onclick, html: icon(name, 16) });

    this.workspaceLabel = h("span", { class: "workspace-name" });
    this.aiPill = h("button", { class: "ai-pill", onclick: () => this.onAiPillClick() });
    // AI の補完（薄い文字）だけを切りかえるボタン（自動判定・説明・チャットはそのまま使える）
    this.inlineBtn = h("button", { class: "inline-toggle", type: "button", onclick: () => settings.set("ai.inline", !settings.get("ai.inline")) });
    this.renderInlineBtn();
    const paletteKey = formatKey("Mod-P");

    const menuBtn = h(
      "button",
      { class: "menu-btn", type: "button", title: t("menu.open"), "aria-label": t("menu.open"), "aria-haspopup": "menu", "aria-expanded": "false" },
      h("span", { class: "brand-mark", "aria-hidden": "true" }, "藍"),
      h("span", { class: "brand-name" }, "Aizome"),
      h("span", { class: "menu-btn-caret", html: icon("chevronDown", 12) }),
    );
    menuBtn.addEventListener("click", () => {
      // 画面の左側から半透明のメニューがすっと出てくる
      if (menuDrawer.isOpen) return menuDrawer.close();
      menuBtn.setAttribute("aria-expanded", "true");
      menuBtn.classList.add("open");
      // 上にメニューバー（編集・表示…）が出ているときは、ここには「ファイル」だけ（検索では全部探せる）
      const barShown = !!menubar.offsetParent;
      menuDrawer.open(
        () => this.menuItems(),
        () => {
          menuBtn.setAttribute("aria-expanded", "false");
          menuBtn.classList.remove("open");
        },
        { groups: barShown ? 1 : Infinity },
      );
    });
    this.menuButton = menuBtn;

    // 「藍 Aizome」の右に並ぶメニュー（編集・表示・実行…）。押すと下に項目が出る
    const menubar = h("nav", { class: "menubar", role: "menubar" });
    const barButtons: HTMLButtonElement[] = [];
    let openIndex = -1;
    let closed = { index: -1, at: 0 };
    const openBar = (i: number) => {
      const top = this.menuItems().filter((x): x is Extract<MenuItem, { type: "submenu" }> => x.type === "submenu").slice(1);
      const item = top[i];
      const btn = barButtons[i];
      if (!item || !btn) return;
      if (menuDrawer.isOpen) menuDrawer.close();
      openIndex = i;
      barButtons.forEach((b, j) => b.classList.toggle("open", j === i));
      menu.open(btn, item.items(), () => {
        if (openIndex === i) {
          openIndex = -1;
          closed = { index: i, at: performance.now() };
          btn.classList.remove("open");
        }
      });
    };
    const renderBar = () => {
      clear(menubar);
      barButtons.length = 0;
      const top = this.menuItems().filter((x): x is Extract<MenuItem, { type: "submenu" }> => x.type === "submenu").slice(1);
      top.forEach((item, i) => {
        const b = h("button", { class: "menubar-item", type: "button", role: "menuitem", "aria-haspopup": "menu" }, item.label) as HTMLButtonElement;
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          // 開いているメニューのボタンをもう一度押したら閉じるだけ（外側のクリックで先に閉じている）
          if (closed.index === i && performance.now() - closed.at < 300) return;
          if (openIndex === i && menu.isOpen) menu.close();
          else openBar(i);
        });
        // ひとつ開いているときは、マウスを横に動かすだけで隣のメニューに切りかわる
        b.addEventListener("mouseenter", () => {
          if (menu.isOpen && openIndex >= 0 && openIndex !== i) openBar(i);
        });
        b.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            openBar(i);
          }
        });
        barButtons.push(b);
        menubar.append(b);
      });
    };
    renderBar();
    bus.on("settings:changed", ({ key }) => {
      if (key === "ui.language") renderBar();
    });

    this.undoBtn = h("button", { class: "icon-btn top-tool history-btn", type: "button", html: icon("undo", 17), onclick: () => void this.historyStep("undo") }) as HTMLButtonElement;
    this.redoBtn = h("button", { class: "icon-btn top-tool history-btn", type: "button", html: icon("redo", 17), onclick: () => void this.historyStep("redo") }) as HTMLButtonElement;
    this.renderHistoryButtons();

    const topbar = h(
      "header",
      { class: "topbar" },
      h("div", { class: "brand" }, menuBtn, menubar),
      this.workspaceLabel,
      h(
        "button",
        { class: "palette-trigger", onclick: () => this.quickOpen() },
        h("span", { html: icon("search", 14) }),
        h("span", { class: "palette-trigger-text" }, t("top.search")),
        h("kbd", {}, paletteKey),
      ),
      h(
        "div",
        { class: "top-actions" },
        this.undoBtn,
        this.redoBtn,
        h("span", { class: "top-sep", "aria-hidden": "true" }),
        button("wand", t("cmd.slash"), () => void openSlashPalette("/", () => this.quickOpen()), "top-tool"),
        button("help", `${t("cmd.help")} (F1)`, () => helpPage.open(), "top-tool"),
        this.inlineBtn,
        this.aiPill,
      ),
    );

    const activity = h("nav", { class: "activity", "aria-label": t("activity.label") });
    const addActivity = (view: ViewName, name: string, label: string) => {
      const b = button(name, label, () => this.toggleView(view), "activity-btn");
      this.activityButtons.set(view, b);
      activity.append(b);
    };
    addActivity("explorer", "files", t("view.explorer"));
    addActivity("outline", "outline", t("view.outline"));
    addActivity("search", "search", t("view.search"));
    addActivity("dict", "book", t("view.dict"));
    this.activityButtons.get("dict")?.classList.add("activity-dict");
    addActivity("ai", "spark", t("view.ai"));
    addActivity("extensions", "puzzle", t("view.extensions"));
    activity.append(h("div", { class: "activity-spacer" }));
    activity.append(button("terminal", t("cmd.toggleTerminal"), () => this.terminal.toggle(), "activity-btn"));
    activity.append(button("gear", t("view.settings"), () => settingsPage.toggle(), "activity-btn"));

    this.sidebarTitle = h("h2", { class: "sidebar-title" });
    this.sidebarActions = h("div", { class: "sidebar-actions" });
    this.explorerEmpty = h(
      "div",
      { class: "explorer-empty" },
      h("p", {}, t("explorer.empty")),
      h("button", { class: "btn primary", onclick: () => this.openFolder() }, t("cmd.openFolder")),
    );
    const explorer = h(
      "div",
      { class: "view explorer-view" },
      this.groups.el,
      h("div", { class: "explorer-tree" }, this.explorerEmpty, this.tree.el),
      this.history.el,
    );
    this.groups.render();
    void this.history.refresh();
    this.views.set("explorer", explorer);
    this.views.set("outline", this.outlineView.el);
    this.outlineView.el.addEventListener("view:show", () => this.refreshOutline(true));
    this.views.set("search", this.searchView.el);
    this.views.set("dict", this.dictView.el);
    this.views.set("ai", this.chatView.el);
    this.views.set("extensions", createExtensionsView(this.extensions));
    const viewsHost = h("div", { class: "sidebar-body" }, ...this.views.values());
    this.sidebarEl = h("aside", { class: "sidebar" }, h("div", { class: "sidebar-head" }, this.sidebarTitle, this.sidebarActions), viewsHost);

    const sideResizer = h("div", { class: "resizer resizer-x", role: "separator", "aria-orientation": "vertical" });
    const panelResizer = h("div", { class: "resizer resizer-y", role: "separator", "aria-orientation": "horizontal" });

    this.tabsEl = h("div", { class: "tabs", role: "tablist" });
    this.editorMount = h("div", { class: "editor-mount" });
    this.welcomeEl = this.buildWelcome();
    this.breadcrumbsEl = h("nav", { class: "breadcrumbs", "aria-label": t("breadcrumbs.label") });
    this.pagePreview = new PagePreview({
      onClose: () => {
        this.previewOn = false;
        this.renderPreview();
        this.renderBreadcrumbs();
      },
      openExternal: (path) => void invoke("preview_open_external", { path }).catch((e) => toast(String(e), "error")),
    });
    this.previewEl = this.pagePreview.el;
    this.editorArea = h("div", { class: "editor-area" }, this.editorMount, this.previewEl, this.welcomeEl);
    const editorArea = this.editorArea;
    const main = h("main", { class: "main" }, this.tabsEl, editorArea, panelResizer, this.terminal.el);

    this.statusLeft = h("div", { class: "status-left" });
    this.statusRight = h("div", { class: "status-right" });
    const statusbar = h("footer", { class: "statusbar" }, this.statusLeft, this.statusRight);

    this.el = h("div", { class: "app" }, topbar, h("div", { class: "body" }, activity, this.sidebarEl, sideResizer, main), statusbar);
    this.el.style.setProperty("--side-w", `${settings.get("ui.sidebarWidth")}px`);
    this.el.style.setProperty("--panel-h", `${settings.get("ui.panelHeight")}px`);
    this.el.classList.toggle("hide-line-numbers", !settings.get("editor.lineNumbers"));
    this.mountPoint.append(this.el);

    this.editor.mount(this.editorMount);
    startClipWatch();
    bus.on("pip:install", async ({ pkg }) => {
      const win = this.sys.os === "windows";
      const py = await this.resolvePython((win ? "python" : "python3") + " ");
      if (py === null) return;
      await this.terminal.run(`${py.trim()} -m pip install ${pkg}`);
    });
    this.editorMount.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.editorMenu(e.clientX, e.clientY);
    });
    this.editor.onFocusDoc((id) => {
      if (id !== this.activeId) this.activate(id);
    });
    this.showView("explorer");
    this.dragResize(sideResizer, "x");
    this.dragResize(panelResizer, "y");
    this.renderAi(completer.status);
  }

  private buildWelcome(): HTMLElement {
    const row = (cmd: string, label: string) => {
      const c = commands.get(cmd);
      return h(
        "button",
        { class: "welcome-action", onclick: () => commands.execute(cmd) },
        h("span", {}, label),
        c?.key ? h("kbd", {}, formatKey(c.key)) : null,
      );
    };
    // コマンド登録前に呼ばれるので、キー表示は後から差し込む
    const el = h("div", { class: "welcome" });
    const fill = () => {
      clear(el);
      el.append(
        h("div", { class: "welcome-mark", "aria-hidden": "true" }, "藍"),
        h("h1", { class: "welcome-title" }, "Aizome"),
        h("p", { class: "welcome-lead" }, t("welcome.lead")),
        h(
          "div",
          { class: "welcome-actions" },
          row("file.openFolder", t("cmd.openFolder")),
          row("file.new", t("cmd.newFile")),
          row("file.quickOpen", t("cmd.quickOpen")),
          row("view.commandPalette", t("cmd.commandPalette")),
          row("terminal.toggle", t("cmd.toggleTerminal")),
        ),
        h("div", {}, this.recentList()),
        h("p", { class: "welcome-hint" }, t("welcome.aiHint")),
      );
    };
    queueMicrotask(fill);
    bus.on("settings:changed", ({ key }) => (key === "ui.language" || key === "workspace.recent") && fill());
    return el;
  }

  private recentList(): HTMLElement | null {
    const recent = settings.get("workspace.recent").filter((r) => r !== this.root);
    if (!recent.length) return null;
    return h(
      "div",
      { class: "welcome-recent" },
      h("h2", {}, t("welcome.recent")),
      ...recent.slice(0, 6).map((r) =>
        h("button", { class: "recent-item", type: "button", title: r, onclick: () => this.openFolder(r) }, h("span", { class: "recent-name" }, basename(r)), h("span", { class: "recent-path" }, r)),
      ),
    );
  }

  private dragResize(handle: HTMLElement, axis: "x" | "y") {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      const startPos = axis === "x" ? e.clientX : e.clientY;
      const hiddenAtStart = axis === "x" && this.el.classList.contains("sidebar-hidden");
      const start = axis === "x" ? (hiddenAtStart ? 0 : settings.get("ui.sidebarWidth")) : settings.get("ui.panelHeight");
      let value = axis === "x" ? settings.get("ui.sidebarWidth") : start;
      let collapsed = hiddenAtStart;
      if (axis === "x") document.body.classList.add("resizing-x");
      const move = (ev: PointerEvent) => {
        const delta = (axis === "x" ? ev.clientX : ev.clientY) - startPos;
        if (axis === "x") {
          // 細くしすぎたら自動で折りたたむ（もう一度引っぱると開く）
          const raw = start + delta;
          collapsed = raw < 120 && settings.get("ui.sidebarAutoCollapse");
          if (collapsed) {
            this.collapseSidebar(true);
            return;
          }
          if (this.el.classList.contains("sidebar-hidden")) this.collapseSidebar(false);
          value = Math.round(Math.min(560, Math.max(180, raw)));
          this.el.style.setProperty("--side-w", `${value}px`);
        } else {
          value = Math.round(Math.min(innerHeight - 200, Math.max(120, start - delta)));
          this.el.style.setProperty("--panel-h", `${value}px`);
        }
      };
      const up = () => {
        handle.classList.remove("dragging");
        document.body.classList.remove("resizing-x");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        if (axis === "y" || !collapsed) settings.set(axis === "x" ? "ui.sidebarWidth" : "ui.panelHeight", value);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  // ───────────── サイドバー

  private showView(view: ViewName) {
    if (view === "settings") {
      settingsPage.open();
      return;
    }
    this.currentView = view;
    this.el.classList.remove("sidebar-hidden");
    for (const [name, el] of this.views) {
      const on = name === view;
      el.hidden = !on;
      if (on) el.dispatchEvent(new Event("view:show"));
    }
    if (view === "search") this.searchView.focus(this.editor.getSelection().split("\n")[0] || undefined);
    if (view === "ai") this.chatView.focus();
    for (const [name, b] of this.activityButtons) b.classList.toggle("active", name === view);
    this.sidebarTitle.textContent = t(`view.${view}`);
    clear(this.sidebarActions);
    this.sidebarActions.append(
      h("button", {
        class: "icon-btn sidebar-collapse",
        title: t("side.collapse", { key: formatKey("Mod-B") }),
        "aria-label": t("side.collapse", { key: formatKey("Mod-B") }),
        html: icon("sidebar", 15),
        onclick: () => this.collapseSidebar(true),
      }),
    );
    if (view === "explorer" && this.root) {
      const b = (name: string, label: string, fn: () => void) =>
        h("button", { class: "icon-btn", title: label, "aria-label": label, html: icon(name, 15), onclick: fn });
      this.sidebarActions.append(
        b("newFile", t("tree.newFile"), () => this.tree.newFile()),
        b("newFolder", t("tree.newFolder"), () => this.tree.newFolder()),
        b("refresh", t("tree.refresh"), () => void this.tree.refresh().then(() => this.reindex())),
        b("folderOpen", t("cmd.openFolder"), () => this.openFolder()),
        b("x", t("tree.unload"), () => void this.unloadFolder()),
      );
    }
  }

  /** 左のエクスプローラーなどを折りたたむ／開く */
  private collapseSidebar(on: boolean) {
    this.el.classList.toggle("sidebar-hidden", on);
    for (const [name, b] of this.activityButtons) b.classList.toggle("active", !on && name === this.currentView);
    if (!on) this.el.style.setProperty("--side-w", `${settings.get("ui.sidebarWidth")}px`);
  }

  private toggleView(view: ViewName) {
    if (this.currentView === view && !this.el.classList.contains("sidebar-hidden")) {
      this.el.classList.add("sidebar-hidden");
      for (const b of this.activityButtons.values()) b.classList.remove("active");
    } else this.showView(view);
  }

  private renderExplorerState() {
    this.explorerEmpty.hidden = !!this.root;
    this.tree.el.hidden = !this.root;
    this.workspaceLabel.textContent = this.root ? basename(this.root) : "";
    this.workspaceLabel.title = this.root ?? "";
    if (this.currentView === "explorer") this.showView("explorer");
  }

  // ───────────── ワークスペースとファイル

  async openFolder(path?: string) {
    const picked = path ?? (await dialog.pickFolder());
    if (picked) await this.setRoot(picked);
  }

  /** 開いているフォルダの読み込みを解除する（ファイルは消さない） */
  async unloadFolder() {
    if (!this.root) return;
    for (const d of [...this.docs]) if (d.path && isInside(this.root, d.path)) await this.closeDoc(d.id);
    if (this.docs.some((d) => d.path && this.root && isInside(this.root, d.path))) return;
    const was = this.root;
    this.root = null;
    settings.set("workspace.last", "");
    await this.tree.setRoot(null);
    this.groups.render();
    this.renderExplorerState();
    this.fileIndex = [];
    bus.emit("workspace:changed", { root: null });
    toast(t("tree.unloaded", { name: basename(was) }), "info", 4000);
  }

  private async setRoot(root: string) {
    if (this.root && this.root !== root) {
      // 別のフォルダに移るときは、今のタブを閉じる
      for (const d of [...this.docs]) await this.closeDoc(d.id);
      if (this.docs.length) return;
    }
    this.root = root;
    this.groups.render();
    settings.set("workspace.last", root);
    settings.set("workspace.recent", [root, ...settings.get("workspace.recent").filter((r) => r !== root)].slice(0, 10));
    await this.tree.setRoot(root);
    this.renderExplorerState();
    bus.emit("workspace:changed", { root });
    await this.reindex();
    this.gitBranch = null;
    void this.refreshGit();
  }

  private async reindex() {
    if (!this.root) return;
    try {
      this.fileIndex = await fs.walk(this.root, 20000);
    } catch {
      this.fileIndex = [];
    }
  }

  private quickOpen() {
    // フォルダを開いていなくても、/ の便利機能とヘルプは使える
    void openQuickOpen(() => (this.root ? this.fileIndex : []), this.root ?? "", (p) => void this.openFile(p));
  }

  private activeDoc(): Doc | undefined {
    return this.docs.find((d) => d.id === this.activeId);
  }

  async openFile(path: string, line?: number, col?: number) {
    let doc = this.docs.find((d) => d.path === path);
    if (!doc) {
      let text: string;
      let read: Awaited<ReturnType<typeof fs.readFileEnc>>;
      try {
        read = await fs.readFileEnc(path, undefined, settings.get("files.guessEncoding"));
        text = read.text;
      } catch (err) {
        const msg = String(err);
        toast(
          msg.includes("BINARY_FILE") ? t("file.binary", { name: basename(path) }) : msg.includes("FILE_TOO_LARGE") ? t("file.tooLarge", { name: basename(path) }) : t("file.openFailed", { name: basename(path), err: msg }),
          "warn",
        );
        return;
      }
      doc = { id: path, path, name: basename(path), dirty: false, encoding: read.encoding, bom: read.bom, eol: read.eol };
      if (read.encoding !== "utf-8") toast(t("enc.openedAs", { name: doc.name, enc: encodingLabel(read.encoding, read.bom) }), "info", 7000);
      if (read.lossy) toast(t("enc.lossy", { name: doc.name }), "warn", 9000);
      this.docs.push(doc);
      await this.editor.open(doc.id, text, doc.name);
      this.appliedName.set(doc.id, doc.name);
      this.refreshLanguage(doc);
      bus.emit("file:opened", { path });
      this.saveSession();
    }
    this.activate(doc.id);
    if (line) requestAnimationFrame(() => this.editor.goTo(line, col));
  }

  private async openLocation(p: string, line: number, col: number) {
    // 実行用のコピーの場所なら、元のファイルを開く
    for (const [copy, docId] of this.runCopies) {
      if (p === copy || p.replace(/\\/g, "/").endsWith(copy.replace(/\\/g, "/").split("/").slice(-3).join("/"))) {
        if (this.docs.some((d) => d.id === docId)) {
          this.activate(docId);
          this.editor.goTo(line, col);
          return;
        }
      }
    }
    const candidates = [p];
    if (this.lastRunDir) candidates.push(resolveIn(this.lastRunDir, p));
    if (this.root) candidates.push(resolveIn(this.root, p));
    for (const c of candidates) {
      if (/^([A-Za-z]:[\\/]|\/)/.test(c) && (await fs.exists(c).catch(() => false))) {
        await this.openFile(c, line, col);
        return;
      }
    }
    toast(t("file.notFound", { name: p }), "warn");
  }

  newUntitled() {
    const id = `untitled:${++this.untitledSeq}`;
    const doc: Doc = { id, path: null, name: t("file.untitled", { n: String(this.untitledSeq) }), dirty: false, ...defaultEncoding() };
    this.docs.push(doc);
    const name = `untitled${settings.get("files.newFileLanguage") || ".py"}`;
    this.appliedName.set(id, name);
    void this.editor.open(id, "", name).then(() => this.activate(id));
  }

  /**
   * このファイルを何語として扱うか。
   * 1 行目の「## py ##」などの指定 → 保存前なら中身から推測 → 新しいファイルの言語（設定）→ 拡張子
   */
  private effectiveName(doc: Doc): string {
    const head = this.editor.peek(doc.id, 4000);
    const directive = this.directiveOf(head.split("\n", 1)[0] ?? "");
    const base = doc.path ? doc.name : `untitled${settings.get("files.newFileLanguage") || ".py"}`;
    if (directive) return stripExt(base) + directive.ext;
    if (!doc.path && settings.get("files.guessLanguage")) {
      const guessed = guessLanguage(head);
      if (guessed) return "untitled" + guessed;
      // 推測できないときは、今の扱いを続ける（入力のたびに言語が変わらないように）
      return this.appliedName.get(doc.id) ?? base;
    }
    return doc.name;
  }

  /** 言語の扱いを見直して、変わっていたらエディタ（色分け・AI・実行）に反映する */
  private refreshLanguage(doc: Doc) {
    if (!this.editor.has(doc.id)) return;
    const name = this.effectiveName(doc);
    if (this.appliedName.get(doc.id) === name) return;
    this.appliedName.set(doc.id, name);
    void this.editor.rename(doc.id, doc.id, name).then(() => this.renderStatus());
  }

  /** 文字コード：保存する文字コードを変える／文字コードを指定して開き直す／改行コードを変える */
  async pickEncoding() {
    const doc = this.activeDoc();
    if (!doc) return;
    type Act = "save" | "reopen" | "eol";
    const act = await quickPick<Act>(
      [
        { label: t("enc.actSave"), detail: t("enc.now", { enc: encodingLabel(doc.encoding, doc.bom) }), value: "save" },
        ...(doc.path ? [{ label: t("enc.actReopen"), detail: t("enc.actReopenDetail"), value: "reopen" as Act }] : []),
        { label: t("enc.actEol", { eol: doc.eol === "crlf" ? "LF" : "CRLF" }), detail: t("enc.nowEol", { eol: doc.eol === "crlf" ? "CRLF" : "LF" }), value: "eol" },
      ],
      t("enc.pick"),
    );
    if (!act) return;
    if (act === "eol") {
      doc.eol = doc.eol === "crlf" ? "lf" : "crlf";
      doc.dirty = true;
      this.renderTabs();
      this.renderStatus();
      if (doc.path) await this.save(doc.id, false, { keepDirective: true });
      toast(t("enc.eolChanged", { eol: doc.eol === "crlf" ? "CRLF" : "LF" }), "success");
      return;
    }
    const choice = await quickPick(
      ENCODINGS.map((e) => ({ label: e.label, detail: e.note, value: e })),
      act === "save" ? t("enc.actSave") : t("enc.actReopen"),
    );
    if (!choice) return;
    if (act === "save") {
      doc.encoding = choice.encoding;
      doc.bom = choice.bom;
      doc.dirty = true;
      this.renderTabs();
      this.renderStatus();
      if (doc.path && (await this.save(doc.id, false, { keepDirective: true }))) toast(t("enc.savedAs", { enc: choice.label }), "success");
      else if (!doc.path) toast(t("enc.willSaveAs", { enc: choice.label }), "info");
      return;
    }
    if (!doc.path) return;
    if (doc.dirty) {
      const ok = await choose(t("enc.reopenTitle"), t("enc.reopenDirty"), [
        { label: t("common.cancel"), value: false, kind: "plain" },
        { label: t("enc.reopenAnyway"), value: true, kind: "danger" },
      ], false);
      if (!ok) return;
    }
    try {
      const read = await fs.readFileEnc(doc.path, choice.encoding);
      doc.encoding = read.encoding;
      doc.bom = read.bom || choice.bom;
      doc.eol = read.eol;
      this.editor.setText(doc.id, read.text);
      doc.dirty = false;
      this.renderTabs();
      this.renderStatus();
      toast(read.lossy ? t("enc.reopenLossy", { enc: choice.label }) : t("enc.reopened", { enc: choice.label }), read.lossy ? "warn" : "success", 7000);
    } catch (err) {
      toast(t("file.openFailed", { name: doc.name, err: String(err) }), "error");
    }
  }

  /** ステータスバーの言語をクリック：1 行目に「## 言語 ##」を書いて切り替える */
  private async pickLanguage() {
    const doc = this.activeDoc();
    if (!doc) return;
    const current = extname(this.appliedName.get(doc.id) ?? doc.name);
    const choice = await quickPick(
      LANG_CHOICES.map((c) => ({ label: c.label, detail: c.ext === current ? t("lang.current") : `## ${c.tag} ##`, value: c })),
      t("lang.pick"),
    );
    if (!choice) return;
    this.editor.activate(doc.id);
    this.editor.applyText(setDirective(this.editor.getText(doc.id), choice));
    this.refreshLanguage(doc);
    toast(t("lang.set", { name: choice.label, tag: `## ${choice.tag} ##` }), "success", 5000);
  }

  private activate(id: string) {
    this.activeId = id;
    this.editor.activate(id);
    this.renderHistoryButtons();
    this.refreshOutline(true);
    this.groups?.render();
    void this.history?.refresh();
    const doc = this.activeDoc();
    this.tree.setActive(doc?.path ?? null);
    this.renderTabs();
    this.renderStatus();
    document.title = doc ? `${doc.dirty ? "● " : ""}${doc.name} — Aizome` : "Aizome";
    bus.emit("active:changed", { path: doc?.path ?? null });
    this.renderBreadcrumbs();
    this.renderPreview();
    this.saveSession();
  }

  /** 「値を見る」の結果を、今の表示（値／出力）とステップの位置に合わせて行の右に出す */
  private refreshTrace(docId = this.activeId, moveCursor = true) {
    if (!docId) return;
    const raw = this.traceRaw.get(docId);
    if (!raw) return;
    const view = settings.get("editor.sideView") === "output" ? "output" : "values";
    const step = this.traceStep && this.traceStep.docId === docId ? this.traceStep : null;
    const time = step ? (stepTimes(raw, step.line)[step.index] ?? null) : null;
    this.editor.showValues(docId, { values: formatTrace(raw, view, time, this.editor.getText(docId)), raw, time });
    if (step && docId === this.activeId && moveCursor && this.editor.cursor().line !== step.line) this.editor.goTo(step.line, 1);
    this.renderBreadcrumbs();
  }

  /** ステップ表示：その行が何回目に実行された瞬間かを 1 つずつ進める（dir: 1 次 / -1 前 / 0 やめる） */
  private stepTrace(dir: 1 | -1 | 0) {
    const doc = this.activeDoc();
    const raw = doc ? this.traceRaw.get(doc.id) : undefined;
    if (!doc || !raw) {
      toast(t("step.noTrace"), "info", 5000);
      return;
    }
    if (dir === 0) {
      this.traceStep = null;
      this.refreshTrace(doc.id);
      return;
    }
    const mode = settings.get("editor.sideView");
    if (mode !== "values" && mode !== "output") settings.set("editor.sideView", "values");
    let step = this.traceStep && this.traceStep.docId === doc.id ? this.traceStep : null;
    if (!step) {
      // カーソルのある行を基準に。その行が実行されていなければ、いちばん多く動いた行
      const cursorLine = this.editor.cursor().line;
      // for / while の行そのものより、ループの中の行を基準にする
      const text = this.editor.getText(doc.id).split("\n");
      const isHeader = (l: number) => /^\s*(for|while)\b/.test(text[l - 1] ?? "");
      const line = stepTimes(raw, cursorLine).length ? cursorLine : (busiestLine(raw, isHeader) ?? busiestLine(raw));
      if (!line) return;
      step = { docId: doc.id, line, index: dir === 1 ? -1 : stepTimes(raw, line).length };
    }
    const times = stepTimes(raw, step.line);
    step.index = Math.max(0, Math.min(times.length - 1, step.index + dir));
    this.traceStep = step;
    this.refreshTrace(doc.id);
  }

  /**
   * ステップ表示中にカーソルを別の行へ動かしたとき：その行が「今の瞬間にいちばん近く」動いた回へ切り替えて、
   * その行の具体的な値を見られるようにする
   */
  private followStepCursor() {
    const doc = this.activeDoc();
    const step = this.traceStep;
    if (!doc || !step || step.docId !== doc.id) return;
    const line = this.editor.cursor().line;
    if (line === step.line) return;
    const raw = this.traceRaw.get(doc.id);
    if (!raw) return;
    const times = stepTimes(raw, line);
    if (!times.length) return;
    const now = stepTimes(raw, step.line)[step.index] ?? 0;
    let best = 0;
    for (let i = 1; i < times.length; i++) {
      const d = Math.abs(times[i] - now);
      const bd = Math.abs(times[best] - now);
      // 同じ近さなら、これから動く方（同じ回の続き）を選ぶ
      if (d < bd || (d === bd && times[i] > now)) best = i;
    }
    this.traceStep = { docId: doc.id, line, index: best };
    this.refreshTrace(doc.id, false);
  }

  /** ループを 1 段ぶん進める・戻す（外側のループの「次の回」など） */
  private stepTraceLoop(header: number, dir: 1 | -1) {
    const doc = this.activeDoc();
    const raw = doc ? this.traceRaw.get(doc.id) : undefined;
    const step = this.traceStep;
    if (!doc || !raw || !step || step.docId !== doc.id) return;
    const times = stepTimes(raw, step.line);
    const now = times[step.index];
    const next = stepLoop(raw, header, step.line, now, dir);
    if (next === null) {
      toast(t(dir === 1 ? "step.loopEnd" : "step.loopStart"), "info", 2500);
      return;
    }
    step.index = times.indexOf(next);
    this.refreshTrace(doc.id);
  }

  private traceStepper(doc = this.activeDoc()): HTMLElement | null {
    const raw = doc ? this.traceRaw.get(doc.id) : undefined;
    const mode = settings.get("editor.sideView");
    if (!doc || !raw || (mode !== "values" && mode !== "output")) return null;
    const step = this.traceStep && this.traceStep.docId === doc.id ? this.traceStep : null;
    const box = h("div", { class: "trace-stepper", title: t("step.title") });
    if (!step) {
      box.append(
        h("button", { type: "button", title: `${t("step.prev")} (Shift+F7)`, onclick: () => this.stepTrace(-1) }, "◀"),
        h("span", { class: "step-label" }, t("step.all")),
        h("button", { type: "button", title: `${t("step.next")} (F7)`, onclick: () => this.stepTrace(1) }, "▶"),
      );
      return box;
    }
    const times = stepTimes(raw, step.line);
    // 何重にもなったループ：外側から順に「i：2 回目」のように出し、それぞれ ◀ ▶ で 1 回ずつ動かせる
    const lines = this.editor.getText(doc.id).split("\n");
    const loops = loopPositions(raw, enclosingLoops(lines, step.line), times[step.index]);
    for (const lp of loops) {
      const name = lp.vars || t("step.loopLine", { line: String(lp.header) });
      box.append(
        h(
          "span",
          { class: "step-loop", title: t("step.loopTitle", { line: String(lp.header) }) },
          h("button", { type: "button", onclick: () => this.stepTraceLoop(lp.header, -1) }, "◀"),
          h("span", { class: "step-label" }, t("step.loopLabel", { name, n: String(lp.iteration) })),
          h("button", { type: "button", onclick: () => this.stepTraceLoop(lp.header, 1) }, "▶"),
        ),
      );
    }
    box.append(
      h(
        "span",
        { class: "step-loop anchor" },
        h("button", { type: "button", title: `${t("step.prev")} (Shift+F7)`, onclick: () => this.stepTrace(-1) }, "◀"),
        h("span", { class: "step-label" }, t("step.label", { line: String(step.line), n: String(step.index + 1), total: String(times.length) })),
        h("button", { type: "button", title: `${t("step.next")} (F7)`, onclick: () => this.stepTrace(1) }, "▶"),
      ),
      h("button", { type: "button", title: t("step.exit"), onclick: () => this.stepTrace(0) }, t("step.exitShort")),
    );
    return box;
  }

  /** 行の右に出すものの切り替え（説明／値／自動判定／なし） */
  private sideSwitch(): HTMLElement {
    const mode = settings.get("editor.sideView");
    const opts: { id: "explain" | "values" | "output" | "auto" | "off"; label: string; title: string }[] = [
      { id: "explain", label: t("side.explain"), title: t("side.explainTitle") },
      { id: "values", label: t("side.values"), title: t("side.valuesTitle") },
      { id: "output", label: t("side.output"), title: t("side.outputTitle") },
      { id: "auto", label: t("side.auto"), title: t("side.autoTitle") },
      { id: "off", label: t("side.off"), title: t("side.offTitle") },
    ];
    return h(
      "div",
      { class: "side-switch", role: "radiogroup", "aria-label": t("side.label") },
      h("span", { class: "side-switch-label" }, t("side.label")),
      ...opts.map((o) =>
        h(
          "button",
          {
            type: "button",
            role: "radio",
            "aria-checked": String(mode === o.id),
            class: "side-opt" + (mode === o.id ? " active" : "") + (o.id === "auto" && inferBusy ? " busy" : ""),
            title: o.title,
            onclick: () => settings.set("editor.sideView", o.id),
          },
          o.label,
        ),
      ),
    );
  }

  /** 左右それぞれのファイルの上に、ファイル名・ステップ表示・行の右の表示・値を見る・実行を出す */
  private renderBreadcrumbs() {
    clear(this.breadcrumbsEl);
    for (const { id, el } of this.editor.paneBars()) {
      clear(el);
      const doc = id ? this.docs.find((d) => d.id === id) : undefined;
      el.hidden = !doc;
      if (!doc) continue;
      el.classList.toggle("current", doc.id === this.activeId);
      el.dataset.doc = doc.id;
      if (!this.barsReady.has(el)) {
        this.barsReady.add(el);
        // 押したときに作り直されてボタンが消えないように、フォーカスは動かさない
        el.addEventListener("mousedown", (e) => {
          if ((e.target as HTMLElement).closest("button")) e.preventDefault();
          e.stopPropagation();
        });
        // 押したボタンの処理より先に、このがわのファイルを「今のファイル」にする
        el.addEventListener(
          "click",
          () => {
            const id = el.dataset.doc;
            if (id && id !== this.activeId) this.activate(id);
          },
          true,
        );
      }
      const crumbs = h("div", { class: "pane-crumbs" });
      const rel = doc.path ? (this.root && isInside(this.root, doc.path) ? relative(this.root, doc.path) : doc.path) : doc.name;
      const parts = rel.split(/[\\/]/).filter(Boolean);
      parts.forEach((p, i) => {
        if (i > 0) crumbs.append(h("span", { class: "crumb-sep", "aria-hidden": "true", html: icon("chevron", 11) }));
        crumbs.append(h("span", { class: i === parts.length - 1 ? "crumb current" : "crumb" }, p));
      });
      const tools = h("div", { class: "pane-tools" });
      const stepper = this.traceStepper(doc);
      if (stepper) tools.append(stepper);
      tools.append(this.sideSwitch());
      // このファイルを実行する（押すと、先にこのがわが「今のファイル」になる）
      const act = (fn: () => unknown) => () => void fn();
      // HTML・Markdown・SVG は、出来上がったページを見られる
      if (this.previewKindOf(doc)) {
        const on = this.previewOn && doc.id === this.activeId;
        tools.append(
          h(
            "button",
            { class: "run-btn secondary small preview-btn" + (on ? " active" : ""), type: "button", "aria-pressed": String(on), title: `${t("pane.preview")} (Ctrl+Shift+V)`, onclick: act(() => this.togglePreview()) },
            h("span", { html: icon("book", 13) }),
            h("span", {}, t("top.preview")),
          ),
        );
      }
      // 値を見るは、プログラムのファイルだけ（HTML・Markdown にはない）
      if (!this.previewKindOf(doc)) {
        tools.append(
          h(
            "button",
            { class: "run-btn secondary small", type: "button", title: `${t("pane.trace")} (F6)`, onclick: act(() => this.traceActive()) },
            h("span", { html: icon("eye", 13) }),
            h("span", {}, t("top.trace")),
          ),
        );
      }
      tools.append(
        h(
          "button",
          { class: "run-btn small", type: "button", title: `${t("pane.run")} (F5)`, onclick: act(() => this.runActive()) },
          h("span", { html: icon("play", 12) }),
          h("span", {}, t("top.run")),
        ),
      );
      el.append(crumbs, tools);
    }
  }

  private isMarkdown(doc?: Doc) {
    return !!doc && [".md", ".markdown", ".mdx"].includes(extname(doc.path ?? doc.name));
  }

  /** HTML・Markdown・SVG なら、プレビューできる */
  private previewKindOf(doc?: Doc) {
    return doc ? previewKind(doc.path ?? doc.name) : null;
  }

  private renderPreview() {
    const doc = this.activeDoc();
    const kind = this.previewKindOf(doc);
    const show = this.previewOn && !!kind;
    this.previewEl.hidden = !show;
    this.editorArea.classList.toggle("with-preview", show);
    if (!show || !doc || !kind) return;
    // 画面が暗い色なら、Markdown のページも暗い色で
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
    const dark = bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11 < 128;
    void this.pagePreview.show(
      { docId: doc.id, kind, text: this.editor.getText(doc.id), title: doc.name, dir: doc.path ? dirname(doc.path) : null, root: this.root ?? null, path: doc.path ?? null },
      dark,
    );
  }

  private togglePreview() {
    if (!this.previewKindOf(this.activeDoc())) {
      toast(t("preview.onlyMarkdown"), "info");
      return;
    }
    this.previewOn = !this.previewOn;
    this.renderPreview();
    this.renderBreadcrumbs();
  }

  /**
   * 保存する。1 行目の「## py ##」のような言語の指定は、ファイルには書かずに取り除く（普通のコメントはそのまま）。
   * 自動保存や実行前の保存では取り除かない（書いた直後に消えたり、実行する言語が変わったりしないように）
   */
  async save(id = this.activeId, forceAs = false, opts: { keepDirective?: boolean } = {}): Promise<boolean> {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return false;
    let path = doc.path;
    if (!path || forceAs) {
      const suggested = doc.path ? basename(doc.path) : stripExt(doc.name) + (extname(this.appliedName.get(doc.id) ?? "") || ".txt");
      path = await dialog.saveFile(this.root ? resolveIn(this.root, suggested) : suggested);
      if (!path) return false;
    }
    let text = this.editor.getText(doc.id);
    const original = text;
    const firstLine = text.split("\n", 1)[0] ?? "";
    const directive = opts.keepDirective || !settings.get("files.stripDirective") ? null : this.directiveOf(firstLine);
    if (directive) text = text.slice(firstLine.length).replace(/^\r?\n/, "");
    if (settings.get("editor.trimTrailingWhitespace")) text = text.replace(/[ \t]+$/gm, "");
    if (settings.get("editor.insertFinalNewline") && text.length && !text.endsWith("\n")) text += "\n";
    if (text !== original) {
      // 表示中のファイルは変わったところだけ書き換える（カーソルがずれないように）
      if (doc.id === this.activeId) this.editor.applyText(text);
      else this.editor.setText(doc.id, text);
    }
    if (directive && extname(path) && extname(path).toLowerCase() !== directive.ext) {
      toast(t("lang.savedOtherExt", { name: directive.label, file: basename(path) }), "warn", 8000);
    }
    // 保存記録のために、保存する前のファイルの中身を読んでおく
    const before = settings.get("ui.saveHistory")
      ? await fs
          .readFileEnc(path, doc.encoding)
          .then((r) => r.text.replace(/\r\n/g, "\n"))
          .catch(() => null)
      : null;
    try {
      await fs.writeFileEnc(path, text, doc.encoding, doc.bom, doc.eol);
      void this.history.record(path, before, text);
    } catch (err) {
      const msg = String(err);
      const bad = /UNMAPPABLE: (.*)/.exec(msg);
      if (bad) {
        // Shift_JIS などで書けない文字（絵文字・一部の漢字）があるとき
        const asUtf8 = await choose(
          t("enc.unmappableTitle", { enc: encodingLabel(doc.encoding, doc.bom) }),
          t("enc.unmappable", { chars: bad[1], enc: encodingLabel(doc.encoding, doc.bom) }),
          [
            { label: t("common.cancel"), value: false, kind: "plain" },
            { label: t("enc.saveUtf8"), value: true, kind: "primary" },
          ],
          false,
        );
        if (!asUtf8) return false;
        doc.encoding = "utf-8";
        doc.bom = false;
        return this.save(doc.id, false, opts);
      }
      toast(t("file.saveFailed", { name: doc.name, err: msg }), "error");
      return false;
    }
    if (doc.path !== path) {
      const oldId = doc.id;
      doc.id = path;
      doc.path = path;
      doc.name = basename(path);
      await this.editor.rename(oldId, path, doc.name);
      if (this.activeId === oldId) this.activeId = path;
      this.appliedName.delete(oldId);
      this.appliedName.set(path, doc.name);
      this.refreshLanguage(doc);
      if (this.root && isInside(this.root, path)) void this.tree.refresh().then(() => this.reindex());
    }
    doc.dirty = false;
    this.renderTabs();
    this.renderStatus();
    if (this.activeId === doc.id) document.title = `${doc.name} — Aizome`;
    bus.emit("file:saved", { path });
    this.saveSession();
    void this.refreshGit();
    return true;
  }

  async closeDoc(id = this.activeId) {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return;
    if (doc.dirty) {
      const answer = await choose(
        t("file.unsavedTitle", { name: doc.name }),
        t("file.unsavedMessage"),
        [
          { label: t("common.cancel"), value: "cancel", kind: "plain" },
          { label: t("file.dontSave"), value: "discard", kind: "plain" },
          { label: t("file.save"), value: "save", kind: "primary" },
        ],
        "cancel",
      );
      if (answer === "cancel") return;
      if (answer === "save" && !(await this.save(doc.id))) return;
    }
    const index = this.docs.indexOf(doc);
    this.docs.splice(index, 1);
    this.editor.close(doc.id);
    if (this.activeId === doc.id) {
      const next = this.docs[Math.min(index, this.docs.length - 1)];
      this.activeId = null;
      if (next) this.activate(next.id);
      else {
        this.tree.setActive(null);
        document.title = "Aizome";
        bus.emit("active:changed", { path: null });
      }
    }
    this.renderTabs();
    this.renderStatus();
    this.renderBreadcrumbs();
    this.renderPreview();
    this.saveSession();
  }

  private handleRenamed(from: string, to: string) {
    for (const doc of this.docs) {
      if (!doc.path) continue;
      if (doc.path === from || isInside(from, doc.path)) {
        const newPath = to + doc.path.slice(from.length);
        const oldId = doc.id;
        doc.path = newPath;
        doc.id = newPath;
        doc.name = basename(newPath);
        void this.editor.rename(oldId, newPath, doc.name);
        if (this.activeId === oldId) this.activeId = newPath;
      }
    }
    this.renderTabs();
    this.renderStatus();
  }

  private handleDeleted(path: string) {
    for (const doc of [...this.docs]) {
      if (doc.path && (doc.path === path || isInside(path, doc.path))) {
        doc.dirty = false;
        void this.closeDoc(doc.id);
      }
    }
  }

  // ───────────── 実行

  /**
   * 実行するファイルを用意する。実行はいつも「そのファイルがある場所」で行う。
   * - 保存してあって、言語の指定がない（または ## py ## のように、その言語でそのままコメントになる指定で拡張子も合っている）
   *   → ファイルそのものを実行
   * - それ以外（## C++ ## の指定・拡張子が違う）→ 同じフォルダに一時的なコピーを作って実行し、終わったら消す
   * - 保存前のファイル → 開いているフォルダ（なければ ~/.aizome/run）で実行
   */
  private async prepareRunTarget(doc: Doc): Promise<{ path: string; cwd: string | null; overrides: Record<string, string>; cleanup?: string } | null> {
    const t0 = await this.prepareRunFile(doc);
    if (!t0) return null;
    // 実行する場所（設定）：ファイルの場所／開いているフォルダ／移動しない（ターミナルの今の場所）
    const mode = settings.get("run.cwd");
    const cwd = mode === "terminal" ? null : mode === "workspace" ? (this.root ?? t0.dir) : t0.dir;
    const stem = stripExt(basename(t0.path)).replace(/\.aizome-run$/, "");
    return {
      path: t0.path,
      cwd,
      // 場所を移動しないときは Set-Location "." になる。ファイルはいつもフルパスで渡す
      overrides: { fileDir: cwd ?? ".", fileBase: t0.path, file: t0.path, fileNoExt: join(cwd ?? t0.dir, stem), fileBaseNoExt: stem },
      cleanup: t0.cleanup,
    };
  }

  /** 実行するファイルそのもの（または一時的なコピー）と、そのファイルの「自然な」場所 */
  private async prepareRunFile(doc: Doc): Promise<{ path: string; dir: string; cleanup?: string } | null> {
    const first = this.editor.getText(doc.id).split("\n", 1)[0] ?? "";
    const directive = this.directiveOf(first);
    // 保存してあるファイルは、変更を保存してから
    if (doc.path && doc.dirty && !(await this.save(doc.id, false, { keepDirective: true }))) return null;
    const hashComment = [".py", ".pyw", ".rb", ".sh", ".bash", ".ps1"];
    if (doc.path && (!directive || (directive.ext === extname(doc.path).toLowerCase() && hashComment.includes(directive.ext)))) {
      return { path: doc.path, dir: dirname(doc.path) };
    }
    const ext = directive?.ext ?? extname(this.effectiveName(doc));
    if (!ext || ext === ".txt" || ext === ".md") {
      toast(t("run.pickLanguage"), "info", 7000);
      void this.pickLanguage();
      return null;
    }
    const latest = this.editor.getText(doc.id);
    const latestFirst = latest.split("\n", 1)[0] ?? "";
    const body = directive ? directiveAsComment(latestFirst, ext) + latest.slice(latestFirst.length) : latest;
    const stem = stripExt(doc.name).replace(/[\\/:*?"<>|\s]+/g, "_") || "untitled";
    // コピーを置く場所＝実行する場所：ファイルと同じフォルダ → 開いているフォルダ → ~/.aizome/run
    let dir = doc.path ? dirname(doc.path) : this.root;
    let temporary = !!dir;
    if (!dir) {
      dir = join(join(this.sys.home, ".aizome"), "run");
      await fs.createDir(dir).catch(() => {});
    }
    let copy = join(dir, temporary ? `${stem}.aizome-run${ext}` : stem + ext);
    try {
      await fs.writeFileEnc(copy, body, doc.encoding, doc.bom, doc.eol);
    } catch {
      // その場所に書けない（読み取り専用など）ときは ~/.aizome/run に置く
      const fallback = join(join(this.sys.home, ".aizome"), "run");
      await fs.createDir(fallback).catch(() => {});
      copy = join(fallback, stem + ext);
      temporary = false;
      try {
        await fs.writeFile(copy, body);
      } catch (err) {
        toast(t("file.saveFailed", { name: basename(copy), err: String(err) }), "error");
        return null;
      }
    }
    this.runCopies.set(copy, doc.id);
    return { path: copy, dir: doc.path ? dirname(doc.path) : (this.root ?? dir), cleanup: temporary ? copy : undefined };
  }

  /** 1 行目の「## py ##」（設定でオフなら使わない） */
  private directiveOf(firstLine: string) {
    return settings.get("files.langDirective") ? parseDirective(firstLine) : null;
  }

  /** 実行が終わったあとに一時的なコピーを消すコマンド */
  private cleanupCommand(path?: string): string {
    if (!path) return "";
    if (this.sys.os === "windows") return `; Remove-Item -LiteralPath "${path.replace(/[`$"]/g, (ch) => "`" + ch)}" -ErrorAction SilentlyContinue`;
    return `; rm -f '${path.replace(/'/g, "'\\''")}'`;
  }

  async runActive() {
    const doc = this.activeDoc();
    if (!doc) {
      toast(t("run.noFile"), "info");
      return;
    }
    const target = await this.prepareRunTarget(doc);
    if (target) {
      this.editor.showRunErrors(doc.id, []);
      await this.runPath(target.path, target.overrides, target.cleanup, await this.inputsFileFor(doc), { key: doc.id, name: doc.name });
      this.pairRunsIfSplit();
    }
  }

  /** 入力の登録（ファイルごと）。キーは保存してあればパス、なければタブの ID */
  private presetKey(doc: Doc): string {
    return doc.path ?? doc.id;
  }

  private presetFor(doc: Doc): InputPreset | undefined {
    return (settings.get("run.inputs") ?? {})[this.presetKey(doc)];
  }

  /** 登録した入力をファイルに書き出す（実行のときに使う）。登録がなければ undefined */
  private async inputsFileFor(doc: Doc): Promise<string | undefined> {
    const preset = this.presetFor(doc);
    if (!presetCount(preset)) return undefined;
    const dir = join(join(this.sys.home, ".aizome"), "inputs");
    await fs.createDir(dir).catch(() => {});
    const file = join(dir, `${hashText(this.presetKey(doc)).replace(/[^\w]/g, "_")}.txt`);
    try {
      await fs.writeFile(file, preset!.text);
      return file;
    } catch {
      return undefined;
    }
  }

  /** 名前の一括変更（F2） */
  async renameSymbol() {
    if (!this.activeDoc()) return toast(t("run.noFile"), "info");
    const sym = this.editor.symbolAtCursor();
    if (!sym) return toast(t("rename.noSymbol"), "info", 4000);
    const next = await inputBox({ title: t("rename.title", { name: sym.name, n: String(sym.count) }), value: sym.name, okLabel: t("rename.ok") });
    if (!next || next === sym.name) return;
    if (!/^[A-Za-z_$\u00C0-\uFFFF][\w$\u00C0-\uFFFF]*$/.test(next)) return toast(t("rename.invalid", { name: next }), "warn", 5000);
    const n = this.editor.renameSymbol(sym.name, next);
    this.editor.focus();
    toast(t("rename.done", { from: sym.name, to: next, n: String(n) }), "success", 5000);
  }

  /** 入力の登録を編集する */
  async editInputs() {
    const doc = this.activeDoc();
    if (!doc) return toast(t("run.noFile"), "info");
    const next = await editInputPreset(doc.name, this.presetFor(doc));
    if (!next) return;
    const all = { ...(settings.get("run.inputs") ?? {}) };
    if (!next.text.trim()) delete all[this.presetKey(doc)];
    else all[this.presetKey(doc)] = next;
    settings.set("run.inputs", all);
    this.renderStatus();
    const n = presetCount(next);
    toast(n ? t("inputs.saved", { n: String(n) }) : t("inputs.off"), "success", 4000);
  }

  /** 値を見る：行ごとの変数の値を記録しながら実行して、行の右に表示する（Python） */
  async traceActive() {
    const doc = this.activeDoc();
    if (!doc) {
      toast(t("run.noFile"), "info");
      return;
    }
    const ext = extname(this.appliedName.get(doc.id) ?? this.effectiveName(doc));
    if (ext !== ".py" && ext !== ".pyw") {
      const lang = traceLangOf(ext);
      if (!lang) {
        toast(t("trace.unsupported", { ext: ext || "?" }), "info", 6000);
        return;
      }
      return this.traceOther(doc, lang);
    }
    const target = await this.prepareRunTarget(doc);
    if (!target) return;
    const inputsFile = await this.inputsFileFor(doc);
    const home = join(this.sys.home, ".aizome");
    await fs.createDir(home).catch(() => {});
    const tracer = join(home, "tracer.py");
    const out = join(home, `trace-${Date.now()}.json`);
    try {
      await fs.writeFile(tracer, TRACER_PY);
    } catch (err) {
      toast(t("file.saveFailed", { name: "tracer.py", err: String(err) }), "error");
      return;
    }
    const win = this.sys.os === "windows";
    const q = (p: string) => (win ? `"${p.replace(/[`$"]/g, (ch) => "`" + ch)}"` : `"${p.replace(/(["$`\\])/g, "\\$1")}"`);
    let cmd = win
      ? `${target.cwd ? `Set-Location ${q(target.cwd)}; ` : ""}python ${q(tracer)} ${q(target.path)} ${q(out)}${inputsFile ? ` ${q(inputsFile)}` : ""}`
      : `${target.cwd ? `cd ${q(target.cwd)} && ` : ""}python3 ${q(tracer)} ${q(target.path)} ${q(out)}${inputsFile ? ` ${q(inputsFile)}` : ""}`;
    if (settings.get("run.findPython")) {
      const resolved = await this.resolvePython(cmd);
      if (resolved === null) return;
      cmd = resolved;
    }
    if (win) cmd += `; $aizomeCode = $LASTEXITCODE${this.cleanupCommand(target.cleanup)}; Write-Host ""; Write-Host "--- ${t("trace.finished", { code: "$aizomeCode" })} ---" -ForegroundColor DarkGray`;
    else cmd += this.cleanupCommand(target.cleanup);
    this.lastRunDir = target.cwd ?? target.overrides.file.replace(/[\\/][^\\/]*$/, "");
    this.editor.showValues(doc.id, null);
    const startText = this.editor.getText(doc.id);
    await this.terminal.run(cmd, target.cwd ?? undefined, { key: doc.id, name: doc.name });
    this.pairRunsIfSplit();
    toast(t("trace.running"), "info", 4000);
    // 終わると記録のファイルができるので、それを待って読む
    window.clearInterval(this.tracePoll);
    const started = Date.now();
    this.tracePoll = window.setInterval(async () => {
      if (Date.now() - started > 30 * 60 * 1000) return window.clearInterval(this.tracePoll);
      if (!(await fs.exists(out).catch(() => false))) return;
      window.clearInterval(this.tracePoll);
      try {
        const result = JSON.parse(await fs.readFile(out)) as TraceResult;
        void fs.remove(out).catch(() => {});
        this.applyTrace(doc.id, result, startText);
      } catch (err) {
        toast(t("trace.failed", { err: String(err) }), "error");
      }
    }, 500);
  }

  /** 記録した値を、行の右に出す（どの言語でも） */
  private applyTrace(docId: string, result: TraceResult, startText: string) {
    if (!this.docs.some((d) => d.id === docId)) return;
    if (this.editor.getText(docId) !== startText) {
      toast(t("trace.changed"), "warn", 6000);
      return;
    }
    const values = formatTrace(result);
    if (this.activeId !== docId) this.activate(docId);
    this.traceRaw.set(docId, result);
    this.traceStep = null;
    this.valuesShown.add(docId);
    // 行の右の表示を「値」に切り替える（「戻り値」を見ているときはそのまま）
    const mode = settings.get("editor.sideView");
    if (mode !== "values" && mode !== "output") settings.set("editor.sideView", "values");
    else this.refreshTrace(docId);
    toast(t(result.truncated ? "trace.truncated" : "trace.done", { n: String(values.size) }), result.error ? "warn" : "success", 7000);
  }

  /** Python 以外の「値を見る」で、実行が終わるのを待っているもの（キーはタブの ID） */
  private otherTraces = new Map<string, { log: string; dir: string; startText: string }>();

  /**
   * Python 以外の「値を見る」：変数に値を入れる行のうしろに「記録する 1 文」を足したコピーを、一時的な場所で実行する。
   * 実行する場所（相対パスのファイルの読み書き）は、ふだんの実行と同じ
   */
  private async traceOther(doc: Doc, lang: TraceLang) {
    const target = await this.prepareRunTarget(doc);
    if (!target) return;
    let src: string;
    try {
      src = await fs.readFile(target.path);
    } catch (err) {
      toast(t("trace.failed", { err: String(err) }), "error");
      return;
    }
    if (lang === "cs" && /\bMonoBehaviour\b|using\s+UnityEngine\b/.test(src)) {
      toast(t("trace.unity"), "info", 9000);
      return;
    }
    const base = basename(target.path).replace(/\.aizome-run(?=\.)/, "");
    const dir = join(join(join(this.sys.home, ".aizome"), "trace-run"), String(Date.now()));
    const log = join(dir, "values.log");
    const inst = instrument(src, lang, log, basename(doc.path ?? doc.name));
    if (!inst) {
      toast(t("trace.nothing"), "info", 7000);
      return;
    }
    const file = join(dir, base);
    try {
      await fs.createDir(dir);
      await fs.writeFile(file, inst.code);
    } catch (err) {
      toast(t("file.saveFailed", { name: base, err: String(err) }), "error");
      return;
    }
    const startText = this.editor.getText(doc.id);
    this.otherTraces.set(doc.id, { log, dir, startText });
    this.editor.showValues(doc.id, null);
    this.editor.showRunErrors(doc.id, []);
    const stem = stripExt(base);
    const fileDir = target.cwd ?? dirname(target.path);
    // ふだんと同じ場所で動かす（ファイルは一時的な場所のコピーをフルパスで）
    await this.runPath(file, { fileDir, file, fileBase: file, fileNoExt: join(dir, stem), fileBaseNoExt: stem }, target.cleanup, await this.inputsFileFor(doc), { key: doc.id, name: doc.name });
    this.pairRunsIfSplit();
    toast(t("trace.runningOther"), "info", 5000);
  }

  /** Python 以外の「値を見る」の実行が終わったら、記録を読む */
  private async finishOtherTrace(key: string, marked: string) {
    const job = this.otherTraces.get(key);
    if (!job) return;
    this.otherTraces.delete(key);
    let text = "";
    try {
      text = await fs.readFile(job.log);
    } catch {
      text = "";
    }
    void fs.remove(job.dir).catch(() => {});
    const result = parseTraceLog(text, splitLineOutputs(marked));
    if (!Object.keys(result.lines).length) {
      toast(t("trace.noRecords"), "warn", 9000);
      return;
    }
    this.applyTrace(key, result, job.startText);
  }

  /** ファイルごとの、最近 2 回の実行の出力 */
  private runOutputs = new Map<string, { prev?: { text: string; at: Date }; last?: { text: string; at: Date } }>();

  private rememberRun(key: string, text: string, marked = text) {
    this.showRunErrorsFor(key, text);
    if (this.otherTraces.has(key)) void this.finishOtherTrace(key, marked);
    const r = this.runOutputs.get(key) ?? {};
    r.prev = r.last;
    r.last = { text, at: new Date() };
    this.runOutputs.set(key, r);
    this.terminal.setCompareReady(key, !!r.prev);
    if (r.prev && r.prev.text !== text && settings.get("run.notifyChanged")) {
      toast(t("runcmp.changed", { key: formatKey("Mod-Alt-D") }), "info", 5000);
    }
  }

  /** 実行・コンパイルで出たエラーを、そのファイルの行の右に日本語で出す（どの言語でも） */
  private showRunErrorsFor(key: string, text: string) {
    const doc = this.docs.find((d) => d.id === key);
    if (!doc || !this.editor.has(doc.id)) return;
    const eff = this.effectiveName(doc);
    const ext = extname(eff);
    const names = [doc.name, basename(eff), stripExt(doc.name) + ext, doc.path ? basename(doc.path) : ""].filter(Boolean);
    const errors = parseRunErrors(text, names, checkLangOf(ext), this.editor.getText(doc.id));
    this.editor.showRunErrors(doc.id, errors);
    const n = errors.filter((e) => e.severity === "error").length;
    if (n) toast(t("run.errorsFound", { n: String(n) }), "warn", 6000);
  }

  /** 前回の実行と今回の実行の出力を、色付きで左右に並べる */
  private async compareRuns(key?: string | null) {
    const k = key ?? this.activeId;
    const r = k ? this.runOutputs.get(k) : undefined;
    if (!r?.last || !r.prev) {
      toast(t("runcmp.notYet"), "info", 6000);
      return;
    }
    const name = this.docs.find((d) => d.id === k)?.name ?? "";
    const time = (d: Date) => d.toLocaleTimeString();
    await showDiff({
      leftTitle: t("runcmp.prev", { time: time(r.prev.at), name }),
      rightTitle: t("runcmp.last", { time: time(r.last.at) }),
      left: r.prev.text,
      right: r.last.text,
    });
  }

  /** 2 つのファイルを比べる（開いているファイルか、ほかのファイルを選ぶ） */
  private async compareFiles(id: string | null = this.activeId) {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return;
    const others = this.docs.filter((d) => d.id !== doc.id);
    const pickFile = { pick: true } as const;
    const choice = await quickPick<Doc | typeof pickFile>(
      [
        ...others.map((d) => ({ label: d.name, detail: d.path ?? t("compare.unsaved"), value: d as Doc | typeof pickFile })),
        { label: t("compare.pickFile"), detail: t("compare.pickFileHint"), value: pickFile },
      ],
      t("compare.pick", { name: doc.name }),
    );
    if (!choice) return;
    let otherName: string;
    let otherText: string;
    if ("pick" in choice) {
      const path = await dialog.pickFile([]);
      if (!path) return;
      try {
        otherText = (await fs.readFileEnc(path)).text;
      } catch (err) {
        toast(t("file.openFailed", { name: basename(path), err: String(err) }), "error");
        return;
      }
      otherName = basename(path);
    } else {
      otherName = choice.name;
      otherText = this.editor.getText(choice.id);
    }
    await showDiff({ leftTitle: doc.name, rightTitle: otherName, left: this.editor.getText(doc.id), right: otherText });
  }

  /** 左右に並べたファイルを両方実行したら、ターミナルも左右に並べて比べられるようにする */
  private pairRunsIfSplit() {
    if (!this.editor.isSplit()) return;
    const ids = this.editor.visibleIds();
    if (ids.length === 2) this.terminal.pairKeys(ids[0], ids[1]);
  }

  private async runPath(path: string, overrides?: Record<string, string>, cleanup?: string, inputsFile?: string, who?: { key: string; name: string }) {
    const config = findRunConfig(path);
    if (!config) {
      toast(t("run.noConfig", { name: basename(path) }), "warn", 6000);
      return;
    }
    let cmd = expandCommand(config, path, this.root ?? "", this.sys.os, overrides);
    const win = this.sys.os === "windows";
    if (inputsFile && config.id === "python") {
      // 入力の登録：input() に登録した値を順に入れる小さな仕組みを通して実行する
      const wrapper = join(join(this.sys.home, ".aizome"), "input_wrapper.py");
      await fs.writeFile(wrapper, INPUT_WRAPPER_PY).catch(() => {});
      const q = (p: string) => (win ? `"${p.replace(/[`$"]/g, (ch) => "`" + ch)}"` : `"${p.replace(/(["$`\\])/g, "\\$1")}"`);
      const dirPart = overrides?.fileDir && overrides.fileDir !== "." ? (win ? `Set-Location ${q(overrides.fileDir)}; ` : `cd ${q(overrides.fileDir)} && `) : "";
      cmd = `${dirPart}${win ? "python" : "python3"} ${q(wrapper)} ${q(overrides?.file ?? path)} ${q(inputsFile)}`;
    } else if (inputsFile) {
      toast(t("inputs.onlyPython"), "info", 5000);
    }
    // go・gcc・dotnet などが入っているか（入っていなければ入れ方を案内。入れた直後で PATH にないときは足す）
    const tool = RUN_TOOLS[config.id];
    if (tool && settings.get("run.checkTools")) {
      const prefix = await this.ensureTools([tool]);
      if (prefix === null) return;
      cmd = prefix + cmd;
    }
    if (config.id === "python" && settings.get("run.findPython")) {
      const resolved = await this.resolvePython(cmd);
      if (resolved === null) return;
      cmd = resolved;
    }
    // 出力の始まりと終わりに、画面には見えない印を付ける（前回の実行と比べるため）
    const mark = (name: string) => (win ? `Write-Host -NoNewline "$([char]27)]633;aizome-${name}$([char]7)"` : `printf '\\033]633;aizome-${name}\\007'`);
    if (win && settings.get("run.showFinished")) {
      // 終わったことと終了コード・かかった時間がわかるように（何も出力しないプログラムでも安心できる）
      const timed = settings.get("run.showTime");
      const msg = timed ? t("run.finishedTime", { code: "$aizomeCode", sec: "$aizomeSec" }) : t("run.finished", { code: "$aizomeCode" });
      cmd = `${mark("start")}; ${timed ? "$aizomeStart = Get-Date; " : ""}${cmd}; $aizomeCode = $LASTEXITCODE; ${mark("end")}${timed ? "; $aizomeSec = '{0:N2}' -f ((Get-Date) - $aizomeStart).TotalSeconds" : ""}${this.cleanupCommand(cleanup)}; Write-Host ""; Write-Host "--- ${msg} ---" -ForegroundColor DarkGray`;
    } else {
      cmd = `${mark("start")}; ${cmd}; ${mark("end")}${this.cleanupCommand(cleanup)}`;
    }
    const cwd = overrides?.fileDir && overrides.fileDir !== "." ? overrides.fileDir : overrides ? undefined : dirname(path);
    this.lastRunDir = cwd ?? dirname(path);
    await this.terminal.run(cmd, cwd, who);
  }

  /**
   * コンパイラなどの道具を確かめる。足りなければ入れ方を聞いて null。
   * 見つかったけれど PATH に入っていない（winget で入れた直後など）ときは、PATH に足す命令を返す
   */
  private async ensureTools(list: Toolchain[]): Promise<string | null> {
    const win = this.sys.os === "windows";
    let prefix = "";
    for (const tc of list) {
      if (!tc.names.length) continue;
      let found: { dir: string; inPath: boolean } | null;
      try {
        found = await tools.find(tc.names);
      } catch {
        continue; // 調べられないときは、そのまま実行してみる
      }
      if (found) {
        if (!found.inPath) {
          prefix += win ? `$env:Path = "${found.dir.replace(/[`$"]/g, (c) => "`" + c)};" + $env:Path; ` : `export PATH="${found.dir.replace(/(["$`\\])/g, "\\$1")}:$PATH"; `;
        }
        continue;
      }
      const choices: { label: string; value: string; kind: "plain" | "primary" }[] = [
        { label: t("common.cancel"), value: "cancel", kind: "plain" },
        { label: t("tool.openPage"), value: "page", kind: "plain" },
      ];
      if (win && tc.winget) choices.push({ label: t("tool.install"), value: "winget", kind: "primary" });
      const answer = await choose(
        t("tool.missingTitle", { name: tc.label }),
        t("tool.missing", { name: tc.label, cmd: tc.names[0] }) + (tc.note ? "\n\n" + tc.note : "") + (win && tc.winget ? "\n\n" + t("tool.wingetHint", { id: tc.winget }) : ""),
        choices,
        "cancel",
      );
      if (answer === "winget") {
        await this.terminal.run(
          `winget install -e --id ${tc.winget} --accept-source-agreements --accept-package-agreements; Write-Host ""; Write-Host "${t("tool.installedHint")}" -ForegroundColor Green`,
        );
      } else if (answer === "page") {
        await this.terminal.run(win ? `Start-Process "${tc.url}"` : `(xdg-open "${tc.url}" || open "${tc.url}") >/dev/null 2>&1`);
      }
      return null;
    }
    return prefix;
  }

  /** ビルド：言語に合わせて、実行ファイル（.exe・.jar など）を「build」フォルダに作る */
  private async buildActive() {
    const doc = this.activeDoc();
    if (!doc) {
      toast(t("run.noFile"), "info");
      return;
    }
    const text = this.editor.getText(doc.id);
    const file = await this.prepareRunFile(doc);
    if (!file) return;
    const win = this.sys.os === "windows";
    const config = findRunConfig(file.path);
    const targets = config ? BUILD_TARGETS[config.id] : undefined;
    const drop = async () => {
      if (file.cleanup) await fs.remove(file.cleanup).catch(() => {});
    };
    if (!config || !targets) {
      await drop();
      toast(t(config ? "bld.noNeed" : "run.noConfig", { name: basename(file.path), lang: config?.label ?? "" }), "info", 7000);
      return;
    }
    if (config.id === "csharp" && isUnityScript(text)) {
      await drop();
      toast(t("bld.unity"), "info", 8000);
      return;
    }
    const target =
      targets.length === 1
        ? targets[0]
        : await quickPick(
            targets.map((x) => ({ label: x.label, detail: x.detail, value: x })),
            t("bld.pick", { lang: config.label }),
          );
    if (!target) {
      await drop();
      return;
    }
    let pyCall = win ? "python" : "python3";
    if (config.id === "python") {
      const resolved = await this.resolvePython(pyCall + " ");
      if (resolved === null) {
        await drop();
        return;
      }
      pyCall = resolved.trim();
    }
    const prefix = await this.ensureTools(target.tools);
    if (prefix === null) {
      await drop();
      return;
    }
    const out = join(file.dir, "build");
    await fs.createDir(out).catch(() => {});
    const name = stripExt(basename(doc.path ?? doc.name)).replace(/\.aizome-run$/, "").replace(/[\\/:*?"<>|\s]+/g, "_") || "app";
    const vars = { src: file.path, out, name, py: pyCall, main: javaMainClass(text, name) };
    const body = fillBuild(win ? target.windows : target.unix, vars, win);
    const result = target.result.replace("${out}", out).replace("${name}", name).replace(/\//g, win ? "\\" : "/");
    const ok = t("bld.done", { path: win ? result : result.replace(/\.exe$/, "") });
    const ng = t("bld.failed");
    const q = (s: string) => s.replace(/[`$"]/g, (c) => "`" + c);
    const cmd = win
      ? `${prefix}${body}; if ($?) { Write-Host ""; Write-Host "--- ${q(ok)} ---" -ForegroundColor Green } else { Write-Host ""; Write-Host "--- ${q(ng)} ---" -ForegroundColor Red }${target.after ? "; " + target.after : ""}${this.cleanupCommand(file.cleanup)}`
      : `${prefix}(${body}) && echo "--- ${ok} ---" || echo "--- ${ng} ---"${this.cleanupCommand(file.cleanup)}`;
    toast(t("bld.started", { lang: config.label, target: target.label }), "info", 4000);
    await this.terminal.run(cmd, file.dir);
  }

  /** 印刷・書き出しの専用画面（右に出来上がりのプレビュー） */
  private async exportActive(mode: "print" | "export" = "export") {
    const doc = this.activeDoc();
    if (!doc) {
      toast(t("print.noFile"), "info");
      return;
    }
    const lines = this.editor.highlightLines(doc.id);
    const meta = { name: doc.name, path: doc.path ?? "", date: new Date().toLocaleString() };
    const tab = settings.get("editor.tabSize");
    openPrintScreen({
      name: doc.name,
      path: doc.path ?? "",
      lines,
      tab,
      mode,
      onPrint: async (o) => {
        await this.printSheet(lines, o, meta, tab);
        toast(t("export.pdfHint"), "info", 9000);
      },
      onExport: async (o) => {
        const ext = o.format === "docx" ? ".docx" : o.format === "html" ? ".html" : o.format === "md" ? ".md" : ".txt";
        const same = (o.format === "txt" && extname(doc.name) === ".txt") || (o.format === "md" && /^\.(md|markdown)$/i.test(extname(doc.name)));
        const suggested = stripExt(doc.name) + (same ? "-書き出し" : "") + ext;
        const path = await dialog.saveFile(doc.path ? join(dirname(doc.path), suggested) : suggested);
        if (!path) return false;
        try {
          if (o.format === "docx") await fs.writeBase64(path, toBase64(exportDocx(lines, o, meta, tab)));
          else if (o.format === "html") await fs.writeFile(path, exportHtmlDocument(lines, o, meta, tab));
          else if (o.format === "md") await fs.writeFile(path, exportMarkdown(lines, o, meta, tab));
          else await fs.writeFile(path, exportText(lines, o, meta, tab));
          toast(t("export.saved", { path }), "success", 7000);
          return true;
        } catch (err) {
          toast(t("export.failed", { err: String(err) }), "error");
          return false;
        }
      },
    });
  }

  /** 色付き・行番号付きのコードを印刷する（印刷の画面で「PDF に保存」も選べる） */
  private async printSheet(lines: { text: string; cls: string }[][], o: ExportOptions, meta: { name: string; path: string; date: string }, tab: number) {
    document.querySelector(".print-sheet")?.remove();
    document.getElementById("print-export-style")?.remove();
    const style = h("style", { id: "print-export-style" });
    style.textContent = `@media print { ${exportCss(o, meta.name)} }`;
    const sheet = h("div", { class: "print-sheet" });
    sheet.innerHTML = exportBody(lines, o, meta, tab);
    document.head.append(style);
    document.body.append(sheet);
    try {
      await sys.print();
    } catch {
      window.print();
    }
  }

  /**
   * 「python」を本物の Python に置き換える。
   * Windows では Python が入っていないと、Store へ案内するだけの python が動いて「Python」と出るだけになるため
   */
  private async resolvePython(cmd: string): Promise<string | null> {
    let info: { command: string | null; storeStub: boolean; source: string };
    try {
      info = await runtimes.findPython();
    } catch {
      return cmd;
    }
    if (info.command) {
      if (info.command === "python" || info.command === "python3") return cmd;
      const call = this.sys.os === "windows" ? `& ${info.command}` : info.command;
      return cmd.replace(/(^|;\s*|&&\s*)python3?(?=\s)/, (_m, pre: string) => pre + call);
    }
    const isWin = this.sys.os === "windows";
    const choice = await choose(
      t("run.noPythonTitle"),
      t(info.storeStub ? "run.noPythonStub" : "run.noPython"),
      isWin
        ? [
            { label: t("common.cancel"), value: "cancel", kind: "plain" },
            { label: t("run.pickPython"), value: "pick", kind: "plain" },
            { label: t("run.openStore"), value: "store", kind: "plain" },
            { label: t("run.installPython"), value: "winget", kind: "primary" },
          ]
        : [{ label: t("common.ok"), value: "cancel", kind: "primary" }],
      "cancel",
    );
    if (choice === "pick") {
      // 入っているのに見つからないとき：python.exe を自分で選ぶ（次からはこれを使う）
      const path = await dialog.pickExe();
      if (!path) return null;
      settings.set("run.pythonPath", path);
      toast(t("run.pythonPicked", { path }), "success", 6000);
      return this.resolvePython(cmd);
    }
    if (choice === "winget") {
      await this.terminal.run(
        `winget install -e --id Python.Python.3.12 --scope user --accept-source-agreements --accept-package-agreements; Write-Host ""; Write-Host "${t("run.pythonInstalledHint")}" -ForegroundColor Green`,
      );
    } else if (choice === "store") {
      await this.terminal.run(`Start-Process "ms-windows-store://pdp/?productid=9NCVDN91XZQP"`);
    }
    return null;
  }

  /** 新しいファイルとして書き込んで開く（同じ名前があれば確認） */
  private async saveAndOpen(path: string, text: string): Promise<boolean> {
    if (await fs.exists(path).catch(() => false)) {
      const ok = await choose(t("build.overwriteTitle", { name: basename(path) }), t("build.overwriteMessage"), [
        { label: t("common.cancel"), value: false, kind: "plain" },
        { label: t("build.overwrite"), value: true, kind: "danger" },
      ], false);
      if (!ok) return false;
    }
    try {
      const enc = defaultEncoding();
      await fs.writeFileEnc(path, text, enc.encoding, enc.bom, enc.eol);
    } catch (err) {
      toast(t("file.saveFailed", { name: basename(path), err: String(err) }), "error");
      return false;
    }
    const open = this.docs.find((d) => d.path === path);
    if (open) {
      this.editor.setText(open.id, text);
      open.dirty = false;
    }
    if (this.root && isInside(this.root, path)) await this.tree.refresh().then(() => this.reindex());
    await this.openFile(path);
    toast(t("build.saved", { name: basename(path) }), "success");
    return true;
  }

  private insertBuildTemplate() {
    if (!this.activeDoc()) {
      this.newUntitled();
      requestAnimationFrame(() => this.editor.insertText(sampleTemplate()));
    } else {
      this.editor.insertText(sampleTemplate());
    }
  }

  // ───────────── タブ

  /** 関数の一覧を作り直す（見えているときだけ。now = すぐに） */
  private refreshOutline(now = false) {
    window.clearTimeout(this.outlineTimer);
    const run = () => {
      const visible = this.currentView === "outline" && !this.el.classList.contains("sidebar-hidden");
      if (!visible) return;
      const doc = this.activeDoc();
      if (!doc) {
        this.outlineItems = [];
        this.outlineView.set([], t("outline.noFile"));
        return;
      }
      const lang = outlineLangOf(extname(this.effectiveName(doc)));
      if (!lang) {
        this.outlineItems = [];
        this.outlineView.set(null, t("outline.unsupported"));
        return;
      }
      this.outlineItems = buildOutline(this.editor.getText(doc.id), lang);
      this.outlineView.set(this.outlineItems, t("outline.none"));
      this.outlineView.setCurrent(currentSymbol(this.outlineItems, this.editor.cursor().line));
    };
    if (now) run();
    else this.outlineTimer = window.setTimeout(run, 350);
  }

  /** Ctrl+Shift+O：関数・クラスを選んで飛ぶ */
  private async gotoSymbol() {
    const doc = this.activeDoc();
    if (!doc) return;
    const lang = outlineLangOf(extname(this.effectiveName(doc)));
    const items = lang ? buildOutline(this.editor.getText(doc.id), lang) : [];
    if (!items.length) {
      toast(t(lang ? "outline.none" : "outline.unsupported"), "info");
      return;
    }
    const pick = await quickPick(
      items.map((it) => ({ label: `${"　".repeat(it.level)}${it.name}`, detail: `${t(`outline.kind.${it.kind}`)}${it.detail ? "  " + it.detail : ""}`, hint: String(it.line), value: it })),
      t("outline.pick"),
    );
    if (pick) this.editor.goTo(pick.line, 1);
  }

  /** 自動整形：black・gofmt・rustfmt・clang-format があれば使い、なければあいぞめの中の簡単な整形 */
  private async formatActive() {
    const doc = this.activeDoc();
    if (!doc) return;
    const text = this.editor.getText(doc.id);
    const ext = extname(this.effectiveName(doc)).toLowerCase();
    const tab = settings.get("editor.tabSize");
    const useExternal = settings.get("editor.externalFormatter");
    let result: string | null = null;
    let used = t("format.builtin");
    const external = async (program: string, args: string[], label: string): Promise<boolean> => {
      try {
        const r = await tools.capture(program, args, text, doc.path ? dirname(doc.path) : undefined);
        if (r.code === 0 && r.stdout.trim()) {
          result = r.stdout.replace(/\r\n/g, "\n");
          used = label;
          return true;
        }
        if (r.code !== 0 && !/No module named|not recognized|not found/i.test(r.stderr)) {
          // 文法のまちがいなどで整えられなかった
          const first = r.stderr.split("\n").find((l) => l.trim()) ?? "";
          toast(t("format.failed", { tool: label, err: first.slice(0, 200) }), "warn", 8000);
          result = text;
          return true;
        }
      } catch {
        /* 見つからない・動かない：次の方法へ */
      }
      return false;
    };
    const lang = outlineLangOf(ext);
    if (useExternal) {
      if (lang === "python") {
        const py = await this.pythonProgram();
        if (py && !(await external(py.program, [...py.args, "-m", "black", "-q", "-"], "black"))) {
          if (!this.askedBlack) {
            this.askedBlack = true;
            const answer = await choose(t("format.blackTitle"), t("format.blackMessage"), [
              { label: t("format.builtinOnce"), value: "builtin", kind: "plain" },
              { label: t("format.installBlack"), value: "install", kind: "primary" },
            ], "builtin");
            if (answer === "install") {
              const win = this.sys.os === "windows";
              const call = (/[\s\\/]/.test(py.program) ? (win ? `& "${py.program}"` : `"${py.program}"`) : py.program) + (py.args.length ? " " + py.args.join(" ") : "");
              const done = t("format.blackInstalled");
              await this.terminal.run(win ? `${call} -m pip install --user black; Write-Host ""; Write-Host "${done}" -ForegroundColor Green` : `${call} -m pip install --user black && echo "${done}"`);
              return;
            }
          }
        }
      } else if (lang === "go" || lang === "rust" || ext === ".c" || ext === ".h" || lang === "cpp" || ext === ".java" || ext === ".cs" || [".js", ".ts", ".jsx", ".tsx", ".mjs"].includes(ext)) {
        const names = lang === "go" ? ["gofmt"] : lang === "rust" ? ["rustfmt"] : ["clang-format"];
        try {
          const found = await tools.find(names);
          if (found) {
            const args = lang === "go" ? [] : lang === "rust" ? ["--edition", "2021", "--emit", "stdout"] : [`--assume-filename=file${ext}`, `--style={BasedOnStyle: Microsoft, IndentWidth: ${tab}, ColumnLimit: 0}`];
            await external(found.path, args, names[0]);
          }
        } catch {
          /* なければ中の整形 */
        }
      }
    }
    if (result === null) {
      if (lang === "python") result = formatPython(text, tab);
      else if (lang) result = formatBraces(text, lang, tab);
      else if (ext === ".json") result = formatJson(text, tab) ?? text;
      else result = formatPlain(text);
    }
    const finalText = result as string;
    if (finalText === text) {
      toast(t("format.same"), "info", 3000);
      return;
    }
    this.editor.activate(doc.id);
    this.editor.applyText(finalText);
    toast(t("format.done", { tool: used }), "success", 3500);
  }

  /** python の呼び方（プログラムと引数に分ける） */
  private async pythonProgram(): Promise<{ program: string; args: string[] } | null> {
    try {
      const info = await runtimes.findPython();
      const cmd = info.command;
      if (!cmd) return null;
      const quoted = /^"([^"]+)"\s*(.*)$/.exec(cmd);
      if (quoted) return { program: quoted[1], args: quoted[2] ? quoted[2].split(/\s+/) : [] };
      const [program, ...args] = cmd.split(/\s+/);
      return { program, args };
    } catch {
      return { program: this.sys.os === "windows" ? "python" : "python3", args: [] };
    }
  }

  /** 上の ↺ ↻：今のファイルを元に戻す／やり直す（Ctrl+Z・Ctrl+Y と同じ記録を使う） */
  private async historyStep(kind: "undo" | "redo") {
    if (!this.activeDoc()) return;
    await this.editor.run(kind);
    this.renderHistoryButtons();
  }

  private renderHistoryButtons() {
    if (!this.undoBtn) return;
    const d = this.activeDoc() ? this.editor.historyDepth() : { undo: 0, redo: 0 };
    const set = (b: HTMLButtonElement, n: number, label: string, keys: string) => {
      b.disabled = n === 0;
      const text = `${label} (${keys})${n ? `　${t("history.steps", { n: String(n) })}` : ""}`;
      b.title = text;
      b.setAttribute("aria-label", text);
    };
    set(this.undoBtn, d.undo, t("cmd.undo"), formatKey("Mod-Z"));
    set(this.redoBtn, d.redo, t("cmd.redo"), `${formatKey("Mod-Y")} / ${formatKey("Mod-Shift-Z")}`);
  }

  /** エディタの右クリック：切り取り・コピー・貼り付けと、コピー履歴 */
  private editorMenu(x: number, y: number) {
    const act = (a: "cut" | "copy" | "paste" | "selectAll") => () => void this.editor.run(a);
    const items: CtxItem[] = [
      { label: t("cmd.cut"), hint: formatKey("Mod-X"), run: act("cut") },
      { label: t("cmd.copy"), hint: formatKey("Mod-C"), run: act("copy") },
      { label: t("cmd.paste"), hint: formatKey("Mod-V"), run: act("paste") },
      { label: t("cmd.selectAll"), hint: formatKey("Mod-A"), run: act("selectAll") },
    ];
    const clips = clipHistory();
    if (settings.get("clip.history")) {
      items.push({ label: "", sep: true }, { label: t("clip.title", { key: formatKey("Mod-Shift-H") }), note: true });
      if (!clips.length) items.push({ label: t("clip.empty"), note: true });
      clips.forEach((text, i) =>
        items.push({
          label: clipLabel(text),
          code: true,
          hint: i < 9 ? String(i + 1) : "0",
          key: i < 9 ? String(i + 1) : "0",
          title: text.length > 600 ? text.slice(0, 600) + "…" : text,
          run: () => this.pasteClip(text),
        }),
      );
    }
    if (this.activeDoc()) {
      items.push({ label: "", sep: true });
      items.push({ label: t("cmd.renameSymbol"), hint: "F2", run: () => this.renameSymbol() });
    }
    contextMenu(x, y, items);
  }

  private pasteClip(text: string) {
    if (!this.activeDoc()) return;
    this.editor.replaceSelection(text);
    this.editor.focus();
  }

  /** Ctrl+Shift+V：コピー履歴から選んで貼り付ける */
  private async pasteFromHistory() {
    const clips = clipHistory();
    if (!clips.length) {
      toast(settings.get("clip.history") ? t("clip.empty") : t("clip.off"), "info");
      return;
    }
    const pick = await quickPick(
      clips.map((text, i) => ({ label: clipLabel(text, 70), detail: i === 0 ? t("clip.latest") : t("clip.nth", { n: String(i + 1) }), value: text })),
      t("clip.pick"),
    );
    if (pick !== undefined) this.pasteClip(pick);
  }

  /** タブの右クリック：左右に並べる・元に戻す */
  private tabMenu(id: string, x: number, y: number) {
    const split = this.editor.isSplit();
    const inRight = this.editor.paneOf(id) === 1;
    const items: { label: string; run: () => void; danger?: boolean }[] = [];
    if (!inRight) items.push({ label: t("split.right"), run: () => this.splitTab(id, "right") });
    items.push({ label: t("split.left"), run: () => this.splitTab(id, "left") });
    if (inRight) items.push({ label: t("split.back"), run: () => this.splitTab(id, "back") });
    if (split) items.push({ label: t("split.off"), run: () => this.unsplit() });
    items.push({ label: t("compare.menu"), run: () => void this.compareFiles(id) });
    if (this.runOutputs.get(id)?.prev) items.push({ label: t("runcmp.menu"), run: () => void this.compareRuns(id) });
    items.push({ label: t("tabs.close"), run: () => void this.closeDoc(id), danger: true });
    const others = this.docs.filter((d) => d.id !== id);
    const idx = this.docs.findIndex((d) => d.id === id);
    const right = this.docs.slice(idx + 1);
    const saved = this.docs.filter((d) => !d.dirty);
    if (others.length) items.push({ label: t("tabs.closeOthers", { n: String(others.length) }), run: () => void this.closeMany(others.map((d) => d.id)) });
    if (right.length) items.push({ label: t("tabs.closeRight", { n: String(right.length) }), run: () => void this.closeMany(right.map((d) => d.id)) });
    if (saved.length && saved.length < this.docs.length) items.push({ label: t("tabs.closeSaved", { n: String(saved.length) }), run: () => void this.closeMany(saved.map((d) => d.id)) });
    if (this.docs.length > 1) items.push({ label: t("tabs.closeAll", { n: String(this.docs.length) }), run: () => void this.closeMany(this.docs.map((d) => d.id)), danger: true });
    contextMenu(x, y, items);
  }

  private async closeMany(ids: string[]) {
    for (const id of ids) await this.closeDoc(id);
  }

  private splitTab(id: string | null = this.activeId, side: "right" | "left" | "back" = "right") {
    if (!id) return;
    if (!this.editor.moveToPane(id, side)) {
      toast(t("split.needTwo"), "info", 5000);
      return;
    }
    this.activate(id);
  }

  private unsplit() {
    this.editor.unsplit();
    if (this.activeId) this.activate(this.activeId);
  }

  private renderTabs() {
    clear(this.tabsEl);
    const split = this.editor.isSplit();
    const visible = this.editor.visibleIds();
    for (const doc of this.docs) {
      const active = doc.id === this.activeId;
      const right = split && this.editor.paneOf(doc.id) === 1;
      const shown = !active && visible.includes(doc.id);
      const tab = h(
        "div",
        {
          class: "tab" + (active ? " active" : "") + (shown ? " shown" : "") + (right ? " in-right" : "") + (doc.dirty ? " dirty" : ""),
          role: "tab",
          "aria-selected": String(active),
          tabindex: 0,
          title: doc.path ?? doc.name,
        },
        split ? h("span", { class: "tab-side", title: t(right ? "split.inRight" : "split.inLeft") }, t(right ? "split.badgeRight" : "split.badgeLeft")) : null,
        h("span", { class: "tab-name" }, doc.name),
        h("button", {
          class: "tab-close",
          title: t("tabs.close"),
          "aria-label": t("tabs.close"),
          html: icon("x", 12),
          onclick: (e: Event) => {
            e.stopPropagation();
            void this.closeDoc(doc.id);
          },
        }),
      );
      tab.addEventListener("click", () => this.activate(doc.id));
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.tabMenu(doc.id, e.clientX, e.clientY);
      });
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) void this.closeDoc(doc.id);
      });
      tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") this.activate(doc.id);
      });
      this.tabsEl.append(tab);
      if (active) requestAnimationFrame(() => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
    const empty = this.docs.length === 0;
    this.welcomeEl.hidden = !empty;
    this.editorMount.hidden = empty;
    this.tabsEl.classList.toggle("empty", empty);
  }

  // ───────────── ステータスバーと AI 表示

  private renderStatus() {
    clear(this.statusLeft);
    clear(this.statusRight);
    const item = (text: string, title?: string, onclick?: () => void) =>
      onclick
        ? h("button", { class: "status-item", title: title ?? text, onclick }, text)
        : h("span", { class: "status-item", title: title ?? text }, text);

    const doc = this.activeDoc();
    if (this.gitBranch) {
      const label = this.gitChanges ? `${this.gitBranch}  ${t("status.gitChanges", { n: String(this.gitChanges) })}` : this.gitBranch;
      this.statusLeft.append(
        h("button", { class: "status-item git-item", title: t("status.gitTitle"), onclick: () => void this.refreshGit() }, h("span", { class: "git-icon", "aria-hidden": "true" }), label),
      );
    }
    if (this.update) {
      const info = this.update;
      this.statusLeft.append(
        h("button", { class: "status-item update-item", title: t("update.title", { version: info.latest ?? "" }), onclick: () => void openUpdateDialog(this.updateDeps, info) }, t("update.status", { version: info.latest ?? "" })),
      );
    }
    if (doc?.dirty) this.statusLeft.append(h("span", { class: "status-item dirty-note" }, t("status.unsaved")));
    for (const [, v] of this.statusItems) this.statusLeft.append(item(v.text, v.tooltip));

    if (doc) {
      const pos = this.editor.cursor();
      const presetN = presetCount(this.presetFor(doc));
      if (presetN) this.statusRight.append(item(t("inputs.status", { n: String(presetN) }), t("inputs.statusTitle"), () => void this.editInputs()));
      const sel = settings.get("ui.selectionCount") ? this.editor.getSelection() : "";
      if (sel) {
        const c = countChars(sel);
        this.statusRight.append(item(t("status.selection", { n: c.chars.toLocaleString(), lines: String(c.lines) }), t("status.selectionTitle"), () => void openSlashPalette("/count").catch(() => {})));
      }
      this.statusRight.append(
        item(t("status.position", { line: String(pos.line), col: String(pos.col) }), undefined, () => void this.goToLine()),
        item(t("status.spaces", { n: String(settings.get("editor.tabSize")) })),
        item(`${encodingLabel(doc.encoding, doc.bom)}  ${doc.eol === "crlf" ? "CRLF" : "LF"}`, t("enc.pick"), () => void this.pickEncoding()),
        item(this.editor.languageName(), t("lang.pick"), () => void this.pickLanguage()),
      );
    }
  }

  private async goToLine() {
    const v = await inputBox({ title: t("cmd.goToLine"), placeholder: "42" });
    const [line, col] = (v ?? "").split(/[:,\s]+/).map(Number);
    if (line) this.editor.goTo(line, col || 1);
  }

  private renderAi(status: AiStatus) {
    const model = settings.get("ai.model");
    const label =
      status === "off" ? t("ai.off") : status === "error" ? t("ai.error") : model;
    this.aiPill.className = `ai-pill ${status}`;
    this.aiPill.title =
      status === "error" ? `${t("ai.errorTitle")}\n${describeAiError(completer.lastError)}` : status === "off" ? t("ai.offTitle") : t("ai.onTitle", { model });
    this.aiPill.innerHTML = "";
    this.aiPill.append(h("span", { class: "ai-drop", "aria-hidden": "true" }), h("span", { class: "ai-label" }, label));
  }

  private onAiPillClick() {
    if (completer.paused) {
      void askAboutMemory();
      return;
    }
    if (completer.status === "error") {
      toast(describeAiError(completer.lastError), "error", 10000);
      completer.setStatus(settings.get("ai.enabled") ? "idle" : "off");
      settingsPage.open("ai");
      return;
    }
    settings.set("ai.enabled", !settings.get("ai.enabled"));
  }

  private toggleZen() {
    const on = !this.el.classList.contains("zen");
    this.el.classList.toggle("zen", on);
    if (on) toast(t("zen.hint", { key: formatKey("Mod-Alt-Z") }), "info");
    this.editor.focus();
  }

  private async revert() {
    const doc = this.activeDoc();
    if (!doc?.path) return;
    try {
      const read = await fs.readFileEnc(doc.path, doc.encoding);
      const text = read.text;
      doc.bom = read.bom;
      doc.eol = read.eol;
      this.editor.setText(doc.id, text);
      doc.dirty = false;
      this.renderTabs();
      this.renderStatus();
      toast(t("file.reverted", { name: doc.name }), "success");
    } catch (err) {
      toast(t("file.openFailed", { name: doc.name, err: String(err) }), "error");
    }
  }

  private cycleTab(dir: number) {
    if (this.docs.length < 2) return;
    const i = this.docs.findIndex((d) => d.id === this.activeId);
    const next = this.docs[(i + dir + this.docs.length) % this.docs.length];
    this.activate(next.id);
  }

  // ───────────── メニュー

  private menuItems(): MenuItem[] {
    const c = (id: string, checked?: () => boolean): MenuItem => ({ type: "command", id, checked });
    const sep: MenuItem = { type: "separator" };
    const recent = (): MenuItem[] => {
      const list = settings.get("workspace.recent");
      if (!list.length) return [{ type: "note", label: t("recent.none") }];
      return list.slice(0, 10).map((r) => ({ type: "action", label: basename(r), hint: r.length > 40 ? "…" + r.slice(-38) : r, run: () => this.openFolder(r) }));
    };
    const themes = (): MenuItem[] =>
      listThemes().map((th) => ({ type: "action", label: th.label, checked: settings.get("ui.theme") === th.id, run: () => settings.set("ui.theme", th.id) }));
    return [
      {
        type: "submenu",
        label: t("menu.file"),
        items: () => [
          c("file.new"),
          c("file.openFolder"),
          { type: "submenu", label: t("cmd.openRecent"), items: recent },
          sep,
          c("file.save"),
          c("file.saveAs"),
          c("file.saveAll"),
          c("file.revert"),
          sep,
          c("file.print"),
          c("file.export"),
          c("file.compare"),
          c("file.copyPath"),
          sep,
          c("file.close"),
          c("file.closeAll"),
          sep,
          c("view.settings"),
          c("app.quit"),
        ],
      },
      {
        type: "submenu",
        label: t("menu.edit"),
        items: () => [
          c("edit.undo"),
          c("edit.redo"),
          sep,
          c("edit.cut"),
          c("edit.copy"),
          c("edit.paste"),
          c("edit.pasteHistory"),
          c("edit.format"),
          c("edit.selectAll"),
          sep,
          c("edit.find"),
          c("edit.replace"),
          c("search.inFiles"),
          c("editor.goToLine"),
          sep,
          c("edit.toggleComment"),
          c("edit.duplicateLine"),
          c("edit.deleteLine"),
          c("edit.moveLineUp"),
          c("edit.moveLineDown"),
          sep,
          c("edit.foldAll"),
          c("edit.unfoldAll"),
        ],
      },
      {
        type: "submenu",
        label: t("menu.view"),
        items: () => [
          c("view.commandPalette"),
          c("file.quickOpen"),
          sep,
          c("view.explorer"),
          c("search.inFiles"),
          c("view.ai"),
          c("view.extensions"),
          sep,
          c("view.toggleSidebar", () => !this.el.classList.contains("sidebar-hidden")),
          c("terminal.toggle", () => this.terminal.isVisible),
          c("view.markdownPreview", () => this.previewOn),
          c("view.dict"),
          c("view.sideNext"),
          c("view.outline"),
          c("go.symbol"),
          c("view.splitRight"),
          c("view.unsplit"),
          c("view.zen", () => this.el.classList.contains("zen")),
          c("editor.toggleExplain", () => settings.get("editor.explain") !== "off"),
          c("view.fullscreen"),
          sep,
          c("view.zoomIn"),
          c("view.zoomOut"),
          c("view.zoomReset"),
          sep,
          c("editor.toggleWrap", () => settings.get("editor.wordWrap")),
          c("editor.toggleLineNumbers", () => settings.get("editor.lineNumbers")),
          { type: "submenu", label: t("settings.theme"), items: themes },
        ],
      },
      {
        type: "submenu",
        label: t("menu.run"),
        items: () => [c("run.file"), c("run.build"), c("run.compareLast"), c("run.editInputs"), c("run.trace"), c("run.stepNext"), c("run.stepPrev"), c("run.clearValues"), sep, c("terminal.new"), ...(commands.get("terminal.newCmd") ? [c("terminal.newCmd"), c("terminal.newPowerShell")] : []), c("terminal.toggle", () => this.terminal.isVisible), c("terminal.clear")],
      },
      {
        type: "submenu",
        label: t("menu.ai"),
        items: () => [
          c("view.ai"),
          c("ai.build"),
          c("ai.buildTemplate"),
          sep,
          c("ai.rewrite"),
          c("ai.explain"),
          c("ai.comment"),
          c("ai.fix"),
          c("ai.trigger"),
          sep,
          c("ai.toggle", () => settings.get("ai.enabled")),
          c("ai.settings"),
        ],
      },
      {
        type: "submenu",
        label: t("menu.help"),
        items: () => [c("help.open"), c("help.slash"), c("help.shortcuts"), c("view.commandPalette"), sep, c("ext.reload"), c("git.refresh"), sep, c("app.checkUpdates"), c("help.about")],
      },
    ];
  }

  /** 開いているファイルを印刷する（画面ではなく、コードだけを行番号付きで） */
  private async printActive() {
    const doc = this.activeDoc();
    if (!doc) {
      toast(t("print.noFile"), "info");
      return;
    }
    if (!(this.isMarkdown(doc) && this.previewOn)) {
      await this.exportActive("print");
      return;
    }
    document.querySelector(".print-sheet")?.remove();
    document.getElementById("print-export-style")?.remove();
    const lines = this.editor.getText(doc.id).split("\n");
    const width = String(lines.length).length;
    const sheet = h(
      "div",
      { class: "print-sheet" },
      h("header", { class: "print-head" }, h("strong", {}, doc.name), h("span", {}, doc.path ?? ""), h("span", {}, new Date().toLocaleString())),
      h("pre", { class: "print-code" }, lines.map((l, i) => `${String(i + 1).padStart(width, " ")}  ${l}`).join("\n")),
    );
    if (this.isMarkdown(doc) && this.previewOn) {
      sheet.replaceChildren(h("div", { class: "print-md" }, renderMarkdown(this.editor.getText(doc.id))));
    }
    document.body.append(sheet);
    try {
      await sys.print();
    } catch {
      window.print();
    }
  }

  private showShortcuts() {
    const rows = commands
      .list()
      .filter((c) => c.key || c.display)
      .map((c) => ({ title: commands.title(c), key: c.key ? formatKey(c.key) : c.display! }))
      .sort((a, b) => a.title.localeCompare(b.title));
    const box = h(
      "div",
      { class: "modal wide", role: "dialog", "aria-modal": "true" },
      h("h2", { class: "modal-title" }, t("help.shortcuts")),
      h("div", { class: "shortcut-list" }, ...rows.map((r) => h("div", { class: "shortcut-row" }, h("span", {}, r.title), h("kbd", {}, r.key)))),
      h("div", { class: "modal-actions" }, h("button", { class: "btn primary", type: "button", onclick: () => backdrop.remove() }, t("common.ok"))),
    );
    const backdrop = h("div", { class: "modal-backdrop" }, box);
    backdrop.addEventListener("mousedown", (e) => e.target === backdrop && backdrop.remove());
    backdrop.addEventListener("keydown", (e) => e.key === "Escape" && backdrop.remove());
    document.body.append(backdrop);
    (box.querySelector("button") as HTMLElement).focus();
  }

  private async showAbout() {
    let version = "";
    try {
      version = (await sys.appInfo()).version;
    } catch {
      version = "—";
    }
    await choose(
      "Aizome",
      t("help.aboutText", { version, os: this.sys.os, model: settings.get("ai.model") }),
      [{ label: t("common.ok"), value: true, kind: "primary" }],
      true,
    );
  }

  // ───────────── コマンド

  /** ターミナルに出た最後のエラーを日本語で説明する */
  private async explainLastError() {
    const recent = this.terminal.recentOutput(400);
    await showErrorExplanation(explainError(recent, this.sys.os), {
      recent,
      goTo: (file, line) => void this.openLocation(file, line, 1),
      run: (cmd) => void this.terminal.run(cmd),
      askAi: (q) => {
        this.showView("ai");
        this.chatView.ask(q);
      },
    });
  }

  /** 画面のボタンなどの表示・非表示（機能のオン・オフ） */
  private applyUiToggles() {
    const root = document.documentElement.classList;
    root.toggle("hide-trace-btn", !settings.get("ui.traceButton"));
    root.toggle("hide-top-tools", !settings.get("ui.topTools"));
    root.toggle("hide-dict-btn", !settings.get("ui.dictButton"));
    root.toggle("hide-err-btn", !settings.get("ui.errorButton"));
    root.toggle("hide-side-switch", !settings.get("ui.sideSwitch"));
  }

  /** 定義元がこのファイルにないとき：開いているフォルダのほかのファイルから探す */
  private setupDefinitionSearch() {
    setDefinitionFallback(async (name) => {
      if (!this.root) return false;
      try {
        const res = await fs.search({ root: this.root, query: definitionSearchRegex(name), regex: true, caseSensitive: true, wholeWord: false, limit: 20 });
        const current = this.activeDoc()?.path;
        const hit = res.hits.find((h) => h.path !== current) ?? res.hits[0];
        if (!hit) return false;
        await this.openFile(hit.path, hit.line, hit.col);
        toast(t("def.otherFile", { name, file: basename(hit.path), line: String(hit.line) }), "info", 3500);
        return true;
      } catch {
        return false;
      }
    });
  }

  private watchSideMode() {
    this.applyUiToggles();
    bus.on("settings:changed", ({ key }) => {
      if (key.startsWith("ui.")) this.applyUiToggles();
      if (key === "ui.fileGroups") this.groups.render();
      if (key === "ui.saveHistory") void this.history.refresh();
      if (key === "ui.selectionCount") this.renderStatus();
    });
    bus.on("settings:changed", ({ key }) => {
      if (key !== "editor.sideView") return;
      this.renderBreadcrumbs();
      if (["values", "output"].includes(settings.get("editor.sideView"))) this.refreshTrace();
      const mode = settings.get("editor.sideView");
      if (mode === "auto") toast(t("side.autoToast"), "info", 6000);
      if ((mode === "values" || mode === "output") && !this.anyValues()) toast(t("side.valuesEmpty"), "info", 5000);
    });
    onInferBusy(() => this.renderBreadcrumbs());
  }

  private anyValues(): boolean {
    return this.valuesShown.has(this.activeId ?? "");
  }

  private registerSlashCommands() {
    registerBuiltinSlash({
      editor: this.editor,
      os: () => this.sys.os,
      activeName: () => this.activeDoc()?.path ?? this.activeDoc()?.name ?? null,
      hasDoc: () => !!this.activeDoc(),
      showView: (v) => this.showView(v),
      searchFor: (text) => {
        this.showView("search");
        this.searchView.focus(text || undefined);
      },
      askAi: (q) => {
        this.showView("ai");
        this.chatView.ask(q);
      },
      runInTerminal: (cmd) => void this.terminal.run(cmd),
      explainError: () => void this.explainLastError(),
      openSettings: (section) => settingsPage.open(section),
      openHelp: (section) => helpPage.open(section),
      openDict: (query) => {
        this.showView("dict");
        this.dictView.focus(query);
      },
    });
    // ヘルプの中の「/〜」をクリックしたとき
    helpPage.runSlash = (name) => {
      const c = listSlash().find((x) => x.name === name);
      if (!c) return;
      if (c.argHint || c.expand) void openSlashPalette(`/${c.name}${c.argHint ? " " : ""}`);
      else void c.run?.("");
    };
  }

  private registerCommands() {
    const reg = (id: string, titleKey: string, run: () => unknown, key?: string, inTerminal = false) =>
      commands.register({ id, title: () => t(titleKey), key, inTerminal, source: "core", run });

    reg("file.openFolder", "cmd.openFolder", () => this.openFolder(), "Mod-O");
    reg("file.new", "cmd.newFile", () => this.newUntitled(), "Mod-N");
    reg("file.save", "cmd.save", () => this.save(), "Mod-S");
    reg("file.saveAs", "cmd.saveAs", () => this.save(this.activeId, true), "Mod-Shift-S");
    reg("file.close", "cmd.closeTab", () => this.closeDoc(), "Mod-W");
    reg("file.quickOpen", "cmd.quickOpen", () => this.quickOpen(), "Mod-P");
    reg("view.commandPalette", "cmd.commandPalette", () => openCommandPalette(), "Mod-Shift-P", true);
    reg("view.toggleSidebar", "cmd.toggleSidebar", () => this.collapseSidebar(!this.el.classList.contains("sidebar-hidden")), "Mod-B");
    reg("view.explorer", "cmd.showExplorer", () => this.showView("explorer"), "Mod-Shift-E");
    reg("view.outline", "cmd.showOutline", () => this.toggleView("outline"));
    reg("go.symbol", "cmd.gotoSymbol", () => this.gotoSymbol(), "Mod-Shift-O");
    reg("edit.format", "cmd.format", () => this.formatActive(), "Shift-Alt-F");
    reg("view.extensions", "cmd.showExtensions", () => this.showView("extensions"), "Mod-Shift-X");
    reg("view.settings", "cmd.showSettings", () => settingsPage.toggle(), "Mod-,", true);
    reg("terminal.toggle", "cmd.toggleTerminal", () => this.terminal.toggle(), "Mod-`", true);
    reg("terminal.new", "cmd.newTerminal", () => this.terminal.newTerminal(), "Mod-Shift-`", true);
    // ここは sys.info() を読む前に動くので、this.sys.os ではなく userAgent で Windows かどうかを見る
    if (navigator.userAgent.includes("Windows")) {
      // 授業のプリントはコマンドプロンプト向け・PowerShell 向けのどちらもあるので、すぐ開けるように
      reg("terminal.newCmd", "cmd.newCmd", () => this.terminal.openShell("cmd"), undefined, true);
      reg("terminal.newPowerShell", "cmd.newPowerShell", () => this.terminal.openShell("powershell"), undefined, true);
    }
    reg("run.file", "cmd.run", () => this.runActive(), "F5", true);
    reg("editor.goToLine", "cmd.goToLine", () => this.goToLine(), "Mod-G");
    // 拡張機能用：commands.execute("editor.goToLineNumber", 行, 列)
    commands.register({
      id: "editor.goToLineNumber",
      title: () => t("cmd.goToLine"),
      hidden: true,
      source: "core",
      run: (line, col) => this.editor.goTo(Number(line) || 1, Number(col) || 1),
    });
    reg("ai.toggle", "cmd.aiToggle", () => settings.set("ai.enabled", !settings.get("ai.enabled")));
    reg("ai.toggleInline", "cmd.aiToggleInline", () => settings.set("ai.inline", !settings.get("ai.inline")), "Mod-Alt-Space");
    reg("ai.trigger", "cmd.aiTrigger", () => this.editor.triggerCompletion());
    reg("ext.reload", "cmd.reloadExtensions", () => this.extensions.reload());
    reg("search.inFiles", "cmd.searchInFiles", () => this.showView("search"), "Mod-Shift-F");
    reg("view.ai", "cmd.showAiChat", () => this.showView("ai"), "Mod-Shift-A");
    reg("ai.rewrite", "cmd.aiRewrite", () => aiRewrite(this.editor), "Mod-I");
    reg("ai.explain", "cmd.aiExplain", () => {
      this.showView("ai");
      this.chatView.ask(t("chat.example1"));
    });
    reg("ai.comment", "cmd.aiComment", () => aiRewrite(this.editor, t("rewrite.presetComment")));
    reg("ai.fix", "cmd.aiFix", () => aiRewrite(this.editor, t("rewrite.presetFix")));
    reg("view.markdownPreview", "cmd.markdownPreview", () => this.togglePreview(), "Mod-Shift-V");
    reg("editor.toggleExplain", "cmd.toggleExplain", () => {
      const next = settings.get("editor.explain") === "off" ? "ai" : "off";
      settings.set("editor.explain", next);
      toast(t(next === "off" ? "explain.offToast" : "explain.onToast"), "info");
    }, "Mod-Alt-E", true);
    reg("view.zen", "cmd.zen", () => this.toggleZen(), "Mod-Alt-Z", true);
    reg("view.fullscreen", "cmd.fullscreen", async () => appWindow.setFullscreen(!(await appWindow.isFullscreen())), "F11", true);
    reg("view.zoomIn", "cmd.zoomIn", () => zoomBy(0.1), "Mod-=", true);
    reg("view.zoomOut", "cmd.zoomOut", () => zoomBy(-0.1), "Mod--", true);
    reg("view.zoomReset", "cmd.zoomReset", () => settings.set("look.zoom", 1), "Mod-0", true);
    // 日本語キーボードの「;+」キーでも拡大できるように
    commands.register({ id: "view.zoomInJis", title: () => t("cmd.zoomIn"), key: "Mod-;", inTerminal: true, hidden: true, run: () => zoomBy(0.1) });
    commands.register({ id: "view.zoomInShift", title: () => t("cmd.zoomIn"), key: "Mod-Shift-;", inTerminal: true, hidden: true, run: () => zoomBy(0.1) });
    reg("editor.toggleWrap", "cmd.toggleWrap", () => settings.set("editor.wordWrap", !settings.get("editor.wordWrap")), "Alt-Z");
    reg("editor.toggleLineNumbers", "cmd.toggleLineNumbers", () => settings.set("editor.lineNumbers", !settings.get("editor.lineNumbers")));
    reg("file.openRecent", "cmd.openRecent", async () => {
      const items = settings.get("workspace.recent").map((r) => ({ label: basename(r), detail: r, icon: "folder", value: r }));
      if (!items.length) return toast(t("recent.none"), "info");
      const picked = await quickPick(items, t("cmd.openRecent"));
      if (picked) await this.openFolder(picked);
    }, "Mod-R");
    reg("file.revert", "cmd.revert", () => this.revert());
    reg("file.saveAll", "cmd.saveAll", () => this.saveAllDirty(), "Mod-Alt-S");
    reg("file.closeAll", "cmd.closeAll", async () => {
      for (const d of [...this.docs]) await this.closeDoc(d.id);
    });
    reg("file.copyPath", "cmd.copyPath", () => {
      const p = this.activeDoc()?.path;
      if (p) void navigator.clipboard?.writeText(p).then(() => toast(t("chat.copied"), "success"));
    });
    reg("tabs.next", "cmd.nextTab", () => this.cycleTab(1), "Ctrl-Tab", true);
    reg("tabs.prev", "cmd.prevTab", () => this.cycleTab(-1), "Ctrl-Shift-Tab", true);
    // Windows / Linux では Ctrl が Mod 扱いになるため、同じ動作を Mod でも登録する
    commands.register({ id: "tabs.nextMod", title: () => t("cmd.nextTab"), key: "Mod-Tab", inTerminal: true, hidden: true, run: () => this.cycleTab(1) });
    commands.register({ id: "tabs.prevMod", title: () => t("cmd.prevTab"), key: "Mod-Shift-Tab", inTerminal: true, hidden: true, run: () => this.cycleTab(-1) });
    reg("terminal.clear", "cmd.clearTerminal", () => this.terminal.clearActive());
    reg("git.refresh", "cmd.gitRefresh", () => this.refreshGit());
    // 編集（キー操作はエディタ側が受け持つので、表示用のキーだけ載せる）
    const edit = (id: string, title: string, action: Parameters<EditorHost["run"]>[0], display?: string) =>
      commands.register({ id, title: () => t(title), display, source: "core", run: () => this.editor.run(action) });
    const mod = (k: string) => formatKey(k);
    edit("edit.undo", "cmd.undo", "undo", mod("Mod-Z"));
    edit("edit.redo", "cmd.redo", "redo", mod("Mod-Shift-Z"));
    edit("edit.cut", "cmd.cut", "cut", mod("Mod-X"));
    edit("edit.copy", "cmd.copy", "copy", mod("Mod-C"));
    commands.register({
      id: "edit.paste",
      title: () => t("cmd.paste"),
      display: mod("Mod-V"),
      source: "core",
      run: async () => {
        if (!(await this.editor.run("paste"))) toast(t("edit.pasteBlocked", { key: mod("Mod-V") }), "info");
      },
    });
    edit("edit.selectAll", "cmd.selectAll", "selectAll", mod("Mod-A"));
    edit("edit.find", "cmd.find", "find", mod("Mod-F"));
    edit("edit.replace", "cmd.replace", "replace");
    edit("edit.toggleComment", "cmd.toggleComment", "toggleComment", mod("Mod-/"));
    edit("edit.duplicateLine", "cmd.duplicateLine", "duplicateLine", mod("Shift-Alt-ArrowDown"));
    edit("edit.deleteLine", "cmd.deleteLine", "deleteLine", mod("Mod-Shift-K"));
    edit("edit.moveLineUp", "cmd.moveLineUp", "moveLineUp", mod("Alt-ArrowUp"));
    edit("edit.moveLineDown", "cmd.moveLineDown", "moveLineDown", mod("Alt-ArrowDown"));
    edit("edit.foldAll", "cmd.foldAll", "foldAll");
    edit("edit.unfoldAll", "cmd.unfoldAll", "unfoldAll");
    reg("file.print", "cmd.print", () => this.printActive(), "Mod-Alt-P");
    reg("file.export", "cmd.exportCode", () => this.exportActive(), "Mod-Alt-X");
    reg("run.build", "cmd.build", () => this.buildActive(), "Mod-Shift-B", true);
    // 日本語から組み立てる（行番号を渡すとそのブロック、なければカーソル位置のブロック）
    commands.register({
      id: "ai.build",
      title: () => t("cmd.aiBuild"),
      key: "Mod-Shift-Enter",
      source: "core",
      run: (line) =>
        buildFromJapanese(
          {
            editor: this.editor,
            activeDoc: () => this.activeDoc(),
            root: () => this.root,
            saveAndOpen: (p, text) => this.saveAndOpen(p, text),
            run: (p) => this.runPath(p),
            insertTemplate: () => this.insertBuildTemplate(),
          },
          typeof line === "number" ? line : undefined,
        ),
    });
    reg("ai.buildTemplate", "cmd.aiBuildTemplate", () => this.insertBuildTemplate());
    reg("app.quit", "cmd.quit", () => appWindow.close(), "Mod-Q", true);
    reg("ai.settings", "cmd.aiSettings", () => settingsPage.open("ai"));
    reg("ai.detect", "cmd.aiDetect", () => ensureLocalAi());
    reg("help.open", "cmd.help", () => helpPage.open(), "F1", true);
    reg("help.slash", "cmd.slash", () => openSlashPalette("/"));
    reg("terminal.explainError", "cmd.explainError", () => this.explainLastError());
    reg("file.encoding", "cmd.encoding", () => this.pickEncoding());
    reg("run.trace", "cmd.trace", () => this.traceActive(), "F6", true);
    reg("run.clearValues", "cmd.clearValues", () => {
      const doc = this.activeDoc();
      if (doc) {
        this.editor.showValues(doc.id, null);
        this.valuesShown.delete(doc.id);
        this.traceRaw.delete(doc.id);
        this.traceStep = null;
        this.renderBreadcrumbs();
      }
    });
    const sides = ["explain", "values", "output", "auto", "off"] as const;
    reg("view.sideNext", "cmd.sideNext", () => {
      const i = sides.indexOf(settings.get("editor.sideView"));
      settings.set("editor.sideView", sides[(i + 1) % sides.length]);
    }, "Mod-Alt-V", true);
    reg("view.sideAuto", "cmd.sideAuto", () => settings.set("editor.sideView", "auto"));
    reg("view.sideOutput", "cmd.sideOutput", () => settings.set("editor.sideView", "output"));
    reg("view.splitRight", "cmd.splitRight", () => this.splitTab(this.activeId, "right"), "Mod-\\");
    reg("view.splitLeft", "cmd.splitLeft", () => this.splitTab(this.activeId, "left"));
    reg("view.splitBack", "cmd.splitBack", () => this.splitTab(this.activeId, "back"));
    reg("view.unsplit", "cmd.unsplit", () => this.unsplit());
    reg("edit.pasteHistory", "cmd.pasteHistory", () => this.pasteFromHistory(), "Mod-Shift-H");
    reg("file.compare", "cmd.compareFiles", () => this.compareFiles());
    reg("run.compareLast", "cmd.compareRuns", () => this.compareRuns(), "Mod-Alt-D", true);
    reg("settings.export", "cmd.settingsExport", () => exportSettings());
    reg("settings.import", "cmd.settingsImport", () => importSettings());
    reg("edit.renameSymbol", "cmd.renameSymbol", () => this.renameSymbol(), "F2");
    reg("run.editInputs", "cmd.editInputs", () => this.editInputs(), "Mod-Alt-I", true);
    reg("run.stepNext", "cmd.stepNext", () => this.stepTrace(1), "F7", true);
    reg("run.stepPrev", "cmd.stepPrev", () => this.stepTrace(-1), "Shift-F7", true);
    reg("run.stepAll", "cmd.stepAll", () => this.stepTrace(0));
    reg("view.sideExplain", "cmd.sideExplain", () => settings.set("editor.sideView", "explain"));
    reg("view.sideValues", "cmd.sideValues", () => settings.set("editor.sideView", "values"));
    reg("view.dict", "cmd.dict", () => {
      this.showView("dict");
      this.dictView.focus();
    }, "Mod-Shift-D", true);
    reg("help.shortcuts", "help.shortcuts", () => this.showShortcuts(), "Mod-K");
    reg("help.about", "help.about", () => this.showAbout());
    reg("app.checkUpdates", "cmd.checkUpdates", () => checkForUpdates(this.updateDeps, true));
    reg("view.menu", "menu.open", () => this.menuButton.click(), "Alt-F", true);
    reg("theme.select", "cmd.selectTheme", async () => {
      const id = await quickPick(
        listThemes().map((th) => ({ label: th.label, detail: th.scheme === "dark" ? t("theme.dark") : t("theme.light"), value: th.id })),
        t("cmd.selectTheme"),
      );
      if (id) settings.set("ui.theme", id);
    });
  }

  /**
   * Esc で、いちばん上に開いているものから閉じる（メニュー → 右クリックメニュー → ヘルプ → 設定）。
   * 検索欄や確認の窓が開いているときは、そちらに任せる
   */
  private installEscape() {
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || e.isComposing) return;
        if (document.querySelector(".palette-backdrop, .modal-backdrop")) return;
        const stop = () => {
          e.preventDefault();
          e.stopPropagation();
        };
        if (menuDrawer.isOpen) return (stop(), menuDrawer.close());
        const ctx = document.querySelector(".context-menu");
        if (ctx) return (stop(), ctx.remove());
        if (helpPage.isOpen) return (stop(), helpPage.close(), this.editor.focus());
        if (settingsPage.isOpen) return (stop(), settingsPage.close(), this.editor.focus());
      },
      true,
    );
  }

  private bindEvents() {
    this.installEscape();
    this.editor.onChange((id) => {
      if (id === this.activeId) this.refreshOutline();
      const doc = this.docs.find((d) => d.id === id);
      if (doc && this.traceRaw.has(doc.id)) {
        // 書き換えたら記録は古くなる
        this.traceRaw.delete(doc.id);
        this.valuesShown.delete(doc.id);
        if (this.traceStep?.docId === doc.id) this.traceStep = null;
        this.renderBreadcrumbs();
      }
      if (doc) {
        window.clearTimeout(this.langTimer);
        this.langTimer = window.setTimeout(() => this.refreshLanguage(doc), 350);
      }
      if (doc && settings.get("editor.autoSave") === "delay" && doc.path) {
        window.clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = window.setTimeout(() => {
          if (doc.dirty) void this.save(doc.id, false, { keepDirective: true });
        }, 1200);
      }
      if (this.previewOn && id === this.activeId) {
        window.clearTimeout(this.previewTimer);
        this.previewTimer = window.setTimeout(() => this.renderPreview(), 350);
      }
      if (doc && !doc.dirty) {
        doc.dirty = true;
        this.renderTabs();
        this.renderStatus();
        if (id === this.activeId) document.title = `● ${doc.name} — Aizome`;
      }
    });
    let pending = false;
    this.editor.onCursor(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        this.renderStatus();
        this.renderHistoryButtons();
        this.followStepCursor();
        if (this.outlineItems.length) this.outlineView.setCurrent(currentSymbol(this.outlineItems, this.editor.cursor().line));
      });
    });
    completer.onStatus((s) => this.renderAi(s));
    watchAiMemory();
    startTourIfFirstTime();
    bus.on("settings:changed", ({ key }) => {
      if (key.startsWith("editor.")) {
        this.editor.applySettings();
        this.renderStatus();
      }
      if (key === "ui.theme") applyTheme(settings.get("ui.theme"));
      if (key === "editor.lineNumbers") this.el.classList.toggle("hide-line-numbers", !settings.get("editor.lineNumbers"));
      if (key === "ai.enabled") {
        if (!settings.get("ai.enabled")) completer.cancelInline();
        completer.setStatus(settings.get("ai.enabled") ? "idle" : "off");
      }
      if (key === "ai.model") this.renderAi(completer.status);
      if (key === "ai.inline") {
        this.renderInlineBtn();
        if (!settings.get("ai.inline")) completer.cancelInline();
        toast(t(settings.get("ai.inline") ? "inline.nowOn" : "inline.nowOff"), "info", 3500);
      }
      if (key === "ui.language") toast(t("settings.languageChanged"), "info");
    });
  }
}
