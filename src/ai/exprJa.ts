// 式（math.sin(i) や s.strip().split(",") など）が何を表すかを、日本語の短い文にする
import { API, PY_BARE, PY_BARE_CONSTS, isOn, type ApiCtx, type ApiEntry, type ApiTable } from "./apiJa";
import { typeLabel } from "./typeJa";

export type ExprLang = "python" | "js" | "c" | "ruby";

const cut = (s: string, n = 20) => {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** かっこと文字列を見ながら、トップレベルでカンマ区切り */
export function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === sep && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return sep === "," ? joinLambdas(out) : out;
}

/** 「lambda a, b: a + b」がカンマで分かれてしまったのをつなぎ直す */
export function joinLambdas(parts: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i];
    while (/^lambda\b[^:]*$/.test(p) && i + 1 < parts.length) p += ", " + parts[++i];
    out.push(p);
  }
  return out;
}

/** s[i] が開きかっこのとき、対応する閉じかっこの位置 */
function matchClose(s: string, i: number): number {
  const open = s[i];
  const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : ">";
  let depth = 0;
  let quote = "";
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = "";
      continue;
    }
    if (open !== "<" && (c === '"' || c === "'" || c === "`")) quote = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  return -1;
}

function stringLit(s: string): string | null {
  const m = /^\s*([rbuf]*)(["'`])((?:\\.|(?!\2).)*)\2\s*$/i.exec(s);
  if (!m || /f/i.test(m[1])) return null;
  return m[3].replace(/\\n/g, "（改行）").replace(/\\t/g, "（タブ）");
}

function stripParens(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && matchClose(t, 0) === t.length - 1) t = t.slice(1, -1).trim();
  return t;
}

interface Chain {
  /** 呼んでいる名前（"math.sin"、"s.strip().split"） */
  callee: string;
  gen?: string;
  args: string[] | null;
}

/** 式の最後が f(...) なら、名前と引数に分ける。かっこなしの a.b なら args は null */
function parseTail(expr: string): Chain | null {
  const s = expr.trim();
  if (s.endsWith(")")) {
    // 最後の ) に対応する ( を探す
    let depth = 0;
    let quote = "";
    let open = -1;
    for (let j = s.length - 1; j >= 0; j--) {
      const c = s[j];
      if (quote) {
        if (c === quote && s[j - 1] !== "\\") quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === ")") depth++;
      else if (c === "(" && --depth === 0) {
        open = j;
        break;
      }
    }
    if (open <= 0) return null;
    let callee = s.slice(0, open);
    let gen: string | undefined;
    const g = /<([\w.,\s[\]]+)>$/.exec(callee);
    if (g) {
      gen = g[1].trim();
      callee = callee.slice(0, -g[0].length);
    }
    if (!/^[A-Za-z_$][\w$]*[?!]?$/.test(callee.split(/\.|::/).pop() ?? "")) return null;
    if (!isChain(callee)) return null;
    return { callee, gen, args: splitTop(s.slice(open + 1, -1)) };
  }
  if (/^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*[?!]?|::[A-Za-z_]\w*)*$/.test(s) || (isChain(s) && /\.[A-Za-z_$][\w$]*$/.test(s))) return { callee: s, args: null };
  return null;
}

/** a.b(c).d[e] のように、演算子をはさまない「つながった」式か */
function isChain(s: string): boolean {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && !/[\w$.?!:]/.test(c)) return false;
  }
  return depth === 0 && /^[A-Za-z_$"'([]/.test(s);
}

/** "a.b.c" → ["a.b", "c"]（かっこの中のドットは見ない） */
function splitLastDot(callee: string): [string, string] | null {
  let depth = 0;
  for (let i = callee.length - 1; i > 0; i--) {
    const c = callee[i];
    if (")]}".includes(c)) depth++;
    else if ("([{".includes(c)) depth--;
    else if (depth === 0 && c === "." ) return [callee.slice(0, i).replace(/\?$/, ""), callee.slice(i + 1)];
    else if (depth === 0 && c === ":" && callee[i - 1] === ":") return [callee.slice(0, i - 1), callee.slice(i + 1)];
  }
  return null;
}

// ───────── テンプレート

function fill(tpl: string, c: ApiCtx): string {
  let out = "";
  for (let i = 0; i < tpl.length; i++) {
    const ch = tpl[i];
    if (ch !== "{") {
      out += ch;
      continue;
    }
    const end = matchClose(tpl, i);
    if (end < 0) {
      out += ch;
      continue;
    }
    const body = tpl.slice(i + 1, end);
    const q = /^(\d\+?|o|\*|T|@\w+)\?/.exec(body);
    if (q) {
      // {X?A|B} … | はトップレベルのものだけ
      const rest = body.slice(q[0].length);
      let depth = 0;
      let bar = -1;
      for (let j = 0; j < rest.length; j++) {
        if (rest[j] === "{") depth++;
        else if (rest[j] === "}") depth--;
        else if (rest[j] === "|" && depth === 0) {
          bar = j;
          break;
        }
      }
      const yes = bar < 0 ? rest : rest.slice(0, bar);
      const no = bar < 0 ? "" : rest.slice(bar + 1);
      out += fill(has(q[1], c) ? yes : no, c);
    } else {
      const v = value(body, c);
      out += v ?? `{${body}}`;
    }
    i = end;
  }
  return out;
}

function has(key: string, c: ApiCtx): boolean {
  if (key === "o") return !!c.o;
  if (key === "*") return c.args.length > 0;
  if (key === "T") return !!c.gen;
  if (key.startsWith("@")) return isOn(c.kw[key.slice(1)]);
  if (key.endsWith("+")) return c.args.length > Number(key.slice(0, -1));
  return c.args[Number(key)] !== undefined;
}

function value(key: string, c: ApiCtx): string | null {
  if (key === "o") return c.o ?? "";
  if (key === "*") return c.args.join("・");
  if (key === "T") return c.gen ?? "";
  if (key.startsWith("@")) return c.kw[key.slice(1)] !== undefined ? show(c.kw[key.slice(1)]) : "";
  if (/^\d\+$/.test(key)) return c.args.slice(Number(key[0])).join("・");
  if (/^\d$/.test(key)) return c.args[Number(key)] ?? "";
  return null;
}

/** 引数を読みやすく：文字は「」、KeyCode.Space は Space */
function show(raw: string): string {
  const t = raw.trim();
  const lit = stringLit(t);
  if (lit !== null) return lit === "" ? "空の文字" : `「${lit.length > 16 ? lit.slice(0, 15) + "…" : lit}」`;
  if (/^KeyCode\.\w+$/.test(t)) return t.slice(8);
  if (/^\*\*\w/.test(t)) return `${cut(t.slice(2), 14)} の中身（名前つきでばらして）`;
  if (/^\*\w/.test(t)) return `${cut(t.slice(1), 14)} の中身（ばらして）`;
  if (/^None$/.test(t)) return "None（何もない）";
  if (/^-?\d+(\.\d+)?[fFdDmMlL]$/.test(t)) return t.slice(0, -1);
  if (/^ForceMode2?D?\.\w+$/.test(t)) return t.replace(/^ForceMode2?D?\./, "");
  if (/^Space\.(World|Self)$/.test(t)) return t.endsWith("World") ? "世界" : "自分";
  return cut(t, 18);
}

// ───────── 本体

export interface ExprMeaning {
  /** 値として「〜」（名詞） */
  noun: string | null;
  /** 1 行の命令として「〜ます」 */
  verb: string | null;
}

function lookup(table: ApiTable, lang: ExprLang, callee: string, isCall: boolean): { entry: ApiEntry; obj: string | null } | { constant: string } | null {
  // std::sqrt → sqrt、Vec::new → Vec.new
  const norm = callee.replace(/^std::/, "").replace(/::/g, ".").replace(/^UnityEngine\./, "");
  if (!isCall) {
    if (table.consts[norm]) return { constant: table.consts[norm] };
    if (lang === "python" && PY_BARE_CONSTS[norm]) return { constant: PY_BARE_CONSTS[norm] };
  }
  if (isCall && table.funcs[norm] !== undefined) return { entry: table.funcs[norm], obj: null };
  const split = splitLastDot(callee.replace(/^std::/, ""));
  if (!split) {
    if (isCall && lang === "python" && PY_BARE[norm]) return { entry: PY_BARE[norm], obj: null };
    return null;
  }
  const [obj, name] = split;
  if (isCall) {
    const m = table.methods[name];
    if (m !== undefined) return { entry: m, obj };
    return null;
  }
  const p = table.props[name];
  if (p) return { entry: p, obj };
  if (lang === "ruby" && table.methods[name] !== undefined) return { entry: table.methods[name], obj };
  return null;
}

function resolve(entry: ApiEntry, c: ApiCtx, depth = 0): { n: string | null; v: string | null } | null {
  if (typeof entry === "function") {
    const r = entry(c);
    return r === null || depth > 2 ? null : resolve(r, c, depth + 1);
  }
  if (typeof entry === "string") return entry.startsWith("!") ? { n: null, v: fill(entry.slice(1), c) } : { n: fill(entry, c), v: null };
  const [n, v] = entry;
  return { n: n ? fill(n, c) : null, v: v ? fill(v.replace(/^!/, ""), c) : null };
}

/** 引数・相手の表し方（中も分かれば『』でくるむ） */
function render(raw: string, lang: ExprLang, depth: number): string {
  const t = raw.trim();
  if (depth < 2) {
    const inner = describeExprInner(t, lang, depth + 1);
    if (inner?.noun && inner.noun.length <= 34 && !inner.noun.includes("『")) return `『${inner.noun}』`;
  }
  return show(t);
}

function describeExprInner(expr: string, lang: ExprLang, depth: number): ExprMeaning | null {
  const raw0 = expr.replace(/;\s*$/, "").trim();
  if (lang === "python" && /^\(.+\sfor\s.+\sin\s.+\)$/s.test(raw0) && matchClose(raw0, 0) === raw0.length - 1) {
    const g = conditionalAndComprehension(raw0, lang, depth);
    if (g) return g;
  }
  let s = stripParens(raw0);
  if (!s || s.length > 200) return null;
  const table = API[lang];
  // await / new
  let m: RegExpExecArray | null;
  if ((m = /^await\s+(.+)$/.exec(s))) {
    const inner = describeExprInner(m[1], lang, depth);
    return inner?.noun ? { noun: `${inner.noun.replace(/（を待つもの）$/, "")}（終わるまで待つ）`, verb: `${inner.noun.replace(/（を待つもの）$/, "")}が終わるまで待ちます` } : null;
  }
  if ((m = /^new\s+([\w.]+)(?:<([^>]*)>)?\((.*)\)$/.exec(s))) {
    const e = table.funcs["new " + m[1]] ?? table.funcs[m[1]];
    if (e !== undefined) {
      const raw = splitTop(m[3]);
      const r = resolve(e, { o: null, rawO: null, args: raw.map((a) => render(a, lang, depth)), raw, kw: {}, gen: m[2] });
      if (r?.n) return { noun: tidy(r.n), verb: null };
    }
    const nm = NEW_NAMES[m[1].split(".").pop()!];
    const gen = m[2] ? `（中身は ${splitTop(m[2]).map((g) => typeLabel(g.trim(), lang === "python" ? "python" : "c")).join("・")}）` : "";
    const args = m[3].trim() ? `（${cut(m[3], 16)} から）` : "";
    return { noun: nm ? `新しい${nm}${gen}` : `新しい ${m[1]}${gen}${args}`, verb: null };
  }
  if ((m = /^-([A-Za-z_(].*)$/.exec(s)) && !splitOp(m[1], ["+", "-"])) {
    const inner = describeExprInner(m[1], lang, depth + 1)?.noun;
    if (inner) return { noun: `『${inner}』にマイナスを付けた値`, verb: null };
  }
  // ! や not
  if ((m = /^(?:!|not\s+)(.+)$/.exec(s)) && lang !== "ruby") {
    const inner = describeExprInner(m[1], lang, depth);
    // !(A || B) →「A」と「B」のどちらでもないか
    const body = stripParens(m[1].trim());
    const orParts = splitOp(body, lang === "python" ? [" or "] : ["||"], false);
    if (orParts && inner?.noun) {
      const a = condPart(orParts[0], lang, depth).trim();
      const b = condPart(orParts[2], lang, depth).trim();
      return { noun: `「${a}」と「${b}」のどちらでもないか`, verb: null };
    }
    if (inner?.noun && /(か|かどうか)$/.test(inner.noun)) return { noun: `「${inner.noun.replace(/\s*(かどうか|か)$/, "")}」ではないか`, verb: null };
    return null;
  }
  if (lang === "python" && (m = /^lambda\s*([^:]*):\s*(.+)$/s.exec(s))) {
    const params = m[1].trim();
    const body = describeExprInner(m[2], lang, depth + 1)?.noun;
    return { noun: `${params ? `${params} を受け取って ` : ""}${body ? `『${body}』` : cut(m[2], 20)} を返す小さな関数（lambda）`, verb: null };
  }
  if ((lang === "js" || lang === "c") && (m = /^\(?([\w\s,]*)\)?\s*=>\s*([^{].*)$/s.exec(s))) {
    const params = m[1].trim();
    const body = describeExprInner(m[2], lang, depth + 1)?.noun;
    return { noun: `${params ? `${params} を受け取って ` : ""}${body ? `『${body}』` : cut(m[2], 20)} を返す小さな関数`, verb: null };
  }
  const special = conditionalAndComprehension(s, lang, depth);
  if (special) return special;
  const bin = binary(s, lang, depth);
  if (bin) return bin;
  const tail = parseTail(s);
  if (!tail) return null;
  const isCall = tail.args !== null;
  const hit = lookup(table, lang, tail.callee, isCall);
  if (!hit) return null;
  if ("constant" in hit) return { noun: hit.constant, verb: null };
  const rawArgs = tail.args ?? [];
  const kw: Record<string, string> = {};
  const pos: string[] = [];
  for (const a of rawArgs) {
    const k = lang === "python" ? /^(\w+)\s*=(?!=)\s*(.+)$/s.exec(a) : null;
    if (k) kw[k[1]] = k[2];
    else pos.push(a.replace(/^(ref|out|in)\s+(var\s+)?/, ""));
  }
  const c: ApiCtx = {
    o: hit.obj !== null ? render(hit.obj, lang, depth) : null,
    rawO: hit.obj,
    args: pos.map((a) => render(a, lang, depth)),
    raw: pos,
    kw,
    gen: tail.gen,
  };
  const r = resolve(hit.entry, c);
  if (!r) return null;
  return { noun: tidy(r.n), verb: tidy(r.v) };
}

/** 「』 を」→「』を」のように、かっこの後ろの余分な空白を詰める */
function tidy(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/([』」）)]) +(?=[をのにとでがはへやも、。])/g, "$1").replace(/ +([、。])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

/** トップレベルの演算子で 2 つに分ける（いちばん弱い演算子から） */
function splitOp(s: string, ops: string[], rightmost = true): [string, string, string] | null {
  let depth = 0;
  let quote = "";
  let found: [number, string] | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0) {
      for (const op of ops) {
        if (!s.startsWith(op, i)) continue;
        const before = s.slice(0, i).trimEnd();
        const after = s[i + op.length];
        // 単項のマイナス・** や // や == の一部・-> や => は除く
        if ((op === "-" || op === "+") && (!before || /[-+*/%(<>=!&|,^~]$/.test(before) || /[eE]$/.test(before) && /\d[eE]$/.test(before))) continue;
        if ((op === "*" && (after === "*" || s[i - 1] === "*")) || (op === "/" && (after === "/" || s[i - 1] === "/"))) continue;
        if ((op === "<" || op === ">") && (after === "=" || after === op || s[i - 1] === op || s[i - 1] === "=" || s[i - 1] === "-")) continue;
        if (op === "-" && after === ">") continue;
        if (/^[a-z]/.test(op) && (/\w/.test(s[i - 1] ?? "") || /\w/.test(after ?? ""))) continue;
        if (!found || rightmost) found = [i, op];
        if (!rightmost) break;
        break;
      }
      if (found && !rightmost) break;
    }
  }
  if (!found) return null;
  const [i, op] = found;
  const l = s.slice(0, i).trim();
  const r = s.slice(i + op.length).trim();
  return l && r ? [l, op, r] : null;
}

const OP_NOUN: Record<string, string> = {
  "+": "{a} と {b} を足した値", "-": "{a} から {b} を引いた値", "*": "{a} に {b} を掛けた値", "/": "{a} を {b} で割った値",
  "//": "{a} を {b} で割った商（小数点以下切り捨て）", "%": "{a} を {b} で割った余り", "**": "{a} の {b} 乗",
  "==": "{a} が {b} と等しいか", "===": "{a} が {b} と等しいか", "!=": "{a} が {b} と違うか", "!==": "{a} が {b} と違うか",
  ">": "{a} が {b} より大きいか", "<": "{a} が {b} より小さいか", ">=": "{a} が {b} 以上か", "<=": "{a} が {b} 以下か",
  "in": "{a} が {b} に入っているか", "not in": "{a} が {b} に入っていないか",
  "is": "{a} が {b} そのものか", "is not": "{a} が {b} ではないか",
};

const NEW_NAMES: Record<string, string> = {
  List: "リスト", Dictionary: "辞書（キーと値の表）", HashSet: "集合", Queue: "キュー（先に入れたものから出る）", Stack: "スタック（後に入れたものから出る）",
  ArrayList: "リスト", LinkedList: "つながったリスト", HashMap: "表（キーと値）", TreeMap: "並んだ表（キーと値）", Scanner: "キーボード入力を読む道具",
  Random: "乱数を作る道具", StringBuilder: "文字をつなげていく入れ物", GameObject: "ゲームオブジェクト", Thread: "スレッド（同時に動く処理）",
  Date: "日時", Map: "Map（キーと値の表）", Set: "Set（集合）", Array: "配列", Error: "エラー", Promise: "あとで結果が出る処理（Promise）",
  Image: "画像", Audio: "音声", RegExp: "正規表現", URL: "URL", WebSocket: "WebSocket 通信", XMLHttpRequest: "通信",
};

function binary(s: string, lang: ExprLang, depth: number): ExprMeaning | null {
  if (depth > 4) return null;
  // 代入（= += など）は式ではない
  if (/(^|[^=!<>+\-*/%&|^])=(?!=)/.test(s.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')) && !/=>/.test(s)) return null;
  let mm: RegExpExecArray | null;
  if ((mm = /^(.+?)\s*%\s*2\s*(==|===|!=|!==)\s*([01])$/.exec(s))) {
    const even = (mm[2].startsWith("=") ? "0" : "1") === mm[3];
    return { noun: `${show(mm[1])} が${even ? "偶数" : "奇数"}か`, verb: null };
  }
  // 論理演算子をふくむ式はここでは扱わない
  if (splitOp(s, lang === "python" ? [" and ", " or "] : ["&&", "||"])) return null;
  const groups: [string[], boolean][] = [
    [lang === "python" ? ["not in", "is not", "is", "in", "==", "!=", ">=", "<=", ">", "<"] : ["===", "!==", "==", "!=", ">=", "<=", ">", "<"], false],
    [["+", "-"], true],
    [["//", "*", "/", "%"], true],
    [["**"], false],
  ];
  for (const [ops, rightmost] of groups) {
    const sp = splitOp(s, ops, rightmost);
    if (!sp) continue;
    const [l, op, r] = sp;
    if (op === "**" && lang !== "python" && lang !== "js") return null;
    // 数・名前・文字だけの、短い足し算・引き算・掛け算（3*3 や i+1）は、式のまま見せる
    const atom = (x: string) => /^(-?[\d.]+|[A-Za-z_][\w.]*|"[^"]*"|'[^']*')$/.test(x.trim());
    const plainArith = (x: string): boolean => {
      const sp2 = splitOp(x, ["+", "-", "*"], true);
      return !!sp2 && x.length <= 16 && atom(sp2[2]) && (atom(sp2[0]) || plainArith(sp2[0]));
    };
    const ld = plainArith(l) ? null : describeExprInner(l, lang, depth + 1)?.noun;
    const rd = plainArith(r) ? null : describeExprInner(r, lang, depth + 1)?.noun;
    const compare = !rightmost && ops.includes("==");
    // 比べる式（==・< など）は、両側が式のままでも「〜が〜と等しいか」の形にする
    // 割り算・余り（2026%4 など）も、数と名前だけなら言葉にする
    const divide = ["%", "/", "//"].includes(op) && atom(l) && atom(r);
    if (!ld && !rd && !compare && !divide && !["in", "not in", "is", "is not"].includes(op)) return null;
    const side = (raw: string, d: string | null | undefined) => (d ? (d.length <= 30 ? `『${d}』` : show(raw)) : show(raw));
    if (op === "*") {
      const unit = /^time\.(Nanosecond|Microsecond|Millisecond|Second|Minute|Hour)$/;
      const ja: Record<string, string> = { Nanosecond: "ナノ秒", Microsecond: "マイクロ秒", Millisecond: "ミリ秒", Second: "秒", Minute: "分", Hour: "時間" };
      const ur = unit.exec(r);
      const ul = unit.exec(l);
      if (ur) return { noun: `${show(l)} ${ja[ur[1]]}`, verb: null };
      if (ul) return { noun: `${show(r)} ${ja[ul[1]]}`, verb: null };
    }
    if ((op === "is" || op === "is not") && r === "None") return { noun: `${side(l, ld)} が${op === "is" ? "「何もない」（None）" : "「何もない」（None）ではない"}か`, verb: null };
    const tpl = OP_NOUN[op];
    if (!tpl) return null;
    return { noun: tidy(tpl.replace("{a}", side(l, ld)).replace("{b}", side(r, rd))), verb: null };
  }
  return null;
}

/** 条件の部分を「〜」の形に（「か」で終わる名詞なら外す） */
function condPart(raw: string, lang: ExprLang, depth: number): string {
  const n = describeExprInner(raw, lang, depth + 1)?.noun;
  if (n && /(かどうか|か)$/.test(n)) return n.replace(/\s*(かどうか|か)$/, "");
  return show(raw) + " ";
}

function valPart(raw: string, lang: ExprLang, depth: number): string {
  const n = describeExprInner(raw, lang, depth + 1)?.noun;
  return n && n.length <= 30 && !n.includes("『") ? `『${n}』` : show(raw);
}

/** 条件式（a if c else b / c ? a : b）・内包表記（[x for x in …]）・and / or */
function conditionalAndComprehension(s: string, lang: ExprLang, depth: number): ExprMeaning | null {
  if (depth > 4) return null;
  // 論理演算（いちばん弱いので先に）
  const or = splitOp(s, lang === "python" ? [" or "] : lang === "ruby" ? [" or ", "||"] : ["||"], false);
  if (or && !(lang === "python" && splitOp(s, [" if "]))) return { noun: tidy(`${condPart(or[0], lang, depth)}、または ${condPart(or[2], lang, depth)}か`), verb: null };
  const and = splitOp(s, lang === "python" ? [" and "] : lang === "ruby" ? [" and ", "&&"] : ["&&"], false);
  if (and && !(lang === "python" && splitOp(s, [" if "]))) return { noun: tidy(`${condPart(and[0], lang, depth)}、かつ ${condPart(and[2], lang, depth)}か`), verb: null };
  let m: RegExpExecArray | null;
  if (lang === "python") {
    // 内包表記
    if ((m = /^([[{(])(.+)\s+for\s+(.+?)\s+in\s+(.+?)(?:\s+if\s+(.+))?([\]})])$/s.exec(s)) && matchClose(s, 0) === s.length - 1 && !/\sfor\s/.test(m[4])) {
      const [, open, body, v, src, cond] = m;
      const kv = open === "{" ? splitOp(body, [":"], false) : null;
      const what = kv ? `キー ${show(kv[0])}・値 ${show(kv[2])}` : body.trim() === v.trim() ? v.trim() : valPart(body, lang, depth);
      const kind = open === "[" ? "リスト" : open === "(" ? "ジェネレーター（必要なときに 1 つずつ作る）" : kv ? "辞書" : "集合";
      const from = valPart(src, lang, depth);
      const only = cond ? `「${condPart(cond, lang, depth).trim()}」のときだけ ` : "";
      return { noun: tidy(`${from} の中身を 1 つずつ ${v.trim()} として、${only}${what} を集めた${kind}`), verb: null };
    }
    // 条件式（三項演算子）
    const ifs = splitOp(s, [" if "], false);
    if (ifs) {
      const els = splitOp(ifs[2], [" else "], false);
      if (els) return { noun: tidy(`${condPart(els[0], lang, depth)}なら ${valPart(ifs[0], lang, depth)}、そうでなければ ${valPart(els[2], lang, depth)}`), verb: null };
    }
    return null;
  }
  // c ? a : b
  const q = splitOp(s, ["?"], false);
  if (q && !/^[.?]/.test(q[2]) && !q[0].endsWith("?")) {
    const colon = splitOp(q[2], [":"], false);
    if (colon && !q[2].startsWith(":")) return { noun: tidy(`${condPart(q[0], lang, depth)}なら ${valPart(colon[0], lang, depth)}、そうでなければ ${valPart(colon[2], lang, depth)}`), verb: null };
  }
  return null;
}

/** 式の意味（分からなければ null） */
export function describeExpr(expr: string, lang: ExprLang): ExprMeaning | null {
  try {
    return describeExprInner(expr, lang, 0);
  } catch {
    return null;
  }
}

/** 1 行まるごとが関数・メソッドの呼び出しなら「〜します」 */
export function describeStatement(line: string, lang: ExprLang): string | null {
  const s = line.trim().replace(/;\s*$/, "");
  const t = parseTail(stripParens(s.replace(/^await\s+/, "")));
  if (!t || t.args === null) return null;
  const d = describeExpr(s, lang);
  if (!d) return null;
  if (d.verb) return d.verb;
  if (d.noun) return /か$/.test(d.noun) ? `${d.noun}調べます` : `${d.noun}を求めます`;
  return null;
}

/** 「〜か」で終わる名詞を「もし 〜なら」に */
export function asCondition(noun: string): string {
  if (/(かどうか|か)$/.test(noun)) return noun.replace(/\s*(かどうか|か)$/, "");
  if (/ではないか$/.test(noun)) return noun.replace(/か$/, "");
  return `${noun}が真`;
}

/** import / using の説明（モジュール名から） */
export function moduleMeaning(name: string, lang: ExprLang): string | null {
  return API[lang].modules[name] ?? null;
}

/** from math import sin のときの、名前のひとこと（「正弦（サイン）を求める」など） */
export function importedMeaning(mod: string, name: string, lang: ExprLang): string | null {
  const t = API[lang];
  const e = t.funcs[`${mod}.${name}`] ?? t.funcs[name];
  if (t.consts[`${mod}.${name}`]) return t.consts[`${mod}.${name}`];
  if (e === undefined) return null;
  if (Array.isArray(e) && e[2]) return e[2];
  const n = typeof e === "string" ? e : Array.isArray(e) ? e[0] ?? e[1] ?? null : null;
  if (!n) return null;
  if (n.startsWith("!")) {
    const v = n.slice(1);
    // 「{0} 秒待ちます」→ 名前だけでは言いにくいので、引数がなければそのまま
    return /\{/.test(v) ? null : v.replace(/ます$/, "る");
  }
  // 「{0} の平方根」→「平方根を求める」（引数が最初に 1 つだけのときだけ）
  const mm = /^\{0\}\s*の(.+)$/.exec(n);
  if (mm && !/\{/.test(mm[1])) return `${mm[1]}を求める`;
  if (!/\{/.test(n)) return n;
  return null;
}
