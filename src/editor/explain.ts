// 行の横に「この行が何をするか」を薄く表示する。
// よくある書き方はルールですぐに、それ以外は手が止まったときに AI がまとめて説明する
import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { settings } from "../core/settings";
import { bus } from "../core/events";
import { completer } from "../ai/completer";
import { explainLine, isTrivial, langFromFilename } from "../ai/explainRules";
import { explainBranch } from "../ai/branchContext";

/** if / elif / else の行（属している条件をさかのぼって説明する） */
const BRANCH_RE = /^\s*(\}\s*)?(if|elif|else|elsif|elseif|unless)\b/;
import { languageOf } from "../ai/plan";
import { docFilename, ghostPos } from "./ghost";
import { hasValueAt, setValues } from "./valueLens";
import { sideMode, sideModeChanged } from "./sideMode";
import { inferUpdated, riskLines } from "./autoInfer";
import { inlineLines } from "./liveCheck";
import { inferBusy } from "./inferState";

const refresh = StateEffect.define<null>();

class ExplainWidget extends WidgetType {
  constructor(readonly text: string, readonly fromAi: boolean) {
    super();
  }
  eq(o: ExplainWidget) {
    return o.text === this.text && o.fromAi === this.fromAi;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-explain" + (this.fromAi ? " ai" : "");
    el.textContent = this.text;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// ルールの結果と AI の結果を覚えておく（同じ行を何度も調べない）
const ruleCache = new Map<string, string | null>();
const aiCache = new Map<string, string>();
const asked = new Set<string>();
const keyOf = (lang: string, text: string) => lang + "\u0000" + text.trim();

function limit<K, V>(m: Map<K, V>, max: number) {
  while (m.size > max) m.delete(m.keys().next().value as K);
}

function explainFor(filename: string, text: string): { text: string; ai: boolean } | null {
  if (isTrivial(text)) return null;
  const lang = langFromFilename(filename);
  const k = keyOf(lang, text);
  let rule = ruleCache.get(k);
  if (rule === undefined) {
    rule = explainLine(text, lang);
    ruleCache.set(k, rule);
    limit(ruleCache, 5000);
  }
  if (rule) return { text: rule, ai: false };
  const fromAi = aiCache.get(keyOf(filename.split(".").pop() ?? "", text));
  return fromAi ? { text: fromAi, ai: true } : null;
}

function build(view: EditorView): DecorationSet {
  const mode = settings.get("editor.explain");
  const side = sideMode();
  if (mode === "off" || (side !== "explain" && side !== "auto")) return Decoration.none;
  // 自動判定ではエラーの可能性（⚠）を優先し、その行には説明を出さない
  const risky = side === "auto" ? riskLines(view.state) : inlineLines(view.state);
  const filename = view.state.facet(docFilename);
  const ghost = ghostPos(view.state);
  const ghostLine = ghost !== null ? view.state.doc.lineAt(ghost).number : -1;
  const b = new RangeSetBuilder<Decoration>();
  let last = 0;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number <= last) continue;
      last = line.number;
      // AI の候補を出している行には重ねない
      if (line.number !== ghostLine && !hasValueAt(view.state, line.number) && !risky.has(line.number)) {
        let e = explainFor(filename, line.text);
        if (e && !e.ai && BRANCH_RE.test(line.text)) {
          const doc = view.state.doc;
          const br = explainBranch((i) => (i >= 0 && i < doc.lines ? doc.line(i + 1).text : ""), line.number - 1, langFromFilename(filename));
          if (br) e = { text: br, ai: false };
        }
        if (e && (mode === "ai" || !e.ai)) b.add(line.to, line.to, Decoration.widget({ widget: new ExplainWidget(e.text, e.ai), side: 2 }));
      }
    }
  }
  return b.finish();
}

// ───────── AI に説明を頼む（手が止まってから、見えている行をまとめて1回）

let timer: number | undefined;
const views = new Set<EditorView>();
/** 説明を頼んでいる最中なら、それを取り消す関数 */
let cancelRunning: (() => void) | null = null;
/** つながらなかったときは、しばらく頼まない */
let pauseUntil = 0;

/** 入力が始まったら、補完を優先するために説明の依頼を止める */
function stopAi() {
  window.clearTimeout(timer);
  cancelRunning?.();
  cancelRunning = null;
}

function scheduleAi(view: EditorView, delay = 1800) {
  window.clearTimeout(timer);
  const side = sideMode();
  if (settings.get("editor.explain") !== "ai" || !settings.get("ai.enabled") || (side !== "explain" && side !== "auto")) return;
  if (Date.now() < pauseUntil) delay = Math.max(delay, pauseUntil - Date.now());
  timer = window.setTimeout(() => void askAi(view), delay);
}

async function askAi(view: EditorView) {
  // 補完を考えている最中は待つ（PC の負担を重ねない）
  // 自動判定の予想を先に（そのあとで説明）
  if (completer.status === "thinking" || cancelRunning || inferBusy) return scheduleAi(view, 1500);
  const filename = view.state.facet(docFilename);
  const ext = filename.split(".").pop() ?? "";
  const lang = langFromFilename(filename);
  const doc = view.state.doc;
  const numbered: string[] = [];
  const targets: { n: number; text: string }[] = [];
  let last = 0;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number <= last) continue;
      last = line.number;
      numbered.push(`${line.number}: ${line.text}`);
      const k = keyOf(ext, line.text);
      if (!isTrivial(line.text) && !explainLine(line.text, lang) && !aiCache.has(k) && !asked.has(k)) targets.push({ n: line.number, text: line.text });
    }
  }
  if (!targets.length) return;
  const batch = targets.slice(0, 25);
  batch.forEach((t) => asked.add(keyOf(ext, t.text)));
  const language = languageOf(filename) || "プログラム";
  const prompt = [
    `次の ${language} のコードで、指定した行がそれぞれ何をするかを、日本語でとても短く（25 文字以内）説明してください。`,
    "プログラミングを習いはじめた人にもわかる言葉で、「〜します」の形で書いてください。",
    "型の名前を書くときは「string（文字列）」「int（整数）」「List<int>（int のリスト）」のように、型の名前のあとにかっこで日本語の意味を書いてください（例：string（文字列）の変数 a を作ります）。",
    "出力は 1 行に 1 つずつ「行番号|説明」の形だけにしてください。前置きや、ほかの文は書かないでください。",
    "",
    `説明してほしい行番号：${batch.map((t) => t.n).join(", ")}`,
    "",
    "コード：",
    ...numbered.slice(0, 120),
  ].join("\n");
  let stopped = false;
  try {
    const answer = await completer.ask(prompt, {
      maxTokens: 900,
      temperature: 0.1,
      onStart: (cancel) => {
        cancelRunning = () => {
          stopped = true;
          cancel();
        };
      },
    });
    cancelRunning = null;
    if (stopped) {
      // 途中で止めた分は、次に手が止まったときにもう一度
      batch.forEach((t) => asked.delete(keyOf(ext, t.text)));
      return;
    }
    const byNumber = new Map(batch.map((t) => [t.n, t.text]));
    for (const row of answer.split("\n")) {
      const m = /^\s*(\d+)\s*[|｜:：]\s*(.+?)\s*$/.exec(row);
      if (!m) continue;
      const text = byNumber.get(Number(m[1]));
      if (!text) continue;
      const desc = m[2].replace(/^[「"']|[」"']$/g, "").slice(0, 60);
      if (desc) aiCache.set(keyOf(ext, text), desc);
    }
    limit(aiCache, 5000);
    for (const v of views) v.dispatch({ effects: refresh.of(null) });
  } catch {
    // つながらないときは静かにあきらめて、1 分ほど待ってからまた試す
    cancelRunning = null;
    pauseUntil = Date.now() + 60_000;
    batch.forEach((t) => asked.delete(keyOf(ext, t.text)));
  }
}

export function lineExplanations(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(readonly view: EditorView) {
        views.add(view);
        this.decorations = build(view);
        scheduleAi(view, 2500);
      }
      update(u: ViewUpdate) {
        const refreshed = u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh) || e.is(setValues) || e.is(sideModeChanged) || e.is(inferUpdated)));
        if (u.docChanged || u.viewportChanged || refreshed || u.selectionSet) this.decorations = build(u.view);
        if (u.docChanged) stopAi();
        if (u.docChanged || u.viewportChanged) scheduleAi(u.view);
        else if (u.transactions.some((tr) => tr.effects.some((e) => e.is(sideModeChanged)))) scheduleAi(u.view, 300);
      }
      destroy() {
        views.delete(this.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// 設定を切り替えたら描き直す
bus.on("settings:changed", ({ key }) => {
  if (key === "editor.explain") {
    for (const v of views) {
      v.dispatch({ effects: refresh.of(null) });
      scheduleAi(v, 300);
    }
  }
});
