# HomeUtilities 開発ガイド

ローカル環境での開発・動作確認手順をまとめます。

---

## 前提条件

- Node.js 20.x 以上
- npm 10.x 以上
- Even Hub CLI（プラグインシミュレーター用）

```bash
node -v   # v20.x.x
npm -v    # 10.x.x
evenhub --version
```

---

## 環境変数による開発・本番の切り替え

ソースコードを変更せず、`.env` ファイルだけで開発・本番を切り替えます。

### ファイル構成

| ファイル | コミット | 用途 |
|---|---|---|
| `plugin/.env` | ✅ | Vite が全モードで読み込むベース値。現状は本番URL・認証情報が入っている |
| `plugin/.env.development` | ✅ | `npm run dev` 実行時に `.env` を上書きする開発用デフォルト（localhost・認証なし） |
| `server/.env.example` | ✅ | サーバー設定テンプレート |
| `server/.env` | ❌ | サーバー実際の値（ローカル・EC2それぞれに配置） |

> ⚠️ `plugin/.env` は Git にコミットされていますが、実際の本番パスワードが入っています。`.gitignore` の想定（`.env.*.local` のみ除外）と噛み合っていないため、認証情報を扱う場合は `plugin/.env.production.local` のような `.local` サフィックス付きファイルに移し、`plugin/.env` 側はプレースホルダーにすることを検討してください。

### プラグイン（Vite）

`plugin/.env.development`（開発用・コミット済み）:
```env
VITE_API_BASE=http://localhost:3000/home/bus
VITE_AUTH_USER=
VITE_AUTH_PASS=
```

`plugin/.env`（ベース値。現状は本番URL・認証情報）:
```env
VITE_API_BASE=https://www.cetacea.jp/home/bus
VITE_AUTH_USER=YOUR_USERNAME
VITE_AUTH_PASS=YOUR_PASSWORD
```

Vite は `npm run dev`（development モード）実行時に `.env` → `.env.development` の順で読み込み、後者が同名キーを上書きします。`npm run build`（production モード）は `.env` のみを読み込むため、`.env` の値がそのままビルドに使われます。

### Web画面（index.html）

`server/.env`（ローカル開発用）:
```env
AUTH_USER=
AUTH_PASS=
```

サーバーが起動時に `.env` を読み込み、`GET /home/bus/api/config` エンドポイントで認証情報を動的生成します。`index.html` はこれを `fetch` で取得するため、ソースコードの変更は不要です。

EC2本番環境では `server/.env.example` をコピーして値を設定します：
```bash
cp .env.example .env
nano .env   # 実際の値を入力
pm2 restart buscheck-gateway
```

---

## 1. サーバーをローカルで起動

```bash
cd server
npm install   # 初回のみ（dotenv 等を含む）
node server.js
```

起動確認：
```bash
# ヘルスチェック（機能共通）
curl http://localhost:3000/home/api/health

# バス情報の取得（スクレイピングが走るため数秒かかる）
curl http://localhost:3000/home/bus/api/bus | python3 -m json.tool

# スクレイピング生データの確認（セレクタ調整時に使用）
curl http://localhost:3000/home/bus/api/debug | python3 -m json.tool

# 猫トイレ監視の状態確認
curl http://localhost:3000/home/api/catwatch/status
```

> `server.js` を直接起動するとポート3000で動作します（gateway不要）。  
> EC2本番環境では `gateway.js` を経由しますが、ローカル開発では不要です。

---

## 2. プラグインをシミュレーターで動かす

ターミナルを2つ開いて実行します。

**ターミナル1 — Vite 開発サーバー:**
```bash
cd plugin
npm install   # 初回のみ
npm run dev
# → http://localhost:5173 で起動（.env を自動読み込み）
```

**ターミナル2 — グラスシミュレーター:**
```bash
cd plugin
npx evenhub-simulator
# → シミュレーターウィンドウが起動
```

シミュレーターが起動したら Vite の URL（`http://localhost:5173`）を接続先として指定します。

### デバッグ（Safari Web Inspector）

シミュレーターの WebView ログは Chrome ではなく **Safari** で確認します：

1. Safari → 開発メニュー → シミュレーターの WebView を選択
2. コンソールタブで `[buscheck]` プレフィックスのログを確認

---

## 3. Web画面をローカルで確認

サーバーが起動している状態でブラウザからアクセス：

```
http://localhost:3000/home/bus/     # BusCheck
http://localhost:3000/home/control/ # Home Control ダッシュボード
```

`server/.env` の `AUTH_USER` が空の場合、認証ヘッダーなしで動作します。

---

## 4. プラグインのビルドと実機テスト

`plugin/.env.production.local` に本番の値を設定した上でビルドします：

```bash
cd plugin
npm run build
# → .env.production.local を読み込んで dist/ にビルド
```

**QRサイドロード（実機確認）:**
```bash
evenhub sideload dist
# QRコードが表示される → スマートフォンの Even Realities App でスキャン
```

**パッケージング（配布用）:**
```bash
npm run pack
# → plugin/buscheck.ehpk が生成される
```

---

## 5. APIエンドポイント一覧

| エンドポイント | 説明 |
|---|---|
| `GET /home/bus/` | BusCheck Web画面（index.html） |
| `GET /home/bus/api/config` | 認証設定（環境変数から動的生成） |
| `GET /home/bus/api/bus` | 次のバス一覧（60秒キャッシュ） |
| `GET /home/bus/api/bus?refresh=1` | 強制再取得（キャッシュ無視） |
| `GET /home/bus/api/debug` | スクレイピング生データ（セレクタ調整用） |
| `GET /home/control/` | Home Control ダッシュボード（index.html） |
| `POST /home/api/catwatch/event` | OrangePi からのイベント受信（Bearer認証） |
| `GET /home/api/catwatch/status` | 猫トイレ監視の現在状態 |
| `GET /home/api/catwatch/stream` | SSE リアルタイムストリーム |
| `GET /home/api/health` | サーバー全体の状態確認（機能共通） |

---

## 6. スクレイパーの調整

バス情報が正しく取れない場合は `/home/bus/api/debug` で HTML 構造を確認します：

```bash
curl http://localhost:3000/home/bus/api/debug | python3 -m json.tool
```

確認ポイント：

| フィールド | 内容 |
|---|---|
| `debug.centerBoxHtml.children` | `div.center_box` の直下子要素の構造 |
| `debug.rawBuses` | `page.evaluate` が返した生データ |
| `debug.bodyPreview` | ページ全体のテキスト先頭500文字 |
| `buses` | 最終的に整形されたバスデータ |

`buses` が空の場合は `server/features/bus/scraper.js` の `page.evaluate` 内のセレクタを調整してください。

---

## 7. ファイル構成と役割

各機能は `server/features/<feature>/`（サーバーロジック）と `server/public/<feature>/`（静的UI）に対称的に分離されています。新機能を追加する際はこのパターンに従ってください（詳細は README.md の「新機能の追加方法」を参照）。

```
HomeUtilities/
├── plugin/
│   ├── .env                   # ベース値（コミット済み・現状は本番URL/認証情報）
│   ├── .env.development       # 開発用デフォルト（コミット済み・npm run dev で .env を上書き）
│   ├── src/
│   │   └── main.ts            # Even Hub プラグイン本体
│   │                          # import.meta.env で環境変数を参照
│   └── app.json               # パッケージ設定・ネットワーク許可リスト
└── server/
    ├── .env                   # 実際の値（gitignore対象）
    ├── .env.example           # 設定テンプレート（コミット済み）
    ├── gateway.js             # 常駐プロセス（本番用・ポート3000）。ワーカー（server.js）を起動
    ├── server.js              # ワーカー本体（ポート3001 or 3000）
    │                          # dotenv で .env を読み込み、各 features/ のルーターをマウントする薄いブートストラップ
    ├── features/
    │   ├── bus/
    │   │   ├── routes.js      # BusCheck API（/home/bus/api/*）。/config・/bus・/debug
    │   │   └── scraper.js     # Puppeteer スクレイパー
    │   └── catwatch/
    │       └── routes.js      # CatPoopWatch API（/home/api/catwatch/*）。SSE・Webhook受信
    └── public/
        ├── bus/
        │   └── index.html     # スマートフォン用Web画面（/home/bus/）
        │                      # fetch('api/config') で認証情報を取得
        └── home/
            └── index.html     # Home Control ダッシュボード（/home/control/）
```
