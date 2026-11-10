// 自動判定で、変数にマウスを乗せたときに出す値と、その出どころ。
// 順番：前の実行（F6）→ 実際に計算（Python を裏で動かす）→ 上から計算した予想（simulate）→ AI の予想 → 書き方からの見当 → わかりません
// CodeMirror に頼らない形にしてあるので、node からそのまま試せる
import { lookupInferred, staticGuess, type InferResult } from "../ai/infer";
import { simulateValue } from "../ai/simulate";
import type { SandboxResult } from "../run/sandbox";
import type { TraceResult } from "../run/trace";
import { lookupLastRun, lookupRealValue } from "./realValues";

export interface HoverInput {
  /** 今のコード（行ごと） */
  lines: string[];
  name: string;
  lineNo: number;
  /** 前に「値を見る（F6）」で実行した記録と、そのときのコード */
  lastRun?: { raw: TraceResult; text: string } | null;
  /** Python を裏で動かした結果（今のコードのもの） */
  sandbox?: SandboxResult | null;
  /** 裏で動かしている最中か */
  sandboxBusy?: boolean;
  /** AI の予想 */
  inferred?: InferResult | null;
  aiBusy?: boolean;
  /** 上から計算する予想（simulate）を使うか */
  simulate?: boolean;
}

export interface HoverOutput {
  body: string;
  source: string;
  /** どこから出した値か（数えるとき用） */
  kind: "lastRun" | "real" | "pending" | "simulate" | "ai" | "guess" | "unknown";
}

/** Python の組み込み関数（自分で同じ名前の変数を作っていなければ、値の小窓は出さない） */
const PY_BUILTINS = new Set("abs all any ascii bin bool bytearray bytes callable chr dict divmod enumerate filter float format frozenset hasattr hash hex id input int isinstance issubclass iter len list map max min next object oct open ord pow print range repr reversed round set slice sorted str sum super tuple type zip".split(" "));

/**
 * 値の小窓を出さない言葉か：
 * - f"…" r"…" の頭の f・r など
 * - 呼び出しの中の key=… reverse=… のような引数の名前
 * - 自分で作っていない組み込み関数の名前（max・sorted など）
 */
export function skipHoverWord(lineText: string, start: number, end: number, name: string, allText: string): boolean {
  if (/^[fFrRbBuU]{1,2}$/.test(name) && /^["']/.test(lineText.slice(end))) return true;
  if (/^\s*=(?!=)/.test(lineText.slice(end))) {
    const before = lineText.slice(0, start);
    let depth = 0;
    for (const c of before) {
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
    }
    if (depth > 0) return true;
  }
  if (PY_BUILTINS.has(name) && !new RegExp(`(^|\\n)\\s*(def\\s+${name}\\b|${name}\\s*(=(?!=)|\\+=)|for\\s+${name}\\b)`).test(allText)) return true;
  return false;
}

const UNKNOWN_TAIL = "\n実際の値は「値を見る（F6）」で実行するとわかります";

/** AI の値の行が input() などで受け取る行なのに、AI の答えが入力のことに触れていなければ、書き方からの見当を返す */
function inputGuessFor(lines: string[], name: string, lineNo: number, inferred: { value: string; from: number }): string | null {
  const text = lines[inferred.from - 1] ?? "";
  if (!/\binput\s*\(|Console\.ReadLine|\bnextInt\b|\bnextLine\b|\bscanf\b|\bprompt\s*\(|readline\s*\(/.test(text)) return null;
  if (/入力|input/i.test(inferred.value)) return null;
  const guess = staticGuess(lines.slice(0, lineNo), name, lineNo);
  return guess && /入力/.test(guess) ? guess : null;
}

/** 返り値が null のときは、小窓を出さない（関数・クラス・モジュールの名前など） */
export function autoHoverValue(input: HoverInput): HoverOutput | null {
  const { lines, name, lineNo } = input;
  const text = lines.join("\n");

  // 1. 前の実行（F6）の記録：その実行のあとに書きかえていない行だけ
  const run = input.lastRun;
  if (run) {
    const v = lookupLastRun(run, lines, name, lineNo);
    if (v && "value" in v) return { body: v.value, source: `▸ 前の実行（${v.from} 行目）`, kind: "lastRun" };
  }

  // 2. 実際に計算（Python を裏で動かした記録）
  const sb = input.sandbox;
  let note = "";
  if (sb?.trace) {
    const v = lookupRealValue(sb.trace, lines, name, lineNo, { stop: sb.stop });
    const rand = /\bimport\s+random\b|\bfrom\s+random\s+import\b/.test(text) ? "・乱数は毎回同じ値に固定" : "";
    if (v && "value" in v) return { body: v.value, source: `● 実際に計算（${v.from} 行目）${rand}`, kind: "real" };
    if (v && "pending" in v) {
      const what = sb.stop?.kind === "argv" ? "sys.argv" : "input()";
      return {
        body: "入力しだいで変わります（実行して入力すると決まります）",
        source: `● 実際に計算（${v.at ?? "?"} 行目の ${what} で止めました）`,
        kind: "pending",
      };
    }
    if (sb.stop?.kind === "timeout") note = "・実際の計算は時間がかかるため途中まで";
  } else if (sb?.refused) {
    note = `・${sb.refused.reason}ので、実際の計算はしていません`;
  } else if (sb?.stop?.kind === "timeout") {
    note = "・実際の計算は時間がかかるため止めました";
  }

  // 3. 今までの順：上から計算した予想 → AI の予想 → 書き方からの見当 → わかりません
  const inferred = lookupInferred(input.inferred ?? null, name, lineNo, lines);
  const sim = input.simulate !== false ? simulateValue(lines, name, lineNo) : null;
  if (sim) return { body: sim.text, source: `コードを上から順に計算した予想（入力や乱数があると変わります）${note}`, kind: "simulate" };
  if (inferred && "value" in inferred) {
    const guess = inputGuessFor(lines, name, lineNo, inferred);
    if (guess) return { body: guess, source: `コードから読み取った見当${note}`, kind: "guess" };
    return { body: inferred.value, source: `✦ AI の予想（${inferred.from} 行目で入る値）・実行はしていません${note}`, kind: "ai" };
  }
  if (inferred && "later" in inferred) {
    return { body: `まだ値が入っていません（${inferred.later} 行目で入ります）`, source: `✦ AI の予想${note}`, kind: "ai" };
  }
  const upTo = lines.slice(0, lineNo);
  const guess = staticGuess(upTo, name, lineNo);
  if (inferred && "unknown" in inferred) {
    return {
      body: `わかりません（AI にも予想できませんでした）${guess ? `\nコードからわかること：${guess.replace(/・(実際の値は|いくつになるかは)、実行しないとわかりません$/, "")}` : ""}${UNKNOWN_TAIL}`,
      source: `✦ AI の予想（${inferred.unknown} 行目）・実行はしていません${note}`,
      kind: "unknown",
    };
  }
  if (guess) {
    const busy = input.sandboxBusy ? "（計算中…）" : input.aiBusy ? "（AI が考え中…）" : "・実行はしていません";
    return { body: guess, source: `コードから読み取った見当${busy}${note}`, kind: "guess" };
  }
  if (input.sandboxBusy) return { body: "計算しています。少し待ってから、もう一度マウスを乗せてください", source: "● 実際に計算", kind: "unknown" };
  if (input.aiBusy) return { body: "AI が考え中です。少し待ってから、もう一度マウスを乗せてください", source: "✦ AI の予想", kind: "unknown" };
  const all = text;
  const n = name;
  // モジュール・関数・クラスの名前は値ではないので出さない
  if (new RegExp(`^\\s*(import\\s+[\\w.,\\s]*\\b${n}\\b|from\\s+\\S+\\s+import\\s+.*\\b${n}\\b|.*\\bas\\s+${n}\\b|(async\\s+)?def\\s+${n}\\b|class\\s+${n}\\b|function\\s+${n}\\b)`, "m").test(all)) return null;
  // 関数の引数
  const param = new RegExp(`^\\s*(?:async\\s+)?def\\s+(\\w+)\\s*\\([^)]*\\b${n}\\b`, "m").exec(upTo.join("\n"));
  return {
    body: param ? `わかりません：関数 ${param[1]} の引数なので、呼ぶときに渡す値で変わります` : `わかりません：この時点の値は、コードを読むだけでは決められません${UNKNOWN_TAIL}`,
    source: input.inferred ? `✦ AI の予想にもありませんでした${note}` : `コードから読み取った見当${note}`,
    kind: "unknown",
  };
}
