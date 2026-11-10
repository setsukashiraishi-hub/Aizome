// まとまり（if・for・関数・クラス・try・複数行のリストなど）がどこまでかかっているかを、色つきの線で示す。
// - 見出しの行の下から、まとまりの終わりまで縦の線と、終わりに小さなかぎ（└）
// - カーソルのあるまとまりと、そのひと続き（if → elif → else など）は、線を濃く太く
// - 分岐のひと続きにカーソルがあるときは、それぞれの見出しの右に「もし〇〇なら」「〇〇でないとき」を出す
import { StateField, type EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, RectangleMarker, ViewPlugin, WidgetType, layer, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { settings } from "../core/settings";
import { bus } from "../core/events";
import { docFilename } from "./ghost";
import { explainLangOf, findBlocks, labelBranches, type Block } from "./blocks";

const MAX_LINES = 8000;

function computeBlocks(state: EditorState): Block[] {
  if (state.doc.lines > MAX_LINES) return [];
  const lines: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) lines.push(state.doc.line(i).text);
  const blocks = findBlocks(lines, state.tabSize);
  labelBranches(blocks, lines, explainLangOf(state.facet(docFilename)));
  return blocks;
}

const blocksField = StateField.define<Block[]>({
  create: (state) => computeBlocks(state),
  update: (value, tr) => (tr.docChanged || tr.startState.facet(docFilename) !== tr.state.facet(docFilename) ? computeBlocks(tr.state) : value),
});

/** カーソルのある、いちばん内側のまとまりと、そのひと続き */
function activeBlocks(state: EditorState): { inner: Block | null; chain: Set<number> } {
  const line = state.doc.lineAt(state.selection.main.head).number;
  let inner: Block | null = null;
  for (const b of state.field(blocksField)) {
    if (b.header <= line && line <= b.end && (!inner || b.col >= inner.col)) inner = b;
  }
  return { inner, chain: inner ? new Set([inner.chain]) : new Set() };
}

/** 分岐のひと続き（ラベルを出すもの）。カーソルのある所から外へ見て、最初の分岐 */
function activeBranchChain(state: EditorState): number | null {
  const line = state.doc.lineAt(state.selection.main.head).number;
  let best: Block | null = null;
  for (const b of state.field(blocksField)) {
    if (!b.label) continue;
    if (b.header <= line && line <= b.end && (!best || b.col >= best.col)) best = b;
  }
  return best ? best.chain : null;
}

// ───────── 線（テキストの下に描く）

function base(view: EditorView) {
  const r = view.scrollDOM.getBoundingClientRect();
  return { left: r.left - view.scrollDOM.scrollLeft * view.scaleX, top: r.top - view.scrollDOM.scrollTop * view.scaleY };
}

const guideLayer = layer({
  above: false,
  class: "cm-block-guides",
  update: (u) => u.docChanged || u.viewportChanged || u.selectionSet || u.geometryChanged || u.focusChanged,
  markers(view) {
    if (!settings.get("editor.blockGuides")) return [];
    const blocks = view.state.field(blocksField);
    if (!blocks.length) return [];
    const b0 = base(view);
    // 字下げ 0 の位置（見えている行で測る）
    const vis = view.visibleRanges[0];
    if (!vis) return [];
    const firstVisible = view.state.doc.lineAt(vis.from);
    const c0 = view.coordsAtPos(firstVisible.from);
    if (!c0) return [];
    const x0 = c0.left - b0.left;
    const cw = view.defaultCharacterWidth;
    const docTop = view.documentTop - b0.top;
    const { inner, chain } = activeBlocks(view.state);
    const out: RectangleMarker[] = [];
    const vFrom = view.viewport.from;
    const vTo = view.viewport.to;
    for (const b of blocks) {
      if (b.end < b.header + 1) continue;
      const start = view.state.doc.line(b.header + 1);
      const end = view.state.doc.line(b.end);
      if (end.to < vFrom || start.from > vTo) continue;
      const top = docTop + view.lineBlockAt(start.from).top;
      const bottom = docTop + view.lineBlockAt(end.from).bottom;
      const on = b === inner || (chain.has(b.chain) && inner?.chain === b.chain);
      const left = x0 + b.col * cw + Math.round(cw * 0.35);
      out.push(new RectangleMarker(`cm-block-guide k-${b.kind}${on ? " on" : ""}`, left, top, Math.max(4, Math.round(cw * 0.6)), Math.max(2, bottom - top - 3)));
    }
    return out;
  },
});

// ───────── 「もし〇〇なら」のラベル（見出しの行の右）

class BranchLabel extends WidgetType {
  constructor(
    readonly text: string,
    readonly kind: string,
  ) {
    super();
  }
  eq(o: BranchLabel) {
    return o.text === this.text && o.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-branch-label k-${this.kind}`;
    el.textContent = `${this.text} ↓`;
    el.title = "このまとまりに入る条件";
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function labels(state: EditorState): DecorationSet {
  if (!settings.get("editor.branchLabels")) return Decoration.none;
  const chain = activeBranchChain(state);
  if (chain === null) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  const seen = new Set<number>();
  for (const blk of state.field(blocksField).filter((x) => x.chain === chain && x.label).sort((a, c) => a.header - c.header)) {
    if (seen.has(blk.header)) continue;
    seen.add(blk.header);
    const line = state.doc.line(blk.header);
    b.add(line.to, line.to, Decoration.widget({ widget: new BranchLabel(blk.label!, blk.kind), side: 1 }));
  }
  return b.finish();
}

const labelPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = labels(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.length)) this.decorations = labels(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);

/** 設定を変えたら描き直す */
const redraw = ViewPlugin.fromClass(
  class {
    off: () => void;
    constructor(view: EditorView) {
      this.off = bus.on("settings:changed", ({ key }) => {
        if (key === "editor.blockGuides" || key === "editor.branchLabels") view.dispatch({ selection: view.state.selection });
      });
    }
    destroy() {
      this.off();
    }
  },
);

export function scopeGuides(): Extension {
  return [blocksField, guideLayer, labelPlugin, redraw];
}

/** ほかの機能から使う：そのまとまりの一覧 */
export function blocksOf(state: EditorState): Block[] {
  return state.field(blocksField, false) ?? [];
}
