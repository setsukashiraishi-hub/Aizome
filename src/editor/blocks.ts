// コードの「まとまり」（if・for・関数・クラス・try・複数行のリストや呼び出しなど）を、字下げから見つける。
// 画面に線で示すのと、「もし〇〇ならこっち」の説明に使う。画面に頼らない（node から試せる）
import { condPhrase, type ExplainLang } from "../ai/explainRules";

export type BlockKind = "branch" | "loop" | "func" | "class" | "try" | "with" | "data" | "block";

export interface Block {
  /** 見出しの行（if x > 0: など） */
  header: number;
  /** 中身の最後の行（} や ) で閉じる言語では、閉じる行） */
  end: number;
  /** 見出しの字下げ（文字数。タブは tabSize で数える） */
  col: number;
  kind: BlockKind;
  /** if / elif / else、try / except / finally のようにひと続きのもの（同じ番号） */
  chain: number;
  /** 「もし x > 0 なら」のような、そのまとまりに入る条件（分岐のときだけ） */
  label?: string;
}

const BLANK = /^\s*$/;

function indentOf(s: string, tab: number): number {
  let n = 0;
  for (const c of s) {
    if (c === " ") n++;
    else if (c === "\t") n += tab - (n % tab);
    else break;
  }
  return n;
}

/** 行の終わりのコメントを除く（文字列の中の # や // は残す） */
function code(line: string): string {
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "#" && !/^\s*#\s*(include|define|if|endif|pragma)/.test(line)) return line.slice(0, i);
    else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

function kindOf(t: string): BlockKind {
  const s = t.trim().replace(/^\}\s*/, "");
  if (/^(if|elif|else|switch|case|default|match|unless|when)\b/.test(s)) return "branch";
  if (/^(for|while|do|loop|foreach|repeat|until)\b/.test(s)) return "loop";
  if (/^(try|except|catch|finally|rescue|ensure)\b/.test(s)) return "try";
  if (/^(async\s+)?(def|function|func|fn|sub|lambda)\b|=>\s*\{?$|^(public|private|protected|internal|static)\b.*\(/.test(s)) return "func";
  if (/^(class|struct|interface|enum|impl|trait|object|module|namespace)\b/.test(s)) return "class";
  if (/^(with|using|lock)\b/.test(s)) return "with";
  // int add(int a, int b) { のような関数（C・Java・C# など）
  if (/^[\w<>[\]*&:,.\s]+\s+\w+\s*\([^;]*\)\s*(const\s*)?\{$/.test(s) && !/^(return|new|else|if|while|for|switch|catch)\b/.test(s)) return "func";
  if (/[([]$/.test(s) || (/\{$/.test(s) && /[=:(,]\s*\{$/.test(s))) return "data";
  return "block";
}

/** 見出しになる行か（中身が下に続くもの） */
function opensBlock(t: string): boolean {
  const s = t.trimEnd();
  return /:$/.test(s) || /[{([]$/.test(s) || /\b(then|do)$/.test(s);
}

/** そのまとまりを閉じる行か（} ) ] end など） */
function closes(t: string): boolean {
  return /^\s*([})\]]|end\b|done\b|fi\b)/.test(t);
}

/** まとまりの一覧（見出しの行の順） */
export function findBlocks(lines: string[], tabSize = 4): Block[] {
  const out: Block[] = [];
  const ind = lines.map((l) => (BLANK.test(l) ? -1 : indentOf(l, tabSize)));
  const nextCode = (i: number) => {
    for (let j = i + 1; j < lines.length; j++) if (ind[j] >= 0) return j;
    return -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (ind[i] < 0) continue;
    const t = code(lines[i]);
    if (!opensBlock(t)) continue;
    const first = nextCode(i);
    if (first < 0 || ind[first] <= ind[i]) continue;
    let last = first;
    let j = first;
    for (; j < lines.length; j++) {
      if (ind[j] < 0) continue;
      if (ind[j] <= ind[i]) break;
      last = j;
    }
    // } や ) で閉じる言語は、閉じる行まで含める
    if (j < lines.length && ind[j] === ind[i] && closes(lines[j]) && /[{([]\s*$/.test(t.trimEnd())) last = j;
    out.push({ header: i + 1, end: last + 1, col: ind[i], kind: kindOf(t), chain: out.length });
  }
  linkChains(out, lines);
  return out;
}

/** if → elif → else、try → except → finally などを、ひと続きにする */
function linkChains(blocks: Block[], lines: string[]) {
  const byHeader = new Map(blocks.map((b) => [b.header, b]));
  for (const b of blocks) {
    const t = lines[b.header - 1].trim();
    const cont = /^(\}\s*)?(elif|else|except|catch|finally)\b/.test(t);
    if (!cont) continue;
    // 同じ字下げで、すぐ上で終わっているまとまり
    for (let l = b.header - 1; l >= 1; l--) {
      const prev = [...byHeader.values()].find((p) => p.col === b.col && (p.end === l || p.end === b.header) && p.header < b.header);
      if (prev) {
        b.chain = prev.chain;
        break;
      }
      if (!BLANK.test(lines[l - 1])) break;
    }
  }
}

/** 言語（説明の文に使う） */
export function explainLangOf(filename: string): ExplainLang {
  const ext = /\.[^.\\/]+$/.exec(filename.toLowerCase())?.[0] ?? "";
  if (ext === ".py" || ext === ".pyw") return "python";
  if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(ext)) return "js";
  if ([".c", ".h", ".cpp", ".cc", ".hpp", ".java", ".cs", ".kt", ".swift", ".dart", ".rs", ".php"].includes(ext)) return "c";
  if (ext === ".go") return "go";
  if (ext === ".rb") return "ruby";
  return "other";
}

/** 条件の部分（if x > 0: → x > 0、} else if (a && b) { → a && b） */
function condOf(line: string): string | null {
  const s = code(line).trim().replace(/^\}\s*/, "");
  const m =
    /^(?:if|elif|else\s+if|while|unless)\s*\((.*)\)\s*\{?$/.exec(s) ??
    /^(?:if|elif|else\s+if|while|unless)\s+(.+?)\s*(?::|\{|then|do)?$/.exec(s);
  return m ? m[1].trim() : null;
}

const say = (expr: string, lang: ExplainLang) => {
  const p = condPhrase(expr, lang);
  return p.length > 40 ? p.slice(0, 39) + "…" : p;
};

/** 「score が 80 以上」+「なら」→「score が 80 以上なら」（式のままのときは空白をはさむ：「x>0 なら」） */
const join = (a: string, b: string) => (/[\u3040-\u30ff\u4e00-\u9fff）」]$/.test(a) ? a + b : `${a} ${b}`);

/**
 * 分岐のまとまりに、「もし〇〇なら」「〇〇でないとき」の説明を付ける。
 * if / elif / else、try / except / finally、match・switch の case、for・while の else
 */
export function labelBranches(blocks: Block[], lines: string[], lang: ExplainLang): void {
  const chains = new Map<number, Block[]>();
  for (const b of blocks) chains.set(b.chain, [...(chains.get(b.chain) ?? []), b]);
  // match / switch の対象（case の説明に使う）
  const subjectFor = (b: Block): string | null => {
    for (const p of blocks) {
      if (p.header < b.header && p.end >= b.end && p.col < b.col) {
        const m = /^\s*(?:match|switch)\s*\(?(.+?)\)?\s*[:{]?\s*$/.exec(code(lines[p.header - 1]));
        if (m) return m[1];
      }
    }
    return null;
  };
  for (const chain of chains.values()) {
    const conds: string[] = [];
    const first = lines[chain[0].header - 1].trim();
    for (const b of chain) {
      const t = code(lines[b.header - 1]).trim().replace(/^\}\s*/, "");
      let m: RegExpExecArray | null;
      if (/^(if|unless)\b/.test(t)) {
        const c = condOf(t);
        if (c) {
          conds.push(say(c, lang));
          b.label = `もし ${join(say(c, lang), "なら")}`;
        }
      } else if (/^(elif|else\s+if)\b/.test(t)) {
        const c = condOf(t);
        if (c) {
          b.label = `そうでなく、もし ${join(say(c, lang), "なら")}`;
          conds.push(say(c, lang));
        }
      } else if (/^else\b/.test(t)) {
        if (/^\s*(for|while)\b/.test(first)) b.label = "くり返しを break で抜けずに終えたら";
        else if (/^\s*try\b/.test(first)) b.label = "エラーが起きなかったら";
        else if (conds.length === 1) b.label = join(conds[0], "でないとき");
        else if (conds.length > 1) b.label = `どれでもないとき（${conds.map((c) => join(c, "でもなく")).join("、").replace(/でもなく$/, "でもない")}）`;
        else b.label = "そうでないとき";
      } else if (/^try\b/.test(t)) {
        b.label = "ためしに動かす（エラーが起きたら下へ）";
      } else if ((m = /^(?:except|catch)\b\s*\(?\s*([\w.]+(?:\s*,\s*[\w.]+)*)?/.exec(t))) {
        const err = m[1] && !/^(e|err|error|ex)$/.test(m[1]) ? m[1].replace(/\s+as\s+\w+$/, "") : "";
        b.label = err && !/^Exception$/.test(err) ? `${err} のエラーが起きたら` : "エラーが起きたら";
      } else if (/^finally\b/.test(t)) {
        b.label = "最後に、かならず";
      } else if ((m = /^case\s+(.+?)\s*:$/.exec(t))) {
        const subj = subjectFor(b);
        b.label = m[1] === "_" ? "どれにも当たらないとき" : subj ? `${subj} が ${join(m[1], "なら")}` : join(m[1], "なら");
      } else if (/^default\s*:$/.test(t)) {
        b.label = "どれにも当たらないとき";
      }
    }
  }
}
