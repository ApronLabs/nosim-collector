#!/usr/bin/env node
'use strict';
// ════════════════════════════════════════════════════════════════════════════
// 배민 리뷰 수집 오케스트레이터 — 세션에서 리뷰 캡처(poc-reviews-baemin) → 매핑(baemin-review-map)
//   → 노심 v4 /api/reviews/ingest 로 전송(백엔드가 DB upsert). 매출 수집 세션(persist:baemin) 재사용.
//
// ⚠️ 미검증(2026-07-02): 파서(baemin-review-map)와 ingest 경로는 실증 완료. 그러나 '월하화 배민 세션'이
//    없어 캡처→적재 전체 실행은 아직 검증 못 함. 검증: 월하화 배민 세션 살린 뒤 아래 실행 1회.
//
// 설계 정합(적대검증 v2 반영):
//   · 대상 storeId 는 v4 실존 매장만(월하화). 환경변수 REVIEW_STORE_ID(v4 UUID) 필수.
//   · v4 로 전송(NOSIM_V4_URL, 기본 localhost:5100) + x-ingest-secret(INGEST_SECRET).
//   · 실패는 노심 v3 report-failure 에 platform='baemin-review' 로 보고(watchdog/Slack 재사용).
//   · read-only(답글 등록 안 함). 하루 1회 저빈도 권장.
//
// 실행(검증용):
//   NOSIM_V4_URL=http://localhost:5100 INGEST_SECRET=... REVIEW_STORE_ID=3c11a2d6-... \
//   BAEMIN_SHOP_NUMBER=<월하화 배민 shopNumber> node scripts/collect-reviews.js --from=2026-06-01 --to=2026-07-02
// ════════════════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {}

const { mapBaeminReviewPage } = require('./lib/baemin-review-map');

const getArg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : undefined; };

const V4_URL = process.env.NOSIM_V4_URL || 'http://localhost:5100';
const INGEST_SECRET = process.env.INGEST_SECRET;
const STORE_ID = process.env.REVIEW_STORE_ID; // v4 store UUID (월하화)
const SHOP = process.env.BAEMIN_SHOP_NUMBER || getArg('shopNumber') || '';
const FROM = getArg('from') || new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
const TO = getArg('to') || new Date().toISOString().slice(0, 10);

function log(m) { console.log(m); }

// ── 1) 배민 리뷰 캡처 (Electron 워커 spawn) ──
function captureReviews() {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `baemin-reviews-${Date.now()}.json`);
    const electron = require('electron'); // 비-electron 컨텍스트에선 실행경로(string) 반환
    const args = [path.join(__dirname, 'poc-reviews-baemin.js'), `--from=${FROM}`, `--to=${TO}`, `--out=${outFile}`];
    if (SHOP) args.push(`--shopNumber=${SHOP}`);
    const child = spawn(electron, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let lastErr = null;
    child.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue;
        try { const m = JSON.parse(line); if (m.type === 'status') log(`  · ${m.msg}`); if (m.type === 'error') lastErr = m.error; }
        catch { /* non-json stdout */ }
      }
    });
    child.on('close', (code) => {
      if (fs.existsSync(outFile)) {
        try { const j = JSON.parse(fs.readFileSync(outFile, 'utf8')); fs.unlinkSync(outFile); return resolve(j); } catch (e) { return reject(new Error('결과 파싱 실패: ' + e.message)); }
      }
      reject(new Error(lastErr || `캡처 실패(exit ${code})`));
    });
  });
}

// ── 2) v4 ingest 전송 (백엔드가 DB upsert) ──
async function ingestToV4(storeId, items) {
  let up = 0;
  for (let i = 0; i < items.length; i += 200) {
    const batch = items.slice(i, i + 200);
    const res = await fetch(`${V4_URL}/api/reviews/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': INGEST_SECRET || '' },
      body: JSON.stringify({ storeId, reviews: batch }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ingest 실패 ${res.status}: ${JSON.stringify(j)}`);
    up += j.upserted || 0;
    log(`  → ingest batch: upserted=${j.upserted} skipped=${j.skipped} crossStore=${j.crossStore}`);
  }
  return up;
}

async function main() {
  if (!INGEST_SECRET) throw new Error('INGEST_SECRET 필요(.env 또는 환경변수)');
  if (!STORE_ID) throw new Error('REVIEW_STORE_ID(v4 월하화 store UUID) 필요');
  log(`배민 리뷰 수집 → v4(${V4_URL}) store=${STORE_ID} ${FROM}~${TO}`);

  const captured = await captureReviews();
  log(`캡처 ${captured.count}건 (shop ${captured.shopNumber})`);

  const { items } = mapBaeminReviewPage({ reviews: captured.reviews, next: false }, { platformStoreId: String(captured.shopNumber) });
  log(`매핑 ${items.length}건 → 전송`);

  const up = await ingestToV4(STORE_ID, items);
  log(`\n✅ 완료: ${up}건 적재(v4). source=collected`);
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
