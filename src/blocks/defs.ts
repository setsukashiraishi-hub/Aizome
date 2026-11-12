// ブロックでプログラムを作るモードの、ブロックの定義と、Python・JavaScript のコードへの変え方。
// Blockly にもとからあるブロック（if・くり返し・計算・文字・リスト・変数・関数）に、
// 足りないもの（表示と入力・辞書・クラス・import・エラー処理・ファイル・その他）を足す。
import * as Blockly from "blockly/core";
import "blockly/blocks";
import * as ja from "blockly/msg/ja";
import { pythonGenerator, Order as PyOrder } from "blockly/python";
import { javascriptGenerator, Order as JsOrder } from "blockly/javascript";
import { generateTyped } from "./typedGen";

export type BlockLang = "python" | "javascript" | "go" | "cpp" | "csharp";

/** 言語の名前と、保存するときの拡張子 */
export const BLOCK_LANGS: { id: BlockLang; label: string; ext: string }[] = [
  { id: "python", label: "Python", ext: ".py" },
  { id: "javascript", label: "JavaScript", ext: ".js" },
  { id: "go", label: "Go", ext: ".go" },
  { id: "cpp", label: "C++", ext: ".cpp" },
  { id: "csharp", label: "C#", ext: ".cs" },
];

// ───────── 日本語（もとの訳を、藍染のやさしい言い方に少し直す）

let ready = false;

export function setupBlockly(): void {
  if (ready) return;
  ready = true;
  Blockly.setLocale(ja as unknown as { [key: string]: string });
  const M = Blockly.Msg as Record<string, string>;
  Object.assign(M, {
    CONTROLS_IF_MSG_IF: "もし",
    CONTROLS_IF_MSG_ELSEIF: "そうでなく、もし",
    CONTROLS_IF_MSG_ELSE: "そうでなければ",
    CONTROLS_IF_MSG_THEN: "なら",
    CONTROLS_REPEAT_TITLE: "%1 回くり返す",
    CONTROLS_REPEAT_INPUT_DO: "",
    CONTROLS_WHILEUNTIL_OPERATOR_WHILE: "次が正しいあいだ、くり返す",
    CONTROLS_WHILEUNTIL_OPERATOR_UNTIL: "次が正しくなるまで、くり返す",
    CONTROLS_FOR_TITLE: "%1 を %2 から %3 まで %4 ずつ変えながら、くり返す",
    CONTROLS_FOREACH_TITLE: "%2 の中身を 1 つずつ %1 に入れて、くり返す",
    CONTROLS_FLOW_STATEMENTS_OPERATOR_BREAK: "くり返しをやめる（break）",
    CONTROLS_FLOW_STATEMENTS_OPERATOR_CONTINUE: "次のくり返しへ進む（continue）",
    VARIABLES_SET: "%1 を %2 にする",
    MATH_CHANGE_TITLE: "%1 を %2 増やす",
    TEXT_PRINT_TITLE: "%1 を表示する",
    TEXT_JOIN_TITLE_CREATEWITH: "つなげた文字",
    LISTS_CREATE_WITH_INPUT_WITH: "リストを作る",
    LISTS_CREATE_EMPTY_TITLE: "空のリスト",
    NEW_VARIABLE: "変数を作る…",
    NEW_VARIABLE_TITLE: "新しい変数の名前：",
    PROCEDURES_DEFNORETURN_PROCEDURE: "なにかする",
    PROCEDURES_DEFNORETURN_TITLE: "関数",
    PROCEDURES_DEFRETURN_TITLE: "関数",
    PROCEDURES_DEFRETURN_RETURN: "返す値",
    PROCEDURES_BEFORE_PARAMS: "受け取るもの：",
    PROCEDURES_CALL_BEFORE_PARAMS: "わたすもの：",
    LOGIC_BOOLEAN_TRUE: "正しい（True）",
    LOGIC_BOOLEAN_FALSE: "まちがい（False）",
    LOGIC_NULL: "なし（None）",
    LOGIC_OPERATION_AND: "かつ",
    LOGIC_OPERATION_OR: "または",
    LOGIC_NEGATE_TITLE: "%1 ではない",
    LOGIC_TERNARY_CONDITION: "もし",
    LOGIC_TERNARY_IF_TRUE: "なら",
    LOGIC_TERNARY_IF_FALSE: "でなければ",
    MATH_RANDOM_INT_TITLE: "%1 から %2 までの、でたらめな整数",
  });
  patchNames();
  defineBlocks();
  defineGenerators();
}

/**
 * Blockly は日本語の変数名を「_E5_90_88」のような記号に変えてしまう。
 * Python も JavaScript も日本語の名前が使えるので、そのまま使う（空白は _ に）
 */
function patchNames() {
  const proto = Blockly.Names.prototype as unknown as { safeName: (name: string) => string };
  proto.safeName = function (name: string) {
    if (!name) return "unnamed";
    let s = name.replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_$]/gu, "_");
    if (/^\p{N}/u.test(s)) s = "_" + s;
    return s;
  };
}

// ───────── 色（和色。明るさと鮮やかさをそろえて、白い文字が読みやすい濃さに）

export const COLORS = {
  io: "#7F72CC", // 藤
  variable: "#DD6B3D", // 柿
  math: "#4E9F5E", // 若竹
  text: "#2E98B0", // 浅葱
  logic: "#D29A24", // 山吹
  loop: "#C9792E", // 琥珀
  list: "#E07362", // 珊瑚
  dict: "#B35CAF", // 牡丹
  func: "#D3618A", // 紅梅
  class: "#4A6CC9", // 群青
  import: "#3A9E8C", // 青磁
  error: "#B5404F", // 茜
  file: "#8F6E4E", // 胡桃
  other: "#7A8496", // 銀鼠
};

/** 色の名前（ヘルプ・ツールチップ用） */
export const COLOR_NAMES: Record<keyof typeof COLORS, string> = {
  io: "藤", variable: "柿", math: "若竹", text: "浅葱", logic: "山吹", loop: "琥珀", list: "珊瑚",
  dict: "牡丹", func: "紅梅", class: "群青", import: "青磁", error: "茜", file: "胡桃", other: "銀鼠",
};

// ───────── ブロック

type Json = Record<string, unknown>;
const stmt = (o: Json): Json => ({ previousStatement: null, nextStatement: null, ...o });
const val = (name: string, check?: string | string[]): Json => ({ type: "input_value", name, ...(check ? { check } : {}) });
const text = (name: string, value: string): Json => ({ type: "field_input", name, text: value });
const body = (name: string): Json => ({ type: "input_statement", name });

const ERROR_TYPES: [string, string][] = [
  ["どんなエラーでも", "Exception"],
  ["値のまちがい（ValueError）", "ValueError"],
  ["0 で割った（ZeroDivisionError）", "ZeroDivisionError"],
  ["番号が範囲の外（IndexError）", "IndexError"],
  ["辞書にないキー（KeyError）", "KeyError"],
  ["型のまちがい（TypeError）", "TypeError"],
  ["ファイルがない（FileNotFoundError）", "FileNotFoundError"],
];

/** 読み込むモジュールの候補（言語ごと）。モードの言語が変わると変わる */
let currentLang: BlockLang = "python";
export function setBlockLang(lang: BlockLang) {
  currentLang = lang;
}
const PY_MODULES = ["math", "random", "time", "datetime", "os", "sys", "re", "json", "csv", "statistics", "collections", "itertools", "string", "turtle", "tkinter"];
const JS_MODULES = ["fs", "path", "os", "readline", "util", "crypto", "events", "child_process"];
const GO_MODULES = ["fmt", "math", "strings", "strconv", "os", "time", "sort", "bufio", "math/rand", "unicode/utf8", "errors"];
const CPP_MODULES = ["iostream", "string", "vector", "map", "set", "cmath", "algorithm", "fstream", "sstream", "random", "chrono", "thread", "numeric"];
const CS_MODULES = ["System", "System.Collections.Generic", "System.Linq", "System.IO", "System.Text", "System.Threading"];
function moduleOptions(): [string, string][] {
  const list = { python: PY_MODULES, javascript: JS_MODULES, go: GO_MODULES, cpp: CPP_MODULES, csharp: CS_MODULES }[currentLang];
  return list.map((m) => [m, m]);
}

function defineBlocks() {
  Blockly.common.defineBlocksWithJsonArray([
    // ── 表示と入力
    stmt({ type: "aiz_print_end", message0: "%1 を表示する（改行しない）", args0: [val("VALUE")], colour: COLORS.io, tooltip: "続けて表示するときに使います" }),
    stmt({ type: "aiz_print_many", message0: "%1 と %2 を表示する", args0: [val("A"), val("B")], inputsInline: true, colour: COLORS.io, tooltip: "2 つの値を空白でつないで表示します" }),
    { type: "aiz_input_text", message0: "「%1」と聞いて、入力された文字", args0: [text("Q", "名前は？")], output: "String", colour: COLORS.io, tooltip: "キーボードから文字を入力してもらいます" },
    { type: "aiz_input_int", message0: "「%1」と聞いて、入力された整数", args0: [text("Q", "数を入れてください")], output: "Number", colour: COLORS.io, tooltip: "入力を整数にして使います" },
    { type: "aiz_input_float", message0: "「%1」と聞いて、入力された小数", args0: [text("Q", "数を入れてください")], output: "Number", colour: COLORS.io, tooltip: "入力を小数にして使います" },
    { type: "aiz_fstring", message0: "埋めこみ文字 %1", args0: [text("TEXT", "合計は {合計} です")], output: "String", colour: COLORS.io, tooltip: "{ } の中に変数や式を書くと、その値が入ります（Python の f 文字列）" },
    { type: "aiz_newline", message0: "改行", output: "String", colour: COLORS.text, tooltip: "改行の文字（\\n）。つなげた文字の中で使います" },
    stmt({ type: "aiz_comment", message0: "メモ：%1", args0: [text("TEXT", "ここに説明を書く")], colour: COLORS.other, tooltip: "プログラムには影響しないメモ（コメント）" }),

    // ── 計算・型
    { type: "aiz_convert", message0: "%1 を %2 にしたもの", args0: [val("VALUE"), { type: "field_dropdown", name: "TO", options: [["整数", "int"], ["小数", "float"], ["文字", "str"], ["真偽値", "bool"]] }], inputsInline: true, output: null, colour: COLORS.math, tooltip: "型を変えます（int・float・str・bool）" },
    { type: "aiz_typeof", message0: "%1 の型", args0: [val("VALUE")], output: "String", colour: COLORS.math, tooltip: "値の種類を調べます" },
    { type: "aiz_in", message0: "%1 が %2 に入っている", args0: [val("ITEM"), val("COLLECTION")], inputsInline: true, output: "Boolean", colour: COLORS.logic, tooltip: "リスト・文字・辞書の中にあるかどうか（in）" },

    // ── リスト
    stmt({ type: "aiz_list_append", message0: "リスト %1 に %2 を追加する", args0: [val("LIST"), val("ITEM")], inputsInline: true, colour: COLORS.list, tooltip: "リストの最後に足します（append）" }),

    // ── 辞書
    { type: "aiz_dict_empty", message0: "空の辞書", output: "Dict", colour: COLORS.dict, tooltip: "キーと値の表を作ります" },
    { type: "aiz_dict_create", message0: "辞書を作る %1 : %2 、 %3 : %4", args0: [val("K1"), val("V1"), val("K2"), val("V2")], inputsInline: true, output: "Dict", colour: COLORS.dict, tooltip: "キーと値を 2 組まで入れて作ります（空いている組は使いません）" },
    stmt({ type: "aiz_dict_set", message0: "辞書 %1 の %2 を %3 にする", args0: [val("DICT"), val("KEY"), val("VALUE")], inputsInline: true, colour: COLORS.dict }),
    { type: "aiz_dict_get", message0: "辞書 %1 の %2", args0: [val("DICT"), val("KEY")], inputsInline: true, output: null, colour: COLORS.dict, tooltip: "キーの値を取り出します（ないとエラー）" },
    { type: "aiz_dict_get_default", message0: "辞書 %1 の %2（なければ %3）", args0: [val("DICT"), val("KEY"), val("DEFAULT")], inputsInline: true, output: null, colour: COLORS.dict, tooltip: "キーがないときは、かわりの値を使います（get）" },
    { type: "aiz_dict_has", message0: "辞書 %1 にキー %2 がある", args0: [val("DICT"), val("KEY")], inputsInline: true, output: "Boolean", colour: COLORS.dict },
    stmt({ type: "aiz_dict_delete", message0: "辞書 %1 から %2 を消す", args0: [val("DICT"), val("KEY")], inputsInline: true, colour: COLORS.dict }),
    { type: "aiz_dict_keys", message0: "辞書 %1 の %2 のリスト", args0: [val("DICT"), { type: "field_dropdown", name: "WHAT", options: [["キー", "keys"], ["値", "values"]] }], inputsInline: true, output: "Array", colour: COLORS.dict },
    { type: "aiz_dict_len", message0: "辞書 %1 の項目の数", args0: [val("DICT")], output: "Number", colour: COLORS.dict },
    stmt({ type: "aiz_dict_loop", message0: "辞書 %1 のキーと値を 1 組ずつ %2 と %3 に入れて、くり返す %4 %5", args0: [val("DICT"), { type: "field_variable", name: "K", variable: "キー" }, { type: "field_variable", name: "V", variable: "値" }, { type: "input_dummy" }, body("DO")], colour: COLORS.dict }),

    // ── 関数（返す）
    stmt({ type: "aiz_return", message0: "%1 を返す（return）", args0: [val("VALUE")], nextStatement: undefined, colour: COLORS.func, tooltip: "関数をここで終わり、値を返します" }),

    // ── クラス
    stmt({ type: "aiz_class", message0: "クラス %1 を作る %2 %3", args0: [text("NAME", "ネコ"), { type: "input_dummy" }, body("BODY")], colour: COLORS.class, tooltip: "オブジェクトの設計図を作ります" }),
    stmt({ type: "aiz_class_init", message0: "作るときの準備（受け取るもの：%1） %2 %3", args0: [text("PARAMS", "名前"), { type: "input_dummy" }, body("BODY")], colour: COLORS.class, tooltip: "オブジェクトを作るときに 1 回動きます（__init__・constructor）" }),
    stmt({ type: "aiz_method", message0: "メソッド %1（受け取るもの：%2） %3 %4", args0: [text("NAME", "鳴く"), text("PARAMS", ""), { type: "input_dummy" }, body("BODY")], colour: COLORS.class, tooltip: "オブジェクトができること（メソッド）" }),
    stmt({ type: "aiz_self_set", message0: "自分の %1 を %2 にする", args0: [text("ATTR", "名前"), val("VALUE")], colour: COLORS.class, tooltip: "self.名前 = 値" }),
    { type: "aiz_self_get", message0: "自分の %1", args0: [text("ATTR", "名前")], output: null, colour: COLORS.class, tooltip: "self.名前" },
    { type: "aiz_new", message0: "%1 を作る（わたすもの %2 %3 %4 ）", args0: [text("CLASS", "ネコ"), val("A1"), val("A2"), val("A3")], inputsInline: true, output: null, colour: COLORS.class, tooltip: "クラスからオブジェクトを作ります（空いている所は使いません）" },
    stmt({ type: "aiz_call_method", message0: "%1 の %2 を呼ぶ（わたすもの %3 %4 %5 ）", args0: [val("OBJ"), text("METHOD", "鳴く"), val("A1"), val("A2"), val("A3")], inputsInline: true, colour: COLORS.class }),
    { type: "aiz_call_method_value", message0: "%1 の %2 の結果（わたすもの %3 %4 %5 ）", args0: [val("OBJ"), text("METHOD", "upper"), val("A1"), val("A2"), val("A3")], inputsInline: true, output: null, colour: COLORS.class },
    { type: "aiz_attr_get", message0: "%1 の %2", args0: [val("OBJ"), text("ATTR", "名前")], inputsInline: true, output: null, colour: COLORS.class },
    stmt({ type: "aiz_attr_set", message0: "%1 の %2 を %3 にする", args0: [val("OBJ"), text("ATTR", "名前"), val("VALUE")], inputsInline: true, colour: COLORS.class }),

    // ── 読み込み（import）
    stmt({ type: "aiz_import", message0: "%1 を読み込む（import）", args0: [{ type: "field_dropdown", name: "MODULE", options: moduleOptions }], colour: COLORS.import }),
    stmt({ type: "aiz_import_text", message0: "%1 を読み込む（import）", args0: [text("MODULE", "math")], colour: COLORS.import, tooltip: "一覧にないモジュールは、名前を書いて読み込みます" }),
    stmt({ type: "aiz_from_import", message0: "%1 から %2 を読み込む", args0: [text("MODULE", "math"), text("NAMES", "sqrt, pi")], colour: COLORS.import, tooltip: "from 〜 import 〜" }),
    stmt({ type: "aiz_import_as", message0: "%1 を %2 という名前で読み込む", args0: [text("MODULE", "datetime"), text("AS", "dt")], colour: COLORS.import, tooltip: "import 〜 as 〜" }),
    { type: "aiz_module_value", message0: "%1 . %2 （わたすもの %3 %4 %5 ）", args0: [text("MODULE", "math"), text("FUNC", "sqrt"), val("A1"), val("A2"), val("A3")], inputsInline: true, output: null, colour: COLORS.import, tooltip: "読み込んだモジュールの関数を使った結果" },
    stmt({ type: "aiz_module_call", message0: "%1 . %2 を呼ぶ（わたすもの %3 %4 %5 ）", args0: [text("MODULE", "time"), text("FUNC", "sleep"), val("A1"), val("A2"), val("A3")], inputsInline: true, colour: COLORS.import }),
    { type: "aiz_module_const", message0: "%1 . %2", args0: [text("MODULE", "math"), text("NAME", "pi")], output: null, colour: COLORS.import, tooltip: "モジュールの値（math.pi など）" },

    // ── エラー処理
    stmt({ type: "aiz_try", message0: "ためしに動かす（try） %1 %2 %3 が起きたら（except） %4 %5", args0: [{ type: "input_dummy" }, body("TRY"), { type: "field_dropdown", name: "ERR", options: ERROR_TYPES }, { type: "input_dummy" }, body("EXCEPT")], colour: COLORS.error }),
    stmt({ type: "aiz_try_finally", message0: "ためしに動かす（try） %1 %2 %3 が起きたら（except） %4 %5 最後に、かならず（finally） %6 %7", args0: [{ type: "input_dummy" }, body("TRY"), { type: "field_dropdown", name: "ERR", options: ERROR_TYPES }, { type: "input_dummy" }, body("EXCEPT"), { type: "input_dummy" }, body("FINALLY")], colour: COLORS.error }),
    { type: "aiz_error_message", message0: "エラーの内容", output: "String", colour: COLORS.error, tooltip: "except の中で、起きたエラーのメッセージ" },
    stmt({ type: "aiz_raise", message0: "エラー %1 を起こす（メッセージ %2 ）", args0: [{ type: "field_dropdown", name: "ERR", options: ERROR_TYPES.slice(1).concat([["エラー（Exception）", "Exception"]]) }, val("MSG")], inputsInline: true, colour: COLORS.error }),

    // ── ファイル
    stmt({ type: "aiz_with_open", message0: "ファイル %1 を %2 で開いて、%3 として使う %4 %5", args0: [val("NAME"), { type: "field_dropdown", name: "MODE", options: [["読む", "r"], ["書く（上書き）", "w"], ["追記", "a"]] }, text("VAR", "f"), { type: "input_dummy" }, body("DO")], colour: COLORS.file, tooltip: "with open(…) as f:" }),
    { type: "aiz_file_read", message0: "%1 の中身ぜんぶ", args0: [text("VAR", "f")], output: "String", colour: COLORS.file },
    { type: "aiz_file_lines", message0: "%1 の行のリスト", args0: [text("VAR", "f")], output: "Array", colour: COLORS.file },
    stmt({ type: "aiz_file_write", message0: "%1 に %2 を書く", args0: [text("VAR", "f"), val("TEXT")], inputsInline: true, colour: COLORS.file }),
    { type: "aiz_read_file", message0: "ファイル %1 を読んだ中身", args0: [val("NAME")], output: "String", colour: COLORS.file, tooltip: "ファイルの中身を、まとめて文字として読みます" },

    // ── その他
    stmt({ type: "aiz_sleep", message0: "%1 秒待つ", args0: [val("SEC", "Number")], colour: COLORS.other }),
    stmt({ type: "aiz_pass", message0: "何もしない（pass）", colour: COLORS.other }),
    stmt({ type: "aiz_main", message0: "プログラムの始まり（main） %1 %2", args0: [{ type: "input_dummy" }, body("DO")], colour: COLORS.other, tooltip: 'if __name__ == "__main__":（ほかのファイルから読み込まれたときは動かない）' }),
    stmt({ type: "aiz_global", message0: "%1 を関数の外の変数として使う（global）", args0: [text("NAMES", "合計")], colour: COLORS.other }),
    stmt({ type: "aiz_code", message0: "コードを書く %1", args0: [text("CODE", "x = 1")], colour: COLORS.other, tooltip: "ブロックにないものは、ここにそのまま書けます" }),
    { type: "aiz_code_value", message0: "式 %1", args0: [text("CODE", "1 + 2")], output: null, colour: COLORS.other, tooltip: "ブロックにない式を、そのまま書けます" },
  ] as Json[]);
}

// ───────── コードへの変え方

type Gen = typeof pythonGenerator | typeof javascriptGenerator;

/** 空いている引数の入れ物は使わない */
function args(block: Blockly.Block, gen: Gen, names: string[]): string {
  return names
    .map((n) => (block.getInput(n)?.connection?.targetBlock() ? gen.valueToCode(block, n, 0) : ""))
    .filter(Boolean)
    .join(", ");
}

const q = (s: string) => JSON.stringify(s);
/** 名前の欄（空白などを _ に） */
const ident = (s: string) => s.trim().replace(/\s+/g, "_") || "_";
const params = (s: string) =>
  s
    .split(/[,、]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(ident);

/** JavaScript で input() を使えるようにする（キーボードから 1 行読む） */
function jsInput(gen: typeof javascriptGenerator): string {
  return gen.provideFunction_("input", [
    `function ${gen.FUNCTION_NAME_PLACEHOLDER_}(message = "") {`,
    "  // キーボードから 1 行読む（node で動かすとき）",
    "  process.stdout.write(String(message));",
    "  const fs = require(\"fs\");",
    "  const bytes = [];",
    "  const one = Buffer.alloc(1);",
    "  for (;;) {",
    "    let n = 0;",
    "    try {",
    "      n = fs.readSync(0, one, 0, 1, null);",
    "    } catch (e) {",
    "      if (e.code === \"EAGAIN\") continue;",
    "      break;",
    "    }",
    "    if (n === 0 || one[0] === 10) break;",
    "    bytes.push(one[0]);",
    "  }",
    "  return Buffer.from(bytes).toString(\"utf8\").replace(/\\r$/, \"\");",
    "}",
  ]);
}

/** JavaScript で、数にできないときに Python と同じくエラーにする（そのままだと NaN になって気づけない） */
function jsToNumber(gen: typeof javascriptGenerator): string {
  return gen.provideFunction_("toNumber", [
    `function ${gen.FUNCTION_NAME_PLACEHOLDER_}(value, integer) {`,
    "  const n = Number(String(value).trim());",
    "  if (String(value).trim() === \"\" || Number.isNaN(n)) throw new Error(`数にできません: ${value}`);",
    "  return integer ? Math.trunc(n) : n;",
    "}",
  ]);
}

/** JavaScript でファイルを with のように使う道具 */
function jsOpenFile(gen: typeof javascriptGenerator): string {
  return gen.provideFunction_("openFile", [
    `function ${gen.FUNCTION_NAME_PLACEHOLDER_}(name, mode) {`,
    "  // ファイルを開く（r：読む・w：書く・a：追記）。最後に close() で書きこむ",
    "  const fs = require(\"fs\");",
    "  let buf = mode === \"r\" ? fs.readFileSync(name, \"utf8\") : \"\";",
    "  return {",
    "    read: () => buf,",
    "    readlines: () => buf.split(/(?<=\\n)/),",
    "    write: (s) => { buf += String(s); },",
    "    close: () => { if (mode === \"w\") fs.writeFileSync(name, buf); else if (mode === \"a\") fs.appendFileSync(name, buf); },",
    "  };",
    "}",
  ]);
}

const JS_ERROR_NOTE: Record<string, string> = {
  ValueError: "値のまちがい",
  ZeroDivisionError: "0 で割った（JavaScript では Infinity になり、エラーにはなりません）",
  IndexError: "番号が範囲の外（JavaScript では undefined になります）",
  KeyError: "辞書にないキー（JavaScript では undefined になります）",
  TypeError: "型のまちがい",
  FileNotFoundError: "ファイルがない",
};

function defineGenerators() {
  const py = pythonGenerator;
  const js = javascriptGenerator;
  py.INDENT = "    ";
  const P = py.forBlock as Record<string, (b: Blockly.Block, g: typeof py) => string | [string, number]>;
  const J = js.forBlock as Record<string, (b: Blockly.Block, g: typeof js) => string | [string, number]>;
  const pyBody = (b: Blockly.Block, name: string) => py.statementToCode(b, name) || py.INDENT + "pass\n";
  const jsBody = (b: Blockly.Block, name: string) => js.statementToCode(b, name);

  // ── 表示と入力（JavaScript は node で動くように console.log と input()）
  J["text_print"] = (b) => `console.log(${js.valueToCode(b, "TEXT", JsOrder.NONE) || "''"});\n`;
  J["text_prompt_ext"] = (b) => {
    const fn = jsInput(js);
    const msg = b.getField("TEXT") ? q(b.getFieldValue("TEXT")) : js.valueToCode(b, "TEXT", JsOrder.NONE) || "''";
    const code = b.getFieldValue("TYPE") === "NUMBER" ? `Number(${fn}(${msg}))` : `${fn}(${msg})`;
    return [code, JsOrder.FUNCTION_CALL];
  };
  P["aiz_print_end"] = (b) => `print(${py.valueToCode(b, "VALUE", PyOrder.NONE) || "''"}, end="")\n`;
  J["aiz_print_end"] = (b) => `process.stdout.write(String(${js.valueToCode(b, "VALUE", JsOrder.NONE) || "''"}));\n`;
  P["aiz_print_many"] = (b) => `print(${py.valueToCode(b, "A", PyOrder.NONE) || "''"}, ${py.valueToCode(b, "B", PyOrder.NONE) || "''"})\n`;
  J["aiz_print_many"] = (b) => `console.log(${js.valueToCode(b, "A", JsOrder.NONE) || "''"}, ${js.valueToCode(b, "B", JsOrder.NONE) || "''"});\n`;
  P["aiz_input_text"] = (b) => [`input(${q(b.getFieldValue("Q"))})`, PyOrder.FUNCTION_CALL];
  J["aiz_input_text"] = (b) => [`${jsInput(js)}(${q(b.getFieldValue("Q"))})`, JsOrder.FUNCTION_CALL];
  P["aiz_input_int"] = (b) => [`int(input(${q(b.getFieldValue("Q"))}))`, PyOrder.FUNCTION_CALL];
  J["aiz_input_int"] = (b) => [`${jsToNumber(js)}(${jsInput(js)}(${q(b.getFieldValue("Q"))}), true)`, JsOrder.FUNCTION_CALL];
  P["aiz_input_float"] = (b) => [`float(input(${q(b.getFieldValue("Q"))}))`, PyOrder.FUNCTION_CALL];
  J["aiz_input_float"] = (b) => [`${jsToNumber(js)}(${jsInput(js)}(${q(b.getFieldValue("Q"))}), false)`, JsOrder.FUNCTION_CALL];
  P["aiz_fstring"] = (b) => [`f${q(b.getFieldValue("TEXT"))}`, PyOrder.ATOMIC];
  J["aiz_fstring"] = (b) => ["`" + String(b.getFieldValue("TEXT")).replace(/[`\\]/g, "\\$&").replace(/\{([^{}]+)\}/g, "${$1}") + "`", JsOrder.ATOMIC];
  P["aiz_newline"] = () => ['"\\n"', PyOrder.ATOMIC];
  J["aiz_newline"] = () => ['"\\n"', JsOrder.ATOMIC];
  // Blockly のままだと、数のリストを「つなげた文字」にできない（','.join は文字だけ）
  const pySplit = P["lists_split"];
  P["lists_split"] = (b, g) => {
    if (b.getFieldValue("MODE") !== "JOIN") return pySplit(b, g);
    const list = py.valueToCode(b, "INPUT", PyOrder.NONE) || "[]";
    const delim = py.valueToCode(b, "DELIM", PyOrder.MEMBER) || "''";
    return [`${delim}.join(str(x) for x in ${list})`, PyOrder.FUNCTION_CALL];
  };
  P["aiz_comment"] = (b) => `# ${b.getFieldValue("TEXT")}\n`;
  J["aiz_comment"] = (b) => `// ${b.getFieldValue("TEXT")}\n`;

  // ── 計算・型
  P["aiz_convert"] = (b) => [`${b.getFieldValue("TO")}(${py.valueToCode(b, "VALUE", PyOrder.NONE) || "0"})`, PyOrder.FUNCTION_CALL];
  J["aiz_convert"] = (b) => {
    const v = js.valueToCode(b, "VALUE", JsOrder.NONE) || "0";
    const to = b.getFieldValue("TO");
    const code = to === "int" ? `${jsToNumber(js)}(${v}, true)` : to === "float" ? `${jsToNumber(js)}(${v}, false)` : to === "str" ? `String(${v})` : `Boolean(${v})`;
    return [code, JsOrder.FUNCTION_CALL];
  };
  P["aiz_typeof"] = (b) => [`type(${py.valueToCode(b, "VALUE", PyOrder.NONE) || "None"}).__name__`, PyOrder.MEMBER];
  J["aiz_typeof"] = (b) => [`typeof ${js.valueToCode(b, "VALUE", JsOrder.TYPEOF) || "undefined"}`, JsOrder.TYPEOF];
  P["aiz_in"] = (b) => [`${py.valueToCode(b, "ITEM", PyOrder.RELATIONAL) || "None"} in ${py.valueToCode(b, "COLLECTION", PyOrder.RELATIONAL) || "[]"}`, PyOrder.RELATIONAL];
  J["aiz_in"] = (b) => {
    const item = js.valueToCode(b, "ITEM", JsOrder.NONE) || "undefined";
    const coll = js.valueToCode(b, "COLLECTION", JsOrder.MEMBER) || "[]";
    return [`(Array.isArray(${coll}) || typeof ${coll} === "string" ? ${coll}.includes(${item}) : ${item} in ${coll})`, JsOrder.ATOMIC];
  };

  // ── リスト
  P["aiz_list_append"] = (b) => `${py.valueToCode(b, "LIST", PyOrder.MEMBER) || "[]"}.append(${py.valueToCode(b, "ITEM", PyOrder.NONE) || "None"})\n`;
  J["aiz_list_append"] = (b) => `${js.valueToCode(b, "LIST", JsOrder.MEMBER) || "[]"}.push(${js.valueToCode(b, "ITEM", JsOrder.NONE) || "undefined"});\n`;

  // ── 辞書（JavaScript はオブジェクト）
  P["aiz_dict_empty"] = () => ["{}", PyOrder.ATOMIC];
  J["aiz_dict_empty"] = () => ["{}", JsOrder.ATOMIC];
  const pairs = (b: Blockly.Block, gen: Gen, sep: string) =>
    [1, 2]
      .filter((i) => b.getInput(`K${i}`)?.connection?.targetBlock())
      .map((i) => `${gen === js ? `[${gen.valueToCode(b, `K${i}`, 0)}]` : gen.valueToCode(b, `K${i}`, 0)}${sep}${gen.valueToCode(b, `V${i}`, 0) || (gen === js ? "undefined" : "None")}`)
      .join(", ");
  P["aiz_dict_create"] = (b) => [`{${pairs(b, py, ": ")}}`, PyOrder.ATOMIC];
  J["aiz_dict_create"] = (b) => [`{${pairs(b, js, ": ")}}`, JsOrder.ATOMIC];
  const pd = (b: Blockly.Block) => py.valueToCode(b, "DICT", PyOrder.MEMBER) || "{}";
  const jd = (b: Blockly.Block) => js.valueToCode(b, "DICT", JsOrder.MEMBER) || "{}";
  const pk = (b: Blockly.Block) => py.valueToCode(b, "KEY", PyOrder.NONE) || "None";
  const jk = (b: Blockly.Block) => js.valueToCode(b, "KEY", JsOrder.NONE) || "undefined";
  P["aiz_dict_set"] = (b) => `${pd(b)}[${pk(b)}] = ${py.valueToCode(b, "VALUE", PyOrder.NONE) || "None"}\n`;
  J["aiz_dict_set"] = (b) => `${jd(b)}[${jk(b)}] = ${js.valueToCode(b, "VALUE", JsOrder.ASSIGNMENT) || "undefined"};\n`;
  P["aiz_dict_get"] = (b) => [`${pd(b)}[${pk(b)}]`, PyOrder.MEMBER];
  J["aiz_dict_get"] = (b) => [`${jd(b)}[${jk(b)}]`, JsOrder.MEMBER];
  P["aiz_dict_get_default"] = (b) => [`${pd(b)}.get(${pk(b)}, ${py.valueToCode(b, "DEFAULT", PyOrder.NONE) || "None"})`, PyOrder.FUNCTION_CALL];
  J["aiz_dict_get_default"] = (b) => [`(${jd(b)}[${jk(b)}] ?? ${js.valueToCode(b, "DEFAULT", JsOrder.LOGICAL_OR) || "undefined"})`, JsOrder.ATOMIC];
  P["aiz_dict_has"] = (b) => [`${pk(b)} in ${pd(b)}`, PyOrder.RELATIONAL];
  J["aiz_dict_has"] = (b) => [`${jk(b)} in ${jd(b)}`, JsOrder.IN];
  P["aiz_dict_delete"] = (b) => `del ${pd(b)}[${pk(b)}]\n`;
  J["aiz_dict_delete"] = (b) => `delete ${jd(b)}[${jk(b)}];\n`;
  P["aiz_dict_keys"] = (b) => [`list(${pd(b)}.${b.getFieldValue("WHAT")}())`, PyOrder.FUNCTION_CALL];
  J["aiz_dict_keys"] = (b) => [`Object.${b.getFieldValue("WHAT")}(${jd(b)})`, JsOrder.FUNCTION_CALL];
  P["aiz_dict_len"] = (b) => [`len(${pd(b)})`, PyOrder.FUNCTION_CALL];
  J["aiz_dict_len"] = (b) => [`Object.keys(${jd(b)}).length`, JsOrder.MEMBER];
  P["aiz_dict_loop"] = (b) => `for ${py.getVariableName(b.getFieldValue("K"))}, ${py.getVariableName(b.getFieldValue("V"))} in ${pd(b)}.items():\n${pyBody(b, "DO")}`;
  J["aiz_dict_loop"] = (b) => `for ([${js.getVariableName(b.getFieldValue("K"))}, ${js.getVariableName(b.getFieldValue("V"))}] of Object.entries(${jd(b)})) {\n${jsBody(b, "DO")}}\n`;

  // ── 関数
  P["aiz_return"] = (b) => `return${b.getInput("VALUE")?.connection?.targetBlock() ? " " + py.valueToCode(b, "VALUE", PyOrder.NONE) : ""}\n`;
  J["aiz_return"] = (b) => `return${b.getInput("VALUE")?.connection?.targetBlock() ? " " + js.valueToCode(b, "VALUE", JsOrder.NONE) : ""};\n`;

  // ── クラス
  P["aiz_class"] = (b) => `class ${ident(b.getFieldValue("NAME"))}:\n${pyBody(b, "BODY")}\n`;
  J["aiz_class"] = (b) => `class ${ident(b.getFieldValue("NAME"))} {\n${jsBody(b, "BODY")}}\n\n`;
  P["aiz_class_init"] = (b) => `def __init__(${["self", ...params(b.getFieldValue("PARAMS"))].join(", ")}):\n${pyBody(b, "BODY")}`;
  J["aiz_class_init"] = (b) => `constructor(${params(b.getFieldValue("PARAMS")).join(", ")}) {\n${jsBody(b, "BODY")}}\n`;
  P["aiz_method"] = (b) => `def ${ident(b.getFieldValue("NAME"))}(${["self", ...params(b.getFieldValue("PARAMS"))].join(", ")}):\n${pyBody(b, "BODY")}`;
  J["aiz_method"] = (b) => `${ident(b.getFieldValue("NAME"))}(${params(b.getFieldValue("PARAMS")).join(", ")}) {\n${jsBody(b, "BODY")}}\n`;
  P["aiz_self_set"] = (b) => `self.${ident(b.getFieldValue("ATTR"))} = ${py.valueToCode(b, "VALUE", PyOrder.NONE) || "None"}\n`;
  J["aiz_self_set"] = (b) => `this.${ident(b.getFieldValue("ATTR"))} = ${js.valueToCode(b, "VALUE", JsOrder.ASSIGNMENT) || "undefined"};\n`;
  P["aiz_self_get"] = (b) => [`self.${ident(b.getFieldValue("ATTR"))}`, PyOrder.MEMBER];
  J["aiz_self_get"] = (b) => [`this.${ident(b.getFieldValue("ATTR"))}`, JsOrder.MEMBER];
  const A = ["A1", "A2", "A3"];
  P["aiz_new"] = (b) => [`${ident(b.getFieldValue("CLASS"))}(${args(b, py, A)})`, PyOrder.FUNCTION_CALL];
  J["aiz_new"] = (b) => [`new ${ident(b.getFieldValue("CLASS"))}(${args(b, js, A)})`, JsOrder.NEW];
  P["aiz_call_method"] = (b) => `${py.valueToCode(b, "OBJ", PyOrder.MEMBER) || "self"}.${ident(b.getFieldValue("METHOD"))}(${args(b, py, A)})\n`;
  J["aiz_call_method"] = (b) => `${js.valueToCode(b, "OBJ", JsOrder.MEMBER) || "this"}.${ident(b.getFieldValue("METHOD"))}(${args(b, js, A)});\n`;
  P["aiz_call_method_value"] = (b) => [`${py.valueToCode(b, "OBJ", PyOrder.MEMBER) || "self"}.${ident(b.getFieldValue("METHOD"))}(${args(b, py, A)})`, PyOrder.FUNCTION_CALL];
  J["aiz_call_method_value"] = (b) => [`${js.valueToCode(b, "OBJ", JsOrder.MEMBER) || "this"}.${ident(b.getFieldValue("METHOD"))}(${args(b, js, A)})`, JsOrder.FUNCTION_CALL];
  P["aiz_attr_get"] = (b) => [`${py.valueToCode(b, "OBJ", PyOrder.MEMBER) || "self"}.${ident(b.getFieldValue("ATTR"))}`, PyOrder.MEMBER];
  J["aiz_attr_get"] = (b) => [`${js.valueToCode(b, "OBJ", JsOrder.MEMBER) || "this"}.${ident(b.getFieldValue("ATTR"))}`, JsOrder.MEMBER];
  P["aiz_attr_set"] = (b) => `${py.valueToCode(b, "OBJ", PyOrder.MEMBER) || "self"}.${ident(b.getFieldValue("ATTR"))} = ${py.valueToCode(b, "VALUE", PyOrder.NONE) || "None"}\n`;
  J["aiz_attr_set"] = (b) => `${js.valueToCode(b, "OBJ", JsOrder.MEMBER) || "this"}.${ident(b.getFieldValue("ATTR"))} = ${js.valueToCode(b, "VALUE", JsOrder.ASSIGNMENT) || "undefined"};\n`;

  // ── 読み込み（import）
  const jsImport = (mod: string, as?: string) => `const ${ident(as ?? mod.split(/[./]/).pop()!)} = require(${q(mod)});\n`;
  P["aiz_import"] = (b) => `import ${b.getFieldValue("MODULE")}\n`;
  J["aiz_import"] = (b) => jsImport(b.getFieldValue("MODULE"));
  P["aiz_import_text"] = (b) => `import ${b.getFieldValue("MODULE").trim()}\n`;
  J["aiz_import_text"] = (b) => jsImport(b.getFieldValue("MODULE").trim());
  P["aiz_from_import"] = (b) => `from ${b.getFieldValue("MODULE").trim()} import ${params(b.getFieldValue("NAMES")).join(", ") || "*"}\n`;
  J["aiz_from_import"] = (b) => `const { ${params(b.getFieldValue("NAMES")).join(", ")} } = require(${q(b.getFieldValue("MODULE").trim())});\n`;
  P["aiz_import_as"] = (b) => `import ${b.getFieldValue("MODULE").trim()} as ${ident(b.getFieldValue("AS"))}\n`;
  J["aiz_import_as"] = (b) => jsImport(b.getFieldValue("MODULE").trim(), b.getFieldValue("AS"));
  const modCall = (b: Blockly.Block, gen: Gen) => `${b.getFieldValue("MODULE").trim()}.${b.getFieldValue("FUNC").trim()}(${args(b, gen, A)})`;
  P["aiz_module_value"] = (b) => [modCall(b, py), PyOrder.FUNCTION_CALL];
  J["aiz_module_value"] = (b) => [modCall(b, js), JsOrder.FUNCTION_CALL];
  P["aiz_module_call"] = (b) => modCall(b, py) + "\n";
  J["aiz_module_call"] = (b) => modCall(b, js) + ";\n";
  P["aiz_module_const"] = (b) => [`${b.getFieldValue("MODULE").trim()}.${b.getFieldValue("NAME").trim()}`, PyOrder.MEMBER];
  J["aiz_module_const"] = (b) => [`${b.getFieldValue("MODULE").trim()}.${b.getFieldValue("NAME").trim()}`, JsOrder.MEMBER];

  // ── エラー処理
  const pyTry = (b: Blockly.Block) => `try:\n${pyBody(b, "TRY")}except ${b.getFieldValue("ERR")} as e:\n${pyBody(b, "EXCEPT")}`;
  const jsTry = (b: Blockly.Block) => {
    const err = b.getFieldValue("ERR");
    const note = JS_ERROR_NOTE[err] ? `${js.INDENT}// ${err}：${JS_ERROR_NOTE[err]}\n` : "";
    return `try {\n${jsBody(b, "TRY")}} catch (e) {\n${note}${jsBody(b, "EXCEPT")}}`;
  };
  P["aiz_try"] = (b) => pyTry(b);
  J["aiz_try"] = (b) => jsTry(b) + "\n";
  P["aiz_try_finally"] = (b) => `${pyTry(b)}finally:\n${pyBody(b, "FINALLY")}`;
  J["aiz_try_finally"] = (b) => `${jsTry(b)} finally {\n${jsBody(b, "FINALLY")}}\n`;
  P["aiz_error_message"] = () => ["str(e)", PyOrder.FUNCTION_CALL];
  J["aiz_error_message"] = () => ["e.message", JsOrder.MEMBER];
  P["aiz_raise"] = (b) => `raise ${b.getFieldValue("ERR")}(${py.valueToCode(b, "MSG", PyOrder.NONE) || ""})\n`;
  J["aiz_raise"] = (b) => `throw new Error(${js.valueToCode(b, "MSG", JsOrder.NONE) || ""});\n`;

  // ── ファイル
  P["aiz_with_open"] = (b) => {
    const mode = b.getFieldValue("MODE");
    return `with open(${py.valueToCode(b, "NAME", PyOrder.NONE) || "'data.txt'"}, ${q(mode)}, encoding="utf-8") as ${ident(b.getFieldValue("VAR"))}:\n${pyBody(b, "DO")}`;
  };
  J["aiz_with_open"] = (b) => {
    const v = ident(b.getFieldValue("VAR"));
    return `{\n${js.INDENT}const ${v} = ${jsOpenFile(js)}(${js.valueToCode(b, "NAME", JsOrder.NONE) || "'data.txt'"}, ${q(b.getFieldValue("MODE"))});\n${jsBody(b, "DO")}${js.INDENT}${v}.close();\n}\n`;
  };
  P["aiz_file_read"] = (b) => [`${ident(b.getFieldValue("VAR"))}.read()`, PyOrder.FUNCTION_CALL];
  J["aiz_file_read"] = (b) => [`${ident(b.getFieldValue("VAR"))}.read()`, JsOrder.FUNCTION_CALL];
  P["aiz_file_lines"] = (b) => [`${ident(b.getFieldValue("VAR"))}.readlines()`, PyOrder.FUNCTION_CALL];
  J["aiz_file_lines"] = (b) => [`${ident(b.getFieldValue("VAR"))}.readlines()`, JsOrder.FUNCTION_CALL];
  P["aiz_file_write"] = (b) => `${ident(b.getFieldValue("VAR"))}.write(${py.valueToCode(b, "TEXT", PyOrder.NONE) || "''"})\n`;
  J["aiz_file_write"] = (b) => `${ident(b.getFieldValue("VAR"))}.write(${js.valueToCode(b, "TEXT", JsOrder.NONE) || "''"});\n`;
  P["aiz_read_file"] = (b) => [`open(${py.valueToCode(b, "NAME", PyOrder.NONE) || "'data.txt'"}, encoding="utf-8").read()`, PyOrder.FUNCTION_CALL];
  J["aiz_read_file"] = (b) => [`require("fs").readFileSync(${js.valueToCode(b, "NAME", JsOrder.NONE) || "'data.txt'"}, "utf8")`, JsOrder.FUNCTION_CALL];

  // ── その他
  P["aiz_sleep"] = (b) => {
    (py as unknown as { definitions_: Record<string, string> }).definitions_["import_time"] = "import time";
    return `time.sleep(${py.valueToCode(b, "SEC", PyOrder.NONE) || "1"})\n`;
  };
  J["aiz_sleep"] = (b) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (${js.valueToCode(b, "SEC", JsOrder.NONE) || "1"}) * 1000);\n`;
  P["aiz_pass"] = () => "pass\n";
  J["aiz_pass"] = () => "// 何もしない\n";
  P["aiz_main"] = (b) => `if __name__ == "__main__":\n${pyBody(b, "DO")}`;
  J["aiz_main"] = (b) => `// プログラムの始まり\n${js.statementToCode(b, "DO").replace(new RegExp(`^${js.INDENT}`, "gm"), "")}`;
  P["aiz_global"] = (b) => `global ${params(b.getFieldValue("NAMES")).join(", ")}\n`;
  J["aiz_global"] = (b) => `// ${params(b.getFieldValue("NAMES")).join("、")} は関数の外の変数を使います\n`;
  P["aiz_code"] = (b) => `${b.getFieldValue("CODE")}\n`;
  J["aiz_code"] = (b) => `${b.getFieldValue("CODE")}\n`;
  P["aiz_code_value"] = (b) => [b.getFieldValue("CODE"), PyOrder.ATOMIC];
  J["aiz_code_value"] = (b) => [b.getFieldValue("CODE"), JsOrder.ATOMIC];
}

/** ブロックからコードを作る */
export function workspaceToCode(ws: Blockly.Workspace, lang: BlockLang): string {
  if (lang === "go" || lang === "cpp" || lang === "csharp") return generateTyped(ws, lang);
  const gen = lang === "python" ? pythonGenerator : javascriptGenerator;
  let code = gen.workspaceToCode(ws);
  if (lang === "python") {
    // Blockly が先に書く「合計 = None」（変数の数だけ並ぶ）は、初めての人にはわかりにくいので消す
    // Blockly は「使っている変数」だけを並べる
    const n = Blockly.Variables.allUsedVarModels(ws).length;
    if (n) {
      const lines = code.split("\n");
      const isDecl = (l: string) => /^[\p{L}\p{N}_]+ = None$/u.test(l);
      for (let i = 0; i < lines.length; i++) {
        let j = i;
        while (j < lines.length && isDecl(lines[j])) j++;
        if (j - i === n) {
          lines.splice(i, n);
          break;
        }
        i = j;
      }
      code = lines.join("\n");
    }
  } else {
    // 「var 合計, 回数;」は let にして、1 行ずつ
    code = code.replace(/^var (.+);\n/m, (_, names: string) => names.split(/,\s*/).map((n) => `let ${n};`).join("\n") + "\n");
  }
  return code.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").trimEnd() + "\n";
}
