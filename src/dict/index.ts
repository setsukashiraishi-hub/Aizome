// コード辞書：言語の一覧・探し方・エディタに入れる形への変換
import { normalizeQuery } from "../core/jpText";
import { settings } from "../core/settings";
import type { DictEntry, DictLanguage } from "./types";
import { python } from "./python";
import { javascript } from "./javascript";
import { csharp } from "./csharp";
import { c, cpp, css, go, html, java, shell } from "./others";
import { mergeEntries, parseDictText } from "./parse";
// 追加分は読みやすいように、ふつうの文字のファイルで書いている（書き方は parse.ts）
import pythonText from "./data/python.txt?raw";
import javascriptText from "./data/javascript.txt?raw";
import csharpText from "./data/csharp.txt?raw";
import goText from "./data/go.txt?raw";
import cText from "./data/c.txt?raw";
import cppText from "./data/cpp.txt?raw";
import javaText from "./data/java.txt?raw";
import htmlText from "./data/html.txt?raw";
import cssText from "./data/css.txt?raw";
import shellText from "./data/shell.txt?raw";
import sqlText from "./data/sql.txt?raw";

export type { DictEntry, DictLanguage } from "./types";

const withExtra = (lang: DictLanguage, text: string): DictLanguage => ({ ...lang, entries: mergeEntries(lang.entries, parseDictText(text)) });

const sql: DictLanguage = { id: "sql", label: "SQL", exts: [".sql"], entries: [] };

export const DICT_LANGUAGES: DictLanguage[] = [
  withExtra(python, pythonText),
  withExtra(javascript, javascriptText),
  withExtra(csharp, csharpText),
  withExtra(go, goText),
  withExtra(c, cText),
  withExtra(cpp, cppText),
  withExtra(java, javaText),
  withExtra(html, htmlText),
  withExtra(css, cssText),
  withExtra(shell, shellText),
  withExtra(sql, sqlText),
];

export interface UserDictEntry {
  lang: string;
  title: string;
  code: string;
  keys?: string;
}

export interface DictHit {
  lang: string;
  category: string;
  title: string;
  keys: string;
  code: string;
  note?: string;
  /** 自分で追加したもの */
  user?: boolean;
  score: number;
}

export function dictLanguageFor(filename: string): DictLanguage | undefined {
  const i = filename.lastIndexOf(".");
  const ext = i >= 0 ? filename.slice(i).toLowerCase() : "";
  return DICT_LANGUAGES.find((l) => l.exts.includes(ext));
}

export function userEntries(): UserDictEntry[] {
  return settings.get("dict.user") ?? [];
}

export function addUserEntry(e: UserDictEntry) {
  settings.set("dict.user", [...userEntries().filter((x) => !(x.lang === e.lang && x.title === e.title)), e]);
}

export function removeUserEntry(e: { lang: string; title: string }) {
  settings.set("dict.user", userEntries().filter((x) => !(x.lang === e.lang && x.title === e.title)));
}

function toHit(lang: string, e: DictEntry): Omit<DictHit, "score"> {
  return { lang, category: e[0], title: e[1], keys: e[2], code: e[3], note: e[4] };
}

/** ひらがなで探しても見つかるように、よく出てくる言葉の読み */
const READINGS: [string, string][] = [
  ["並べ替", "ならべかえ"], ["読", "よむ よみこみ"], ["書", "かく かきこみ"], ["表示", "ひょうじ"], ["入力", "にゅうりょく"],
  ["乱数", "らんすう"], ["削除", "さくじょ"], ["追加", "ついか"], ["検索", "けんさく"], ["探", "さがす"], ["繰り返", "くりかえし"], ["くり返", "くりかえし"],
  ["回数", "かいすう"], ["条件", "じょうけん"], ["保存", "ほぞん"], ["合計", "ごうけい"], ["平均", "へいきん"], ["最大", "さいだい"],
  ["最小", "さいしょう"], ["文字列", "もじれつ"], ["文字", "もじ"], ["数", "かず すう"], ["日付", "ひづけ"], ["時刻", "じこく"],
  ["時間", "じかん"], ["待", "まつ"], ["関数", "かんすう"], ["変数", "へんすう"], ["配列", "はいれつ"], ["辞書", "じしょ"],
  ["分ける", "わける"], ["置き換", "おきかえ"], ["変換", "へんかん"], ["計算", "けいさん"], ["四捨五入", "ししゃごにゅう"],
  ["移動", "いどう"], ["回転", "かいてん"], ["当たり", "あたり"], ["衝突", "しょうとつ"], ["音", "おと"], ["画像", "がぞう"],
  ["背景", "はいけい"], ["色", "いろ"], ["真ん中", "まんなか"], ["横", "よこ"], ["重複", "ちょうふく"], ["偶数", "ぐうすう"],
  ["奇数", "きすう"], ["例外", "れいがい"], ["終了", "しゅうりょう"], ["一覧", "いちらん"], ["作", "つくる"], ["取り出", "とりだす"],
];
function withReadings(s: string): string {
  let out = s;
  for (const [k, r] of READINGS) if (s.includes(k)) out += " " + r;
  return out;
}

/** 言語の中から探す。query が空なら全部（分類順） */
export function searchDict(langId: string, query: string, category?: string): DictHit[] {
  const lang = DICT_LANGUAGES.find((l) => l.id === langId);
  const all: Omit<DictHit, "score">[] = [
    ...userEntries()
      .filter((u) => u.lang === langId)
      .map((u) => ({ lang: u.lang, category: "自分の辞書", title: u.title, keys: u.keys ?? "", code: u.code, user: true })),
    ...(lang?.entries.map((e) => toHit(langId, e)) ?? []),
  ];
  const inCat = category ? all.filter((h) => h.category === category) : all;
  const terms = normalizeQuery(query).split(/[\s　]+/).filter(Boolean);
  if (!terms.length) return inCat.map((h, i) => ({ ...h, score: -i }));
  const hits: DictHit[] = [];
  for (const h of inCat) {
    const title = normalizeQuery(withReadings(h.title));
    const keys = normalizeQuery(withReadings(h.keys));
    const hay = `${title} ${keys} ${normalizeQuery(withReadings(h.category))} ${normalizeQuery(h.code)}`;
    let score = 0;
    let ok = true;
    for (const t of terms) {
      if (title.includes(t)) score += 10;
      else if (keys.includes(t)) score += 6;
      else if (hay.includes(t)) score += 2;
      else {
        ok = false;
        break;
      }
    }
    if (ok) hits.push({ ...h, score: score + (h.user ? 3 : 0) - h.title.length / 100 });
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** 分類の一覧（出てくる順） */
export function categories(langId: string): string[] {
  const lang = DICT_LANGUAGES.find((l) => l.id === langId);
  const list = [...new Set(lang?.entries.map((e) => e[0]) ?? [])];
  if (userEntries().some((u) => u.lang === langId)) list.unshift("自分の辞書");
  return list;
}

/** ⟨名前⟩ を取った、そのままのコード（コピー用・見せる用） */
export function plainCode(code: string): string {
  return code.replace(/⟨([^⟩]*)⟩/g, "$1");
}

/**
 * エディタのひな形の書き方に変える。
 * ⟨名前⟩ → Tab で順に書き換えられる場所、⟨⟩ → 最後のカーソル位置。
 * コードの中の { } は、ひな形の印と間違えないように \{ \} にする。行頭のスペース 4 つはそのファイルの字下げに合わせる
 */
export function toSnippetTemplate(code: string): string {
  const escaped = code
    .split(/(⟨[^⟩]*⟩)/)
    .map((part) => {
      const m = /^⟨([^⟩]*)⟩$/.exec(part);
      if (m) return `\${${m[1].replace(/[{}]/g, (b) => "\\" + b)}}`;
      return part.replace(/[{}]/g, (b) => "\\" + b);
    })
    .join("");
  return escaped
    .split("\n")
    .map((l) => l.replace(/^((?: {4})+)/, (sp) => "\t".repeat(sp.length / 4)))
    .join("\n");
}
