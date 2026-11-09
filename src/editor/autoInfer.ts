// 自動判定モード：実行せずに AI がコード全体を読んで、変数の中身とエラーになりそうな行を予想する。
// - 変数の上にマウスを置いて少し待つと、その行の時点での値を小窓で見せる（値モードでは実行した結果を見せる）
// - エラーになりそうな行には、右に薄く原因を書く
import { Compartment, RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, hoverTooltip, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { settings } from "../core/settings";
import { completer } from "../ai/completer";
import { buildInferPrompt, hashText, implausibleRisk, lookupInferred, parseInfer, staticGuess, type InferResult } from "../ai/infer";
import { docFilename, docId } from "./ghost";
import { fs } from "../core/platform";
import { dirname, join } from "../core/paths";
import { simulateValue } from "../ai/simulate";
import { forEachView, sideMode, sideModeChanged, trackView } from "./sideMode";
import { bus } from "../core/events";
import { traceAt, traceTimeAt } from "./valueLens";
import { inferBusy, setInferBusy } from "./inferState";
import { checkLangOfState, predictedProblems, syntaxProblems } from "./liveCheck";
import { t } from "../core/i18n";

/** AI の予想が新しくなった合図（行の説明もこれで描き直す） */
import { inferUpdated } from "./checkEvents";
export { inferUpdated };

/** 自動判定でエラーの可能性を出している行（行の説明より優先するため） */
export function riskLines(state: EditorState): Set<number> {
  if (sideMode() !== "auto") return new Set();
  const syntax = syntaxProblems(state);
  if (syntax.length) return new Set(syntax.map((s) => s.line));
  const ai = (resultFor(state)?.risks ?? []).filter((r) => r.line <= state.doc.lines && fileRisk(state, r.line, r.reason) !== "hide");
  return new Set([...predictedProblems(state).map((p) => p.line), ...ai.map((r) => r.line)]);
}

// ───────── AI の予想（コードごとに覚えておく）
const cache = new Map<string, InferResult>();
let timer: number | undefined;
let cancelRunning: (() => void) | null = null;
let pauseUntil = 0;
function resultFor(state: EditorState): InferResult | null {
  const key = hashText(state.doc.toString());
  return cache.get(key) ?? null;
}

function stop() {
  window.clearTimeout(timer);
  cancelRunning?.();
  cancelRunning = null;
}

function schedule(view: EditorView, delay = 2500) {
  window.clearTimeout(timer);
  if (sideMode() !== "auto" || !settings.get("ai.enabled")) return;
  if (Date.now() < pauseUntil) delay = Math.max(delay, pauseUntil - Date.now());
  timer = window.setTimeout(() => void analyze(view), delay);
}

async function analyze(view: EditorView) {
  if (sideMode() !== "auto") return;
  // 補完を考えている最中は待つ
  if (completer.status === "thinking" || cancelRunning) return schedule(view, 1500);
  const text = view.state.doc.toString();
  if (!text.trim()) return;
  const key = hashText(text);
  if (cache.has(key)) {
    view.dispatch({ effects: inferUpdated.of(null) });
    return;
  }
  let stopped = false;
  setInferBusy(true);
  try {
    const answer = await completer.ask(buildInferPrompt(text, view.state.facet(docFilename)), {
      maxTokens: 1400,
      temperature: 0.1,
      onStart: (cancel) => {
        cancelRunning = () => {
          stopped = true;
          cancel();
        };
      },
    });
    cancelRunning = null;
    if (stopped) return;
    const result = parseInfer(answer, view.state.doc.lines, checkLangOfState(view.state));
    cache.set(key, result);
    while (cache.size > 30) cache.delete(cache.keys().next().value as string);
    view.dispatch({ effects: inferUpdated.of(null) });
  } catch {
    cancelRunning = null;
    pauseUntil = Date.now() + 60_000;
  } finally {
    setInferBusy(false);
  }
}

// ───────── エラーになりそうな行（右に薄く）
class RiskWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly sure = false,
    /** 「〜かもしれない」程度の控えめな注意（⚠ を付けない） */
    readonly soft = false,
  ) {
    super();
  }
  eq(o: RiskWidget) {
    return o.text === this.text && o.sure === this.sure && o.soft === this.soft;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.soft ? "cm-risk soft" : this.sure ? "cm-risk sure" : "cm-risk";
    el.textContent = this.soft ? `ⓘ ${this.text}` : `⚠ ${this.text}`;
    el.title = this.text;
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// ───────── ファイルが見つからないかも、という予想
// AI は実行せずに読むので、open("data.txt") があるだけで「FileNotFoundError」と予想しがち。
// 実際にファイルがあれば出さず、なければ「ないとエラーになる可能性があります」と控えめに出す

const FILE_RISK = /FileNotFound|No such file|IOError|ファイル.{0,12}(ない|無い|見つから|存在しな|開けな)|(存在しない|見つからない).{0,6}ファイル/i;
const FILE_IN_LINE = /(?:open|Path|read_csv|read_excel|read_json|loadtxt|genfromtxt|imread|load|File\.\w+|fopen|ifstream|FileReader|readFileSync|StreamReader)\s*\(\s*(?:file\s*=\s*)?[rbuf]?["']([^"']+)["']/i;
const ANY_FILE = /["']([^"'\s]+\.[A-Za-z0-9]{1,6})["']/;
const fileExists = new Map<string, boolean | "checking">();

function isAbsolutePath(p: string) {
  return /^([A-Za-z]:[\\/]|[\\/]{1,2}|~)/.test(p);
}

/** その行で開こうとしているファイル名 */
function fileOnLine(text: string): string | null {
  return FILE_IN_LINE.exec(text)?.[1] ?? ANY_FILE.exec(text)?.[1] ?? null;
}

/** ファイルがあるか（わからなければ null。調べ終わったら描き直す） */
function existsNow(state: EditorState, file: string): boolean | null {
  const id = state.facet(docId);
  let full: string | null = null;
  if (isAbsolutePath(file) && !file.startsWith("~")) full = file;
  else if (isAbsolutePath(id)) full = join(dirname(id), file.replace(/^\.[\\/]/, ""));
  if (!full) return null;
  const known = fileExists.get(full);
  if (known === true || known === false) return known;
  if (known !== "checking") {
    fileExists.set(full, "checking");
    fs.exists(full)
      .then((ok) => fileExists.set(full!, ok))
      .catch(() => fileExists.delete(full!))
      .finally(() => forEachView((v) => v.dispatch({ effects: inferUpdated.of(null) })));
    // しばらくしたら調べ直す（あとからファイルを置いたときのため）
    window.setTimeout(() => fileExists.delete(full!), 15000);
  }
  return null;
}

const ZERO_RISK = /ZeroDivision|0\s*で割|ゼロで割|ゼロ除算|division by zero|divide by zero/i;
const INPUT_RISK = /ValueError|数字(以外|でない)|数値に変換できな/;

/** 割り算の「割る数」（a / n なら n）。見つからなければ null */
function divisorOnLine(text: string): string | null {
  const code = text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*$/, "");
  const m = /[^/*]\s*(?:\/\/?|%)\s*(\([^()]*\)|-?[A-Za-z_][\w.]*(?:\[[^\]]*\])?(?:\([^()]*\))?|-?\d+(?:\.\d+)?)/.exec(" " + code);
  return m?.[1] ?? null;
}

/**
 * AI の予想が「値しだいで起きる」エラー（ファイルがない・0 で割る・数字でない入力）なら、
 * ⚠ ではなく控えめな注意にする。確かめて大丈夫なら出さない（"hide"）。関係なければ null
 */
function fileRisk(state: EditorState, lineNo: number, reason: string): { text: string } | "hide" | null {
  const lineText = state.doc.line(lineNo).text;
  // sys.argv[1] など：引数を渡さずに実行したときだけ起きるので、注意にする
  const argv = /\b(?:sys\.argv|process\.argv|args|argv|ARGV|os\.Args)\s*\[\s*\d+\s*\]/.exec(lineText);
  if (argv && /Index|範囲|番号|argv|引数|out of/i.test(reason)) return { text: t("predict.argvMaybe", { expr: argv[0].replace(/\s+/g, "") }) };
  if (ZERO_RISK.test(reason)) {
    const d = divisorOnLine(lineText);
    if (d && /^-?\d+(\.\d+)?$/.test(d)) return Number(d) === 0 ? null : "hide";
    return { text: d ? t("predict.zeroMaybe", { name: d }) : t("predict.zeroMaybeAny") };
  }
  if (INPUT_RISK.test(reason) && /\binput\s*\(|Console\.ReadLine|nextInt|scanf|prompt\s*\(/.test(lineText)) return { text: t("predict.inputMaybe") };
  if (!FILE_RISK.test(reason)) return null;
  const file = fileOnLine(state.doc.line(lineNo).text);
  if (file) {
    const ok = existsNow(state, file);
    if (ok === true) return "hide";
    if (ok === false) return { text: t("predict.fileMissing", { file }) };
    return { text: t("predict.fileMaybe", { file }) };
  }
  return { text: t("predict.fileMaybeAny") };
}

function buildRisks(state: EditorState): DecorationSet {
  if (sideMode() !== "auto") return Decoration.none;
  // 文法のまちがいがあると実行そのものができないので、それを先に（AI の予想より確か）
  const syntax = syntaxProblems(state);
  if (syntax.length) {
    const b = new RangeSetBuilder<Decoration>();
    for (const s of syntax.sort((a, b) => a.line - b.line)) {
      const line = state.doc.line(s.line);
      b.add(line.to, line.to, Decoration.widget({ widget: new RiskWidget(`${t("check.runWillFail")}：${s.text}`, true), side: 2 }));
    }
    return b.finish();
  }
  const result = resultFor(state);
  // 書き方から確かにわかる「実行するとエラー」（まだない名前・math.cil など）を先に、AI の予想はほかの行に
  const predicted = predictedProblems(state);
  if (!result?.risks.length && !predicted.length) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  const seen = new Set<number>();
  const all = [...predicted.map((p) => ({ line: p.line, reason: p.text, sure: true })), ...(result?.risks ?? []).map((r) => ({ line: r.line, reason: r.reason, sure: false }))].sort((a, b) => a.line - b.line);
  for (const r of all) {
    if (seen.has(r.line) || r.line > state.doc.lines) continue;
    let text = r.reason;
    let soft = false;
    if (!r.sure) {
      if (implausibleRisk(state.doc.line(r.line).text, r.reason, checkLangOfState(state))) continue;
      const f = fileRisk(state, r.line, r.reason);
      if (f === "hide") continue;
      if (f) {
        text = f.text;
        soft = true;
      }
    }
    seen.add(r.line);
    const line = state.doc.line(r.line);
    b.add(line.to, line.to, Decoration.widget({ widget: new RiskWidget(text, r.sure, soft), side: 2 }));
  }
  return b.finish();

}

// ───────── 変数の上にマウスを置いたときの小窓
const IDENT = /[A-Za-z_][\w]*/;

function wordAt(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  const text = line.text;
  let s = col;
  let e = col;
  while (s > 0 && /\w/.test(text[s - 1])) s--;
  while (e < text.length && /\w/.test(text[e])) e++;
  const word = text.slice(s, e);
  if (!word || !IDENT.test(word) || /^\d/.test(word)) return null;
  // キーワードや組み込み関数は対象外
  if (/^(def|class|for|in|if|elif|else|while|return|import|from|as|with|try|except|finally|and|or|not|is|None|True|False|print|input|range|len|int|str|float|list|dict|set|tuple|open|self|lambda|pass|break|continue|global|yield)$/.test(word)) return null;
  return { from: line.from + s, to: line.from + e, text: word };
}

/** 値モード：実行した記録から、その行の時点の値を探す */
function tracedValue(state: EditorState, name: string, lineNo: number): { value: string; from: number } | null {
  const trace = traceAt(state);
  if (!trace) return null;
  const time = traceTimeAt(state);
  // ステップ表示中は、その瞬間までで最後にわかっている値
  if (time !== null) {
    let best: { value: string; from: number; s: number } | null = null;
    for (const [l, e] of Object.entries(trace.lines)) {
      for (const r of e.recs) {
        const s = r.s ?? 0;
        const v = r.c[name] ?? r.r[name];
        if (v !== undefined && s <= time && (!best || s > best.s)) best = { value: v, from: Number(l), s };
      }
    }
    return best;
  }
  for (let l = lineNo; l >= 1; l--) {
    const e = trace.lines[String(l)];
    if (!e) continue;
    for (let i = e.recs.length - 1; i >= 0; i--) {
      const v = e.recs[i].c[name] ?? e.recs[i].r[name];
      if (v !== undefined) return { value: v, from: l };
    }
  }
  return null;
}

/**
 * AI が予想した値の行が「input() などで受け取る」行なのに、AI の答えが入力のことに触れていなければ、
 * コードから読み取った見当（「ユーザーの入力に依存（整数）」など）を返す。それ以外は null
 */
function inputGuessFor(lines: string[], name: string, lineNo: number, inferred: { value: string; from: number }): string | null {
  const text = lines[inferred.from - 1] ?? "";
  if (!/\binput\s*\(|Console\.ReadLine|\bnextInt\b|\bnextLine\b|\bscanf\b|\bprompt\s*\(|readline\s*\(/.test(text)) return null;
  if (/入力|input/i.test(inferred.value)) return null;
  const guess = staticGuess(lines.slice(0, lineNo), name, lineNo);
  return guess && /入力/.test(guess) ? guess : null;
}

function tooltipBox(name: string, lineNo: number, body: string, source: string): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-var-tip";
  const head = document.createElement("div");
  head.className = "cm-var-tip-head";
  head.textContent = `${name}（${lineNo} 行目の時点）`;
  const val = document.createElement("pre");
  val.className = "cm-var-tip-value";
  val.textContent = body;
  const foot = document.createElement("div");
  foot.className = "cm-var-tip-src";
  foot.textContent = source;
  dom.append(head, val, foot);
  return dom;
}

const hoverSource: Parameters<typeof hoverTooltip>[0] = (view, pos) => {
    const mode = sideMode();
    if ((mode !== "auto" && mode !== "values" && mode !== "output") || !settings.get("editor.valueHover")) return null;
    const word = wordAt(view.state, pos);
    if (!word) return null;
    const lineNo = view.state.doc.lineAt(pos).number;
    let body: string | null = null;
    let source = "";
    if (mode === "values" || mode === "output") {
      const v = tracedValue(view.state, word.text, lineNo);
      if (v) {
        body = v.value;
        source = `▸ 実行した結果（${v.from} 行目）`;
      } else if (traceAt(view.state)) {
        body = "（この時点では値がありません）";
        source = "▸ 実行した結果";
      } else {
        body = "「値を見る（F6）」で実行すると、ここに実際の値が出ます";
        source = "";
      }
    } else {
      const docLines: string[] = [];
      for (let n = 1; n <= view.state.doc.lines && n <= 2000; n++) docLines.push(view.state.doc.line(n).text);
      const inferred = lookupInferred(resultFor(view.state), word.text, lineNo, docLines);
      // かんたんなコードなら、上から順に計算した値（AI の予想より確か）
      const sim = settings.get("editor.liveCheck") !== false ? simulateValue(docLines, word.text, lineNo) : null;
      if (sim) {
        body = sim.text;
        source = "コードを上から順に計算した予想・実行はしていません（入力や乱数があると変わります）";
      } else if (inferred && "value" in inferred && inputGuessFor(docLines, word.text, lineNo, inferred)) {
        // 入力で決まる値なのに、AI が「5」のように勝手な値を答えたときは、コードから確かにわかる方を出す
        body = inputGuessFor(docLines, word.text, lineNo, inferred)!;
        source = "コードから読み取った見当・実行はしていません";
      } else if (inferred && "value" in inferred) {
        body = inferred.value;
        source = `✦ AI の予想（${inferred.from} 行目で入る値）・実行はしていません`;
      } else if (inferred && "later" in inferred) {
        body = `まだ値が入っていません（${inferred.later} 行目で入ります）`;
        source = "✦ AI の予想";
      } else {
        const lines: string[] = [];
        for (let n = 1; n <= lineNo; n++) lines.push(view.state.doc.line(n).text);
        const guess = staticGuess(lines, word.text, lineNo);
        if (inferred && "unknown" in inferred) {
          // AI が値を予想できなかった：わからないことをはっきり伝える
          body = `わかりません（AI にも予想できませんでした）${guess ? `\nコードからわかること：${guess.replace(/・(実際の値は|いくつになるかは)、実行しないとわかりません$/, "")}` : ""}\n実際の値は「値を見る（F6）」で実行するとわかります`;
          source = `✦ AI の予想（${inferred.unknown} 行目）・実行はしていません`;
        } else if (guess) {
          body = guess;
          source = inferBusy ? "コードから読み取った見当（AI が考え中…）" : "コードから読み取った見当・実行はしていません";
        } else if (inferBusy) {
          body = "AI が考え中です。少し待ってから、もう一度マウスを乗せてください";
          source = "✦ AI の予想";
        } else {
          const all = view.state.doc.toString();
          const n = word.text;
          // モジュール・関数・クラスの名前は値ではないので出さない
          if (new RegExp(`^\\s*(import\\s+[\\w.,\\s]*\\b${n}\\b|from\\s+\\S+\\s+import\\s+.*\\b${n}\\b|.*\\bas\\s+${n}\\b|(async\\s+)?def\\s+${n}\\b|class\\s+${n}\\b)`, "m").test(all)) return null;
          // 関数の引数
          const param = new RegExp(`^\\s*(?:async\\s+)?def\\s+(\\w+)\\s*\\([^)]*\\b${n}\\b`, "m").exec(lines.join("\n"));
          body = param
            ? `わかりません：関数 ${param[1]} の引数なので、呼ぶときに渡す値で変わります`
            : "わかりません：この時点の値は、コードを読むだけでは決められません\n実際の値は「値を見る（F6）」で実行するとわかります";
          source = resultFor(view.state) ? "✦ AI の予想にもありませんでした" : "コードから読み取った見当";
        }
      }
    }
    return {
      pos: word.from,
      end: word.to,
      above: true,
      create: () => ({ dom: tooltipBox(word.text, lineNo, body!, source) }),
    };
};

/** マウスを乗せてから小窓が出るまでの時間は設定で変えられる（変えたらすぐ反映） */
const hoverSlot = new Compartment();
const makeHover = () => hoverTooltip(hoverSource, { hoverTime: Math.max(0, settings.get("editor.hoverDelay") ?? 250) });

bus.on("settings:changed", ({ key }) => {
  if (key === "editor.hoverDelay") forEachView((v) => v.dispatch({ effects: hoverSlot.reconfigure(makeHover()) }));
});

export function autoInfer(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        untrack: () => void;
        constructor(readonly view: EditorView) {
          this.untrack = trackView(view);
          this.decorations = buildRisks(view.state);
          schedule(view, 1500);
        }
        update(u: ViewUpdate) {
          const effects = u.transactions.flatMap((tr) => tr.effects);
          const modeChanged = effects.some((e) => e.is(sideModeChanged));
          if (u.docChanged) stop();
          if (u.docChanged || modeChanged || effects.some((e) => e.is(inferUpdated))) this.decorations = buildRisks(u.state);
          if (u.docChanged || modeChanged) schedule(u.view, modeChanged ? 300 : 2500);
        }
        destroy() {
          this.untrack();
        }
      },
      { decorations: (v) => v.decorations },
    ),
    hoverSlot.of(makeHover()),
  ];
}
