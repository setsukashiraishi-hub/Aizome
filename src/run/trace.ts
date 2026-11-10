import { explainRuntime } from "./pyErrors";
import { t } from "../core/i18n";
// 「値を見る」：Python のプログラムを、行ごとの変数の値を記録しながら実行する
// 実行はターミナルで行う（input() も使える）。終わると JSON に記録が書き出されるので、それを読んで行の横に表示する

/** トレーサー本体（Python）。ターミナルで python tracer.py 対象.py 記録.json と動かす */
export const TRACER_PY = String.raw`# Aizome 値を見る（トレーサー）
import sys, os, json, runpy, reprlib, types, traceback, re, linecache, ast, builtins, tokenize, time

def main():
    target = os.path.abspath(sys.argv[1])
    out = sys.argv[2]
    # 3 つ目があれば「入力の登録」のファイル：input() に順に入れる
    if len(sys.argv) > 3 and sys.argv[3]:
        with open(sys.argv[3], encoding="utf-8") as f:
            queue = f.read().replace("\r\n", "\n").split("\n")
        if queue and queue[-1] == "":
            queue.pop()
        real_input = builtins.input
        def registered_input(prompt=""):
            if queue:
                value = queue.pop(0)
                sys.stdout.write(str(prompt) + value + "\n")
                sys.stdout.flush()
                return value
            return real_input(prompt)
        builtins.input = registered_input
    sys.argv = [target]
    sys.path.insert(0, os.path.dirname(target))
    rp = reprlib.Repr()
    rp.maxstring = 60; rp.maxother = 60; rp.maxlist = 10; rp.maxtuple = 10
    rp.maxdict = 8; rp.maxset = 8; rp.maxlevel = 3; rp.maxlong = 40
    lines = {}
    last = {}
    state = {"events": 0, "truncated": False, "seq": 0, "recs": 0}
    outputs = {}
    # 戻り値：呼び出し（関数・メソッド）ごとに、その行の実行で返ってきた値
    returns = {}
    calls = []

    class Tee:
        """画面に出す文字をそのまま出しつつ、どの行の実行で出たかを覚える"""
        def __init__(self, real):
            self._real = real
        def write(self, s):
            try:
                f = sys._getframe(1)
                while f is not None and f.f_code.co_filename != target:
                    f = f.f_back
                if f is not None and s:
                    outputs.setdefault(id(f), []).append(s)
            except Exception:
                pass
            return self._real.write(s)
        def flush(self):
            return self._real.flush()
        def __getattr__(self, name):
            return getattr(self._real, name)
    SKIP = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type, types.MethodType)
    NAME = re.compile(r"[A-Za-z_]\w*")

    def show(v):
        t = type(v)
        # 正規表現の結果は、見つかった文字と、グループの中身を見せる
        if isinstance(v, re.Match):
            g = v.groups()
            body = "見つかった " + rp.repr(v.group(0)) + "（" + str(v.start()) + "〜" + str(v.end()) + " 文字目）"
            if g:
                body += "　グループ " + ", ".join(str(i + 1) + "=" + rp.repr(x) for i, x in enumerate(g[:5])) + ("…" if len(g) > 5 else "")
            return body
        if isinstance(v, re.Pattern):
            return "パターン " + rp.repr(v.pattern)
        # 自分で作ったクラスは <… object at 0x…> ではなく、中身を見せる
        if t.__repr__ is object.__repr__ and hasattr(v, "__dict__"):
            items = list(vars(v).items())
            body = ", ".join(k + "=" + rp.repr(x) for k, x in items[:4])
            return t.__name__ + "(" + body + (", …" if len(items) > 4 else "") + ")"
        return rp.repr(v)

    def snap(frame):
        d = {}
        for k, v in list(frame.f_locals.items()):
            if k.startswith("__") or isinstance(v, SKIP):
                continue
            try:
                d[k] = show(v)
            except Exception:
                d[k] = "?"
        return d

    def record(lineno, before, after, key):
        # before：その関数（フレーム）で最後に見たそれぞれの変数の値
        changed = {k: v for k, v in after.items() if before.get(k) != v}
        # その行で使った変数の値（変わったものは c にあるので除く）。マウスを乗せたときの値に使う
        refs = {}
        src = linecache.getline(target, lineno)
        src = src.split("#", 1)[0]
        for name in NAME.findall(src):
            if name in after and name not in refs and name not in changed:
                refs[name] = after[name]
        e = lines.setdefault(lineno, {"n": 0, "recs": []})
        e["n"] += 1
        # s：実行した順番の通し番号（「その瞬間」の値を見るため）、o：この実行で print などが出した文字
        state["seq"] += 1
        rec = {"c": changed, "r": refs, "s": state["seq"]}
        out_text = "".join(outputs.pop(key, []))
        if out_text:
            rec["o"] = out_text[:400]
        rv = returns.pop(key, None)
        if rv:
            rec["v"] = rv
        if len(e["recs"]) < 300 and state["recs"] < 60000:
            e["recs"].append(rec)
            state["recs"] += 1
        else:
            e["recs"][-1] = rec

    def ret_hook(idx, value):
        try:
            f = sys._getframe(1)
            seg, stmt, whole = calls[idx]
            # 1 行の命令として呼んだもの（print(…) や a.append(…)）が None を返すのは当たり前なので出さない
            # range(10) や enumerate(…) のような「くり返し用の入れ物」は、値を見ても意味がないので出さない
            if isinstance(value, (range, enumerate, zip, map, filter, reversed, types.GeneratorType)):
                return value
            if not ((stmt or whole) and value is None):
                lst = returns.setdefault(id(f), [])
                text = show(value)
                for item in lst:
                    if item[0] == seg:
                        item[1] = text
                        item[2] += 1
                        break
                else:
                    if len(lst) < 6:
                        lst.append([seg, text, 1])
        except Exception:
            pass
        return value
    builtins.__aizome_ret__ = ret_hook

    class Wrap(ast.NodeTransformer):
        """すべての呼び出し f(x) を __aizome_ret__(番号, f(x)) にして、返ってきた値を覚える"""
        def __init__(self, src):
            self.src = src
            self.stmt_calls = set()
        def visit_Expr(self, node):
            if isinstance(node.value, ast.Call):
                self.stmt_calls.add(id(node.value))
                return self.generic_visit(node)
            # 呼び出しでない式だけの行（m、dat[0:4]、m.lastindex、len(a) * 2 など）も、戻り値の表示に出す
            # 文字だけの行（説明の文字列）や yield / await はそのまま
            if isinstance(node.value, (ast.Constant, ast.Yield, ast.YieldFrom, ast.Await, ast.JoinedStr)):
                return self.generic_visit(node)
            self.generic_visit(node)
            seg = " ".join((ast.get_source_segment(self.src, node.value) or "").split())
            calls.append((seg[:80], False, True))
            node.value = ast.copy_location(ast.Call(func=ast.Name(id="__aizome_ret__", ctx=ast.Load()), args=[ast.Constant(len(calls) - 1), node.value], keywords=[]), node.value)
            return node
        def visit_Call(self, node):
            stmt = id(node) in self.stmt_calls
            self.generic_visit(node)
            if isinstance(node.func, ast.Name) and node.func.id in ("super", "__aizome_ret__", "locals", "globals", "vars"):
                return node
            seg = ast.get_source_segment(self.src, node) or ""
            seg = " ".join(seg.split())
            calls.append((seg[:80], stmt, stmt))
            new = ast.Call(func=ast.Name(id="__aizome_ret__", ctx=ast.Load()), args=[ast.Constant(len(calls) - 1), node], keywords=[])
            return ast.copy_location(new, node)

    def compiled():
        try:
            with tokenize.open(target) as f:
                src = f.read()
            tree = ast.parse(src, target)
            tree = Wrap(src).visit(tree)
            ast.fix_missing_locations(tree)
            return compile(tree, target, "exec")
        except Exception:
            # 書きかえられないとき（文法のまちがいなど）は、そのまま実行する（エラーの表示は Python に任せる）
            return None

    # 裏で動かすとき（自動判定）だけ：決めた時刻を過ぎたら、そこまでの記録を残して止める
    deadline = getattr(builtins, "__aizome_deadline__", None)

    def local(frame, event, arg):
        state["events"] += 1
        if deadline is not None and state["events"] % 256 == 0 and time.time() > deadline:
            sys.settrace(None)
            raise builtins.__aizome_timeout__()
        if state["events"] > 300000:
            state["truncated"] = True
            sys.settrace(None)
            # 裏で動かしているときは、記録をやめたあとに止まらなくなるので、ここで止める
            if deadline is not None:
                raise builtins.__aizome_timeout__()
            return None
        key = id(frame)
        now = snap(frame)
        if key in last:
            ln, known = last.pop(key)
            record(ln, known, now, key)
            # 内包表記の中などで一時的に見えなくなった変数も、最後に見た値として覚えておく
            known = dict(known)
            known.update(now)
        else:
            known = now
            # 裏で動かすとき（自動判定）だけ：関数が呼ばれたときの引数の値を、def の行に記録する
            if deadline is not None and frame.f_code.co_name != "<module>" and now:
                e = lines.setdefault(frame.f_code.co_firstlineno, {"n": 0, "recs": []})
                e["n"] += 1
                if len(e["recs"]) < 300:
                    e["recs"].append({"c": {}, "r": dict(now)})
        if event == "line":
            last[key] = (frame.f_lineno, known)
        return local

    def glob(frame, event, arg):
        if frame.f_code.co_filename == target:
            return local
        return None

    error = None
    linecache.checkcache(target)
    real_stdout = sys.stdout
    sys.stdout = Tee(real_stdout)
    sys.settrace(glob)
    try:
        code = compiled()
        if code is None:
            runpy.run_path(target, run_name="__main__")
        else:
            # runpy と同じく、実行中は __main__ モジュールを差しかえる（dataclass や pickle が __main__ を見るため）
            mod = types.ModuleType("__main__")
            mod.__dict__.update({"__file__": target, "__builtins__": builtins, "__package__": None, "__spec__": None, "__loader__": None, "__cached__": None})
            saved_main = sys.modules.get("__main__")
            sys.modules["__main__"] = mod
            try:
                exec(code, mod.__dict__)
            finally:
                if saved_main is not None:
                    sys.modules["__main__"] = saved_main
    except SystemExit:
        pass
    except BaseException as e:
        sys.settrace(None)
        line = None
        col = None
        end_col = None
        for fr in traceback.extract_tb(e.__traceback__):
            if os.path.abspath(fr.filename) == target:
                line = fr.lineno
                col = getattr(fr, "colno", None)
                end_col = getattr(fr, "end_colno", None)
        try:
            detail = "".join(traceback.format_exception_only(type(e), e)).strip().splitlines()[-1]
        except Exception:
            detail = type(e).__name__ + ": " + str(e)
        nm = getattr(e, "name", None)
        error = {"line": line, "message": type(e).__name__ + ": " + str(e), "type": type(e).__name__, "detail": detail, "name": nm if isinstance(nm, str) else None, "col": col, "endCol": end_col}
        # 自分のプログラムの部分だけのエラー表示にする（トレーサーの中は見せない）
        tb = e.__traceback__
        while tb is not None and os.path.abspath(tb.tb_frame.f_code.co_filename) != target:
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
    finally:
        sys.settrace(None)
        sys.stdout = real_stdout
        tmp = out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"lines": lines, "error": error, "truncated": state["truncated"]}, f, ensure_ascii=False)
        os.replace(tmp, out)
    if error is not None:
        sys.exit(1)

main()
`;

export interface TraceRecord {
  /** その行で変わった変数 */
  c: Record<string, string>;
  /** 変わらなかったときに、その行で使っている変数 */
  r: Record<string, string>;
  /** 実行した順番の通し番号 */
  s?: number;
  /** この実行で出た出力（print など） */
  o?: string;
  /** この実行での呼び出しの戻り値：[呼び出し, 値, 回数] */
  v?: [string, string, number][];
}

export interface TraceResult {
  lines: Record<string, { n: number; recs: TraceRecord[] }>;
  error: {
    line: number | null;
    message: string;
    /** NameError など */
    type?: string;
    /** Python が出す 1 行（Did you mean: … も入る） */
    detail?: string;
    /** まちがえた名前（NameError・AttributeError） */
    name?: string | null;
    /** その行の中の場所（0 から） */
    col?: number | null;
    endCol?: number | null;
  } | null;
  truncated: boolean;
}

export interface LineValue {
  text: string;
  /** マウスを乗せたときの、回ごとの値 */
  detail: string;
  kind: "value" | "ref" | "error" | "current" | "output" | "past";
}

const SHORT = 14;

export function seqText(values: string[], n: number): string {
  // 同じ値が続くところはまとめる
  const uniq = values.filter((v, i) => i === 0 || v !== values[i - 1]);
  if (uniq.length === 1) return uniq[0] + (n > 1 ? `（${n} 回）` : "");
  const short = uniq.every((v) => v.length <= SHORT);
  if (!short) return `${uniq[uniq.length - 1]}（${n} 回目）`;
  const head = uniq.slice(0, 4);
  const lastV = uniq[uniq.length - 1];
  const body = uniq.length > 5 ? `${head.join(" → ")} → … → ${lastV}` : uniq.join(" → ");
  return `${body}（${n} 回）`;
}

/** 出力を 1 行で見せる形に（改行は ⏎） */
function oneLine(o: string, max = 60): string {
  const t = o.replace(/\r/g, "").replace(/\n$/, "").replace(/\n/g, " ⏎ ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** values：変数の値　output：呼び出しの戻り値（前は print の出力だった名残で output という名前） */
export type TraceView = "values" | "output";

/** 0.8414709848078965 → 0.8415 のように、長い小数を短く */
function shortNum(v: string): string {
  return /^-?\d+\.\d{5,}(e[-+]?\d+)?$/.test(v) ? String(Number(Number(v).toPrecision(4))) : v;
}

function cutCall(seg: string, max = 24): string {
  return seg.length > max ? seg.slice(0, max - 1) + "…" : seg;
}

/** その回の戻り値を 1 行に（math.sin(i) → 0.8415　sq(i) → 1） */
function returnsText(r: TraceRecord, max = 3): string {
  const v = r.v ?? [];
  const parts = v.slice(0, max).map(([seg, val, n]) => `${cutCall(seg)} → ${shortNum(val)}${n > 1 ? `（最後の値・${n} 回）` : ""}`);
  if (v.length > max) parts.push(`ほか ${v.length - max} 個`);
  return parts.join("　");
}

/** その行が、指定した瞬間（通し番号 time）までに最後に実行されたときの記録 */
function recAt(recs: TraceRecord[], time: number): TraceRecord | null {
  let best: TraceRecord | null = null;
  for (const r of recs) if ((r.s ?? 0) <= time && (!best || (r.s ?? 0) > (best.s ?? 0))) best = r;
  return best;
}

function varsText(r: TraceRecord): string {
  const vals = Object.entries(Object.keys(r.c).length ? r.c : r.r);
  return vals.slice(0, 4).map(([k, v]) => `${k} = ${v}`).join("　") + (vals.length > 4 ? `　ほか ${vals.length - 4} 個` : "");
}

/**
 * 記録を、行ごとの表示の文にする。
 * view：values（変数の値）か output（その行の出力）。time を渡すと「その瞬間」の値だけを出す（ステップ表示）
 */
export function formatTrace(result: TraceResult, view: TraceView = "values", time: number | null = null, source?: string): Map<number, LineValue> {
  const out = new Map<number, LineValue>();
  for (const [lineStr, entry] of Object.entries(result.lines)) {
    const line = Number(lineStr);
    const recs = entry.recs;
    const detail =
      view === "output"
        ? recs
            .filter((r) => r.v?.length)
            .map((r, i) => `${i + 1} 回目：${(r.v ?? []).map(([seg, val]) => `${seg} → ${val}`).join("　")}`)
            .join("\n")
        : recs
            .map((r, i) => {
              const label = i === recs.length - 1 && entry.n > recs.length ? `${entry.n} 回目` : `${i + 1} 回目`;
              const v = varsText(r);
              const o = r.o ? `出力 → ${oneLine(r.o, 80)}` : "";
              return `${label}：${[v, o].filter(Boolean).join("　") || "（変化なし）"}`;
            })
            .join("\n");

    // ステップ表示：その瞬間の値・出力
    if (time !== null) {
      const r = recAt(recs, time);
      if (!r) continue;
      const current = r.s === time;
      if (view === "output") {
        if (r.v?.length) out.set(line, { text: returnsText(r), detail, kind: current ? "current" : "past" });
      } else {
        let text = varsText(r);
        // 今の行は、その回に出した文字（print の結果など）も添える
        if (current && r.o) text = text ? `${text}　→ ${oneLine(r.o, 40)}` : `→ ${oneLine(r.o, 60)}`;
        // 今の行以外は「その行が最後に動いたときの値」なので薄く
        if (text) out.set(line, { text, detail, kind: current ? "current" : "past" });
      }
      continue;
    }

    if (view === "output") {
      // 呼び出しごとに、回ごとの戻り値を並べる（math.sin(i) → 0.0 → 0.8415 → …（10 回））
      const segs: string[] = [];
      for (const r of recs) for (const [seg] of r.v ?? []) if (!segs.includes(seg)) segs.push(seg);
      if (!segs.length) continue;
      const parts = segs.slice(0, 2).map((seg) => {
        const values = recs.flatMap((r) => (r.v ?? []).filter((x) => x[0] === seg).map((x) => shortNum(x[1])));
        return `${cutCall(seg)} → ${seqText(values, values.length)}`;
      });
      if (segs.length > 2) parts.push(`ほか ${segs.length - 2} 個`);
      out.set(line, { text: parts.join("　"), detail, kind: "output" });
      continue;
    }

    const names: string[] = [];
    for (const r of recs) for (const k of Object.keys(r.c)) if (!names.includes(k)) names.push(k);
    const describe = (field: "c" | "r", keys: string[]) => {
      const parts = keys.slice(0, 3).map((k) => {
        const values = recs.filter((r) => k in r[field]).map((r) => r[field][k]);
        return `${k} = ${seqText(values, values.length === recs.length ? entry.n : values.length)}`;
      });
      if (keys.length > 3) parts.push(`ほか ${keys.length - 3} 個`);
      return parts.join("　");
    };
    // その行が画面に出した文字（print・console.log・printf など）
    const outs = recs.filter((r) => r.o).map((r) => `「${oneLine(r.o!, 30)}」`);
    const outRecs = recs.filter((r) => r.o).length;
    const outText = outs.length ? `出力 → ${seqText(outs, outRecs === recs.length ? entry.n : outs.length)}` : "";
    const join = (a: string) => [a, outText].filter(Boolean).join("　");
    if (names.length) {
      out.set(line, { text: join(describe("c", names)), detail, kind: "value" });
    } else {
      const refNames: string[] = [];
      for (const r of recs) for (const k of Object.keys(r.r)) if (!refNames.includes(k)) refNames.push(k);
      if (refNames.length) out.set(line, { text: join(describe("r", refNames)), detail, kind: "ref" });
      else if (outText) out.set(line, { text: outText, detail, kind: "value" });
    }
  }
  if (result.error?.line && (time === null || time >= maxTime(result))) {
    const ex = explainRuntime(result.error, source);
    out.set(result.error.line, { text: `${ex.soft ? "ⓘ" : "✖"} ${ex.text}${ex.fix ? `　${t("rt.tabHint", { to: ex.fix.to })}` : ""}`, detail: `${ex.text}\n${ex.hint ? ex.hint + "\n" : ""}（${result.error.detail ?? result.error.message}）`, kind: ex.soft ? "past" : "error" });
  }
  return out;
}

/** その行が実行された瞬間（通し番号）の一覧 */
export function stepTimes(result: TraceResult, line: number): number[] {
  return (result.lines[String(line)]?.recs ?? []).map((r) => r.s ?? 0).filter((s) => s > 0).sort((a, b) => a - b);
}

export function maxTime(result: TraceResult): number {
  let m = 0;
  for (const e of Object.values(result.lines)) for (const r of e.recs) m = Math.max(m, r.s ?? 0);
  return m;
}

/** いちばん多く実行された行（ステップ表示の最初の基準に使う） */
export function busiestLine(result: TraceResult, skip: (line: number) => boolean = () => false): number | null {
  let best: number | null = null;
  let n = 0;
  for (const [l, e] of Object.entries(result.lines)) {
    if (skip(Number(l))) continue;
    if (e.recs.length > n) {
      n = e.recs.length;
      best = Number(l);
    }
  }
  return best;
}

// ───────── 何重にもなったループ

function indentOf(s: string): number {
  return /^[ \t]*/.exec(s)![0].replace(/\t/g, "    ").length;
}

/** その行を囲んでいる for / while の行（外側から順に）。関数やクラスの外までは見ない */
export function enclosingLoops(lines: string[], line: number): number[] {
  const out: number[] = [];
  let cur = indentOf(lines[line - 1] ?? "");
  for (let i = line - 1; i >= 1 && cur > 0; i--) {
    const text = lines[i - 1];
    if (!text.trim() || /^\s*(#|\/\/)/.test(text)) continue;
    const ind = indentOf(text);
    if (ind >= cur) continue;
    cur = ind;
    if (/^\s*(for|while)\b/.test(text)) out.unshift(i);
    else if (/^\s*(def|class|async\s+def|function|func)\b/.test(text)) break;
  }
  return out;
}

export interface LoopPos {
  header: number;
  /** そのループの何回目か（外側のループの今の回の中で数える） */
  iteration: number;
  /** その回のループ変数（例：i = 2） */
  vars: string;
}

/** time の瞬間に、それぞれのループが何回目か */
export function loopPositions(result: TraceResult, headers: number[], time: number): LoopPos[] {
  const out: LoopPos[] = [];
  let start = 0;
  for (const h of headers) {
    const times = stepTimes(result, h).filter((s) => s <= time);
    const inRun = times.filter((s) => s > start);
    const lastRec = (result.lines[String(h)]?.recs ?? []).filter((r) => (r.s ?? 0) <= time).pop();
    const vars = lastRec ? Object.entries(Object.keys(lastRec.c).length ? lastRec.c : lastRec.r).map(([k, v]) => `${k} = ${v}`).join(", ") : "";
    out.push({ header: h, iteration: inRun.length, vars });
    start = times.length ? times[times.length - 1] : start;
  }
  return out;
}

/**
 * ループ 1 段ぶん進める・戻す。進めた先で anchor の行が最初に動いた瞬間を返す（なければ null）
 */
export function stepLoop(result: TraceResult, header: number, anchor: number, time: number, dir: 1 | -1): number | null {
  const ht = stepTimes(result, header);
  const at = stepTimes(result, anchor);
  if (dir === 1) {
    const next = ht.find((s) => s > time);
    if (next === undefined) return null;
    return at.find((s) => s > next) ?? null;
  }
  const cur = [...ht].reverse().find((s) => s <= time);
  if (cur === undefined) return null;
  const prev = [...ht].reverse().find((s) => s < cur);
  if (prev === undefined) return null;
  return at.find((s) => s > prev && s < cur) ?? at.find((s) => s > prev) ?? null;
}
