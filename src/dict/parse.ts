// コード辞書の追加分（src/dict/data/*.txt）を読む。
// 書き方：
//   @ 分類
//   ## 見出し | 探すための言葉 | ひとこと説明（なくてもよい）
//   コード（次の「## 」か「@ 」の行まで。字下げはスペース 4 つ）
// 「;; 」で始まる行は、ファイルの中のメモ（辞書には入らない）
import type { DictEntry } from "./types";

export function parseDictText(text: string): DictEntry[] {
  const out: DictEntry[] = [];
  let category = "その他";
  let head: { title: string; keys: string; note?: string } | null = null;
  let code: string[] = [];
  const flush = () => {
    if (!head) return;
    while (code.length && !code[code.length - 1].trim()) code.pop();
    while (code.length && !code[0].trim()) code.shift();
    if (code.length) out.push(head.note ? [category, head.title, head.keys, code.join("\n"), head.note] : [category, head.title, head.keys, code.join("\n")]);
    head = null;
    code = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith(";; ") || line === ";;") continue;
    if (line.startsWith("@ ")) {
      flush();
      category = line.slice(2).trim();
    } else if (line.startsWith("## ")) {
      flush();
      const [title, keys = "", note] = line.slice(3).split(" | ").map((s) => s.trim());
      head = { title, keys, note: note || undefined };
    } else if (head) {
      code.push(line);
    }
  }
  flush();
  return out;
}

/** 分類の順（最初に出てきた順）にまとめ直す。同じ分類の中の順番はそのまま */
export function groupByCategory(entries: DictEntry[]): DictEntry[] {
  const order = new Map<string, number>();
  for (const e of entries) if (!order.has(e[0])) order.set(e[0], order.size);
  return entries
    .map((e, i) => [e, i] as const)
    .sort((a, b) => order.get(a[0][0])! - order.get(b[0][0])! || a[1] - b[1])
    .map(([e]) => e);
}

/** 見出しが同じものは、先に書いたほうを残す */
export function mergeEntries(base: DictEntry[], extra: DictEntry[]): DictEntry[] {
  const seen = new Set(base.map((e) => e[1]));
  return groupByCategory([...base, ...extra.filter((e) => !seen.has(e[1]) && (seen.add(e[1]), true))]);
}
