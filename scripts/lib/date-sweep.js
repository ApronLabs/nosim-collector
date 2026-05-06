/**
 * 0건 마커 sweep — backfill/daily 모드에서 요청 기간 중 미수집 날짜에도
 * 빈 페이로드로 노심에 sync log 'success' 행을 남겨, 다음 백필부터
 * sync-status API 가 해당 날짜를 "이미 수집됨" 으로 분류하게 한다.
 *
 * 이 sweep 이 없으면 휴무/광고 미집행/0건 날이 매번 미수집으로 잡혀
 * 한 날짜라도 비어있으면 needBackfillSites 로 분류 → POC 가 1월~D-1
 * 전 기간을 다시 긁는 비효율이 발생한다.
 */

/**
 * [start, end] (양 끝 포함) 사이 모든 날짜를 YYYY-MM-DD 로 enumerate.
 * @param {string} startDash YYYY-MM-DD
 * @param {string} endDash   YYYY-MM-DD
 * @returns {string[]}
 */
function enumerateDates(startDash, endDash) {
  const out = [];
  const start = new Date(startDash + 'T00:00:00Z');
  const end = new Date(endDash + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return out;
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 요청 기간 중 collected 에 없는 날짜를 골라 sender 콜백 호출.
 * sender 는 missing 한 한 날짜를 받아 빈 페이로드로 sendToSalesKeeper 를 부른다.
 * @param {string} startDash
 * @param {string} endDash
 * @param {Iterable<string>} collectedDates 수집된 YYYY-MM-DD 목록
 * @param {(missingDate: string) => Promise<unknown>} sender
 */
async function sweepMissingDates(startDash, endDash, collectedDates, sender) {
  const collected = new Set(collectedDates);
  const all = enumerateDates(startDash, endDash);
  const missing = all.filter(d => !collected.has(d));
  for (const d of missing) {
    await sender(d);
  }
  return { total: all.length, sent: missing.length };
}

module.exports = { enumerateDates, sweepMissingDates };
