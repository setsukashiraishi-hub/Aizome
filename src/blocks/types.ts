// Go・C++・C# のように型を書く言語のために、ブロックから型を決める。
// 変数・リスト・辞書・関数の引数と返す値・クラスの項目を、入れた値や使い方から決める（何回か見直して固める）
import type * as Blockly from "blockly/core";

export type Ty =
  | { k: "?" }
  | { k: "int" }
  | { k: "float" }
  | { k: "str" }
  | { k: "bool" }
  | { k: "any" }
  | { k: "void" }
  | { k: "list"; e: Ty }
  | { k: "dict"; key: Ty; val: Ty }
  | { k: "obj"; cls: string };

export const T = {
  unknown: { k: "?" } as Ty,
  int: { k: "int" } as Ty,
  float: { k: "float" } as Ty,
  str: { k: "str" } as Ty,
  bool: { k: "bool" } as Ty,
  any: { k: "any" } as Ty,
  void: { k: "void" } as Ty,
  list: (e: Ty): Ty => ({ k: "list", e }),
  dict: (key: Ty, val: Ty): Ty => ({ k: "dict", key, val }),
  obj: (cls: string): Ty => ({ k: "obj", cls }),
};

export const same = (a: Ty, b: Ty) => JSON.stringify(a) === JSON.stringify(b);
export const isNum = (t: Ty) => t.k === "int" || t.k === "float";

/** 2 つの型を合わせる（int と float なら float、合わなければ any） */
export function unify(a: Ty, b: Ty): Ty {
  if (a.k === "?") return b;
  if (b.k === "?") return a;
  if (a.k === "any" || b.k === "any") return T.any;
  if (isNum(a) && isNum(b)) return a.k === "float" || b.k === "float" ? T.float : T.int;
  if (a.k === "list" && b.k === "list") return T.list(unify(a.e, b.e));
  if (a.k === "dict" && b.k === "dict") return T.dict(unify(a.key, b.key), unify(a.val, b.val));
  if (a.k === "obj" && b.k === "obj") return a.cls === b.cls ? a : T.any;
  return a.k === b.k ? a : T.any;
}

/** まだ決まらない所を、ふつうの型にしておく（空のリストは整数のリスト、など） */
export function settle(t: Ty): Ty {
  if (t.k === "?") return T.any;
  if (t.k === "list") return T.list(t.e.k === "?" ? T.int : settle(t.e));
  if (t.k === "dict") return T.dict(t.key.k === "?" ? T.str : settle(t.key), t.val.k === "?" ? T.int : settle(t.val));
  return t;
}

export const elemOf = (t: Ty): Ty => (t.k === "list" ? t.e : t.k === "str" ? T.str : t.k === "?" ? T.unknown : T.any);

// ───────── ブロックの読み取り

export function input(b: Blockly.Block, name: string): Blockly.Block | null {
  return b.getInputTargetBlock(name);
}

export function varName(b: Blockly.Block, field = "VAR"): string {
  const f = b.getField(field) as unknown as { getVariable?: () => { getName?: () => string; name?: string } | null; getText: () => string } | null;
  const v = f?.getVariable?.();
  return (v?.getName?.() ?? v?.name ?? f?.getText() ?? "x").trim();
}

/** 関数ブロックの引数の名前（Blockly の procedures） */
export function procParams(b: Blockly.Block): string[] {
  // Blockly 13 では arguments_ に入っている（前は getVars()）
  const x = b as unknown as { arguments_?: string[]; getVars?: () => string[] };
  return x.arguments_ ?? (x.getVars ? x.getVars() : []);
}

export function paramList(s: string): string[] {
  return String(s ?? "")
    .split(/[,、]/)
    .map((x) => x.trim().replace(/\s+/g, "_"))
    .filter(Boolean);
}

// ───────── 型を決める

export interface TypeInfo {
  vars: Map<string, Ty>;
  procRet: Map<string, Ty>;
  /** クラス → 項目 → 型 */
  fields: Map<string, Map<string, Ty>>;
  /** 「クラス.メソッド」→ 返す値の型 */
  methodRet: Map<string, Ty>;
  /** 「クラス.メソッド」→ 引数の名前（__init__ は作るときの準備） */
  methodParams: Map<string, string[]>;
  /** クラスの名前 → メソッドの名前の一覧 */
  classes: Map<string, string[]>;
  /** どの変数が読まれているか（Go の「使っていない変数」をよけるため） */
  read: Set<string>;
}

/** そのブロックを囲んでいる関数・メソッド・クラス */
export function contextOf(b: Blockly.Block): { cls: string | null; method: string | null; proc: string | null } {
  let cls: string | null = null;
  let method: string | null = null;
  let proc: string | null = null;
  for (let p = b.getSurroundParent(); p; p = p.getSurroundParent()) {
    if (p.type === "aiz_method" && method === null) method = String(p.getFieldValue("NAME")).trim();
    if (p.type === "aiz_class_init" && method === null) method = "__init__";
    if (p.type === "aiz_class" && cls === null) cls = String(p.getFieldValue("NAME")).trim();
    if ((p.type === "procedures_defreturn" || p.type === "procedures_defnoreturn") && proc === null) proc = String(p.getFieldValue("NAME"));
  }
  return { cls, method, proc };
}

export function inferTypes(ws: Blockly.Workspace): TypeInfoWithExpr {
  const info: TypeInfo = { vars: new Map(), procRet: new Map(), fields: new Map(), methodRet: new Map(), methodParams: new Map(), classes: new Map(), read: new Set() };
  const all = ws.getAllBlocks(false).filter((b) => b.isEnabled());
  // クラス・メソッドの形
  for (const b of all) {
    if (b.type === "aiz_class") {
      const cls = String(b.getFieldValue("NAME")).trim();
      const methods: string[] = [];
      for (let m = input(b, "BODY"); m; m = m.getNextBlock()) {
        if (m.type === "aiz_method") {
          const name = String(m.getFieldValue("NAME")).trim();
          methods.push(name);
          info.methodParams.set(`${cls}.${name}`, paramList(m.getFieldValue("PARAMS")));
        } else if (m.type === "aiz_class_init") info.methodParams.set(`${cls}.__init__`, paramList(m.getFieldValue("PARAMS")));
      }
      info.classes.set(cls, methods);
      if (!info.fields.has(cls)) info.fields.set(cls, new Map());
    }
    if (b.type === "variables_get") info.read.add(varName(b));
    if (b.type === "procedures_defreturn" || b.type === "procedures_defnoreturn") for (const p of procParams(b)) info.read.add(p);
  }
  const setVar = (name: string, t: Ty) => info.vars.set(name, unify(info.vars.get(name) ?? T.unknown, t));
  const setField = (cls: string, attr: string, t: Ty) => {
    const f = info.fields.get(cls) ?? new Map<string, Ty>();
    f.set(attr, unify(f.get(attr) ?? T.unknown, t));
    info.fields.set(cls, f);
  };
  const setRet = (map: Map<string, Ty>, key: string, t: Ty) => map.set(key, unify(map.get(key) ?? T.unknown, t));

  /** リストや辞書が入っている場所（変数・自分の項目・オブジェクトの項目）の型を足す */
  const setPlace = (b: Blockly.Block | null, t: Ty) => {
    if (!b) return;
    if (b.type === "variables_get") setVar(varName(b), t);
    else if (b.type === "aiz_self_get") {
      const { cls } = contextOf(b);
      if (cls) setField(cls, String(b.getFieldValue("ATTR")).trim(), t);
    } else if (b.type === "aiz_attr_get") {
      const o = typeOf(input(b, "OBJ"));
      if (o.k === "obj") setField(o.cls, String(b.getFieldValue("ATTR")).trim(), t);
    } else if (b.type === "aiz_dict_get") {
      setPlace(input(b, "DICT"), T.dict(typeOf(input(b, "KEY")), t));
    } else if (b.type === "lists_getIndex") {
      setPlace(input(b, "VALUE"), T.list(t));
    }
  };

  const typeOf = (b: Blockly.Block | null): Ty => {
    if (!b) return T.unknown;
    const v = (n: string) => typeOf(input(b, n));
    switch (b.type) {
      case "math_number":
        return Number.isInteger(Number(b.getFieldValue("NUM"))) && !/[.eE]/.test(String(b.getFieldValue("NUM"))) ? T.int : T.float;
      case "math_arithmetic": {
        const op = b.getFieldValue("OP");
        if (op === "DIVIDE" || op === "POWER") return T.float;
        const u = unify(v("A"), v("B"));
        return isNum(u) ? u : u.k === "?" ? T.unknown : T.float;
      }
      case "math_single": {
        const op = b.getFieldValue("OP");
        return op === "ABS" || op === "NEG" ? (isNum(v("NUM")) ? v("NUM") : T.float) : T.float;
      }
      case "math_trig":
      case "math_constant":
      case "math_random_float":
      case "math_atan2":
        return T.float;
      case "math_number_property":
      case "logic_compare":
      case "logic_operation":
      case "logic_negate":
      case "logic_boolean":
      case "text_isEmpty":
      case "lists_isEmpty":
      case "aiz_in":
      case "aiz_dict_has":
        return T.bool;
      case "math_round":
      case "math_random_int":
      case "text_length":
      case "text_indexOf":
      case "text_count":
      case "lists_length":
      case "lists_indexOf":
      case "aiz_dict_len":
        return T.int;
      case "math_modulo": {
        const u = unify(v("DIVIDEND"), v("DIVISOR"));
        return u.k === "int" ? T.int : T.float;
      }
      case "math_constrain":
        return unify(unify(v("VALUE"), v("LOW")), v("HIGH"));
      case "math_on_list": {
        const op = b.getFieldValue("OP");
        const e = elemOf(v("LIST"));
        if (op === "AVERAGE" || op === "MEDIAN" || op === "STD_DEV") return T.float;
        if (op === "MODE") return T.list(e);
        return e.k === "?" ? T.unknown : e;
      }
      case "text":
      case "text_multiline":
      case "text_join":
      case "text_charAt":
      case "text_getSubstring":
      case "text_changeCase":
      case "text_trim":
      case "text_replace":
      case "text_reverse":
      case "aiz_newline":
      case "aiz_input_text":
      case "aiz_fstring":
      case "aiz_typeof":
      case "aiz_error_message":
      case "aiz_file_read":
      case "aiz_read_file":
        return T.str;
      case "aiz_input_int":
        return T.int;
      case "aiz_input_float":
        return T.float;
      case "aiz_file_lines":
        return T.list(T.str);
      case "aiz_convert":
        return ({ int: T.int, float: T.float, str: T.str, bool: T.bool } as Record<string, Ty>)[b.getFieldValue("TO")] ?? T.any;
      case "logic_null":
        return T.unknown;
      case "logic_ternary":
        return unify(v("THEN"), v("ELSE"));
      case "variables_get":
        return info.vars.get(varName(b)) ?? T.unknown;
      case "lists_create_empty":
        return T.list(T.unknown);
      case "lists_create_with": {
        let e: Ty = T.unknown;
        for (const inp of b.inputList) if (inp.name.startsWith("ADD")) e = unify(e, typeOf(inp.connection?.targetBlock() ?? null));
        return T.list(e);
      }
      case "lists_repeat":
        return T.list(v("ITEM"));
      case "lists_getIndex":
        return b.getFieldValue("MODE") === "REMOVE" ? T.void : elemOf(v("VALUE"));
      case "lists_getSublist":
      case "lists_sort":
      case "lists_reverse": {
        const l = v(b.type === "lists_getSublist" ? "LIST" : "LIST");
        return l.k === "list" ? l : T.list(T.unknown);
      }
      case "lists_split":
        return b.getFieldValue("MODE") === "SPLIT" ? T.list(T.str) : T.str;
      case "aiz_dict_empty":
        return T.dict(T.unknown, T.unknown);
      case "aiz_dict_create":
        return T.dict(unify(v("K1"), v("K2")), unify(v("V1"), v("V2")));
      case "aiz_dict_get":
      case "aiz_dict_get_default": {
        const d = v("DICT");
        const val = d.k === "dict" ? d.val : T.unknown;
        return b.type === "aiz_dict_get_default" ? unify(val, v("DEFAULT")) : val;
      }
      case "aiz_dict_keys": {
        const d = v("DICT");
        return T.list(d.k === "dict" ? (b.getFieldValue("WHAT") === "keys" ? d.key : d.val) : T.unknown);
      }
      case "procedures_callreturn":
        return info.procRet.get(String(b.getFieldValue("NAME"))) ?? T.unknown;
      case "aiz_self_get": {
        const { cls } = contextOf(b);
        return (cls && info.fields.get(cls)?.get(String(b.getFieldValue("ATTR")).trim())) || T.unknown;
      }
      case "aiz_attr_get": {
        const o = v("OBJ");
        return o.k === "obj" ? (info.fields.get(o.cls)?.get(String(b.getFieldValue("ATTR")).trim()) ?? T.unknown) : T.any;
      }
      case "aiz_new":
        return T.obj(String(b.getFieldValue("CLASS")).trim());
      case "aiz_call_method_value": {
        const o = v("OBJ");
        const m = String(b.getFieldValue("METHOD")).trim();
        if (o.k === "obj") return info.methodRet.get(`${o.cls}.${m}`) ?? T.unknown;
        if (o.k === "str") return /^(upper|lower|strip|title|capitalize|replace|lstrip|rstrip)$/.test(m) ? T.str : m === "split" ? T.list(T.str) : /^(find|count|index)$/.test(m) ? T.int : T.any;
        return T.any;
      }
      default:
        return T.any;
    }
  };

  // 何回か見直して、型を固める
  for (let pass = 0; pass < 6; pass++) {
    const before = JSON.stringify([...info.vars, ...info.procRet, ...[...info.fields].map(([k, m]) => [k, [...m]]), ...info.methodRet]);
    for (const b of all) {
      const ctx = () => contextOf(b);
      switch (b.type) {
        case "variables_set":
          setVar(varName(b), typeOf(input(b, "VALUE")));
          break;
        case "math_change":
          setVar(varName(b), isNum(typeOf(input(b, "DELTA"))) ? typeOf(input(b, "DELTA")) : T.int);
          break;
        case "text_append":
          setVar(varName(b), T.str);
          break;
        case "controls_for": {
          const t = unify(unify(typeOf(input(b, "FROM")), typeOf(input(b, "TO"))), typeOf(input(b, "BY")));
          setVar(varName(b), t.k === "float" ? T.float : T.int);
          break;
        }
        case "controls_forEach":
          setVar(varName(b), elemOf(typeOf(input(b, "LIST"))));
          break;
        case "aiz_dict_loop": {
          const d = typeOf(input(b, "DICT"));
          if (d.k === "dict") {
            setVar(varName(b, "K"), d.key);
            setVar(varName(b, "V"), d.val);
          }
          break;
        }
        case "aiz_list_append":
          setPlace(input(b, "LIST"), T.list(typeOf(input(b, "ITEM"))));
          break;
        case "lists_setIndex":
          setPlace(input(b, "LIST"), T.list(typeOf(input(b, "TO"))));
          break;
        case "aiz_dict_set":
          setPlace(input(b, "DICT"), T.dict(typeOf(input(b, "KEY")), typeOf(input(b, "VALUE"))));
          break;
        case "aiz_self_set": {
          const { cls } = ctx();
          if (cls) setField(cls, String(b.getFieldValue("ATTR")).trim(), typeOf(input(b, "VALUE")));
          break;
        }
        case "aiz_attr_set": {
          const o = typeOf(input(b, "OBJ"));
          if (o.k === "obj") setField(o.cls, String(b.getFieldValue("ATTR")).trim(), typeOf(input(b, "VALUE")));
          break;
        }
        case "procedures_defreturn":
          setRet(info.procRet, String(b.getFieldValue("NAME")), typeOf(input(b, "RETURN")));
          break;
        case "aiz_return":
        case "procedures_ifreturn": {
          const value = input(b, "VALUE");
          if (!value) break;
          const { cls, method, proc } = ctx();
          if (cls && method) setRet(info.methodRet, `${cls}.${method}`, typeOf(value));
          else if (proc) setRet(info.procRet, proc, typeOf(value));
          break;
        }
        case "procedures_callreturn":
        case "procedures_callnoreturn": {
          const names = procParams(b);
          names.forEach((n, i) => setVar(n, typeOf(input(b, `ARG${i}`))));
          break;
        }
        case "aiz_new":
        case "aiz_call_method":
        case "aiz_call_method_value": {
          let key: string | null = null;
          if (b.type === "aiz_new") key = `${String(b.getFieldValue("CLASS")).trim()}.__init__`;
          else {
            const o = typeOf(input(b, "OBJ"));
            if (o.k === "obj") key = `${o.cls}.${String(b.getFieldValue("METHOD")).trim()}`;
          }
          const ps = key ? info.methodParams.get(key) : undefined;
          if (ps) ["A1", "A2", "A3"].forEach((a, i) => ps[i] && input(b, a) && setVar(ps[i], typeOf(input(b, a))));
          break;
        }
      }
    }
    const after = JSON.stringify([...info.vars, ...info.procRet, ...[...info.fields].map(([k, m]) => [k, [...m]]), ...info.methodRet]);
    if (after === before) break;
  }
  return Object.assign(info, { typeOf });
}

export type TypeInfoWithExpr = TypeInfo & { typeOf: (b: Blockly.Block | null) => Ty };
