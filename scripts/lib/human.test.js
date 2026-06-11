'use strict';
// node --test scripts/lib/human.test.js
const test = require('node:test');
const assert = require('node:assert');
const h = require('./human');

test('rnd — [min,max) 범위, 정수', () => {
  for (let i = 0; i < 500; i++) {
    const v = h.rnd(10, 20);
    assert.ok(v >= 10 && v < 20, `out of range: ${v}`);
    assert.strictEqual(v, Math.floor(v));
  }
  // max<=min 방어
  assert.strictEqual(h.rnd(5, 5), 5);
  assert.strictEqual(h.rnd(8, 3), 8);
});

test('jitter — base ±pct 범위, 음수 없음', () => {
  for (let i = 0; i < 500; i++) {
    const v = h.jitter(1000, 0.2);
    assert.ok(v >= 800 && v <= 1200, `out of range: ${v}`);
  }
  // 작은 base 도 0 밑으로 안 감
  for (let i = 0; i < 200; i++) {
    assert.ok(h.jitter(50, 0.5) >= 0);
  }
});

test('buildUserAgent — Windows 는 Win64, Mac UA 하드코딩 안 함', () => {
  const win = h.buildUserAgent('win32', '120.0.6099.291');
  assert.ok(win.includes('Windows NT 10.0; Win64; x64'), win);
  assert.ok(!win.includes('Macintosh'), '윈도우인데 Mac UA 면 불일치 신호');
  assert.ok(win.includes('Chrome/120.0.0.0'), win); // 실버전 메이저 + 관례상 .0.0.0
  assert.ok(!/Electron/i.test(win), 'Electron 토큰은 봇신호 — 없어야 함');
});

test('buildUserAgent — darwin/linux/누락 처리', () => {
  assert.ok(h.buildUserAgent('darwin', '124.0.0.0').includes('Macintosh'));
  assert.ok(h.buildUserAgent('linux', '124.0.0.0').includes('Linux'));
  // chromeVersion 누락/이상 → 안전 기본값
  assert.ok(h.buildUserAgent('win32', '').includes('Chrome/120.0.0.0'));
  assert.ok(h.buildUserAgent('win32', undefined).includes('Chrome/120.0.0.0'));
});

test('typingDelays — 길이만큼, 모두 양수, 0ms 연타 없음', () => {
  const seq = h.typingDelays(12);
  assert.strictEqual(seq.length, 12);
  assert.ok(seq.every((d) => d >= 70), '70ms 미만 키 간격은 초인적');
  // 결정적 randomFn 으로 망설임 가산 검증 (항상 <0.08 → 매 글자 가산)
  const always = h.typingDelays(3, () => 0); // 0 < 0.08 → 가산, floor(0*..)=0
  assert.deepStrictEqual(always, [220, 220, 220]); // 70+0 +150+0
});
