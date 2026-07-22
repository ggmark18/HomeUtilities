'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const { scrapeBusInfo } = require('./scraper');

const catwatchRouter = require('./routes/catwatch');

const app = express();

// スマホ用ウェブUI（public/index.html）
const publicDir = path.join(__dirname, 'public');

// 認証設定を返す API（Apache の ProxyPass /bus/api/ 経由でアクセスされる）
app.get('/api/config', (req, res) => {
  const user = process.env.AUTH_USER || '';
  const pass = process.env.AUTH_PASS || '';
  const header = user
    ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    : '';
  res.set('Cache-Control', 'no-store');
  res.json({ auth: header });
});

app.use(express.static(publicDir));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// HomeUtilities: /home/*
app.use('/home/api/catwatch', catwatchRouter);
app.get('/home/control', (req, res) =>
  res.sendFile(path.join(publicDir, 'home', 'control.html'))
);

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

// キャッシュ設定（スクレイピング結果を1分間保持）
const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let cacheTimestamp = 0;
let pendingFetch = null; // 同時リクエストの重複スクレイピング防止

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

/**
 * GET /api/bus
 * 次のバス情報を返す
 *
 * レスポンス例:
 * {
 *   "buses": [
 *     { "departureTime": "14:23", "minutesUntil": 5, "route": "八千代中央行き", "isDelayed": false, "isCancelled": false },
 *     ...
 *   ],
 *   "fetchedAt": "2026-05-25T14:18:00.000Z",
 *   "cached": false
 * }
 */
app.get('/api/bus', async (req, res) => {
  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === '1';

    // キャッシュが有効な場合はそのまま返す
    if (!forceRefresh && cache && now - cacheTimestamp < CACHE_TTL_MS) {
      console.log('[cache] hit');
      return res.json({ ...cache, cached: true });
    }

    // 既に進行中のスクレイピングがある場合はそれを待つ
    if (pendingFetch) {
      console.log('[cache] waiting for pending fetch');
      const result = await pendingFetch;
      return res.json({ ...result, cached: true });
    }

    console.log('[scrape] starting...');
    pendingFetch = scrapeBusInfo().finally(() => {
      pendingFetch = null;
    });

    const result = await pendingFetch;
    cache = result;
    cacheTimestamp = Date.now();

    console.log(`[scrape] done. ${result.buses.length} buses found.`);
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error('[scrape] error:', err.message);

    // キャッシュが古くても返せるものがあれば返す
    if (cache) {
      return res.json({ ...cache, cached: true, error: err.message });
    }

    res.status(500).json({
      error: 'スクレイピングに失敗しました',
      detail: err.message,
      buses: [],
    });
  }
});

/**
 * GET /api/health
 * ヘルスチェック用
 */
app.get('/api/health', (req, res) => {
  const idleSec  = Math.round((Date.now() - lastRequestTime) / 1000);
  const remainSec = Math.max(0, Math.round((IDLE_TIMEOUT_MS - (Date.now() - lastRequestTime)) / 1000));
  res.json({
    status: 'ok',
    mode: IS_WORKER ? 'worker' : 'standalone',
    uptime: Math.round(process.uptime()) + 's',
    idleSince: idleSec + 's',
    shutdownIn: remainSec + 's',
    cacheAge: cache ? Math.round((Date.now() - cacheTimestamp) / 1000) + 's' : 'no cache',
  });
});

/**
 * GET /api/debug
 * ページの生テキストを確認するデバッグ用エンドポイント
 * セレクタ調整が必要な時に使う
 */
app.get('/api/debug', async (req, res) => {
  try {
    const result = await scrapeBusInfo();
    res.json(result); // debugフィールド含む生データを返す
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`BusCheck server listening on port ${PORT}`);
  console.log(`  GET /api/bus     - 次のバス一覧`);
  console.log(`  GET /api/health  - ヘルスチェック`);
  console.log(`  GET /api/debug   - スクレイピング生データ（調整用）`);
});
