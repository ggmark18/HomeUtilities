# HOMESERVER.md — 太陽光発電モニタ制御プロジェクト向け基本情報

新規プロジェクト（太陽光発電コントローラーのモニタ制御）を、既存の HomeUtilities 基盤に
`server/features/solar/`（仮）として追加する前提でまとめた基本情報。詳細な追加手順は
[README.md](./README.md) の「4. 新機能の追加方法（太陽光発電など）」に既にこのユースケースを
想定した記載があるので、そちらも参照してください。

---

## 1. システム全体構成（既存パターン）

```
【自宅のローカルデバイス】                    【AWS EC2】                      【閲覧側】
OrangePi等（センサー/コントローラー制御）        Node.js (HomeUtilities server)    ブラウザ
  - Python常駐プロセス（systemd管理）    ─HTTP→   gateway.js (PM2, port 3000)  ←SSE─  Home Control
  - .env に EC2 側と共有するシークレット           server.js (worker, port 3001)         ダッシュボード
    を持ち、Bearer認証でPOST                       features/<feature>/routes.js
```

CatPoopWatch（猫トイレ監視）が同じ構成の先行実装。OrangePi側デバイス→EC2 Webhook→
ダッシュボードSSE配信、という流れをそのまま太陽光発電コントローラーにも適用できる。

---

## 2. EC2（HomeUtilitiesサーバー）

- **ホスト:** `ec2-user@54.178.201.84`（Ubuntu, Node.js 20.x, PM2）
- **公開ドメイン:** `https://www.cetacea.jp`（Apacheがリバースプロキシ）
- **デプロイ先パス:** `~/homeutils/`（≒ Apache設定上は `/home/homeutils/server/`）
- **デプロイ:**
  ```bash
  scp -r ./server/* ec2-user@54.178.201.84:~/homeutils/
  ssh ec2-user@54.178.201.84 "cd ~/homeutils && npm install"
  pm2 restart homeutils-gateway
  ```
- **常駐プロセス:** `gateway.js`（PM2名: `homeutils-gateway`、port 3000）が常時待機し、
  リクエストが来たら `server.js`（実体ワーカー、port 3001）を起動してプロキシする。
  ワーカーは1時間無通信で自動終了（EC2コスト削減のための設計）。太陽光発電は定期POSTで
  この前提が崩れる問題があったが、VPN（Tailscale）ハブ方式で解決済み。詳細は `SOLAR.md` §5.5。
- **PM2管理コマンド:** `pm2 logs homeutils-gateway` / `pm2 restart homeutils-gateway`

---

## 3. リポジトリ構成のパターン

```
HomeUtilities/server/
├── gateway.js
├── server.js                  # 各 features/ のルーターをマウントする薄いブートストラップ
├── features/
│   ├── bus/                   # 例: 専用画面を持つ機能（BusCheck方式）
│   ├── catwatch/               # 例: ダッシュボード組み込み型（CatPoopWatch方式）
│   └── solar/                  # ← 新規追加はこの形
│       └── routes.js
└── public/
    ├── bus/index.html
    ├── home/index.html          # Home Control ダッシュボード本体
    └── solar/index.html         # 専用画面を持つ場合のみ
```

新機能追加の2パターン（README.md 4章より）:
1. **専用画面を持つ機能**（BusCheck方式）: `/home/solar/` に静的UI、`/home/solar/api/*` にAPI
2. **Home Controlダッシュボードに組み込む機能**（CatPoopWatch方式）: `/home/api/solar/*` に
   APIのみを生やし、`server/public/home/index.html` にカードを追加

太陽光発電は「状態表示カードをHome Controlダッシュボードに追加する」形（②）が
README.md側で既に想定されている。

Apache側にも対応する `Alias` / `ProxyPass` ルールの追加が別途必要（本番のみ・手動作業。
BusCheck/CatPoopWatchのApache設定例をREADME.mdに掲載済み、同じ形で追加する）。

---

## 4. 認証・環境変数のパターン

デバイス→EC2のWebhook認証は共有シークレット＋Bearerトークン方式（CatPoopWatchの
`CATWATCH_SECRET`が前例）。太陽光発電コントローラーでも同様に:

- EC2側 `server/.env` に `SOLAR_SECRET=<openssl rand -hex 32で生成>` のような変数を追加
- デバイス側 `.env` に同じ値を設定し、`Authorization: Bearer <値>` ヘッダーで送信
- `server/features/solar/routes.js` 側で `authenticate` ミドルウェア（catwatchの実装を
  流用可）でチェック

`server/.env.example` に本番用テンプレートがあるので、新変数もそこに追記するとよい。

---

## 5. ローカルデバイス側の参考パターン（OrangePi/CatPoopWatch）

太陽光コントローラーが自宅内の常駐デバイス（Raspberry Pi等）から制御・監視する構成なら、
CatPoopWatchの以下のパターンがそのまま参考になる:

- systemdサービスとして常駐（例: `poop-detector.service`）
- Mac側から `deploy.sh` で `rsync` デプロイ（`--deps`でpip/npm再インストール、
  `--restart`でsystemd再起動、をオプションで分離）
- デバッグ用にローカルネットワーク越しのNFS read-onlyエクスポートを設定し、
  開発機（Mac）からデバイスの状態ファイル（画像・ログ等）を直接参照できるようにする
  （`/etc/exports` に `<path> 192.168.1.0/24(ro,sync,no_subtree_check,insecure)` を追加→
  `sudo exportfs -ra`）

既存のOrangePi（`mark@192.168.1.7`）に、別systemdサービス（`solar-bridge`）として相乗りさせる方針とした。
Tailscale経由でEC2から到達させ、ESP32とのリレー制御・状態取得を中継する。詳細は `SOLAR.md` §5.5。

---

## 6. 動作確認用コマンド

```bash
# サーバー全体のヘルスチェック
curl https://www.cetacea.jp/home/api/health

# （太陽光APIができたら、catwatchのstatus相当）
curl https://www.cetacea.jp/home/api/solar/status
```

---

## 7. 参照元

- 詳細は `/Users/mark/Develop/HomeUtilities/README.md`（特に1〜4章）、`DEVELOP.md`、`SETUP.md`
- 実装の一次ソース: `server/server.js`, `server/features/catwatch/routes.js`
  （Webhook受信・SSE配信・認証ミドルウェアの実装例として最も近い）
- ローカルデバイス側の一次ソース: `/Users/mark/Develop/CatPoopWatch/`
  （`deploy.sh`, `cleaner_control.py` のEC2連携部分）
