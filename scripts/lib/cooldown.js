'use strict';
// 플랫폼별 수집 쿨다운(backoff) 상태.
//
// 배경: 작업 스케줄러가 collect-stores.js 를 30분마다 돌리는데, 쿠팡이츠는 로그인
// 실패(세션만료/Akamai 봇감지) 시에도 매 실행마다 다시 로그인을 시도한다. 박제된
// 사실: "짧은 시간에 쿠팡 로그인을 여러 번 두드리면 Akamai 가 차단" → 무한 재시도가
// 차단을 푸는 게 아니라 고착시킨다(2026-06-01 유신·정릉 5일 무음 사고).
//
// 그래서 실패하면 점증 backoff(기본 40분 → ×2 → 상한 3시간)를 걸고, 그 시간 전에는
// 자동 실행에서 해당 (매장,플랫폼)을 건너뛴다. 성공하면 즉시 해제.
// 수동 백필(--targetDate)·--force 는 쿨다운을 무시(사장님이 재로그인 직후 즉시 재수집).

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(os.homedir(), '.collect-stores-cooldown.json');

// 쿨다운 적용 플랫폼 — 레이트리밋/봇감지에 민감한 것만. 배민/요기요/땡겨요/OKPOS 는
// 기존대로 매 실행 재시도(난타해도 차단 안 됨).
const COOLDOWN_PLATFORMS = new Set(['coupangeats']);

const BASE_MS = 40 * 60 * 1000; // 40분 (박제: "40분 쉬고 실패 날짜만 재시도")
const MAX_MS = 3 * 60 * 60 * 1000; // 상한 3시간
const FACTOR = 2;

// IP 전역 쿨다운용 의사(pseudo) store 키 — 한 계정이라도 throttle 나면 그 실행의 모든 쿠팡 정지.
const GLOBAL_STORE = '__global__';

// throttle/봇감지 신호 (단순 0건·세션만료와 구분 — 이게 뜨면 IP 전역 쿨다운을 건다).
const THROTTLE_PATTERNS = [
  '권한이 존재하지 않', // Akamai 로그인 차단
  '매장 목록을 불러오지', // 매장 페이지 throttle
  '페이지가 작동하지', // 페이지 오류
  'throttle',
  'Akamai',
];
function isThrottleError(msg) {
  const s = String(msg == null ? '' : msg);
  return THROTTLE_PATTERNS.some((p) => s.includes(p));
}

function appliesTo(platform) {
  return COOLDOWN_PLATFORMS.has(platform);
}

function keyOf(storeId, platform) {
  return `${String(storeId).slice(0, 8)}|${platform}`;
}

// ─── 순수 함수 (테스트 대상) ───

/** 연속 실패 n회째의 backoff(ms). 1회=BASE, 2회=BASE×2 … 상한 MAX. */
function nextBackoffMs(failCount, base = BASE_MS, factor = FACTOR, max = MAX_MS) {
  const n = Math.max(1, failCount);
  return Math.min(base * Math.pow(factor, n - 1), max);
}

/** 쿨다운 중이면 해제 예정 epoch(ms), 아니면 null. */
function coolingUntil(state, storeId, platform, nowMs) {
  const e = state && state[keyOf(storeId, platform)];
  if (!e || !e.until) return null;
  return e.until > nowMs ? e.until : null;
}

/** 실패 기록: failCount++ 및 until 갱신. state 를 변형하고 반환. */
function recordFailure(state, storeId, platform, nowMs, errorMsg) {
  const k = keyOf(storeId, platform);
  const prev = state[k] || {};
  const failCount = (prev.failCount || 0) + 1;
  state[k] = {
    failCount,
    until: nowMs + nextBackoffMs(failCount),
    lastError: String(errorMsg == null ? '' : errorMsg).slice(0, 200),
    updatedAt: nowMs,
  };
  return state;
}

/** 성공 기록: 쿨다운 해제 + 마지막 성공 시각 보존(수집 간격 판단용). */
function recordSuccess(state, storeId, platform, nowMs) {
  state[keyOf(storeId, platform)] = { lastSuccessAt: nowMs == null ? Date.now() : nowMs };
  return state;
}

/**
 * 최근 성공 후 최소 간격(intervalMs)이 안 지났으면 다음 허용 epoch(ms), 지났으면 null.
 *
 * 목적: 쿠팡 Akamai 노출 감소. 세션이 살아 있어도 30분마다 방문(하루 48회)하면
 * rate 신호가 쌓인다 — 성공 후 N시간은 재방문을 건너뛰어 하루 ~8회로 줄인다.
 * 실패 상태(recordFailure 가 키를 덮어씀)에선 lastSuccessAt 이 없어 적용 안 됨
 * (backoff 쿨다운이 우선). 수동 백필/--force 는 호출부에서 무시.
 */
function successIntervalUntil(state, storeId, platform, nowMs, intervalMs) {
  if (!intervalMs || intervalMs <= 0) return null;
  const e = state && state[keyOf(storeId, platform)];
  if (!e || e.lastSuccessAt == null) return null;
  const until = e.lastSuccessAt + intervalMs;
  return until > nowMs ? until : null;
}

// ─── 파일 IO ───

function loadState(file = STATE_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveState(state, file = STATE_FILE) {
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    /* 상태 저장 실패는 수집을 막지 않는다 */
  }
}

module.exports = {
  STATE_FILE,
  COOLDOWN_PLATFORMS,
  BASE_MS,
  MAX_MS,
  FACTOR,
  GLOBAL_STORE,
  THROTTLE_PATTERNS,
  isThrottleError,
  appliesTo,
  keyOf,
  nextBackoffMs,
  coolingUntil,
  successIntervalUntil,
  recordFailure,
  recordSuccess,
  loadState,
  saveState,
};
