# Yurinoki Home Utilities

ゆりのき台の自宅環境向けホームオートメーションシステム。バスの運行情報確認と猫トイレ監視の2つの機能を統合したプラットフォームです。

---

## システム全体構成

```
【自宅 OrangePi】
  poop_detector.py   ─ ATOM Cam を監視 → 糞検知
  cleaner_control.py ─ LINE 通知 + DEEBOT 停止
        ↓ HTTP POST (Webhook)
【AWS EC2】
  Node.js (HomeUtilities サーバー)
        ↓ SSE
【ブラウザ / Even G2 グラス / スマートフォン】
  www.cetacea.jp/home/control/ ─ ホームダッシュボード
  www.cetacea.jp/home/bus/     ─ バス運行情報
  www.cetacea.jp/home/app/     ─ 上記2つをiframeで内包するシェル（iOSホーム画面用）
```

---

## 機能一覧

| 機能 | 説明 | アクセス先 |
|---|---|---|
| **BusCheck** | 東洋バス運行情報（Even G2 / Web） | `/home/bus/` |
| **CatPoopWatch** | 猫トイレ監視・LINE通知 | OrangePi 常駐 |
| **Home Control** | ホームダッシュボード（猫トイレ状態） | `/home/control/` |
| **App Shell** | Bus/Catをiframeで内包（iOSホーム画面追加用） | `/home/app/` |

新しい自宅状態レポート機能（太陽光発電など）を追加する際は、下記「リポジトリ構成」のパターンに従って `server/features/<feature>/` を追加してください。

---

## リポジトリ構成

各機能は `server/features/<feature>/`（ロジック）と、静的UIを持つ機能は `server/public/<feature>/` にも対称的に分離されています。

```
HomeUtilities/
├── plugin/                     # Even Hub プラグイン（Vite + TypeScript）
│   ├── src/main.ts
│   └── app.json
└── server/                     # EC2 Node.js サーバー
    ├── gateway.js               # 常駐プロセス（ポート3000）。全機能を内包するワーカーを起動
    ├── server.js                # ワーカー本体（ポート3001）。各 features/ のルーターをマウントする薄いブートストラップ
    ├── features/
    │   ├── bus/
    │   │   ├── routes.js        # BusCheck API（/home/bus/api/*）
    │   │   └── scraper.js       # 東洋バスサイトスクレイパー
    │   └── catwatch/
    │       └── routes.js        # CatPoopWatch API（/home/api/catwatch/*。SSE・Webhook受信）
    └── public/
        ├── bus/
        │   └── index.html       # バス情報 Web 画面（/home/bus/）
        ├── home/
        │   └── index.html       # ホームダッシュボード（/home/control/）
        └── app/
            └── index.html       # App Shell（/home/app/。上記2つをiframeで内包）

CatPoopWatch/                 # OrangePi 上で動作
    ├── poop_detector.py      # カメラ監視・糞検知
    ├── cleaner_control.py    # LINE通知・DEEBOT制御
    ├── get_ecovacs_token.py  # ECOVACS トークン取得（初回のみ）
    ├── get_group_id.py       # LINE グループID取得用
    ├── requirements.txt
    └── .env                  # 環境変数（Git 管理外）
```

---

## 1. BusCheck

東洋バス「ゆりのき台第三 → 八千代中央駅」の次のバス時刻・遅延情報・停留所通過状況を、Even G2 グラスの HUD とスマートフォン Web 画面で確認できます。

### 特徴

- **Even G2 グラス表示** — 次のバスの予定時刻・予測時刻・残り分数・停留所通過情報を HUD に表示
- **スマートフォン Web 画面** — ブラウザからいつでも確認。30秒ごとに自動更新
- **オンデマンド起動** — スクレイパーサーバーはリクエスト時のみ起動し、1時間無通信で自動終了（EC2 コスト削減）
- **Basic 認証** — Apache の Basic 認証でアクセスを保護

### API エンドポイント

| エンドポイント | 説明 |
|---|---|
| `GET /home/bus/api/bus` | 次のバス一覧 |
| `GET /home/bus/api/debug` | スクレイピング生データ（調整用） |
| `GET /home/api/health` | サーバー全体のヘルスチェック（機能共通） |

### EC2 セットアップ

```bash
# Node.js 20.x インストール（Ubuntu）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs chromium-browser \
  libgbm-dev libasound2 libxss1 libxtst6 libxrandr2 libxcomposite1 libxdamage1 libxfixes3

# PM2 インストール
sudo npm install -g pm2

# デプロイ
scp -r ./server/* ec2-user@54.178.201.84:~/homeutils/
ssh ec2-user@54.178.201.84 "cd ~/homeutils && npm install"

# 起動・常駐化
pm2 start gateway.js --name homeutils-gateway
pm2 startup && pm2 save
```

### Apache 設定（BusCheck）

> **既存のEC2環境からの移行時のみ:** 旧構成（`Alias /bus`, `ProxyPass /bus/api/`）を使っている場合、本設定に置き換えた上で `pm2 restart homeutils-gateway` してください。`/bus/api/` 系のルールは `/home/api/` 系より前（より具体的な位置）に書く必要があります。

```apache
# Basic 認証
<Location /home/bus/>
    AuthType Basic
    AuthName "BusCheck"
    AuthUserFile /etc/apache2/.htpasswd
    <LimitExcept OPTIONS>
        Require valid-user
    </LimitExcept>
</Location>

# 静的ファイル
Alias /home/bus /home/homeutils/server/public/bus
<Directory /home/homeutils/server/public/bus>
    Require all granted
</Directory>

# API プロキシ（プレフィックスを剥がさず、そのまま /home/bus/api/ で転送）
ProxyPass        /home/bus/api/ http://localhost:3000/home/bus/api/
ProxyPassReverse /home/bus/api/ http://localhost:3000/home/bus/api/
```

### Even Hub プラグイン ビルド

```bash
cd plugin
npm install
npm run build   # dist/ を生成
npm run pack    # buscheck.ehpk を生成
```

[https://hub.evenrealities.com/hub](https://hub.evenrealities.com/hub) に `buscheck.ehpk` をアップロードしてインストール。

### 操作方法（Even G2）

| 操作 | 動作 |
|---|---|
| シングルプレス | バス情報を再取得 |
| ダブルプレス | 強制再取得（最新） |

自動更新: **15秒**ごと

---

## 2. CatPoopWatch

猫トイレ監視・LINE通知の検知ロジックや OrangePi 上のセットアップは別リポジトリ [CatPoopWatch](../CatPoopWatch) で管理する。ここでは HomeUtilities 側が受け持つ、監視結果の受信・ダッシュボード表示部分のみ記載する。

### システム構成

```
OrangePi（CatPoopWatch: poop_detector.py / cleaner_control.py）
    ↓ HTTP POST Webhook
EC2 Node.js（HomeUtilities: /home/api/catwatch/*）
    ↓ SSE
Home Control ダッシュボード
```

### Webhook イベント（EC2 が受信）

| イベント | タイミング |
|---|---|
| `detection_alert` | 糞検知確定時 |
| `cleanup_detected` | 清掃完了自動検知時 |
| `heartbeat` | 20秒ごと（死活監視） |
| `startup_reset` | プロセス起動直後に1回（再起動でプロセス内の検知状態が失われるため、ダッシュボードを明示的に同期） |

### 認証

OrangePi からの `POST /home/api/catwatch/event` は `CATWATCH_SECRET` による Bearer 認証で保護されている。OrangePi 側（CatPoopWatch リポジトリの `.env`）の `CATWATCH_WEBHOOK_URL` / `CATWATCH_SECRET` と、EC2 側 `server/.env` の `CATWATCH_SECRET` が一致している必要がある。

### 検知レビュー（学習データの振り分け）

誤検知が学習データに混入するのを防ぐため、`training_data/pending/` に溜まった検知画像をダッシュボードから確認し、「✅ 糞でした」「❌ 誤検知」を選んで振り分けられる（`/home/control/review/`）。

```
poop_detector.py (検知確定時)
    ↓ POST /home/api/catwatch/detections（画像アップロード、Bearer認証）
EC2: server/data/catwatch/ に一時保存（label='pending'）
    ↓
ダッシュボード（/home/control/review/）で ✅/❌ を選択
    ↓ POST /home/api/catwatch/detections/:id/label
EC2側のレコードを更新（label='poop'|'no_poop', synced=false）
    ↓
cleaner_control.py が30秒ごとにポーリング
    ↓ GET /home/api/catwatch/detections/unsynced（Bearer認証）
training_data/pending/ の該当ファイルを poop/ or no_poop/ へ移動
    ↓ POST /home/api/catwatch/detections/:id/ack（Bearer認証）
EC2側の画像を削除（training_data/がOrangePi側の恒久保存先のため）
```

OrangePiは自宅NAT内にあり外部から直接到達できないため、EC2→OrangePiの通信は行わず、常にOrangePi側が起点（push/poll）になる設計にしてある。

---

## 3. Home Control ダッシュボード

`www.cetacea.jp/home/control` で猫トイレの状態をリアルタイムに確認できる Web ダッシュボード。

### API エンドポイント

| エンドポイント | 説明 |
|---|---|
| `POST /home/api/catwatch/event` | OrangePi からのイベント受信（Bearer 認証） |
| `GET /home/api/catwatch/status` | 現在の状態取得 |
| `GET /home/api/catwatch/stream` | SSE リアルタイムストリーム |
| `POST /home/api/catwatch/detections` | OrangePi からの検知画像アップロード（Bearer 認証） |
| `GET /home/api/catwatch/detections` | レビュー一覧取得（`?label=pending`等） |
| `GET /home/api/catwatch/detections/:id/image` | 検知画像の取得 |
| `POST /home/api/catwatch/detections/:id/label` | ダッシュボードからの振り分け（`poop` / `no_poop`） |
| `GET /home/api/catwatch/detections/unsynced` | OrangePi からの未同期ラベル取得（Bearer 認証） |
| `POST /home/api/catwatch/detections/:id/ack` | OrangePi からの反映完了報告（Bearer 認証） |

### Apache 設定（Home Control）

BusCheck（`/home/bus`）と全く同じ形にしてあります。`/home/control` を静的ディレクトリとして直接 `Alias` するため、Node を経由しない分レイテンシも小さく、`Alias /home` のような広いパスとの前後関係を気にする必要もありません（BusCheck 同様、ページ本体は静的配信、API のみ Node にプロキシ）。

```apache
# 静的ファイル（BusCheckと同じパターン）
Alias /home/control /home/homeutils/server/public/home
<Directory /home/homeutils/server/public/home>
    Require all granted
</Directory>

# API プロキシ（catwatch。BusCheckのapiプロキシと対称）
ProxyPass        /home/api/ http://localhost:3000/home/api/
ProxyPassReverse /home/api/ http://localhost:3000/home/api/
```

> **旧構成（`Alias /home` + `ProxyPass /home/control`）からの移行時:** 上記に置き換えた上で `sudo apachectl configtest && sudo systemctl reload apache2` してください。`Alias /home`（汎用）はもう不要です。

### EC2 環境変数（`server/.env`）

```
AUTH_USER=your_username
AUTH_PASS=your_password
BEHIND_APACHE=true
CATWATCH_SECRET=your_secret_token  # OrangePi の .env と同じ値
```

### CATWATCH_SECRET の設定手順

OrangePi → EC2 の Webhook（`POST /home/api/catwatch/event`）を認証するための共有シークレット。**EC2側とOrangePi側で全く同じ値**にする必要があり、片方だけ設定/変更すると OrangePi からのイベントが全て `401 Unauthorized` になり、ダッシュボードが「OrangePi: 未受信」のままになる。

1. ランダムなシークレットを1つ生成する。
   ```bash
   openssl rand -hex 32
   ```
2. **EC2側**: `server/.env`（`server/.env.example` をコピーして作成、Git管理外）に設定する。
   ```
   CATWATCH_SECRET=<生成した値>
   ```
   反映のためワーカーを再起動する。
   ```bash
   pm2 restart homeutils-gateway
   ```
3. **OrangePi側**: `~/CatPoopWatch/.env` に**同じ値**を設定する。
   ```
   CATWATCH_WEBHOOK_URL=https://www.cetacea.jp/home/api/catwatch/event
   CATWATCH_SECRET=<EC2と同じ値>
   ```
   反映のためサービスを再起動する。
   ```bash
   ssh mark@192.168.1.7 "sudo systemctl restart poop-detector cleaner-control"
   ```
4. EC2側で直接叩いて認証が通ることを確認する。
   ```bash
   curl -i -X POST https://www.cetacea.jp/home/api/catwatch/event \
     -H "Authorization: Bearer <EC2の.envに設定した値>" \
     -H "Content-Type: application/json" \
     -d '{"type":"heartbeat"}'
   ```
   `{"ok":true}` が返り、ダッシュボードの「OrangePi」表示が緑（生存中）に変われば設定は正しい。`401 Unauthorized` が返る場合は EC2側の値が未設定・不一致。

> **注意:** `CATWATCH_SECRET` が未設定の場合、`authenticate` ミドルウェアは認証をスキップする（`server/features/catwatch/routes.js:25`、開発用の抜け道）。本番では必ず設定すること。

---

## 3.5 App Shell（iOSホーム画面用）

`www.cetacea.jp/home/app/` は BusCheck と Home Control を `<iframe>` で内包し、ヘッダー/フッターのボタンで切り替えるだけの薄いシェルページ（`server/public/app/index.html`）。

### なぜ必要か

iOS Safari の「ホーム画面に追加」で standalone 表示（ブラウザUIなし）にするには `apple-mobile-web-app-capable` を全ページに設定すればよいと思われがちだが、**トップレベルのページ遷移が発生した時点でSafariのブラウザUIが復帰してしまう**という制約があり、meta タグだけでは防げない。`/home/bus/` と `/home/control/` の間を通常の `<a href>` で行き来する限りこの問題は避けられないため、両方を最初から `<iframe>` で読み込んでおき、切り替えは表示/非表示の切り替えだけ（トップレベル遷移ゼロ）で行う。

- `/home/bus/` ・ `/home/control/` は直接アクセスもでき、単独でも今まで通り動作する（それぞれのページ内にも切り替えナビが付いているが、`/home/app/` の iframe 内で開かれている場合は `window.self !== window.top` を見て自動的に隠れる）。
- **ホーム画面に追加するのは `/home/app/` の方。** `/home/bus/` や `/home/control/` を直接追加すると、この問題が再発する。

### Apache 設定（App Shell）

BusCheck・Home Control と同じ静的Aliasパターン。

```apache
Alias /home/app /home/homeutils/server/public/app
<Directory /home/homeutils/server/public/app>
    Require all granted
</Directory>
```

### Apache 設定（Solar）

太陽光発電（2026-08-27〜、ダッシュボード組み込み型から専用画面に変更。SOLAR.md §5.8参照）。
他の専用画面と同じ静的Aliasパターン。`/home/api/solar/*` は既存の `ProxyPass /home/api/` で
既にカバーされているため、新規のProxyPass設定は不要。

```apache
Alias /home/solar /home/homeutils/server/public/solar
<Directory /home/homeutils/server/public/solar>
    Require all granted
</Directory>
```

---

## 4. 新機能の追加方法（太陽光発電など）

自宅の状態をレポート・制御する新機能は、以下のパターンで `server/features/<feature>/` に追加します。

1. `server/features/<feature>/routes.js` に Express の `Router` を作成し、必要なロジック（センサー取得・API呼び出しなど）を同じフォルダ内に置く（例: `scraper.js`, `client.js`）。
2. 専用の Web 画面が必要な場合は `server/public/<feature>/index.html` を作成する。
3. `server/server.js` で以下のいずれかのパターンでマウントする。
   - **専用画面を持つ機能**（BusCheck 方式）: `/home/<feature>/` に静的UI、`/home/<feature>/api/*` にAPI
   - **Home Control ダッシュボードに組み込む機能**（CatPoopWatch 方式）: `/home/api/<feature>/*` にAPIのみを生やし、`server/public/home/index.html` にカードを追加
4. Apache 側にも対応するルール（`Alias` / `ProxyPass`）を追加する（本番のみ・手動作業）。

太陽光発電の状態表示は、既存の `server/public/home/index.html` に新しいカードを追加する形（Home Control ダッシュボード方式）が想定されています。

---

## 共通デバッグコマンド

```bash
# PM2 管理
pm2 logs homeutils-gateway
pm2 restart homeutils-gateway

# バス API 確認
curl -u USER:PASS https://www.cetacea.jp/home/bus/api/bus
curl https://www.cetacea.jp/home/api/health

# CatPoopWatch 状態確認
curl https://www.cetacea.jp/home/api/catwatch/status
```
