import { bus } from "./events";

export interface Settings {
  "ui.language": "ja" | "en";
  "ui.theme": string;
  "ui.sidebarWidth": number;
  /** 左のエクスプローラーを細くしすぎたら自動で折りたたむ */
  "ui.sidebarAutoCollapse": boolean;
  /** 左右に並べたときの左の幅（0〜1） */
  "ui.splitRatio": number;
  /** コピー履歴（最近の 10 個） */
  "clip.history": boolean;
  /** 実行の前に、コンパイラなどが入っているか確かめる */
  "run.checkTools": boolean;
  /** 実行の出力が前回と変わったら知らせる */
  "run.notifyChanged": boolean;
  /** 整形に black・gofmt などがあれば使う（オフならあいぞめの中の整形だけ） */
  "editor.externalFormatter": boolean;
  /** 書き出しの設定（前回のもの） */
  "export.options": Record<string, unknown> | null;
  "ui.panelHeight": number;
  "editor.fontSize": number;
  "editor.tabSize": number;
  "editor.wordWrap": boolean;
  "ai.enabled": boolean;
  "ai.provider": "ollama" | "openai";
  "ai.endpoint": string;
  "ai.model": string;
  "ai.debounceMs": number;
  "ai.maxTokens": number;
  "ai.apiKey": string;
  "terminal.shell": string;
  "terminal.fontSize": number;
  "workspace.last": string;
  "workspace.recent": string[];
  "session.files": string[];
  "session.active": string;
  "extensions.disabled": string[];
  "extensions.granted": Record<string, string[]>;

  "look.bgColor": string;
  "look.accentColor": string;
  "look.bgImage": string;
  "look.bgOpacity": number;
  "look.bgBlur": number;
  "look.bgDim": number;
  "look.bgFit": "cover" | "contain" | "tile" | "center";
  "look.zoom": number;
  "editor.fontFamily": string;
  "editor.autoSave": "off" | "delay" | "focus";
  "editor.trimTrailingWhitespace": boolean;
  "editor.insertFinalNewline": boolean;
  "editor.restoreTabs": boolean;
  "editor.lineNumbers": boolean;
  "build.keepComments": boolean;
  "update.autoCheck": boolean;
  "editor.suggestFont": "kyokasho" | "code" | "bizud";
  "editor.explain": "off" | "rules" | "ai";
  "editor.suggestList": "smart" | "off";
  "editor.listKey": "tab" | "enter";
  /** AI の候補（薄い文字）を入れるキー：Tab 2 回か、Tab 1 回か */
  "ai.acceptKey": "rshift" | "double" | "single";
  "editor.zenkaku": boolean;
  /** 行の右に出すもの：説明／値（値を見るの結果）／自動判定（AI の予想）／なし */
  "editor.sideView": "explain" | "values" | "output" | "auto" | "off";
  // ───── 機能のオン・オフ
  /** 実行する場所：ファイルの場所／開いているフォルダ／移動しない（ターミナルの今の場所） */
  "run.cwd": "file" | "workspace" | "terminal";
  /** Python を実行するとき、本物の Python を探して使う（Store 案内用の仮の python を避ける） */
  "run.findPython": boolean;
  /** 使う python.exe の場所（空なら自動で探す） */
  "run.pythonPath": string;
  /** 実行の最後に「終了しました（終了コード）」を出す */
  "run.showFinished": boolean;
  /** 実行の最後にかかった時間を出す */
  "run.showTime": boolean;
  /** 長く動き続けたり、同じ出力をくり返したりしたら知らせる */
  "run.watch": boolean;
  /** 何秒動き続けたら知らせるか */
  "run.watchSeconds": number;
  /** 入力の登録（ファイルごと） */
  "run.inputs": Record<string, { enabled: boolean; text: string }>;
  /** 1 行目の ## py ## で言語を指定できる */
  "files.langDirective": boolean;
  /** 保存するとき 1 行目の ## py ## を取り除く */
  "files.stripDirective": boolean;
  /** 保存前のファイルの言語を中身から推測する */
  "files.guessLanguage": boolean;
  /** ファイルの言語と違う書き方の AI 候補を出さない */
  "ai.languageFilter": boolean;
  /** 複数行の AI 候補を文法で確かめて、崩れた行より後ろを出さない */
  "ai.syntaxTrim": boolean;
  /** グラフィック（GPU）を使わず CPU だけで AI を動かす（メモリが足りないとき用） */
  "ai.cpuOnly": boolean;
  /** 書いている途中の AI の補完（薄い文字）だけを使う／止める（自動判定・説明・チャットはそのまま） */
  "ai.inline": boolean;
  /** ###構築py### の行に「▶ 組み立てる」ボタン */
  "editor.buildLens": boolean;
  /** 変数にマウスを乗せたときの小窓（値・自動判定） */
  "editor.valueHover": boolean;
  /** 自動判定で、Python を裏で安全に動かして本当の値を出す */
  "editor.realValues": boolean;
  /** Shift+クリック・F12 で定義元へ飛ぶ */
  "editor.gotoDefinition": boolean;
  /** インデントを動かしたあと、Tab で下の行もまとめて動かす */
  "editor.indentFollow": boolean;
  /** 書きながら、文法のまちがい・まだ作っていない名前に波線を引く */
  "editor.liveCheck": boolean;
  /** Python は本物の Python でも文法・字下げを確かめる */
  "editor.pythonCheck": boolean;
  /** 書きながら見つけたまちがいを、行の右にも出す */
  "editor.inlineErrors": boolean;
  /** import / using / #include の付け忘れを知らせ、補完から足せるようにする */
  "editor.importHelp": boolean;
  /** 変数にマウスを乗せてから小窓が出るまで（ミリ秒） */
  "editor.hoverDelay": number;
  /** 1 行目の ## py ## の横の「← Python として扱います」 */
  "editor.langTag": boolean;
  /** ターミナルで、選んで Ctrl+C でコピー・Ctrl+V で貼り付け・右クリック */
  "terminal.smartCopy": boolean;
  /** 上の「値を見る」ボタン */
  "ui.traceButton": boolean;
  /** 上の「/ 便利機能」「? ヘルプ」ボタン */
  "ui.topTools": boolean;
  /** 左の「コード辞書」ボタン */
  "ui.dictButton": boolean;
  /** ターミナルの「エラーを日本語で解説」ボタン */
  "ui.errorButton": boolean;
  /** ファイル名の右の「説明／値／自動判定／なし」 */
  "ui.sideSwitch": boolean;
  /** はじめてのチュートリアルを見終わった（スキップした） */
  "ui.tourDone": boolean;
  /** ステータスバーに選んだ文字数 */
  "ui.selectionCount": boolean;
  /** エクスプローラーの「グループ」 */
  "ui.fileGroups": boolean;
  /** エクスプローラーの下の「保存記録」 */
  "ui.saveHistory": boolean;
  "explorer.groups": Record<string, { name: string; files: string[]; open?: boolean }[]>;
  /** エクスプローラーの一覧から外したもの（フォルダごと。ファイルは消さない） */
  "explorer.hidden": Record<string, string[]>;
  "explorer.groupsOpen": boolean;
  "explorer.historyOpen": boolean;
  /** 新しいファイル（保存前）を何語として扱うか（拡張子） */
  "files.newFileLanguage": string;
  /** 新しく保存するファイルの文字コード */
  "files.encoding": "utf-8" | "utf-8-bom" | "shift_jis" | "euc-jp" | "utf-16le";
  /** UTF-8 で読めないファイルを Shift_JIS などとして読む */
  "files.guessEncoding": boolean;
  /** 新しく保存するファイルの改行コード */
  "files.eol": "auto" | "lf" | "crlf";
  "dict.user": { lang: string; title: string; code: string; keys?: string }[];
  "update.skipVersion": string;
}

export const defaults: Settings = {
  "ui.language": "ja",
  "ui.theme": "ai",
  "ui.sidebarWidth": 260,
  "ui.sidebarAutoCollapse": true,
  "ui.splitRatio": 0.5,
  "clip.history": true,
  "run.checkTools": true,
  "run.notifyChanged": true,
  "editor.externalFormatter": true,
  "export.options": null,
  "ui.panelHeight": 240,
  "editor.fontSize": 14,
  "editor.tabSize": 4,
  "editor.wordWrap": false,
  "ai.enabled": true,
  "ai.provider": "ollama",
  "ai.endpoint": "http://127.0.0.1:11434",
  "ai.model": "qwen2.5-coder:1.5b",
  "ai.debounceMs": 300,
  "ai.maxTokens": 96,
  "ai.apiKey": "",
  "terminal.shell": "",
  "terminal.fontSize": 13,
  "workspace.last": "",
  "workspace.recent": [],
  "session.files": [],
  "session.active": "",
  "extensions.disabled": [],
  "extensions.granted": {},

  "look.bgColor": "",
  "look.accentColor": "",
  "look.bgImage": "",
  "look.bgOpacity": 0.74,
  "look.bgBlur": 0,
  "look.bgDim": 0.2,
  "look.bgFit": "cover",
  "look.zoom": 1,
  "editor.fontFamily": "",
  "editor.autoSave": "off",
  "editor.trimTrailingWhitespace": false,
  "editor.insertFinalNewline": true,
  "editor.restoreTabs": true,
  "editor.lineNumbers": true,
  "build.keepComments": true,
  "update.autoCheck": true,
  "editor.suggestFont": "kyokasho",
  "editor.explain": "ai",
  "editor.suggestList": "smart",
  "editor.listKey": "tab",
  "ai.acceptKey": "double",
  "editor.zenkaku": true,
  "editor.sideView": "explain",
  "run.cwd": "file",
  "run.findPython": true,
  "run.pythonPath": "",
  "run.showFinished": true,
  "run.showTime": true,
  "run.watch": true,
  "run.watchSeconds": 15,
  "run.inputs": {},
  "files.langDirective": true,
  "files.stripDirective": true,
  "files.guessLanguage": true,
  "ai.languageFilter": true,
  "ai.syntaxTrim": true,
  "ai.cpuOnly": false,
  "ai.inline": true,
  "editor.buildLens": true,
  "editor.valueHover": true,
  "editor.realValues": true,
  "editor.gotoDefinition": true,
  "editor.indentFollow": true,
  "editor.liveCheck": true,
  "editor.pythonCheck": true,
  "editor.inlineErrors": true,
  "editor.importHelp": true,
  "editor.hoverDelay": 250,
  "editor.langTag": true,
  "terminal.smartCopy": true,
  "ui.traceButton": true,
  "ui.topTools": true,
  "ui.dictButton": true,
  "ui.errorButton": true,
  "ui.sideSwitch": true,
  "ui.tourDone": false,
  "ui.selectionCount": true,
  "ui.fileGroups": true,
  "ui.saveHistory": true,
  "explorer.groups": {},
  "explorer.hidden": {},
  "explorer.groupsOpen": true,
  "explorer.historyOpen": true,
  "files.newFileLanguage": ".py",
  "files.encoding": "utf-8",
  "files.guessEncoding": true,
  "files.eol": "lf",
  "dict.user": [],
  "update.skipVersion": "",
};

const STORAGE_KEY = "aizome.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>;
      // 前は、変えていない設定も既定値ごと保存していた。そのため既定値を変えても（AI の候補を入れるキー：
      // Tab 2 回 → 右 Shift など）前の値のままになっていた。前のころの既定値は 1 回だけ消して、今の既定値にする
      if (!saved["_v"]) {
        for (const k of Object.keys(saved)) if (k in defaults && JSON.stringify(saved[k]) === JSON.stringify(defaults[k as keyof Settings])) delete saved[k];
      }
      delete saved["_v"];
      return { ...defaults, ...saved };
    }
  } catch {
    /* 読めなければ既定値で起動する */
  }
  return { ...defaults };
}

const current: Settings = load();

function persist() {
  try {
    // 既定値と同じものは保存しない（あとで既定値が変わったら、そちらに合わせる）
    const diff: Record<string, unknown> = { _v: 2 };
    for (const [k, v] of Object.entries(current)) if (JSON.stringify(v) !== JSON.stringify(defaults[k as keyof Settings])) diff[k] = v;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(diff));
  } catch {
    /* 保存できない環境では今回の起動中だけ有効 */
  }
}

export const settings = {
  get<K extends keyof Settings>(key: K): Settings[K] {
    return current[key];
  },
  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    current[key] = value;
    persist();
    bus.emit("settings:changed", { key });
  },
  all(): Readonly<Settings> {
    return current;
  },
};
