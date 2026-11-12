// 「/」で呼び出せる便利機能の中身
import { commands } from "../core/commands";
import { settings } from "../core/settings";
import { runtimes } from "../core/platform";
import { basename } from "../core/paths";
import { calc, countChars, dateFormats, fixZenkakuInCode, hanKanaToZen, hanToZen, hiraToKata, kataToHira, zenToHan } from "../core/jpText";
import { commentSyntax, languageOf } from "../ai/plan";
import type { EditorHost } from "../editor/types";
import { registerSlash, type SlashCommand } from "./slash";
import { startTour } from "./tour";
import { DICT_LANGUAGES, dictLanguageFor, plainCode, searchDict, toSnippetTemplate } from "../dict";
import { quickPick } from "./palette";
import { toast } from "./toast";
import { choose } from "./dialog";

export interface SlashDeps {
  editor: EditorHost;
  os: () => string;
  activeName: () => string | null;
  hasDoc: () => boolean;
  showView: (view: "explorer" | "search" | "ai" | "extensions") => void;
  searchFor: (text: string) => void;
  askAi: (text: string) => void;
  runInTerminal: (command: string) => void;
  explainError: () => void;
  openSettings: (section?: string) => void;
  openHelp: (section?: string) => void;
  openDict: (query?: string) => void;
}

const G = {
  help: "ヘルプ",
  file: "ファイル",
  run: "実行",
  ai: "AI",
  jp: "日本語・文字",
  insert: "入力・挿入",
  view: "表示",
  settings: "設定",
};

/** 既にあるコマンドを、そのまま / から呼べるようにする */
function cmd(name: string, aliases: string[], id: string, group: string, icon?: string, desc?: string): SlashCommand {
  return {
    name,
    aliases,
    group,
    icon,
    command: id,
    title: () => {
      const c = commands.get(id);
      return c ? commands.title(c) : name;
    },
    desc: desc ? () => desc : undefined,
    run: () => commands.execute(id),
  };
}

export function registerBuiltinSlash(d: SlashDeps) {
  const needDoc = (): boolean => {
    if (d.hasDoc()) return true;
    toast("ファイルを開いてから使ってください", "info");
    return false;
  };
  /** 選んだ範囲（なければファイル全体）の文字を変換する */
  const convert = (fn: (s: string) => string, label: string) => () => {
    if (!needDoc()) return;
    const sel = d.editor.getSelection();
    if (sel) {
      const out = fn(sel);
      if (out !== sel) d.editor.replaceSelection(out);
      toast(out === sel ? `${label}：変えるところはありませんでした` : `${label}：選んだ範囲を変えました`, "info");
      return;
    }
    const all = d.editor.getText();
    const out = fn(all);
    if (out === all) return toast(`${label}：変えるところはありませんでした`, "info");
    d.editor.applyText(out);
    toast(`${label}：ファイル全体を変えました（Ctrl+Z で元に戻せます）`, "success");
  };
  const insert = (text: string) => {
    if (!needDoc()) return;
    d.editor.insertText(text);
    d.editor.focus();
  };

  registerSlash(
    // ───── ヘルプ
    {
      name: "help",
      aliases: ["へるぷ", "ヘルプ", "使い方", "つかいかた", "tsukaikata", "herupu", "?", "？", "howto", "manual"],
      group: G.help,
      icon: "help",
      title: () => "使い方とヘルプ",
      desc: () => "基本の使い方・便利機能・困ったとき",
      command: "help.open",
      run: () => d.openHelp(),
    },
    {
      name: "tutorial",
      aliases: ["チュートリアル", "ちゅーとりある", "ツアー", "案内", "あんない", "はじめて", "初めて", "tour", "chuutoriaru", "annai"],
      group: G.help,
      icon: "help",
      title: () => "チュートリアル（画面の案内）",
      desc: () => "画面の部品を順番に囲んで、何ができるかを紹介します",
      run: () => startTour(),
    },
    {
      name: "faq",
      aliases: ["困ったとき", "こまったとき", "トラブル", "うごかない", "動かない", "trouble"],
      group: G.help,
      icon: "help",
      title: () => "困ったとき（よくある質問）",
      run: () => d.openHelp("faq"),
    },
    cmd("keys", ["ショートカット", "しょーとかっと", "キー", "shortcut", "kii"], "help.shortcuts", G.help, "keyboard"),
    cmd("about", ["バージョン", "ばーじょん", "version", "情報", "じょうほう"], "help.about", G.help, "help"),
    cmd("update", ["更新", "こうしん", "アップデート", "koushin", "appudeto"], "app.checkUpdates", G.help, "refresh"),
    cmd("commands", ["コマンド", "こまんど", "すべてのコマンド", "palette"], "view.commandPalette", G.help, "search", "メニューにあるすべての操作"),

    {
      name: "dict",
      aliases: ["辞書", "じしょ", "コード辞書", "jisho", "書き方", "かきかた", "使い方を調べる", "cheatsheet", "snippet"],
      group: G.help,
      icon: "book",
      title: () => "コード辞書",
      argHint: () => "やりたいこと（例：並べ替え）",
      command: "view.dict",
      desc: () => "やりたいことを日本語で探して、ボタン一つでコードを入れる",
      expand: (arg) => {
        if (!arg) return [];
        const lang = dictLanguageFor(d.activeName() ?? "") ?? DICT_LANGUAGES[0];
        return searchDict(lang.id, arg)
          .slice(0, 8)
          .map((hit) => ({
            label: hit.title,
            detail: `${lang.label}：${plainCode(hit.code).split("\n").find((l) => l.trim() && !/^(import|from|using|#include)\b/.test(l.trim()))?.trim() ?? ""}`,
            run: () => {
              if (!needDoc()) return;
              d.editor.insertSnippet(toSnippetTemplate(hit.code));
            },
          }));
      },
      run: (arg) => d.openDict(arg),
    },

    // ───── ファイル
    cmd("new", ["新規", "しんき", "新しいファイル", "shinki"], "file.new", G.file, "newFile"),
    cmd("open", ["開く", "ひらく", "フォルダ", "ふぉるだ", "folder", "hiraku"], "file.openFolder", G.file, "folderOpen"),
    cmd("recent", ["最近", "さいきん", "履歴", "rireki", "saikin"], "file.openRecent", G.file, "clock"),
    cmd("save", ["保存", "ほぞん", "hozon", "セーブ"], "file.save", G.file, "file"),
    cmd("saveas", ["名前を付けて保存", "なまえをつけて", "別名", "betsumei"], "file.saveAs", G.file, "file"),
    cmd("saveall", ["すべて保存", "ぜんぶ保存", "全部保存"], "file.saveAll", G.file, "file"),
    cmd("copypath", ["パス", "ぱす", "場所をコピー", "pasu"], "file.copyPath", G.file, "file"),
    cmd("encoding", ["文字コード", "もじこーど", "エンコード", "utf8", "utf-8", "shift_jis", "sjis", "文字化け", "もじばけ", "改行コード", "crlf"], "file.encoding", G.file, "text", "UTF-8・Shift_JIS などで保存し直す／開き直す・改行コード"),
    cmd("print", ["印刷", "いんさつ", "insatsu", "プリント"], "file.print", G.file, "file"),
    {
      name: "find",
      aliases: ["探す", "さがす", "検索", "けんさく", "grep", "sagasu", "kensaku", "search"],
      group: G.file,
      icon: "search",
      title: () => "フォルダ全体から探す",
      argHint: () => "探す言葉",
      desc: () => "/探す 関数名 のように書くと、すぐ探します",
      run: (arg) => d.searchFor(arg),
    },
    {
      name: "replace",
      aliases: ["置換", "ちかん", "置き換え", "おきかえ", "chikan"],
      group: G.file,
      icon: "search",
      title: () => "このファイルで置き換え",
      command: "edit.replace",
      run: () => needDoc() && d.editor.run("replace"),
    },
    {
      name: "goto",
      aliases: ["行", "ぎょう", "line", "移動", "いどう", "gyou", "jump"],
      group: G.file,
      icon: "chevron",
      title: () => "指定した行へ移動",
      argHint: () => "行番号",
      command: "editor.goToLine",
      preview: (arg) => (/^\d+$/.test(zenToHan(arg)) ? `→ ${zenToHan(arg)} 行目` : null),
      run: (arg) => {
        const n = Number(zenToHan(arg));
        if (needDoc() && n > 0) d.editor.goTo(n);
      },
    },
    {
      name: "todo",
      aliases: ["やること", "やる事", "TODO", "FIXME", "メモ", "yarukoto"],
      group: G.file,
      icon: "files",
      title: () => "TODO・FIXME の一覧",
      desc: () => "このファイルの TODO / FIXME / XXX / メモ の行へ移動",
      run: async () => {
        if (!needDoc()) return;
        const items = d.editor
          .getText()
          .split("\n")
          .map((text, i) => ({ text, line: i + 1 }))
          .filter((l) => /\b(TODO|FIXME|XXX|HACK|NOTE)\b|やること|あとで|要確認/.test(l.text))
          .map((l) => ({ label: l.text.trim().slice(0, 120), detail: `${l.line} 行目`, value: l.line }));
        if (!items.length) return toast("TODO や FIXME の行はありませんでした", "info");
        const line = await quickPick(items, "移動する行を選んでください");
        if (line) d.editor.goTo(line);
      },
    },

    // ───── 実行
    cmd("auto", ["自動判定", "じどうはんてい", "予想", "よそう", "自動", "jidou", "推測"], "view.sideAuto", G.ai, "spark", "実行せずに AI が変数の中身とエラーの可能性を予想（変数にマウスを乗せると表示）"),
    cmd("export", ["書き出し", "かきだし", "PDF", "pdf", "Word", "word", "ワード", "docx", "HTML", "html", "テキスト", "txt", "印刷用", "保存形式"], "file.export", G.file, "file", "コードを PDF・Word・HTML・テキストに、用紙・行番号・色付きで書き出す"),
    cmd("build", ["ビルド", "びるど", "exe", "実行ファイル", "じっこうふぁいる", "jar", "コンパイル", "こんぱいる"], "run.build", G.run, "play", "言語に合わせて実行ファイル（.exe・.jar など）を build フォルダに作る"),
    cmd("format", ["整形", "せいけい", "整える", "ととのえる", "フォーマット", "インデントを直す", "きれいに"], "edit.format", G.insert, "wand", "コードの字下げ・空白・空行を整える（black・gofmt などがあれば使う）"),
    cmd("outline", ["関数の一覧", "かんすうのいちらん", "アウトライン", "一覧", "目次", "もくじ"], "view.outline", G.view, "sidebar", "左に、このファイルの関数・クラスの一覧を出す"),
    cmd("symbol", ["関数へ移動", "記号へ移動", "関数を探す", "ジャンプ"], "go.symbol", G.view, "search", "関数・クラスを選んで、その行へ飛ぶ"),
    cmd("clips", ["コピー履歴", "こぴーりれき", "履歴", "りれき", "クリップボード", "clipboard", "kopi"], "edit.pasteHistory", G.insert, "clock", "最近コピーした 10 個から選んで貼り付ける（あいぞめの外でコピーしたものも）"),
    cmd("split", ["左右", "左右に並べる", "さゆう", "並べる", "ならべる", "分割", "ぶんかつ", "右に並べる"], "view.splitRight", G.view, "sidebar", "今のファイルを右に並べる（タブの右クリックでも）"),
    cmd("unsplit", ["分割をやめる", "元に戻す", "並べるのをやめる", "ひとつに"], "view.unsplit", G.view, "sidebar", "左右に並べるのをやめる"),
    cmd("side", ["表示切替", "表示切り替え", "ひょうじきりかえ", "切り替え", "横の表示"], "view.sideNext", G.view, "sidebar", "行の右の表示：説明 → 値 → 自動判定 → なし"),
    cmd("rename", ["名前の変更", "なまえのへんこう", "一括変更", "いっかつへんこう", "リネーム", "名前を変える"], "edit.renameSymbol", G.file, "text", "カーソルのある変数・関数の名前を、ファイル内でまとめて変える"),
    cmd("inputs", ["入力", "にゅうりょく", "入力の登録", "テスト入力", "input", "自動入力", "nyuuryoku"], "run.editInputs", G.run, "keyboard", "input() に入れる値を登録して、実行のたびに自動で入れる"),
    cmd("returns", ["戻り値", "もどりち", "返り値", "かえりち", "return", "modorichi", "出力"], "view.sideOutput", G.run, "terminal", "「値を見る」で実行したときに、関数・メソッドが返した値を行の右に表示"),
    cmd("step", ["ステップ", "すてっぷ", "1回ずつ", "次の回", "その時点", "step"], "run.stepNext", G.run, "chevron", "その行が何回目に動いた瞬間の値・出力を 1 回ずつ見る（F7 / Shift+F7）"),
    cmd("values", ["値", "あたい", "値を見る", "変数", "へんすう", "中身", "なかみ", "トレース", "trace", "デバッグ", "debug", "atai"], "run.trace", G.run, "eye", "行ごとに変数の値を記録しながら実行して、行の右に表示（Python）"),
    cmd("run", ["実行", "じっこう", "jikkou", "jikko", "うごかす", "動かす", "F5"], "run.file", G.run, "play"),
    cmd("terminal", ["ターミナル", "たーみなる", "端末", "ta-minaru"], "terminal.toggle", G.run, "terminal"),
    cmd("newterm", ["新しいターミナル", "あたらしいたーみなる"], "terminal.new", G.run, "terminal"),
    cmd("copyall", ["全部コピー", "ぜんぶこぴー", "まるごとコピー", "まるごとこぴー", "コピー", "こぴー", "copy"], "edit.copyAll", G.file, "copy", "開いているファイルの中身を、1 回でまるごとコピー"),
    cmd("blocks", ["ブロック", "ぶろっく", "スクラッチ", "すくらっち", "scratch", "burokku"], "blocks.open", G.run, "blocks", "日本語のブロックを組み立てて、Python・JavaScript・Go・C++・C# のプログラムを作る"),
    // 登録は OS の情報を読む前に動くので、d.os() ではなく userAgent で見る
    ...(navigator.userAgent.includes("Windows")
      ? [
          cmd("cmd", ["コマンドプロンプト", "こまんどぷろんぷと", "コマプロ", "こまぷろ", "command", "komapuro"], "terminal.newCmd", G.run, "terminal", "コマンドプロンプトのターミナルを開く（set HTTPS_PROXY=… や dir /? が、プリントのとおりに使える）"),
          cmd("powershell", ["パワーシェル", "ぱわーしぇる", "ps", "pawa-sheru"], "terminal.newPowerShell", G.run, "terminal", "PowerShell のターミナルを開く（環境変数は $env:HTTPS_PROXY=\"…\" の書き方）"),
        ]
      : []),
    cmd("clear", ["クリア", "くりあ", "画面を消す", "cls"], "terminal.clear", G.run, "trash"),
    {
      name: "error",
      aliases: ["エラー", "えらー", "エラー解説", "えらーかいせつ", "err", "era-", "なぜ", "なんで"],
      group: G.run,
      icon: "alert",
      title: () => "エラーを日本語で解説",
      desc: () => "ターミナルに出た最後のエラーの意味と直し方",
      run: () => d.explainError(),
    },
    {
      name: "python",
      aliases: ["パイソン", "ぱいそん", "py", "paison"],
      group: G.run,
      icon: "play",
      title: () => "Python が使えるか確かめる",
      run: async () => {
        const info = await runtimes.findPython().catch(() => ({ command: null, storeStub: false, source: "" }));
        if (info.command) {
          toast(`Python が使えます：${info.command}（${info.source}で見つけました）`, "success", 7000);
          d.runInTerminal(`${d.os() === "windows" ? "& " : ""}${info.command} --version`);
        } else {
          toast(info.storeStub ? "Python が入っていません（Store 案内用の仮の python だけがあります）。実行すると入れ方を案内します" : "Python が見つかりません", "warn", 8000);
        }
      },
    },
    {
      name: "pip",
      aliases: ["ライブラリ", "らいぶらり", "パッケージ", "インストール", "いんすとーる", "入れる", "いれる"],
      group: G.run,
      icon: "terminal",
      title: () => "Python のライブラリを入れる",
      argHint: () => "名前（例：numpy）",
      preview: (arg) => (arg ? `→ ${arg} を入れる` : null),
      run: async (arg) => {
        const info = await runtimes.findPython().catch(() => ({ command: null, storeStub: false, source: "" }));
        const py = info.command ?? (d.os() === "windows" ? "py" : "python3");
        d.runInTerminal(`${d.os() === "windows" && py.startsWith('"') ? "& " : ""}${py} -m pip install ${arg}`);
      },
    },

    // ───── AI
    {
      name: "ai",
      aliases: ["聞く", "きく", "質問", "しつもん", "chat", "ask", "チャット", "相談", "そうだん", "kiku"],
      group: G.ai,
      icon: "spark",
      title: () => "AI に聞く",
      argHint: () => "聞きたいこと",
      desc: () => "/聞く for文の使い方 のように書くと、そのまま質問します",
      run: (arg) => (arg ? d.askAi(arg) : d.showView("ai")),
    },
    cmd("explain", ["説明", "せつめい", "解説", "かいせつ", "setsumei"], "ai.explain", G.ai, "spark", "選んだコードを日本語で説明"),
    cmd("comment", ["コメント", "こめんと", "注釈", "komento"], "ai.comment", G.ai, "spark", "選んだコードに日本語のコメントを付ける"),
    cmd("fix", ["直す", "なおす", "修正", "しゅうせい", "naosu", "バグ"], "ai.fix", G.ai, "spark", "選んだコードのまちがいを直す"),
    cmd("build", ["構築", "こうちく", "組み立て", "くみたて", "kouchiku", "日本語から"], "ai.build", G.ai, "wand", "日本語の手順からプログラムを組み立てる"),
    cmd("template", ["ひな形", "ひながた", "見本", "みほん"], "ai.buildTemplate", G.ai, "wand", "組み立て用のひな形を入れる"),
    cmd("lines", ["行の説明", "ぎょうのせつめい", "行説明", "explainlines"], "editor.toggleExplain", G.ai, "spark", "各行の右の説明を表示／非表示"),
    cmd("aion", ["AI切り替え", "AIオンオフ", "えーあい"], "ai.toggle", G.ai, "spark"),
    cmd("model", ["モデル", "もでる", "AI設定", "moderu"], "ai.settings", G.ai, "gear"),
    cmd("detect", ["AIを探す", "AIを見つける", "接続", "せつぞく", "つながらない"], "ai.detect", G.ai, "refresh"),

    // ───── 日本語・文字
    {
      name: "hankaku",
      aliases: ["半角", "はんかく", "zen2han", "全角を直す", "全角記号", "ぜんかくきごう"],
      group: G.jp,
      icon: "text",
      title: () => "全角の英数字・記号を半角に",
      desc: () => "範囲を選ばなければ、文字列とコメント以外の全角（（）：＝ 全角スペースなど）をまとめて直す",
      run: () => {
        if (!needDoc()) return;
        const sel = d.editor.getSelection();
        if (sel) return convert(zenToHan, "半角に")();
        const marks = commentSyntax(d.activeName() ?? "")?.[0];
        const { text, count } = fixZenkakuInCode(d.editor.getText(), marks ? [marks] : ["#", "//"]);
        if (!count) return toast("直す全角記号はありませんでした", "info");
        d.editor.applyText(text);
        toast(`全角の記号を ${count} か所、半角に直しました（Ctrl+Z で元に戻せます）`, "success");
      },
    },
    {
      name: "zenkaku",
      aliases: ["全角", "ぜんかく", "han2zen"],
      group: G.jp,
      icon: "text",
      title: () => "半角の英数字・記号を全角に",
      desc: () => "選んだ範囲",
      run: () => {
        if (!d.editor.getSelection()) return toast("全角にしたい範囲を選んでから使ってください", "info");
        convert(hanToZen, "全角に")();
      },
    },
    {
      name: "kana",
      aliases: ["半角カナ", "はんかくかな", "ｶﾅ", "かな"],
      group: G.jp,
      icon: "text",
      title: () => "半角カナ（ｶﾀｶﾅ）を全角に",
      run: convert(hanKanaToZen, "半角カナを全角に"),
    },
    { name: "katakana", aliases: ["カタカナ", "かたかな", "katakana"], group: G.jp, icon: "text", title: () => "ひらがな → カタカナ", desc: () => "選んだ範囲（なければ全体）", run: convert(hiraToKata, "カタカナに") },
    { name: "hiragana", aliases: ["ひらがな", "平仮名", "hiragana"], group: G.jp, icon: "text", title: () => "カタカナ → ひらがな", desc: () => "選んだ範囲（なければ全体）", run: convert(kataToHira, "ひらがなに") },
    {
      name: "count",
      aliases: ["文字数", "もじすう", "カウント", "かうんと", "mojisuu", "字数"],
      group: G.jp,
      icon: "text",
      title: () => "文字数を数える",
      desc: () => "選んだ範囲（なければファイル全体）",
      run: () => {
        if (!needDoc()) return;
        const sel = d.editor.getSelection();
        const c = countChars(sel || d.editor.getText());
        const rows: [string, string][] = [
          ["文字数", `${c.chars.toLocaleString()} 文字`],
          ["空白・改行を除く", `${c.charsNoSpace.toLocaleString()} 文字`],
          ["行数", `${c.lines.toLocaleString()} 行`],
          ["原稿用紙（400 字）", `約 ${c.manuscript} 枚`],
          ["バイト数（UTF-8）", `${c.bytesUtf8.toLocaleString()} バイト`],
        ];
        void choose(sel ? "選んだ範囲の文字数" : "ファイル全体の文字数", rows.map(([a, b]) => `${a}　${b}`).join("\n"), [{ label: "OK", value: true, kind: "primary" }], true);
      },
    },
    {
      name: "calc",
      aliases: ["計算", "けいさん", "keisan", "電卓", "でんたく", "="],
      group: G.jp,
      icon: "calc",
      title: () => "計算する",
      argHint: () => "式（例：1200*1.1）",
      desc: () => "全角の数字や × ÷ も使えます",
      expand: (arg) => {
        const v = calc(arg);
        if (v === null) return [];
        const s = String(v);
        return [
          { label: `= ${v.toLocaleString()}`, detail: "結果をコピー", run: () => navigator.clipboard?.writeText(s).then(() => toast(`${s} をコピーしました`, "success")) },
          { label: `= ${v.toLocaleString()} を入力`, detail: "カーソルの位置に入れる", run: () => insert(s) },
        ];
      },
      preview: (arg) => {
        const v = calc(arg);
        return v === null ? (arg ? "（計算できない式です）" : null) : `= ${v.toLocaleString()}`;
      },
      run: () => {},
    },
    {
      name: "zenkakucheck",
      aliases: ["全角チェック", "ぜんかくちぇっく", "全角の印", "全角表示"],
      group: G.jp,
      icon: "alert",
      title: () => "全角スペース・全角記号に印を付ける（切り替え）",
      run: () => {
        settings.set("editor.zenkaku", !settings.get("editor.zenkaku"));
        toast(settings.get("editor.zenkaku") ? "全角の印を表示します" : "全角の印を隠しました", "info");
      },
    },

    // ───── 入力・挿入
    {
      name: "date",
      aliases: ["日付", "ひづけ", "今日", "きょう", "hiduke", "hizuke", "today", "和暦", "われき", "令和", "日時"],
      group: G.insert,
      icon: "clock",
      title: () => "今日の日付を入れる",
      expand: () => dateFormats().map((f) => ({ label: f.text, detail: `日付を入れる（${f.label}）`, run: () => insert(f.text) })),
      run: () => insert(dateFormats()[0].text),
    },
    {
      name: "time",
      aliases: ["時刻", "じこく", "時間", "じかん", "今", "いま", "jikoku"],
      group: G.insert,
      icon: "clock",
      title: () => "今の時刻を入れる",
      run: () => insert(dateFormats().find((f) => f.label === "時刻")!.text),
    },
    {
      name: "header",
      aliases: ["ヘッダー", "へっだー", "見出し", "作成者", "さくせいしゃ", "提出", "ていしゅつ", "名前"],
      group: G.insert,
      icon: "file",
      title: () => "ファイルの先頭に「作成日・作成者・説明」を入れる",
      argHint: () => "作成者の名前（なくても可）",
      run: (arg) => {
        if (!needDoc()) return;
        const name = d.activeName() ?? "";
        const [start, end] = commentSyntax(name) ?? ["#", ""];
        const lines = [
          `ファイル名：${basename(name)}${languageOf(name) ? `（${languageOf(name)}）` : ""}`,
          `作成日：${dateFormats()[0].text}`,
          `作成者：${arg}`,
          "説明：",
        ];
        const text = end ? `${start}\n${lines.map((l) => `  ${l}`).join("\n")}\n${end.trim()}\n\n` : lines.map((l) => `${start} ${l}`).join("\n") + "\n\n";
        d.editor.goTo(1, 1);
        d.editor.insertText(text);
      },
    },
    {
      name: "uuid",
      aliases: ["ID", "ユーユーアイディー", "ランダムID"],
      group: G.insert,
      icon: "text",
      title: () => "UUID（重ならない ID）を入れる",
      run: () => insert(crypto.randomUUID()),
    },

    // ───── 表示
    cmd("focus", ["集中", "しゅうちゅう", "zen", "禅", "shuuchuu"], "view.zen", G.view, "sidebar"),
    cmd("fullscreen", ["全画面", "ぜんがめん", "フルスクリーン"], "view.fullscreen", G.view, "sidebar"),
    cmd("theme", ["テーマ", "てーま", "色", "いろ", "ダーク", "ライト", "te-ma"], "theme.select", G.view, "gear"),
    {
      name: "background",
      aliases: ["背景", "はいけい", "壁紙", "かべがみ", "haikei", "bg"],
      group: G.view,
      icon: "gear",
      title: () => "背景の色・画像を変える",
      run: () => d.openSettings("look"),
    },
    cmd("bigger", ["大きく", "おおきく", "拡大", "かくだい", "zoomin"], "view.zoomIn", G.view, "plus"),
    cmd("smaller", ["小さく", "ちいさく", "縮小", "しゅくしょう", "zoomout"], "view.zoomOut", G.view, "x"),
    cmd("wrap", ["折り返し", "おりかえし", "orikaeshi"], "editor.toggleWrap", G.view, "text"),
    cmd("sidebar", ["サイドバー", "さいどばー", "エクスプローラー"], "view.toggleSidebar", G.view, "sidebar"),
    cmd("preview", ["プレビュー", "ぷれびゅー", "markdown", "md", "html", "ページ"], "view.markdownPreview", G.view, "file"),
    cmd("menu", ["メニュー", "めにゅー"], "view.menu", G.view, "sidebar"),

    // ───── 設定
    {
      name: "settings",
      aliases: ["設定", "せってい", "settei", "オプション", "環境設定"],
      group: G.settings,
      icon: "gear",
      title: () => "設定を開く",
      command: "view.settings",
      expand: (arg) => {
        const sections: [string, string][] = [
          ["general", "全般"], ["look", "色と背景"], ["editor", "エディタ"], ["files", "保存とファイル"],
          ["ai", "AI"], ["build", "日本語から組み立て"], ["terminal", "ターミナル"], ["about", "情報"],
        ];
        return sections
          .filter(([, label]) => !arg || label.includes(arg) || zenToHan(arg).toLowerCase() === label.toLowerCase())
          .map(([id, label]) => ({ label: `設定：${label}`, detail: "/settings", run: () => d.openSettings(id) }));
      },
      run: () => d.openSettings(),
    },
    cmd("settings-export", ["設定の書き出し", "せっていのかきだし", "持ち運び", "もちはこび", "バックアップ", "backup"], "settings.export", G.settings, "file", "設定・グループ・自分の辞書・入力の登録をファイルに書き出す（ほかのパソコン用）"),
    cmd("settings-import", ["設定の読み込み", "せっていのよみこみ", "引き継ぎ", "ひきつぎ", "restore"], "settings.import", G.settings, "file", "書き出した設定ファイルを読み込む"),
    cmd("extensions", ["拡張機能", "かくちょう", "アドオン", "プラグイン", "kakuchou"], "view.extensions", G.settings, "puzzle"),
  );
}

/** エラーの説明を表示する（ボタンでその行へ移動・ライブラリを入れる・AI に聞く） */
export async function showErrorExplanation(
  e: import("../ai/errorExplain").ErrorExplanation | null,
  actions: { goTo: (file: string, line: number) => void; run: (cmd: string) => void; askAi: (q: string) => void; recent: string },
) {
  if (!e) {
    const ask = await choose(
      "エラーが見つかりませんでした",
      "ターミナルに、説明できるエラーが見つかりませんでした。\nAI に出力を見てもらうこともできます。",
      [
        { label: "閉じる", value: false, kind: "plain" },
        { label: "AI に聞く", value: true, kind: "primary" },
      ],
      false,
    );
    if (ask) actions.askAi(`次のターミナルの出力で何が起きているか、日本語でわかりやすく説明して、直し方を教えてください。\n\n\`\`\`\n${actions.recent.slice(-3000)}\n\`\`\``);
    return;
  }
  const where = e.file && e.line ? `\n\n場所：${basename(e.file)} の ${e.line} 行目` : "";
  type Act = "close" | "goto" | "run" | "ai" | "copy";
  const buttons: { label: string; value: Act; kind: "plain" | "primary" }[] = [
    { label: "閉じる", value: "close", kind: "plain" },
    { label: "エラー文をコピー", value: "copy", kind: "plain" },
  ];
  buttons.push({ label: "AI にくわしく聞く", value: "ai", kind: "plain" });
  if (e.command) buttons.push({ label: e.command.label, value: "run", kind: "primary" });
  if (e.file && e.line) buttons.push({ label: "その行へ移動", value: "goto", kind: e.command ? "plain" : "primary" });
  const act = await choose<Act>(`${e.kind}：何が起きた？`, `${e.what}\n\n直し方：${e.fix}${where}\n\n（元のメッセージ：${e.raw}）`, buttons, "close");
  if (act === "copy") {
    // Traceback から最後のエラーの行までをまとめてコピー
    const lines = actions.recent.split("\n");
    let end = lines.length - 1;
    while (end > 0 && !lines[end].includes(e.raw)) end--;
    let start = end;
    while (start > 0 && end - start < 40 && !/^Traceback/.test(lines[start])) start--;
    if (!/^Traceback/.test(lines[start] ?? "")) start = Math.max(0, end - 15);
    const text = lines.slice(start, end + 1).join("\n").trim() || e.raw;
    void navigator.clipboard?.writeText(text).then(() => toast("エラー文をコピーしました", "success"));
  } else if (act === "goto" && e.file && e.line) actions.goTo(e.file, e.line);
  else if (act === "run" && e.command) actions.run(e.command.run);
  else if (act === "ai") actions.askAi(`次のエラーの原因と直し方を、日本語でわかりやすく教えてください。\n\n\`\`\`\n${actions.recent.slice(-3000)}\n\`\`\``);
}

