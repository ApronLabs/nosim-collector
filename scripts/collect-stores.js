#!/usr/bin/env node
// 매장별 매출 자동 수집 오케스트레이터 (무인 PC + 작업 스케줄러용)
//
// 설계
// - 작업 스케줄러가 이 스크립트(부모)를 매일 1회 실행.
// - 부모는 노심에 1회 로그인 → 세션 토큰 확보 → GET /api/stores 로 노심 전체 매장을
//   동적으로 받아 "하나씩 순차" 처리. 매장당 등록된 배달/POS 계정만 골라 수집하고,
//   배달/POS 계정이 없는 매장은 자동 skip. → 노심 UI 에서 계정만 추가하면 자동 반영
//   (config 에 매장·플랫폼 하드코딩 불필요). config.stores 가 있으면 그 매장만 override.
// - 매장마다 독립 자식 프로세스(node collect-stores.js --store=...)를 띄워 OS 레벨 고립.
//   → 한 매장 수집이 다음 매장에 영향(쿠키/상태 잔존)을 못 줌.
// - 자식은 자기 매장의 플랫폼 계정을 노심 API 로 fetch → 플랫폼을 순차 수집(PocRunner).
//   - baemin: 매장별 stable user-data-dir(~/.poc-baemin-session-<id8>) 로 세션 격리.
//     공유하면 첫 매장 세션 재사용 → 잘못된 shopId(2026-05-16 발견). 반드시 매장별 분리.
//   - coupangeats: --show 필요(Akamai 봇감지 회피). 화면 있는 로그온 세션에서만 통과.
//
// 사용
//   node scripts/collect-stores.js                 # KST 어제, 노심 전체 매장(동적)
//   node scripts/collect-stores.js --targetDate=2026-05-24
//   node scripts/collect-stores.js --dry-run       # 로그인+계정조회만, electron 안 띄움
//   node scripts/collect-stores.js --store=<uuid> --name=.. --platforms=a,b --targetDate=.. \
//        --server=.. --sessionToken=..             # (내부) 부모가 자식으로 호출
//
// 비밀: NOSIM_EMAIL / NOSIM_PASSWORD 를 .env(또는 환경변수)에 둔다. 플랫폼 비번은 저장 X.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {}

const PocRunner = require('./poc-runner');

// ─── 인자 파싱 ───
function getArg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

// ─── 로깅 (콘솔 + 일자별 파일) ───
const LOG_DIR = path.join(__dirname, '..', 'collect-logs');
let LOG_FILE = null;
function setLogFile(targetDate) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  LOG_FILE = path.join(LOG_DIR, `collect-${targetDate}.log`);
}
function log(msg) {
  const line = String(msg);
  console.log(line);
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {} }
}

// ─── 날짜 유틸 (KST) ───
function kstYesterday() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() - 1);
  return kst.toISOString().slice(0, 10);
}
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

// ─── config ───
function loadConfig() {
  const p = path.join(__dirname, 'collect-stores.config.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.serverUrl = process.env.NOSIM_SERVER_URL || cfg.serverUrl;
  return cfg;
}

// ─── 노심 API ───
async function nosimLogin(serverUrl, email, password) {
  const res = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`노심 로그인 실패 (HTTP ${res.status})`);
  const cookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : null)
    || [res.headers.get('set-cookie') || ''];
  for (const c of cookies) {
    const m = (c || '').match(/session-token=([^;]+)/);
    if (m) return m[1];
  }
  throw new Error('응답에서 session-token 을 찾지 못함');
}

// 노심 전체 매장 목록 조회 (system_admin 계정으로 호출 시 전체 매장 반환).
// 수집 대상 매장을 config 하드코딩 대신 노심에서 동적으로 가져온다.
async function fetchCollectStores(serverUrl, token) {
  const res = await fetch(`${serverUrl}/api/stores`, { headers: { Cookie: `session-token=${token}` } });
  if (!res.ok) throw new Error(`매장 목록 조회 실패 (HTTP ${res.status})`);
  const data = await res.json();
  return (data.data || [])
    .filter((s) => s && s.id)
    .map((s) => ({ storeId: s.id, name: s.name || String(s.id).slice(0, 8) }));
}

async function fetchStoreCredentials(serverUrl, storeId, token) {
  const url = `${serverUrl}/api/suppliers/platform-accounts?storeId=${encodeURIComponent(storeId)}&withCredentials=true`;
  const res = await fetch(url, { headers: { Cookie: `session-token=${token}` } });
  if (!res.ok) throw new Error(`계정 조회 실패 (HTTP ${res.status})`);
  const data = await res.json();
  const creds = {};
  (data.data || []).forEach((p) => {
    if (p.loginId) creds[p.platform] = { id: p.loginId, pw: p.loginPassword || '', registered: !!p.registered };
  });
  return creds;
}

// sync-status 가 인정하는 날짜기반 플랫폼
const DATE_PLATFORMS = ['baemin', 'yogiyo', 'coupangeats', 'ddangyoyo', 'okpos'];

// targetDate 기준 이미 수집 완료된 플랫폼 Set 반환 (sync-status).
// 실패 시 빈 Set → 전부 수집 시도(안전). 30분 반복 실행 시 미수집만 골라내는 데 사용.
async function fetchSyncedPlatforms(serverUrl, storeId, platforms, targetDate, token) {
  if (!platforms.length) return new Set();
  const url = `${serverUrl}/api/stores/${encodeURIComponent(storeId)}/crawler/sync-status`
    + `?sources=${platforms.join(',')}&startDate=${targetDate}&endDate=${targetDate}`;
  try {
    const res = await fetch(url, { headers: { Cookie: `session-token=${token}` } });
    if (!res.ok) return new Set();
    const synced = (await res.json()).syncedDates || {};
    const done = new Set();
    for (const p of platforms) {
      if ((synced[p] || []).includes(targetDate)) done.add(p);
    }
    return done;
  } catch {
    return new Set();
  }
}

// ─── PocRunner 플랫폼별 옵션 ───
function pocOptionsFor(platform, storeId) {
  const opts = {};
  if (platform === 'baemin') {
    // 매장별 stable dir — 교차오염 방지
    opts.userDataDir = path.join(os.homedir(), `.poc-baemin-session-${String(storeId).slice(0, 8)}`);
  }
  if (platform === 'coupangeats') {
    opts.show = true; // Akamai 회피
  }
  return opts;
}

function sumOrders(resultMsg) {
  if (!resultMsg || !Array.isArray(resultMsg.shops)) return null;
  return resultMsg.shops.reduce((acc, s) => acc + (s.totalOrders || 0), 0);
}

// ─── 자식: 한 매장의 플랫폼들을 순차 수집 ───
async function runStore({ serverUrl, storeId, storeName, platforms, targetDate, token }) {
  log(`  계정 조회: ${storeName}`);
  let creds;
  try {
    creds = await fetchStoreCredentials(serverUrl, storeId, token);
  } catch (err) {
    log(`  ❌ 계정 조회 실패 — ${err.message}`);
    return 1;
  }

  let hadFailure = false;
  for (const platform of platforms) {
    const cred = creds[platform];
    if (!cred || !cred.id || !cred.pw) {
      log(`  ⏭ ${platform} — 인증정보 없음, skip`);
      continue;
    }

    let resultMsg = null;
    let lastError = null;
    const runner = new PocRunner(platform, {
      onStatus: () => {},
      onResult: (m) => { resultMsg = m; },
      onError: (m) => { lastError = m?.error || 'unknown'; },
    });

    log(`  ▶ ${platform} (loginId=${cred.id})`);
    try {
      const r = await runner.run(cred.id, cred.pw, {
        mode: 'daily',
        targetDate,
        salesKeeper: { apiBaseUrl: serverUrl, salesKeeperStoreId: storeId, sessionToken: token },
        ...pocOptionsFor(platform, storeId),
      });
      const orders = sumOrders(r || resultMsg);
      log(`  ✅ ${platform} — ${orders == null ? '완료' : orders + ' orders'}`);
    } catch (err) {
      hadFailure = true;
      log(`  ❌ ${platform} — ${lastError || err.message}`);
    } finally {
      runner.destroy();
    }
  }
  return hadFailure ? 1 : 0;
}

// ─── 부모: 매장 순차 (각 매장 독립 자식 프로세스) ───
function spawnStoreChild(store, { serverUrl, targetDate, token }) {
  const args = [
    __filename,
    `--store=${store.storeId}`,
    `--name=${store.name}`,
    `--platforms=${store.platforms.join(',')}`,
    `--targetDate=${targetDate}`,
    `--server=${serverUrl}`,
    `--sessionToken=${token}`,
  ];
  return spawn(process.execPath, args, { stdio: 'inherit' });
}
function waitExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code == null ? 1 : code)));
}

async function runAll({ dryRun }) {
  const cfg = loadConfig();
  // --today: 당일(오늘) 실시간 수집. 없으면 어제(백필).
  const targetDate = getArg('targetDate') || (hasFlag('today') ? kstToday() : kstYesterday());
  const isToday = targetDate === kstToday();
  setLogFile(targetDate);

  const email = process.env.NOSIM_EMAIL;
  const password = process.env.NOSIM_PASSWORD;
  if (!email || !password) {
    log('❌ NOSIM_EMAIL / NOSIM_PASSWORD 미설정 — .env 또는 환경변수에 노심 계정을 넣으세요.');
    process.exit(2);
  }

  log('════════════════════════════════════════');
  log(`  매장별 매출 자동 수집  (target=${targetDate}${isToday ? ' [당일 실시간]' : ''}, KST ${kstNow()})${dryRun ? '  [DRY-RUN]' : ''}`);
  log('════════════════════════════════════════');

  let token;
  try {
    token = await nosimLogin(cfg.serverUrl, email, password);
    log(`✅ 노심 로그인 (token ${token.slice(0, 12)}***)`);
  } catch (err) {
    log(`❌ ${err.message}`);
    process.exit(2);
  }

  // 수집 대상 매장 = 노심 전체 매장 (동적). UI 에서 배달/POS 계정만 추가하면 자동 포함.
  // config.stores 가 있으면 그 매장만 대상 (긴급/테스트용 override).
  let stores;
  try {
    stores = await fetchCollectStores(cfg.serverUrl, token);
  } catch (err) {
    log(`❌ ${err.message}`);
    process.exit(2);
  }
  if (Array.isArray(cfg.stores) && cfg.stores.length) {
    const allow = new Set(cfg.stores.map((s) => s.storeId));
    stores = stores.filter((s) => allow.has(s.storeId));
    log(`  config override 적용 — 대상 ${stores.length}곳`);
  }
  log(`  노심 매장 ${stores.length}곳 점검 (배달/POS 계정 등록된 매장만 수집)`);

  const summary = [];
  const skippedNoAccount = [];
  for (const store of stores) {
    // 매장에 노심 UI 로 등록된 배달/POS 계정만 동적으로 수집 (config 하드코딩 제거).
    let creds;
    try {
      creds = await fetchStoreCredentials(cfg.serverUrl, store.storeId, token);
    } catch (err) {
      log(`\n━━━ ${store.name} (${store.storeId.slice(0, 8)}) ━━━\n  ❌ 계정 조회 실패 — ${err.message}`);
      summary.push({ store: store.name, code: 1 });
      continue;
    }
    const platforms = Object.keys(creds).filter((p) => DATE_PLATFORMS.includes(p) && creds[p].id && creds[p].pw);
    if (platforms.length === 0) {
      skippedNoAccount.push(store.name);
      continue;
    }

    // 당일(오늘)은 새 주문 흡수 위해 항상 재수집(skip 안 함, 중복은 노심 upsert 가 방지).
    // 과거 날짜는 이미 수집된 플랫폼 skip — 미수집만 재시도(30분 반복 대비).
    const done = isToday ? new Set() : await fetchSyncedPlatforms(cfg.serverUrl, store.storeId, platforms, targetDate, token);
    const remaining = platforms.filter((p) => !done.has(p));

    log(`\n━━━ ${store.name} (${store.storeId.slice(0, 8)}) — 등록: ${platforms.join(', ')} / 대상: ${remaining.length ? remaining.join(', ') : '없음 (이미 수집 완료)'} ━━━`);
    if (done.size) log(`  ✓ 이미 수집됨: ${[...done].join(', ')}`);

    if (remaining.length === 0) {
      summary.push({ store: store.name, code: 0, skipped: true });
      continue;
    }

    if (dryRun) {
      remaining.forEach((p) => log(`  · ${p}: 수집 예정 (loginId=${creds[p].id})`));
      summary.push({ store: store.name, code: 0 });
      continue;
    }

    const child = spawnStoreChild({ ...store, platforms: remaining }, { serverUrl: cfg.serverUrl, targetDate, token });
    const code = await waitExit(child);
    summary.push({ store: store.name, code });
  }

  if (skippedNoAccount.length) {
    log(`\n  · 배달/POS 미등록 ${skippedNoAccount.length}곳 skip`);
  }

  log('\n──────────── 요약 ────────────');
  summary.forEach((s) => {
    const mark = s.skipped ? '✓' : (s.code === 0 ? '✅' : '❌');
    const note = s.skipped ? ' (이미 완료)' : (s.code === 0 ? '' : ` (exit ${s.code})`);
    log(`  ${mark} ${s.store}${note}`);
  });
  const anyFail = summary.some((s) => s.code !== 0);
  log(`\n${anyFail ? '⚠️  일부 매장 실패' : '🎉 전 매장 완료'}  (로그: ${LOG_FILE})`);
  process.exit(anyFail ? 1 : 0);
}

// ─── 엔트리 ───
async function main() {
  const storeId = getArg('store');
  if (storeId) {
    // 자식 모드
    const targetDate = getArg('targetDate') || kstYesterday();
    setLogFile(targetDate);
    const code = await runStore({
      serverUrl: getArg('server'),
      storeId,
      storeName: getArg('name') || storeId.slice(0, 8),
      platforms: (getArg('platforms') || '').split(',').filter(Boolean),
      targetDate,
      token: getArg('sessionToken'),
    });
    process.exit(code);
  }
  // 부모 모드
  await runAll({ dryRun: hasFlag('dry-run') });
}

main().catch((err) => {
  log(`❌ 예기치 못한 오류: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
