'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();

// ========= 状態管理 =========
let state = {
  detection: 'clean',       // 'clean' | 'detected'
  lastHeartbeat: null,      // Unix timestamp (seconds)
  lastEvent: null,          // { type, timestamp }
};

// ========= 検知レビュー（学習データの振り分け）永続化 =========
// フロー:
//   1. poop_detector.pyが検知確定時にROI画像をPOST /detectionsで送る（label='pending'で保存）
//   2. ダッシュボードがGET /detections?label=pendingで一覧表示、POST /detections/:id/labelで振り分け
//   3. cleaner_control.pyがGET /detections/unsyncedを定期的にポーリングし、ローカルのtraining_data/を更新
//   4. 反映が終わったらPOST /detections/:id/ackでEC2側の画像を削除（training_data/がOrangePi側の恒久保存先）
const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'catwatch');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DB_FILE = path.join(DATA_DIR, 'detections.json');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

function loadDetections() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveDetections(list) {
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2));
}

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

// ========= 検知レビュー（学習データの振り分け） =========

// OrangePi(poop_detector.py)からの検知画像アップロード
// POST /home/api/catwatch/detections?id=20260726_120000  body: image/jpeg (raw)
router.post(
  '/detections',
  authenticate,
  express.raw({ type: 'image/jpeg', limit: '5mb' }),
  (req, res) => {
    const { id } = req.query;
    if (!id || !/^[0-9_]+$/.test(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'image body required' });
    }

    fs.writeFileSync(path.join(IMAGES_DIR, `${id}.jpg`), req.body);

    const detections = loadDetections();
    if (!detections.find((d) => d.id === id)) {
      detections.push({
        id,
        label: 'pending',
        createdAt: Math.floor(Date.now() / 1000),
        synced: false,
      });
      saveDetections(detections);
    }
    console.log(`[catwatch] 検知画像を受信: id=${id}`);
    res.json({ ok: true });
  }
);

// ダッシュボード: レビュー一覧取得
// GET /home/api/catwatch/detections?label=pending
router.get('/detections', (req, res) => {
  const { label } = req.query;
  const detections = loadDetections();
  const items = label ? detections.filter((d) => d.label === label) : detections;
  // 新しい順
  items.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ items });
});

// ダッシュボード: 検知画像の取得
// GET /home/api/catwatch/detections/:id/image
router.get('/detections/:id/image', (req, res) => {
  // req.params.idをそのままpath.joinに渡すとパストラバーサルの恐れがあるため検証する
  if (!/^[0-9_]+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const imgPath = path.join(IMAGES_DIR, `${req.params.id}.jpg`);
  if (!fs.existsSync(imgPath)) return res.status(404).end();
  res.sendFile(imgPath);
});

// ダッシュボード: レビュー結果の記録（✅糞でした / ❌誤検知）
// 家族が使う操作のため、/resetと同様にOrangePi向けのBearer認証は不要
// POST /home/api/catwatch/detections/:id/label  body: { label: 'poop' | 'no_poop' }
// JSONボディの解析はserver.jsでグローバルに適用済み（express.json()）のためここでは不要
router.post('/detections/:id/label', (req, res) => {
  const { label } = req.body || {};
  if (label !== 'poop' && label !== 'no_poop') {
    return res.status(400).json({ error: 'label must be poop or no_poop' });
  }

  const detections = loadDetections();
  const d = detections.find((d) => d.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });

  d.label = label;
  d.labeledAt = Math.floor(Date.now() / 1000);
  d.synced = false;
  saveDetections(detections);

  console.log(`[catwatch] レビュー結果: id=${d.id} → ${label}`);
  res.json({ ok: true });
});

// OrangePi(cleaner_control.py)からのポーリング: まだtraining_data/に反映していないラベルを取得
// GET /home/api/catwatch/detections/unsynced
router.get('/detections/unsynced', authenticate, (req, res) => {
  const detections = loadDetections();
  const items = detections
    .filter((d) => d.label !== 'pending' && !d.synced)
    .map((d) => ({ id: d.id, label: d.label }));
  res.json({ items });
});

// OrangePi: training_data/への反映完了報告。EC2側の画像はもう不要なので削除する
// （training_data/がOrangePi側の恒久保存先で、EC2側はレビュー用の一時置き場のため）
// POST /home/api/catwatch/detections/:id/ack
router.post('/detections/:id/ack', authenticate, (req, res) => {
  const detections = loadDetections();
  const d = detections.find((d) => d.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });

  d.synced = true;
  saveDetections(detections);
  fs.unlink(path.join(IMAGES_DIR, `${d.id}.jpg`), () => {});

  console.log(`[catwatch] 同期完了: id=${d.id} (${d.label})`);
  res.json({ ok: true });
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
