import { runtimes, tools } from "../core/platform";
// 本物の Python で文法を確かめる（字下げ・構文のまちがいを、Python と同じ判定で見つける）。
// 文法が正しいときは、実行するとエラーになりやすい書き方も調べる（input() のまま計算・引数の数・global 忘れ など）。
// 中身は標準入力で渡し、結果は JSON で受け取る

export const PY_CHECK = String.raw`
import sys, json, ast, warnings
src = sys.stdin.buffer.read().decode("utf-8", "replace")
out = []
def add(kind, typ, msg, line, col=0, eline=None, ecol=None):
    out.append({"k": kind, "t": typ, "m": msg, "l": line or 1, "c": col or 0, "el": eline, "ec": ecol})
tree = None
try:
    with warnings.catch_warnings(record=True) as ws:
        warnings.simplefilter("always")
        tree = compile(src, "<code>", "exec", flags=ast.PyCF_ONLY_AST, dont_inherit=True)
        compile(tree, "<code>", "exec", dont_inherit=True)
    for w in ws:
        if issubclass(w.category, SyntaxWarning) or issubclass(w.category, DeprecationWarning):
            add("warning", w.category.__name__, str(w.message), w.lineno, 0)
except SyntaxError as e:
    add("error", type(e).__name__, e.msg or "invalid syntax", e.lineno, e.offset, getattr(e, "end_lineno", None), getattr(e, "end_offset", None))
    tree = None
except (ValueError, RecursionError, MemoryError) as e:
    tree = None

def pos(n):
    return (getattr(n, "lineno", 1), getattr(n, "col_offset", 0) + 1, getattr(n, "end_lineno", None), (getattr(n, "end_col_offset", 0) or 0) + 1)

def note(n, key, **kw):
    l, c, el, ec = pos(n)
    add("warning", "lint", key + ("|" + json.dumps(kw, ensure_ascii=False) if kw else ""), l, c, el, ec)

if tree is not None:
    BUILTINS = set(dir(__builtins__)) if not isinstance(__builtins__, dict) else set(__builtins__)
    # ── 文字列のままの input() で計算している
    inputs = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name) and n.value.func.id == "input":
            for tg in n.targets:
                if isinstance(tg, ast.Name):
                    inputs.setdefault(tg.id, []).append(n.lineno)
    assigns = {}
    for n in ast.walk(tree):
        if isinstance(n, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            tgs = n.targets if isinstance(n, ast.Assign) else [n.target]
            for tg in tgs:
                if isinstance(tg, ast.Name):
                    assigns.setdefault(tg.id, []).append((n.lineno, n))
        elif isinstance(n, (ast.For, ast.comprehension)) and isinstance(n.target, ast.Name):
            assigns.setdefault(n.target.id, []).append((getattr(n, "lineno", 0) or 0, n))
    def still_str(name, line):
        # その行より前で、いちばん近い代入が input() のままか
        best = None
        for (l, a) in assigns.get(name, []):
            if l < line and (best is None or l > best[0]):
                best = (l, a)
        if best is None:
            return False
        a = best[1]
        return isinstance(a, ast.Assign) and isinstance(a.value, ast.Call) and isinstance(a.value.func, ast.Name) and a.value.func.id == "input"
    def is_num(x):
        return isinstance(x, ast.Constant) and isinstance(x.value, (int, float)) and not isinstance(x.value, bool)
    def str_name(x):
        return isinstance(x, ast.Name) and x.id in inputs and still_str(x.id, x.lineno)
    for n in ast.walk(tree):
        if isinstance(n, ast.BinOp) and not isinstance(n.op, ast.Mod):
            for a, b in ((n.left, n.right), (n.right, n.left)):
                if str_name(a) and (is_num(b) or (isinstance(n.op, (ast.Sub, ast.Div, ast.FloorDiv, ast.Pow)))):
                    note(a, "input_str", name=a.id)
                    break
        elif isinstance(n, ast.Compare):
            items = [n.left] + list(n.comparators)
            for i, op in enumerate(n.ops):
                a, b = items[i], items[i + 1]
                for x, y in ((a, b), (b, a)):
                    if str_name(x) and is_num(y):
                        note(x, "input_cmp", name=x.id)
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "range":
            for arg in n.args:
                if str_name(arg):
                    note(arg, "input_str", name=arg.id)
    # ── 文字と数を + でつなぐ
    for n in ast.walk(tree):
        if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add):
            l, r = n.left, n.right
            if (isinstance(l, (ast.Constant, ast.JoinedStr)) and (isinstance(l, ast.JoinedStr) or isinstance(l.value, str)) and is_num(r)) or (is_num(l) and isinstance(r, ast.Constant) and isinstance(r.value, str)):
                note(n, "str_plus_num")
        if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Div, ast.FloorDiv, ast.Mod)) and isinstance(n.right, ast.Constant) and n.right.value == 0 and not isinstance(n.right.value, bool):
            note(n.right, "div_zero")
    # ── 自分で作った関数の引数の数
    funcs = {}
    for st in tree.body:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = st.args
            if a.vararg or a.kwarg:
                continue
            pos_args = list(a.posonlyargs) + list(a.args)
            required = len(pos_args) - len(a.defaults)
            funcs[st.name] = (required, len(pos_args), [x.arg for x in pos_args], [x.arg for x in a.kwonlyargs], st.lineno)
    redefined = {k for k, v in assigns.items() if k in funcs}
    for n in ast.walk(tree):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in funcs and n.func.id not in redefined:
            if any(isinstance(x, ast.Starred) for x in n.args) or any(k.arg is None for k in n.keywords):
                continue
            required, total, names, kwonly, _ = funcs[n.func.id]
            given_names = {k.arg for k in n.keywords}
            npos = len(n.args)
            filled = npos + len([k for k in n.keywords if k.arg in names[npos:]])
            bad_kw = [k for k in given_names if k not in names and k not in kwonly]
            if bad_kw:
                note(n, "bad_kw", name=n.func.id, kw=bad_kw[0])
            elif npos > total:
                note(n, "too_many", name=n.func.id, want=str(total), got=str(npos))
            elif filled < required:
                note(n, "too_few", name=n.func.id, want=str(required), got=str(filled))
    # ── 定義より前で関数を呼んでいる（いちばん外側の文だけ。実行した時点ではまだない）
    top_defs = {}
    for st in tree.body:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            top_defs.setdefault(st.name, st.lineno)
    class TopCalls(ast.NodeVisitor):
        def visit_FunctionDef(self, n): pass
        def visit_AsyncFunctionDef(self, n): pass
        def visit_ClassDef(self, n): pass
        def visit_Lambda(self, n): pass
        def visit_Call(self, n):
            if isinstance(n.func, ast.Name) and n.func.id in top_defs and n.lineno < top_defs[n.func.id] and not any(l < n.lineno for (l, _) in assigns.get(n.func.id, [])):
                note(n.func, "before_def", name=n.func.id, line=str(top_defs[n.func.id]))
            self.generic_visit(n)
    for st in tree.body:
        if not isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            TopCalls().visit(st)
    # ── 関数の中で外の変数を書きかえている（global 忘れ → UnboundLocalError）
    module_names = set()
    for st in tree.body:
        for n in ast.walk(st):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                module_names.add(n.name)
        if isinstance(st, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            for tg in (st.targets if isinstance(st, ast.Assign) else [st.target]):
                if isinstance(tg, ast.Name):
                    module_names.add(tg.id)
        elif isinstance(st, (ast.For,)) and isinstance(st.target, ast.Name):
            module_names.add(st.target.id)
    def own_nodes(fn):
        # 入れ子の関数・クラスの中は除く
        stack = list(fn.body)
        while stack:
            x = stack.pop()
            yield x
            for c in ast.iter_child_nodes(x):
                if not isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                    stack.append(c)
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        nodes = list(own_nodes(fn))
        declared = set()
        for x in nodes:
            if isinstance(x, (ast.Global, ast.Nonlocal)):
                declared.update(x.names)
        params = {a.arg for a in fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs}
        if fn.args.vararg: params.add(fn.args.vararg.arg)
        if fn.args.kwarg: params.add(fn.args.kwarg.arg)
        stores = {}
        for x in nodes:
            if isinstance(x, ast.Name) and isinstance(x.ctx, ast.Store):
                stores.setdefault(x.id, []).append(x)
            if isinstance(x, (ast.Import, ast.ImportFrom)):
                for al in x.names:
                    stores.setdefault((al.asname or al.name).split(".")[0], []).append(x)
        for x in nodes:
            if isinstance(x, ast.AugAssign) and isinstance(x.target, ast.Name):
                nm = x.target.id
                if nm in declared or nm in params:
                    continue
                first = min((s.lineno for s in stores.get(nm, []) if s is not x.target), default=None)
                if (first is None or first >= x.lineno) and nm in module_names:
                    note(x.target, "need_global", name=nm)
        for nm, sts in stores.items():
            if nm in declared or nm in params or nm not in module_names:
                continue
            first = min(s.lineno for s in sts)
            for x in nodes:
                if isinstance(x, ast.Name) and isinstance(x.ctx, ast.Load) and x.id == nm and x.lineno < first:
                    note(x, "need_global", name=nm)
                    break
    # ── メソッドの self 忘れ
    for cls in ast.walk(tree):
        if not isinstance(cls, ast.ClassDef):
            continue
        for st in cls.body:
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                decos = {d.id if isinstance(d, ast.Name) else getattr(d, "attr", "") for d in st.decorator_list}
                if "staticmethod" in decos:
                    continue
                args = st.args.posonlyargs + st.args.args
                uses_self = any(isinstance(x, ast.Name) and x.id == "self" for x in ast.walk(st))
                if not args and not st.args.vararg:
                    l, c, el, ec = pos(st)
                    add("warning", "lint", "no_self|" + json.dumps({"name": st.name}, ensure_ascii=False), st.lineno, c, st.lineno, c + 3 + len(st.name))
                elif uses_self and args and args[0].arg != "self" and "classmethod" not in decos and args[0].arg != "cls":
                    note(args[0], "self_first", name=st.name)
    # ── return / break などのあとで、絶対に実行されない行
    def check_block(body):
        for i, st in enumerate(body):
            if isinstance(st, (ast.Return, ast.Break, ast.Continue, ast.Raise)) and i + 1 < len(body):
                note(body[i + 1], "unreachable", what=type(st).__name__.lower())
                break
    for n in ast.walk(tree):
        for field in ("body", "orelse", "finalbody"):
            b = getattr(n, field, None)
            if isinstance(b, list) and b and isinstance(b[0], ast.stmt):
                check_block(b)
    # ── 抜け出せない while True
    for n in ast.walk(tree):
        if isinstance(n, ast.While) and isinstance(n.test, ast.Constant) and n.test.value is True:
            exits = False
            stack = list(n.body)
            while stack:
                x = stack.pop()
                if isinstance(x, (ast.Break, ast.Return, ast.Raise)):
                    exits = True
                    break
                if isinstance(x, ast.Call) and ((isinstance(x.func, ast.Attribute) and x.func.attr in ("exit", "_exit", "quit")) or (isinstance(x.func, ast.Name) and x.func.id in ("exit", "quit"))):
                    exits = True
                    break
                for c in ast.iter_child_nodes(x):
                    if not isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.While, ast.For)):
                        stack.append(c)
                    elif isinstance(c, (ast.While, ast.For)):
                        # 内側のループの break は外へは抜けない。return と raise だけ探す
                        for y in ast.walk(c):
                            if isinstance(y, (ast.Return, ast.Raise)):
                                exits = True
            if not exits:
                l, c, el, ec = pos(n)
                add("warning", "lint", "endless", l, c, l, c + 5)
    # ── import したモジュールにない名前（math.cil など）。読み込んでも安全な標準のモジュールだけ調べる
    SAFE = {"math", "random", "time", "datetime", "json", "re", "string", "statistics", "itertools", "functools", "collections",
            "copy", "csv", "decimal", "fractions", "heapq", "bisect", "os", "sys", "pathlib", "calendar", "textwrap", "operator", "cmath", "array", "enum", "typing", "dataclasses"}
    import importlib, difflib
    mods = {}
    for st in ast.walk(tree):
        if isinstance(st, ast.Import):
            for al in st.names:
                top = al.name.split(".")[0]
                if al.name in SAFE and (al.asname or "." not in al.name):
                    mods[al.asname or al.name] = al.name
    rebound = {k for k in assigns if k in mods}
    loaded = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in mods and n.value.id not in rebound:
            name = mods[n.value.id]
            if name not in loaded:
                try:
                    loaded[name] = importlib.import_module(name)
                except Exception:
                    loaded[name] = None
            m = loaded[name]
            if m is None or hasattr(m, n.attr):
                continue
            near = difflib.get_close_matches(n.attr, [x for x in dir(m) if not x.startswith("_")], n=1, cutoff=0.6)
            el = getattr(n, "end_lineno", n.lineno)
            ec = (getattr(n, "end_col_offset", 0) or 0) + 1
            key = "attr_missing" if near else "attr_missing_none"
            add("warning", "lint", key + "|" + json.dumps({"mod": n.value.id, "attr": n.attr, "near": near[0] if near else ""}, ensure_ascii=False), el, ec - len(n.attr), el, ec)
print(json.dumps(out, ensure_ascii=False))
`;

export interface PyIssue {
  k: "error" | "warning";
  /** SyntaxError / IndentationError / TabError / SyntaxWarning / lint */
  t: string;
  m: string;
  l: number;
  c: number;
  el: number | null;
  ec: number | null;
}

/** Python のエラーの文を日本語に。わからないものは英語のまま添える */
export function translatePy(msg: string, type: string): { key: string; args: Record<string, string> } {
  const m = msg.trim();
  let r: RegExpExecArray | null;
  if ((r = /^'(.)' was never closed/.exec(m))) return { key: "py.neverClosed", args: { c: r[1], want: { "(": ")", "[": "]", "{": "}" }[r[1]] ?? "" } };
  if ((r = /^unmatched '(.)'/.exec(m))) return { key: "py.unmatched", args: { c: r[1] } };
  if ((r = /^closing parenthesis '(.)' does not match opening parenthesis '(.)'/.exec(m))) return { key: "py.mismatch", args: { close: r[1], open: r[2] } };
  if (/^expected ':'/.test(m)) return { key: "py.expectedColon", args: {} };
  if ((r = /^expected an indented block after '?(.+?)'? (statement|definition)? ?on line (\d+)/.exec(m))) return { key: "py.expectedIndentAfter", args: { what: r[1].replace(/ statement$/, ""), line: r[3] } };
  if (/^expected an indented block/.test(m)) return { key: "py.expectedIndent", args: {} };
  if (/^unexpected indent/.test(m)) return { key: "py.unexpectedIndent", args: {} };
  if (/^unindent does not match any outer indentation level/.test(m)) return { key: "py.unindent", args: {} };
  if (/inconsistent use of tabs and spaces/.test(m) || type === "TabError") return { key: "py.tabs", args: {} };
  if (/^unterminated triple-quoted string/.test(m)) return { key: "py.unterminatedTriple", args: {} };
  if (/^unterminated string literal|^EOL while scanning string literal/.test(m)) return { key: "py.unterminated", args: {} };
  if (/^Missing parentheses in call to 'print'/.test(m)) return { key: "py.printParen", args: {} };
  if ((r = /^Missing parentheses in call to '(\w+)'/.exec(m))) return { key: "py.callParen", args: { name: r[1] } };
  if ((r = /^invalid character '(.)' \(U\+([0-9A-F]+)\)/.exec(m))) return { key: "py.invalidChar", args: { c: r[1] } };
  if ((r = /^invalid non-printable character U\+([0-9A-F]+)/.exec(m))) return { key: "py.invisibleChar", args: { code: r[1] } };
  if (/^invalid decimal literal|^invalid (hexadecimal|octal|binary) literal/.test(m)) return { key: "py.badNumber", args: {} };
  if (/^invalid syntax\. Perhaps you forgot a comma\?/.test(m)) return { key: "py.forgotComma", args: {} };
  if (/Maybe you meant '==' or ':=' instead of '='\?|cannot assign to .* here\. Maybe you meant '==' instead of '='\?/.test(m)) return { key: "py.assignInCond", args: {} };
  if ((r = /^'(return|yield|await)' outside (function|async function)/.exec(m))) return { key: "py.outsideFunc", args: { kw: r[1] } };
  if ((r = /^'(break|continue)' (outside loop|not properly in loop)/.exec(m))) return { key: "py.outsideLoop", args: { kw: r[1] } };
  if (/^expected 'except' or 'finally' block/.test(m)) return { key: "py.tryNeedsExcept", args: {} };
  if ((r = /^cannot assign to (function call|literal|expression|comparison|True|False|None|conditional expression|f-string expression)/.exec(m))) return { key: "py.cannotAssign", args: { what: r[1] } };
  if (/^positional argument follows keyword argument/.test(m)) return { key: "py.posAfterKw", args: {} };
  if ((r = /^keyword argument repeated: (\w+)/.exec(m))) return { key: "py.kwRepeated", args: { name: r[1] } };
  if (/non-default argument follows default argument|parameter without a default follows parameter with a default/.test(m)) return { key: "py.defaultOrder", args: {} };
  if ((r = /^duplicate argument '(\w+)'/.exec(m))) return { key: "py.dupArg", args: { name: r[1] } };
  if (/^f-string/.test(m)) return { key: "py.fstring", args: { msg: m } };
  if (/^unexpected EOF while parsing|^invalid syntax$/.test(m) && type === "SyntaxError" && /EOF/.test(m)) return { key: "py.eof", args: {} };
  if (/^"is" with '?\w+'? literal|^"is" with a literal|^"is not" with/.test(m)) return { key: "py.isLiteral", args: {} };
  if ((r = /^invalid escape sequence '(\\.)'/.exec(m))) return { key: "py.escape", args: { seq: r[1] } };
  if (/'tuple' object is not callable|is not callable; perhaps you missed a comma/.test(m)) return { key: "py.missedComma", args: {} };
  if (/^invalid syntax/.test(m)) return { key: "py.invalid", args: {} };
  if (/^expected '\('/.test(m)) return { key: "py.expectedParen", args: {} };
  if (/^expression expected after dictionary key and ':'|^':' expected after dictionary key/.test(m)) return { key: "py.dictColon", args: {} };
  if (/^assignment to (True|False|None)|cannot assign to (True|False|None)/.test(m)) return { key: "py.cannotAssign", args: { what: m } };
  return { key: "py.other", args: { msg: m } };
}

/** 全角の記号を半角に（invalid character の直し方） */
export const ZENKAKU_FIX: Record<string, string> = {
  "（": "(", "）": ")", "：": ":", "，": ",", "、": ",", "。": ".", "．": ".", "＝": "=", "＋": "+", "－": "-", "＊": "*", "／": "/",
  "＜": "<", "＞": ">", "［": "[", "］": "]", "｛": "{", "｝": "}", "＂": '"', "＇": "'", "“": '"', "”": '"', "‘": "'", "’": "'", "　": " ", "；": ";", "＃": "#", "！": "!", "％": "%",
};

// ───────── 呼び出し（Python は 1 回だけ探して覚えておく）

let program: Promise<{ program: string; args: string[] } | null> | null = null;
export function pythonProgram() {
  program ??= (async () => {
    try {
      const info = await runtimes.findPython();
      const cmd = info.command;
      if (!cmd) return null;
      const quoted = /^"([^"]+)"\s*(.*)$/.exec(cmd);
      if (quoted) return { program: quoted[1], args: quoted[2] ? quoted[2].split(/\s+/) : [] };
      const [p, ...args] = cmd.replace(/^&\s*/, "").split(/\s+/);
      return { program: p, args };
    } catch {
      return null;
    }
  })();
  return program;
}

/** Python が見つからなかったら、しばらくは試さない */
let unavailableUntil = 0;
const results = new Map<string, PyIssue[]>();
let running: { text: string; promise: Promise<PyIssue[] | null> } | null = null;

/** 調べ終わった結果があれば（なければ null）。自動判定の表示などで使う */
export function cachedPyCheck(text: string): PyIssue[] | null {
  return results.get(text) ?? null;
}

export async function pyCheck(text: string): Promise<PyIssue[] | null> {
  const hit = results.get(text);
  if (hit) return hit;
  if (Date.now() < unavailableUntil || text.length > 300_000) return null;
  if (running && running.text === text) return running.promise;
  const promise = (async () => {
    const py = await pythonProgram();
    if (!py) {
      unavailableUntil = Date.now() + 60_000;
      return null;
    }
    try {
      const r = await tools.capture(py.program, [...py.args, "-X", "utf8", "-c", PY_CHECK], text);
      const line = r.stdout.trim().split("\n").pop() ?? "";
      if (!line.startsWith("[")) {
        unavailableUntil = Date.now() + 30_000;
        return null;
      }
      const list = JSON.parse(line) as PyIssue[];
      results.set(text, list);
      while (results.size > 20) results.delete(results.keys().next().value as string);
      return list;
    } catch {
      unavailableUntil = Date.now() + 30_000;
      return null;
    }
  })();
  running = { text, promise };
  try {
    return await promise;
  } finally {
    if (running?.promise === promise) running = null;
  }
}
