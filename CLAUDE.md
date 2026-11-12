# Aizome — 作業のきまり

開発の全体像・リリース手順・注意点は [DEVELOPMENT.md](DEVELOPMENT.md) にあります。作業の前に読んでください。

- ユーザーとのやりとり、コミットメッセージ、README、コード内のコメントは日本語で書く。むずかしい言葉は避け、やさしい言い方にする
- 画面の文字は `src/core/i18n.ts` の `ja` と `en` の両方に足す
- 変えたら `npm run typecheck` と（できれば）`cd src-tauri && cargo check` を通す
- 版を上げるときは version を 3 か所（package.json・src-tauri/tauri.conf.json・src-tauri/Cargo.toml）そろえ、README の版ごとの説明のいちばん上に追記し、コミットを `0.x.0: 要約` の形にする
- リリースの添付ファイルの名前（`Aizome_<版>_x64-setup.exe` など）はアプリ内の更新が探す名前なので変えない
- リリースしたことをユーザーに伝えるときは、Windows 版のダウンロードのリンク `https://github.com/setsukashiraishi-hub/Aizome/releases/download/v<版>/Aizome_<版>_x64-setup.exe` を貼る
- `debug/ghost` に push すると `debug/ghost-out` が上書きされる
