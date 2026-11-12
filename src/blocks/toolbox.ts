// ブロックの一覧（左のカテゴリ）。よく使う形は、最初から値を入れておく
import { COLORS } from "./defs";

type Item = Record<string, unknown>;

/** 値の入れ物に最初から入れておくもの（あとで別のブロックに置きかえられる） */
const num = (n: number) => ({ shadow: { type: "math_number", fields: { NUM: n } } });
const txt = (s: string) => ({ shadow: { type: "text", fields: { TEXT: s } } });
const blk = (type: string, extra: Item = {}): Item => ({ kind: "block", type, ...extra });
const label = (text: string): Item => ({ kind: "label", text });

function category(name: string, colour: string, contents: Item[], extra: Item = {}): Item {
  return { kind: "category", name, colour, contents, ...extra };
}

export function toolbox(): Item {
  return {
    kind: "categoryToolbox",
    contents: [
      category("表示と入力", COLORS.io, [
        blk("text_print", { inputs: { TEXT: txt("こんにちは") } }),
        blk("aiz_print_end", { inputs: { VALUE: txt("★") } }),
        blk("aiz_print_many", { inputs: { A: txt("合計"), B: num(10) } }),
        label("キーボードから入力"),
        blk("aiz_input_text"),
        blk("aiz_input_int"),
        blk("aiz_input_float"),
        label("文字に値を入れる"),
        blk("aiz_fstring"),
        blk("aiz_comment"),
      ]),
      category("変数", COLORS.variable, [], { custom: "VARIABLE" }),
      category("計算", COLORS.math, [
        blk("math_number"),
        blk("math_arithmetic", { inputs: { A: num(1), B: num(1) } }),
        blk("math_modulo", { inputs: { DIVIDEND: num(10), DIVISOR: num(3) } }),
        blk("math_single", { inputs: { NUM: num(9) } }),
        blk("math_round", { inputs: { NUM: num(3.1) } }),
        blk("math_number_property", { inputs: { NUMBER_TO_CHECK: num(0) } }),
        blk("math_random_int", { inputs: { FROM: num(1), TO: num(6) } }),
        blk("math_random_float"),
        blk("math_constrain", { inputs: { VALUE: num(50), LOW: num(1), HIGH: num(100) } }),
        blk("math_on_list", { fields: { OP: "SUM" } }),
        blk("math_constant"),
        blk("math_trig", { inputs: { NUM: num(45) } }),
        label("型"),
        blk("aiz_convert", { fields: { TO: "int" }, inputs: { VALUE: txt("123") } }),
        blk("aiz_typeof"),
      ]),
      category("文字", COLORS.text, [
        blk("text"),
        blk("text_join"),
        blk("aiz_newline"),
        blk("text_append", { inputs: { TEXT: txt("") } }),
        blk("text_length", { inputs: { VALUE: txt("abc") } }),
        blk("text_isEmpty", { inputs: { VALUE: txt("") } }),
        blk("text_indexOf", { inputs: { FIND: txt("a") } }),
        blk("text_charAt", { inputs: { AT: num(1) } }),
        blk("text_getSubstring"),
        blk("text_changeCase", { inputs: { TEXT: txt("abc") } }),
        blk("text_trim", { inputs: { TEXT: txt(" abc ") } }),
        blk("text_count", { inputs: { SUB: txt("a"), TEXT: txt("banana") } }),
        blk("text_replace", { inputs: { FROM: txt("a"), TO: txt("o"), TEXT: txt("banana") } }),
        blk("text_reverse", { inputs: { TEXT: txt("abc") } }),
      ]),
      category("条件（if）", COLORS.logic, [
        blk("controls_if"),
        blk("controls_if", { extraState: { hasElse: true } }),
        blk("controls_if", { extraState: { elseIfCount: 1, hasElse: true } }),
        blk("logic_compare"),
        blk("logic_operation"),
        blk("logic_negate"),
        blk("logic_boolean"),
        blk("logic_null"),
        blk("logic_ternary"),
        blk("aiz_in"),
      ]),
      category("くり返し", COLORS.loop, [
        blk("controls_repeat_ext", { inputs: { TIMES: num(10) } }),
        blk("controls_whileUntil"),
        blk("controls_for", { inputs: { FROM: num(1), TO: num(10), BY: num(1) } }),
        blk("controls_forEach"),
        blk("controls_flow_statements"),
        blk("controls_flow_statements", { fields: { FLOW: "CONTINUE" } }),
      ]),
      category("リスト", COLORS.list, [
        blk("lists_create_empty"),
        blk("lists_create_with"),
        blk("aiz_list_append"),
        blk("lists_repeat", { inputs: { NUM: num(5) } }),
        blk("lists_length"),
        blk("lists_isEmpty"),
        blk("lists_indexOf"),
        blk("lists_getIndex"),
        blk("lists_setIndex"),
        blk("lists_getSublist"),
        blk("lists_split", { inputs: { DELIM: txt(",") } }),
        blk("lists_sort"),
        blk("lists_reverse"),
      ]),
      category("辞書", COLORS.dict, [
        blk("aiz_dict_empty"),
        blk("aiz_dict_create", { inputs: { K1: txt("りんご"), V1: num(100), K2: txt("みかん"), V2: num(80) } }),
        blk("aiz_dict_set", { inputs: { KEY: txt("りんご"), VALUE: num(120) } }),
        blk("aiz_dict_get", { inputs: { KEY: txt("りんご") } }),
        blk("aiz_dict_get_default", { inputs: { KEY: txt("ぶどう"), DEFAULT: num(0) } }),
        blk("aiz_dict_has", { inputs: { KEY: txt("りんご") } }),
        blk("aiz_dict_delete", { inputs: { KEY: txt("りんご") } }),
        blk("aiz_dict_keys"),
        blk("aiz_dict_len"),
        blk("aiz_dict_loop"),
      ]),
      category("関数", COLORS.func, [blk("aiz_return")], { custom: "PROCEDURE" }),
      category("クラス", COLORS.class, [
        blk("aiz_class"),
        blk("aiz_class_init"),
        blk("aiz_method"),
        blk("aiz_self_set"),
        blk("aiz_self_get"),
        label("オブジェクトを使う"),
        blk("aiz_new", { inputs: { A1: txt("タマ") } }),
        blk("aiz_call_method"),
        blk("aiz_call_method_value"),
        blk("aiz_attr_get"),
        blk("aiz_attr_set"),
      ]),
      category("読み込み（import）", COLORS.import, [
        blk("aiz_import"),
        blk("aiz_import_text"),
        blk("aiz_from_import"),
        blk("aiz_import_as"),
        label("読み込んだものを使う"),
        blk("aiz_module_value", { inputs: { A1: num(2) } }),
        blk("aiz_module_call", { inputs: { A1: num(1) } }),
        blk("aiz_module_const"),
      ]),
      category("エラー処理", COLORS.error, [blk("aiz_try"), blk("aiz_try_finally"), blk("aiz_error_message"), blk("aiz_raise", { inputs: { MSG: txt("まちがった値です") } })]),
      category("ファイル", COLORS.file, [
        blk("aiz_with_open", { inputs: { NAME: txt("data.txt") } }),
        blk("aiz_file_write", { inputs: { TEXT: txt("こんにちは") } }),
        blk("aiz_file_read"),
        blk("aiz_file_lines"),
        blk("aiz_read_file", { inputs: { NAME: txt("data.txt") } }),
      ]),
      category("その他", COLORS.other, [
        blk("aiz_sleep", { inputs: { SEC: num(1) } }),
        blk("aiz_pass"),
        blk("aiz_main"),
        blk("aiz_global"),
        label("ブロックにないものを書く"),
        blk("aiz_code"),
        blk("aiz_code_value"),
      ]),
    ],
  };
}
