// ブロックから Go・C++・C# のコードを作る。
// - 型は types.ts で決めたものを使う（変数はファイルの上のほうにまとめて、型と最初の値を書く）
// - 関数・クラスは main の外に出す
// - Blockly の「1 番目」は 1 から数えるので、0 から数える形に直す
// - 割り算は Python と同じく小数で計算する
// - Go：使っていない import をよける。C++：日本語の文字を 1 文字ずつ数える
import type * as Blockly from "blockly/core";
import { T, contextOf, elemOf, inferTypes, input, isNum, paramList, procParams, settle, type Ty, type TypeInfoWithExpr, varName } from "./types";

export type TypedLang = "go" | "cpp" | "csharp";

interface Ex {
  c: string;
  t: Ty;
  /** そのまま演算に使える（かっこ不要） */
  atom: boolean;
}

const KEYWORDS: Record<TypedLang, Set<string>> = {
  go: new Set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var len cap append make new delete copy print println string int float64 bool byte rune error true false nil iota main".split(" ")),
  cpp: new Set("alignas alignof and asm auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or private protected public register return short signed sizeof static struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile while xor main std string vector map input show".split(" ")),
  csharp: new Set("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var dynamic Main Program Input Show".split(" ")),
};

/** こちらで用意した関数の名前（変数名とぶつからないように） */
const HELPERS = "sorted reversed sum minOf maxOf average median modes stdev choice listIndex pop repeatList strList mustGet getOr keysOf valuesOf sortedKeys openFile readFile input toInt toFloat modInt absInt isPrime substr textIndex title reverseText chars ulen show upper lower trim countText replaceAll split join randint randfloat rng reader number aizFile AizFile Rnd";
for (const k of Object.values(KEYWORDS)) for (const h of HELPERS.split(" ")) k.add(h);

const ERR: Record<TypedLang, Record<string, string>> = {
  go: {},
  cpp: { Exception: "std::exception", ValueError: "std::invalid_argument", ZeroDivisionError: "std::domain_error", IndexError: "std::out_of_range", KeyError: "std::out_of_range", TypeError: "std::bad_cast", FileNotFoundError: "std::runtime_error" },
  csharp: { Exception: "Exception", ValueError: "FormatException", ZeroDivisionError: "DivideByZeroException", IndexError: "ArgumentOutOfRangeException", KeyError: "KeyNotFoundException", TypeError: "InvalidCastException", FileNotFoundError: "System.IO.FileNotFoundException" },
};

export function generateTyped(ws: Blockly.Workspace, lang: TypedLang): string {
  return new TypedGen(ws, lang).run();
}

class TypedGen {
  private info: TypeInfoWithExpr;
  private I: string;
  private need = new Set<string>();
  private imports = new Set<string>();
  private userImports: { pkg: string; alias?: string }[] = [];
  private loopDepth = 0;
  /** 型がわからない変数で、もう作ったもの（Go の := と C++ の auto） */
  private declaredLocal = new Set<string>();

  constructor(
    private ws: Blockly.Workspace,
    private lang: TypedLang,
  ) {
    this.info = inferTypes(ws);
    for (const [k, v] of this.info.vars) this.info.vars.set(k, settle(v));
    for (const [k, v] of this.info.procRet) this.info.procRet.set(k, settle(v));
    for (const [k, v] of this.info.methodRet) this.info.methodRet.set(k, settle(v));
    for (const m of this.info.fields.values()) for (const [k, v] of m) m.set(k, settle(v));
    this.I = lang === "go" ? "\t" : "    ";
  }

  private get go() {
    return this.lang === "go";
  }
  private get cpp() {
    return this.lang === "cpp";
  }
  private get cs() {
    return this.lang === "csharp";
  }

  // ───────── 名前・型

  private id(name: string): string {
    let s = String(name).trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_]/gu, "_") || "_";
    if (/^\p{N}/u.test(s)) s = "_" + s;
    return KEYWORDS[this.lang].has(s) ? s + "_" : s;
  }

  private ty(t: Ty): string {
    const go = this.go;
    const cpp = this.cpp;
    switch (t.k) {
      case "int":
        return "int";
      case "float":
        return go ? "float64" : "double";
      case "str":
        if (cpp) this.include("string");
        return go ? "string" : cpp ? "std::string" : "string";
      case "bool":
        return "bool";
      case "void":
        return go ? "" : "void";
      case "list":
        if (cpp) this.include("vector");
        return go ? `[]${this.ty(t.e)}` : cpp ? `std::vector<${this.ty(t.e)}>` : `List<${this.ty(t.e)}>`;
      case "dict":
        if (cpp) this.include("map");
        return go ? `map[${this.ty(t.key)}]${this.ty(t.val)}` : cpp ? `std::map<${this.ty(t.key)}, ${this.ty(t.val)}>` : `Dictionary<${this.ty(t.key)}, ${this.ty(t.val)}>`;
      case "obj":
        return go ? `*${this.id(t.cls)}` : this.id(t.cls);
      default:
        return go ? "any" : cpp ? "double" : "dynamic";
    }
  }

  /** 型の最初の値 */
  private zero(t: Ty): string {
    switch (t.k) {
      case "int":
        return "0";
      case "float":
        return this.go ? "0" : "0.0";
      case "str":
        return this.cpp ? "" : '""';
      case "bool":
        return "false";
      case "list":
        return this.go ? "" : this.cpp ? "" : `new ${this.ty(t)}()`;
      case "dict":
        return this.go ? `${this.ty(t)}{}` : this.cpp ? "" : `new ${this.ty(t)}()`;
      case "obj":
        return this.go ? "" : this.cpp ? "" : "null";
      default:
        return this.go ? "" : this.cpp ? "0" : "null";
    }
  }

  private include(h: string) {
    if (this.cpp) this.imports.add(h);
  }

  private q(s: string): string {
    return JSON.stringify(String(s));
  }

  // ───────── 式

  private ex(b: Blockly.Block | null, fallback?: Ty): Ex {
    if (!b) return this.emptyOf(fallback ?? T.int);
    // 空のリスト・辞書は、入れる先の型で作る（List<int> など）
    if (fallback && (fallback.k === "list" || fallback.k === "dict") && (b.type === "lists_create_empty" || b.type === "aiz_dict_empty")) {
      const ft = settle(fallback);
      const c = this.go || this.cpp ? `${this.ty(ft)}{}` : `new ${this.ty(ft)}()`;
      return this.x(c, ft, true);
    }
    return this.expr(b);
  }

  private emptyOf(t: Ty): Ex {
    if (t.k === "str") return { c: '""', t: T.str, atom: true };
    if (t.k === "bool") return { c: "false", t: T.bool, atom: true };
    if (t.k === "float") return { c: "0.0", t: T.float, atom: true };
    return { c: "0", t: T.int, atom: true };
  }

  private p(e: Ex): string {
    // C++ の "abc" は文字の配列なので、.empty() などを呼べるように std::string にする
    if (this.cpp && e.t.k === "str" && /^"(?:[^"\\]|\\.)*"$/.test(e.c)) return `std::string(${e.c})`;
    return e.atom ? e.c : `(${e.c})`;
  }

  /** 型を合わせる（Go は int と float64 を自動で変えないので、変換を書く） */
  private as(e: Ex, to: Ty): string {
    if (to.k === "float" && e.t.k === "int") return this.go ? `float64(${e.c})` : e.c;
    if (to.k === "int" && e.t.k === "float") return this.go ? `int(${e.c})` : this.cpp ? `static_cast<int>(${e.c})` : `(int)${this.p(e)}`;
    if (to.k === "str" && e.t.k !== "str") return this.str(e);
    if (this.go && to.k === "any") return e.c;
    return e.c;
  }

  /** 文字にする */
  private str(e: Ex): string {
    if (e.t.k === "str") return e.c;
    // 整数はその言語のふつうの書き方で（リスト・辞書などは、見やすくする関数で）
    if (this.go) {
      if (e.t.k === "int") {
        this.imports.add("strconv");
        return `strconv.Itoa(${e.c})`;
      }
      this.imports.add("fmt");
      return `fmt.Sprint(${e.c})`;
    }
    if (this.cpp) {
      if (e.t.k === "int") return `std::to_string(${e.c})`;
      this.need.add("show");
      return `show(${e.c})`;
    }
    if (e.t.k === "int" || e.t.k === "float" || e.t.k === "bool") return `${this.p(e)}.ToString()`;
    this.need.add("show");
    return `Show(${e.c})`;
  }

  /** C# の文字の埋めこみ（$"{回数} 回目"） */
  private csInterp(parts: Ex[]): string {
    let out = "";
    for (const e of parts) {
      const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(e.c);
      if (lit) out += lit[1].replace(/[{}]/g, (c) => c + c);
      else if (e.t.k === "str" || e.t.k === "int" || e.t.k === "float" || e.t.k === "bool") out += `{${e.c}}`;
      else {
        this.need.add("show");
        out += `{Show(${e.c})}`;
      }
    }
    return `$"${out}"`;
  }

  /** C++ のテンプレートにわたすときは型をはっきりさせる（"ん" を std::string に） */
  private exact(e: Ex, t: Ty): string {
    const v = this.as(e, t);
    if (this.cpp && t.k === "str" && /^"/.test(v)) return `std::string(${v})`;
    if (this.cpp && t.k === "float" && /^-?\d+$/.test(v)) return `${v}.0`;
    return v;
  }

  private x(c: string, t: Ty, atom = false): Ex {
    return { c, t, atom };
  }

  private v(b: Blockly.Block, name: string, fallback?: Ty): Ex {
    return this.ex(input(b, name), fallback);
  }

  private num(b: Blockly.Block, name: string): Ex {
    return this.v(b, name, T.int);
  }

  /** Blockly の「n 番目（1 から）」を、0 から数える番号に */
  private index(where: string, at: Ex | null, len: string): string {
    switch (where) {
      case "FIRST":
        return "0";
      case "LAST":
        return `${len} - 1`;
      case "FROM_END":
        return `${len} - ${at ? this.p(at) : "1"}`;
      case "RANDOM":
        return this.go ? (this.imports.add("math/rand"), `rand.Intn(${len})`) : this.cpp ? (this.need.add("randint"), `randint(0, ${len} - 1)`) : (this.need.add("rand"), `Rnd.Next(${len})`);
      default: {
        if (!at) return "0";
        if (/^\d+$/.test(at.c)) return String(Number(at.c) - 1);
        return `${this.p(at)} - 1`;
      }
    }
  }

  private len(e: Ex): string {
    if (e.t.k === "str") {
      if (this.go) {
        this.imports.add("unicode/utf8");
        return `utf8.RuneCountInString(${e.c})`;
      }
      if (this.cpp) {
        this.need.add("utf8");
        return `ulen(${e.c})`;
      }
      return `${this.p(e)}.Length`;
    }
    if (this.go) return `len(${e.c})`;
    if (this.cpp) return `static_cast<int>(${this.p(e)}.size())`;
    return `${this.p(e)}.Count`;
  }

  private expr(b: Blockly.Block): Ex {
    const go = this.go;
    const cpp = this.cpp;
    const cs = this.cs;
    const t = this.info.typeOf(b);
    const f = (n: string) => String(b.getFieldValue(n) ?? "");
    switch (b.type) {
      // ── 値
      case "math_number": {
        const n = f("NUM");
        return this.x(t.k === "float" && !/[.eE]/.test(n) ? n + ".0" : n, t, !n.startsWith("-"));
      }
      case "text":
      case "text_multiline":
        return this.x(this.q(f("TEXT")), T.str, true);
      case "aiz_newline":
        return this.x('"\\n"', T.str, true);
      case "logic_boolean":
        return this.x(f("BOOL") === "TRUE" ? "true" : "false", T.bool, true);
      case "logic_null":
        return this.x(go ? "nil" : cpp ? "{}" : "null", T.any, true);
      case "variables_get": {
        const name = varName(b);
        return this.x(this.id(name), this.info.vars.get(name) ?? T.any, true);
      }

      // ── 計算
      case "math_arithmetic": {
        const op = f("OP");
        const a = this.num(b, "A");
        const c = this.num(b, "B");
        if (op === "POWER") {
          if (go) this.imports.add("math");
          else if (cpp) this.include("cmath");
          return this.x(go ? `math.Pow(${this.as(a, T.float)}, ${this.as(c, T.float)})` : cpp ? `std::pow(${a.c}, ${c.c})` : `Math.Pow(${a.c}, ${c.c})`, T.float, true);
        }
        if (op === "DIVIDE") {
          // Python と同じく、整数どうしでも小数で割る
          const l = a.t.k === "int" && c.t.k === "int" ? (go ? `float64(${a.c})` : cpp ? `static_cast<double>(${a.c})` : `(double)${this.p(a)}`) : go ? this.as(a, T.float) : this.p(a);
          const r = go ? (c.t.k === "int" ? `float64(${c.c})` : this.p(c)) : this.p(c);
          return this.x(`${l} / ${r}`, T.float);
        }
        const sym = { ADD: "+", MINUS: "-", MULTIPLY: "*" }[op] ?? "+";
        const rt = t.k === "float" ? T.float : t.k === "int" ? T.int : t;
        const l = rt.k === "float" && go ? this.as(a, T.float) : this.p(a);
        const r = rt.k === "float" && go ? this.as(c, T.float) : this.p(c);
        return this.x(`${go && rt.k === "float" && a.t.k === "int" ? l : l} ${sym} ${r}`, rt);
      }
      case "math_single": {
        const op = f("OP");
        const n = this.num(b, "NUM");
        if (op === "NEG") return this.x(`-${this.p(n)}`, n.t);
        if (go) this.imports.add("math");
        else if (cpp) this.include("cmath");
        const fl = go ? this.as(n, T.float) : n.c;
        if (op === "ABS") {
          if (n.t.k === "int") return this.x(go ? (this.need.add("absInt"), `absInt(${n.c})`) : cpp ? `std::abs(${n.c})` : `Math.Abs(${n.c})`, T.int, true);
          return this.x(go ? `math.Abs(${fl})` : cpp ? `std::fabs(${n.c})` : `Math.Abs(${n.c})`, T.float, true);
        }
        const fn: Record<string, [string, string, string]> = {
          ROOT: ["math.Sqrt", "std::sqrt", "Math.Sqrt"],
          LN: ["math.Log", "std::log", "Math.Log"],
          LOG10: ["math.Log10", "std::log10", "Math.Log10"],
          EXP: ["math.Exp", "std::exp", "Math.Exp"],
        };
        if (op === "POW10") return this.x(go ? `math.Pow(10, ${fl})` : cpp ? `std::pow(10.0, ${n.c})` : `Math.Pow(10, ${n.c})`, T.float, true);
        const [g, c, s] = fn[op] ?? fn.ROOT;
        return this.x(`${go ? g : cpp ? c : s}(${fl})`, T.float, true);
      }
      case "math_trig": {
        const op = f("OP");
        const n = this.num(b, "NUM");
        if (go) this.imports.add("math");
        else if (cpp) this.include("cmath");
        const pi = go ? "math.Pi" : cpp ? "M_PI" : "Math.PI";
        const name = { SIN: "Sin", COS: "Cos", TAN: "Tan", ASIN: "Asin", ACOS: "Acos", ATAN: "Atan" }[op] ?? "Sin";
        const call = (arg: string) => (go ? `math.${name}(${arg})` : cpp ? `std::${name.toLowerCase()}(${arg})` : `Math.${name}(${arg})`);
        const val = go ? this.as(n, T.float) : this.p(n);
        // Blockly の角度は「度」
        return op.startsWith("A") ? this.x(`${call(val)} / ${pi} * 180`, T.float) : this.x(call(`${val} / 180 * ${pi}`), T.float, true);
      }
      case "math_constant": {
        const c = f("CONSTANT");
        if (go) this.imports.add("math");
        else if (cpp) this.include("cmath");
        const m: Record<string, [string, string, string]> = {
          PI: ["math.Pi", "M_PI", "Math.PI"],
          E: ["math.E", "M_E", "Math.E"],
          GOLDEN_RATIO: ["math.Phi", "((1 + std::sqrt(5.0)) / 2)", "((1 + Math.Sqrt(5)) / 2)"],
          SQRT2: ["math.Sqrt2", "M_SQRT2", "Math.Sqrt(2)"],
          SQRT1_2: ["(1 / math.Sqrt2)", "M_SQRT1_2", "Math.Sqrt(0.5)"],
          INFINITY: ["math.Inf(1)", "INFINITY", "double.PositiveInfinity"],
        };
        const [g, cc, s] = m[c] ?? m.PI;
        return this.x(go ? g : cpp ? cc : s, T.float, true);
      }
      case "math_number_property": {
        const n = this.num(b, "NUMBER_TO_CHECK");
        const prop = f("PROPERTY");
        const mod = (d: string) => (n.t.k === "int" ? `${this.p(n)} % ${d}` : go ? (this.imports.add("math"), `math.Mod(${n.c}, ${d})`) : cpp ? (this.include("cmath"), `std::fmod(${n.c}, ${d})`) : `${this.p(n)} % ${d}`);
        switch (prop) {
          case "EVEN":
            return this.x(`${mod("2")} == 0`, T.bool);
          case "ODD":
            return this.x(`${mod("2")} != 0`, T.bool);
          case "WHOLE":
            return this.x(`${mod("1")} == 0`, T.bool);
          case "POSITIVE":
            return this.x(`${this.p(n)} > 0`, T.bool);
          case "NEGATIVE":
            return this.x(`${this.p(n)} < 0`, T.bool);
          case "DIVISIBLE_BY": {
            const d = this.num(b, "DIVISOR");
            return this.x(`${mod(this.p(d))} == 0`, T.bool);
          }
          default:
            this.need.add("isPrime");
            return this.x(`${go ? "isPrime" : cpp ? "isPrime" : "IsPrime"}(${this.as(n, T.int)})`, T.bool, true);
        }
      }
      case "math_round": {
        const op = f("OP");
        const n = this.num(b, "NUM");
        if (go) this.imports.add("math");
        else if (cpp) this.include("cmath");
        const fl = go ? this.as(n, T.float) : n.c;
        // Python の round と同じく、ちょうど半分のときは偶数に寄せて、整数にする（2.5 → 2、3.5 → 4）
        const name = { ROUND: ["RoundToEven", "nearbyint", "Round"], ROUNDUP: ["Ceil", "ceil", "Ceiling"], ROUNDDOWN: ["Floor", "floor", "Floor"] }[op] ?? ["RoundToEven", "nearbyint", "Round"];
        return this.x(go ? `int(math.${name[0]}(${fl}))` : cpp ? `static_cast<int>(std::${name[1]}(${fl}))` : `(int)Math.${name[2]}((double)${this.p(n)})`, T.int, true);
      }
      case "math_modulo": {
        const a = this.num(b, "DIVIDEND");
        const d = this.num(b, "DIVISOR");
        if (a.t.k === "int" && d.t.k === "int") {
          // Python と同じく、割る数と同じ符号の余り
          this.need.add("modInt");
          return this.x(`${go ? "modInt" : cpp ? "modInt" : "ModInt"}(${a.c}, ${d.c})`, T.int, true);
        }
        if (go) this.imports.add("math");
        else if (cpp) this.include("cmath");
        return this.x(go ? `math.Mod(${this.as(a, T.float)}, ${this.as(d, T.float)})` : cpp ? `std::fmod(${a.c}, ${d.c})` : `${this.p(a)} % ${this.p(d)}`, T.float, true);
      }
      case "math_constrain": {
        const v = this.num(b, "VALUE");
        const lo = this.num(b, "LOW");
        const hi = this.num(b, "HIGH");
        const tt = t.k === "float" ? T.float : T.int;
        if (go) return this.x(`min(max(${this.as(v, tt)}, ${this.as(lo, tt)}), ${this.as(hi, tt)})`, tt, true);
        if (cpp) {
          this.include("algorithm");
          return this.x(`std::min(std::max<${this.ty(tt)}>(${v.c}, ${lo.c}), static_cast<${this.ty(tt)}>(${hi.c}))`, tt, true);
        }
        return this.x(`Math.Min(Math.Max(${v.c}, ${lo.c}), ${hi.c})`, tt, true);
      }
      case "math_random_int": {
        const a = this.num(b, "FROM");
        const c = this.num(b, "TO");
        if (go) {
          this.imports.add("math/rand");
          return this.x(`rand.Intn(${this.p(c)} - ${this.p(a)} + 1) + ${this.p(a)}`, T.int);
        }
        if (cpp) {
          this.need.add("randint");
          return this.x(`randint(${a.c}, ${c.c})`, T.int, true);
        }
        this.need.add("rand");
        return this.x(`Rnd.Next(${a.c}, ${this.p(c)} + 1)`, T.int, true);
      }
      case "math_random_float":
        if (go) {
          this.imports.add("math/rand");
          return this.x("rand.Float64()", T.float, true);
        }
        if (cpp) {
          this.need.add("randint");
          return this.x("randfloat()", T.float, true);
        }
        this.need.add("rand");
        return this.x("Rnd.NextDouble()", T.float, true);
      case "math_atan2": {
        const xx = this.num(b, "X");
        const yy = this.num(b, "Y");
        if (go) this.imports.add("math");
        else if (cpp) this.include("cmath");
        const pi = go ? "math.Pi" : cpp ? "M_PI" : "Math.PI";
        return this.x(`${go ? `math.Atan2(${this.as(yy, T.float)}, ${this.as(xx, T.float)})` : cpp ? `std::atan2(${yy.c}, ${xx.c})` : `Math.Atan2(${yy.c}, ${xx.c})`} / ${pi} * 180`, T.float);
      }
      case "math_on_list": {
        const l = this.v(b, "LIST", T.list(T.int));
        const op = f("OP");
        const e = elemOf(l.t);
        const fn = { SUM: "sum", MIN: "minOf", MAX: "maxOf", AVERAGE: "average", MEDIAN: "median", MODE: "modes", STD_DEV: "stdev", RANDOM: "choice" }[op] ?? "sum";
        this.need.add("listMath");
        const name = cs ? fn[0].toUpperCase() + fn.slice(1) : fn;
        return this.x(`${name}(${l.c})`, op === "AVERAGE" || op === "MEDIAN" || op === "STD_DEV" ? T.float : op === "MODE" ? T.list(e) : e, true);
      }

      // ── 比べる・条件
      case "logic_compare": {
        const a = this.ex(input(b, "A"));
        const c = this.ex(input(b, "B"));
        const op = { EQ: "==", NEQ: "!=", LT: "<", LTE: "<=", GT: ">", GTE: ">=" }[f("OP")] ?? "==";
        const both = isNum(a.t) && isNum(c.t) && a.t.k !== c.t.k;
        const l = both && go ? this.as(a, T.float) : this.p(a);
        const r = both && go ? this.as(c, T.float) : this.p(c);
        return this.x(`${l} ${op} ${r}`, T.bool);
      }
      case "logic_operation": {
        const a = this.v(b, "A", T.bool);
        const c = this.v(b, "B", T.bool);
        return this.x(`${this.p(a)} ${f("OP") === "AND" ? "&&" : "||"} ${this.p(c)}`, T.bool);
      }
      case "logic_negate": {
        const a = this.v(b, "BOOL", T.bool);
        return this.x(`!${this.p(a)}`, T.bool, true);
      }
      case "logic_ternary": {
        const c = this.v(b, "IF", T.bool);
        const a = this.ex(input(b, "THEN"));
        const e = this.ex(input(b, "ELSE"));
        if (go) {
          const tt = this.ty(t) || "any";
          return this.x(`func() ${tt} { if ${c.c} { return ${this.as(a, t)} }; return ${this.as(e, t)} }()`, t, true);
        }
        return this.x(`${this.p(c)} ? ${this.p(a)} : ${this.p(e)}`, t);
      }
      case "aiz_in": {
        const item = this.ex(input(b, "ITEM"));
        const coll = this.ex(input(b, "COLLECTION"));
        if (coll.t.k === "dict") return this.x(go ? `func() bool { _, ok := ${coll.c}[${item.c}]; return ok }()` : cpp ? `${this.p(coll)}.count(${item.c}) > 0` : `${this.p(coll)}.ContainsKey(${item.c})`, T.bool, go);
        if (coll.t.k === "str") return this.x(go ? (this.imports.add("strings"), `strings.Contains(${coll.c}, ${this.str(item)})`) : cpp ? `${this.p(coll)}.find(${this.str(item)}) != std::string::npos` : `${this.p(coll)}.Contains(${this.str(item)})`, T.bool, go || cs);
        if (go) {
          this.imports.add("slices");
          return this.x(`slices.Contains(${coll.c}, ${this.as(item, elemOf(coll.t))})`, T.bool, true);
        }
        if (cpp) {
          this.include("algorithm");
          return this.x(`std::find(${this.p(coll)}.begin(), ${this.p(coll)}.end(), ${item.c}) != ${this.p(coll)}.end()`, T.bool);
        }
        return this.x(`${this.p(coll)}.Contains(${item.c})`, T.bool, true);
      }

      // ── 文字
      case "text_join": {
        if (cs) {
          const exs: Ex[] = [];
          for (const inp of b.inputList) if (inp.name.startsWith("ADD")) exs.push(this.ex(inp.connection?.targetBlock() ?? null, T.str));
          if (exs.length > 1 && exs.every((e) => !/[?:]/.test(e.c) || /^"/.test(e.c))) return this.x(this.csInterp(exs), T.str, true);
        }
        const parts: string[] = [];
        for (const inp of b.inputList) if (inp.name.startsWith("ADD")) parts.push(this.str(this.ex(inp.connection?.targetBlock() ?? null, T.str)));
        if (!parts.length) return this.x('""', T.str, true);
        if (cpp && parts.length && parts[0].startsWith('"')) parts[0] = `std::string(${parts[0]})`;
        return this.x(parts.join(" + "), T.str, parts.length === 1);
      }
      case "text_length":
        return this.x(this.len(this.v(b, "VALUE", T.str)), T.int, !cpp);
      case "text_isEmpty": {
        const s = this.v(b, "VALUE", T.str);
        return this.x(go ? `${s.c} == ""` : cpp ? `${this.p(s)}.empty()` : `${this.p(s)}.Length == 0`, T.bool, !go);
      }
      case "text_indexOf": {
        const s = this.v(b, "VALUE", T.str);
        const sub = this.v(b, "FIND", T.str);
        const last = f("END") === "LAST";
        this.need.add("textIndex");
        return this.x(`${go || cpp ? "textIndex" : "TextIndex"}(${s.c}, ${this.str(sub)}, ${last ? "true" : "false"})`, T.int, true);
      }
      case "text_charAt": {
        const s = this.v(b, "VALUE", T.str);
        const at = input(b, "AT") ? this.num(b, "AT") : null;
        const i = this.index(f("WHERE"), at, this.len(s));
        this.need.add("substr");
        return this.x(`${go || cpp ? "substr" : "Substr"}(${s.c}, ${i}, 1)`, T.str, true);
      }
      case "text_getSubstring": {
        const s = this.v(b, "STRING", T.str);
        const a1 = input(b, "AT1") ? this.num(b, "AT1") : null;
        const a2 = input(b, "AT2") ? this.num(b, "AT2") : null;
        const from = this.index(f("WHERE1"), a1, this.len(s));
        const w2 = f("WHERE2");
        // 終わりは「そこまで含む」
        const to = w2 === "LAST" ? this.len(s) : w2 === "FROM_END" ? `${this.len(s)} - ${a2 ? this.p(a2) : "1"} + 1` : a2 ? a2.c : "0";
        this.need.add("substr");
        return this.x(`${go || cpp ? "substr" : "Substr"}(${s.c}, ${from}, (${to}) - (${from}))`, T.str, true);
      }
      case "text_changeCase": {
        const s = this.v(b, "TEXT", T.str);
        const c = f("CASE");
        if (c === "TITLECASE") {
          this.need.add("title");
          return this.x(`${go || cpp ? "title" : "Title"}(${s.c})`, T.str, true);
        }
        const up = c === "UPPERCASE";
        if (go) {
          this.imports.add("strings");
          return this.x(`strings.${up ? "ToUpper" : "ToLower"}(${s.c})`, T.str, true);
        }
        if (cpp) {
          this.need.add("caseConv");
          return this.x(`${up ? "upper" : "lower"}(${s.c})`, T.str, true);
        }
        return this.x(`${this.p(s)}.${up ? "ToUpper" : "ToLower"}()`, T.str, true);
      }
      case "text_trim": {
        const s = this.v(b, "TEXT", T.str);
        const m = f("MODE");
        if (go) {
          this.imports.add("strings");
          return this.x(`strings.${m === "LEFT" ? "TrimLeft" : m === "RIGHT" ? "TrimRight" : "TrimSpace"}(${s.c}${m === "BOTH" ? "" : ', " \\t\\r\\n"'})`, T.str, true);
        }
        if (cpp) {
          this.need.add("trim");
          return this.x(`trim(${s.c}, ${m === "LEFT" ? 1 : m === "RIGHT" ? 2 : 3})`, T.str, true);
        }
        return this.x(`${this.p(s)}.${m === "LEFT" ? "TrimStart" : m === "RIGHT" ? "TrimEnd" : "Trim"}()`, T.str, true);
      }
      case "text_count": {
        const s = this.v(b, "TEXT", T.str);
        const sub = this.v(b, "SUB", T.str);
        if (go) {
          this.imports.add("strings");
          return this.x(`strings.Count(${s.c}, ${sub.c})`, T.int, true);
        }
        this.need.add("countText");
        return this.x(`${cpp ? "countText" : "CountText"}(${s.c}, ${sub.c})`, T.int, true);
      }
      case "text_replace": {
        const s = this.v(b, "TEXT", T.str);
        const a = this.v(b, "FROM", T.str);
        const c = this.v(b, "TO", T.str);
        if (go) {
          this.imports.add("strings");
          return this.x(`strings.ReplaceAll(${s.c}, ${a.c}, ${c.c})`, T.str, true);
        }
        if (cpp) {
          this.need.add("replaceAll");
          return this.x(`replaceAll(${s.c}, ${a.c}, ${c.c})`, T.str, true);
        }
        return this.x(`${this.p(s)}.Replace(${a.c}, ${c.c})`, T.str, true);
      }
      case "text_reverse": {
        const s = this.v(b, "TEXT", T.str);
        this.need.add("reverseText");
        return this.x(`${go || cpp ? "reverseText" : "ReverseText"}(${s.c})`, T.str, true);
      }

      // ── 入力・表示
      case "aiz_input_text":
      case "aiz_input_int":
      case "aiz_input_float": {
        this.need.add("input");
        const call = `${cs ? "Input" : "input"}(${this.q(f("Q"))})`;
        if (b.type === "aiz_input_text") return this.x(call, T.str, true);
        this.need.add("convert");
        const toInt = b.type === "aiz_input_int";
        return this.x(go ? `${toInt ? "toInt" : "toFloat"}(${call})` : cpp ? `${toInt ? "toInt" : "toFloat"}(${call})` : `${toInt ? "int" : "double"}.Parse(${call})`, toInt ? T.int : T.float, true);
      }
      case "aiz_fstring": {
        // {名前} を値に置きかえる
        const textv = f("TEXT");
        const parts: string[] = [];
        let last = 0;
        for (const m of textv.matchAll(/\{([^{}]+)\}/g)) {
          if (m.index! > last) parts.push(this.q(textv.slice(last, m.index)));
          const name = m[1].trim();
          const vt = this.info.vars.get(name);
          const e = this.x(/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? this.id(name) : name, vt ?? T.any, true);
          parts.push(vt?.k === "str" ? e.c : this.str(e));
          last = m.index! + m[0].length;
        }
        if (last < textv.length || !parts.length) parts.push(this.q(textv.slice(last)));
        if (cs) {
          return this.x("$" + this.q(textv.replace(/\{([^{}]+)\}/g, (_, n) => `{${this.id(String(n).trim())}}`)), T.str, true);
        }
        if (cpp && parts[0].startsWith('"')) parts[0] = `std::string(${parts[0]})`;
        return this.x(parts.join(" + "), T.str, parts.length === 1);
      }

      // ── 型
      case "aiz_convert": {
        const e = this.ex(input(b, "VALUE"));
        const to = f("TO");
        if (to === "str") return this.x(this.str(e), T.str, true);
        if (to === "int") {
          if (e.t.k === "str") {
            this.need.add("convert");
            return this.x(cs ? `int.Parse(${e.c})` : `toInt(${e.c})`, T.int, true);
          }
          return this.x(go ? `int(${e.c})` : cpp ? `static_cast<int>(${e.c})` : `(int)${this.p(e)}`, T.int, !cs);
        }
        if (to === "float") {
          if (e.t.k === "str") {
            this.need.add("convert");
            return this.x(cs ? `double.Parse(${e.c})` : `toFloat(${e.c})`, T.float, true);
          }
          return this.x(go ? `float64(${e.c})` : cpp ? `static_cast<double>(${e.c})` : `(double)${this.p(e)}`, T.float, !cs);
        }
        if (e.t.k === "str") return this.x(go ? `${e.c} != ""` : cpp ? `!${this.p(e)}.empty()` : `${this.p(e)}.Length > 0`, T.bool);
        return this.x(`${this.p(e)} != 0`, T.bool);
      }
      case "aiz_typeof": {
        const e = this.ex(input(b, "VALUE"));
        return this.x(this.q(this.ty(e.t) || "any"), T.str, true);
      }

      // ── リスト
      case "lists_create_empty": {
        const lt = t.k === "list" ? t : T.list(T.int);
        return this.x(go ? `${this.ty(lt)}{}` : cpp ? `${this.ty(lt)}{}` : `new ${this.ty(lt)}()`, lt, true);
      }
      case "lists_create_with": {
        const lt = (t.k === "list" && t.e.k !== "?" ? t : T.list(T.int)) as { k: "list"; e: Ty };
        const items: string[] = [];
        for (const inp of b.inputList) if (inp.name.startsWith("ADD")) items.push(this.as(this.ex(inp.connection?.targetBlock() ?? null, lt.e), lt.e));
        return this.x(go ? `${this.ty(lt)}{${items.join(", ")}}` : cpp ? `${this.ty(lt)}{${items.join(", ")}}` : `new ${this.ty(lt)} { ${items.join(", ")} }`, lt, true);
      }
      case "lists_repeat": {
        const item = this.ex(input(b, "ITEM"));
        const n = this.num(b, "NUM");
        const lt = T.list(item.t.k === "?" ? T.int : item.t);
        if (go) {
          this.need.add("repeatList");
          return this.x(`repeatList(${item.c}, ${n.c})`, lt, true);
        }
        if (cpp) return this.x(`${this.ty(lt)}(${n.c}, ${item.c})`, lt, true);
        this.imports.add("System.Linq");
        return this.x(`Enumerable.Repeat(${item.c}, ${n.c}).ToList()`, lt, true);
      }
      case "lists_length":
        return this.x(this.len(this.v(b, "VALUE", T.list(T.int))), T.int, !cpp);
      case "lists_isEmpty": {
        const l = this.v(b, "VALUE", T.list(T.int));
        return this.x(go ? `len(${l.c}) == 0` : cpp ? `${this.p(l)}.empty()` : `${this.p(l)}.Count == 0`, T.bool, cpp);
      }
      case "lists_indexOf": {
        const l = this.v(b, "VALUE", T.list(T.int));
        const item = this.ex(input(b, "FIND"));
        const last = f("END") === "LAST";
        this.need.add("listIndex");
        return this.x(`${cs ? "ListIndex" : "listIndex"}(${l.c}, ${this.exact(item, elemOf(l.t))}, ${last ? "true" : "false"})`, T.int, true);
      }
      case "lists_getIndex": {
        const l = this.v(b, "VALUE", T.list(T.int));
        const at = input(b, "AT") ? this.num(b, "AT") : null;
        const i = this.index(f("WHERE"), at, this.len(l));
        if (f("MODE") === "GET_REMOVE") {
          this.need.add("pop");
          return this.x(go ? `pop(&${l.c}, ${i})` : `${cs ? "Pop" : "pop"}(${l.c}, ${i})`, elemOf(l.t), true);
        }
        return this.x(cpp ? `${this.p(l)}.at(${i})` : `${this.p(l)}[${i}]`, elemOf(l.t), true);
      }
      case "lists_getSublist": {
        const l = this.v(b, "LIST", T.list(T.int));
        const a1 = input(b, "AT1") ? this.num(b, "AT1") : null;
        const a2 = input(b, "AT2") ? this.num(b, "AT2") : null;
        const from = this.index(f("WHERE1"), a1, this.len(l));
        const w2 = f("WHERE2");
        const to = w2 === "LAST" ? this.len(l) : w2 === "FROM_END" ? `${this.len(l)} - ${a2 ? this.p(a2) : "1"} + 1` : a2 ? a2.c : "0";
        if (go) return this.x(`append(${this.ty(l.t)}{}, ${this.p(l)}[${from}:${to}]...)`, l.t, true);
        if (cpp) return this.x(`${this.ty(l.t)}(${this.p(l)}.begin() + (${from}), ${this.p(l)}.begin() + (${to}))`, l.t, true);
        return this.x(`${this.p(l)}.GetRange(${from}, (${to}) - (${from}))`, l.t, true);
      }
      case "lists_split": {
        const inp = this.ex(input(b, "INPUT"));
        const d = this.v(b, "DELIM", T.str);
        if (f("MODE") === "SPLIT") {
          if (go) {
            this.imports.add("strings");
            return this.x(`strings.Split(${inp.c}, ${d.c})`, T.list(T.str), true);
          }
          this.need.add("split");
          return this.x(cpp ? `split(${inp.c}, ${d.c})` : `${this.p(inp)}.Split(${d.c}).ToList()`, T.list(T.str), true);
        }
        const items = inp.t.k === "list" && inp.t.e.k !== "str" ? (this.need.add("strList"), this.need.add("show"), `${cs ? "StrList" : "strList"}(${inp.c})`) : inp.c;
        if (go) {
          this.imports.add("strings");
          return this.x(`strings.Join(${items}, ${d.c})`, T.str, true);
        }
        this.need.add("join");
        return this.x(cpp ? `join(${items}, ${d.c})` : `string.Join(${d.c}, ${items})`, T.str, true);
      }
      case "lists_sort": {
        const l = this.v(b, "LIST", T.list(T.int));
        const desc = f("DIRECTION") === "-1";
        const ic = f("TYPE") === "IGNORE_CASE";
        this.need.add("sorted");
        return this.x(`${cs ? "Sorted" : "sorted"}(${l.c}, ${desc ? "true" : "false"}, ${ic ? "true" : "false"})`, l.t, true);
      }
      case "lists_reverse": {
        const l = this.v(b, "LIST", T.list(T.int));
        this.need.add("reversed");
        return this.x(`${cs ? "Reversed" : "reversed"}(${l.c})`, l.t, true);
      }

      // ── 辞書
      case "aiz_dict_empty": {
        const dt = t.k === "dict" ? t : T.dict(T.str, T.int);
        return this.x(go ? `${this.ty(dt)}{}` : cpp ? `${this.ty(dt)}{}` : `new ${this.ty(dt)}()`, dt, true);
      }
      case "aiz_dict_create": {
        const dt = t.k === "dict" ? (t.key.k === "?" || t.val.k === "?" ? T.dict(t.key.k === "?" ? T.str : t.key, t.val.k === "?" ? T.int : t.val) : t) : T.dict(T.str, T.int);
        const kvs: string[] = [];
        for (const i of [1, 2]) {
          if (!input(b, `K${i}`)) continue;
          const k = this.as(this.v(b, `K${i}`), (dt as { key: Ty }).key);
          const v = this.as(this.v(b, `V${i}`), (dt as { val: Ty }).val);
          kvs.push(go ? `${k}: ${v}` : cpp ? `{${k}, ${v}}` : `[${k}] = ${v}`);
        }
        return this.x(go ? `${this.ty(dt)}{${kvs.join(", ")}}` : cpp ? `${this.ty(dt)}{${kvs.join(", ")}}` : `new ${this.ty(dt)} { ${kvs.join(", ")} }`, dt, true);
      }
      case "aiz_dict_get": {
        const d = this.v(b, "DICT", T.dict(T.str, T.int));
        const k = this.ex(input(b, "KEY"));
        const kk = d.t.k === "dict" ? this.as(k, d.t.key) : k.c;
        if (go) {
          this.need.add("mustGet");
          return this.x(`mustGet(${d.c}, ${kk})`, t, true);
        }
        return this.x(cpp ? `${this.p(d)}.at(${kk})` : `${this.p(d)}[${kk}]`, t, true);
      }
      case "aiz_dict_get_default": {
        const d = this.v(b, "DICT", T.dict(T.str, T.int));
        const k = this.ex(input(b, "KEY"));
        const def = this.ex(input(b, "DEFAULT"));
        const vt = d.t.k === "dict" ? d.t.val : t;
        const kk = d.t.k === "dict" ? this.as(k, d.t.key) : k.c;
        this.need.add("getOr");
        const kx = d.t.k === "dict" ? this.exact(k, d.t.key) : kk;
        return this.x(`${cs ? "GetOr" : "getOr"}(${d.c}, ${kx}, ${this.exact(def, vt)})`, vt, true);
      }
      case "aiz_dict_has": {
        const d = this.v(b, "DICT", T.dict(T.str, T.int));
        const k = this.ex(input(b, "KEY"));
        const kk = d.t.k === "dict" ? this.as(k, d.t.key) : k.c;
        return this.x(go ? `func() bool { _, ok := ${d.c}[${kk}]; return ok }()` : cpp ? `${this.p(d)}.count(${kk}) > 0` : `${this.p(d)}.ContainsKey(${kk})`, T.bool, !cpp);
      }
      case "aiz_dict_keys": {
        const d = this.v(b, "DICT", T.dict(T.str, T.int));
        const keys = f("WHAT") === "keys";
        this.need.add("keysValues");
        return this.x(`${cs ? (keys ? "Keys" : "Values") : keys ? "keysOf" : "valuesOf"}(${d.c})`, t, true);
      }
      case "aiz_dict_len": {
        const d = this.v(b, "DICT", T.dict(T.str, T.int));
        return this.x(go ? `len(${d.c})` : cpp ? `static_cast<int>(${this.p(d)}.size())` : `${this.p(d)}.Count`, T.int, !cpp);
      }

      // ── 関数・クラス
      case "procedures_callreturn": {
        const name = String(b.getFieldValue("NAME"));
        return this.x(`${this.id(name)}(${this.callArgs(b)})`, this.info.procRet.get(name) ?? T.any, true);
      }
      case "aiz_self_get":
        return this.x(`${go ? "self." : cpp ? "this->" : "this."}${this.id(f("ATTR"))}`, t, true);
      case "aiz_attr_get": {
        const o = this.v(b, "OBJ", T.any);
        return this.x(`${this.p(o)}.${this.id(f("ATTR"))}`, t, true);
      }
      case "aiz_new": {
        const cls = this.id(f("CLASS"));
        const a = this.methodArgs(b, `${f("CLASS").trim()}.__init__`);
        return this.x(go ? `New${cls}(${a})` : cpp ? `${cls}(${a})` : `new ${cls}(${a})`, T.obj(f("CLASS").trim()), true);
      }
      case "aiz_call_method_value": {
        const o = this.v(b, "OBJ", T.any);
        const m = f("METHOD").trim();
        const key = o.t.k === "obj" ? `${o.t.cls}.${m}` : "";
        return this.x(`${this.p(o)}.${o.t.k === "obj" ? this.id(m) : m}(${this.methodArgs(b, key)})`, t, true);
      }
      case "aiz_error_message":
        return this.x(go ? "e" : cpp ? "e" : "e.Message", T.str, true);

      // ── ファイル
      case "aiz_file_read":
        return this.x(`${this.id(f("VAR"))}.${cs ? "Read" : go ? "Read" : "read"}()`, T.str, true);
      case "aiz_file_lines":
        return this.x(`${this.id(f("VAR"))}.${cs ? "ReadLines" : go ? "ReadLines" : "readlines"}()`, T.list(T.str), true);
      case "aiz_read_file": {
        const n = this.v(b, "NAME", T.str);
        this.need.add("readFile");
        return this.x(`${cs ? "ReadFile" : "readFile"}(${n.c})`, T.str, true);
      }

      // ── 読み込み・そのまま書く
      case "aiz_module_value":
        return this.x(`${f("MODULE").trim()}${cpp ? "::" : "."}${f("FUNC").trim()}(${this.plainArgs(b)})`, T.any, true);
      case "aiz_module_const":
        return this.x(`${f("MODULE").trim()}${cpp ? "::" : "."}${f("NAME").trim()}`, T.any, true);
      case "aiz_code_value":
        return this.x(f("CODE"), T.any);
      default:
        return this.x(`/* ${b.type} */ 0`, T.any);
    }
  }

  private plainArgs(b: Blockly.Block): string {
    return ["A1", "A2", "A3"]
      .filter((a) => input(b, a))
      .map((a) => this.ex(input(b, a)).c)
      .join(", ");
  }

  /** メソッド・作るときの準備にわたす値（引数の型に合わせる） */
  private methodArgs(b: Blockly.Block, key: string): string {
    const ps = this.info.methodParams.get(key) ?? [];
    return ["A1", "A2", "A3"]
      .filter((a) => input(b, a))
      .map((a, i) => {
        const e = this.ex(input(b, a));
        const pt = ps[i] ? this.info.vars.get(ps[i]) : undefined;
        return pt ? this.as(e, pt) : e.c;
      })
      .join(", ");
  }

  private callArgs(b: Blockly.Block): string {
    return procParams(b)
      .map((p, i) => {
        const e = this.ex(input(b, `ARG${i}`), this.info.vars.get(p));
        return this.as(e, this.info.vars.get(p) ?? e.t);
      })
      .join(", ");
  }

  // ───────── 文

  private body(b: Blockly.Block, name: string): string {
    const code = this.stmts(input(b, name));
    return code ? this.indent(code) : this.go ? "" : "";
  }

  private indent(code: string): string {
    return code
      .split("\n")
      .map((l) => (l ? this.I + l : l))
      .join("\n");
  }

  private stmts(first: Blockly.Block | null): string {
    let out = "";
    for (let b = first; b; b = b.getNextBlock()) {
      if (!b.isEnabled()) continue;
      out += this.stmt(b);
    }
    return out;
  }

  private end(): string {
    return this.go ? "" : ";";
  }

  private print(e: Ex, newline = true): string {
    if (this.go) {
      this.imports.add("fmt");
      return `fmt.${newline ? "Println" : "Print"}(${e.c})\n`;
    }
    // 整数・小数・文字はそのまま表示する（リスト・辞書・真偽値などだけ、見やすくする関数を通す）
    const plain = e.t.k === "str" || e.t.k === "int" || (e.t.k === "float" && this.cpp) || (e.t.k === "bool" && this.cs);
    if (this.cpp) {
      this.include("iostream");
      const val = plain ? this.p(e) : this.str(e);
      return `std::cout << ${val}${newline ? " << std::endl" : " << std::flush"};\n`;
    }
    const val = plain ? e.c : this.str(e);
    return `Console.${newline ? "WriteLine" : "Write"}(${val});\n`;
  }

  /** 代入（型がわからない変数は、最初の代入で作る） */
  private assign(name: string, e: Ex): string {
    const vt = this.info.vars.get(name) ?? T.any;
    const n = this.id(name);
    if (vt.k === "any" && !this.cs && !this.declaredLocal.has(name)) {
      this.declaredLocal.add(name);
      return this.go ? `${n} := ${e.c}\n_ = ${n}\n` : `[[maybe_unused]] auto ${n} = ${e.c};\n`;
    }
    return `${n} = ${this.as(e, vt)}${this.end()}\n`;
  }

  private stmt(b: Blockly.Block): string {
    const go = this.go;
    const cpp = this.cpp;
    const cs = this.cs;
    const f = (n: string) => String(b.getFieldValue(n) ?? "");
    const E = this.end();
    switch (b.type) {
      case "variables_set":
        return this.assign(varName(b), this.ex(input(b, "VALUE"), this.info.vars.get(varName(b))));
      case "math_change": {
        const vt = this.info.vars.get(varName(b)) ?? T.int;
        return `${this.id(varName(b))} += ${this.as(this.num(b, "DELTA"), vt)}${E}\n`;
      }
      case "text_append":
        return `${this.id(varName(b))} += ${this.str(this.ex(input(b, "TEXT"), T.str))}${E}\n`;
      case "text_print":
        return this.print(this.ex(input(b, "TEXT"), T.str));
      case "aiz_print_end":
        return this.print(this.ex(input(b, "VALUE"), T.str), false);
      case "aiz_print_many": {
        const a = this.ex(input(b, "A"), T.str);
        const c = this.ex(input(b, "B"), T.str);
        if (go) {
          this.imports.add("fmt");
          return `fmt.Println(${a.c}, ${c.c})\n`;
        }
        return this.print(this.x(`${this.str(a).startsWith('"') && cpp ? `std::string(${this.str(a)})` : this.str(a)} + " " + ${this.str(c)}`, T.str));
      }
      case "aiz_comment":
        return `// ${f("TEXT")}\n`;
      case "controls_if": {
        const count = (b as unknown as { elseifCount_?: number }).elseifCount_ ?? 0;
        const hasElse = !!(b as unknown as { elseCount_?: number }).elseCount_;
        let out = "";
        for (let i = 0; i <= count; i++) {
          const c = this.v(b, `IF${i}`, T.bool);
          const head = go ? `if ${c.c} {` : `if (${c.c}) {`;
          out += `${i === 0 ? "" : go || cs || cpp ? "} else " : ""}${head}\n${this.body(b, `DO${i}`)}`;
        }
        if (hasElse) out += `} else {\n${this.body(b, "ELSE")}`;
        return out + "}\n";
      }
      case "controls_repeat_ext":
      case "controls_repeat": {
        const n = b.type === "controls_repeat" ? this.x(f("TIMES"), T.int, true) : this.num(b, "TIMES");
        const i = this.loopDepth === 0 ? "count" : `count${this.loopDepth + 1}`;
        this.loopDepth++;
        const inner = this.body(b, "DO");
        this.loopDepth--;
        if (go) return `for ${i} := 0; ${i} < ${this.as(n, T.int)}; ${i}++ {\n${inner}}\n`;
        return `for (int ${i} = 0; ${i} < ${this.as(n, T.int)}; ${i}++) {\n${inner}}\n`;
      }
      case "controls_whileUntil": {
        let c = this.v(b, "BOOL", T.bool);
        if (f("MODE") === "UNTIL") c = this.x(`!${this.p(c)}`, T.bool, true);
        this.loopDepth++;
        const inner = this.body(b, "DO");
        this.loopDepth--;
        return go ? `for ${c.c} {\n${inner}}\n` : `while (${c.c}) {\n${inner}}\n`;
      }
      case "controls_for": {
        const name = varName(b);
        const n = this.id(name);
        const vt = this.info.vars.get(name) ?? T.int;
        const from = this.num(b, "FROM");
        const to = this.num(b, "TO");
        const by = input(b, "BY") ? this.num(b, "BY") : this.x("1", T.int, true);
        // 数がそのまま書いてあれば、増やすか減らすかが決まる
        const down = /^-?\d+(\.\d+)?$/.test(from.c) && /^-?\d+(\.\d+)?$/.test(to.c) && Number(from.c) > Number(to.c);
        const step = by.c.replace(/^-/, "");
        this.loopDepth++;
        const inner = this.body(b, "DO");
        this.loopDepth--;
        const cmp = down ? ">=" : "<=";
        const upd = `${n} ${down ? "-=" : "+="} ${this.as(this.x(step, by.t, true), vt)}`;
        if (go) return `for ${n} = ${this.as(from, vt)}; ${n} ${cmp} ${this.as(to, vt)}; ${upd} {\n${inner}}\n`;
        return `for (${n} = ${from.c}; ${n} ${cmp} ${to.c}; ${upd}) {\n${inner}}\n`;
      }
      case "controls_forEach": {
        const n = this.id(varName(b));
        const l = this.v(b, "LIST", T.list(T.int));
        this.loopDepth++;
        const inner = this.body(b, "DO");
        this.loopDepth--;
        if (go) return l.t.k === "str" ? `for _, r := range ${l.c} {\n${this.I}${n} = string(r)\n${inner}}\n` : `for _, ${n} = range ${l.c} {\n${inner}}\n`;
        if (cpp) {
          if (l.t.k === "str") {
            this.need.add("utf8");
            return `for (const auto& ${n} : chars(${l.c})) {\n${inner}}\n`;
          }
          return `for (const auto& ${n} : ${l.c}) {\n${inner}}\n`;
        }
        return l.t.k === "str" ? `foreach (var ch in ${l.c}) {\n${this.I}${n} = ch.ToString();\n${inner}}\n` : `foreach (var ${n} in ${l.c}) {\n${inner}}\n`;
      }
      case "controls_flow_statements":
        return `${f("FLOW") === "BREAK" ? "break" : "continue"}${E}\n`;
      case "aiz_list_append": {
        const l = this.v(b, "LIST", T.list(T.int));
        const item = this.ex(input(b, "ITEM"));
        const it = this.as(item, elemOf(l.t));
        return go ? `${l.c} = append(${l.c}, ${it})\n` : cpp ? `${this.p(l)}.push_back(${it});\n` : `${this.p(l)}.Add(${it});\n`;
      }
      case "lists_setIndex": {
        const l = this.v(b, "LIST", T.list(T.int));
        const at = input(b, "AT") ? this.num(b, "AT") : null;
        const i = this.index(f("WHERE"), at, this.len(l));
        const v = this.as(this.ex(input(b, "TO")), elemOf(l.t));
        if (f("MODE") === "SET") return `${cpp ? `${this.p(l)}.at(${i})` : `${l.c}[${i}]`} = ${v}${E}\n`;
        if (go) {
          this.imports.add("slices");
          return `${l.c} = slices.Insert(${l.c}, ${i}, ${v})\n`;
        }
        return cpp ? `${this.p(l)}.insert(${this.p(l)}.begin() + (${i}), ${v});\n` : `${l.c}.Insert(${i}, ${v});\n`;
      }
      case "lists_getIndex": {
        const mode = f("MODE");
        if (mode === "GET") return `${this.expr(b).c}${E}\n`;
        const l = this.v(b, "VALUE", T.list(T.int));
        const at = input(b, "AT") ? this.num(b, "AT") : null;
        const i = this.index(f("WHERE"), at, this.len(l));
        if (go) {
          this.imports.add("slices");
          return `${l.c} = slices.Delete(${l.c}, ${i}, ${i}+1)\n`;
        }
        return cpp ? `${this.p(l)}.erase(${this.p(l)}.begin() + (${i}));\n` : `${l.c}.RemoveAt(${i});\n`;
      }
      case "lists_sort":
      case "lists_reverse":
        return `${this.expr(b).c}${E}\n`;
      case "aiz_dict_set": {
        const d = this.v(b, "DICT", T.dict(T.str, T.int));
        const k = this.ex(input(b, "KEY"));
        const v = this.ex(input(b, "VALUE"));
        const dt = (d.t.k === "dict" ? d.t : T.dict(T.str, T.int)) as { k: "dict"; key: Ty; val: Ty };
        return `${this.p(d)}[${this.as(k, dt.key)}] = ${this.as(v, dt.val)}${E}\n`;
      }
      case "aiz_dict_delete": {
        const d = this.v(b, "DICT", T.dict(T.str, T.int));
        const k = this.ex(input(b, "KEY"));
        return go ? `delete(${d.c}, ${k.c})\n` : cpp ? `${this.p(d)}.erase(${k.c});\n` : `${this.p(d)}.Remove(${k.c});\n`;
      }
      case "aiz_dict_loop": {
        const d = this.v(b, "DICT", T.dict(T.str, T.int));
        const k = this.id(varName(b, "K"));
        const v = this.id(varName(b, "V"));
        this.loopDepth++;
        const inner = this.body(b, "DO");
        this.loopDepth--;
        if (go) {
          // map の順番は毎回ちがうので、キーの順に並べてから
          this.need.add("sortedKeys");
          return `for _, ${k} = range sortedKeys(${d.c}) {\n${this.I}${v} = ${d.c}[${k}]\n${inner}}\n`;
        }
        if (cpp) return `for (const auto& [${k}, ${v}] : ${d.c}) {\n${inner}}\n`;
        return `foreach (var (${k}, ${v}) in ${d.c}) {\n${inner}}\n`;
      }
      case "procedures_callnoreturn":
        return `${this.id(String(b.getFieldValue("NAME")))}(${this.callArgs(b)})${E}\n`;
      case "procedures_ifreturn": {
        const c = this.v(b, "CONDITION", T.bool);
        const hasValue = (b as unknown as { hasReturnValue_?: boolean }).hasReturnValue_;
        const ret = hasValue ? ` ${this.retValue(b, this.ex(input(b, "VALUE")))}` : "";
        return go ? `if ${c.c} {\n${this.I}return${ret}\n}\n` : `if (${c.c}) {\n${this.I}return${ret};\n}\n`;
      }
      case "aiz_return": {
        const value = input(b, "VALUE");
        return value ? `return ${this.retValue(b, this.ex(value))}${E}\n` : `return${E}\n`;
      }
      case "aiz_self_set": {
        const { cls } = contextOf(b);
        const ft = (cls && this.info.fields.get(cls)?.get(f("ATTR").trim())) || T.any;
        return `${go ? "self." : cpp ? "this->" : "this."}${this.id(f("ATTR"))} = ${this.as(this.ex(input(b, "VALUE")), ft)}${E}\n`;
      }
      case "aiz_attr_set": {
        const o = this.v(b, "OBJ", T.any);
        const ft = o.t.k === "obj" ? (this.info.fields.get(o.t.cls)?.get(f("ATTR").trim()) ?? T.any) : T.any;
        return `${this.p(o)}.${this.id(f("ATTR"))} = ${this.as(this.ex(input(b, "VALUE")), ft)}${E}\n`;
      }
      case "aiz_call_method": {
        const o = this.v(b, "OBJ", T.any);
        const m = f("METHOD").trim();
        const key = o.t.k === "obj" ? `${o.t.cls}.${m}` : "";
        return `${this.p(o)}.${o.t.k === "obj" ? this.id(m) : m}(${this.methodArgs(b, key)})${E}\n`;
      }
      case "aiz_import":
      case "aiz_import_text":
      case "aiz_import_as":
      case "aiz_from_import": {
        const mod = f("MODULE").trim();
        if (!mod) return "";
        if (go) this.userImports.push({ pkg: mod, alias: b.type === "aiz_import_as" ? this.id(f("AS")) : undefined });
        else if (cpp) this.imports.add(mod.replace(/^<|>$/g, "").replace(/\.h$/, ".h"));
        else this.imports.add(b.type === "aiz_from_import" ? `static ${mod}` : b.type === "aiz_import_as" ? `${this.id(f("AS"))} = ${mod}` : mod);
        return "";
      }
      case "aiz_module_call":
        return `${f("MODULE").trim()}${cpp ? "::" : "."}${f("FUNC").trim()}(${this.plainArgs(b)})${E}\n`;
      case "aiz_try":
      case "aiz_try_finally":
        return this.tryBlock(b);
      case "aiz_raise": {
        const msg = input(b, "MSG") ? this.str(this.ex(input(b, "MSG"))) : '""';
        const err = f("ERR");
        if (go) return `panic(${msg})\n`;
        if (cpp) {
          this.include("stdexcept");
          const ct = ERR.cpp[err] && ERR.cpp[err] !== "std::exception" && ERR.cpp[err] !== "std::bad_cast" ? ERR.cpp[err] : "std::runtime_error";
          return `throw ${ct}(${msg});\n`;
        }
        return `throw new ${ERR.csharp[err] === "Exception" ? "Exception" : ERR.csharp[err] ?? "Exception"}(${msg});\n`;
      }
      case "aiz_with_open": {
        const v = this.id(f("VAR"));
        const name = this.v(b, "NAME", T.str);
        const mode = this.q(f("MODE"));
        this.need.add("file");
        const inner = this.body(b, "DO");
        if (go) return `{\n${this.I}${v} := openFile(${name.c}, ${mode})\n${inner}${this.I}${v}.Close()\n}\n`;
        if (cpp) return `{\n${this.I}AizFile ${v}(${name.c}, ${mode});\n${inner}}\n`;
        return `using (var ${v} = new AizFile(${name.c}, ${mode})) {\n${inner}}\n`;
      }
      case "aiz_file_write":
        return `${this.id(f("VAR"))}.${go || cs ? "Write" : "write"}(${this.str(this.ex(input(b, "TEXT"), T.str))})${E}\n`;
      case "aiz_sleep": {
        const s = this.num(b, "SEC");
        if (go) {
          this.imports.add("time");
          return `time.Sleep(time.Duration(${this.as(s, T.float)} * float64(time.Second)))\n`;
        }
        if (cpp) {
          this.include("thread");
          this.include("chrono");
          return `std::this_thread::sleep_for(std::chrono::milliseconds(static_cast<int>(${this.p(s)} * 1000)));\n`;
        }
        return `System.Threading.Thread.Sleep((int)(${this.p(s)} * 1000));\n`;
      }
      case "aiz_pass":
        return "// 何もしない\n";
      case "aiz_main":
        return this.stmts(input(b, "DO"));
      case "aiz_global":
        return `// ${paramList(f("NAMES")).join("、")} は関数の外の変数を使います（${go ? "Go" : cpp ? "C++" : "C#"} では書かなくても使えます）\n`;
      case "aiz_code":
        return `${f("CODE")}\n`;
      // 関数・クラスは main の外に書くので、ここでは何もしない
      case "procedures_defnoreturn":
      case "procedures_defreturn":
      case "aiz_class":
        return "";
      default: {
        // 値のブロックが単独で置かれたとき
        if (b.outputConnection) return `${this.expr(b).c}${E}\n`;
        return `// （${b.type} は ${go ? "Go" : cpp ? "C++" : "C#"} ではまだ書けません）\n`;
      }
    }
  }

  /** 関数・メソッドの返す値を、その型に合わせる */
  private retValue(b: Blockly.Block, e: Ex): string {
    const { cls, method, proc } = contextOf(b);
    const rt = cls && method ? this.info.methodRet.get(`${cls}.${method}`) : proc ? this.info.procRet.get(proc) : undefined;
    return rt ? this.as(e, rt) : e.c;
  }

  private tryBlock(b: Blockly.Block): string {
    const err = String(b.getFieldValue("ERR"));
    const tryCode = this.body(b, "TRY");
    const exceptCode = this.body(b, "EXCEPT");
    const fin = b.type === "aiz_try_finally" ? this.body(b, "FINALLY") : null;
    const I = this.I;
    if (this.go) {
      // Go にはエラーの「投げる・受け取る」がないので、panic と recover で同じ動きにする
      this.imports.add("fmt");
      let out = "func() {\n";
      if (fin !== null) out += `${I}defer func() {\n${this.indent(fin)}${I}}()\n`;
      out += `${I}defer func() {\n${I}${I}if r := recover(); r != nil {\n${I}${I}${I}e := fmt.Sprint(r)\n${I}${I}${I}_ = e\n${this.indent(this.indent(exceptCode))}${I}${I}}\n${I}}()\n`;
      out += tryCode;
      return out + "}()\n";
    }
    if (this.cpp) {
      this.include("stdexcept");
      this.include("string");
      const ct = ERR.cpp[err] ?? "std::exception";
      let out = `try {\n${tryCode}} catch (const ${ct}& ex_) {\n${I}std::string e = ex_.what();\n${exceptCode}}\n`;
      // C++ には finally がないので、後ろに書く（エラーが外に出るときは動かない）
      if (fin !== null) out += `// 最後に、かならず（finally）\n${fin.replace(new RegExp(`^${I}`, "gm"), "")}`;
      return out;
    }
    const ct = ERR.csharp[err] ?? "Exception";
    // エラーの内容を使わないときは、名前を付けない（使っていない変数の警告が出るため）
    const usesE = /\be\.Message\b/.test(exceptCode);
    let out = `try {\n${tryCode}} catch (${ct}${usesE ? " e" : ""}) {\n${exceptCode}}`;
    if (fin !== null) out += ` finally {\n${fin}}`;
    return out + "\n";
  }

  // ───────── 関数・クラス

  private retTy(t: Ty | undefined): Ty {
    return !t || t.k === "?" ? T.void : t;
  }

  private procDef(b: Blockly.Block): string {
    const name = String(b.getFieldValue("NAME"));
    const ps = procParams(b);
    const rt = this.retTy(this.info.procRet.get(name));
    const params = ps.map((p) => this.param(p)).join(", ");
    let inner = this.stmts(input(b, "STACK"));
    if (b.type === "procedures_defreturn" && input(b, "RETURN")) inner += `return ${this.as(this.ex(input(b, "RETURN")), rt)}${this.end()}\n`;
    const body = this.indent(inner);
    if (this.go) return `func ${this.id(name)}(${params})${rt.k === "void" ? "" : " " + this.ty(rt)} {\n${body}}\n`;
    if (this.cpp) return `${this.ty(rt)} ${this.id(name)}(${params}) {\n${body}}\n`;
    return `static ${this.ty(rt)} ${this.id(name)}(${params})\n{\n${body}}\n`;
  }

  private procProto(b: Blockly.Block): string {
    const name = String(b.getFieldValue("NAME"));
    const rt = this.retTy(this.info.procRet.get(name));
    return `${this.ty(rt)} ${this.id(name)}(${procParams(b)
      .map((p) => this.param(p))
      .join(", ")});\n`;
  }

  private param(name: string): string {
    const t = this.info.vars.get(name) ?? T.any;
    if (this.go) return `${this.id(name)} ${this.ty(t)}`;
    if (this.cpp && (t.k === "list" || t.k === "dict" || t.k === "str" || t.k === "obj")) return `${this.ty(t)} ${this.id(name)}`;
    return `${this.ty(t)} ${this.id(name)}`;
  }

  private classDef(b: Blockly.Block): string {
    const clsRaw = String(b.getFieldValue("NAME")).trim();
    const cls = this.id(clsRaw);
    const fields = this.info.fields.get(clsRaw) ?? new Map<string, Ty>();
    const I = this.I;
    const members: Blockly.Block[] = [];
    for (let m = input(b, "BODY"); m; m = m.getNextBlock()) members.push(m);
    const init = members.find((m) => m.type === "aiz_class_init");
    const methods = members.filter((m) => m.type === "aiz_method");
    const others = members.filter((m) => m.type !== "aiz_method" && m.type !== "aiz_class_init");
    const sig = (m: Blockly.Block) => paramList(m.getFieldValue("PARAMS")).map((p) => this.param(p)).join(", ");
    const ret = (m: Blockly.Block) => this.retTy(this.info.methodRet.get(`${clsRaw}.${String(m.getFieldValue("NAME")).trim()}`));
    const note = others.length ? `${I}// （クラスの中の、メソッドではないブロックは使いません）\n` : "";
    if (this.go) {
      let out = `type ${cls} struct {\n${[...fields].map(([k, t]) => `${I}${this.id(k)} ${this.ty(settle(t))}`).join("\n")}${fields.size ? "\n" : ""}}\n\n`;
      out += `func New${cls}(${init ? sig(init) : ""}) *${cls} {\n${I}self := &${cls}{}\n`;
      for (const [k, t] of fields) if (settle(t).k === "dict") out += `${I}self.${this.id(k)} = ${this.ty(settle(t))}{}\n`;
      if (init) out += this.indent(this.stmts(input(init, "BODY")));
      out += `${I}return self\n}\n`;
      for (const m of methods) {
        const rt = ret(m);
        out += `\nfunc (self *${cls}) ${this.id(String(m.getFieldValue("NAME")))}(${sig(m)})${rt.k === "void" ? "" : " " + this.ty(rt)} {\n${this.indent(this.stmts(input(m, "BODY")))}}\n`;
      }
      return out;
    }
    if (this.cpp) {
      let out = `class ${cls} {\npublic:\n`;
      for (const [k, t] of fields) out += `${I}${this.ty(settle(t))} ${this.id(k)}${this.zero(settle(t)) && settle(t).k !== "str" ? ` = ${this.zero(settle(t))}` : ""};\n`;
      out += `\n${I}${cls}() {}\n`;
      if (init && paramList(init.getFieldValue("PARAMS")).length) out += `${I}${cls}(${sig(init)}) {\n${this.indent(this.indent(this.stmts(input(init, "BODY"))))}${I}}\n`;
      else if (init) out = out.replace(`${I}${cls}() {}\n`, `${I}${cls}() {\n${this.indent(this.indent(this.stmts(input(init, "BODY"))))}${I}}\n`);
      for (const m of methods) out += `\n${I}${this.ty(ret(m))} ${this.id(String(m.getFieldValue("NAME")))}(${sig(m)}) {\n${this.indent(this.indent(this.stmts(input(m, "BODY"))))}${I}}\n`;
      return out + note + "};\n";
    }
    let out = `public class ${cls}\n{\n`;
    for (const [k, t] of fields) out += `${I}public ${this.ty(settle(t))} ${this.id(k)}${this.zero(settle(t)) ? ` = ${this.zero(settle(t))}` : ""};\n`;
    if (init) out += `\n${I}public ${cls}(${sig(init)})\n${I}{\n${this.indent(this.indent(this.stmts(input(init, "BODY"))))}${I}}\n`;
    for (const m of methods) out += `\n${I}public ${this.ty(ret(m))} ${this.id(String(m.getFieldValue("NAME")))}(${sig(m)})\n${I}{\n${this.indent(this.indent(this.stmts(input(m, "BODY"))))}${I}}\n`;
    return out + note + "}\n";
  }

  // ───────── 全体

  run(): string {
    const tops = this.ws.getTopBlocks(true).filter((b) => b.isEnabled());
    const procs = tops.filter((b) => b.type === "procedures_defnoreturn" || b.type === "procedures_defreturn");
    const classes = tops.filter((b) => b.type === "aiz_class");
    const mainBlocks = tops.filter((b) => !procs.includes(b) && !classes.includes(b) && !b.outputConnection);
    // import のブロックは何も書かずに、読み込むものとして覚える（つながった下のブロックはふつうに書く）
    let mainCode = "";
    for (const b of mainBlocks) mainCode += this.stmts(b);
    const classCode = classes.map((c) => this.classDef(c));
    const procCode = procs.map((p) => this.procDef(p));
    // 変数（関数の引数・型のわからないものは除く）
    const params = new Set<string>([...procs.flatMap((p) => procParams(p)), ...[...this.info.methodParams.values()].flat()]);
    const loopOnly = new Set<string>();
    if (this.cpp || this.cs) {
      for (const b of this.ws.getAllBlocks(false)) if (b.type === "controls_forEach" || b.type === "aiz_dict_loop") loopOnly.add(varName(b, b.type === "aiz_dict_loop" ? "K" : "VAR")), b.type === "aiz_dict_loop" && loopOnly.add(varName(b, "V"));
      // ループの外でも値を入れている変数は、ふつうに作る
      for (const b of this.ws.getAllBlocks(false)) if (b.type === "variables_set" || b.type === "math_change") loopOnly.delete(varName(b));
    }
    const vars = [...this.info.vars]
      .filter(([name, t]) => !params.has(name) && !loopOnly.has(name) && (t.k !== "any" || this.cs))
      .map(([name, t]) => ({ name, t }));
    if (this.go) return this.goFile(vars, classCode, procCode, mainCode);
    if (this.cpp) return this.cppFile(vars, classCode, procCode, procs, mainCode, classes.length > 0);
    return this.csFile(vars, classCode, procCode, mainCode);
  }

  private goFile(vars: { name: string; t: Ty }[], classCode: string[], procCode: string[], mainCode: string): string {
    const helpers = this.goHelpers();
    // 型をはっきり書く（Go は「= 0」だけだと int になるため）
    const varLines = vars.map(({ name, t }) => `${this.I}${this.id(name)} ${this.ty(t)}${t.k === "dict" ? ` = ${this.zero(t)}` : ""}`);
    const bodyText = [helpers, ...classCode, ...procCode, mainCode].join("\n");
    // 自分で読み込んだもので、使っていないものは _ で読み込む（Go は使っていない import がエラーになる）
    const user = this.userImports.map(({ pkg, alias }) => {
      const short = alias ?? pkg.split("/").pop()!;
      return new RegExp(`\\b${short}\\.`).test(bodyText) ? `${alias ? alias + " " : ""}"${pkg}"` : `_ "${pkg}"`;
    });
    const std = [...this.imports].filter((p) => !this.userImports.some((u) => u.pkg === p && !u.alias)).map((p) => `"${p}"`);
    const all = [...new Set([...std, ...user])].sort((a, b) => a.replace(/^_ |^\w+ /, "").localeCompare(b.replace(/^_ |^\w+ /, "")));
    let out = "package main\n\n";
    if (all.length) out += all.length === 1 ? `import ${all[0]}\n\n` : `import (\n${all.map((i) => `${this.I}${i}`).join("\n")}\n)\n\n`;
    if (varLines.length) out += `var (\n${varLines.join("\n")}\n)\n\n`;
    if (helpers) out += helpers + "\n";
    for (const c of classCode) out += c + "\n";
    for (const p of procCode) out += p + "\n";
    out += `func main() {\n${this.indent(mainCode)}}\n`;
    return out.replace(/\n{3,}/g, "\n\n");
  }

  private cppFile(vars: { name: string; t: Ty }[], classCode: string[], procCode: string[], procs: Blockly.Block[], mainCode: string, hasClasses: boolean): string {
    const helpers = this.cppHelpers();
    const plain = vars.filter((v) => v.t.k !== "obj");
    const objs = vars.filter((v) => v.t.k === "obj");
    const decl = ({ name, t }: { name: string; t: Ty }) => {
      const z = this.zero(t);
      return `${this.ty(t)} ${this.id(name)}${z ? ` = ${z}` : ""};`;
    };
    const plainLines = plain.map(decl);
    const objLines = objs.map(decl);
    const protos = procs.map((p) => this.procProto(p));
    const includes = [...this.imports].sort().map((h) => `#include <${h}>`);
    let out = includes.join("\n") + "\n\n";
    if (helpers) out += helpers + "\n";
    if (hasClasses) out += this.ws.getTopBlocks(true).filter((b) => b.type === "aiz_class").map((b) => `class ${this.id(String(b.getFieldValue("NAME")))};`).join("\n") + "\n\n";
    if (plainLines.length) out += plainLines.join("\n") + "\n\n";
    if (protos.length && (hasClasses || procs.length > 1)) out += protos.join("") + "\n";
    for (const c of classCode) out += c + "\n";
    if (objLines.length) out += objLines.join("\n") + "\n\n";
    for (const p of procCode) out += p + "\n";
    out += `int main() {\n${this.indent(mainCode)}${this.I}return 0;\n}\n`;
    return out.replace(/\n{3,}/g, "\n\n");
  }

  private csFile(vars: { name: string; t: Ty }[], classCode: string[], procCode: string[], mainCode: string): string {
    const helpers = this.csHelpers();
    const I = this.I;
    const usings = new Set(["System", "System.Collections.Generic", "System.Linq", ...this.imports]);
    let out = "#nullable disable\n" + [...usings].map((u) => `using ${u};`).join("\n") + "\n\n";
    out += "class Program\n{\n";
    for (const { name, t } of vars) {
      const z = this.zero(t);
      out += `${I}static ${this.ty(t)} ${this.id(name)}${z ? ` = ${z}` : ""};\n`;
    }
    if (vars.length) out += "\n";
    for (const c of classCode) out += this.indent(c) + "\n";
    for (const p of procCode) out += this.indent(p) + "\n";
    out += `${I}static void Main(string[] args)\n${I}{\n${this.indent(this.indent(mainCode))}${I}}\n`;
    if (helpers) out += "\n" + this.indent(helpers);
    out += "}\n";
    return out.replace(/\n{3,}/g, "\n\n");
  }

  // ───────── 助けの関数（使うものだけ書く）

  private goHelpers(): string {
    const n = this.need;
    const h: string[] = [];
    const imp = (...p: string[]) => p.forEach((x) => this.imports.add(x));
    if (n.has("input")) {
      imp("bufio", "fmt", "os", "strings");
      h.push(`var reader = bufio.NewReader(os.Stdin)

// キーボードから 1 行読む
func input(prompt string) string {
	fmt.Print(prompt)
	s, _ := reader.ReadString('\\n')
	return strings.TrimRight(s, "\\r\\n")
}`);
    }
    if (n.has("convert")) {
      imp("strconv", "strings");
      h.push(`// 文字を整数に（できなければ止まる）
func toInt(s string) int {
	v, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		panic("整数にできません: " + s)
	}
	return v
}

// 文字を小数に（できなければ止まる）
func toFloat(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		panic("小数にできません: " + s)
	}
	return v
}`);
    }
    if (n.has("modInt")) h.push(`// 余り（Python と同じく、割る数と同じ符号）
func modInt(a, b int) int {
	return ((a % b) + b) % b
}`);
    if (n.has("absInt")) h.push(`func absInt(a int) int {
	if a < 0 {
		return -a
	}
	return a
}`);
    if (n.has("isPrime")) h.push(`// 素数かどうか
func isPrime(n int) bool {
	if n < 2 {
		return false
	}
	for i := 2; i*i <= n; i++ {
		if n%i == 0 {
			return false
		}
	}
	return true
}`);
    if (n.has("substr")) h.push(`// 文字の一部（日本語も 1 文字ずつ数える）
func substr(s string, start, length int) string {
	r := []rune(s)
	if start < 0 {
		start = 0
	}
	end := start + length
	if end > len(r) {
		end = len(r)
	}
	if start >= end {
		return ""
	}
	return string(r[start:end])
}`);
    if (n.has("textIndex")) {
      imp("strings");
      h.push(`// 文字の中で何文字目にあるか（1 から。なければ 0）
func textIndex(s, sub string, last bool) int {
	i := strings.Index(s, sub)
	if last {
		i = strings.LastIndex(s, sub)
	}
	if i < 0 {
		return 0
	}
	return len([]rune(s[:i])) + 1
}`);
    }
    if (n.has("title")) {
      imp("strings");
      h.push(`// 単語の頭を大文字に
func title(s string) string {
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		r := []rune(w)
		words[i] = strings.ToUpper(string(r[0])) + string(r[1:])
	}
	return strings.Join(words, " ")
}`);
    }
    if (n.has("reverseText")) h.push(`// 文字を逆の順に
func reverseText(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}`);
    if (n.has("listMath")) {
      imp("math", "sort");
      h.push(`type number interface{ ~int | ~float64 }

func sum[T number](xs []T) T {
	var s T
	for _, x := range xs {
		s += x
	}
	return s
}

func minOf[T number](xs []T) T {
	m := xs[0]
	for _, x := range xs {
		if x < m {
			m = x
		}
	}
	return m
}

func maxOf[T number](xs []T) T {
	m := xs[0]
	for _, x := range xs {
		if x > m {
			m = x
		}
	}
	return m
}

func average[T number](xs []T) float64 {
	return float64(sum(xs)) / float64(len(xs))
}

func median[T number](xs []T) float64 {
	s := append([]T{}, xs...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	if len(s)%2 == 1 {
		return float64(s[len(s)/2])
	}
	return float64(s[len(s)/2-1]+s[len(s)/2]) / 2
}

func modes[T number](xs []T) []T {
	count := map[T]int{}
	best := 0
	for _, x := range xs {
		count[x]++
		if count[x] > best {
			best = count[x]
		}
	}
	out := []T{}
	for _, x := range xs {
		if count[x] == best {
			out = append(out, x)
			count[x] = 0
		}
	}
	return out
}

func stdev[T number](xs []T) float64 {
	m := average(xs)
	s := 0.0
	for _, x := range xs {
		s += (float64(x) - m) * (float64(x) - m)
	}
	return math.Sqrt(s / float64(len(xs)))
}

func choice[T any](xs []T) T {
	return xs[rand.Intn(len(xs))]
}`);
      imp("math/rand");
    }
    if (n.has("listIndex")) h.push(`// リストの中で何番目にあるか（1 から。なければ 0）
func listIndex[T comparable](xs []T, x T, last bool) int {
	found := 0
	for i, v := range xs {
		if v == x {
			found = i + 1
			if !last {
				break
			}
		}
	}
	return found
}`);
    if (n.has("pop")) h.push(`// リストから取り出して消す
func pop[T any](xs *[]T, i int) T {
	v := (*xs)[i]
	*xs = append((*xs)[:i], (*xs)[i+1:]...)
	return v
}`);
    if (n.has("repeatList")) h.push(`func repeatList[T any](x T, n int) []T {
	out := make([]T, n)
	for i := range out {
		out[i] = x
	}
	return out
}`);
    if (n.has("sorted")) {
      imp("sort", "strings", "fmt");
      h.push(`// 並べかえたもの（元のリストは変えない）
func sorted[T any](xs []T, desc, ignoreCase bool) []T {
	s := append([]T{}, xs...)
	less := func(a, b T) bool {
		switch x := any(a).(type) {
		case int:
			return x < any(b).(int)
		case float64:
			return x < any(b).(float64)
		case string:
			y := any(b).(string)
			if ignoreCase {
				return strings.ToLower(x) < strings.ToLower(y)
			}
			return x < y
		}
		return fmt.Sprint(a) < fmt.Sprint(b)
	}
	sort.SliceStable(s, func(i, j int) bool {
		if desc {
			return less(s[j], s[i])
		}
		return less(s[i], s[j])
	})
	return s
}`);
    }
    if (n.has("reversed")) h.push(`// 逆の順にしたもの
func reversed[T any](xs []T) []T {
	out := make([]T, len(xs))
	for i, x := range xs {
		out[len(xs)-1-i] = x
	}
	return out
}`);
    if (n.has("strList")) {
      imp("fmt");
      h.push(`func strList[T any](xs []T) []string {
	out := []string{}
	for _, x := range xs {
		out = append(out, fmt.Sprint(x))
	}
	return out
}`);
    }
    if (n.has("mustGet")) {
      imp("fmt");
      h.push(`// 辞書から取り出す（キーがなければ止まる。Python の KeyError と同じ）
func mustGet[K comparable, V any](m map[K]V, k K) V {
	v, ok := m[k]
	if !ok {
		panic(fmt.Sprint("キーがありません: ", k))
	}
	return v
}`);
    }
    if (n.has("getOr")) h.push(`// 辞書から取り出す（なければかわりの値）
func getOr[K comparable, V any](m map[K]V, k K, def V) V {
	if v, ok := m[k]; ok {
		return v
	}
	return def
}`);
    if (n.has("keysValues") || n.has("sortedKeys")) {
      imp("sort", "fmt");
      h.push(`// キーを順に並べたもの（Go の map は順番が決まらないため）
func sortedKeys[K comparable, V any](m map[K]V) []K {
	keys := make([]K, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return fmt.Sprint(keys[i]) < fmt.Sprint(keys[j]) })
	return keys
}`);
      if (n.has("keysValues")) h.push(`func keysOf[K comparable, V any](m map[K]V) []K {
	return sortedKeys(m)
}

func valuesOf[K comparable, V any](m map[K]V) []V {
	out := []V{}
	for _, k := range sortedKeys(m) {
		out = append(out, m[k])
	}
	return out
}`);
    }
    if (n.has("file") || n.has("readFile")) {
      imp("os", "strings");
      if (n.has("file")) h.push(`// ファイルを開く（r：読む・w：書く・a：追記）。最後に Close で書きこむ
type aizFile struct {
	name, mode string
	buf        strings.Builder
	text       string
}

func openFile(name, mode string) *aizFile {
	f := &aizFile{name: name, mode: mode}
	if mode == "r" {
		data, err := os.ReadFile(name)
		if err != nil {
			panic("ファイルがありません: " + name)
		}
		f.text = string(data)
	}
	return f
}

func (f *aizFile) Read() string { return f.text }

func (f *aizFile) ReadLines() []string {
	lines := strings.SplitAfter(f.text, "\\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func (f *aizFile) Write(s string) { f.buf.WriteString(s) }

func (f *aizFile) Close() {
	if f.mode == "w" {
		os.WriteFile(f.name, []byte(f.buf.String()), 0644)
	} else if f.mode == "a" {
		file, _ := os.OpenFile(f.name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		file.WriteString(f.buf.String())
		file.Close()
	}
}`);
      if (n.has("readFile")) h.push(`func readFile(name string) string {
	data, err := os.ReadFile(name)
	if err != nil {
		panic("ファイルがありません: " + name)
	}
	return string(data)
}`);
    }
    return h.join("\n\n") + (h.length ? "\n" : "");
  }

  private cppHelpers(): string {
    const n = this.need;
    const h: string[] = [];
    const inc = (...x: string[]) => x.forEach((i) => this.include(i));
    if (n.has("show") || n.has("print")) {
      inc("sstream", "string", "vector", "map");
      h.push(`// 値を文字にする（リスト・辞書・真偽値も見やすく）
std::string show(const std::string& v) { return v; }
std::string show(const char* v) { return v; }
std::string show(bool v) { return v ? "true" : "false"; }
template <class T> std::string show(const T& v) {
    std::ostringstream os;
    os << v;
    return os.str();
}
template <class T> std::string show(const std::vector<T>& v) {
    std::string s = "[";
    for (size_t i = 0; i < v.size(); i++) s += (i ? ", " : "") + show(v[i]);
    return s + "]";
}
template <class K, class V> std::string show(const std::map<K, V>& m) {
    std::string s = "{";
    bool first = true;
    for (const auto& [k, v] : m) {
        s += (first ? "" : ", ") + show(k) + ": " + show(v);
        first = false;
    }
    return s + "}";
}`);
    }
    if (n.has("input")) {
      inc("iostream", "string");
      h.push(`// キーボードから 1 行読む
std::string input(const std::string& prompt) {
    std::cout << prompt << std::flush;
    std::string s;
    std::getline(std::cin, s);
    if (!s.empty() && s.back() == '\\r') s.pop_back();
    return s;
}`);
    }
    if (n.has("convert")) {
      inc("string", "stdexcept");
      h.push(`// 文字を整数・小数に（できなければエラー）
int toInt(const std::string& s) {
    size_t used = 0;
    int v = std::stoi(s, &used);
    if (s.find_first_not_of(" \\t", used) != std::string::npos) throw std::invalid_argument("整数にできません: " + s);
    return v;
}
double toFloat(const std::string& s) { return std::stod(s); }`);
    }
    if (n.has("modInt")) h.push(`// 余り（Python と同じく、割る数と同じ符号）
int modInt(int a, int b) { return ((a % b) + b) % b; }`);
    if (n.has("isPrime")) h.push(`bool isPrime(int n) {
    if (n < 2) return false;
    for (int i = 2; i * i <= n; i++)
        if (n % i == 0) return false;
    return true;
}`);
    if (n.has("randint")) {
      inc("random");
      h.push(`std::mt19937 rng(std::random_device{}());
int randint(int a, int b) { return std::uniform_int_distribution<int>(a, b)(rng); }
double randfloat() { return std::uniform_real_distribution<double>(0.0, 1.0)(rng); }`);
    }
    if (n.has("utf8") || n.has("substr") || n.has("reverseText") || n.has("textIndex")) {
      inc("string", "vector");
      h.push(`// 日本語も 1 文字ずつ数えるために、文字ごとに分ける（UTF-8）
std::vector<std::string> chars(const std::string& s) {
    std::vector<std::string> out;
    for (size_t i = 0; i < s.size();) {
        unsigned char c = s[i];
        size_t n = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : 4;
        out.push_back(s.substr(i, n));
        i += n;
    }
    return out;
}
int ulen(const std::string& s) { return static_cast<int>(chars(s).size()); }`);
    }
    if (n.has("substr")) inc("algorithm");
    if (n.has("substr")) h.push(`// 文字の一部（start 文字目から length 文字）
std::string substr(const std::string& s, int start, int length) {
    auto c = chars(s);
    std::string out;
    for (int i = std::max(0, start); i < start + length && i < static_cast<int>(c.size()); i++) out += c[i];
    return out;
}`);
    if (n.has("textIndex")) h.push(`// 文字の中で何文字目にあるか（1 から。なければ 0）
int textIndex(const std::string& s, const std::string& sub, bool last) {
    size_t i = last ? s.rfind(sub) : s.find(sub);
    return i == std::string::npos ? 0 : ulen(s.substr(0, i)) + 1;
}`);
    if (n.has("reverseText")) h.push(`std::string reverseText(const std::string& s) {
    auto c = chars(s);
    std::string out;
    for (auto it = c.rbegin(); it != c.rend(); ++it) out += *it;
    return out;
}`);
    if (n.has("caseConv") || n.has("title")) {
      inc("cctype", "string");
      h.push(`std::string upper(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return s;
}
std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}`);
      if (n.has("title")) h.push(`std::string title(std::string s) {
    bool start = true;
    for (auto& c : s) {
        c = static_cast<char>(start ? std::toupper(static_cast<unsigned char>(c)) : std::tolower(static_cast<unsigned char>(c)));
        start = c == ' ';
    }
    return s;
}`);
    }
    if (n.has("trim")) h.push(`// 前後の空白を取る（1：前・2：後ろ・3：両方）
std::string trim(std::string s, int where) {
    const char* ws = " \\t\\r\\n";
    if (where & 1) s.erase(0, s.find_first_not_of(ws) == std::string::npos ? s.size() : s.find_first_not_of(ws));
    if (where & 2) s.erase(s.find_last_not_of(ws) + 1);
    return s;
}`);
    if (n.has("countText")) h.push(`int countText(const std::string& s, const std::string& sub) {
    if (sub.empty()) return 0;
    int n = 0;
    for (size_t i = s.find(sub); i != std::string::npos; i = s.find(sub, i + sub.size())) n++;
    return n;
}`);
    if (n.has("replaceAll")) h.push(`std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
    if (from.empty()) return s;
    for (size_t i = s.find(from); i != std::string::npos; i = s.find(from, i + to.size())) s.replace(i, from.size(), to);
    return s;
}`);
    if (n.has("split")) h.push(`std::vector<std::string> split(const std::string& s, const std::string& sep) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = s.find(sep); i != std::string::npos && !sep.empty(); i = s.find(sep, start)) {
        out.push_back(s.substr(start, i - start));
        start = i + sep.size();
    }
    out.push_back(s.substr(start));
    return out;
}`);
    if (n.has("strList")) h.push(`template <class T> std::vector<std::string> strList(const std::vector<T>& xs) {
    std::vector<std::string> out;
    for (const auto& x : xs) out.push_back(show(x));
    return out;
}`);
    if (n.has("join")) h.push(`std::string join(const std::vector<std::string>& xs, const std::string& sep) {
    std::string out;
    for (size_t i = 0; i < xs.size(); i++) out += (i ? sep : "") + xs[i];
    return out;
}`);
    if (n.has("listMath")) {
      inc("algorithm", "cmath", "map", "numeric", "vector");
      if (!n.has("randint")) {
        inc("random");
        h.push(`std::mt19937 rng(std::random_device{}());`);
      }
      h.push(`template <class T> T sum(const std::vector<T>& xs) { return std::accumulate(xs.begin(), xs.end(), T{}); }
template <class T> T minOf(const std::vector<T>& xs) { return *std::min_element(xs.begin(), xs.end()); }
template <class T> T maxOf(const std::vector<T>& xs) { return *std::max_element(xs.begin(), xs.end()); }
template <class T> double average(const std::vector<T>& xs) { return static_cast<double>(sum(xs)) / xs.size(); }
template <class T> double median(std::vector<T> xs) {
    std::sort(xs.begin(), xs.end());
    size_t n = xs.size();
    return n % 2 ? static_cast<double>(xs[n / 2]) : (xs[n / 2 - 1] + xs[n / 2]) / 2.0;
}
template <class T> std::vector<T> modes(const std::vector<T>& xs) {
    std::map<T, int> count;
    int best = 0;
    for (const auto& x : xs) best = std::max(best, ++count[x]);
    std::vector<T> out;
    for (const auto& x : xs)
        if (count[x] == best) {
            out.push_back(x);
            count[x] = 0;
        }
    return out;
}
template <class T> double stdev(const std::vector<T>& xs) {
    double m = average(xs), s = 0;
    for (const auto& x : xs) s += (x - m) * (x - m);
    return std::sqrt(s / xs.size());
}
template <class T> T choice(const std::vector<T>& xs) { return xs[std::uniform_int_distribution<size_t>(0, xs.size() - 1)(rng)]; }`);
    }
    if (n.has("listIndex")) h.push(`// リストの中で何番目にあるか（1 から。なければ 0）
template <class T> int listIndex(const std::vector<T>& xs, const T& x, bool last) {
    int found = 0;
    for (size_t i = 0; i < xs.size(); i++)
        if (xs[i] == x) {
            found = static_cast<int>(i) + 1;
            if (!last) break;
        }
    return found;
}`);
    if (n.has("pop")) h.push(`// リストから取り出して消す
template <class T> T pop(std::vector<T>& xs, int i) {
    T v = xs.at(i);
    xs.erase(xs.begin() + i);
    return v;
}`);
    if (n.has("sorted")) {
      inc("algorithm");
      h.push(`// 並べかえたもの（元のリストは変えない）
template <class T> std::vector<T> sorted(std::vector<T> xs, bool desc, bool ignoreCase) {
    std::stable_sort(xs.begin(), xs.end(), [&](const T& a, const T& b) {
        if constexpr (std::is_same_v<T, std::string>) {
            if (ignoreCase) return desc ? lower(b) < lower(a) : lower(a) < lower(b);
        }
        return desc ? b < a : a < b;
    });
    return xs;
}`);
      if (!n.has("caseConv")) {
        n.add("caseConv");
        inc("cctype");
        h.splice(h.length - 1, 0, `std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}`);
      }
    }
    if (n.has("reversed")) h.push(`template <class T> std::vector<T> reversed(std::vector<T> xs) {
    std::reverse(xs.begin(), xs.end());
    return xs;
}`);
    if (n.has("getOr")) h.push(`template <class K, class V> V getOr(const std::map<K, V>& m, const K& k, const V& def) {
    auto it = m.find(k);
    return it == m.end() ? def : it->second;
}`);
    if (n.has("keysValues")) h.push(`template <class K, class V> std::vector<K> keysOf(const std::map<K, V>& m) {
    std::vector<K> out;
    for (const auto& [k, v] : m) out.push_back(k);
    return out;
}
template <class K, class V> std::vector<V> valuesOf(const std::map<K, V>& m) {
    std::vector<V> out;
    for (const auto& [k, v] : m) out.push_back(v);
    return out;
}`);
    if (n.has("file") || n.has("readFile")) {
      inc("fstream", "sstream", "string", "vector", "stdexcept");
      h.push(`std::string readFile(const std::string& name) {
    std::ifstream in(name);
    if (!in) throw std::runtime_error("ファイルがありません: " + name);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}`);
      if (n.has("file")) h.push(`// ファイルを開く（r：読む・w：書く・a：追記）。ブロックの終わりで書きこむ
struct AizFile {
    std::string name, mode, text, buf;
    AizFile(const std::string& n, const std::string& m) : name(n), mode(m) {
        if (mode == "r") text = readFile(name);
    }
    std::string read() const { return text; }
    std::vector<std::string> readlines() const {
        std::vector<std::string> out;
        size_t start = 0;
        for (size_t i = text.find('\\n'); i != std::string::npos; i = text.find('\\n', start)) {
            out.push_back(text.substr(start, i - start + 1));
            start = i + 1;
        }
        if (start < text.size()) out.push_back(text.substr(start));
        return out;
    }
    void write(const std::string& s) { buf += s; }
    ~AizFile() {
        if (mode == "w" || mode == "a") {
            std::ofstream out(name, mode == "a" ? std::ios::app : std::ios::trunc);
            out << buf;
        }
    }
};`);
    }
    return h.join("\n\n") + (h.length ? "\n" : "");
  }

  private csHelpers(): string {
    const n = this.need;
    const h: string[] = [];
    if (n.has("show")) h.push(`// 値を文字にする（リスト・辞書も見やすく）
static string Show(object v)
{
    if (v is null) return "null";
    if (v is string s) return s;
    if (v is bool b) return b ? "True" : "False";
    if (v is System.Collections.IDictionary d)
    {
        var parts = new List<string>();
        foreach (System.Collections.DictionaryEntry e in d) parts.Add(Show(e.Key) + ": " + Show(e.Value));
        return "{" + string.Join(", ", parts) + "}";
    }
    if (v is System.Collections.IEnumerable list)
    {
        var parts = new List<string>();
        foreach (var x in list) parts.Add(Show(x));
        return "[" + string.Join(", ", parts) + "]";
    }
    return Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) ?? "";
}`);
    if (n.has("input")) h.push(`// キーボードから 1 行読む
static string Input(string prompt)
{
    Console.Write(prompt);
    return Console.ReadLine() ?? "";
}`);
    if (n.has("modInt")) h.push(`// 余り（Python と同じく、割る数と同じ符号）
static int ModInt(int a, int b) => ((a % b) + b) % b;`);
    if (n.has("isPrime")) h.push(`static bool IsPrime(int n)
{
    if (n < 2) return false;
    for (int i = 2; i * i <= n; i++)
        if (n % i == 0) return false;
    return true;
}`);
    if (n.has("rand") || n.has("listMath")) h.push(`static readonly Random Rnd = new Random();`);
    if (n.has("substr")) h.push(`// 文字の一部（start 文字目から length 文字）
static string Substr(string s, int start, int length)
{
    start = Math.Max(0, start);
    length = Math.Min(length, s.Length - start);
    return length <= 0 ? "" : s.Substring(start, length);
}`);
    if (n.has("textIndex")) h.push(`// 文字の中で何文字目にあるか（1 から。なければ 0）
static int TextIndex(string s, string sub, bool last) => (last ? s.LastIndexOf(sub, StringComparison.Ordinal) : s.IndexOf(sub, StringComparison.Ordinal)) + 1;`);
    if (n.has("title")) h.push(`static string Title(string s) => System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(s.ToLower());`);
    if (n.has("countText")) h.push(`static int CountText(string s, string sub)
{
    if (sub.Length == 0) return 0;
    int n = 0;
    for (int i = s.IndexOf(sub, StringComparison.Ordinal); i >= 0; i = s.IndexOf(sub, i + sub.Length, StringComparison.Ordinal)) n++;
    return n;
}`);
    if (n.has("reverseText")) h.push(`static string ReverseText(string s)
{
    var c = s.ToCharArray();
    Array.Reverse(c);
    return new string(c);
}`);
    if (n.has("strList")) h.push(`static List<string> StrList<T>(List<T> xs) => xs.Select(x => Show(x!)).ToList();`);
    if (n.has("listMath")) h.push(`static T Sum<T>(List<T> xs) where T : System.Numerics.INumber<T> => xs.Aggregate(T.Zero, (a, b) => a + b);
static T MinOf<T>(List<T> xs) => xs.Min()!;
static T MaxOf<T>(List<T> xs) => xs.Max()!;
static double Average<T>(List<T> xs) where T : System.Numerics.INumber<T> => double.CreateChecked(Sum(xs)) / xs.Count;
static double Median<T>(List<T> xs) where T : System.Numerics.INumber<T>
{
    var s = xs.OrderBy(x => x).ToList();
    int n = s.Count;
    return n % 2 == 1 ? double.CreateChecked(s[n / 2]) : (double.CreateChecked(s[n / 2 - 1]) + double.CreateChecked(s[n / 2])) / 2;
}
static List<T> Modes<T>(List<T> xs) where T : notnull
{
    var g = xs.GroupBy(x => x).ToList();
    int best = g.Max(x => x.Count());
    return g.Where(x => x.Count() == best).Select(x => x.Key).ToList();
}
static double Stdev<T>(List<T> xs) where T : System.Numerics.INumber<T>
{
    double m = Average(xs);
    return Math.Sqrt(xs.Sum(x => Math.Pow(double.CreateChecked(x) - m, 2)) / xs.Count);
}
static T Choice<T>(List<T> xs) => xs[Rnd.Next(xs.Count)];`);
    if (n.has("listIndex")) h.push(`// リストの中で何番目にあるか（1 から。なければ 0）
static int ListIndex<T>(List<T> xs, T x, bool last) => (last ? xs.LastIndexOf(x) : xs.IndexOf(x)) + 1;`);
    if (n.has("pop")) h.push(`// リストから取り出して消す
static T Pop<T>(List<T> xs, int i)
{
    T v = xs[i];
    xs.RemoveAt(i);
    return v;
}`);
    if (n.has("sorted")) h.push(`// 並べかえたもの（元のリストは変えない）
static List<T> Sorted<T>(List<T> xs, bool desc, bool ignoreCase)
{
    var cmp = typeof(T) == typeof(string) && ignoreCase ? (IComparer<T>)StringComparer.OrdinalIgnoreCase : Comparer<T>.Default;
    var s = desc ? xs.OrderByDescending(x => x, cmp) : xs.OrderBy(x => x, cmp);
    return s.ToList();
}`);
    if (n.has("reversed")) h.push(`static List<T> Reversed<T>(List<T> xs) => Enumerable.Reverse(xs).ToList();`);
    if (n.has("getOr")) h.push(`static V GetOr<K, V>(Dictionary<K, V> d, K k, V def) where K : notnull => d.TryGetValue(k, out var v) ? v : def;`);
    if (n.has("keysValues")) h.push(`static List<K> Keys<K, V>(Dictionary<K, V> d) where K : notnull => d.Keys.ToList();
static List<V> Values<K, V>(Dictionary<K, V> d) where K : notnull => d.Values.ToList();`);
    if (n.has("readFile") || n.has("file")) h.push(`static string ReadFile(string name) => System.IO.File.ReadAllText(name);`);
    if (n.has("file")) h.push(`// ファイルを開く（r：読む・w：書く・a：追記）。using の終わりで書きこむ
class AizFile : IDisposable
{
    readonly string name, mode, text = "";
    readonly System.Text.StringBuilder buf = new();
    public AizFile(string name, string mode)
    {
        this.name = name;
        this.mode = mode;
        if (mode == "r") text = System.IO.File.ReadAllText(name);
    }
    public string Read() => text;
    public List<string> ReadLines() => System.Text.RegularExpressions.Regex.Split(text, "(?<=\\n)").Where(l => l.Length > 0).ToList();
    public void Write(string s) => buf.Append(s);
    public void Dispose()
    {
        if (mode == "w") System.IO.File.WriteAllText(name, buf.ToString());
        else if (mode == "a") System.IO.File.AppendAllText(name, buf.ToString());
    }
}`);
    return h.join("\n\n") + (h.length ? "\n" : "");
  }
}
