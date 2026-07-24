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
  www.cetacea.jp/home/control  ─ ホームダッシュボード
  www.cetacea.jp/home/bus/     ─ バス運行情報
```

---

## 機能一覧

| 機能 | 説明 | アクセス先 |
|---|---|---|
| **BusCheck** | 東洋バス運行情報（Even G2 / Web） | `/home/bus/` |
| **CatPoopWatch** | 猫トイレ監視・LINE通知 | OrangePi 常駐 |
| **Home Control** | ホームダッシュボード（猫トイレ状態） | `/home/control` |

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
        └── home/
            └── control.html     # ホームダッシュボード（/home/control）

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

ATOM Cam で猫トイレを監視し、糞を検知したら LINE に通知するシステム。OrangePi 上で常駐動作する。

### システム構成

```
ATOM Cam (RTSP: 192.168.1.21:8554)
    ↓ ffmpeg（20秒ごとにスナップショット取得）
poop_detector.py（背景差分で糞を検知）
    ↓ MQTT (192.168.1.7:1883)
cleaner_control.py（LINE 通知 + DEEBOT 停止試行）
    ↓ HTTP POST Webhook
EC2 Node.js（ダッシュボードへ状態反映）
```

### 検知ロジック

1. 20秒ごとに ATOM Cam から静止画を取得
2. ROI（猫トイレ領域）を切り出して背景差分を計算
3. 3回連続で差分を検知したら「確定」→ アラート発火
4. 糞を取り除くと3回連続クリーン検知で自動リセット
5. 1時間ごとに背景画像を自動更新（アラート未検出時のみ）

### MQTT トピック

| トピック | 方向 | 内容 |
|---|---|---|
| `alert/cat_poop` | detector → control | 糞検知アラート |
| `control/cat_poop_reset` | control → detector | 清掃完了・リセット |

### Webhook イベント（EC2 へ送信）

| イベント | タイミング |
|---|---|
| `detection_alert` | 糞検知確定時 |
| `cleanup_detected` | 清掃完了自動検知時 |
| `heartbeat` | 20秒ごと（死活監視） |

### 前提条件（OrangePi）

- Mosquitto インストール・起動済み
- `ffmpeg` インストール済み
- ATOM Cam に atomcam_tools インストール済み・RTSP 有効化済み
- Python 3.11 以上

### OrangePi セットアップ

```bash
cd ~/CatPoopWatch
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

`.env` ファイルを作成:

```
LINE_CHANNEL_TOKEN=your_line_channel_token
ECOVACS_ACCOUNT=your_ecovacs_email
ECOVACS_PASSWORD=your_ecovacs_password
CATWATCH_WEBHOOK_URL=https://www.cetacea.jp/home/api/catwatch/event
CATWATCH_SECRET=your_secret_token
```

### デプロイ（Mac → OrangePi）

```bash
# 初回・更新時
rsync -av --exclude='venv' --exclude='__pycache__' \
  ~/Develop/CatPoopWatch/ mark@192.168.1.7:~/CatPoopWatch/

# サービス再起動
ssh mark@192.168.1.7 "sudo systemctl restart poop-detector cleaner-control"
```

### systemd サービス登録

```bash
sudo nano /etc/systemd/system/poop-detector.service
```

```ini
[Unit]
Description=Cat Poop Detector
After=network.target mosquitto.service

[Service]
User=mark
WorkingDirectory=/home/mark/CatPoopWatch
EnvironmentFile=/home/mark/CatPoopWatch/.env
ExecStart=/home/mark/CatPoopWatch/venv/bin/python poop_detector.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo nano /etc/systemd/system/cleaner-control.service
```

```ini
[Unit]
Description=Cat Poop Cleaner Control
After=network.target mosquitto.service

[Service]
User=mark
WorkingDirectory=/home/mark/CatPoopWatch
EnvironmentFile=/home/mark/CatPoopWatch/.env
ExecStart=/home/mark/CatPoopWatch/venv/bin/python cleaner_control.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable poop-detector cleaner-control
sudo systemctl start poop-detector cleaner-control
```

### ログ確認

```bash
sudo journalctl -u poop-detector -f
sudo journalctl -u cleaner-control -f
```

### 手動テスト（MQTT アラート送信）

```bash
mosquitto_pub -h 192.168.1.7 -p 1883 -t "alert/cat_poop" -m "detected"
```

### DEEBOT 自動制御について

> **2026年7月時点で、日本では ECOVACS API による DEEBOT 制御は不可能。** 以下の手段をすべて試みたが失敗：
> - `get_ecovacs_token.py`: メール送信 API がエラー（code 0002）
> - `sucks` ライブラリ: Pearl は XMPP 非対応
> - `deebot-client 3.0.2`: アプリバージョン古すぎ（code 1013）
> - `deebot-client 6.0.2`: `/user/login` エンドポイントが日本で封鎖
>
> 糞検知時の LINE 通知は正常に動作するため、DEEBOT の停止は ECOVACS HOME アプリから手動で行うこと。日本で API が開放された際に備え、DEEBOT 制御コードはそのまま残してある。

---

## 3. Home Control ダッシュボード

`www.cetacea.jp/home/control` で猫トイレの状態をリアルタイムに確認できる Web ダッシュボード。

### API エンドポイント

| エンドポイント | 説明 |
|---|---|
| `POST /home/api/catwatch/event` | OrangePi からのイベント受信（Bearer 認証） |
| `GET /home/api/catwatch/status` | 現在の状態取得 |
| `GET /home/api/catwatch/stream` | SSE リアルタイムストリーム |

### Apache 設定（Home Control）

```apache
# Home Control（認証なし・家族向け）
ProxyPass        /home/api/ http://localhost:3000/home/api/
ProxyPassReverse /home/api/ http://localhost:3000/home/api/

Alias /home /home/homeutils/server/public/home
<Directory /home/homeutils/server/public/home>
    Require all granted
</Directory>
```

### EC2 環境変数（`server/.env`）

```
AUTH_USER=your_username
AUTH_PASS=your_password
BEHIND_APACHE=true
CATWATCH_SECRET=your_secret_token  # OrangePi の .env と同じ値
```

---

## 4. 新機能の追加方法（太陽光発電など）

自宅の状態をレポート・制御する新機能は、以下のパターンで `server/features/<feature>/` に追加します。

1. `server/features/<feature>/routes.js` に Express の `Router` を作成し、必要なロジック（センサー取得・API呼び出しなど）を同じフォルダ内に置く（例: `scraper.js`, `client.js`）。
2. 専用の Web 画面が必要な場合は `server/public/<feature>/index.html` を作成する。
3. `server/server.js` で以下のいずれかのパターンでマウントする。
   - **専用画面を持つ機能**（BusCheck 方式）: `/home/<feature>/` に静的UI、`/home/<feature>/api/*` にAPI
   - **Home Control ダッシュボードに組み込む機能**（CatPoopWatch 方式）: `/home/api/<feature>/*` にAPIのみを生やし、`control.html` にカードを追加
4. Apache 側にも対応するルール（`Alias` / `ProxyPass`）を追加する（本番のみ・手動作業）。

太陽光発電の状態表示は、既存の `control.html` に新しいカードを追加する形（Home Control ダッシュボード方式）が想定されています。

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
