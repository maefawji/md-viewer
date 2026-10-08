# MD Viewer

Dropbox に置いた Markdown（相対パスの画像つき）を iPhone で読むための Web アプリ。
サーバーは持たず、ブラウザが Dropbox API と直接やりとりする。ホスティング先には md も画像も置かない。

## できること
- 「Dropbox でログイン」（OAuth PKCE、リフレッシュトークンで再ログイン不要）
- フォルダ一覧、最近開いたもの、ホームフォルダ設定
- md を整形表示（表、コード、見出しリンク、front matter 非表示）
- 相対パスの画像、Obsidian 形式の `![[画像]]` / `[[ノート]]`、空白入りパス
- md 間のリンク移動、PDF などは Dropbox の一時リンクで開く
- 検索（Dropbox 検索 ＋ 保存済み本文の全文検索）
- オフライン: 開いたものは自動で保存。メニューの「まとめてオフライン保存」でホーム以下の md と参照画像を一括保存
- Dropbox Business のチームスペースにも対応

## Dropbox 側の準備（1回だけ）
1. https://www.dropbox.com/developers/apps で「Create app」→ Scoped access → Full Dropbox → 名前を付けて作成
2. Permissions タブで `files.metadata.read` と `files.content.read` にチェックして Submit
3. Settings タブで
   - OAuth 2 の Redirect URIs に公開 URL（例 `https://<user>.github.io/md-viewer/`）を追加
   - 「Allow public clients (Implicit Grant & PKCE)」を Allow
   - App key をコピー
4. App key は `config.js` に書くか、アプリの初回画面で入力する

## iPhone で使う
Safari で公開 URL を開いてログイン → 共有ボタン →「ホーム画面に追加」。
ホーム画面から開いたときにログイン後戻ってこない場合は、ログイン画面の「戻ってこない場合」からコード貼り付けでログインできる。

## ファイル
- `index.html` / `style.css` / `app.js` 本体
- `config.js` App key と最初に開くフォルダ
- `sw.js` アプリ本体のオフラインキャッシュ
- `vendor/` marked（MIT）、DOMPurify（Apache-2.0 / MPL-2.0）
