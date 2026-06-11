'use strict';
// 워커 result 메시지에서 "수집 주문 수"를 안전하게 합산.
//
// 배경: 워커마다 emit('result') 의 shop 구조가 달라 주문 수 위치가 제각각이다.
//   - coupangeats / yogiyo : shop.totalOrders        (최상위)
//   - baemin               : shop.totals.totalOrders (중첩!)
//   - okpos                : 없음 — shop.orders 배열만
// 기존 collect-stores.js 의 sumOrders 는 shop.totalOrders 만 봐서 배민·okpos 가
// 실제로 잘 수집됐는데도 터미널 로그에 "0 orders" 로 찍혔다(데이터는 정상 적재).
//
// 모든 워커가 shop.orders 배열은 갖고 있으므로 그걸 최종 폴백으로 쓰면 전부 정확해진다.

/** result 메시지의 모든 shop 주문 수 합. shops 없으면 null(→ "완료"로 표기). */
function sumOrders(resultMsg) {
  if (!resultMsg || !Array.isArray(resultMsg.shops)) return null;
  return resultMsg.shops.reduce((acc, s) => acc + shopOrderCount(s), 0);
}

/** shop 1개의 주문 수 — 최상위 totalOrders → totals.totalOrders → orders.length 순. */
function shopOrderCount(shop) {
  if (!shop || typeof shop !== 'object') return 0;
  if (typeof shop.totalOrders === 'number') return shop.totalOrders;
  if (shop.totals && typeof shop.totals.totalOrders === 'number') return shop.totals.totalOrders;
  if (Array.isArray(shop.orders)) return shop.orders.length;
  return 0;
}

module.exports = { sumOrders, shopOrderCount };
