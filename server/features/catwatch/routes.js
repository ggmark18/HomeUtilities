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
// body: { type: 'detection_alert' | 'cleanup_detected' | 'heartbeat' }
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

  console.warn(`[catwatch] 不明なevent type: ${type}`);
  res.status(400).json({ error: 'unknown event type' });
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
