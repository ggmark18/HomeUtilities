'use strict';

const { Router } = require('express');
const router = Router();

// ========= 状態管理 =========
let state = {
  detection: 'clean',       // 'clean' | 'detected'
  lastHeartbeat: null,      // Unix timestamp (seconds)
  lastEvent: null,          // { type, timestamp }
};

const sseClients = new Set();

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ========= 認証ミドルウェア =========
function authenticate(req, res, next) {
  const token = process.env.CATWATCH_SECRET;
  if (!token) return next(); // 未設定時はスルー（開発用）
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${token}`) {
    console.warn(`[catwatch] 401 Unauthorized from=${req.ip} auth=${auth ? '不一致' : '未送信'}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ========= OrangePi からのイベント受信 =========
// POST /home/api/catwatch/event
// body: { type: 'detection_alert' | 'cleanup_detected' | 'heartbeat' | 'startup_reset' }
router.post('/event', authenticate, (req, res) => {
  const { type } = req.body;
  const timestamp = Math.floor(Date.now() / 1000);
  console.log(`[catwatch] event受信: type=${type} from=${req.ip}`);

  if (type === 'heartbeat') {
    state.lastHeartbeat = timestamp;
    broadcastSSE({ type: 'heartbeat', timestamp });
    return res.json({ ok: true });
  }

  if (type === 'detection_alert') {
    state.detection = 'detected';
    state.lastEvent = { type, timestamp };
    broadcastSSE({ type, timestamp, detection: 'detected' });
    return res.json({ ok: true });
  }

  if (type === 'cleanup_detected') {
    state.detection = 'clean';
    state.lastEvent = { type, timestamp };
    broadcastSSE({ type, timestamp, detection: 'clean' });
    return res.json({ ok: true });
  }

  // poop_detector.py起動直後に1回だけ送る。プロセス内の検知状態（alerted等）は
  // 再起動のたびに失われるため、ダッシュボードもそれに合わせて明示的に同期する。
  if (type === 'startup_reset') {
    state.detection = 'clean';
    state.lastEvent = { type, timestamp };
    broadcastSSE({ type, timestamp, detection: 'clean' });
    return res.json({ ok: true });
  }

  console.warn(`[catwatch] 不明なevent type: ${type}`);
  res.status(400).json({ error: 'unknown event type' });
});

// ========= 手動リセット（ダッシュボードから） =========
// OrangePi再起動時にプロセス内の検知状態が失われ、ダッシュボードが
// 「検知」のまま固定されてしまうケースの救済用。実際に清掃済みであることを
// 確認したうえで家族が手動で押す想定のため、OrangePi向けのBearer認証は不要。
// POST /home/api/catwatch/reset
router.post('/reset', (req, res) => {
  const timestamp = Math.floor(Date.now() / 1000);
  console.log(`[catwatch] 手動リセット from=${req.ip}`);

  state.detection = 'clean';
  state.lastEvent = { type: 'manual_reset', timestamp };
  broadcastSSE({ type: 'manual_reset', timestamp, detection: 'clean' });
  res.json({ ok: true });
});

// ========= 現在の状態取得 =========
// GET /home/api/catwatch/status
router.get('/status', (req, res) => {
  res.json(state);
});

// ========= SSE ストリーム =========
// GET /home/api/catwatch/stream
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 接続直後に現在の状態を送信
  res.write(`data: ${JSON.stringify({ type: 'init', ...state })}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

module.exports = router;
