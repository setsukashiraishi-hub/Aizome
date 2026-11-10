// AI に聞く前に、もうわかっている変数の値を集める（AI へのヒントにし、食いちがう答えを直すため）。
// わかる値：前の実行（F6）の記録・Python を裏で動かした記録・上から計算した予想（simulate）
import { assignTargets } from "../ai/infer";
import { simulateValue } from "../ai/simulate";
import type { SandboxResult } from "../run/sandbox";
import type { TraceResult } from "../run/trace";
import { lookupLastRun, lookupRealValue } from "./realValues";

export interface KnownValues {
  /** 「行|変数名」→ その行を実行したあとの値 */
  values: Map<string, string>;
  /** 値が入る行がすべてわかっていて、実際に最後まで動いた（AI に聞かなくてよい） */
  complete: boolean;
}

export function knownValues(
  lines: string[],
  src: { lastRun?: { raw: TraceResult; text: string } | null; sandbox?: SandboxResult | null; simulate?: boolean },
): KnownValues {
  const values = new Map<string, string>();
  const targets = assignTargets(lines);
  const run = src.lastRun;
  const sb = src.sandbox;
  for (const t of targets) {
    const key = `${t.line}|${t.name}`;
    let v: string | null = null;
    if (run) {
      const r = lookupLastRun(run, lines, t.name, t.line);
      // その行そのものの記録だけ（さかのぼって見つけた値は、その行の値とは限らない）
      if (r && "value" in r && r.from === t.line) v = r.value;
    }
    if (v === null && sb?.trace) {
      const r = lookupRealValue(sb.trace, lines, t.name, t.line, { stop: sb.stop });
      if (r && "value" in r && r.from === t.line) v = r.value;
    }
    if (v === null && src.simulate) v = simulateValue(lines, t.name, t.line)?.text ?? null;
    // どの言語でも：値をそのまま書いた行（let x = 5;）と、数え方の決まったループ（for (let i = 0; i < 5; i++)）
    if (v === null) v = literalValue(lines, t.name, t.line);
    if (v !== null) values.set(key, v);
  }
  const complete = !!sb?.trace && !sb.stop && targets.length > 0 && targets.every((t) => values.has(`${t.line}|${t.name}`));
  return { values, complete };
}

const LITERAL = /^(-?\d+(\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|true|false|True|False|null|None|nil|\[\s*\]|\{\s*\})$/;

/**
 * その行が「変数 = 値そのもの」なら、その値。ループの中の行や、同じ変数に別の行でも入れているときは、
 * その行の値として正しいので、そのまま使う（その行を実行したあとの値）。
 * for (let i = 0; i < 5; i++) のように回数が決まったループなら「0 → 1 → … → 4（5 回）」
 */
export function literalValue(lines: string[], name: string, line: number): string | null {
  const text = (lines[line - 1] ?? "").replace(/\s*(\/\/|#).*$/, "");
  const loop = new RegExp(`^\\s*for\\s*\\(\\s*(?:let|var|int|long|auto|size_t)?\\s*${name}\\s*=\\s*(-?\\d+)\\s*;\\s*${name}\\s*(<|<=)\\s*(-?\\d+)\\s*;\\s*(?:${name}\\+\\+|\\+\\+${name}|${name}\\s*\\+=\\s*1)\\s*\\)`).exec(text);
  if (loop) {
    const from = Number(loop[1]);
    const to = Number(loop[3]) - (loop[2] === "<" ? 1 : 0);
    const n = to - from + 1;
    if (n < 1 || n > 1000) return null;
    const vals = Array.from({ length: Math.min(n, 6) }, (_, i) => String(from + i));
    return n === 1 ? String(from) : `${n > 6 ? `${vals.slice(0, 4).join(" → ")} → … → ${to}` : vals.join(" → ")}（${n} 回）`;
  }
  const m = new RegExp(`^\\s*(?:(?:let|const|var|final|static|auto|val|my|local|[A-Za-z_][\\w<>\\[\\]]*)\\s+)*${name}\\s*(?::\\s*[^=]+?)?\\s*:?=\\s*(.+?)\\s*;?\\s*$`).exec(text);
  if (!m || /^\s*(if|while|for|return)\b/.test(text)) return null;
  return LITERAL.test(m[1]) ? m[1] : null;
}
