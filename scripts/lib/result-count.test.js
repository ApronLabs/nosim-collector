'use strict';
// node --test scripts/lib/result-count.test.js
const test = require('node:test');
const assert = require('node:assert');
const { sumOrders, shopOrderCount } = require('./result-count');

test('coupangeats/yogiyo — 최상위 totalOrders', () => {
  const msg = { site: 'coupangeats', shops: [{ totalOrders: 2, orders: [{}, {}] }] };
  assert.strictEqual(sumOrders(msg), 2);
});

test('baemin — 중첩 totals.totalOrders (기존 버그: 0 으로 찍히던 케이스)', () => {
  const msg = {
    site: 'baemin',
    shops: [{ totals: { totalOrders: 16 }, orders: new Array(16).fill({}) }],
  };
  assert.strictEqual(sumOrders(msg), 16);
});

test('okpos — totalOrders 없음, orders 배열 폴백', () => {
  const msg = { site: 'okpos', shops: [{ orders: [{}, {}, {}] }] };
  assert.strictEqual(sumOrders(msg), 3);
});

test('여러 shop 합산 (샵인샵)', () => {
  const msg = {
    site: 'coupangeats',
    shops: [{ totalOrders: 2 }, { totalOrders: 5 }, { totals: { totalOrders: 3 } }],
  };
  assert.strictEqual(sumOrders(msg), 10);
});

test('0건 정상 — totalOrders 0', () => {
  assert.strictEqual(sumOrders({ shops: [{ totalOrders: 0, orders: [] }] }), 0);
});

test('shops 없음 → null (→ "완료" 표기)', () => {
  assert.strictEqual(sumOrders(null), null);
  assert.strictEqual(sumOrders({}), null);
  assert.strictEqual(sumOrders({ shops: 'x' }), null);
});

test('shopOrderCount — 우선순위 totalOrders > totals > orders.length', () => {
  // 최상위가 있으면 그것 우선 (orders 길이와 달라도)
  assert.strictEqual(shopOrderCount({ totalOrders: 7, orders: [{}] }), 7);
  assert.strictEqual(shopOrderCount({ totals: { totalOrders: 4 }, orders: [{}] }), 4);
  assert.strictEqual(shopOrderCount({ orders: [{}, {}] }), 2);
  assert.strictEqual(shopOrderCount({}), 0);
  assert.strictEqual(shopOrderCount(null), 0);
});
