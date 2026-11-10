// 自動判定モード：実行せずに、変数に何が入るかとエラーになりそうな行を予想する（画面に依存しない部分）
import { jaReason } from "./jaError";
import { languageOf } from "./plan";
import { splitTop } from "./exprJa";

export interface InferVar {
  line: number;
  name: string;
  value: string;
}

export interface InferRisk {
  line: number;
  reason: string;
}

export interface InferResult {
  vars: InferVar[];
  risks: InferRisk[];
}

const MAX_LINES = 300;

/** 名前ではないもの（型・キーワード）。「int x = 1」の int などを変数とまちがえないため */
const NOT_NAME = /^(if|elif|else|while|for|return|yield|await|async|def|class|function|fn|func|import|from|as|with|in|of|not|and|or|is|new|delete|typeof|case|switch|do|try|except|catch|finally|throw|raise|lambda|pass|break|continue|global|nonlocal|let|const|var|final|static|auto|mut|val|public|private|protected|int|long|short|float|double|char|bool|boolean|byte|void|string|String|unsigned|signed|size_t|struct|enum|self|this|None|True|False|null|true|false|nil|undefined)$/;

const FOR_PY = /^\s*(?:async\s+)?for\s+(.+?)\s+in\s+/;
const FOR_C = /^\s*for\s*\(\s*(?:(?:let|const|var|auto|final|[A-Za-z_][\w.]*(?:<[^>]*>)?(?:\[\])*\*?)\s+)?([A-Za-z_]\w*)\s*(?:=|:|\bof\b|\bin\b)/;
const FOR_GO = /^\s*for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)?)\s*:=/;
const VAR_GO = /^\s*var\s+([A-Za-z_]\w*)\s+[\w.\[\]*]+\s*=/;
const ASSIGN_ANY = /^\s*(?:(?:let|const|var|final|static|auto|mut|val|my|local|[A-Za-z_][\w.]*(?:<[^>]*>)?(?:\[\])*\*?)\s+)*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::\s*[^=:]+?)?\s*(?::=|\+=|-=|\*=|\/=|\/\/=|%=|\*\*=|=)(?![=>])/;
const INC_DEC = /^\s*([A-Za-z_]\w*)\s*(?:\+\+|--)\s*;?\s*$/;
const WITH_AS = /\bas\s+([A-Za-z_]\w*)\s*:\s*$/;

/**
 * 変数に値が入る（変わる）行と、その変数の名前。AI にはこの一覧の値を埋めてもらう。
 * 例：「a = []」「total += i」「let x = 1」「int n = 5」「for i in range(5)」「for (let i = 0; …)」
 */
export function assignTargets(lines: string[], max = 80): { line: number; name: string }[] {
  const out: { line: number; name: string }[] = [];
  const add = (line: number, names: string) => {
    for (const raw of names.split(",")) {
      const name = raw.replace(/[()\[\]\s]/g, "");
      if (!/^[A-Za-z_]\w*$/.test(name) || NOT_NAME.test(name) || name === "_") continue;
      if (!out.some((o) => o.line === line && o.name === name)) out.push({ line, name });
    }
  };
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const text = lines[i];
    if (/^\s*(#|\/\/|\/\*|\*|--)/.test(text)) continue;
    const n = i + 1;
    let m: RegExpExecArray | null;
    if ((m = FOR_GO.exec(text))) add(n, m[1]);
    else if ((m = FOR_C.exec(text))) add(n, m[1]);
    else if ((m = FOR_PY.exec(text))) add(n, m[1]);
    else if ((m = VAR_GO.exec(text))) add(n, m[1]);
    else if ((m = INC_DEC.exec(text))) add(n, m[1]);
    else if ((m = ASSIGN_ANY.exec(text))) add(n, m[1]);
    else if ((m = WITH_AS.exec(text))) add(n, m[1]);
  }
  return out.slice(0, max);
}

/**
 * 自動判定で AI に送る指示の「お手本」。コード・値が入る行の一覧・答えを一組で見せる。
 * 答えだけを見せると、小さいモデルはコードを読まずにその答えを写してしまう。
 * 一覧だけを見せると、値を書かずに一覧を写して終わってしまう。
 */
const EXAMPLE_CODE = ["1: x = 3", "2: s = 0", "3: for k in range(x):", "4:     s += k", "5: w = input()"];
const EXAMPLE_LIST = ["V|1|x|", "V|2|s|", "V|3|k|", "V|4|s|", "V|5|w|"];
const EXAMPLE_ANSWER = ["V|1|x|3", "V|2|s|0", "V|3|k|0 → 1 → 2", "V|4|s|0 → 1 → 3", "V|5|w|ユーザーの入力（文字列）"];
/** お手本の答えを写しただけの行（読み取るときに捨てる） */
const EXAMPLE_ROWS = new Set(EXAMPLE_ANSWER.map((r) => r.replace(/\s/g, "")));

/**
 * 自動判定で AI に送る指示。
 * 値が入る行はこちらで拾って一覧にし、お手本と同じ形で「| のあとを埋めて」と頼む。
 */
export function buildInferPrompt(code: string, filename: string, known: Map<string, string> = new Map()): string {
  const lang = languageOf(filename) || "プログラム";
  const lines = code.split("\n").slice(0, MAX_LINES);
  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
  const targets = assignTargets(lines);
  // 実際に計算してわかった値は、はじめから書いておく（AI はそれをもとに、空いている行だけ考えればよい）
  const filled = (t: { line: number; name: string }) => {
    const v = known.get(`${t.line}|${t.name}`);
    return v === undefined ? "" : v.length > 80 ? v.slice(0, 79) + "…" : v;
  };
  const list = targets.length ? targets.map((t) => `V|${t.line}|${t.name}|${filled(t)}`) : ["（値が入る行は自分で探して、同じ形で書く）"];
  const hasKnown = targets.some((t) => filled(t));
  return [
    `${lang} のコードを、実行せずに読んで考えてください。`,
    "",
    "1. 「一覧」の各行の最後の | のあとに、その行を実行したあとの変数の値を書きたす。",
    ...(hasKnown ? ["   - 一覧で値がもう書いてある行は、実際に計算した確かな値。そのまま写し、空いている行は、その値をもとに考えて埋める。"] : []),
    "   - くり返しの中で変わる値は、変わる順に → でつなぐ。リストなどは最後の中身を書く。",
    "   - input() などで受け取る値は「ユーザーの入力（整数）」、ファイルや通信から読む値は「ファイルの内容（文字列のリスト）」のように書く。入力から計算できるなら「n * 2（n はユーザーの入力）」のような式で書く。",
    "   - 本当に None・null が入るときだけ None と書く。値がわからない行は、その行ごと書かない。",
    "2. 実行するとエラーになりそうな行があれば「E|行番号|エラーの名前：原因」の形で書く（原因は 30 文字くらい、必ず日本語）。なければ E の行は書かない。",
    "   - 本当に実行するとエラーになるものだけ。書き方の好み・字下げ（Python 以外では字下げはエラーにならない）・正しい書式（%T %t %d など）は書かない。",
    "",
    "答えは V の行と E の行だけにしてください。前置きや説明の文章は書かないでください。",
    "",
    "【お手本】",
    "コード：",
    ...EXAMPLE_CODE,
    "一覧：",
    ...EXAMPLE_LIST,
    "答え：",
    ...EXAMPLE_ANSWER,
    "",
    "【本番】（お手本の答えは写さず、このコードを読んで答える）",
    "コード：",
    numbered,
    "一覧：",
    ...list,
    "答え：",
  ].join("\n");
}

/** 指示の中の言い回しを写しただけの値 */
const PLACEHOLDER_VALUE = /^(値|最初の値 → 次の値 → … → 最後の値|その行を実行したあとの(変数の)?値|…+|\.\.\.)$/;

const V_LINE = /^\s*V\s*[|｜]\s*(\d+)\s*[|｜]\s*([A-Za-z_][\w.]*(?:\[[^\]]*\])?)\s*[|｜]\s*(.+?)\s*$/;
const E_LINE = /^\s*E\s*[|｜]\s*(\d+)\s*[|｜]\s*(.+?)\s*$/;

export function parseInfer(answer: string, lineCount: number, lang: string | null = null): InferResult {
  const vars: InferVar[] = [];
  const risks: InferRisk[] = [];
  for (const row of answer.split("\n")) {
    if (EXAMPLE_ROWS.has(row.replace(/\s/g, ""))) continue;
    const v = V_LINE.exec(row);
    if (v) {
      const line = Number(v[1]);
      // 指示の文をそのまま写しただけの値は使わない
      if (line >= 1 && line <= lineCount && !PLACEHOLDER_VALUE.test(v[3])) vars.push({ line, name: v[2], value: v[3].slice(0, 160) });
      continue;
    }
    const e = E_LINE.exec(row);
    if (e) {
      const line = Number(e[1]);
      if (line >= 1 && line <= lineCount && !/^(なし|特になし|none)$/i.test(e[2])) risks.push({ line, reason: jaReason(e[2], lang).slice(0, 90) });
    }
  }
  return { vars, risks };
}

/** その行の時点で、その変数に入っている（と AI が予想した）値 */
/** AI が「わからない」ときに書きがちな値（None と書いてくることが多い） */
const UNKNOWN_VALUE = /^[\s「『"']*(none|null|nil|undefined|unknown|不明|わからない|わかりません|未定|\?+|-+|なし)[\s」』"']*$/i;

/**
 * その行の時点で、その変数に入っている（と AI が予想した）値。
 * lines（コードの各行）を渡すと、あやしい予想を除く：
 * - 値が「None」「不明」なのに、その行で None を入れていない（小さいモデルは、わからないと None と書く）
 * - その行にその変数が出てこない（行番号のずれ）
 */
export function lookupInferred(result: InferResult | null, name: string, line: number, lines?: string[]): { value: string; from: number } | { later: number } | { unknown: number } | null {
  if (!result) return null;
  let unknownAt = 0;
  const word = new RegExp(`(^|[^\\w.])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const hits = result.vars.filter((v) => {
    if (v.name !== name && v.name.split(/[.[]/)[0] !== name) return false;
    if (!lines) return true;
    const text = lines[v.line - 1] ?? "";
    if (!word.test(text)) return false;
    if (UNKNOWN_VALUE.test(v.value) && !/\b(None|null|nil|undefined)\b/.test(text)) {
      if (v.line <= line) unknownAt = Math.max(unknownAt, v.line);
      return false;
    }
    return true;
  });
  // AI が「わからない」と答えた（その後に値の予想もない）
  if (unknownAt && !hits.some((v) => v.line <= line && v.line >= unknownAt)) return { unknown: unknownAt };
  if (!hits.length) return null;
  const before = hits.filter((v) => v.line <= line).sort((a, b) => b.line - a.line)[0];
  if (before) return { value: before.value, from: before.line };
  return { later: Math.min(...hits.map((v) => v.line)) };
}

const ASSIGN = (name: string) => new RegExp(`^\\s*(?:for\\s+(?:[\\w\\s,]*\\b)?${name}\\b[\\w\\s,]*\\s+in\\s+(.+?):|(?:[\\w\\s,]*\\b)?${name}\\b\\s*(?:[,\\w\\s]*)?(=|\\+=|-=|\\*=|/=)(?!=)\\s*(.+)|with\\s+.+\\s+as\\s+${name}\\s*:)`);

/**
 * AI の予想がまだないときの、コードから読み取れる範囲の見当（実行はしない）。
 * 例：a = [] → 「[]」、n = int(input()) → 「ユーザーの入力に依存」、for i in range(10) → 「range(10) の値を順に」
 */
export function staticGuess(lines: string[], name: string, line: number): string | null {
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  const re = ASSIGN(name);
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const text = lines[i].replace(/#.*$/, "");
    const m = re.exec(text);
    if (!m) continue;
    if (m[1]) {
      const iter = m[1].trim();
      const r = /^range\((.+)\)$/.exec(iter);
      if (r) {
        const args = r[1].split(",").map((s) => s.trim());
        const from = args.length > 1 ? args[0] : "0";
        const to = args.length > 1 ? args[1] : args[0];
        return `${from} から ${/^\d+$/.test(to) ? Number(to) - 1 : `${to} - 1`} まで順に（${i + 1} 行目の for）`;
      }
      return `${iter} の中身を 1 つずつ（${i + 1} 行目の for）`;
    }
    if (/with\s+/.test(text) && /open\(/.test(text)) return `ファイル（${i + 1} 行目で開いたもの）`;
    const op = m[2];
    const rhs = (m[3] ?? "").trim();
    if (/\binput\s*\(/.test(rhs)) {
      const kind = /^int\(/.test(rhs) ? "整数" : /^float\(/.test(rhs) ? "小数" : /split\(/.test(rhs) ? "区切った文字列のリスト" : "文字列";
      return `ユーザーの入力に依存（${kind}・${i + 1} 行目）`;
    }
    if (/\bopen\s*\(|\.read(lines)?\s*\(|csv\.reader|json\.load|requests\./.test(rhs)) return `ファイル・通信の内容に依存（${i + 1} 行目）`;
    if (/\brandom\./.test(rhs)) return `ランダム（${rhs}・${i + 1} 行目）`;
    if (op !== "=") return `${name} ${op} ${rhs}（${i + 1} 行目で更新）・いくつになるかは、実行しないとわかりません`;
    // 数・文字・True などそのままの値ならそれを、式なら「その結果」と、わからないことを伝える
    if (/^(-?\d+(\.\d+)?|True|False|None|null|true|false|(["'])(?:\\.|(?!\3).)*\3|\[[^\]]*\]|\{[^}]*\}|\([^()]*\))$/.test(rhs)) return `${rhs}（${i + 1} 行目で代入）`;
    return `${rhs} の結果（${i + 1} 行目で代入）・実際の値は、実行しないとわかりません`;
  }
  return null;
}

/** 文字列のかんたんなハッシュ（同じコードなら AI に聞き直さない） */
export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + s.length;
}

/**
 * AI（小さいモデル）がよくまちがえる「エラーになりそう」を除く。
 * - Python 以外で、字下げ（タブと空白がまざっている など）をエラーと言う
 * - printf の書式（%T %t %d …）と値の数が合っているのに、書式のまちがいと言う
 */
export function implausibleRisk(lineText: string, reason: string, lang: string | null): boolean {
  if (lang !== "python" && /インデント|字下げ|indent|タブ|空白|スペース/i.test(reason)) return true;
  const m = /\b(?:printf|Printf|Sprintf|Fprintf|Errorf|Fatalf|Panicf|Logf|format|String\.format)\s*\((.*)\)\s*;?\s*$/.exec(lineText.trim());
  if (m && /書式|フォーマット|format|%|型|verb|Printf/i.test(reason)) {
    const args = splitTop(m[1]);
    // Fprintf(os.Stdout, "…", …) は 2 つ目が書式
    const fi = args.findIndex((a) => /^\s*["`]/.test(a));
    if (fi >= 0) {
      const fmt = args[fi];
      const verbs = (fmt.replace(/%%/g, "").match(/%[-+#0 ]*(\d+|\*)?(\.\d*)?(?:hh|h|ll|l|L|z|j)?[a-zA-Z]/g) ?? []).length;
      if (verbs === args.length - fi - 1) return true;
    }
  }
  return false;
}
