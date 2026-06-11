#!/usr/bin/env node
// 매장별 매출 자동 수집 오케스트레이터 (무인 PC + 작업 스케줄러용)
//
// 설계
// - 작업 스케줄러가 이 스크립트(부모)를 30분마다(24시간) 실행. 매장별 영업일 기준 현재 영업일을 매번 재수집.
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
//   node scripts/collect-stores.js                 # 매장별 영업일(현재) 자동 수집, 노심 전체 매장(동적)
//   node scripts/collect-stores.js --targetDate=2026-05-24   # 전 매장 그 날짜로 강제(수동 백필)
//   node scripts/collect-stores.js --dry-run       # 로그인+계정조회만, electron 안 띄움
//   node scripts/collect-stores.js --force         # 쿠팡 backoff 쿨다운 무시(재로그인 직후 즉시 재수집)
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
const cooldown = require('./lib/cooldown');
const { sumOrders } = require('./lib/result-count');

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
// 영업일 cutoff(시) — 노심 lib/business-day.ts 와 동일 규약.
//   - 자정 이후 마감(h < 12, 예 "02:00")  → cutoff = h + 1  (02:00 → 3: 마감 후 1시간 여유까지 같은 영업일)
//   - 자정 이전 마감(h >= 12) / 미설정      → cutoff = 0  (KST 달력일 그대로)
// closingStr: "/api/stores" 의 closing_time ("HH:MM" 또는 null).
function getCutoffHour(closingStr) {
  if (!closingStr) return 0;
  const h = parseInt(String(closingStr).split(':')[0], 10);
  if (!Number.isFinite(h)) return 0;
  return h < 12 ? h + 1 : 0;
}
// 지금(now) 이 속한 매장 영업일을 YYYY-MM-DD(KST)로. cutoff 전이면 전날 영업일.
// 예) 월하화(cutoff 3): KST 5/31 02:30 → "2026-05-30" (마감 02:00 후에도 03:00까지 5/30 으로 수집).
function businessDateStr(now, cutoffHour) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  if (cutoffHour > 0 && kst.getUTCHours() < cutoffHour) {
    kst.setUTCDate(kst.getUTCDate() - 1);
  }
  return kst.toISOString().slice(0, 10);
}
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
function kstHm(epochMs) {
  return new Date(epochMs + 9 * 3600 * 1000).toISOString().slice(11, 16);
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
    .map((s) => ({ storeId: s.id, name: s.name || String(s.id).slice(0, 8), closingTime: s.closing_time || null }));
}

// 수집 실패를 노심에 즉시 보고 (노심 PR #1674 report-failure 라우트).
// 로그인 단계 실패는 ingest 에 도달하지 못해 노심 흔적이 0 이던 빈틈
// (2026-06-01 쿠팡 5일 무음)을 막는다 — 노심이 crawler_sync_logs 에 failed 를
// 남기고 Slack #크롤링-보고 로 알림(매장×플랫폼 6시간 dedupe 는 서버가 처리).
async function reportFailure({ serverUrl, token, storeId, platform, targetDate, reason, throttle }) {
  try {
    await fetch(`${serverUrl}/api/stores/${encodeURIComponent(storeId)}/crawler/report-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `session-token=${token}` },
      body: JSON.stringify({
        platform,
        targetDate,
        error: String(reason == null ? '' : reason).slice(0, 500),
        throttle: !!throttle,
      }),
    });
  } catch {
    /* 보고 실패가 수집을 막지 않는다 */
  }
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

// 날짜기반(영업일 합계/주문) 수집 플랫폼
const DATE_PLATFORMS = ['baemin', 'yogiyo', 'coupangeats', 'ddangyoyo', 'okpos'];

// ─── PocRunner 플랫폼별 옵션 ───
function pocOptionsFor(platform, storeId) {
  const opts = {};
  if (platform === 'baemin') {
    // 매장별 stable dir — 교차오염 방지
    opts.userDataDir = path.join(os.homedir(), `.poc-baemin-session-${String(storeId).slice(0, 8)}`);
  }
  if (platform === 'coupangeats') {
    // 매장별 stable dir — 세션 영속 + 계정 교차오염 방지(baemin 과 동일).
    // 살아있는 세션 재사용으로 봇감지 회피. 세션 만료 시 --show 창에서 1회 수동 로그인.
    opts.userDataDir = path.join(os.homedir(), `.poc-coupangeats-session-${String(storeId).slice(0, 8)}`);
    opts.show = true; // Akamai 회피 + 세션 만료 시 수동 로그인 창
    // --inspect-coupang: 주문페이지 DOM/자체 XHR 덤프(coupang-inspect.txt). UI-구동 수집 설계용.
    if (hasFlag('inspect-coupang')) opts.inspect = true;
    // --ui-drive: 페이지 자체 XHR 캡처 + 실제 '다음' 클릭(가장 사람다움). config.coupangUiDrive 로도 켬.
    if (hasFlag('ui-drive')) opts.uiDrive = true;
  }
  return opts;
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

    // 쿠팡 실행 전 짧은 랜덤 지연 — 작업 스케줄러의 30분 정주기 방문 패턴을
    // 흩뜨림(Akamai rate 신호 완화). 수동 백필(--manual)은 즉시 실행.
    if (platform === 'coupangeats' && !hasFlag('manual')) {
      const jitterMs = 10_000 + Math.floor(Math.random() * 50_000);
      log(`  ⏲ ${platform} 지터 ${Math.round(jitterMs / 1000)}s 대기`);
      await new Promise((r) => setTimeout(r, jitterMs));
    }

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
      // 성공 → 쿨다운 해제 + 성공 시각 기록 (수동 백필 성공도 세션 정상이므로
      // 자동 재시도 재개. 성공 시각은 쿠팡 수집 간격 판단에 사용).
      if (cooldown.appliesTo(platform)) {
        const st = cooldown.loadState();
        cooldown.recordSuccess(st, storeId, platform, Date.now());
        cooldown.saveState(st);
      }
    } catch (err) {
      hadFailure = true;
      const reason = lastError || err.message;
      const throttled = cooldown.isThrottleError(reason);
      log(`  ❌ ${platform} — ${reason}`);
      // 실패 → 점증 backoff 기록 (쿠팡 등 레이트리밋 민감 플랫폼만). 다음 자동
      // 실행은 until 전까지 이 플랫폼을 건너뛴다 → Akamai 차단 고착 방지.
      if (cooldown.appliesTo(platform)) {
        const st = cooldown.loadState();
        cooldown.recordFailure(st, storeId, platform, Date.now(), reason);
        // throttle/봇감지면 IP 전역 쿨다운 → 이번 실행의 다른 매장 쿠팡도 전부 중단(난타 방지).
        if (throttled) {
          cooldown.recordFailure(st, cooldown.GLOBAL_STORE, platform, Date.now(), 'throttle');
          log(`  🛑 ${platform} throttle 감지 — 이번 실행 모든 ${platform} 중단(IP 쿨다운)`);
        }
        cooldown.saveState(st);
        const until = cooldown.coolingUntil(st, storeId, platform, Date.now());
        if (until) log(`  ⏸ ${platform} 쿨다운 — ${kstHm(until)} KST 이후 재시도`);
      }
      // 노심에 즉시 보고 → Slack 알림. 로그인 실패도 노심에 흔적을 남긴다.
      await reportFailure({ serverUrl, token, storeId, platform, targetDate, reason, throttle: throttled });
    } finally {
      runner.destroy();
    }
  }
  return hadFailure ? 1 : 0;
}

// ─── 부모: 매장 순차 (각 매장 독립 자식 프로세스) ───
function spawnStoreChild(store, { serverUrl, targetDate, token, manual, uiDrive }) {
  const args = [
    __filename,
    `--store=${store.storeId}`,
    `--name=${store.name}`,
    `--platforms=${store.platforms.join(',')}`,
    `--targetDate=${targetDate}`,
    `--server=${serverUrl}`,
    `--sessionToken=${token}`,
    // 수동 실행(백필/--force)은 쿠팡 지터 없이 즉시 수집.
    ...(manual ? ['--manual'] : []),
    // 진단/UI-구동 플래그는 자식까지 전파 (쿠팡 워커 옵션은 자식의 pocOptionsFor 에서 결정됨).
    ...(hasFlag('inspect-coupang') ? ['--inspect-coupang'] : []),
    ...(uiDrive ? ['--ui-drive'] : []),
  ];
  return spawn(process.execPath, args, { stdio: 'inherit' });
}
function waitExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code == null ? 1 : code)));
}

async function runAll({ dryRun }) {
  const cfg = loadConfig();
  // 쿠팡 UI-구동 수집: config.coupangUiDrive 또는 --ui-drive 플래그. (백필은 워커가 raw fetch 로 처리)
  const uiDrive = hasFlag('ui-drive') || !!cfg.coupangUiDrive;
  // 매장별 영업일(closingTime cutoff) 기준으로 수집. 시간 윈도우 없이 30분마다 항상 "현재 영업일"을 재수집한다.
  // 새벽 마감 매장(월하화 02:00→cutoff 3)은 자정~03:00 에도 현재 영업일=전날 이라 마감 후에도 한 번 더
  // 수집돼 자연히 완전값으로 채워진다(별도 finalize 불필요). 중복/재수집은 노심 upsert 가 흡수.
  // --targetDate=YYYY-MM-DD 를 주면 전 매장을 그 날짜로 강제(수동 백필).
  const manualDate = getArg('targetDate') || null;
  // 수동 백필(--targetDate)·--force 는 쿨다운 무시 (재로그인 직후 즉시 재수집용).
  const ignoreCooldown = hasFlag('force') || !!manualDate;
  // 쿠팡 최소 수집 간격(시간, config coupangIntervalHours, 기본 3). 세션이 살아
  // 있어도 30분마다 방문하면 Akamai rate 신호가 쌓인다 — 성공 후 이 간격은
  // 재방문을 건너뛴다. 0 으로 두면 비활성(기존처럼 매 실행 수집).
  const coupangIntervalMs = (cfg.coupangIntervalHours == null ? 3 : cfg.coupangIntervalHours) * 3600 * 1000;
  const now = new Date();
  setLogFile(kstToday()); // 로그는 실행일(KST) 기준 1개 파일

  const email = process.env.NOSIM_EMAIL;
  const password = process.env.NOSIM_PASSWORD;
  if (!email || !password) {
    log('❌ NOSIM_EMAIL / NOSIM_PASSWORD 미설정 — .env 또는 환경변수에 노심 계정을 넣으세요.');
    process.exit(2);
  }

  log('════════════════════════════════════════');
  log(`  매장별 매출 자동 수집  (${manualDate ? `target=${manualDate} [수동 백필]` : '매장별 영업일 자동'}, KST ${kstNow()})${dryRun ? '  [DRY-RUN]' : ''}`);
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

    // 쿨다운 필터 — 직전 실패로 backoff 중인 (매장,플랫폼)은 자동 실행에서 건너뛴다.
    // (쿠팡 등 레이트리밋 민감 플랫폼만 대상. 수동/--force 는 무시.)
    const cdState = cooldown.loadState();
    const nowMs = Date.now();
    const cooling = [];
    const collectPlatforms = ignoreCooldown ? platforms : platforms.filter((p) => {
      if (!cooldown.appliesTo(p)) return true;
      // 전역(IP) 쿨다운 우선 — 직전 매장에서 throttle 났으면 이 매장 쿠팡도 skip.
      const gUntil = cooldown.coolingUntil(cdState, cooldown.GLOBAL_STORE, p, nowMs);
      const until = gUntil || cooldown.coolingUntil(cdState, store.storeId, p, nowMs);
      if (until) { cooling.push(`${p}(재시도 ${kstHm(until)} KST 이후${gUntil ? ', 전역' : ''})`); return false; }
      // 수집 간격 필터 — 최근 성공 후 최소 간격이 안 지났으면 skip (쿠팡 Akamai
      // 노출 감소: 30분×48회/일 → 간격 3h 기준 ~8회/일). 새 주문은 다음 간격
      // 회차가 같은 영업일을 재수집하며 자연 흡수(노심 upsert).
      const ivUntil = cooldown.successIntervalUntil(cdState, store.storeId, p, nowMs, p === 'coupangeats' ? coupangIntervalMs : 0);
      if (ivUntil) { cooling.push(`${p}(간격 유지, ${kstHm(ivUntil)} KST 이후)`); return false; }
      return true;
    });

    // 매장 영업일 기준 targetDate (수동 --targetDate 있으면 그 날짜로 강제 백필).
    const cutoffHour = getCutoffHour(store.closingTime);
    const targetDate = manualDate || businessDateStr(now, cutoffHour);

    // 시간 윈도우/skip 없이 항상 재수집 — 30분마다 현재 영업일 덮어쓰기(새 주문 흡수 + 마감 후 완전화).
    // 중복은 노심 upsert 가 방지. 같은 영업일이 마감(cutoff) 직후까지 유지돼 자연히 완전값이 된다.
    const cutoffNote = cutoffHour ? ` (마감 ${store.closingTime}→cutoff ${cutoffHour}시)` : '';
    log(`\n━━━ ${store.name} (${store.storeId.slice(0, 8)}) — 영업일 ${targetDate}${cutoffNote} / 수집: ${collectPlatforms.join(', ') || '(없음)'} ━━━`);
    if (cooling.length) log(`  ⏸ 쿨다운 skip: ${cooling.join(', ')}`);

    if (collectPlatforms.length === 0) {
      // 전부 쿨다운 중 — 이번 실행은 이 매장 건너뜀(요약엔 성공으로 표기, 실패 누적 아님).
      summary.push({ store: store.name, code: 0, cooling: true });
      continue;
    }

    if (dryRun) {
      collectPlatforms.forEach((p) => log(`  · ${p}: 수집 예정 (loginId=${creds[p].id})`));
      summary.push({ store: store.name, code: 0 });
      continue;
    }

    const child = spawnStoreChild({ ...store, platforms: collectPlatforms }, { serverUrl: cfg.serverUrl, targetDate, token, manual: ignoreCooldown, uiDrive });
    const code = await waitExit(child);
    summary.push({ store: store.name, code });
  }

  if (skippedNoAccount.length) {
    log(`\n  · 배달/POS 미등록 ${skippedNoAccount.length}곳 skip`);
  }

  log('\n──────────── 요약 ────────────');
  summary.forEach((s) => {
    const mark = s.cooling ? '⏸' : s.skipped ? '✓' : (s.code === 0 ? '✅' : '❌');
    const note = s.cooling ? ' (전부 쿨다운)' : s.skipped ? ' (이미 완료)' : (s.code === 0 ? '' : ` (exit ${s.code})`);
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
