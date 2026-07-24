'use strict';

/**
 * HomeUtilities Gateway
 *
 * ポート3000で常時待機する超軽量プロセス。
 * リクエストが来たらワーカー（server.js。全機能を内包）を起動してプロキシし、
 * ワーカーは1時間無通信で自動終了する。
 */

require('dotenv').config();
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const GATEWAY_PORT = process.env.GATEWAY_PORT || 3000;
const WORKER_PORT  = 3001;
const WORKER_READY_TIMEOUT_MS = 60_000; // ワーカー起動タイムアウト（60秒）
const WORKER_POLL_INTERVAL_MS = 500;    // 起動確認のポーリング間隔

let workerProc        = null;  // 実行中のワーカープロセス
let workerStartPromise = null; // 起動中の場合に重複起動を防ぐPromise

// ──────────────────────────────────────────────
// ワーカー管理
// ──────────────────────────────────────────────

/** ワーカーが起動済みかどうか */
function isWorkerAlive() {
  return workerProc !== null && !workerProc.killed;
}

/** ワーカーを起動して ready になるまで待つ（重複起動防止） */
function ensureWorker() {
  if (isWorkerAlive())     return Promise.resolve();
  if (workerStartPromise)  return workerStartPromise;

  console.log('[gateway] ワーカーを起動します...');
  workerProc = spawn(
    process.execPath,
    [path.join(__dirname, 'server.js')],
    {
      env: { ...process.env, PORT: String(WORKER_PORT), BUSCHECK_WORKER: '1' },
      stdio: 'inherit',
    }
  );

  workerProc.on('exit', code => {
    console.log(`[gateway] ワーカー終了 (code ${code ?? '?'})`);
    workerProc        = null;
    workerStartPromise = null;
  });

  workerStartPromise = waitUntilWorkerReady()
    .finally(() => { workerStartPromise = null; });

  return workerStartPromise;
}

/** ワーカーの /api/health が 200 を返すまでポーリング */
function waitUntilWorkerReady() {
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() > deadline) {
        return reject(new Error('ワーカー起動タイムアウト'));
      }
      const req = http.get(
        `http://127.0.0.1:${WORKER_PORT}/home/api/health`,
        res => {
          res.resume();
          if (res.statusCode === 200) {
            console.log('[gateway] ワーカー準備完了');
            resolve();
          } else {
            setTimeout(poll, WORKER_POLL_INTERVAL_MS);
          }
        }
      );
      req.on('error', () => setTimeout(poll, WORKER_POLL_INTERVAL_MS));
      req.end();
    };
    // 最初の1秒は必ず待つ（起動直後は確実に落ちているため）
    setTimeout(poll, 1000);
  });
}

// ──────────────────────────────────────────────
// HTTPプロキシ
// ──────────────────────────────────────────────

function proxyToWorker(clientReq, clientRes) {
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: WORKER_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers, host: `127.0.0.1:${WORKER_PORT}` },
    },
    proxyRes => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes, { end: true });
    }
  );

  proxyReq.on('error', err => {
    console.error('[gateway] プロキシエラー:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: 'proxy error', detail: err.message }));
    }
  });

  clientReq.pipe(proxyReq, { end: true });
}

// ──────────────────────────────────────────────
// ゲートウェイサーバー
// ──────────────────────────────────────────────

const gateway = http.createServer(async (req, res) => {
  // CORS プリフライトはワーカーを起動せず即答
  // BEHIND_APACHE=true の場合は Apache が CORS ヘッダーを付与するので省略
  if (req.method === 'OPTIONS') {
    const corsHeaders = process.env.BEHIND_APACHE ? {} : {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const ts = new Date().toLocaleTimeString('ja-JP');
  const workerWasAlive = isWorkerAlive();
  console.log(`[${ts}] ${req.method} ${req.url} (worker: ${workerWasAlive ? '起動中' : '停止中'})`);

  try {
    await ensureWorker();
    proxyToWorker(req, res);
  } catch (err) {
    console.error('[gateway] ワーカー起動失敗:', err.message);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ワーカー起動失敗', detail: err.message, buses: [] }));
  }
});

gateway.listen(GATEWAY_PORT, () => {
  console.log(`[gateway] HomeUtilities gateway 起動 → ポート ${GATEWAY_PORT}`);
  console.log(`          ワーカーはリクエスト時に自動起動 / 1時間無通信で自動終了`);
});
