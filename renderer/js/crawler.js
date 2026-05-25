// 매출 수집 현황 상태판
// 전 매장 × 등록 플랫폼 × 날짜별 수집 성공 여부를 그리드로 표시.
// 데이터: window.crawler.getCollectionStatus({ startDate, endDate })  (노심 sync-status 기반)

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const PLATFORM_FALLBACK = {
  baemin: '배민', yogiyo: '요기요', coupangeats: '쿠팡이츠', ddangyoyo: '땡겨요', okpos: 'OKPOS',
};
const AUTO_REFRESH_MS = 5 * 60 * 1000;

const $board = document.getElementById('board');
const $message = document.getElementById('message');
const $meta = document.getElementById('meta');
const $range = document.getElementById('rangeSelect');
const $refresh = document.getElementById('refreshBtn');

let autoTimer = null;
let DASHBOARD = false;
let reloggingIn = false;
let lastReloginAt = 0;

// ─── KST 날짜 ───
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
function buildDates(n) {
  const t = kstNow();
  const end = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const arr = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    arr.push({
      ymd: d.toISOString().slice(0, 10),
      m: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      dow: d.getUTCDay(),
    });
  }
  return arr;
}

function setMessage(text, isError) {
  $message.textContent = text || '';
  $message.style.display = text ? 'block' : 'none';
  $message.className = isError ? 'error' : '';
}

// ─── 렌더 ───
function render(stores, dates) {
  const todayYmd = dates[dates.length - 1].ymd;
  $board.innerHTML = '';

  if (!stores.length) {
    setMessage('표시할 매장이 없습니다.', false);
    return;
  }
  setMessage('', false);

  for (const store of stores) {
    const section = document.createElement('div');
    section.className = 'store-section';

    const head = document.createElement('div');
    head.className = 'store-head';
    head.innerHTML = `<span class="store-bar"></span><span class="store-name"></span>`;
    head.querySelector('.store-name').textContent = store.name || store.storeId;
    section.appendChild(head);

    if (!store.platforms || store.platforms.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'store-empty';
      empty.textContent = '등록된 수집 플랫폼이 없습니다.';
      section.appendChild(empty);
      $board.appendChild(section);
      continue;
    }

    // 날짜 헤더
    let thead = '<tr><th class="platform"></th>';
    for (const d of dates) {
      const cls = ['dow-' + d.dow];
      if (d.ymd === todayYmd) cls.push('today');
      thead += `<th class="${cls.join(' ')}">`
        + `<span class="date-num">${d.m}/${d.day}</span>`
        + `<span class="date-dow">${d.ymd === todayYmd ? '오늘' : DOW[d.dow]}</span></th>`;
    }
    thead += '</tr>';

    // 플랫폼 행
    let tbody = '';
    for (const p of store.platforms) {
      const got = new Set(p.dates || []);
      const label = p.label || PLATFORM_FALLBACK[p.platform] || p.platform;
      let row = '<tr><th class="platform"></th>';
      for (const d of dates) {
        const ok = got.has(d.ymd);
        const cls = ['cell', ok ? 'ok' : 'miss'];
        if (d.ymd === todayYmd) cls.push('today');
        row += `<td class="${cls.join(' ')}">${ok ? '✅' : '⬜'}</td>`;
      }
      row += '</tr>';
      // 플랫폼 라벨은 textContent 로 안전하게 주입
      const tmp = document.createElement('tbody');
      tmp.innerHTML = row;
      tmp.querySelector('th.platform').textContent = label;
      tbody += tmp.innerHTML;
    }

    const scroll = document.createElement('div');
    scroll.className = 'grid-scroll';
    scroll.innerHTML = `<table class="grid"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
    section.appendChild(scroll);
    $board.appendChild(section);
  }
}

// ─── 로드 ───
async function load() {
  const n = parseInt($range.value, 10) || 14;
  const dates = buildDates(n);
  const startDate = dates[0].ymd;
  const endDate = dates[dates.length - 1].ymd;

  $refresh.disabled = true;
  $refresh.textContent = '불러오는 중…';
  if (!$board.children.length) setMessage('불러오는 중…', false);

  try {
    const res = await window.crawler.getCollectionStatus({ startDate, endDate });
    if (!res || !res.success) {
      if (res && res.code === 'UNAUTHORIZED') {
        await handleSessionExpired();
        return;
      }
      setMessage((res && res.message) || '수집 현황을 불러오지 못했습니다.', true);
      $board.innerHTML = '';
      return;
    }
    render(res.stores || [], dates);
    const now = kstNow();
    $meta.textContent = `갱신 ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  } catch (err) {
    setMessage('오류: ' + (err && err.message ? err.message : err), true);
  } finally {
    $refresh.disabled = false;
    $refresh.textContent = '새로고침';
  }
}

function scheduleAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(load, AUTO_REFRESH_MS);
}

// ─── 세션 만료 처리 ───
// 대시보드 모드: 자동 재로그인 후 새로고침(로그인 화면으로 안 빠짐). 30초 백오프로 루프 방지.
// 일반 모드: 로그인 화면으로 이동.
async function handleSessionExpired() {
  if (!DASHBOARD) {
    setMessage('세션이 만료되었습니다. 다시 로그인합니다…', true);
    setTimeout(() => window.api.navigate('login'), 1500);
    return;
  }
  const now = Date.now();
  if (reloggingIn || now - lastReloginAt < 30000) {
    setMessage('세션 갱신 대기 중… (잠시 후 자동 재시도)', true);
    return;
  }
  reloggingIn = true;
  lastReloginAt = now;
  setMessage('세션 갱신 중…', false);
  let ok = false;
  try { const r = await window.crawler.relogin(); ok = !!(r && r.success); } catch {}
  reloggingIn = false;
  if (ok) await load();
  else setMessage('세션 갱신 실패 — 잠시 후 자동 재시도합니다.', true);
}

// ─── 이벤트 ───
document.getElementById('backBtn').addEventListener('click', () => window.api.navigate('scanner'));
$refresh.addEventListener('click', load);
$range.addEventListener('change', load);
window.api.onSessionExpired(() => { handleSessionExpired(); });

// ─── 초기화 ───
(async function init() {
  try { DASHBOARD = await window.crawler.getDashboardMode(); } catch {}
  if (DASHBOARD) {
    const back = document.getElementById('backBtn');
    if (back) back.style.display = 'none'; // 상황판 전용 PC 에선 뒤로가기 불필요
  }
  load();
  scheduleAuto();
})();
