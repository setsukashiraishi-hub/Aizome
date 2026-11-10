// ネイティブ側（Rust）との窓口。Tauri への依存はこのファイルだけに閉じ込める。
import { settings } from "./settings";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface SysInfo {
  os: string;
  home: string;
  defaultShell: string;
  pathSep: string;
}

export interface AiRequest {
  provider: "ollama" | "openai";
  endpoint: string;
  model: string;
  prompt: string;
  suffix?: string;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  apiKey?: string;
  repeatPenalty?: number;
  raw?: boolean;
  /** AI が一度に読める量（トークン数） */
  numCtx?: number;
  /** CPU だけで動かす */
  cpu?: boolean;
}

export interface AiChunk {
  id: number;
  text: string;
  done: boolean;
  error: string | null;
}

export interface UserExtensionRecord {
  dir: string;
  manifest: unknown;
  mainSource: string | null;
  error: string | null;
}

export const fs = {
  listDir: (path: string) => invoke<DirEntry[]>("fs_list_dir", { path }),
  walk: (root: string, limit?: number) => invoke<string[]>("fs_walk", { root, limit }),
  readFile: (path: string) => invoke<string>("fs_read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("fs_write_file", { path, content }),
  /** 文字コードを指定して（空なら自動で判定して）読む */
  readFileEnc: (path: string, encoding?: string, guess = true) =>
    invoke<{ text: string; encoding: string; bom: boolean; lossy: boolean; eol: "crlf" | "lf" }>("fs_read_file_enc", { path, encoding: encoding ?? null, guess }),
  /** 文字コード・BOM・改行コードを指定して書く */
  writeFileEnc: (path: string, content: string, encoding: string, bom: boolean, eol: "crlf" | "lf") =>
    invoke<void>("fs_write_file_enc", { path, content, encoding, bom, eol }),
  createFile: (path: string) => invoke<void>("fs_create_file", { path }),
  createDir: (path: string) => invoke<void>("fs_create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("fs_rename", { from, to }),
  remove: (path: string) => invoke<void>("fs_remove", { path }),
  exists: (path: string) => invoke<boolean>("fs_exists", { path }),
  isDir: (path: string) => invoke<boolean>("fs_is_dir", { path }),
  /** 文字ではないファイルを書く（中身は base64） */
  writeBase64: (path: string, data: string) => invoke<void>("fsops_extra_write_base64", { path, data }),
  readDataUrl: (path: string) => invoke<string>("fs_read_data_url", { path }),
  search: (opts: { root: string; query: string; regex: boolean; caseSensitive: boolean; wholeWord: boolean; limit?: number }) =>
    invoke<SearchResult>("fs_search", opts),
};

export interface SearchHit {
  path: string;
  line: number;
  col: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  filesSearched: number;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: { path: string; status: string }[];
}

export const git = {
  status: (root: string) => invoke<GitStatus>("git_status", { root }),
};

export const appWindow = {
  async setFullscreen(on: boolean) {
    await getCurrentWindow().setFullscreen(on);
  },
  async isFullscreen() {
    return getCurrentWindow().isFullscreen();
  },
  /** ファイルやフォルダが画面にドラッグされたとき */
  onFileDrop(cb: (e: { type: "enter" | "over" | "drop" | "leave"; paths: string[] }) => void) {
    return getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload as { type: "enter" | "over" | "drop" | "leave"; paths?: string[] };
      cb({ type: p.type, paths: p.paths ?? [] });
    });
  },
  /** 閉じる（閉じる前の確認を通る） */
  async close() {
    await getCurrentWindow().close();
  },
  /** 閉じる前に確認する。handler が false を返すと閉じない */
  onCloseRequested(handler: () => Promise<boolean>) {
    const w = getCurrentWindow();
    return w.onCloseRequested(async (event) => {
      event.preventDefault();
      if (await handler()) await w.destroy();
    });
  },
};

export const dialog = {
  async pickFolder(): Promise<string | null> {
    const r = await open({ directory: true, multiple: false });
    return typeof r === "string" ? r : null;
  },
  async pickImage(): Promise<string | null> {
    const r = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif"] }],
    });
    return typeof r === "string" ? r : null;
  },
  async pickFile(filters: { name: string; extensions: string[] }[]): Promise<string | null> {
    const r = await open({ multiple: false, filters });
    return typeof r === "string" ? r : null;
  },
  async pickExe(): Promise<string | null> {
    const r = await open({ multiple: false, filters: [{ name: "python.exe", extensions: ["exe"] }, { name: "*", extensions: ["*"] }] });
    return typeof r === "string" ? r : null;
  },
  async pickModelFile(): Promise<string | null> {
    const r = await open({ multiple: false, filters: [{ name: "GGUF", extensions: ["gguf"] }] });
    return typeof r === "string" ? r : null;
  },
  async saveFile(defaultPath?: string): Promise<string | null> {
    const r = await save({ defaultPath });
    return typeof r === "string" ? r : null;
  },
};

export const pty = {
  spawn: (opts: { cwd?: string; cols: number; rows: number; shell?: string }) =>
    invoke<number>("pty_spawn", opts),
  write: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
  resize: (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: number) => invoke<void>("pty_kill", { id }),
  shells: () => invoke<{ name: string; command: string }[]>("pty_shells"),
  onData: (cb: (p: { id: number; data: string }) => void) =>
    listen<{ id: number; data: string }>("pty:data", (e) => cb(e.payload)),
  onExit: (cb: (p: { id: number; code: number | null }) => void) =>
    listen<{ id: number; code: number | null }>("pty:exit", (e) => cb(e.payload)),
};

export interface AiDiagnosis {
  reachable: boolean;
  error: string | null;
  version: string | null;
  models: string[];
  modelFound: boolean;
  local: boolean;
}

export interface AiDetected {
  endpoint: string | null;
  models: string[];
  source: "running" | "started" | "usb" | "folder";
  ollamaPath: string | null;
  modelsDir: string | null;
  foundDirs: string[];
  foundGguf: string[];
  error: string | null;
}

export const ai = {
  start: (req: AiRequest) => invoke<number>("ai_complete", { req }),
  cancel: (id: number) => invoke<void>("ai_cancel", { id }),
  models: (provider: string, endpoint: string, apiKey?: string) =>
    invoke<string[]>("ai_models", { provider, endpoint, apiKey }),
  onChunk: (cb: (c: AiChunk) => void) => listen<AiChunk>("ai:chunk", (e) => cb(e.payload)),
  diagnose: (provider: string, endpoint: string, model: string, apiKey?: string) =>
    invoke<AiDiagnosis>("ai_diagnose", { provider, endpoint, model, apiKey }),
  autodetect: (endpoint: string) => invoke<AiDetected>("ai_autodetect", { endpoint }),
  useModelsDir: (dir: string) => invoke<AiDetected>("ai_use_models_dir", { dir }),
  importGguf: (path: string, name: string, endpoint: string) => invoke<string>("ai_import_gguf", { path, name, endpoint }),
};

export const ext = {
  dir: () => invoke<string>("ext_dir"),
  list: () => invoke<UserExtensionRecord[]>("ext_list"),
  install: (from: string) => invoke<string>("ext_install", { from }),
  uninstall: (id: string) => invoke<void>("ext_uninstall", { id }),
};

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  manualOnly: boolean;
  notes: string | null;
  downloadUrl: string | null;
  pageUrl: string;
}

export const updater = {
  check: () => invoke<UpdateInfo>("update_check"),
  install: (url: string) => invoke<void>("update_install", { url }),
  onProgress: (cb: (p: { received: number; total: number }) => void) =>
    listen<{ received: number; total: number }>("update:progress", (e) => cb(e.payload)),
};

export const osIntegration = {
  /** OS から「開いて」と渡されたファイル（受け取ると空になる） */
  takeOpenPaths: () => invoke<string[]>("take_open_paths"),
  onOpenPaths: (cb: () => void) => listen<string[]>("open:paths", () => cb()),
  status: () => invoke<{ supported: boolean; registered: boolean }>("os_integration_status"),
  set: (enabled: boolean) => invoke<void>("os_integration_set", { enabled }),
  /** Windows の「既定のアプリ」の画面を開く */
  openDefaultApps: () => invoke<void>("os_default_apps"),
  /** その種類のファイルで「プログラムから開く」の画面を出す */
  openWith: (ext: string) => invoke<void>("os_open_with", { ext }),
};

export const runtimes = {
  /** 本物の Python を探す（Windows の Store 案内用の見せかけは除く） */
  /** 見つかった Python の一覧（実際に動くものだけ） */
  listPythons: () => invoke<{ command: string; path: string; source: string; version: string }[]>("list_pythons"),
  findPython: () =>
    invoke<{ command: string | null; storeStub: boolean; source: string }>("find_python", { preferred: settings.get("run.pythonPath") || null }),
};

export const tools = {
  /** コンパイラなどを探す（winget で入れた直後でも見つかるように、最新の PATH とよくある場所も見る） */
  find: (names: string[]) => invoke<{ path: string; dir: string; inPath: boolean } | null>("find_tool", { names }),
  /** 画面を出さずに動かして、出力を受け取る（中身は標準入力で渡す） */
  capture: (program: string, args: string[], stdin: string, cwd?: string, timeoutMs?: number) =>
    invoke<{ code: number | null; stdout: string; stderr: string }>("run_capture", { program, args, stdin, cwd: cwd ?? null, timeoutMs: timeoutMs ?? null }),
};

export const clipboardWatch = {
  /** クリップボードの文字が変わったとき（アプリの外でのコピーも） */
  onChange: (cb: (text: string) => void) => listen<string>("clipboard:changed", (e) => cb(e.payload)),
};

export const sys = {
  info: () => invoke<SysInfo>("sys_info"),
  print: () => invoke<void>("print_page"),
  appInfo: () => invoke<{ version: string; tauri: string }>("app_info"),
};
