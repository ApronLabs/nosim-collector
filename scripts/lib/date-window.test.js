'use strict';
// node --test scripts/lib/date-window.test.js
const test = require('node:test');
const assert = require('node:assert');
const { recentDaysRange } = require('./date-window');

test('days=1 → 당일만 (start=end=targetDate, 기존 동작 역호환)', () => {
  assert.deepStrictEqual(recentDaysRange('2026-06-20', 1), {
    startDate: '2026-06-20',
    endDate: '2026-06-20',
  });
});

test('days=3 → 최근 3일 (정산 backfill 윈도우)', () => {
  assert.deepStrictEqual(recentDaysRange('2026-06-20', 3), {
    startDate: '2026-06-18',
    endDate: '2026-06-20',
  });
});

test('월 경계를 넘는 윈도우', () => {
  assert.deepStrictEqual(recentDaysRange('2026-06-01', 3), {
    startDate: '2026-05-30',
    endDate: '2026-06-01',
  });
});

test('2월 경계 (2026 비윤년 — 2월 28일)', () => {
  assert.deepStrictEqual(recentDaysRange('2026-03-01', 3), {
    startDate: '2026-02-27',
    endDate: '2026-03-01',
  });
});

test('연 경계', () => {
  assert.deepStrictEqual(recentDaysRange('2026-01-01', 3), {
    startDate: '2025-12-30',
    endDate: '2026-01-01',
  });
});

test('days 미지정/0/음수 → 당일만 (방어적 폴백)', () => {
  const expected = { startDate: '2026-06-20', endDate: '2026-06-20' };
  assert.deepStrictEqual(recentDaysRange('2026-06-20'), expected);
  assert.deepStrictEqual(recentDaysRange('2026-06-20', 0), expected);
  assert.deepStrictEqual(recentDaysRange('2026-06-20', -5), expected);
});

test('잘못된 targetDate → throw', () => {
  assert.throws(() => recentDaysRange('', 3));
  assert.throws(() => recentDaysRange('not-a-date', 3));
});
