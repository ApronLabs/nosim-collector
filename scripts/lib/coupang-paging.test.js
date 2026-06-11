'use strict';
// node --test scripts/lib/coupang-paging.test.js
const test = require('node:test');
const assert = require('node:assert');
const { ordersInRange, pageOldestMs, shouldStopPaging } = require('./coupang-paging');

// 실측 기반: 6/11 KST 00:00~23:59 의 ms 구간
const START = Date.UTC(2026, 5, 11, 0, 0, 0) - 9 * 3600000; // KST 6/11 00:00
const END = Date.UTC(2026, 5, 11, 23, 59, 59, 999) - 9 * 3600000;
const t = (kstHour) => Date.UTC(2026, 5, 11, kstHour, 0, 0) - 9 * 3600000; // 6/11 KST hour
const yesterday = (kstHour) => Date.UTC(2026, 5, 10, kstHour, 0, 0) - 9 * 3600000;

test('ordersInRange — target 일자만 통과', () => {
  const content = [
    { createdAt: t(19), abbrOrderId: 'a' },
    { createdAt: t(13), abbrOrderId: 'b' },
    { createdAt: yesterday(22), abbrOrderId: 'c' }, // 어제 → 제외
  ];
  const r = ordersInRange(content, START, END);
  assert.deepStrictEqual(r.map((o) => o.abbrOrderId), ['a', 'b']);
});

test('ordersInRange — createdAt 없는/이상 데이터 안전', () => {
  assert.deepStrictEqual(ordersInRange(null, START, END), []);
  assert.deepStrictEqual(ordersInRange([{}, { createdAt: 'x' }, { createdAt: t(10) }], START, END).length, 1);
});

test('pageOldestMs — 가장 과거, 빈 페이지는 Infinity', () => {
  assert.strictEqual(pageOldestMs([{ createdAt: t(19) }, { createdAt: t(13) }]), t(13));
  assert.strictEqual(pageOldestMs([]), Infinity);
});

test('shouldStopPaging — 페이지가 어제로 넘어가면 멈춤(=target 시작보다 과거)', () => {
  // page 0: 전부 오늘 → 계속
  assert.strictEqual(shouldStopPaging([{ createdAt: t(19) }, { createdAt: t(13) }], START), false);
  // 오늘+어제 섞인 페이지: 가장 과거가 어제 → 멈춤(어제분은 ordersInRange 가 거르고, 더 안 넘김)
  assert.strictEqual(shouldStopPaging([{ createdAt: t(2) }, { createdAt: yesterday(23) }], START), true);
  // 전부 어제 → 멈춤
  assert.strictEqual(shouldStopPaging([{ createdAt: yesterday(20) }], START), true);
});

test('통합 시나리오 — 오늘 12건(2페이지)+어제, page1 에서 멈춤', () => {
  // page0: 오늘 10건 (newest-first), oldest=오늘 → 계속
  const page0 = Array.from({ length: 10 }, (_, i) => ({ createdAt: t(23 - i) }));
  assert.strictEqual(shouldStopPaging(page0, START), false);
  assert.strictEqual(ordersInRange(page0, START, END).length, 10);
  // page1: 오늘 2건 + 어제 8건 → 오늘분만 담고, oldest 가 어제라 멈춤
  const page1 = [{ createdAt: t(2) }, { createdAt: t(1) }, ...Array.from({ length: 8 }, (_, i) => ({ createdAt: yesterday(23 - i) }))];
  assert.strictEqual(ordersInRange(page1, START, END).length, 2);
  assert.strictEqual(shouldStopPaging(page1, START), true);
});
