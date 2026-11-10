# 開発の引き継ぎメモ

Aizome（藍染）の開発を続ける人向けのメモです。使い方は [README.md](README.md)、拡張機能の作り方は [docs/EXTENSIONS.md](docs/EXTENSIONS.md) にあります。

## いまの置き場所

- 本体：https://github.com/setsukashiraishi-hub/Aizome
- ダウンロードページ：https://setsukashiraishi-hub.github.io/Aizome/
- 0.47.0 までは `zjybttvmpr-ux/aizome` で開発していました。0.48.0 でコミットの記録ごとこちらへ移しています。
- 0.47.0 以前のアプリは古いリポジトリの更新を見に行きます。そのため、0.48.0 以降が出ても自動では更新されません。使っている人には、新しいダウンロードページから一度入れ直してもらう必要があります。

## ブランチ

| ブランチ | 中身 |
|---|---|
| `main` | 本体。リリースはここから作る |
| `debug/ghost` | AI 補完（薄い文字）の画面テスト。`tests/ui/` と `.github/workflows/ghost-debug.yml` がある |
| `debug/ghost-out` | 上のテストの結果（スクリーンショットと `shots/out.txt`） |

`debug/ghost` に push すると「Ghost debug」ワークフローが動き、`debug/ghost-out` を新しい結果で **強制的に上書き** します。前の結果を残したいときは、先に別の名前のブランチにしておいてください。

## 開発の準備

必要なもの：Node.js 20 以上、Rust（stable）、[Tauri の OS 別の準備](https://v2.tauri.app/start/prerequisites/)。AI 補完を試すなら Ollama も入れます。

```bash
npm install
npm run app          # アプリとして起動（tauri dev）
npm run dev          # 画面だけブラウザで（Tauri の機能は動かない）
```

Windows でビルドするときは、先に PowerShell で `./scripts/fetch-conpty.ps1` を実行します。ConPTY を取ってくるスクリプトで、新しい ConPTY がないと Windows 10 で日本語が 2 回ずつ表示されます。

## どこに何があるか

- `src/` 画面側（TypeScript・CodeMirror 6・xterm.js）。くわしくは README の「フォルダ構成」
- `src/core/i18n.ts` 画面の文字。`ja` と `en` の両方にキーを足す（片方だけでも型チェックは通ってしまうので、足し忘れに注意）
- `src-tauri/src/` アプリ本体（Rust）。更新は `updater.rs`、ターミナルは `pty.rs`、AI との通信は `ai.rs`・`local_ai.rs`
- `public/extensions/` 組み込みの拡張機能
- `site/` ダウンロードページ（GitHub Pages で公開）
- `.github/workflows/`
  - `check.yml`：型チェックと `cargo check`（手動で実行）
  - `release.yml`：インストーラーを作ってリリースに載せる
  - `pages.yml`：ダウンロードページの公開

## 自動判定の値（マウスを乗せたとき）の仕組み

| ファイル | 役目 |
|---|---|
| `src/editor/hoverValue.ts` | 出す値を決める順番（前の実行 → 実際に計算 → simulate → AI → 見当）。CodeMirror に頼らないので node から試せる |
| `src/editor/realValues.ts` | F6 の記録をタブごとに覚える・書きかえていない行の対応・記録から「その行の時点の値」を探す |
| `src/run/sandbox.ts` | Python を裏で安全に動かす（`TRACER_PY` を使う）。危ない import・open などは動かさず、input() で止める |
| `src/editor/knownValues.ts` | AI に聞く前にわかっている値を集める（AI へのヒントと、食いちがう答えの直しに使う） |

裏で動かす部分は「自分のコードで、うっかりファイルを消したり書いたりしない」ためのものです。わざと抜けようとするコードを完全に止めるものではありません。

## 変えたら確かめること

```bash
npm run typecheck
cd src-tauri && cargo check
```

手元に Rust の環境がなければ、Actions の「Check」→ Run workflow で同じ確認ができます（3〜4 分）。

## 新しい版を出す手順

1. バージョンを 3 か所で上げる：`package.json`・`src-tauri/tauri.conf.json`・`src-tauri/Cargo.toml`
2. README の「### 0.47.0：…」が並んでいる所の **いちばん上** に、新しい版の見出しと変更点を足す
3. コミットのメッセージは、いままでどおり `0.49.0: 日本語の要約` の形にする
4. main に push し、Actions の「Check」が通るのを確かめる
5. 次のどちらかでリリースを作る（Windows・Mac・Linux あわせて 10〜30 分）
   - `git tag v0.49.0 && git push origin v0.49.0`
   - Actions の「Release」→ Run workflow（タグはリリースのときに自動で作られる）
6. リリースに次のファイルがそろっているか確かめる。アプリ内の更新はこの名前で探すので、名前が変わると更新できなくなる
   - `Aizome_<版>_x64-setup.exe`（Windows）
   - `Aizome_universal.app.tar.gz`（Mac）
   - `Aizome_<版>_amd64.AppImage`（Linux）

ダウンロードページは最新のリリースを自動で読むので、作り直す必要はありません。

## リポジトリの場所や名前を変えるとき

次の 3 か所を書きかえます。

- `src-tauri/src/updater.rs` の `REPO`
- `src/ui/settingsPage.ts` のダウンロードページの URL
- `site/index.html` の `<meta name="aizome-repo">`

あわせて README の先頭にあるリンクも直します。

## 気をつけること・残っていること

- 配布版には電子署名が入っていないため、初回は Windows や Mac で確認画面が出ます。
- `package-lock.json` と `Cargo.lock` をコミットしていません。ビルドのたびに依存パッケージの最新版が入るので、急に壊れたらまずここを疑ってください。
- Actions に「Node.js 20 は非推奨」「ubuntu-latest が Ubuntu 26 に移る」という注意が出ています。いまは動いていますが、いつか `actions/checkout` などの版を上げる必要があります。
