#!/usr/bin/env bash
# server/.env の CATWATCH_SECRET を読み込み、catwatch webhook に heartbeat を送って認証を確認する。
# 使い方:
#   ./check-catwatch.sh                                  # デフォルトURLに送信
#   ./check-catwatch.sh https://www.cetacea.jp/home/api/catwatch/event
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
URL="${1:-https://www.cetacea.jp/home/api/catwatch/event}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "エラー: $ENV_FILE が見つかりません（server/.env.example をコピーして作成してください）" >&2
  exit 1
fi

CATWATCH_SECRET="$(grep -E '^CATWATCH_SECRET=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"

if [[ -z "$CATWATCH_SECRET" ]]; then
  echo "エラー: $ENV_FILE に CATWATCH_SECRET が設定されていません" >&2
  exit 1
fi

echo "→ $URL に heartbeat を送信します..."
HTTP_STATUS=$(curl -sS -o /tmp/catwatch-check-body.$$ -w '%{http_code}' -X POST "$URL" \
  -H "Authorization: Bearer $CATWATCH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"type":"heartbeat"}')
BODY="$(cat /tmp/catwatch-check-body.$$)"
rm -f /tmp/catwatch-check-body.$$

echo "HTTPステータス: $HTTP_STATUS"
echo "レスポンス: $BODY"

if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "OK: 認証成功。ダッシュボードの「OrangePi」表示が緑になるはずです。"
  exit 0
elif [[ "$HTTP_STATUS" == "401" ]]; then
  echo "NG: 401 Unauthorized。EC2側(server/.env)とOrangePi側(~/CatPoopWatch/.env)のCATWATCH_SECRETが一致していません。" >&2
  exit 1
else
  echo "NG: 想定外のステータスです。pm2 logs homeutils-gateway でサーバー側のログを確認してください。" >&2
  exit 1
fi
