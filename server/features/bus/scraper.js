'use strict';

const puppeteer = require('puppeteer');

const BUS_URL =
  'https://toyo-bus.bus-navigation.jp/wgsys/wgp/bus.htm' +
  '?tabName=searchTab' +
  '&from=%E3%82%86%E3%82%8A%E3%81%AE%E3%81%8D%E5%8F%B0%E7%AC%AC%E4%B8%89' +
  '&fromType=1' +
  '&to=%E5%85%AB%E5%8D%83%E4%BB%A3%E4%B8%AD%E5%A4%AE%E9%A7%85' +
  '&toType=1' +
  '&locale=ja' +
  '&bsid=1' +
  '&mapFlag=false' +
  '&existYn=N' +
  '&nextDiagramFlag=0' +
  '&diaRevisedDate=';

/**
 * 東洋バスサイトをスクレイピングして次のバス一覧を返す
 * @returns {Promise<{buses: Array, fetchedAt: string, raw?: string}>}
 */
async function scrapeBusInfo() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );
    await page.setViewport({ width: 390, height: 844 });

    // ページを開いてコンテンツの読み込みを待つ
    await page.goto(BUS_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // ページが安定するまで少し待機
    await new Promise(r => setTimeout(r, 2000));

    // ページ全体のテキストを取得（デバッグ用）
    const bodyText = await page.evaluate(() => document.body.innerText);

    // center_box の構造をデバッグ用に取得
    const centerBoxHtml = await page.evaluate(() => {
      const box = document.querySelector('.center_box');
      if (!box) return null;
      // 直下子要素の概要（タグ・クラス・テキスト先頭80字）も取得
      const childSummary = Array.from(box.children).map((el, i) => ({
        index: i,
        tag: el.tagName,
        className: el.className,
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        hasBadge: !!el.querySelector('.green_badge'),
      }));
      return { html: box.innerHTML.slice(0, 3000), children: childSummary };
    });

    // バス情報を抽出（div.center_box の直下子要素を順番に見る）
    const buses = await page.evaluate(() => {
      const results = [];

      function normalizeTime(text) {
        if (!text) return null;
        const m = text.trim().match(/(\d{1,2}):(\d{2})/);
        if (!m) return null;
        return `${m[1].padStart(2, '0')}:${m[2]}`;
      }

      // 指定要素から stopsPassed を取り出す（green_badge or テキストパターン）
      function extractStopsPassed(el) {
        if (!el) return undefined;
        const badge = el.querySelector('.green_badge');
        if (badge) {
          const n = parseInt(badge.innerText.trim(), 10);
          if (!isNaN(n)) return n;
        }
        const m = (el.innerText || '').match(/(\d+)\s*個前の停留所を通過/);
        return m ? parseInt(m[1], 10) : undefined;
      }

      const centerBox = document.querySelector('.center_box');
      if (!centerBox) return results;

      // center_box 直下の子要素を配列に
      const children = Array.from(centerBox.children);

      // ── PASS 1: center_box の直下子要素を全て処理（重複を許容して収集）──
      for (let i = 0; i < children.length; i++) {
        const el = children[i];
        const text = el.innerText || '';
        if (!text.trim() || !/\d{1,2}:\d{2}/.test(text)) continue;

        const times = [...text.matchAll(/(\d{1,2}:\d{2})/g)]
          .map(m => normalizeTime(m[1]))
          .filter(Boolean);
        const uniqueTimes = [...new Set(times)];
        if (uniqueTimes.length === 0) continue;

        // 前の兄弟を最大3つ遡って stopsPassed を探す（なければ自分自身も確認）
        let stopsPassed = undefined;
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          stopsPassed = extractStopsPassed(children[j]);
          if (stopsPassed !== undefined) break;
        }
        if (stopsPassed === undefined) stopsPassed = extractStopsPassed(el);

        results.push({
          scheduledTime: uniqueTimes[0],
          departureTime: uniqueTimes[1] || uniqueTimes[0],
          stopsPassed,
          fullText: text.replace(/\s+/g, ' ').trim().slice(0, 150),
        });

        if (results.length >= 10) break; // 多めに収集して後で絞る
      }

      // ── PASS 2: 時刻をキーに重複排除（stopsPassed がある方を優先）──
      const deduped = new Map();
      for (const r of results) {
        const key = r.scheduledTime;
        if (!deduped.has(key)) {
          deduped.set(key, r);
        } else if (r.stopsPassed !== undefined && deduped.get(key).stopsPassed === undefined) {
          // stopsPassed の情報がある方に置き換える
          deduped.set(key, r);
        }
      }
      results.length = 0;
      for (const r of deduped.values()) {
        results.push(r);
        if (results.length >= 5) break;
      }

      // ── PASS 3: 直下に見つからない場合は一段深く探す（フォールバック）──
      if (results.length === 0) {
        const deeper = Array.from(centerBox.querySelectorAll('div, li'))
          .filter(el => /\d{1,2}:\d{2}/.test(el.innerText || '') &&
                        (el.innerText || '').length < 300);
        const seen = new WeakSet();
        const deepResults = [];
        for (const el of deeper) {
          if (seen.has(el)) continue;
          const text = el.innerText || '';
          const times = [...text.matchAll(/(\d{1,2}:\d{2})/g)]
            .map(m => normalizeTime(m[1])).filter(Boolean);
          const uniqueTimes = [...new Set(times)];
          if (uniqueTimes.length === 0) continue;

          let stopsPassed = extractStopsPassed(el.previousElementSibling);
          if (stopsPassed === undefined) stopsPassed = extractStopsPassed(el);

          let p = el;
          while (p && p !== centerBox) { seen.add(p); p = p.parentElement; }

          deepResults.push({
            scheduledTime: uniqueTimes[0],
            departureTime: uniqueTimes[1] || uniqueTimes[0],
            stopsPassed,
            fullText: text.replace(/\s+/g, ' ').trim().slice(0, 150),
          });
          if (deepResults.length >= 10) break;
        }
        // 同じく重複排除
        const deepDeduped = new Map();
        for (const r of deepResults) {
          if (!deepDeduped.has(r.scheduledTime)) deepDeduped.set(r.scheduledTime, r);
          else if (r.stopsPassed !== undefined && deepDeduped.get(r.scheduledTime).stopsPassed === undefined) {
            deepDeduped.set(r.scheduledTime, r);
          }
        }
        for (const r of deepDeduped.values()) {
          results.push(r);
          if (results.length >= 5) break;
        }
      }

      return results;
    });

    // 構造化データを整形
    const parsedBuses = parseStructuredBuses(buses);

    return {
      buses: parsedBuses,
      fetchedAt: new Date().toISOString(),
      debug: {
        rawCount: buses.length,
        bodyLength: bodyText.length,
        bodyPreview: bodyText.slice(0, 500),
        centerBoxHtml: centerBoxHtml,   // center_box の生HTML（セレクタ調整用）
        rawBuses: buses,                // page.evaluate が返した生データ
      },
    };
  } finally {
    await browser.close();
  }
}

/**
 * page.evaluate から返った構造化データを整形する（メインパス）
 */
function parseStructuredBuses(items) {
  const now = new Date();
  const buses = [];

  for (const item of items) {
    const depTime = item.departureTime || item.scheduledTime;
    if (!depTime) continue;

    const [h, m] = depTime.split(':').map(Number);
    const departure = new Date(now);
    departure.setHours(h, m, 0, 0);
    if (departure < now) departure.setDate(departure.getDate() + 1);
    const minutesUntil = Math.round((departure - now) / 60000);

    const isDelayed   = item.scheduledTime !== item.departureTime;
    const isCancelled = /運休|中止/.test(item.fullText || '');

    buses.push({
      scheduledTime: item.scheduledTime,
      departureTime: depTime,
      minutesUntil,
      route: '',
      isDelayed,
      isCancelled,
      stopsPassed: item.stopsPassed,
      currentStop: item.currentStop,
      rawText: (item.fullText || '').slice(0, 80),
    });
  }

  return buses
    .filter(b => b.minutesUntil >= 0 && b.minutesUntil <= 120)
    .sort((a, b) => a.minutesUntil - b.minutesUntil)
    .slice(0, 5);
}

/**
 * スクレイピングした生テキストからバス情報を構造化する（フォールバック）
 */
function parseRawBuses(rawItems, bodyText) {
  const timeRegex = /(\d{1,2}):(\d{2})/g;
  const now = new Date();

  if (rawItems.length === 0) {
    return extractTimesFromText(bodyText, now);
  }

  const buses = [];
  for (const item of rawItems) {
    const times = [...item.text.matchAll(/(\d{1,2}):(\d{2})/g)];
    if (times.length === 0) continue;

    // 1つ目の時刻 = 予定時刻
    const [, h1, m1] = times[0];
    const schedHour = parseInt(h1, 10);
    const schedMin  = parseInt(m1, 10);
    const scheduledTime = `${String(schedHour).padStart(2, '0')}:${String(schedMin).padStart(2, '0')}`;

    // 2つ目の時刻があれば発車時刻（遅延で異なる場合）、なければ予定時刻と同じ
    let departureTime = scheduledTime;
    if (times.length >= 2) {
      const [, h2, m2] = times[1];
      departureTime = `${String(parseInt(h2,10)).padStart(2,'0')}:${String(parseInt(m2,10)).padStart(2,'0')}`;
    }

    // あと何分（発車時刻ベース）
    const departure = new Date(now);
    departure.setHours(parseInt(departureTime.split(':')[0], 10),
                       parseInt(departureTime.split(':')[1], 10), 0, 0);
    if (departure < now) departure.setDate(departure.getDate() + 1);
    const minutesUntil = Math.round((departure - now) / 60000);

    // 遅延・運休
    const isDelayed   = /遅延|遅れ|delay/i.test(item.text);
    const isCancelled = /運休|中止|cancel/i.test(item.text);

    // 路線名
    const routeMatch = item.text.match(/([ぁ-んァ-ヶ一-龠\w]{2,10}行き|[A-Z0-9]{2,6}系統|[0-9]{1,3}番)/);
    const route = routeMatch ? routeMatch[0] : '';

    // 通過停留所（「〇つ前」「〇停留所前」などのパターンを試みる）
    let stopsPassed;
    let currentStop;
    const stopsMatch = item.text.match(/(\d+)\s*(?:つ前|停留所前|バス停前)/);
    if (stopsMatch) {
      stopsPassed = parseInt(stopsMatch[1], 10);
    }
    // 停留所名っぽいもの（「〇〇バス停」「〇〇停」）
    const stopNameMatch = item.text.match(/「(.{2,12})」|(.{2,12}?)(?:バス停|停留所)(?:通過|発)/);
    if (stopNameMatch) {
      currentStop = (stopNameMatch[1] || stopNameMatch[2] || '').trim();
    }

    buses.push({
      scheduledTime,
      departureTime,
      minutesUntil,
      route,
      isDelayed,
      isCancelled,
      stopsPassed,
      currentStop,
      rawText: item.text.slice(0, 80),
    });
  }

  return buses
    .filter(b => b.minutesUntil >= 0 && b.minutesUntil <= 120)
    .sort((a, b) => a.minutesUntil - b.minutesUntil)
    .slice(0, 5);
}

/**
 * bodyTextから時刻を抽出するフォールバック
 */
function extractTimesFromText(bodyText, now) {
  const timeRegex = /(\d{1,2}):(\d{2})/g;
  const buses = [];
  let match;

  while ((match = timeRegex.exec(bodyText)) !== null) {
    const hour = parseInt(match[1], 10);
    const min = parseInt(match[2], 10);
    if (hour > 23 || min > 59) continue;

    const departure = new Date(now);
    departure.setHours(hour, min, 0, 0);
    if (departure < now) departure.setDate(departure.getDate() + 1);

    const minutesUntil = Math.round((departure - now) / 60000);

    const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    buses.push({
      scheduledTime: timeStr,
      departureTime: timeStr,
      minutesUntil,
      route: '',
      isDelayed: false,
      isCancelled: false,
      rawText: '',
    });
  }

  return buses
    .filter(b => b.minutesUntil >= 0 && b.minutesUntil <= 120)
    .sort((a, b) => a.minutesUntil - b.minutesUntil)
    .slice(0, 5)
    .filter((b, i, arr) => i === 0 || b.scheduledTime !== arr[i - 1].scheduledTime);
}

module.exports = { scrapeBusInfo };
