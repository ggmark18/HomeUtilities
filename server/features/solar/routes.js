'use strict';

const express = require('express');
const router = express.Router();

// ========= 太陽光発電コントローラー（Renogy Rover Li）の状態受信 =========
// フロー:
//   自宅のESP32（Waveshare ESP32-S3-Relay-6CH / ESPHome）
//     → RoverのRS485ポートをModbus RTUで読み取り
//     → POST /home/api/solar/report で定期送信（Bearer認証）
//   EC2（このファイル）が最新状態を保持し、SSEでダッシュボードへ配信
//
// ESP32は自宅NAT内にあり外部から到達できないため、catwatch（OrangePi）と同じく
// 常にデバイス側が起点（push）になる設計。ポーリング用のGETは生やさない。

// ========= 状態管理 =========
// catwatchと同じくメモリ保持。ワーカーがアイドル終了しても、ESP32が次の
// レポート（既定60秒間隔）を送れば復元されるため永続化はしない。
let state = {
  soc: null,              // バッテリー残量 [%]
  batteryVoltage: null,   // バッテリー電圧 [V]
  chargingCurrent: null,  // 充電電流 [A]
  chargingPower: null,    // 充電電力 [W]
  solarVoltage: null,     // PV電圧 [V]
  solarCurrent: null,     // PV電流 [A]
  loadPower: null,        // 負荷電力 [W]
  batteryTemp: null,      // バッテリー温度 [℃]
  controllerTemp: null,   // コントローラー温度 [℃]
  generationToday: null,  // 本日の発電量 [Wh]
  chargingState: null,    // 'deactivated'|'activated'|'mppt'|'equalizing'|'boost'|'float'|'current_limiting'
  fault: null,            // 障害ビット（0なら正常）
  lastReport: null,       // 最終受信時刻 Unix timestamp [秒]
};

// Roverの充電状態レジスタ(0x0120の下位バイト)が取りうる値。
// ESP32側は数値ではなくこの文字列で送る（ダッシュボードの表示ラベルと1対1にするため）。
const CHARGING_STATES = [
  'deactivated',
  'activated',
  'mppt',
  'equalizing',
  'boost',
  'float',
  'current_limiting',
];

const sseClients = new Set();

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ========= 認証ミドルウェア =========
// catwatchのauthenticateと同じ形。未設定時にスルーするのも開発用として踏襲する。
function authenticate(req, res, next) {
  const token = process.env.SOLAR_SECRET;
  if (!token) return next(); // 未設定時はスルー（開発用）
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${token}`) {
    console.warn(`[solar] 401 Unauthorized from=${req.ip} auth=${auth ? '不一致' : '未送信'}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ========= 入力値の検証 =========
// ESP32からの値をそのままSSEに流すと、通信エラー時のNaNや想定外の巨大値が
// ダッシュボードの表示を壊すため、数値であることと範囲を確認してから採用する。
function num(value, { min, max }) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// ========= ESP32 からの状態レポート受信 =========
// POST /home/api/solar/report
// body: { soc, batteryVoltage, chargingCurrent, chargingPower, solarVoltage,
//         solarCurrent, loadPower, batteryTemp, controllerTemp,
//         generationToday, chargingState, fault }
// 送信されなかったキーは前回値を維持する（ESP32側で一部のセンサーだけ
// 更新タイミングがずれても、ダッシュボードが欠測表示にならないようにするため）。
router.post('/report', authenticate, (req, res) => {
  const b = req.body || {};
  const timestamp = Math.floor(Date.now() / 1000);

  const parsed = {
    soc:             num(b.soc,             { min: 0,    max: 100 }),
    batteryVoltage:  num(b.batteryVoltage,  { min: 0,    max: 100 }),
    chargingCurrent: num(b.chargingCurrent, { min: 0,    max: 200 }),
    chargingPower:   num(b.chargingPower,   { min: 0,    max: 10000 }),
    solarVoltage:    num(b.solarVoltage,    { min: 0,    max: 200 }),
    solarCurrent:    num(b.solarCurrent,    { min: 0,    max: 200 }),
    loadPower:       num(b.loadPower,       { min: 0,    max: 10000 }),
    batteryTemp:     num(b.batteryTemp,     { min: -50,  max: 120 }),
    controllerTemp:  num(b.controllerTemp,  { min: -50,  max: 120 }),
    generationToday: num(b.generationToday, { min: 0,    max: 1000000 }),
    fault:           num(b.fault,           { min: 0,    max: 0xFFFFFFFF }),
  };

  // 送信されたキーのみ上書きする（nullは「今回は値が無い」とみなし前回値を残す）
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null) state[key] = value;
  }

  if (typeof b.chargingState === 'string' && CHARGING_STATES.includes(b.chargingState)) {
    state.chargingState = b.chargingState;
  }

  state.lastReport = timestamp;

  // /report の受信自体が死活監視を兼ねる（catwatchのheartbeatに相当）。
  // 別途heartbeatイベントは設けない。
  broadcastSSE({ type: 'report', ...state });

  console.log(
    `[solar] report受信: soc=${state.soc}% v=${state.batteryVoltage}V ` +
    `charge=${state.chargingPower}W state=${state.chargingState} from=${req.ip}`
  );
  res.json({ ok: true });
});

// ========= 現在の状態取得 =========
// GET /home/api/solar/status
router.get('/status', (req, res) => {
  res.json(state);
});

// ========= SSE ストリーム =========
// GET /home/api/solar/stream
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
