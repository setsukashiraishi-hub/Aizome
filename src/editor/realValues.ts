// 自動判定で、変数にマウスを乗せたときの「本当の値」。
// 1. 前に「値を見る（F6）」で実行した記録（その実行のあとに書きかえていない行だけ）
// 2. Python は裏で安全に動かした記録（src/run/sandbox.ts）
// どちらも「その行の時点の値」を、記録から探して返す。決まらなければ null（AI などの予想にまかせる）
import { seqText, type TraceResult } from "../run/trace";
import type { SandboxStop } from "../run/sandbox";
import { assignTargets } from "../ai/infer";

// ───────── 前の実行（F6）の記録をタブごとに覚えておく（書きかえても消さない）

const lastRuns = new Map<string, { raw: TraceResult; text: string }>();

export function setLastRun(docId: string, raw: TraceResult, text: string) {
  lastRuns.set(docId, { raw, text });
}

export function lastRunFor(docId: string): { raw: TraceResult; text: string } | null {
  return lastRuns.get(docId) ?? null;
}

// ───────── 書きかえていない行を、前の行番号に対応させる

const mapCache = new Map<string, (number | null)[]>();

/**
 * 今の行 → 実行したときの行（書きかえた行・足した行は null）。
 * 行ごとの最長共通部分で対応させる（前後の同じ部分は先に除く）
 */
export function unchangedLineMap(oldText: string, newText: string): (number | null)[] {
  const key = oldText.length + ":" + newText.length + ":" + hash(oldText) + ":" + hash(newText);
  const hit = mapCache.get(key);
  if (hit) return hit;
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const map: (number | null)[] = new Array(b.length + 1).fill(null);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    map[pre + 1] = pre + 1;
    pre++;
  }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    map[b.length - suf] = a.length - suf;
    suf++;
  }
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length && bm.length && am.length * bm.length <= 4_000_000) {
    // 最長共通部分（LCS）の表
    const n = am.length;
    const m = bm.length;
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        map[pre + j + 1] = pre + i + 1;
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
  }
  mapCache.set(key, map);
  while (mapCache.size > 20) mapCache.delete(mapCache.keys().next().value as string);
  return map;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ───────── 記録から、その行の時点の値を探す

export type RealValue =
  | { value: string; from: number }
  /** 入力（input・sys.argv）の前で止めたので、まだ決まらない */
  | { pending: true; at: number | null };

const BLANK_OR_COMMENT = /^\s*(#.*|\/\/.*|--.*)?$/;

function indentOf(s: string): number {
  return /^[ \t]*/.exec(s)![0].replace(/\t/g, "    ").length;
}

/**
 * 実行したあとに、どの行から先の記録が古くなったか（今の行番号）。古くなっていなければ lines.length + 1。
 * - 書きかえた・足した・消した行のうち、最初の行（空行・コメントだけの変更は数えない）
 * - それがループの中なら、いちばん外のループの行から（2 回目からの値が変わるため）
 * - 関数・クラスの中なら 1（どこから呼ばれているかわからないため）
 */
export function firstSemanticEdit(oldText: string, newText: string, map: (number | null)[]): number {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let edit = b.length + 1;
  let prev = 0;
  for (let l = 1; l <= b.length; l++) {
    const o = map[l] ?? null;
    if (o === null) {
      if (BLANK_OR_COMMENT.test(b[l - 1])) continue;
      edit = l;
      break;
    }
    // 間の行が消されている
    if (o !== prev + 1 && a.slice(prev, o - 1).some((t) => !BLANK_OR_COMMENT.test(t))) {
      edit = l;
      break;
    }
    prev = o;
  }
  if (edit > b.length) return edit;
  // 書きかえた行を囲むブロック（字下げで判断）
  let cur = indentOf(b[edit - 1] ?? "");
  let start = edit;
  for (let i = edit - 1; i >= 1 && cur > 0; i--) {
    const t = b[i - 1];
    if (BLANK_OR_COMMENT.test(t)) continue;
    const ind = indentOf(t);
    if (ind >= cur) continue;
    cur = ind;
    if (/^\s*(for|while|do)\b/.test(t)) {
      start = i;
      continue;
    }
    if (/^\s*(if|elif|else|switch|case|try|except|catch|finally|with|match)\b/.test(t)) continue;
    // main は 1 回だけ動く本体なので、その中は上から順に考えてよい
    if (/\bmain\s*\(/.test(t)) continue;
    // 関数・クラス（Python・JavaScript・Go・Rust・C・Java・C# など）
    if (/^\s*(async\s+)?(def|class|function|func|fn|struct|interface|impl)\b|^\s*(public|private|protected|static|internal)\b|^\s*[\w<>\[\]*&:,]+(\s+[\w<>\[\]*&:,]+)*\s+\w+\s*\([^;]*\)\s*(\{|=>)?\s*$/.test(t)) return 1;
  }
  return start;
}

export interface LookupOptions {
  /** 今の行 → 記録の行（書きかえた行は null）。省略すると同じ番号 */
  map?: (number | null)[];
  /** この行（今の行番号）から先の記録は古いので使わない */
  validBefore?: number;
  /** 途中で止まった実行なら、その理由と行（記録の行番号） */
  stop?: SandboxStop | null;
}

/** 記録の中の、その行での name の値（回ごと）。変わった値（c）、変わらなかったときに使った値（r）の順 */
function valuesAt(trace: TraceResult, line: number, name: string): { values: string[]; n: number } | null {
  const e = trace.lines[String(line)];
  if (!e) return null;
  const values: string[] = [];
  for (const r of e.recs) {
    const v = r.c[name] ?? r.r[name];
    if (v !== undefined) values.push(v);
  }
  if (!values.length) return null;
  // 記録しきれなかった回があるときは、本当の回数を出す
  return { values, n: values.length === e.recs.length ? e.n : values.length };
}

/**
 * lines（今のコード）の lineNo 行目の時点の name の値。
 * - その行の記録があればそれ（くり返しの中なら「1 → 3 → 6（3 回）」）
 * - なければ上の行へさかのぼって、最後に値が入った行の値
 * - 書きかえた行で name に値を入れていたら、記録は古いので null
 * - 止めた行より後で name に値を入れる行があれば、入力しだい（pending）
 */
export function lookupRealValue(trace: TraceResult, lines: string[], name: string, lineNo: number, opts: LookupOptions = {}): RealValue | null {
  const orig = (l: number): number | null => (opts.map ? (opts.map[l] ?? null) : l);
  const assigns = new Set(assignTargets(lines, 100000).filter((t) => t.name === name).map((t) => t.line));
  const stopLine = opts.stop && (opts.stop.kind === "input" || opts.stop.kind === "argv") ? opts.stop.line : null;
  const stopped = !!opts.stop;
  // その行が何回動いたか（くり返しの中なら値を並べる）
  const hoverOrig = orig(lineNo);
  const hoverRuns = hoverOrig !== null ? (trace.lines[String(hoverOrig)]?.n ?? 0) : 0;
  for (let l = lineNo; l >= 1; l--) {
    const o = orig(l);
    if (o === null) {
      // 書きかえた行：そこで値を入れたり中身を変えたりしているなら、記録の値はもう古い
      if (assigns.has(l) || new RegExp(`\\b${name}\\s*(\\.\\w+\\s*\\(|\\[[^\\]]*\\]\\s*[-+*/%]?=(?!=))|\\bdel\\s+${name}\\b`).test(lines[l - 1] ?? "")) return null;
      continue;
    }
    // 止めた行（input() の行）か、それより後で値を入れる行：入力しだいで変わる
    if (stopLine !== null && o >= stopLine && assigns.has(l)) return { pending: true, at: stopLine };
    const at = valuesAt(trace, o, name);
    // 書きかえた所より後の行の記録は、もう古いかもしれない
    if (at && opts.validBefore !== undefined && l >= opts.validBefore) return null;
    if (at) {
      const many = hoverRuns > 1 || l === lineNo;
      const value = many && at.values.length > 1 ? seqText(at.values, at.n) : at.values[at.values.length - 1];
      return { value, from: l };
    }
    // 動かなかった行で値を入れている
    if (assigns.has(l) && !trace.lines[String(o)]) {
      // 途中で止まった（時間切れ・エラー）ときは、その先はわからない
      if (stopped && opts.stop!.line !== null && o > opts.stop!.line) return null;
      // 最後まで動いて通らなかった行（if の別の道など）は飛ばす
    }
  }
  // 見つからない：入力の前で止めていて、この行がそれより後なら、入力しだい
  if (stopLine !== null && hoverOrig !== null && hoverOrig >= stopLine) return { pending: true, at: stopLine };
  return null;
}

/** 前の実行（F6）の記録から、今のコードの lineNo 行目の時点の値（書きかえで古くなったものは使わない） */
export function lookupLastRun(run: { raw: TraceResult; text: string }, lines: string[], name: string, lineNo: number): RealValue | null {
  const text = lines.join("\n");
  const same = run.text === text;
  const map = same ? undefined : unchangedLineMap(run.text, text);
  const validBefore = map ? firstSemanticEdit(run.text, text, map) : undefined;
  const errLine = run.raw.error?.line ?? null;
  return lookupRealValue(run.raw, lines, name, lineNo, { map, validBefore, stop: errLine ? { kind: "error", line: errLine } : null });
}
