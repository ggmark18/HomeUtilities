'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

const busRouter = require('./features/bus/routes');
const catwatchRouter = require('./features/catwatch/routes');

const app = express();
const publicDir = path.join(__dirname, 'public');

// ゲートウェイ経由で起動された場合はポート3001、単独起動は3000
const IS_WORKER = process.env.BUSCHECK_WORKER === '1';
const PORT = process.env.PORT || (IS_WORKER ? 3001 : 3000);

// アイドルタイムアウト設定（1時間）
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
let lastRequestTime = Date.now();

// アイドルチェック（1分ごとに確認）
const idleTimer = setInterval(() => {
  const idleMs = Date.now() - lastRequestTime;
  if (idleMs >= IDLE_TIMEOUT_MS) {
    console.log(`[worker] ${Math.round(idleMs / 60000)}分間リクエストなし → 終了します`);
    clearInterval(idleTimer);
    process.exit(0);
  }
}, 60_000);
idleTimer.unref(); // プロセス終了を妨げない

// リクエストログ＋最終リクエスト時刻の更新
app.use((req, res, next) => {
  lastRequestTime = Date.now();
  const ts = new Date().toLocaleTimeString('ja-JP');
  const mode = IS_WORKER ? 'worker' : 'standalone';
  console.log(`[${ts}][${mode}] ${req.method} ${req.path}`);
  next();
});

// CORS — Even Hub WebViewからのアクセスを許可
// BEHIND_APACHE=true の場合は Apache が CORS ヘッダーを付与するので省略
if (!process.env.BEHIND_APACHE) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.use(express.json());

// ルート → バス画面へリダイレクト（スタンドアロン確認用。本番は Apache がドメイン直下を別サイトとして扱う）
app.get('/', (req, res) => res.redirect('/home/bus/'));

// ── HomeUtilities: 機能ごとに server/features/<name>/ ・ server/public/<name>/ で管理 ──
// 各機能は自分のURL配下に閉じる:
//   静的UIを持つ機能    → /home/<feature>/          + /home/<feature>/api/*
//   API のみの機能      → /home/api/<feature>/*
// 新機能（太陽光発電など）を追加する際は同じパターンで features/ 配下にフォルダを追加する。

// BusCheck: /home/bus/*
app.use('/home/bus', express.static(path.join(publicDir, 'bus')));
app.use('/home/bus/api', busRouter);

// CatPoopWatch: /home/api/catwatch/*（Home Control ダッシュボードの1コンポーネント）
app.use('/home/api/catwatch', catwatchRouter);

// Home Control ダッシュボード: /home/control/*
app.use('/home/control', express.static(path.join(publicDir, 'home')));

// アプリシェル: /home/app/*（BusとCatをiframeで内包し、iOSホーム画面アプリとして
// トップレベル遷移なしに切り替える。ホーム画面に追加するのはこのURL）
app.use('/home/app', express.static(path.join(publicDir, 'app')));

/**
 * GET /home/api/health
 * サーバー全体のヘルスチェック（ゲートウェイのワーカー起動確認にも使用）
 */
app.get('/home/api/health', (req, res) => {
  const idleSec  = Math.round((Date.now() - lastRequestTime) / 1000);
  const remainSec = Math.max(0, Math.round((IDLE_TIMEOUT_MS - (Date.now() - lastRequestTime)) / 1000));
  res.json({
    status: 'ok',
    mode: IS_WORKER ? 'worker' : 'standalone',
    uptime: Math.round(process.uptime()) + 's',
    idleSince: idleSec + 's',
    shutdownIn: remainSec + 's',
  });
});

app.listen(PORT, () => {
  console.log(`HomeUtilities server listening on port ${PORT}`);
  console.log(`  GET  /home/bus/              - BusCheck 画面`);
  console.log(`  GET  /home/bus/api/bus       - 次のバス一覧`);
  console.log(`  GET  /home/control           - Home Control ダッシュボード`);
  console.log(`  GET  /home/api/catwatch/*    - CatPoopWatch API`);
  console.log(`  GET  /home/api/health        - ヘルスチェック`);
});
