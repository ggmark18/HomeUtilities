# CLAUDE.md — HomeUtilities

ゆりのき台の自宅向けホームオートメーション基盤。EC2上のNode.js（Express）サーバーが
自宅デバイスからのイベントを受け、ブラウザにSSEで配信する。

## ドキュメントの読み方

| ファイル | 内容 |
|---|---|
| `README.md` | 全体構成・機能一覧・Apache設定・**新機能の追加方法（§4）** |
| `DEVELOP.md` | ローカル開発手順・環境変数・APIエンドポイント一覧 |
| `SETUP.md` | 初期セットアップ |
| `HOMESERVER.md` | 太陽光発電プロジェクト向けのEC2/構成まとめ |
| `SOLAR.md` | **☀️ 太陽光発電機能の作業状況と残タスク（現在進行中）** |

作業を始める前に、対象機能のドキュメントと一次ソース（`server/features/<name>/routes.js`）を読むこと。

## アーキテクチャの原則

- **機能ごとに `server/features/<name>/`（ロジック）と `server/public/<name>/`（静的UI）に分離する。**
  新機能は既存機能をコピーせず、同じ形で新しいフォルダを作る。
- **マウントの2パターン**（README §4）
  - 専用画面を持つ機能（bus・solar方式）: `/home/<feature>/` に静的UI + `/home/<feature>/api/*`
  - ダッシュボード組み込み型（catwatch方式）: `/home/api/<feature>/*` のAPIのみ生やし、
    `server/public/home/index.html` にカードを追加する
  - 各画面には共通の`.app-switch`ナビ（Bus/Cat/Solar）を置き、`/home/app/`のiOSアプリシェルからは
    iframeタブとして内包する。新しく専用画面を追加する際は、既存の全画面（bus/home/solar）の
    ナビにも新タブへのリンクを追加すること（2026-08-27〜、solarを組み込み型から専用画面化した際の教訓）
- **自宅デバイスはNAT内にあり、EC2から到達できない。** 通信は常にデバイス側が起点（push/poll）。
  EC2からデバイスへ接続しにいく設計にはしないこと。
  **例外**: 自宅側デバイス（OrangePi等）が自発的に張るVPNトンネル（Tailscale等）は許容する
  （ホームルーターのポート開放やEC2発の非トンネル接続は引き続き禁止。トンネル確立自体が
  デバイス起点であればよい）。トンネル経由で公開するサービスはVPNインターフェースにのみbindし、
  ACLで到達範囲を絞ること。実例は `SOLAR.md` §5.5（OrangePiのsolar-bridge）。
- **デバイス→EC2の認証は共有シークレット + Bearer。** `<FEATURE>_SECRET` を `server/.env` に置き、
  未設定時は認証をスキップする（開発用の抜け道。本番では必ず設定）。
- **`/home/api/` は既にApacheでプロキシ済み。** ダッシュボード組み込み型の新機能を足すとき、
  Apache設定の追加は不要。専用画面を持つ場合のみ `Alias` の追加が要る（本番・手動）。

## 開発コマンド

```bash
cd server && npm install     # 初回のみ
node server.js               # ポート3000で単独起動（gateway不要）

curl localhost:3000/home/api/health
open http://localhost:3000/home/control/    # Home Control ダッシュボード
```

## デプロイ（本番・手動）

```bash
scp -r ./server/* ec2-user@54.178.201.84:~/homeutils/
ssh ec2-user@54.178.201.84 "cd ~/homeutils && npm install"
pm2 restart homeutils-gateway
```

## 注意

- `server/.env` はGit管理外。値を変えたら `pm2 restart homeutils-gateway` が要る。
- `gateway.js` のワーカーは**1時間無通信で自動終了する**（EC2コスト削減のため）。
  定期POSTを受ける機能を足すとこの前提が崩れるので、影響を確認すること
  （太陽光発電はVPNハブ方式で解決済み。`SOLAR.md` §5.5 参照）。
- `plugin/.env` は本番パスワードが入ったままコミットされている（`DEVELOP.md` に警告あり）。
