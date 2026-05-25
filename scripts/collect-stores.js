#!/usr/bin/env node
// 매장별 매출 자동 수집 오케스트레이터 (무인 PC + 작업 스케줄러용)
//
// 설계
// - 작업 스케줄러가 이 스크립트(부모)를 매일 1회 실행.
// - 부모는 노심에 1회 로그인 → 세션 토큰 확보 → config 의 매장을 "하나씩 순차" 처리.
// - 매장마다 독립 자식 프로세스(node collect-stores.js --store=...)를 띄워 OS 레벨 고립.
//   → 한 매장 수집이 다음 매장에 영향(쿠키/상태 잔존)을 못 줌.
// - 자식은 자기 매장의 플랫폼 계정을 노심 API 로 fetch → 플랫폼을 순차 수집(PocRunner).
//   - baemin: 매장별 stable user-data-dir(~/.poc-baemin-session-<id8>) 로 세션 격리.
//     공유하면 첫 매장 세션 재사용 → 잘못된 shopId(2026-05-16 발견). 반드시 매장별 분리.
//   - coupangeats: --show 필요(Akamai 봇감지 회피). 화면 있는 로그온 세션에서만 통과.
//
// 사용
//   node scripts/collect-stores.js                 # KST 어제, config 전체 매장
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
  const targetDate = getArg('targetDate') || kstYesterday();
  setLogFile(targetDate);

  const email = process.env.NOSIM_EMAIL;
  const password = process.env.NOSIM_PASSWORD;
  if (!email || !password) {
    log('❌ NOSIM_EMAIL / NOSIM_PASSWORD 미설정 — .env 또는 환경변수에 노심 계정을 넣으세요.');
    process.exit(2);
  }

  log('════════════════════════════════════════');
  log(`  매장별 매출 자동 수집  (target=${targetDate}, KST ${kstNow()})`);
  log(`  대상 매장 ${cfg.stores.length}곳${dryRun ? '  [DRY-RUN]' : ''}`);
  log('════════════════════════════════════════');

  let token;
  try {
    token = await nosimLogin(cfg.serverUrl, email, password);
    log(`✅ 노심 로그인 (token ${token.slice(0, 12)}***)`);
  } catch (err) {
    log(`❌ ${err.message}`);
    process.exit(2);
  }

  const summary = [];
  for (const store of cfg.stores) {
    log(`\n━━━ ${store.name} (${store.storeId.slice(0, 8)}) — ${store.platforms.join(', ')} ━━━`);
    if (dryRun) {
      try {
        const creds = await fetchStoreCredentials(cfg.serverUrl, store.storeId, token);
        const lines = store.platforms.map((p) => {
          const c = creds[p];
          return c && c.id && c.pw ? `  · ${p}: 수집 예정 (loginId=${c.id})` : `  · ${p}: ⏭ 인증정보 없음`;
        });
        lines.forEach(log);
        summary.push({ store: store.name, code: 0 });
      } catch (err) {
        log(`  ❌ 계정 조회 실패 — ${err.message}`);
        summary.push({ store: store.name, code: 1 });
      }
      continue;
    }
    const child = spawnStoreChild(store, { serverUrl: cfg.serverUrl, targetDate, token });
    const code = await waitExit(child);
    summary.push({ store: store.name, code });
  }

  log('\n──────────── 요약 ────────────');
  summary.forEach((s) => log(`  ${s.code === 0 ? '✅' : '❌'} ${s.store}${s.code === 0 ? '' : ` (exit ${s.code})`}`));
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
