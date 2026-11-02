// はじめての人向けのチュートリアル：画面の部品を枠で囲みながら、順に説明する
// 最初に起動したときに 1 回だけ、あとは /tutorial でいつでも
import { h } from "../core/dom";
import { settings } from "../core/settings";

interface Step {
  /** 囲む部品（なければ画面の真ん中に説明だけ出す） */
  target?: () => Element | null | undefined;
  title: string;
  body: string;
  /** 部品が見つからなかったときに添える一言 */
  missing?: string;
}

const q = (sel: string) => () => document.querySelector(sel);
const activity = (i: number) => () => {
  const list = [...document.querySelectorAll(".activity > .activity-btn")];
  return i < 0 ? list[list.length + i] : list[i];
};
const openFileNote = "（ファイルを開くと、ここに出ます）";

const STEPS: Step[] = [
  {
    title: "Aizome へようこそ！",
    body: "この画面の使い方を、部品ごとに順番に紹介します。「次へ」で進み、「スキップ」でいつでも終われます。あとから見たいときは、/tutorial と入力すると何回でも見られます。",
  },
  {
    target: q(".menu-btn"),
    title: "メニュー",
    body: "「Aizome」を押すと、新しいファイル・開く・保存・書き出し・印刷・設定などのメニューが出ます。右に並んでいる「編集」「表示」「実行」「AI」「ヘルプ」も、押すと中の項目が出てきます。",
  },
  {
    target: q(".palette-trigger"),
    title: "検索と / で便利機能",
    body: "ファイル名やコマンドの名前で探せます（Ctrl+P）。「/」を入力すると、/help（使い方）・/dict（コード辞書）・/python（実行）・/tutorial（このチュートリアル）などの便利機能を呼び出せます。",
  },
  {
    target: () => document.querySelector(".history-btn")?.parentElement,
    title: "元に戻す・やり直す",
    body: "↺ で元に戻し、↻ でやり直します（Ctrl+Z / Ctrl+Y と同じ）。AI で組み立てた変更も戻せます。保存してからアプリを閉じるまで、何回でも戻れます。",
  },
  {
    target: q(".ai-pill"),
    title: "AI の状態",
    body: "使っている AI のモデルと、つながっているかが表示されます。押すと AI のオン・オフを切りかえられます。エラーのときは、押すと原因と直し方が出ます。",
  },
  {
    target: q(".activity"),
    title: "左の列（いろいろな画面）",
    body: "上から、エクスプローラー（ファイル）・関数の一覧・全体検索・コード辞書・AI チャット・拡張機能です。下のほうには、ターミナルと設定のボタンがあります。",
  },
  {
    target: q(".sidebar"),
    title: "エクスプローラー",
    body: "開いているフォルダのファイルが並びます。グループを作ってファイルをまとめたり（Ctrl や Shift を押しながら選ぶと、まとめてグループに入れられます。フォルダごとも OK）、下の「保存記録」から前に保存した内容に戻したりできます。境目をドラッグすると幅を変えられ、細くしすぎると自動で折りたたまれます。",
  },
  {
    target: q(".activity-dict"),
    title: "コード辞書",
    body: "「画面に表示する」「くり返す」のように、やりたいことから書き方を探して、そのまま入れられます。Python・C#（Unity）・JavaScript などに対応しています。",
  },
  {
    target: q(".tabs"),
    title: "タブ",
    body: "開いているファイルが並びます。タブを右のほうへドラッグすると、2 つのファイルを横に並べて見られます。● は、まだ保存していない印です。",
    missing: openFileNote,
  },
  {
    target: q(".side-switch"),
    title: "行の右に出すもの",
    body: "「説明」は各行が何をするかを日本語で出します（math.sin(i) なら「i の正弦（サイン）」）。「値」は実行したときの変数の値、「戻り値」は関数やメソッドが返した値（math.sin(i) → 0.8415 など）、「自動判定」は実行するとエラーになりそうな所を出します。「なし」で何も出しません。",
    missing: openFileNote,
  },
  {
    target: q(".pane-tools"),
    title: "値を見る・実行",
    body: "「実行」（F5）でプログラムを動かします。「値を見る」（F6）は 1 行ずつ動かして、その時の変数の値と、その行が画面に出した文字（print などの出力）を行の右に出します。くり返しの何回目かも切りかえて見られます。HTML や Markdown のファイルでは「プレビュー」が出て、出来上がったページの形で見られます。",
    missing: openFileNote,
  },
  {
    target: q(".editor-mount"),
    title: "コードを書くところ",
    body: "書いていると、AI が続きを薄い文字で出します。Tab をすばやく 2 回押すと入り（Tab 1 回は下に出る候補の一覧用）、Esc で消せます。まちがいには赤い波線と日本語の説明が出て、ホイールを押しこむ（中クリック）といちばん確かな直し方で直ります。右クリックでコピー履歴などのメニューも出ます。",
  },
  {
    target: q(".statusbar"),
    title: "下の帯",
    body: "カーソルの行と列、字下げ、文字コード（UTF-8 など）、言語が表示されます。押すと切りかえられるものもあります。",
  },
  {
    target: activity(-2),
    title: "ターミナル",
    body: "コマンドを打てる画面を開きます（Ctrl+`）。実行した結果もここに出ます。2 つ並べて、実行結果を比べることもできます。",
  },
  {
    target: activity(-1),
    title: "設定",
    body: "色や文字の大きさ、AI のモデル、使う機能のオン・オフなどを変えられます。AI がメモリ不足で動かないときは、ここで「AI を CPU だけで動かす」を選べます。",
  },
  {
    title: "これで紹介は終わりです",
    body: "困ったときは /help（使い方）や /faq（よくある質問）を入力してください。このチュートリアルは /tutorial でいつでも見直せます。たのしく書いていきましょう！",
  },
];

let running: (() => void) | null = null;

/** チュートリアルを始める（すでに出ていれば何もしない） */
export function startTour(): void {
  if (running) return;
  let index = 0;

  const shade = h("div", { class: "tour-shade" });
  const ring = h("div", { class: "tour-ring" });
  const title = h("h3", { class: "tour-title" });
  const body = h("p", { class: "tour-body" });
  const count = h("span", { class: "tour-count" });
  const back = h("button", { class: "btn plain", type: "button" }, "戻る") as HTMLButtonElement;
  const next = h("button", { class: "btn primary", type: "button" }, "次へ") as HTMLButtonElement;
  const skip = h("button", { class: "btn plain tour-skip", type: "button" }, "スキップ") as HTMLButtonElement;
  const card = h(
    "div",
    { class: "tour-card", role: "dialog", "aria-modal": "true", "aria-live": "polite" },
    title,
    body,
    h("div", { class: "tour-actions" }, count, h("span", { class: "tour-gap" }), skip, back, next),
  );
  const root = h("div", { class: "tour" }, shade, ring, card);

  const finish = () => {
    root.remove();
    window.removeEventListener("resize", place);
    document.removeEventListener("keydown", onKey, true);
    running = null;
    settings.set("ui.tourDone", true);
  };
  running = finish;

  function visible(el: Element | null | undefined): el is HTMLElement {
    if (!el || !(el instanceof HTMLElement) || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== "hidden";
  }

  function place() {
    const step = STEPS[index];
    const el = step.target?.();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    card.style.maxWidth = `${Math.min(380, vw - 32)}px`;
    if (visible(el)) {
      const r = el.getBoundingClientRect();
      const pad = 6;
      const x = Math.max(4, r.left - pad);
      const y = Math.max(4, r.top - pad);
      const w = Math.min(vw - 8, r.right + pad) - x;
      const hgt = Math.min(vh - 8, r.bottom + pad) - y;
      Object.assign(ring.style, { display: "block", left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hgt}px` });
      shade.classList.add("clear");
      // 説明は、囲んだ所の下 → 上 → 右 → 左 の順で入る所に置く
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const gap = 14;
      let left: number;
      let top: number;
      if (y + hgt + gap + ch <= vh - 8) {
        top = y + hgt + gap;
        left = x;
      } else if (y - gap - ch >= 8) {
        top = y - gap - ch;
        left = x;
      } else if (x + w + gap + cw <= vw - 8) {
        left = x + w + gap;
        top = y;
      } else if (x - gap - cw >= 8) {
        left = x - gap - cw;
        top = y;
      } else {
        // 大きい部品（コードを書くところなど）は、中に重ねる
        left = x + w / 2 - cw / 2;
        top = y + hgt / 2 - ch / 2;
      }
      left = Math.min(Math.max(8, left), vw - cw - 8);
      top = Math.min(Math.max(8, top), vh - ch - 8);
      Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    } else {
      ring.style.display = "none";
      shade.classList.remove("clear");
      Object.assign(card.style, { left: `${vw / 2 - card.offsetWidth / 2}px`, top: `${vh / 2 - card.offsetHeight / 2}px` });
    }
  }

  function show() {
    const step = STEPS[index];
    const el = step.target?.();
    title.textContent = step.title;
    body.textContent = step.body + (step.target && !visible(el) && step.missing ? step.missing : "");
    count.textContent = `${index + 1} / ${STEPS.length}`;
    back.disabled = index === 0;
    next.textContent = index === STEPS.length - 1 ? "はじめる" : "次へ";
    skip.style.visibility = index === STEPS.length - 1 ? "hidden" : "visible";
    place();
    next.focus();
  }

  const go = (d: number) => {
    const n = index + d;
    if (n >= STEPS.length) return finish();
    if (n < 0) return;
    index = n;
    show();
  };

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") finish();
    else if (e.key === "ArrowRight" || e.key === "Enter") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  next.onclick = () => go(1);
  back.onclick = () => go(-1);
  skip.onclick = finish;
  // 暗い所を押しても進まない（まちがえて押したときのため）
  shade.addEventListener("mousedown", (e) => e.preventDefault());
  window.addEventListener("resize", place);
  document.addEventListener("keydown", onKey, true);
  document.body.append(root);
  show();
}

/** はじめて起動したときに 1 回だけ出す（ほかの確認画面が出ていれば、閉じるのを待つ） */
export function startTourIfFirstTime(): void {
  if (settings.get("ui.tourDone")) return;
  let tries = 0;
  const wait = () => {
    if (settings.get("ui.tourDone") || running) return;
    if (document.querySelector(".modal-backdrop") && tries++ < 600) {
      window.setTimeout(wait, 1000);
      return;
    }
    startTour();
  };
  window.setTimeout(wait, 1500);
}
