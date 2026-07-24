# BusCheck セットアップ手順

## システム構成

```
Even G2 グラス
    ↕ Bluetooth
スマートフォン（Even Hub WebView）
    ↕ HTTP（Wi-Fi / モバイルデータ）
AWS EC2（BusCheckサーバー）
    ↕ Puppeteer（Headless Chrome）
東洋バス bus-navigation.jp
```

---

## 1. EC2サーバーのセットアップ

### 1-1. 必要パッケージのインストール（Amazon Linux 2 / Ubuntu）

**Amazon Linux 2 の場合:**
```bash
# Node.js 20.x
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Chromium（Puppeteerが使う）
sudo yum install -y chromium

# PM2（プロセス管理）
sudo npm install -g pm2
```

**Ubuntu 22.04 の場合:**
```bash
# Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Chromium と依存ライブラリ
sudo apt-get install -y chromium-browser \
  libgbm-dev libasound2 libxss1 libxtst6 \
  libxrandr2 libxcomposite1 libxdamage1 libxfixes3

# PM2
sudo npm install -g pm2
```

### 1-2. サーバーコードをデプロイ

```bash
# EC2上で
mkdir -p ~/buscheck
cd ~/buscheck

# serverディレクトリの内容を転送（ローカルから）
# scp -r ./server/* ec2-user@YOUR_EC2_IP:~/buscheck/

npm install
```

### 1-3. EC2のセキュリティグループ設定

AWSコンソール → EC2 → セキュリティグループ → インバウンドルールに追加:
- タイプ: カスタムTCP
- ポート: 3000
- ソース: 0.0.0.0/0（またはスマートフォンのIPに絞る）

### 1-4. PM2でゲートウェイを起動・常駐化

```bash
cd ~/buscheck
# 常駐させるのはgateway.jsのみ（軽量）
# server.js（Puppeteer）はリクエスト時に自動起動 → 1時間で自動終了
pm2 start gateway.js --name homeutils-gateway
pm2 startup        # 再起動時の自動起動設定（表示されたコマンドを実行）
pm2 save           # 設定を保存
```

### 1-5. 動作確認

```bash
# ゲートウェイが起動しているか
pm2 status

# バス情報が取得できるか（初回はワーカー起動のため数秒かかる）
curl http://localhost:3000/home/api/health
curl http://localhost:3000/home/bus/api/bus

# 外部から確認（ローカルPCで）
curl http://YOUR_EC2_IP:3000/home/api/health
```

---

## 2. プラグインの接続先設定

`plugin/src/main.ts` はソースコードに URL を直書きせず、`import.meta.env.VITE_API_BASE` を参照します。接続先の変更は以下の `.env` ファイルで行ってください（詳細は `DEVELOP.md` 参照）。

**`plugin/.env`（ベース値・本番用）:**
```env
VITE_API_BASE=https://YOUR_DOMAIN/home/bus
VITE_AUTH_USER=YOUR_USERNAME
VITE_AUTH_PASS=YOUR_PASSWORD
```

**`plugin/app.json` のwhitelist:**
```json
"whitelist": [
  "https://YOUR_DOMAIN"   // ← 変更
]
```

---

## 3. Even Hub プラグインのビルドと実行

### ローカル開発（シミュレーター）

```bash
cd plugin
npm install
npm run dev          # Viteサーバー起動（localhost:5173）
npm run simulator    # 別ターミナルで、グラスシミュレーターを起動
```

### 実機テスト（QRサイドロード）

```bash
cd plugin
npm run build
evenhub sideload dist  # QRコードが表示される → Even Realities Appでスキャン
```

### パッケージング（配布用）

```bash
cd plugin
npm run build
npm run pack         # buscheck.ehpk が生成される
# → Even Hub Portalにアップロード
```

---

## 4. 操作方法

| 操作 | 動作 |
|---|---|
| アプリ起動 | 自動でバス情報を取得・表示 |
| シングルプレス（G2 or R1） | バス情報を再取得（キャッシュ使用） |
| ダブルプレス（G2 or R1） | バス情報を強制再取得（最新） |
| スワイプ上下（G2 or R1） | 画面スクロール |
| バックグラウンド移動 | 自動更新を停止 |
| フォアグラウンド復帰 | 自動でバス情報を再取得 |

自動更新: 60秒ごとに自動でバス情報を更新します。

---

## 5. スクレイパーのデバッグ・調整

初回デプロイ後、バス情報が正しく取れない場合は `/home/bus/api/debug` で生データを確認します:

```bash
curl http://YOUR_EC2_IP:3000/home/bus/api/debug | python3 -m json.tool
```

`debug.bodyPreview` に東洋バスサイトのテキストが入っているはずです。
セレクタが合っていない場合は `server/features/bus/scraper.js` の `page.evaluate` 内のセレクタを調整してください。

---

## 6. PM2 管理コマンド

```bash
pm2 logs homeutils-gateway      # ログ確認
pm2 restart homeutils-gateway   # 再起動
pm2 stop homeutils-gateway      # 停止
pm2 delete homeutils-gateway    # 削除
```
