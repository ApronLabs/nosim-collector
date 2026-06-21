'use strict';
// UI-구동 쿠팡 수집(#3)의 순수 로직.
//
// 쿠팡 주문페이지는 날짜선택기를 안 건드리면 "최근 며칠" 범위를 newest-first 로 준다(실측).
// 그래서 우리 target 일자 구간만 모으고, 어떤 페이지가 target 시작보다 더 과거 주문만 담고
// 있으면 그 다음 페이지는 더 과거뿐이므로 페이지 넘김을 멈춘다 → 날짜선택기(가장 깨지기 쉬운
// 부분)를 안 건드리고도 정확. 이 판단이 틀리면 '엉뚱한 날 수집' 이 되므로 여기 순수 함수로
// 두고 테스트한다.

/** content 중 createdAt 이 [startMs, endMs] 인 주문만. */
function ordersInRange(content, startMs, endMs) {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (o) => o && typeof o.createdAt === 'number' && o.createdAt >= startMs && o.createdAt <= endMs
  );
}

/** 페이지에서 가장 오래된 주문 시각(ms). 비었으면 Infinity. */
function pageOldestMs(content) {
  if (!Array.isArray(content) || content.length === 0) return Infinity;
  return content.reduce((min, o) => {
    const t = o && typeof o.createdAt === 'number' ? o.createdAt : Infinity;
    return t < min ? t : min;
  }, Infinity);
}

/** 이 페이지의 가장 오래된 주문이 target 시작보다 과거 → 다음은 더 과거뿐이라 멈춤. */
function shouldStopPaging(content, startMs) {
  return pageOldestMs(content) < startMs;
}

/**
 * 한 페이지(pageSize) 미만이면 마지막/단일 페이지 → 다음 페이지 없음.
 * 주문이 적거나(1~9건) 온보딩중인 서브매장은 페이지네이션 컨트롤 자체가 없어
 * '다음 버튼 못 찾음' 오탐을 낸다. full 페이지가 아니면 클릭 시도 전에 정상 종료하기 위한 판정.
 * (full 페이지면 false → 다음 페이지 가능성 있으니 계속 — 데이터 누락 없음)
 */
function isLastPage(content, pageSize) {
  return !Array.isArray(content) || content.length < pageSize;
}

module.exports = { ordersInRange, pageOldestMs, shouldStopPaging, isLastPage };
