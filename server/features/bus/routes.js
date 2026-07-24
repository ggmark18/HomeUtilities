'use strict';

const { Router } = require('express');
const { scrapeBusInfo } = require('./scraper');

const router = Router();

// キャッシュ設定（スクレイピング結果を1分間保持）
const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let cacheTimestamp = 0;
let pendingFetch = null; // 同時リクエストの重複スクレイピング防止

/**
 * GET /home/bus/api/config
 * 認証設定を返す（Apache の Basic 認証ヘッダーをフロントで再利用するため）
 */
router.get('/config', (req, res) => {
  const user = process.env.AUTH_USER || '';
  const pass = process.env.AUTH_PASS || '';
  const header = user
    ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    : '';
  res.set('Cache-Control', 'no-store');
  res.json({ auth: header });
});

/**
 * GET /home/bus/api/bus
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
router.get('/bus', async (req, res) => {
  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === '1';

    // キャッシュが有効な場合はそのまま返す
    if (!forceRefresh && cache && now - cacheTimestamp < CACHE_TTL_MS) {
      console.log('[bus][cache] hit');
      return res.json({ ...cache, cached: true });
    }

    // 既に進行中のスクレイピングがある場合はそれを待つ
    if (pendingFetch) {
      console.log('[bus][cache] waiting for pending fetch');
      const result = await pendingFetch;
      return res.json({ ...result, cached: true });
    }

    console.log('[bus][scrape] starting...');
    pendingFetch = scrapeBusInfo().finally(() => {
      pendingFetch = null;
    });

    const result = await pendingFetch;
    cache = result;
    cacheTimestamp = Date.now();

    console.log(`[bus][scrape] done. ${result.buses.length} buses found.`);
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error('[bus][scrape] error:', err.message);

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
 * GET /home/bus/api/debug
 * ページの生テキストを確認するデバッグ用エンドポイント
 * セレクタ調整が必要な時に使う
 */
router.get('/debug', async (req, res) => {
  try {
    const result = await scrapeBusInfo();
    res.json(result); // debugフィールド含む生データを返す
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
