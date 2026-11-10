// ターミナルの Tab 補完（AI は使わない）。
// cmd や PowerShell がもともと補完できない「コマンドの続き」（pip ins → install、uv → venv など）を補う。
// ファイル名などここで決められないものは、シェル自身の補完にまかせる（null を返す）

export type ShellKind = "cmd" | "powershell" | "other";

interface Cand {
  word: string;
  desc: string;
}

const c = (word: string, desc: string): Cand => ({ word, desc });

const PIP: Cand[] = [
  c("install", "ライブラリを入れる"),
  c("uninstall", "ライブラリを消す"),
  c("list", "入っているライブラリの一覧"),
  c("freeze", "requirements.txt の形で一覧"),
  c("show", "ライブラリのくわしい情報"),
  c("--version", "pip の版"),
];
const PIP_INSTALL_OPTS: Cand[] = [
  c("--proxy=", "プロキシを通す（例：--proxy=147.157.2.20:8080）"),
  c("-r", "requirements.txt から入れる"),
  c("--upgrade", "新しい版にする"),
  c("--user", "自分のユーザーだけに入れる"),
];
const UV: Cand[] = [
  c("pip", "pip と同じ使い方（uv pip install …）"),
  c("venv", "仮想環境を作る"),
  c("run", "仮想環境で動かす"),
  c("init", "プロジェクトを作る"),
  c("add", "ライブラリを足す（プロジェクト）"),
  c("remove", "ライブラリを外す（プロジェクト）"),
  c("sync", "ライブラリをそろえる"),
  c("python", "Python の版を入れる・選ぶ"),
  c("--version", "uv の版"),
];
const UV_PIP: Cand[] = [...PIP.filter((x) => x.word !== "--version"), c("compile", "requirements.txt を作る"), c("sync", "requirements.txt にそろえる")];
const PYTHON: Cand[] = [c("-m", "モジュールとして動かす（-m pip、-m venv）"), c("-c", "その場で 1 行動かす"), c("--version", "Python の版"), c("-V", "Python の版")];
const PY_MODULES: Cand[] = [
  c("pip", "ライブラリを入れる・消す"),
  c("venv", "仮想環境を作る（python -m venv 名前）"),
  c("http.server", "このフォルダを Web で見せる"),
  c("json.tool", "JSON を見やすく"),
  c("idlelib", "IDLE を開く"),
];
const GIT: Cand[] = ["status", "add", "commit", "push", "pull", "clone", "checkout", "switch", "branch", "log", "diff", "init", "restore", "stash", "merge", "fetch", "remote"].map((w) => c(w, ""));

const CMD_BUILTINS: Cand[] = [
  c("cd", "フォルダを移る"),
  c("cls", "画面を消す"),
  c("dir", "ファイルの一覧"),
  c("mkdir", "フォルダを作る"),
  c("rmdir", "フォルダを消す"),
  c("copy", "ファイルをコピー"),
  c("move", "ファイルを動かす"),
  c("del", "ファイルを消す"),
  c("ren", "名前を変える"),
  c("type", "ファイルの中身を見る"),
  c("echo", "文字を出す"),
  c("set", "環境変数を見る・決める"),
  c("where", "コマンドの場所を探す"),
  c("tree", "フォルダの木"),
  c("exit", "閉じる"),
  c("python", "Python"),
  c("py", "Python ランチャー"),
  c("pip", "ライブラリを入れる"),
  c("uv", "速い pip・仮想環境"),
  c("git", "Git"),
  c("deactivate", "仮想環境を抜ける"),
];
const PS_EXTRA: Cand[] = [
  c("python", "Python"),
  c("py", "Python ランチャー"),
  c("pip", "ライブラリを入れる"),
  c("uv", "速い pip・仮想環境"),
  c("git", "Git"),
  c("deactivate", "仮想環境を抜ける"),
  c("cls", "画面を消す"),
  c("Set-ExecutionPolicy", "スクリプトの実行を許す（-Scope Process Bypass）"),
];
const ENV_NAMES: Cand[] = [c("HTTPS_PROXY", "プロキシ（https）"), c("HTTP_PROXY", "プロキシ（http）"), c("PATH", "コマンドを探す場所"), c("PYTHONIOENCODING", "Python の文字コード")];

export interface Completion {
  /** 今の言葉のうち、すでに打った部分（これを置きかえる） */
  prefix: string;
  /** 候補（1 つだけなら、そのまま入れる） */
  choices: Cand[];
  /** 候補に共通する、まだ打っていない部分 */
  common: string;
  /** 1 つに決まったときに続けて入れる文字（空白など）。「--proxy=」のように = や : で終わる候補には付けない */
  after: string;
}

/** 入力中の行（プロンプトのうしろ）から、Tab で入れる候補を決める。決められなければ null（シェルにまかせる） */
export function completeLine(input: string, shell: ShellKind): Completion | null {
  if (shell === "other") return null;
  // 引用符の中は、ファイル名などなのでシェルにまかせる
  if ((input.match(/"/g) ?? []).length % 2 === 1) return null;
  const words = input.trimStart().split(/\s+/);
  const prefix = words[words.length - 1] ?? "";
  const before = words.slice(0, -1).map((w) => w.toLowerCase().replace(/\.exe$/, ""));
  // パスを打っているときはシェルにまかせる
  if (/[\\/:.]/.test(prefix) && !/^-/.test(prefix) && !/^\$env:/i.test(prefix)) return null;

  let list: Cand[] | null = null;
  let after = " ";
  const head = before[0];
  // PowerShell の環境変数：$env:HTT → $env:HTTPS_PROXY
  if (shell === "powershell" && /^\$env:/i.test(prefix)) {
    const name = prefix.slice(5);
    const hits = ENV_NAMES.filter((x) => x.word.toLowerCase().startsWith(name.toLowerCase()));
    return finish("$env:", name, hits, ' = "', prefix);
  }
  if (!before.length) {
    list = shell === "cmd" ? CMD_BUILTINS : PS_EXTRA;
    // PowerShell のコマンド名（Get-… など）は PowerShell のほうがくわしいので、ここで決まらなければまかせる
  } else if (shell === "cmd" && head === "set" && before.length === 1) {
    list = ENV_NAMES;
    after = "=";
  } else if (head === "uv" && before[1] === "pip" && before.length === 2) {
    list = UV_PIP;
  } else if (head === "uv" && before.length === 1) {
    list = UV;
  } else if ((head === "python" || head === "python3" || head === "py") && before[before.length - 1] === "-m") {
    list = PY_MODULES;
  } else if ((head === "python" || head === "python3" || head === "py") && before.length === 1 && prefix.startsWith("-")) {
    list = PYTHON;
  } else if (head === "git" && before.length === 1) {
    list = GIT;
  } else if (isPipCommand(before) && pipSub(before) === null) {
    list = PIP;
  } else if (isPipCommand(before) && pipSub(before) === "install" && prefix.startsWith("-")) {
    list = PIP_INSTALL_OPTS;
  }
  if (!list) return null;
  const hits = list.filter((x) => x.word.toLowerCase().startsWith(prefix.toLowerCase()));
  if (!hits.length) return null;
  return finish("", prefix, hits, after, prefix);
}

/** pip install … / python -m pip install … / uv pip install … のどれか */
function isPipCommand(before: string[]): boolean {
  return before.some((w, i) => w === "pip" || w === "pip3" || (w === "-m" && before[i + 1] === "pip"));
}

/** pip のうしろの命令（install など）。まだなければ null */
function pipSub(before: string[]): string | null {
  const i = before.findIndex((w) => w === "pip" || w === "pip3");
  return before[i + 1] ?? null;
}

function finish(lead: string, typed: string, hits: Cand[], after: string, prefix: string): Completion | null {
  if (!hits.length) return null;
  // 打った文字と同じ大文字・小文字で、共通する部分を出す
  let common = hits[0].word;
  for (const h of hits.slice(1)) {
    let i = 0;
    while (i < common.length && i < h.word.length && common[i].toLowerCase() === h.word[i].toLowerCase()) i++;
    common = common.slice(0, i);
  }
  const rest = common.length > typed.length ? common.slice(typed.length) : "";
  return { prefix, choices: hits.map((h) => ({ word: lead + h.word, desc: h.desc })), common: rest, after };
}

/** 候補を 1 つ選んだときに、そのうしろに入れる文字 */
export function afterFor(c: Completion, word: string): string {
  return /[=:]$/.test(word) ? "" : c.after;
}

/** 画面の 1 行から、プロンプト（C:\…> や PS C:\…> ）のうしろの入力を取り出す。プロンプトがなければ null */
export function inputAfterPrompt(lineText: string): string | null {
  const ps = /^PS [^>]*> ?/.exec(lineText);
  if (ps) return lineText.slice(ps[0].length);
  const cmd = /^(?:\([^)]*\) )?[A-Za-z]:\\[^>]*>/.exec(lineText);
  if (cmd) return lineText.slice(cmd[0].length);
  // 仮想環境に入っているとき：(venv) PS C:\…>
  const venvPs = /^\([^)]*\) PS [^>]*> ?/.exec(lineText);
  if (venvPs) return lineText.slice(venvPs[0].length);
  return null;
}
