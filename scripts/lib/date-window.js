'use strict';

// 정산·수수료 후행 채움용 날짜 윈도우.
//
// 배민/요기요/땡겨요는 중개이용료·결제수수료·배달비·정산금액이 주문 당일이 아니라
// 1~2일(주말 끼면 더) 뒤에 확정된다. 그래서 "당일만" 수집하면 그 비용이 영영 0으로
// 남는다 (2026-06-11~ 정릉본점 배민 비용 0 사고). daily 모드에서 targetDate 를 포함한
// 최근 N일을 한 세션에서 다시 긁어(=정산 backfill) 비용이 확정되면 채워지게 한다.
//
// days=1 이면 start=end=targetDate → 기존 "당일만" 동작과 완전히 동일(역호환).

/** 'YYYY-MM-DD' 로컬 날짜 포맷 (UTC 변환에 의한 ±1일 어긋남 방지). */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * targetDate 를 끝으로 하는 최근 days 일 범위.
 * @param {string} targetDate  'YYYY-MM-DD'
 * @param {number} [days=1]    재수집 일수 (1 이하·미지정 → 당일만)
 * @returns {{ startDate: string, endDate: string }}
 */
function recentDaysRange(targetDate, days) {
  if (!targetDate) throw new Error('recentDaysRange: targetDate 필요 (YYYY-MM-DD)');
  const end = new Date(targetDate + 'T00:00:00');
  if (isNaN(end.getTime())) throw new Error(`recentDaysRange: 잘못된 날짜 "${targetDate}"`);
  const n = Math.max(1, Number(days) || 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (n - 1));
  return { startDate: fmtDate(start), endDate: fmtDate(end) };
}

module.exports = { recentDaysRange, fmtDate };
