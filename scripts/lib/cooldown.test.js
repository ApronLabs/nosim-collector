'use strict';
// node --test scripts/lib/cooldown.test.js
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const cd = require('./cooldown');

const MIN = 60 * 1000;

test('appliesTo — 쿠팡만 쿨다운 대상', () => {
  assert.strictEqual(cd.appliesTo('coupangeats'), true);
  assert.strictEqual(cd.appliesTo('baemin'), false);
  assert.strictEqual(cd.appliesTo('okpos'), false);
});

test('isThrottleError — throttle/봇감지 신호만 true', () => {
  assert.strictEqual(cd.isThrottleError('해당하는 요청을 처리할 권한이 존재하지 않습니다'), true);
  assert.strictEqual(cd.isThrottleError('매장 목록을 불러오지 못했습니다'), true);
  assert.strictEqual(cd.isThrottleError('Akamai throttle: 매장 페이지 조회 차단'), true);
  // 단순 만료/0건은 전역 차단 신호 아님
  assert.strictEqual(cd.isThrottleError('세션 만료 — 재인증 필요'), false);
  assert.strictEqual(cd.isThrottleError(''), false);
  assert.strictEqual(cd.isThrottleError(null), false);
});

test('전역(GLOBAL) 쿨다운 — 한 계정 throttle → 모든 쿠팡 정지', () => {
  const now = 0;
  const st = {};
  // 매장 A throttle → 전역 쿨다운 기록
  cd.recordFailure(st, cd.GLOBAL_STORE, 'coupangeats', now, 'throttle');
  // 매장 B(다른 storeId)도 전역 쿨다운에 걸려야 함
  assert.ok(cd.coolingUntil(st, cd.GLOBAL_STORE, 'coupangeats', now));
  assert.strictEqual(cd.coolingUntil(st, cd.GLOBAL_STORE, 'coupangeats', now), now + 40 * MIN);
});

test('nextBackoffMs — 점증 + 상한', () => {
  assert.strictEqual(cd.nextBackoffMs(1), 40 * MIN);
  assert.strictEqual(cd.nextBackoffMs(2), 80 * MIN);
  assert.strictEqual(cd.nextBackoffMs(3), 160 * MIN);
  assert.strictEqual(cd.nextBackoffMs(4), cd.MAX_MS); // 320분 > 상한 180분
  assert.strictEqual(cd.nextBackoffMs(99), cd.MAX_MS);
});

test('recordFailure → coolingUntil 가 미래로 설정', () => {
  const now = 1_000_000;
  const st = {};
  cd.recordFailure(st, 'store-aaaa-1111', 'coupangeats', now, '로그인 잔류');
  const until = cd.coolingUntil(st, 'store-aaaa-1111', 'coupangeats', now);
  assert.strictEqual(until, now + 40 * MIN);
  // 쿨다운 만료 후엔 null
  assert.strictEqual(cd.coolingUntil(st, 'store-aaaa-1111', 'coupangeats', now + 41 * MIN), null);
});

test('연속 실패는 backoff 가 2배씩', () => {
  const now = 0;
  const st = {};
  cd.recordFailure(st, 's', 'coupangeats', now, 'e');
  cd.recordFailure(st, 's', 'coupangeats', now, 'e');
  const until = cd.coolingUntil(st, 's', 'coupangeats', now);
  assert.strictEqual(until, now + 80 * MIN); // 2회째 = 80분
});

test('recordSuccess → 쿨다운 해제', () => {
  const now = 0;
  const st = {};
  cd.recordFailure(st, 's', 'coupangeats', now, 'e');
  assert.ok(cd.coolingUntil(st, 's', 'coupangeats', now));
  cd.recordSuccess(st, 's', 'coupangeats');
  assert.strictEqual(cd.coolingUntil(st, 's', 'coupangeats', now), null);
});

test('load/save 라운드트립 + 깨진 파일은 빈 객체', () => {
  const f = path.join(os.tmpdir(), `cd-test-${process.pid}.json`);
  try {
    const st = {};
    cd.recordFailure(st, 's', 'coupangeats', 5, 'e');
    cd.saveState(st, f);
    const loaded = cd.loadState(f);
    assert.deepStrictEqual(loaded, st);
    fs.writeFileSync(f, '{ not json');
    assert.deepStrictEqual(cd.loadState(f), {});
  } finally {
    try { fs.unlinkSync(f); } catch {}
  }
});

test('recordSuccess — lastSuccessAt 보존 + backoff 리셋', () => {
  const now = 1_000_000;
  const st = {};
  cd.recordFailure(st, 's', 'coupangeats', now, 'e');
  cd.recordSuccess(st, 's', 'coupangeats', now + 10 * MIN);
  // 쿨다운은 해제되고
  assert.strictEqual(cd.coolingUntil(st, 's', 'coupangeats', now + 10 * MIN), null);
  // 성공 시각은 남는다
  assert.strictEqual(st[cd.keyOf('s', 'coupangeats')].lastSuccessAt, now + 10 * MIN);
  // 성공 후 첫 실패는 backoff 1회차(40분)부터 다시 시작
  cd.recordFailure(st, 's', 'coupangeats', now + 20 * MIN, 'e');
  assert.strictEqual(cd.coolingUntil(st, 's', 'coupangeats', now + 20 * MIN), now + 20 * MIN + 40 * MIN);
});

test('successIntervalUntil — 성공 후 간격 이내면 다음 허용 시각, 지나면 null', () => {
  const now = 0;
  const ivMs = 3 * 60 * MIN; // 3시간
  const st = {};
  // 기록 없음 → 즉시 허용
  assert.strictEqual(cd.successIntervalUntil(st, 's', 'coupangeats', now, ivMs), null);
  cd.recordSuccess(st, 's', 'coupangeats', now);
  // 간격 이내 → skip (다음 허용 시각 반환)
  assert.strictEqual(cd.successIntervalUntil(st, 's', 'coupangeats', now + 30 * MIN, ivMs), now + ivMs);
  // 간격 경과 → 허용
  assert.strictEqual(cd.successIntervalUntil(st, 's', 'coupangeats', now + ivMs, ivMs), null);
  // interval 0/null → 비활성 (기존처럼 매 실행 수집)
  assert.strictEqual(cd.successIntervalUntil(st, 's', 'coupangeats', now + 1, 0), null);
  assert.strictEqual(cd.successIntervalUntil(st, 's', 'coupangeats', now + 1, null), null);
});

test('successIntervalUntil — 실패가 끼면 lastSuccessAt 이 사라져 간격 미적용(쿨다운이 우선)', () => {
  const now = 0;
  const ivMs = 3 * 60 * MIN;
  const st = {};
  cd.recordSuccess(st, 's', 'coupangeats', now);
  cd.recordFailure(st, 's', 'coupangeats', now + 10 * MIN, 'e');
  assert.strictEqual(cd.successIntervalUntil(st, 's', 'coupangeats', now + 20 * MIN, ivMs), null);
  assert.ok(cd.coolingUntil(st, 's', 'coupangeats', now + 20 * MIN));
});
