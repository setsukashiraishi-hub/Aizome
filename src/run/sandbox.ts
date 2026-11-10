// 自動判定：Python のコードを裏で安全に動かして、本当の値を記録する。
// - 記録には「値を見る（F6）」と同じトレーサー（TRACER_PY）を使う
// - ファイル・OS・ネットにさわるもの（open・os・subprocess・socket など）を使うコードは動かさない
// - input() や sys.argv の値が必要になったら、その時点で止める（それより前の記録は使える）
// - print の出力は捨てる。1 回 2 秒まで
// ねらいは「自分のコードで、うっかりファイルを消したり書いたりしない」こと。わざと抜けようとするコードを完全に止めるものではない
import { tools } from "../core/platform";
import { pythonProgram } from "./pycheck";
import { TRACER_PY, type TraceResult } from "./trace";

/** 動かす前に調べて、断る理由を返す（動かしてよければ None）。動かしている間も、自分のコードからの危ない呼び出しは止める */
export const SANDBOX_PY = String.raw`
import sys, os, json, ast, tempfile, shutil, builtins, random, time, re
data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
src = data["code"]
TRACER = data["tracer"]
real_stdout = sys.stdout

ALLOWED = {"math", "random", "re", "string", "collections", "itertools", "functools", "statistics", "datetime", "json", "fractions", "decimal"}
BAD_NAMES = {"open", "exec", "eval", "compile", "__import__", "globals", "breakpoint", "help", "exit", "quit",
             "getattr", "setattr", "delattr", "vars", "memoryview", "__builtins__", "__loader__", "__spec__", "dir"}
SAFE_DUNDER = {"__init__", "__str__", "__repr__", "__name__", "__len__", "__eq__", "__ne__", "__lt__", "__le__", "__gt__",
               "__ge__", "__add__", "__sub__", "__mul__", "__truediv__", "__floordiv__", "__mod__", "__iter__", "__next__",
               "__contains__", "__getitem__", "__setitem__", "__hash__", "__bool__", "__call__", "__doc__", "__post_init__"}
FORMAT_ESCAPE = re.compile(r"\{[^{}]*__")
# フレーム・コードをたどって外に出られる属性
BAD_ATTRS = {"gi_frame", "gi_code", "cr_frame", "cr_code", "ag_frame", "ag_code", "f_globals", "f_locals", "f_back",
             "f_builtins", "f_code", "tb_frame", "tb_next", "get_field", "get_value"}

def reply(obj):
    real_stdout.write(json.dumps(obj, ensure_ascii=False))
    real_stdout.flush()

def refuse(reason, line=None):
    reply({"refused": reason, "line": line})
    sys.exit(0)

try:
    tree = ast.parse(src)
except SyntaxError as e:
    refuse("文法のまちがい", e.lineno)

for n in ast.walk(tree):
    line = getattr(n, "lineno", None)
    if isinstance(n, ast.Import):
        for a in n.names:
            root = a.name.split(".")[0]
            if root != "sys" and root not in ALLOWED:
                refuse(a.name + " を import している", line)
    elif isinstance(n, ast.ImportFrom):
        root = (n.module or "").split(".")[0]
        if n.level or not root:
            refuse("自分のファイルを import している", line)
        if root == "sys":
            if any(a.name != "argv" for a in n.names):
                refuse("sys の argv 以外を使っている", line)
        elif root not in ALLOWED:
            refuse(n.module + " を import している", line)
    elif isinstance(n, ast.Name) and n.id in BAD_NAMES:
        refuse(n.id + " を使っている", line)
    elif isinstance(n, ast.Attribute):
        if n.attr.startswith("__") and n.attr.endswith("__") and n.attr not in SAFE_DUNDER:
            refuse(n.attr + " を使っている", line)
        if n.attr in BAD_ATTRS:
            refuse(n.attr + " を使っている", line)
        # _ で始まる名前は、自分のクラスの self._x / cls._x だけ（random._os のような中のモジュールに届かないように）
        if n.attr.startswith("_") and n.attr not in SAFE_DUNDER and not (isinstance(n.value, ast.Name) and n.value.id in ("self", "cls")):
            refuse(n.attr + " を使っている", line)
        if isinstance(n.value, ast.Name) and n.value.id == "sys" and n.attr != "argv":
            refuse("sys." + n.attr + " を使っている", line)
    elif isinstance(n, ast.Constant) and isinstance(n.value, str) and FORMAT_ESCAPE.search(n.value):
        refuse("文字列の書式で __ を使っている", line)

class AizomeNeedInput(BaseException):
    pass
class AizomeBlocked(BaseException):
    pass
class AizomeTimeout(BaseException):
    pass

tmp = tempfile.mkdtemp(prefix="aizome-sandbox-")
target = os.path.abspath(os.path.join(tmp, "main.py"))
out = os.path.join(tmp, "trace.json")
with open(target, "w", encoding="utf-8") as f:
    f.write(src)

def from_user(depth=2):
    try:
        return sys._getframe(depth).f_code.co_filename == target
    except ValueError:
        return False

real_open = builtins.open
real_import = builtins.__import__
real_input = builtins.input

def guarded_open(*a, **k):
    if from_user():
        raise AizomeBlocked("open")
    return real_open(*a, **k)

def guarded_input(*a, **k):
    if from_user():
        raise AizomeNeedInput("input")
    return real_input(*a, **k)

class FakeSys:
    @property
    def argv(self):
        raise AizomeNeedInput("argv")
    def __getattr__(self, name):
        raise AizomeBlocked("sys." + name)
fake_sys = FakeSys()

class SafeModule:
    """許可したモジュールの、中のモジュール（statistics.sys など）と _ で始まる名前を除いたもの"""
    def __init__(self, mod):
        for k in dir(mod):
            if k.startswith("_"):
                continue
            v = getattr(mod, k)
            if isinstance(v, type(sys)):
                if v.__name__.split(".")[0] not in ALLOWED or not v.__name__.startswith(mod.__name__ + "."):
                    continue
                v = safe(v)
            object.__setattr__(self, k, v)
        object.__setattr__(self, "__name__", mod.__name__)
    def __setattr__(self, k, v):
        raise AizomeBlocked("setattr")
    def __repr__(self):
        return "<module " + repr(self.__name__) + ">"

safe_cache = {}
def safe(mod):
    if mod.__name__ not in safe_cache:
        safe_cache[mod.__name__] = None
        safe_cache[mod.__name__] = SafeModule(mod)
    return safe_cache[mod.__name__]

def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if from_user():
        root = name.split(".")[0]
        if root == "sys":
            if fromlist:
                raise AizomeNeedInput("argv")
            return fake_sys
        if level or root not in ALLOWED:
            raise AizomeBlocked(name)
        mod = real_import(name, globals, locals, fromlist, level)
        # import a.b は a を、from a.b import c は a.b を返す
        if fromlist:
            return safe(sys.modules[name])
        return safe(mod)
    return real_import(name, globals, locals, fromlist, level)

def guard(fn, what):
    def g(*a, **k):
        if from_user():
            raise AizomeBlocked(what)
        return fn(*a, **k)
    return g

class Sink:
    def write(self, s):
        return len(s)
    def flush(self):
        pass
    def isatty(self):
        return False

random.seed(0)
builtins.open = guarded_open
builtins.input = guarded_input
builtins.__import__ = guarded_import
real_exec, real_eval, real_compile = builtins.exec, builtins.eval, builtins.compile
builtins.exec = guard(real_exec, "exec")
builtins.eval = guard(real_eval, "eval")
builtins.compile = guard(real_compile, "compile")
for k in ("exit", "quit", "help", "breakpoint"):
    if hasattr(builtins, k):
        delattr(builtins, k)
builtins.__aizome_timeout__ = AizomeTimeout
builtins.__aizome_deadline__ = time.time() + float(data.get("seconds", 1.5))
sys.stdout = Sink()
sys.stdin = None
sys.argv = ["aizome-tracer", target, out]
try:
    real_exec(real_compile(TRACER, "<aizome-tracer>", "exec"), {"__name__": "__aizome__", "__builtins__": builtins})
except SystemExit:
    pass
finally:
    builtins.open = real_open
    builtins.__import__ = real_import
    builtins.input = real_input
    builtins.exec, builtins.eval, builtins.compile = real_exec, real_eval, real_compile
    sys.stdout = real_stdout
try:
    with open(out, encoding="utf-8") as f:
        result = json.load(f)
except Exception:
    result = None
shutil.rmtree(tmp, ignore_errors=True)
reply({"trace": result})
`;

export type SandboxStop = { kind: "input" | "argv" | "timeout" | "blocked" | "error"; line: number | null };

export interface SandboxResult {
  /** 記録（動かさなかったときは null） */
  trace: TraceResult | null;
  /** 途中で止まったときの理由と行（最後まで動いたときは null） */
  stop: SandboxStop | null;
  /** 動かさなかった理由（open を使っている など） */
  refused?: { reason: string; line: number | null };
}

const cache = new Map<string, SandboxResult>();
let running: { text: string; promise: Promise<SandboxResult | null> } | null = null;
let unavailableUntil = 0;

/** すでに動かした結果（なければ null） */
export function cachedSandbox(text: string): SandboxResult | null {
  return cache.get(text) ?? null;
}

/** トレーサーの記録の error から、止まった理由を決める */
export function stopOf(trace: TraceResult | null): SandboxStop | null {
  const e = trace?.error;
  if (!e) return null;
  const line = e.line ?? null;
  if (e.type === "AizomeNeedInput") return { kind: /argv/.test(e.message) ? "argv" : "input", line };
  if (e.type === "AizomeTimeout") return { kind: "timeout", line };
  if (e.type === "AizomeBlocked") return { kind: "blocked", line };
  return { kind: "error", line };
}

/** 動かして結果を受け取る（Python がない・失敗したときは null） */
export async function runSandbox(text: string): Promise<SandboxResult | null> {
  const hit = cache.get(text);
  if (hit) return hit;
  if (Date.now() < unavailableUntil || text.length > 200_000) return null;
  if (running && running.text === text) return running.promise;
  const promise = (async (): Promise<SandboxResult | null> => {
    const py = await pythonProgram();
    if (!py) {
      unavailableUntil = Date.now() + 60_000;
      return null;
    }
    let stdout = "";
    try {
      const r = await tools.capture(py.program, [...py.args, "-X", "utf8", "-I", "-S", "-c", SANDBOX_PY], JSON.stringify({ code: text, tracer: TRACER_PY, seconds: 1.5 }), undefined, 2000);
      stdout = r.stdout.trim();
    } catch (err) {
      // 2 秒で止めた：そこまでの記録も取れないので、「時間がかかる」とだけ覚える
      if (/timeout/.test(String(err))) {
        const res: SandboxResult = { trace: null, stop: { kind: "timeout", line: null } };
        remember(text, res);
        return res;
      }
      unavailableUntil = Date.now() + 30_000;
      return null;
    }
    // 自分のコードの print は捨てているので、出力は返事の JSON だけ
    let parsed: { trace?: TraceResult | null; refused?: string; line?: number | null };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }
    const res: SandboxResult = parsed.refused
      ? { trace: null, stop: null, refused: { reason: parsed.refused, line: parsed.line ?? null } }
      : { trace: parsed.trace ?? null, stop: stopOf(parsed.trace ?? null) };
    remember(text, res);
    return res;
  })();
  running = { text, promise };
  try {
    return await promise;
  } finally {
    if (running?.promise === promise) running = null;
  }
}

function remember(text: string, res: SandboxResult) {
  cache.set(text, res);
  while (cache.size > 20) cache.delete(cache.keys().next().value as string);
}
