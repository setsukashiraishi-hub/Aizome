// 変数の名前を 1 か所書きかえたら、「ほかの 3 か所も変える？」と小窓で聞く。
// Tab（または「まとめて変える」）で、ファイルの中の同じ名前をまとめて変える。Esc でやめる。
// 文字列・コメントの中と、obj.名前 のような別のものの属性は変えない（rename.ts と同じ）
import { Prec, StateEffect, StateField, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { settings } from "../core/settings";
import { occurrences } from "./rename";

interface Pending {
  /** 書きかえる前の名前 */
  orig: string;
  /** 今書いている言葉の場所 */
  from: number;
  to: number;
}

const KEYWORDS = /^(and|as|assert|async|await|break|class|const|continue|def|del|elif|else|except|false|False|finally|for|from|function|global|if|import|in|is|lambda|let|new|None|nonlocal|not|null|or|pass|raise|return|self|this|true|True|try|var|while|with|yield|int|str|float|list|dict|print|range|len|input)$/;
const VALID = /^[A-Za-z_$À-￿][\w$À-￿]*$/;
const WORD = /[\w$À-￿]/;

const dismiss = StateEffect.define<null>();

/** pos の場所の言葉（なければ空の範囲） */
function wordRange(state: EditorState, pos: number): { from: number; to: number; text: string } {
  const line = state.doc.lineAt(pos);
  let s = pos - line.from;
  let e = s;
  while (s > 0 && WORD.test(line.text[s - 1])) s--;
  while (e < line.text.length && WORD.test(line.text[e])) e++;
  return { from: line.from + s, to: line.from + e, text: line.text.slice(s, e) };
}

/** ほかの場所（今書いている所を除く）で、その名前が出てくる所 */
function others(state: EditorState, p: Pending): { from: number; to: number }[] {
  return occurrences(state, p.orig).filter((o) => o.to <= p.from || o.from >= p.to);
}

function step(value: Pending | null, tr: Transaction): Pending | null {
  if (tr.effects.some((e) => e.is(dismiss))) return null;
  if (!tr.docChanged) {
    // カーソルが別の行へ行っても、提案はしばらく残す（その言葉から離れて、ほかを書きかえたら消える）
    return value;
  }
  if (tr.isUserEvent("undo") || tr.isUserEvent("redo") || tr.isUserEvent("input.rename") || !(tr.isUserEvent("input") || tr.isUserEvent("delete"))) {
    return value ? mapPending(value, tr) : null;
  }
  // 書きかえた場所（1 か所だけのとき）
  let fromA = -1;
  let toA = -1;
  let toB = -1;
  let count = 0;
  tr.changes.iterChanges((fa, ta, _fb, tb) => {
    count++;
    fromA = fa;
    toA = ta;
    toB = tb;
  });
  if (count !== 1) return null;
  const now = wordRange(tr.state, toB);
  if (value && fromA >= value.from && toA <= value.to) {
    // 書いている途中の言葉の続き
    return { orig: value.orig, from: now.from, to: now.to };
  }
  // 新しく書きかえはじめた：前の言葉が、ほかでも使っている名前なら覚える
  const before = wordRange(tr.startState, fromA);
  if (!before.text || toA > before.to || fromA < before.from) return null;
  if (!VALID.test(before.text) || /^\d/.test(before.text) || KEYWORDS.test(before.text)) return null;
  const p = { orig: before.text, from: now.from, to: now.to };
  return others(tr.startState, { orig: before.text, from: before.from, to: before.to }).length ? p : null;
}

function mapPending(p: Pending, tr: Transaction): Pending | null {
  const from = tr.changes.mapPos(p.from, -1);
  const to = tr.changes.mapPos(p.to, 1);
  return from <= to ? { ...p, from, to } : null;
}

/** 提案を出せるか（新しい名前が正しい名前で、前の名前がほかに残っている） */
function ready(state: EditorState, p: Pending | null): { next: string; n: number } | null {
  if (!p || !settings.get("editor.renameSuggest")) return null;
  const next = state.sliceDoc(p.from, p.to);
  if (!next || next === p.orig || !VALID.test(next) || /^\d/.test(next) || KEYWORDS.test(next)) return null;
  const n = others(state, p).length;
  return n ? { next, n } : null;
}

/** まとめて変える */
function apply(view: EditorView): boolean {
  const p = view.state.field(pendingField, false);
  const r = ready(view.state, p ?? null);
  if (!p || !r) return false;
  const occ = others(view.state, p);
  view.dispatch({
    changes: occ.map((o) => ({ from: o.from, to: o.to, insert: r.next })),
    effects: dismiss.of(null),
    userEvent: "input.rename",
  });
  return true;
}

const pendingField = StateField.define<Pending | null>({
  create: () => null,
  update: step,
  provide: (f) =>
    showTooltip.compute([f], (state): Tooltip | null => {
      const p = state.field(f);
      const r = ready(state, p);
      if (!p || !r) return null;
      // 書いている言葉から離れたら（別の行で作業していたら）出さない
      const head = state.selection.main.head;
      if (state.doc.lineAt(head).number !== state.doc.lineAt(p.from).number) return null;
      return {
        pos: p.from,
        above: true,
        strictSide: false,
        arrow: false,
        create: (view) => {
          const dom = document.createElement("div");
          dom.className = "cm-rename-suggest";
          const text = document.createElement("span");
          text.textContent = `ほかの ${r.n} か所の「${p.orig}」も「${r.next}」に変えますか？`;
          const yes = document.createElement("button");
          yes.className = "btn small primary";
          yes.textContent = "まとめて変える（Tab）";
          yes.onmousedown = (e) => {
            e.preventDefault();
            apply(view);
          };
          const no = document.createElement("button");
          no.className = "btn small plain";
          no.textContent = "このまま（Esc）";
          no.onmousedown = (e) => {
            e.preventDefault();
            view.dispatch({ effects: dismiss.of(null) });
          };
          dom.append(text, yes, no);
          return { dom };
        },
      };
    }),
});

export function renameSuggest(): Extension {
  return [
    pendingField,
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: (view) => {
            const p = view.state.field(pendingField, false);
            if (!p || !ready(view.state, p)) return false;
            if (view.state.doc.lineAt(view.state.selection.main.head).number !== view.state.doc.lineAt(p.from).number) return false;
            return apply(view);
          },
        },
        {
          key: "Escape",
          run: (view) => {
            const p = view.state.field(pendingField, false);
            if (!p || !ready(view.state, p)) return false;
            view.dispatch({ effects: dismiss.of(null) });
            return true;
          },
        },
      ]),
    ),
  ];
}
