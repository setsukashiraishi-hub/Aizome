// 使い方とヘルプ（/help）。左に項目、右に本文。上の検索欄で全部から探せる
import { h, clear } from "../core/dom";
import { commands, formatKey } from "../core/commands";
import { normalizeQuery } from "../core/jpText";
import { renderMarkdown } from "./markdown";
import { icon } from "./icons";
import { listSlash, slashNames } from "./slash";

interface Section {
  id: string;
  label: string;
  icon: string;
  body: () => string;
}

const k = (key: string) => `<kbd>${formatKey(key)}</kbd>`;

function slashTable(): string {
  const groups = new Map<string, ReturnType<typeof listSlash>>();
  for (const c of listSlash()) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group)!.push(c);
  }
  let md = "";
  for (const [group, list] of groups) {
    md += `\n### ${group}\n\n| 呼び出し方 | できること |\n|---|---|\n`;
    for (const c of list) {
      const names = slashNames(c)
        .slice(0, 4)
        .map((n) => `<a href="#slash:${encodeURIComponent(c.name)}">/${n}</a>`)
        .join(" ");
      const arg = c.argHint ? ` <span class="help-arg">${c.argHint()}</span>` : "";
      md += `| ${names}${arg} | ${c.title()}${c.desc ? `<br><span class="help-sub">${c.desc()}</span>` : ""} |\n`;
    }
  }
  return md;
}

function shortcutTable(): string {
  const rows = commands
    .list()
    .filter((c) => c.key)
    .map((c) => [commands.title(c), formatKey(c.key!)] as const)
    .sort((a, b) => a[0].localeCompare(b[0], "ja"));
  const editorKeys: [string, string][] = [
    ["候補の一覧を入力", "Tab"],
    ["AI の候補（薄い文字）を入力", "Tab をすばやく 2 回 / Alt+Enter"],
    ["一覧が出ていても AI の候補を確定", "Alt+Enter"],
    ["AI の候補を 1 語ずつ確定", "Ctrl+→ / Alt+→"],
    ["AI の候補を今すぐ出す", "Alt+\\"],
    ["候補を消す・一覧を閉じる", "Esc"],
    ["候補の一覧を出す", "Ctrl+Space"],
    ["実行中のプログラムを止める（ターミナル）", "Ctrl+C"],
  ];
  return (
    "| 操作 | キー |\n|---|---|\n" +
    [...editorKeys, ...rows].map(([a, b]) => `| ${a} | <kbd>${b}</kbd> |`).join("\n")
  );
}

function sections(): Section[] {
  return [
    {
      id: "start",
      label: "はじめに",
      icon: "help",
      body: () => `
# あいぞめへようこそ

ローカルの AI がコードの続きを考えてくれる、日本語で使いやすいコードエディタです。

## まずはこれだけ

1. **ファイルを作る・開く**：${k("Mod-N")} で新しいファイル、${k("Mod-O")} でフォルダを開きます。ファイルを画面にドラッグしても開けます。
2. **書く**：手を止めると、AI の候補が薄い文字で出ます。**Tab をすばやく 2 回** 押すと入力、**Esc** で消せます（設定で右 Shift や Tab 1 回にもできます）。
3. **実行する**：右上の「▶ 実行」か **F5**。下のターミナルに結果が出ます。
4. **困ったら**：上の検索欄（${k("Mod-P")}）で **/** を打つと、便利機能の一覧が出ます。**/help** でこの画面です。

## 何語のファイルかを決める

- 保存したファイルは、拡張子（.py・.cs・.cpp など）で決まります。
- 保存前の新しいファイルは、中身から推測します。わからないときは **Python**（設定 → 保存とファイル →「新しいファイルの言語」で変更可）。
- **1 行目に \`## py ##\` \`## C# ##\` \`## C++ ##\` \`## java ##\` のように書くと、その言語として扱い、「▶ 実行」もその言語で動きます**（保存していなくても、拡張子が違っても OK）。
- 下のステータスバーの言語名をクリックしても選べます。
- **保存するときは、この 1 行目（\`## py ##\` など）は取り除いて保存します**（普通のコメントはそのまま）。自動保存では取り除きません。

## 上の検索欄でできること

| 打つもの | できること |
|---|---|
| ファイル名の一部 | フォルダの中のファイルを開く |
| **/** | 便利機能の一覧（/保存、/日付、/計算、/エラー など） |
| **/help** | この使い方の画面 |
| **/辞書 並べ替え** | コード辞書から「やりたいこと」で探して、そのまま入れる |
| **>** | メニューにあるすべての操作を探す |

## コード辞書

左の 📖 ボタン（${k("Mod-Shift-D")}）で開きます。「並べ替え」「ファイル 読む」「ジャンプ」のように **やりたいことを日本語で** 探して、「入れる」を押すとコードが入ります。
入れたあとは **Tab** で、名前や値など書き換える場所へ順に移動できます。
Python・JavaScript・C#（Unity）・Go・C・C++・Java・HTML・CSS・シェルに対応していて、開いているファイルに合わせて自動で切り替わります。
辞書にないときは「AI に書き方を聞く」、よく使うコードはエディタで選んで ＋ を押すと「自分の辞書」に保存できます。

/ のあとは、英語・日本語・ひらがな・ローマ字のどれでも探せます。例：<a href="#slash:date">/日付</a>、/ひづけ、/hiduke はどれも同じです。
`,
    },
    {
      id: "slash",
      label: "/ 便利機能の一覧",
      icon: "wand",
      body: () => `
# / 便利機能の一覧

上の検索欄（${k("Mod-P")}）で **/** を打つと呼び出せます。名前をクリックしてもすぐ使えます。
後ろに言葉を書けるものもあります（例：**/計算 1200*1.1**、**/探す print**、**/聞く for文の使い方**、**/行 30**）。
${slashTable()}`,
    },
    {
      id: "ai",
      label: "AI 補完と AI 機能",
      icon: "spark",
      body: () => `
# AI 補完と AI 機能

## 薄い文字の候補（AI 補完）

- 入力を止めると、AI が続きを考えて薄い文字で見せます。**Tab をすばやく 2 回**（または **Alt+Enter**）で入力、**Ctrl+→** で 1 語ずつ、**Esc** で消します。Tab 1 回は候補の一覧と字下げです。右 Shift や Tab 1 回にしたいときは、設定 → エディタ の「AI の候補を入れるキー」で変えられます。
- Esc で消した候補は、同じ場所では出し直しません。
- 単語の途中（例：\`impo\`）では今の行だけ、新しい行の頭や \`:\` \`{\` の直後ではブロックの中身を数行だけ出します。
- **コメントで頼める**：\`# 1 から 10 までの合計を出す\` と書いて改行すると、その内容のコードを提案します。
- ファイルの拡張子から「何語のファイルか」を AI に伝えるので、Python・Go・JavaScript など言語に合った候補になります。

## 入力中の候補一覧

AI とは別に、打った文字で始まる名前の一覧が出ます。**Tab** で選んでいるものを入力（↑↓ で選ぶ）。
一覧が出ていても AI の候補を入れたいときは **Alt+Enter**。設定 → エディタ で Enter に変えたり、Ctrl+Space のときだけにしたりできます。

## 行の横の説明

各行の右に「← 「こんにちは」と表示します」のような説明が薄く出ます。よくある書き方はすぐに、ほかの行は手を止めたときに AI が説明します（✦ 印）。
${k("Mod-Alt-E")} か <a href="#slash:lines">/行の説明</a> で表示・非表示を切り替えます。

## そのほかの AI 機能

| 呼び出し方 | できること |
|---|---|
| <a href="#slash:ai">/聞く</a> | 横の AI チャットで質問する |
| <a href="#slash:explain">/説明</a> | 選んだコードを日本語で説明 |
| <a href="#slash:comment">/コメント</a> | 選んだコードに日本語のコメントを付ける |
| <a href="#slash:fix">/直す</a> | 選んだコードのまちがいを直す |
| <a href="#slash:error">/エラー</a> | ターミナルのエラーを日本語で解説 |
| <a href="#slash:build">/構築</a> | 日本語の手順からプログラムを組み立てる |

## AI の準備

- パソコンに Ollama が入っていれば、起動時に自動で見つけてつなぎます。USB メモリの中のモデルも探します。
- 見つからないときは、設定 → AI の「AI を探す」か、**.gguf** ファイルを画面にドラッグしてください。
- おすすめのモデル：\`qwen2.5-coder:1.5b\`（軽い）、\`qwen2.5-coder:7b\`（賢い・少し重い）。
`,
    },
    {
      id: "build",
      label: "日本語から組み立て",
      icon: "wand",
      body: () => `
# 日本語から組み立てる

\`###構築py###\` のような行の下に、やりたいことを日本語で箇条書きにして、行の横の **▶ 組み立てる** を押す（または ${k("Mod-Shift-Enter")}）と、AI がプログラムにします。

\`\`\`
###構築py###
空のリスト a を作る
1 から 10 まで繰り返す
  数を a に入れる
a の合計を表示する
\`\`\`

- \`py\` の部分を \`js\` \`go\` \`c\` などに変えると、その言語で作ります。
- <a href="#slash:template">/ひな形</a> で見本が入ります。
`,
    },
    {
      id: "run",
      label: "実行とターミナル",
      icon: "terminal",
      body: () => `
# 実行とターミナル

- **F5** か「▶ 実行」で、開いているファイルを実行します（Python・JavaScript・Go・C/C++・Java・Ruby など）。
- 終わると「--- 終了しました（終了コード 0）---」と出ます。**0 なら正常**、それ以外はエラーで終わっています。
- 実行中に止めるには ■（または Ctrl+C）。🔁 でもう一度実行。
- ターミナルはコマンドプロンプトのように使えます。▾ から PowerShell・cmd・Git Bash などを選べます。Windows では「/cmd」でコマンドプロンプト、「/powershell」で PowerShell をすぐ開けます。いつも開くものは、設定の「ターミナル」で選べます（プログラムの実行には、いつも PowerShell を使います）。
- プリントの「set HTTPS_PROXY=…」や「dir /?」はコマンドプロンプトの書き方です。PowerShell では「$env:HTTPS_PROXY="…"」のように書きます。
- 出力の \`ファイル名:行\` をクリックすると、その行へ移動します。

## 定義元へ飛ぶ・インデントをまとめて動かす

- 変数や関数の名前を **Shift+クリック**（または **F12**）すると、それを作った行（def・class・代入・for・import・引数など）へ飛びます。このファイルにないときは、開いているフォルダのほかのファイルから探します。
- for や if の行の字下げを変えると、行の右に「⇥ Tab：下の 3 行も一緒に動かす」と出ます。そこで **Tab** を押すと、もともとその中にあった行も同じだけ動いて、インデントが崩れません。

## 整形・関数の一覧

- **整形**（${k("Shift-Alt-F")}、<a href="#slash:format">/整形</a>）：字下げ・空白・空行をそろえます。black（Python）・gofmt・rustfmt・clang-format が入っていればそれを使い、なければあいぞめの中の簡単な整形を使います。↺ で元に戻せます。
- **関数の一覧**（左の ☰、<a href="#slash:outline">/関数の一覧</a>）：今のファイルのクラス・関数・メソッド・プロパティを並べ、クリックでその行へ。カーソルのある関数が光ります。${k("Mod-Shift-O")} で名前から選んで飛ぶこともできます。

## ファイルごとの実行・比べる

- ファイルの上の見出しに、そのファイル用の「行の右」の切り替え・**値を見る**・**▶ 実行** があります。左右に並べているときは、それぞれのがわで使えます。
- 実行はファイルごとに別のタブ（▷ ファイル名）で動くので、2 つのファイルを同時に実行できます。左右に並べた 2 つを両方実行すると、ターミナルも左右に並んで出力を比べられます。ターミナルの ◫ ボタンで、いつでも 2 つを並べられます。

## 比べる

- **2 つのファイル**：タブを右クリック →「ほかのファイルと比べる…」。開いているファイルか、ほかのファイル（先生の見本など）を選ぶと、消えた行を赤、増えた行を緑で左右に並べます。
- **前回の実行**：同じファイルを 2 回実行すると、${k("Mod-Alt-D")} かターミナルの 🕒 ボタンで、前回と今回の出力の違いを見られます。出力が変わったときは小さく知らせます（設定 → 機能のオン・オフ で止められます）。

## 元に戻す・やり直す

上の **↺**（元に戻す、${k("Mod-Z")}）と **↻**（やり直す、${k("Mod-Y")}）で、今のファイルの変更を 1 つずつ戻したり進めたりできます。手で打った文字だけでなく、日本語から組み立てた結果・AI の書き換え・置換・名前の一括変更・import の追加なども戻せます。保存したあとも、あいぞめを閉じるまでは何回でも戻れます。ボタンにマウスを乗せると、あと何回戻せるかが出ます。

## ビルド（実行ファイルを作る）

${k("Mod-Shift-B")}（<a href="#slash:build">/ビルド</a>）で、今のファイルの言語に合わせて作り方を選べます。できたものはファイルと同じ場所の **build** フォルダに入ります。

| 言語 | 作れるもの |
|---|---|
| Python | .exe（PyInstaller。初回は自動で入れます）／黒い画面を出さない .exe |
| Go | .exe・Mac 用・Linux 用 |
| C / C++ | ほかのパソコンでも動く .exe（-static）／デバッグ用 |
| Rust | .exe |
| C# | .NET のアプリ（Unity のスクリプトは Unity エディタでビルド） |
| Java | .jar／class ファイル |
| TypeScript | JavaScript に変換 |

Go・C/C++・Rust・C#・Java などを **▶ 実行** するときは、ビルドしたファイルを置かずに一時的な場所で作って動かします。必要な道具（go・gcc・dotnet など）がなければ、「入れる」で winget から入れられます。

## 書き出す（PDF・Word・HTML・テキスト）

${k("Mod-Alt-X")}（<a href="#slash:export">/書き出し</a>）か印刷（${k("Mod-Alt-P")}）で専用の画面が開き、右に出来上がりのプレビューがページごとに出ます。用紙（A4 など）・向き・文字の大きさ・行番号・色付き・見出し・ページ番号を選んで書き出せます。PDF は印刷の画面で送信先を「PDF に保存」にします。印刷（${k("Mod-Alt-P")}）も色付きになりました。

## 書きながらのエラー表示・import の付け忘れ

- かっこ・引用符の閉じ忘れ、if や for の行の「:」の付け忘れ、まだ作っていない名前（\`pirnt\` のようなタイプミス）に **波線** が出ます。入力中の行は、打ち終わるまで待ちます。
- 波線にマウスを乗せると、原因と直し方のボタン（「print に直す」「: を付ける」など）が出ます。**Ctrl+.** でカーソルの行をすぐ直せます。
- import していないもの（\`sqrt\`・\`randint\`・\`np\`・C# の \`List\`・\`SceneManager\`・\`TextMeshProUGUI\`・C の \`strlen\` など）を使うと、「from math import sqrt を上に追加」のように足せます。候補の一覧にも「＋ 〜 を追加」の項目が出て、選ぶと名前と import が一緒に入ります。
- 表は言語ごと（Python・Java・C#/Unity・C・C++・Go・Rust）に分かれていて、ほかの言語の import が混ざることはありません。
- Python は、入っている Python にコードを（実行せずに）読ませて、字下げ・文法のまちがいを Python と同じ判定で見つけます。input() のまま計算する・引数の数のまちがい・global 忘れ・self 忘れ・抜け出せない while True など、実行するとエラーになりそうな書き方も知らせます。
- C# / Java / C / C++ では、行の終わりの「;」忘れや \`if (x = 5)\` も知らせます。
- 設定 → 機能のオン・オフ で、それぞれ止められます。

## 名前の一括変更

変数や関数の名前にカーソルを置いて **F2**（<a href="#slash:rename">/名前の変更</a>）。新しい名前を入れると、このファイルの同じ名前がまとめて変わります（文字列やコメントの中、\`obj.名前\` の形は変えません）。

1 か所で変数の名前を書きかえると、「ほかの 3 か所の「score」も「points」に変えますか？」と聞きます。**Tab** でまとめて変え、**Esc** でそのままにします（文字列・コメントの中と obj.名前 は変えません。同じファイルの同じ名前はすべて変わります）。

## ブロックでつくる（Scratch のように）

上の帯の「ブロック」ボタン（または「/blocks」「/ブロック」）で、エディタとは別の画面が開きます。日本語のブロックをドラッグして組み立てると、右にプログラムができていきます。

- 上の「言語」で **Python・JavaScript・Go・C++・C#** から選べます。同じブロックのまま、言語だけ切りかえられます
- Go・C++・C# では、変数の型（int・double・string・リスト・辞書など）を、入れた値から自動で決めて書きます。割り算は Python と同じく小数で計算し、日本語の文字も 1 文字ずつ数えます
- ブロックの種類：表示と入力・変数・計算・文字・条件（if）・くり返し・リスト・辞書・関数・クラス・読み込み（import）・エラー処理（try）・ファイル・その他（待つ・pass・main・global・コードを直接書く）
- **実行**：できたプログラムを下のターミナルで動かします（入力もできます）
- **エディタで開く**：できたプログラムを、ふつうのエディタの新しいタブで開きます
- **保存・開く**：組み立てたブロックを「.aizblocks」のファイルにします。閉じても、次に開いたときは続きから始まります
- ブロックは右クリックでコピーや削除、Ctrl+Z で元に戻せます

## まとまりの線・「もし〇〇なら」

if・for・関数・クラス・try・with、複数行のリストや呼び出しが、どこまでかかっているかを、左に色つきの線（└）で示します。カーソルのあるまとまりは濃く・太く出ます。

| 色 | まとまり |
|---|---|
| だいだい | 条件（if・elif・else・match・case・switch） |
| 青 | くり返し（for・while） |
| むらさき | 関数（def・function） |
| 緑 | クラス |
| 赤 | try・except・finally |
| グレーの点線 | 複数行のリスト・辞書・呼び出し |

分岐（if・elif・else、try・except、case）の中にカーソルを置くと、それぞれの行の右に「もし score が 80 以上なら ↓」「そうでなく、もし score が 60 以上なら ↓」「どれでもないとき（…でもない） ↓」のように、どんなときにそこへ入るかを出します。

線・説明・名前の提案は、設定の「機能のオン・オフ」でそれぞれ止められます。

## 左右に並べる

タブを **右クリック** →「右に並べる」「左に並べる」「元に戻す（左へ）」「左右に並べるのをやめる」。${k("Mod-\\")} で今のファイルを右に並べます。右がわのタブには「右」、左がわには「左」の印が付き、クリックしたがわのファイルが「今のファイル」になります。右がわが空になると、自動で 1 画面に戻ります。左右の **境目をドラッグ** すると幅を変えられます（ダブルクリックで半分ずつ）。

## エクスプローラーの折りたたみ・幅

- エクスプローラーなどの右上の ◫ ボタン、または ${k("Mod-B")} で折りたたみ／開く。
- 境目をドラッグすると幅を変えられます。細くしすぎると **自動で折りたたまれ**、境目をもう一度右へ引っぱると開きます。

## コピー履歴

最近コピーした **10 個** を覚えています（ブラウザなど、あいぞめの外でコピーしたものも）。エディタを **右クリック** →「コピー履歴」から選ぶか、${k("Mod-Shift-H")}（<a href="#slash:clips">/コピー履歴</a>）で一覧から選ぶと、今のカーソルの位置（選んでいる所）に貼り付けます。右クリックのメニューでは 1〜9 のキーでも選べます。

## 入力の登録・実行時間・無限ループの見張り

- **入力の登録**（${k("Mod-Alt-I")}、<a href="#slash:inputs">/入力</a>）：input() に入れる値を 1 行に 1 つずつ登録しておくと、実行のたびに自動で入ります（「値を見る」でも使われます）。登録した分を使い切ると、ふつうに打てます。ステータスバーの「⌨ 入力 N 件」からも開けます。
- **実行時間**：終わると「--- 終了しました（0.42 秒）---」のように、かかった時間が出ます。
- **無限ループの見張り**：同じ出力が何百回も続いたり、設定した秒数を過ぎても終わらなかったりすると、ターミナルの上に「止まらないかもしれません」と出て、「■ 止める」で止められます。input() で入力を待っている間は知らせません。

## 保存記録の比較・設定の持ち運び

- 保存記録（エクスプローラーの下）の行にマウスを乗せて **「比べる」**：その時点と今の中身を左右に並べ、消えた行を赤、増えた行を緑で表示します。「左の版に戻す」で戻せます。
- **設定の持ち運び**（設定 → 全般、<a href="#slash:export">/書き出し</a>・<a href="#slash:import">/読み込み</a>）：設定・グループ・自分の辞書・入力の登録を 1 つのファイルに書き出し、ほかのパソコンで読み込めます。Python の場所など、そのパソコンだけの設定は持ち運びません。

## 行の右の表示を切り替える

ファイル名の右（パンくずの右端）の **「説明 ／ 値 ／ 自動判定 ／ なし」** で切り替えます（${k("Mod-Alt-V")} でも順に切り替え）。

| 表示 | 内容 |
|---|---|
| 説明 | 何をする行か（「こんにちはと表示します」など） |
| 値 | 「値を見る（F6）」で実行した結果。変数にマウスを乗せると、その行の時点の値 |
| 自動判定 | 行の説明に加えて、エラーになりそうな行に ⚠ と原因を薄く表示（説明より優先）。変数にマウスを乗せて少し待つと、その行の時点の値を小窓で表示（Python は裏で実際に計算した値） |
| なし | 何も出さない |

自動判定で変数にマウスを乗せたときの値は、確かなものから順に出します。小窓の下に、どこから出した値かを小さく書きます。

1. **前の実行**：前に「値を見る（F6）」で実行していれば、その記録（その実行のあとに書きかえていない所だけ。どの言語でも）
2. **実際に計算**：Python は、書きかえが止まって 1 秒たったら、裏で安全に動かして本当の値を出します（2 秒まで）。くり返しの中なら「1 → 3 → 6（3 回）」のように回ごとに出します
   - ファイル・OS・ネットにさわるコード（open・os・subprocess・socket など）は動かしません。使える import は math・random・re・string・collections・itertools・functools・statistics・datetime・json・fractions・decimal だけです
   - input() や sys.argv が出てきたら、その所で止めます。それより前の値は出し、あとの値は「入力しだいで変わります」と出します
   - print の出力は画面に出しません。random は毎回同じ値になるよう固定します
   - 本当にエラーになった行（0 で割ったなど）には「実行するとエラー」と出します
   - 止めたいときは、設定の「機能のオン・オフ」で切れます
3. それでも決まらないときだけ、上から順に計算した予想 → **AI の予想** → コードから読み取った見当 の順に出します。AI には実際に計算してわかった値を先に渡すので、AI はわからない所だけを考えます

## 値を見る（行ごとの変数の中身）

上の「👁 値を見る」か **F6**（<a href="#slash:values">/値</a>）で、プログラムを動かしながら **各行を実行したあとの変数の値** を記録し、行の右に表示します。

Python のほか、**JavaScript・TypeScript・Java・C#・C・C++・Go・Rust・Ruby・PHP・Lua・Kotlin（.kts）・Swift・Dart** でも使えます。Python 以外は、変数に値を入れる行のうしろに「値を記録する 1 文」を足したコピーを一時的な場所で動かして記録します（元のファイルは変わりません。ふつうの実行と同じ道具（gcc・go・java など）が必要です）。Python 以外では「戻り値」の表示と、値の予想の小窓の一部は使えません。Unity のスクリプトは Unity の中でしか動かないので使えません。

\`\`\`
a = []                  ▸ a = []
for i in range(10):     ▸ i = 0 → 1 → 2 → 3 → … → 9（10 回）
    a.append(i)         ▸ a = [0, 1, 2, … 9]（10 回目）
\`\`\`

- **ステップ表示**：**F7**（次の回）／**Shift+F7**（前の回）か、ファイル名の右の ◀ ▶ で、カーソルのある行が「何回目に動いた瞬間」かを選べます。すべての行がその瞬間の値になり、今の行は ▶ で強調、前に動いたときの値は薄く表示されます。「全体」で元に戻ります。
- **何重ものループ**：ステップ表示中は、ループごとに「i = 1（2 回目）」「j = 0（1 回目）」のように並び、それぞれの ◀ ▶ で外側・内側のループを別々に 1 回ずつ進められます。
- **ほかの行の値**：ステップ表示のまま別の行をクリックすると、その行が今の瞬間にいちばん近く動いた回に切り替わり、その行の具体的な値（と、その回に出した文字）が出ます。
- **戻り値**：ファイル名の右の切り替えで「戻り値」にすると、その行で呼んだ関数・メソッドが返した値を行の右に表示します（例：\`print(math.sin(i))\` の行に \`math.sin(i) → 0.0 → 0.8415 → …（10 回）\`）。print のように何も返さないものは出しません。ステップ表示と組み合わせると、その回の戻り値だけ。
- 値にマウスを乗せると、1 回目・2 回目…と回ごとの値が見えます。
- エラーが起きた行には ✖ とエラーの内容が出ます。
- input() もふつうに使えます（ターミナルで入力）。書き換えると表示は消えます。

## エラーが出たら

ターミナルの ⚠ ボタンか <a href="#slash:error">/エラー</a> で、最後のエラーを **日本語で** 説明します。
「その行へ移動」「ライブラリを入れる」「AI にくわしく聞く」もボタン一つです。

## Python のライブラリを入れる

<a href="#slash:pip">/pip numpy</a> のように書くと、ターミナルで入れます。
`,
    },
    {
      id: "japanese",
      label: "日本語の便利機能",
      icon: "text",
      body: () => `
# 日本語の便利機能

## 全角のまちがいを見つける・直す

日本語入力のまま \`（\` \`：\` \`＝\` や全角スペースを打つと、エラーになります。
あいぞめは、コードの中（文字列とコメント以外）の全角文字に **赤い波線**、全角スペースに **四角い印** を付けます。マウスを乗せると、どの文字かがわかります。

<a href="#slash:hankaku">/半角</a> で、文字列とコメント以外の全角記号をまとめて半角に直せます（範囲を選んでいれば、その範囲だけ）。

## 文字の変換

| 呼び出し方 | できること |
|---|---|
| <a href="#slash:hankaku">/半角</a> | 全角英数・記号 → 半角 |
| <a href="#slash:zenkaku">/全角</a> | 半角英数・記号 → 全角（選んだ範囲） |
| <a href="#slash:kana">/半角カナ</a> | ｶﾀｶﾅ → カタカナ |
| <a href="#slash:katakana">/カタカナ</a> ・ <a href="#slash:hiragana">/ひらがな</a> | ひらがな ⇄ カタカナ |
| <a href="#slash:count">/文字数</a> | 文字数・行数・原稿用紙の枚数 |

範囲を選ぶと、下のステータスバーにも選んだ文字数が出ます。

## 入力の手助け

| 呼び出し方 | できること |
|---|---|
| <a href="#slash:date">/日付</a> | 2026年10月22日（木）・令和・2026-10-22 などから選んで入力 |
| <a href="#slash:time">/時刻</a> | 今の時刻 |
| <a href="#slash:calc">/計算 1200*1.1</a> | 計算（全角数字や × ÷ も使える）。結果をコピーまたは入力 |
| <a href="#slash:header">/ヘッダー 名前</a> | 先頭に「ファイル名・作成日・作成者・説明」のコメント（課題の提出に便利） |
| <a href="#slash:todo">/やること</a> | TODO・FIXME の行の一覧から移動 |
`,
    },
    {
      id: "keys",
      label: "ショートカット",
      icon: "keyboard",
      body: () => `
# ショートカット

${shortcutTable()}
`,
    },
    {
      id: "faq",
      label: "困ったとき",
      icon: "alert",
      body: () => `
# 困ったとき

### 実行しても「Python」とだけ出て、結果が出ない
Python が入っていないときに Windows が用意している、Microsoft Store 案内用の仮の \`python\` が動いています。
実行すると入れ方を案内するので、「Python を入れる」を押してください。<a href="#slash:python">/python</a> で確かめられます。

### 「AI に接続できません」と出る
<a href="#slash:detect">/AIを探す</a> を試してください。Ollama が入っていなければ、設定 → AI から .gguf ファイルを選ぶこともできます。
会社や学校のネットワークでダウンロードできない場合は、USB メモリにモデルを入れて読み込めます。

### AI の候補が的外れ・長すぎる
小さいモデル（1.5b）は精度が低めです。できれば \`qwen2.5-coder:7b\` を使ってください。
コメントで「何をしたいか」を書いてから改行すると、意図に沿った候補になりやすくなります。

### ターミナルのエラーをコピーしたい
文字をドラッグで選んで **Ctrl+C**（選んでいないときの Ctrl+C は、実行中のプログラムを止めます）。**Ctrl+V** で貼り付け、**右クリック** でもコピー／貼り付けができます。
エラーの解説（⚠）の「エラー文をコピー」でも、エラーの部分をまとめてコピーできます。

### UnicodeDecodeError: 'utf-8' codec can't decode … と出る
読もうとしているファイルが Shift_JIS（Windows の日本語）です。\`open("ファイル", encoding="cp932")\` のように文字コードを指定すると確実です。
（あいぞめのターミナルの Python は、VS Code と同じく、指定がなければ Windows の既定の文字コードで読みます）

### 文字化けする
ターミナルは UTF-8 にしてあります。Python で古いファイルを読むときは \`open(…, encoding="cp932")\` を試してください。

### 全角の印がじゃま
<a href="#slash:zenkakucheck">/全角チェック</a> で表示・非表示を切り替えます。

### ウイルス対策ソフト（ノートンなど）が反応する
署名のない新しいソフトなので、反応することがあります。あいぞめのフォルダを除外に入れると落ち着きます。

### 更新したい
自動で新しい版を確かめ、左下に「更新があります」と出ます。<a href="#slash:update">/更新</a> でも確かめられます。インストールし直す必要はありません。
`,
    },
  ];
}

class HelpPage {
  private el: HTMLElement | null = null;
  private current = "start";
  private query = "";
  /** / の便利機能を実行する（ヘルプを閉じてから） */
  runSlash: (name: string) => void = () => {};

  get isOpen() {
    return !!this.el;
  }

  open(section?: string) {
    if (section) this.current = section;
    if (!this.el) {
      this.el = h("div", { class: "settings-page help-page", role: "dialog", "aria-label": "使い方とヘルプ" });
      this.el.addEventListener("click", (e) => {
        const a = (e.target as HTMLElement).closest("a");
        const href = a?.getAttribute("href") ?? "";
        if (href.startsWith("#slash:")) {
          e.preventDefault();
          const name = decodeURIComponent(href.slice(7));
          this.close();
          this.runSlash(name);
        } else if (href.startsWith("#")) e.preventDefault();
      });
      document.body.append(this.el);
      document.addEventListener("keydown", this.onKey, true);
    }
    this.render();
  }

  close() {
    this.el?.remove();
    this.el = null;
    this.query = "";
    document.removeEventListener("keydown", this.onKey, true);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".modal-backdrop, .palette-backdrop, .menu")) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  private render() {
    const el = this.el!;
    clear(el);
    const all = sections();
    const search = h("input", { class: "text-input set-search", type: "search", placeholder: "使い方を探す（例：エラー、日付、AI）", value: this.query, spellcheck: "false" });
    const content = h("div", { class: "set-content help-content" });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderContent(content, all);
      nav.querySelectorAll(".set-nav-item").forEach((b) => b.classList.toggle("active", !this.query && b.getAttribute("data-id") === this.current));
    });
    const nav = h(
      "nav",
      { class: "set-nav" },
      ...all.map((s) =>
        h(
          "button",
          {
            class: "set-nav-item" + (s.id === this.current && !this.query ? " active" : ""),
            type: "button",
            "data-id": s.id,
            onclick: () => {
              this.current = s.id;
              this.query = "";
              this.render();
            },
          },
          h("span", { html: icon(s.icon, 15) }),
          h("span", {}, s.label),
        ),
      ),
    );
    el.append(
      h(
        "div",
        { class: "set-side" },
        h("div", { class: "set-head" }, h("h2", {}, "使い方とヘルプ"), h("button", { class: "icon-btn", type: "button", title: "閉じる", "aria-label": "閉じる", html: icon("x", 16), onclick: () => this.close() })),
        search,
        nav,
      ),
      content,
    );
    this.renderContent(content, all);
    if (this.query) search.focus();
  }

  private renderContent(content: HTMLElement, all: Section[]) {
    clear(content);
    content.scrollTop = 0;
    const q = normalizeQuery(this.query.trim());
    if (!q) {
      const s = all.find((x) => x.id === this.current) ?? all[0];
      content.append(h("div", { class: "md-preview help-body" }, renderMarkdown(s.body())));
      return;
    }
    // 検索：見出しごとに分けて、言葉を含むところだけ見せる
    let hits = 0;
    for (const s of all) {
      const md = s.body();
      const parts = md.split(/\n(?=#{2,3} )/);
      const found = parts.filter((p) => normalizeQuery(p.replace(/<[^>]+>/g, "")).includes(q));
      if (!found.length) continue;
      hits += found.length;
      content.append(h("h2", { class: "set-group-title" }, s.label), h("div", { class: "md-preview help-body" }, renderMarkdown(found.join("\n"))));
    }
    if (!hits) content.append(h("p", { class: "set-empty" }, "見つかりませんでした。別の言葉で探すか、/聞く で AI に質問してみてください。"));
  }
}

export const helpPage = new HelpPage();
