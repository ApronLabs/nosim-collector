/**
 * 쿠팡이츠 워커: 매장별 수집 (XHR API 방식)
 * 실행: npx electron poc-coupangeats.js --id=아이디 --pw=비밀번호 --mode=backfill|daily --targetDate=YYYY-MM-DD
 *       --storeId=매장UUID --serverUrl=http://localhost:3000 --sessionToken=JWT토큰
 */

const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const { RawDumper } = require('./lib/raw-dumper');
const { sweepMissingDates } = require('./lib/date-sweep');
const { rnd, jitter, buildUserAgent } = require('./lib/human');
const { ordersInRange, shouldStopPaging, isLastPage } = require('./lib/coupang-paging');
const POC_VERSION = app.getVersion() || 'unknown';
const rawDumper = new RawDumper('coupangeats');

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');

// ── CLI 인자 파싱 ──
function getArg(name) {
  const a = process.argv.find(a => a.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : '';
}

const config = {
  id: getArg('id'),
  pw: getArg('pw'),
  mode: getArg('mode') || 'backfill',
  targetDate: getArg('targetDate'),
  storeId: getArg('storeId'),
  serverUrl: getArg('serverUrl'),
  sessionToken: getArg('sessionToken'),
};

const SHOW = process.argv.includes('--show');
// 자동 로그인(id/pw 자동입력)은 Akamai 봇감지의 핵심 신호 → 기본 OFF.
// 원칙: 살아있는 세션 재사용. 만료 시 --show 창에서 사람이 1회 로그인(엔트로피 있어 통과)
// → 세션이 user-data-dir 에 저장돼 이후 자동 재사용. 굳이 자동입력하려면 --auto-login.
const AUTO_LOGIN = process.argv.includes('--auto-login');
// 진단 모드 — 주문페이지의 실제 DOM(버튼/날짜/페이지네이션) + 페이지 자체 XHR 캡처를
// 별도 파일에 덤프. UI-구동 수집(#3) 을 정확히 만들기 위한 화면 구조 확보용. 수집은 평소대로 진행.
const UI_INSPECT = process.argv.includes('--inspect-coupang');
// UI-구동 수집 — raw fetch 대신, 주문페이지로 들어가면 페이지가 스스로 쏘는 주문 XHR(가장
// 사람다움)을 preload 로 가로채 사용하고, 다음 페이지는 실제 '다음' 버튼 클릭. 깨지면(화면 변경)
// 명확히 throw → exit 1 → 노심 보고 → Slack(사장님 안전망). daily 모드만 대상(백필은 raw fetch).
const UI_DRIVE = process.argv.includes('--ui-drive');
// 로그인화면 DOM 수집 모드 — 임시 빈 세션(로그아웃)으로 로그인 페이지만 떠서 체크박스 DOM 을
// coupang-inspect.txt 에 덤프하고 종료. 수집/로그인 안 함. '로그인 상태 유지' 셀렉터 확정용.
const INSPECT_LOGIN = process.argv.includes('--inspect-login');
const LOG_FILE = path.join(__dirname, 'poc-coupangeats-log.txt');
const INSPECT_FILE = path.join(__dirname, 'coupang-inspect.txt');

// 프로세스 종료 코드. 에러/차단으로 끝나면 1 로 두고 app.exit(1) → poc-runner 가 reject
// → collect-stores 가 실패로 인식(throttle 이면 전역 쿨다운 + Slack 보고). 과거엔 무조건
// app.quit()(코드 0)이라 차단당해도 "성공"으로 오인돼 #58/#61 안전망이 무력화됐다.
let exitCode = 0;

// ── stdout JSON 프로토콜 ──
function emit(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 사람 같은 분산 대기 — 고정 round-number sleep 의 기계적 등간격은 Akamai 행동센서의
// 봇신호. hsleep(a,b)=구간 난수, jsleep(base)=base 중심 ±20% 흔든 대기.
const hsleep = (a, b) => sleep(rnd(a, b));
const jsleep = base => sleep(jitter(base));
process.on('uncaughtException', err => {
  if (err.code === 'EPIPE') return;
  fs.appendFileSync(LOG_FILE, `[FATAL] ${err.message}\n`);
  emit('error', { error: err.message });
});

// ── mode에 따른 날짜 범위 (YYYY-MM-DD + ms 타임스탬프) ──
function getDateRangeByMode() {
  if (config.mode === 'daily') {
    if (!config.targetDate) throw new Error('daily 모드에서는 --targetDate=YYYY-MM-DD 필요');
    return {
      startDash: config.targetDate,
      endDash: config.targetDate,
      startMs: dateToKstStartMs(config.targetDate),
      endMs: dateToKstEndMs(config.targetDate),
    };
  }
  // backfill — 올해 1월 1일부터 D-1까지 (v3.5.4부터 전 기간 백필)
  const kstNow = new Date(Date.now() + 9 * 3600000);
  const yesterday = new Date(kstNow);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const start = new Date(Date.UTC(kstNow.getUTCFullYear(), 0, 1));
  const f = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  const startDash = f(start);
  const endDash = f(yesterday);
  return {
    startDash,
    endDash,
    startMs: dateToKstStartMs(startDash),
    endMs: dateToKstEndMs(endDash),
  };
}

/** YYYY-MM-DD → KST 00:00:00.000 의 ms 타임스탬프 */
function dateToKstStartMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // KST = UTC+9, 그러므로 KST 00:00 = UTC 전날 15:00
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 9 * 3600000;
}

/** YYYY-MM-DD → KST 23:59:59.999 의 ms 타임스탬프 */
function dateToKstEndMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 9 * 3600000;
}

/** ms 타임스탬프 → KST YYYY-MM-DD */
function msToKstDate(ms) {
  const kst = new Date(ms + 9 * 3600000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth()+1).padStart(2,'0')}-${String(kst.getUTCDate()).padStart(2,'0')}`;
}

// ── 매출지킴이 API 전송 ──
async function sendToSalesKeeper(platform, targetDate, shopId, shopName, orders) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return null;
  const url = `${config.serverUrl}/api/stores/${config.storeId}/crawler/${platform}`;

  // POC 내부 필드명 → API 기대 필드명으로 변환
  const mappedOrders = orders.map(o => ({
    orderId: o.orderId || '',
    orderedAt: o.date && o.time ? `${o.date}T${o.time}:00+09:00` : o.date || '',
    orderType: o.status || null,
    menuSummary: o.menuSummary || null,
    totalPayment: o.salePrice || o.amount || 0,
    // v3.5.5: 총금액(할인 전) — 노심에서 쿠팡부담 쿠폰 역산에 사용
    totalAmount: o.totalAmount || 0,
    // 메뉴 라인 (자동출고용) — 노심 crawler_order_items 로 저장. dishId·itemOptions 포함.
    items: o.items || [],
    orderSettlement: {
      commissionTotal: o.settlement?.commissionTotal || 0,
      commissionVat: o.settlement?.commissionVat || 0,
      serviceSupplyPrice: { appliedSupplyPrice: o.settlement?.serviceSupplyPrice || 0 },
      paymentSupplyPrice: { appliedSupplyPrice: o.settlement?.paymentSupplyPrice || 0 },
      deliverySupplyPrice: { appliedSupplyPrice: o.settlement?.deliverySupplyPrice || 0 },
      advertisingSupplyPrice: { appliedSupplyPrice: o.settlement?.advertisingSupplyPrice || 0 },
      storePromotionAmount: o.settlement?.storePromotionAmount || 0,
      mfdTotalAmount: o.settlement?.mfdTotalAmount || 0,
      favorableFee: o.settlement?.favorableFee || 0,
      settlementDueDate: o.settlement?.settlementDueDate || '',
      hasSettled: o.settlement?.hasSettled || false,
      subtractAmount: o.settlement?.subtractAmount || 0,
    },
  }));

  const body = JSON.stringify({
    targetDate,
    platformStoreId: shopId,
    brandName: shopName,
    orders: mappedOrders,
    pocVersion: POC_VERSION,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session-token=${config.sessionToken}`,
      },
      body,
    });
    log(`   API 전송 ${targetDate}: ${res.status}`);
    return { status: res.status, ok: res.ok };
  } catch (err) {
    log(`   API 전송 실패 ${targetDate}: ${err.message}`);
    emit('error', { error: `API 전송 실패 (${targetDate}): ${err.message}` });
    return null;
  }
}

/* ─────────────────────── 공통 스크립트 ─────────────────────── */

function jsLogin(id, pw) {
  // 사람 타이핑 모사: 글자별 70~190ms(가끔 망설임) 지연 + 자연스러운 focus/blur.
  // 0ms 연타는 강한 봇신호라 자동입력(--auto-login) 시에도 사람 분포로 친다.
  return `(async function(){
    const s=ms=>new Promise(r=>setTimeout(r,ms));
    const rn=(a,b)=>Math.floor(a+Math.random()*(b-a));
    await s(rn(1500,2700));
    const i=document.getElementById('loginId'),p=document.getElementById('password');
    if(!i||!p)return{success:false,error:'no form'};
    async function t(el,v){el.focus();el.click();await s(rn(180,460));
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}));
      for(let c=0;c<v.length;c++){
        set.call(el,el.value+v[c]);
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:v[c]}));
        await s(rn(70,190)+(Math.random()<0.08?rn(150,400):0));
      }
      el.dispatchEvent(new Event('change',{bubbles:true}));el.blur();}
    await t(i,${JSON.stringify(id)});await s(rn(450,950));
    await t(p,${JSON.stringify(pw)});await s(rn(500,1100));
    const b=Array.from(document.querySelectorAll('button')).find(b=>b.innerText.trim()==='로그인');
    if(!b)return{success:false,error:'no btn'};
    await s(rn(220,600));b.click();return{success:true};
  })()`;
}

// 페이지 안에서 사람처럼 살짝 스크롤(읽는 척) — 행동 엔트로피용.
const JS_HUMAN_SCROLL = `(async function(){
  const s=ms=>new Promise(r=>setTimeout(r,ms));
  const steps=2+Math.floor(Math.random()*3);
  for(let k=0;k<steps;k++){window.scrollBy(0,120+Math.floor(Math.random()*260));await s(200+Math.floor(Math.random()*500));}
  await s(150+Math.floor(Math.random()*350));window.scrollTo(0,0);return true;
})()`;

const JS_DISMISS = `(function(){
  let c=0;
  ['.btn-close','[class*="close-button"]','[class*="modal"] [class*="close"]','[aria-label="닫기"]','[aria-label="close"]'].forEach(s=>{
    document.querySelectorAll(s).forEach(e=>{if(e.offsetHeight>0){e.click();c++}})});
  document.querySelectorAll('button').forEach(b=>{const t=b.innerText.trim();
    if(['확인','닫기','다음에','다음에 보기','건너뛰기','나중에'].includes(t)){
      const p=b.closest('[class*="modal"],[class*="popup"],[class*="dialog"],[role="dialog"]');
      if(p&&p.offsetHeight>0){b.click();c++}}});return c})()`;

/* ─────────── 매장 탐색 ─────────── */
const JS_FIND_STORES = `(async function(){
  const s=ms=>new Promise(r=>setTimeout(r,ms));
  const allEls = [];
  document.querySelectorAll('*').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.top >= 0 && r.top < 400 && el.offsetHeight > 0) {
      const text = el.innerText?.trim() || '';
      if (text.length > 0) {
        allEls.push({ el, text, tag: el.tagName, cls: el.className?.toString() || '',
          rect: { t: Math.round(r.top), l: Math.round(r.left), h: Math.round(r.height), w: Math.round(r.width) },
          children: el.children.length, hasSvg: !!el.querySelector('svg') });
      }
    }
  });
  const storeNameEls = allEls.filter(e => e.text.includes('점') && e.rect.h < 80 && e.rect.h > 10 && e.text.length < 60);
  let trigger = null;
  for (const item of storeNameEls) {
    const clickable = item.el.closest('button, a, [role="button"]');
    if (clickable && clickable.offsetHeight > 0 && clickable.offsetHeight < 120) {
      trigger = clickable; break;
    }
  }
  if (!trigger) {
    const sorted = [...storeNameEls].sort((a, b) => a.rect.h - b.rect.h);
    for (const item of sorted) {
      const cleanText = item.text.replace(/\\n/g, ' ').trim();
      if (cleanText.length < 50 && item.rect.h < 120 && item.el.offsetHeight > 0) {
        trigger = item.el; break;
      }
    }
  }
  if (!trigger) {
    const debug = allEls.filter(e => e.rect.h < 80 && e.rect.h > 10 && e.text.length < 80)
      .map(e => ({ tag: e.tag, cls: e.cls.substring(0,50), text: e.text.substring(0,50).replace(/\\n/g,'|'), t: e.rect.t, l: e.rect.l, h: e.rect.h, w: e.rect.w }))
      .slice(0, 40);
    return { success: false, stores: [], debug };
  }
  const triggerRect = trigger.getBoundingClientRect();
  const beforeIds = new Set();
  document.querySelectorAll('a').forEach(a => { if (a.offsetHeight > 0) beforeIds.add(a.href); });
  trigger.click();
  await s(2000);
  const stores = [];
  const seen = new Set();
  const selectorEl = document.querySelector('.home-store-selector') || trigger.closest('[class*="store-selector"]') || trigger;
  const dropdownItems = selectorEl.querySelectorAll('[class*="option"], [class*="item"], [class*="select-box"] *, li, div');
  for (const item of dropdownItems) {
    if (item.offsetHeight <= 0) continue;
    const r = item.getBoundingClientRect();
    if (r.top < triggerRect.top - 50 || r.top > triggerRect.top + 250) continue;
    const text = (item.innerText?.trim() || '').split('\\n')[0].trim();
    if (text && text.length > 2 && text.length < 40 && !seen.has(text)) {
      if (['홈','공지사항','매출 관리','정산 관리','광고 관리','쿠폰 관리','리뷰','메뉴 편집','매장 정보','계약 관리','계정 관리','POS','FAQ'].some(nav => text.includes(nav))) continue;
      seen.add(text);
      const anchor = item.querySelector('a') || item.closest('a');
      const href = anchor?.href || '';
      const m = href.match(/\\/(?:home|orders)\\/(\\d{5,})/);
      stores.push({ storeName: text, storeId: m ? m[1] : '' });
    }
  }
  if (stores.length <= 1) {
    document.querySelectorAll('a').forEach(a => {
      if (a.offsetHeight <= 0) return;
      if (beforeIds.has(a.href)) return;
      const href = a.href || '';
      const m = href.match(/\\/(?:home|orders)\\/(\\d{5,})/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        const name = (a.innerText?.trim() || '').split('\\n')[0].trim();
        stores.push({ storeName: name, storeId: m[1] });
      }
    });
  }
  if (stores.length <= 1) {
    document.querySelectorAll('[role="option"], [role="listbox"] > *, [class*="select"] li, [class*="dropdown"] li, [class*="extend"] li, [class*="extend"] div').forEach(item => {
      if (item.offsetHeight <= 0) return;
      const r = item.getBoundingClientRect();
      if (Math.abs(r.left - triggerRect.left) > 100) return;
      if (r.top < triggerRect.bottom - 10 || r.top > triggerRect.bottom + 300) return;
      const text = (item.innerText?.trim() || '').split('\\n')[0].trim();
      if (text && text.length > 2 && text.length < 40 && !seen.has(text)) {
        seen.add(text);
        stores.push({ storeName: text, storeId: '' });
      }
    });
  }
  trigger.click();
  await s(500);
  if (stores.length > 0) {
    return { success: true, stores, method: 'dropdown' };
  }
  const html = document.body?.innerHTML || '';
  const ids = [...new Set([...html.matchAll(/\\/merchant\\/management\\/(?:home|orders)\\/(\\d{5,})/g)].map(m => m[1]))];
  if (ids.length > 1) {
    return { success: true, stores: ids.map(id => ({ storeName: '', storeId: id })), method: 'html' };
  }
  return { success: false, stores: [],
    debug: allEls.filter(e => e.rect.t < 200 && e.rect.h < 100)
      .map(e => ({ tag: e.tag, cls: e.cls.substring(0,40), text: e.text.substring(0,40).replace(/\\n/g,'|'), ...e.rect }))
      .slice(0, 30)
  };
})()`;

/* ─────────── XHR API로 주문 조회 ─────────── */
function jsFetchOrders(storeId, startMs, endMs) {
  return `(async function(){
    try {
      // x-request-meta — 쿠팡 주문 API 가 요구하는 메타 헤더. 사이트 프런트엔드가
      // 보내는 것과 동일 형식을 그대로 동봉(스푸핑 아님, 정상 요청 재현).
      const meta = btoa(JSON.stringify({
        o: location.origin,
        ua: navigator.userAgent.substring(0, navigator.userAgent.indexOf('Chrome/') + 12),
        r: location.href,
        t: Date.now(),
        sr: screen.width + 'x' + screen.height,
        l: navigator.language
      }));

      const res = await fetch('https://store.coupangeats.com/api/v1/merchant/web/order/condition', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'x-request-meta': meta,
          'x-requested-with': 'XMLHttpRequest'
        },
        credentials: 'include',
        body: JSON.stringify({
          pageNumber: 0,
          pageSize: 10,
          storeId: ${storeId},
          startDate: ${startMs},
          endDate: ${endMs}
        })
      });
      if (!res.ok) return JSON.stringify({ success: false, error: 'HTTP ' + res.status, status: res.status });
      const data = await res.json();
      return JSON.stringify({ success: true, data });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }
  })()`;
}

/* ─────────── 헬퍼 ─────────── */
let mainWindow, webView;
function nav(url, t=30000) {
  return new Promise(r => {
    let done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(to); };
    const to = setTimeout(() => { fin(); r(); }, t);
    webView.webContents.once('did-finish-load', () => { fin(); r(); });
    webView.webContents.loadURL(url).catch(() => {});
  });
}
const isLogin = u => u.includes('/login') || u.includes('/signin');

// 사람 같은 마우스 이동 — 실제 OS 입력 이벤트(sendInputEvent)라 Akamai 센서가 포인터
// 엔트로피로 기록한다. 보이는 창(--show)에서만 의미 있어 그때만 수행. 실패는 무시.
async function humanMouse(moves = 3) {
  if (!SHOW || !mainWindow || !webView) return;
  try {
    const [w, h] = mainWindow.getContentSize();
    let x = rnd(40, Math.max(60, w - 40));
    let y = rnd(70, Math.max(100, h - 70));
    for (let k = 0; k < moves; k++) {
      x = Math.min(w - 5, Math.max(5, x + rnd(-180, 180)));
      y = Math.min(h - 5, Math.max(5, y + rnd(-140, 140)));
      webView.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      await sleep(rnd(60, 180));
    }
  } catch { /* 입력 이벤트 실패는 수집을 막지 않는다 */ }
}

// Akamai 차단/throttle 문구가 현재 페이지에 떠 있나 (봇감지 신호 — 보이면 즉시 중단).
async function hasBlockText() {
  try {
    return await webView.webContents.executeJavaScript(
      `!!(document.body && /해당하는 요청을 처리할 권한이 존재하지 않|페이지가 작동하지 않습니다|매장 목록을 불러오지 못했습니다/.test(document.body.innerText))`
    );
  } catch { return false; }
}

// 로그인 페이지에서 벗어날 때까지 대기 (수동 로그인 통과 감지). baemin 패턴 차용.
function waitForLoginRedirect(timeoutMs = 180000) {
  return new Promise(resolve => {
    if (!isLogin(webView.webContents.getURL())) { resolve(webView.webContents.getURL()); return; }
    let done = false;
    const cleanup = () => {
      if (done) return; done = true; clearInterval(poll); clearTimeout(t);
      webView.webContents.removeListener('did-navigate', onNav);
      webView.webContents.removeListener('did-navigate-in-page', onNav);
    };
    const t = setTimeout(() => { cleanup(); resolve(webView.webContents.getURL()); }, timeoutMs);
    const onNav = (_, url) => { if (!isLogin(url)) { cleanup(); resolve(url); } };
    webView.webContents.on('did-navigate', onNav);
    webView.webContents.on('did-navigate-in-page', onNav);
    const poll = setInterval(() => {
      const u = webView.webContents.getURL();
      if (!isLogin(u)) { cleanup(); resolve(u); }
    }, 1000);
  });
}

/* ─────────── 로그인 세션 오래가게: '로그인 상태 유지' 체크박스 자동 체크 ─────────── */
// 로그인 화면에 '로그인 상태 유지/자동 로그인/로그인 유지' 체크박스가 있으면 켠다(비번은 사람/
// jsLogin 이 입력, 체크박스만 자동 — 안전). 세션이 2시간→며칠/주 단위로 늘어 재로그인 빈도↓.
// 라벨 텍스트 휴리스틱(쿠팡 DOM 셀렉터 추측 안 함). 못 찾으면 no-op.
const JS_CHECK_KEEP_LOGIN = `(function(){
  try{
    var re=/로그인\\s*상태\\s*유지|자동\\s*로그인|로그인\\s*유지|기억하기|remember/i;
    var boxes=Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]'));
    for(var i=0;i<boxes.length;i++){
      var b=boxes[i];
      var lbl=(b.closest('label')&&b.closest('label').innerText)||'';
      if(!lbl&&b.id){var l2=document.querySelector('label[for="'+b.id+'"]');lbl=l2?l2.innerText:'';}
      if(!lbl){var p=b.parentElement;lbl=(p&&p.innerText)||'';}
      if(re.test(lbl)){ if(!b.checked){ b.click(); } return {found:true,label:(lbl||'').trim().slice(0,30),checked:b.checked}; }
    }
    // 라벨 매칭 실패 시 아무것도 건드리지 않음(엉뚱한 박스 클릭 방지). DOM 덤프로 정확히 확인 후 보완.
    return {found:false,count:boxes.length};
  }catch(e){ return {found:false,error:String(e)}; }
})()`;

// 로그인 화면 진단용 — 체크박스/버튼 후보를 로그에 남겨 유지옵션 셀렉터를 확인.
const JS_DUMP_LOGIN = `(function(){
  function vis(el){try{return el&&el.offsetHeight>0}catch(e){return false}}
  var boxes=Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]')).map(function(b){
    var lbl=(b.closest('label')&&b.closest('label').innerText)||'';
    if(!lbl&&b.id){var l2=document.querySelector('label[for="'+b.id+'"]');lbl=l2?l2.innerText:'';}
    if(!lbl){lbl=(b.parentElement&&b.parentElement.innerText)||'';}
    return {id:b.id||'',name:b.name||'',checked:b.checked,label:(lbl||'').replace(/\\s+/g,' ').trim().slice(0,40)};
  });
  return JSON.stringify({url:location.href,checkboxes:boxes});
})()`;

/* ─────────── 진단: 주문페이지 DOM + 자체 XHR 덤프 (#3 설계용) ─────────── */
// 보이는 버튼/링크 텍스트, 날짜 입력, 페이지네이션 후보, 페이지가 스스로 쏜 주문 XHR 캡처를
// JSON 으로 반환. createdAt 샘플로 "페이지 기본 날짜범위(오늘/주/월)"를 역산할 수 있다.
const JS_INSPECT_ORDERS = `(function(){
  function vis(el){try{return el&&el.offsetHeight>0&&el.offsetWidth>0}catch(e){return false}}
  const out={url:location.href};
  out.buttons = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(vis)
    .map(el=>({t:(el.innerText||'').trim().slice(0,24),tag:el.tagName,
      cls:((el.className&&el.className.toString())||'').slice(0,50),aria:el.getAttribute('aria-label')||''}))
    .filter(b=>b.t||b.aria).slice(0,90);
  out.dateish = Array.from(document.querySelectorAll('input,[class*="date"],[class*="Date"],[class*="calendar"],[class*="picker"],[class*="Picker"]')).filter(vis)
    .map(el=>({tag:el.tagName,type:el.type||'',val:(el.value||'').slice(0,24),
      cls:((el.className&&el.className.toString())||'').slice(0,60),ph:el.placeholder||''})).slice(0,30);
  out.pagination = Array.from(document.querySelectorAll('[class*="pag"],[class*="Pag"],[class*="paging"],nav,[role="navigation"]')).filter(vis)
    .map(el=>({cls:((el.className&&el.className.toString())||'').slice(0,60),
      html:((el.innerHTML||'').replace(/\\s+/g,' ')).slice(0,240)})).slice(0,12);
  const cap=window.__coupangCapture||[];
  out.captureCount=cap.length;
  if(cap.length){
    const d=cap[cap.length-1].data||{};
    out.captureKeys=Object.keys(d);
    const content=(d.orderPageVo&&d.orderPageVo.content)||d.content||[];
    out.captureTotalOrderCount=(d.totalOrderCount!=null?d.totalOrderCount:(d.orderPageVo&&d.orderPageVo.totalElements))||null;
    out.captureSampleCreatedAt=content.slice(0,6).map(o=>o.createdAt);
  }
  return JSON.stringify(out);
})()`;

async function dumpInspect(name, id) {
  try {
    const raw = await webView.webContents.executeJavaScript(JS_INSPECT_ORDERS);
    const header = `\n===== INSPECT ${name} (${id}) @ ${new Date().toISOString()} =====\n`;
    fs.appendFileSync(INSPECT_FILE, header + raw + '\n');
    log(`   🔎 진단 덤프 기록: ${INSPECT_FILE}`);
    emit('status', { msg: `진단 덤프 기록됨: coupang-inspect.txt` });
  } catch (e) {
    log(`   진단 덤프 실패: ${e.message}`);
  }
}

/* ─────────── UI-구동 수집 (#3): 페이지 자체 XHR 캡처 + 실제 '다음' 클릭 ─────────── */
// preload(coupang-preload.js)가 모은 페이지 자체 주문 응답을 읽는다.
async function readCaptures() {
  try {
    const raw = await webView.webContents.executeJavaScript('JSON.stringify(window.__coupangCapture||[])');
    return JSON.parse(raw) || [];
  } catch { return []; }
}
// 실측 DOM(2026-06-11): ul.merchant-pagination > li > button.pagination-btn.next-btn,
// 마지막 페이지면 next-btn 에 hide-btn 클래스. clicked|last-page|no-btn 반환.
const JS_CLICK_NEXT_PAGE = `(function(){
  var btn=document.querySelector('.merchant-pagination button.next-btn')||document.querySelector('button.pagination-btn.next-btn');
  if(!btn) return 'no-btn';
  var cls=(btn.className||'');
  if(cls.indexOf('hide-btn')!==-1||btn.disabled) return 'last-page';
  btn.click(); return 'clicked';
})()`;

// 캡처에서 가장 최근 응답(=방금 클릭/로드로 갱신된 페이지) 추출.
function latestData(caps) {
  if (!caps || !caps.length) return null;
  return caps[caps.length - 1].data || null;
}

async function collectStoreViaUi(name, id, dr) {
  log(`\n===== [UI] ${name} (${id}) =====`);
  const url = `https://store.coupangeats.com/merchant/management/orders/${id}`;
  // 캡처 비우고 이동 — 페이지가 스스로 주문 XHR 을 쏘면 preload 가 잡는다(클릭→XHR 인과 = 사람).
  await webView.webContents.executeJavaScript('try{window.__coupangCapture=[]}catch(e){}; true').catch(()=>{});
  await nav(url);
  await jsleep(5000);
  await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
  await jsleep(1000);
  await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
  if (await hasBlockText()) {
    throw new Error('Akamai 차단 감지(매장 주문페이지 권한 없음) — 즉시 중단');
  }

  // 사람처럼 읽기(마우스/스크롤/dwell)
  await humanMouse(rnd(3, 6));
  await webView.webContents.executeJavaScript(JS_HUMAN_SCROLL).catch(()=>{});
  await hsleep(2500, 6000);

  // 페이지 자동조회 응답 대기
  let caps = await readCaptures();
  let waited = 0;
  while (caps.length === 0 && waited < 12000) { await sleep(1000); waited += 1000; caps = await readCaptures(); }
  if (caps.length === 0) {
    throw new Error('쿠팡 UI 자동조회 응답 캡처 실패 — 화면 변경/차단 의심, 수집기 점검 필요(nosim.cmd 메뉴8 진단)');
  }

  // 페이지 기본 조회는 newest-first 의 "최근 며칠" 범위(실측 확인). 날짜선택기 안 건드리고,
  // 우리 target 일자 구간만 모은다. 판단 로직은 lib/coupang-paging(순수, 테스트됨).
  const first = latestData(caps) || {};
  const totalSalePrice = first.totalSalePrice || 0;
  const rangeTotal = first.totalOrderCount || first.orderPageVo?.totalElements || 0;
  const PAGE_SIZE = 10;
  const maxPages = Math.max(1, Math.ceil((rangeTotal || 0) / PAGE_SIZE)) + 2; // 안전 상한
  const collected = [];
  let pageData = first;
  let pageNum = 0;
  while (true) {
    const content = pageData.orderPageVo?.content || pageData.content || [];
    const inTarget = ordersInRange(content, dr.startMs, dr.endMs);
    collected.push(...inTarget);
    log(`   [UI] page ${pageNum}: ${content.length}건 중 target ${inTarget.length}건`);
    // 빈 페이지(0건 매장/데이터 끝)는 페이지네이션 컨트롤이 없을 수 있으므로 여기서 종료 —
    // '다음 버튼 못 찾음' 오탐 방지(예: 주문 0건인 샵인샵 매장).
    if (content.length === 0) break;
    if (shouldStopPaging(content, dr.startMs)) break; // 다음은 더 과거뿐 → 종료(날짜선택기 불필요의 핵심)
    // 한 페이지(PAGE_SIZE) 미만 = 마지막/단일 페이지 → 다음 없음. 주문 적은·온보딩중 서브매장
    // (예: 샤브편백 OB_CHECKING)은 페이지네이션 컨트롤이 없어 아래 '다음버튼 못찾음' 오탐을 냄 → 여기서 정상 종료.
    if (isLastPage(content, PAGE_SIZE)) break;
    if (pageNum + 1 >= maxPages) break;     // 안전 상한
    // 실제 '다음' 버튼 클릭 → 페이지가 새 주문 XHR 발생
    await humanMouse(rnd(1, 3));
    await hsleep(2500, 6500);
    const before = (await readCaptures()).length;
    const r = await webView.webContents.executeJavaScript(JS_CLICK_NEXT_PAGE);
    if (r === 'last-page') break;
    if (r === 'no-btn') {
      throw new Error(`쿠팡 페이지네이션 '다음' 버튼 못 찾음(page ${pageNum}) — 화면 변경, 수집기 점검 필요`);
    }
    // 클릭 후 새 응답 대기
    let w = 0; let cc = await readCaptures();
    while (cc.length <= before && w < 10000) { await sleep(500); w += 500; cc = await readCaptures(); }
    if (cc.length <= before) {
      throw new Error(`쿠팡 페이지 ${pageNum + 1} 응답 미수신(클릭 후) — 차단/화면 변경 의심`);
    }
    if (await hasBlockText()) {
      throw new Error('Akamai 차단 감지(페이지 이동 중 권한 없음) — 즉시 중단');
    }
    pageData = latestData(cc) || {};
    pageNum++;
  }
  log(`   [UI] target ${dr.startDash}~${dr.endDash} 수집: ${collected.length}건 (페이지 범위 전체 ${rangeTotal}건 중)`);
  return await processAndSend({ name, id, dr, allOrders: collected, totalOrderCount: collected.length, totalSalePrice });
}

/* ─────────── 매장별 수집 (XHR API) ─────────── */
async function collectStore(name, id, dr) {
  log(`\n===== ${name} (${id}) =====`);

  // 주문 페이지로 이동 (쿠키가 해당 매장 컨텍스트에 세팅되도록)
  const url = `https://store.coupangeats.com/merchant/management/orders/${id}`;
  await nav(url);
  await jsleep(5000);
  await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
  await jsleep(1000);
  await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});

  // 매장 주문페이지에 Akamai 차단 문구(권한 없음/페이지 오류)가 떠 있으면 즉시 중단.
  // 밀어붙여 다음 매장·페이지를 계속 두드리면 하드블록으로 번진다. 메시지에 'Akamai' 를
  // 넣어 collect-stores 의 isThrottleError 가 잡아 전역 쿨다운을 걸게 한다.
  if (await hasBlockText()) {
    throw new Error('Akamai 차단 감지(매장 주문페이지 권한 없음) — 즉시 중단');
  }

  // 사람이 주문 목록을 "읽는" 동작 — 마우스로 훑고, 스크롤하며 충분히 머문 뒤 조회.
  // 페이지 로드 직후 즉시 fetch 난사는 기계적 신호(클릭/마우스 없는 XHR). 행동 엔트로피 +
  // 넉넉한 dwell 로 정상 사용자 패턴에 가깝게. 샵인샵 다중매장일수록 이 dwell 이 중요.
  await humanMouse(rnd(3, 6));
  await webView.webContents.executeJavaScript(JS_HUMAN_SCROLL).catch(()=>{});
  await hsleep(2500, 6000);
  await humanMouse(rnd(1, 3));

  // 진단 모드: 페이지 자동조회 XHR 이 잡힐 시간을 좀 더 준 뒤 DOM+캡처 덤프(수집은 그대로 진행).
  if (UI_INSPECT) {
    await hsleep(1500, 2500);
    await dumpInspect(name, id);
  }

  // XHR API 호출 (JSON.stringify로 반환 → JSON.parse로 파싱, 직렬화 문제 방지)
  log(`   API 호출: storeId=${id}, ${dr.startDash}(${dr.startMs}) ~ ${dr.endDash}(${dr.endMs})`);
  const apiResultStr = await webView.webContents.executeJavaScript(jsFetchOrders(id, dr.startMs, dr.endMs));
  const apiResult = JSON.parse(apiResultStr);

  if (!apiResult.success) {
    // 403/429 = Akamai 차단/레이트리밋 → throttle 로 표시해 즉시 중단(전역 쿨다운).
    if (apiResult.status === 403 || apiResult.status === 429) {
      throw new Error(`Akamai 차단(주문 API ${apiResult.status}) — 즉시 중단`);
    }
    throw new Error(`API 호출 실패: ${apiResult.error}`);
  }

  const data = apiResult.data;
  // 디버그: 응답 구조 확인
  const topKeys = Object.keys(data || {});
  log(`   API 응답 키: ${topKeys.join(', ')}`);
  if (data.orderPageVo) {
    log(`   orderPageVo 키: ${Object.keys(data.orderPageVo).join(', ')}`);
    log(`   content 타입: ${typeof data.orderPageVo.content}, 길이: ${Array.isArray(data.orderPageVo.content) ? data.orderPageVo.content.length : 'N/A'}`);
  } else {
    log(`   orderPageVo 없음! 전체 응답 (처음 500자): ${JSON.stringify(data).substring(0, 500)}`);
  }

  const orders = data.orderPageVo?.content || data.content || [];
  const totalOrderCount = data.totalOrderCount || data.orderPageVo?.totalElements || 0;
  const totalSalePrice = data.totalSalePrice || 0;

  log(`   API 응답: totalOrderCount=${totalOrderCount}, totalSalePrice=${totalSalePrice}, 수신=${orders.length}건`);

  // pageSize=100으로 조회, 추가 페이지 자동 호출
  const PAGE_SIZE = 10;
  const allOrders = [...orders];
  if (totalOrderCount > PAGE_SIZE) {
    const totalPages = Math.ceil(totalOrderCount / PAGE_SIZE);
    for (let page = 1; page < totalPages; page++) {
      // 사람이 한 페이지(약 10건)를 읽고 다음으로 넘기듯 — 스크롤·마우스 후 충분히 쉰다.
      // 연속 API 난사는 rate 신호의 핵심이라 페이지네이션을 가장 사람답게 늦춘다.
      await webView.webContents.executeJavaScript(JS_HUMAN_SCROLL).catch(()=>{});
      await humanMouse(rnd(1, 3));
      await hsleep(2500, 6500);
      log(`   추가 페이지 ${page}/${totalPages - 1} 호출... (0-indexed)`);
      const pageResultStr = await webView.webContents.executeJavaScript(`(async function(){
        try {
          const meta2 = btoa(JSON.stringify({
            o: location.origin, ua: navigator.userAgent.substring(0, navigator.userAgent.indexOf('Chrome/') + 12),
            r: location.href, t: Date.now(), sr: screen.width + 'x' + screen.height, l: navigator.language
          }));
          const res = await fetch('https://store.coupangeats.com/api/v1/merchant/web/order/condition', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=UTF-8', 'x-request-meta': meta2, 'x-requested-with': 'XMLHttpRequest' },
            credentials: 'include',
            body: JSON.stringify({
              pageNumber: ${page},
              pageSize: 10,
              storeId: ${id},
              startDate: ${dr.startMs},
              endDate: ${dr.endMs}
            })
          });
          if (!res.ok) return JSON.stringify({ success: false, error: 'HTTP ' + res.status, status: res.status });
          const data = await res.json();
          return JSON.stringify({ success: true, content: data.orderPageVo?.content || [] });
        } catch (err) {
          return JSON.stringify({ success: false, error: err.message });
        }
      })()`);
      const pageResult = JSON.parse(pageResultStr);
      if (pageResult.success) {
        log(`   페이지 ${page}: ${pageResult.content.length}건`);
        allOrders.push(...pageResult.content);
      } else if (pageResult.status === 403 || pageResult.status === 429) {
        // 페이지네이션 중 차단 → 더 두드리지 말고 즉시 중단(전역 쿨다운 유도).
        throw new Error(`Akamai 차단(페이지 ${page} API ${pageResult.status}) — 즉시 중단`);
      } else {
        log(`   페이지 ${page} 실패: ${pageResult.error}`);
      }
    }
  }

  return await processAndSend({ name, id, dr, allOrders, totalOrderCount, totalSalePrice });
}

// 공통 처리부: 수집된 주문(allOrders) → 통일 포맷 변환 · 날짜별 그룹핑 · 매출지킴이 전송 · 반환.
// raw-fetch(collectStore) 와 UI-구동(collectStoreViaUi) 양쪽이 이걸 호출한다.
async function processAndSend({ name, id, dr, allOrders, totalOrderCount, totalSalePrice }) {
  log(`   총 수신: ${allOrders.length}건`);

  // DUMP_RAW=1 시 raw 응답 샘플 수집
  for (const o of allOrders) rawDumper.add(o);

  // API 응답 → 통일 포맷 변환 + 날짜별 그룹핑
  const converted = allOrders.map(o => {
    const dateStr = msToKstDate(o.createdAt);
    const kst = new Date(o.createdAt + 9 * 3600000);
    const time = `${String(kst.getUTCHours()).padStart(2,'0')}:${String(kst.getUTCMinutes()).padStart(2,'0')}`;

    const settlement = o.orderSettlement || {};
    return {
      date: dateStr,
      time,
      orderId: o.abbrOrderId || '',
      uniqueOrderId: o.uniqueOrderId || '',
      storeName: o.store?.storeName || name,
      storeId: String(o.storeId || id),
      status: o.status || '',
      salePrice: o.salePrice || 0,
      totalAmount: o.totalAmount || 0,
      actuallyAmount: o.actuallyAmount || 0,
      menuSummary: (o.items || []).map(i => `${i.name} x${i.quantity}`).join(', '),
      // 메뉴 라인 (자동출고용) — dishId(안정 메뉴ID)·단가·itemOptions(optionItemId) 보존.
      // 노심 인제스트가 crawler_order_items(platform_menu_id=dishId, options) 로 저장.
      items: (o.items || []).map(i => ({
        dishId: i.dishId,
        name: i.name,
        quantity: i.quantity,
        unitSalePrice: i.unitSalePrice,
        subTotalPrice: i.subTotalPrice,
        itemOptions: (i.itemOptions || []).map(opt => ({
          optionItemId: opt.optionItemId,
          optionName: opt.optionName,
          optionQuantity: opt.optionQuantity,
          optionPrice: opt.optionPrice,
        })),
      })),
      // 정산 상세 (API 응답 그대로)
      settlement: {
        commissionTotal: settlement.commissionTotal || 0,
        commissionVat: settlement.commissionVat || 0,
        serviceSupplyPrice: settlement.serviceSupplyPrice?.appliedSupplyPrice || 0,
        paymentSupplyPrice: settlement.paymentSupplyPrice?.appliedSupplyPrice || 0,
        deliverySupplyPrice: settlement.deliverySupplyPrice?.appliedSupplyPrice || 0,
        advertisingSupplyPrice: settlement.advertisingSupplyPrice?.appliedSupplyPrice || 0,
        storePromotionAmount: settlement.storePromotionAmount || 0,
        favorableFee: settlement.favorableFee || 0,
        settlementDueDate: settlement.settlementDueDate || '',
        hasSettled: settlement.hasSettled || false,
        mfdTotalAmount: settlement.mfdTotalAmount || 0,
        subtractAmount: settlement.subtractAmount || 0,
      },
      settlementStatus: settlement.hasSettled ? '정산완료' : '정산예정',
      amount: o.salePrice || 0,
    };
  });

  // 날짜별 그룹핑
  const byDate = {};
  for (const o of converted) {
    if (!byDate[o.date]) byDate[o.date] = [];
    byDate[o.date].push(o);
  }
  const dates = Object.keys(byDate).sort();
  const daily = dates.map(d => {
    const day = byDate[d];
    const sales = day.reduce((s, o) => s + o.salePrice, 0);
    const actuallyTotal = day.reduce((s, o) => s + o.actuallyAmount, 0);
    const settled = day.filter(o => o.settlementStatus === '정산완료').length;
    return {
      date: d,
      orderCount: day.length,
      totalSales: sales,
      actuallyTotal,
      settledCount: settled,
      unsettledCount: day.length - settled,
    };
  });

  // 날짜별 매출지킴이 API 전송
  for (const d of dates) {
    const dayOrders = byDate[d];
    await sendToSalesKeeper('coupangeats', d, id, name, dayOrders);
  }

  // 0건 마커 sweep — 요청 기간 중 주문 없는 날짜에도 빈 페이로드로 sync log 남김
  const sweepStat = await sweepMissingDates(dr.startDash, dr.endDash, dates, (md) =>
    sendToSalesKeeper('coupangeats', md, id, name, [])
  );
  if (sweepStat.sent > 0) log(`   0건 마커: ${sweepStat.sent}/${sweepStat.total}일`);

  // 진행 상황 emit
  emit('progress', { current: converted.length, total: totalOrderCount, date: dr.endDash });

  const grandTotal = {
    orderCount: converted.length,
    totalSales: converted.reduce((s, o) => s + o.salePrice, 0),
    actuallyTotal: converted.reduce((s, o) => s + o.actuallyAmount, 0),
  };

  log(`   완료: ${converted.length}건, ${dates.length}일, 매출=${grandTotal.totalSales}원, 실수령=${grandTotal.actuallyTotal}원`);

  return {
    storeName: name,
    storeId: id,
    requestedPeriod: `${dr.startDash} ~ ${dr.endDash}`,
    apiSummary: { totalOrderCount, totalSalePrice },
    totalOrders: converted.length,
    totalDays: dates.length,
    grandTotal,
    dailySummaries: daily,
    orders: converted,
  };
}

/* ═══════════════════════════ MAIN ═══════════════════════════ */
app.whenReady().then(async () => {
  fs.writeFileSync(LOG_FILE, '');

  if (!config.id || !config.pw) {
    emit('error', { error: '--id=ID --pw=PW 필요' });
    app.exit(1); return;
  }

  const dr = getDateRangeByMode();
  emit('status', { msg: `쿠팡이츠 수집 시작 (${config.mode}: ${dr.startDash} ~ ${dr.endDash})` });
  log(`=== 쿠팡이츠 워커: ${config.mode} (${dr.startDash} ~ ${dr.endDash}) ===`);
  log(`   타임스탬프: ${dr.startMs} ~ ${dr.endMs}`);

  mainWindow = new BrowserWindow({ width: 1200, height: 900, show: SHOW });
  mainWindow.loadURL('about:blank');
  // 진단/UI-구동 모드에서 preload(주문 XHR 캡처) 주입 — 평소 raw-fetch 수집은 그대로 유지.
  const webPreferences = { contextIsolation: false, nodeIntegration: false };
  if (UI_INSPECT || UI_DRIVE) webPreferences.preload = path.join(__dirname, 'coupang-preload.js');
  webView = new WebContentsView({ webPreferences });
  mainWindow.contentView.addChildView(webView);
  const [w, h] = mainWindow.getContentSize();
  webView.setBounds({ x: 0, y: 0, width: w, height: h });

  try {
    const ses = webView.webContents.session;
    // 세션 영속 — clearStorageData 제거. 매장별 user-data-dir 로 계정 격리(공유 시 다른
    // 매장 계정 세션 오염 방지, baemin 과 동일 패턴). 살아있는 세션은 재사용해 봇감지 회피.
    //
    // UA 는 실제 OS + 실제 Chromium 메이저로 생성. 기존엔 Windows 수집 PC 에서도 Mac UA 를
    // 하드코딩 → navigator.platform(Win32) 불일치(봇신호)였다. Electron/앱 토큰도 제거된다.
    const ua = buildUserAgent(process.platform, process.versions.chrome);
    log(`   UA: ${ua}`);
    ses.setUserAgent(ua); webView.webContents.setUserAgent(ua);

    // ── [로그인화면 DOM 수집 모드] 임시 빈 세션이라 로그인 페이지가 떠야 정상. DOM 덤프 후 종료.
    if (INSPECT_LOGIN) {
      emit('status', { msg: '쿠팡 로그인화면 DOM 수집 중...' });
      log('1) [로그인진단] 로그인 페이지 이동...');
      await nav('https://store.coupangeats.com/merchant/login');
      log('   Akamai 센서 대기(~10초)...');
      await jsleep(10000);
      const blocked = await hasBlockText();
      const curUrl = webView.webContents.getURL();
      const dump = await webView.webContents.executeJavaScript(JS_DUMP_LOGIN).catch((e) => JSON.stringify({ error: String(e) }));
      const header = `\n===== LOGIN-INSPECT ${new Date().toISOString()} (blocked=${blocked}, url=${curUrl}, isLogin=${isLogin(curUrl)}) =====\n`;
      try { fs.appendFileSync(INSPECT_FILE, header + dump + '\n'); } catch {}
      log(`   로그인화면 덤프: ${dump}`);
      if (!isLogin(curUrl)) log('   ⚠️ 로그인 페이지가 아님(임시 세션인데 로그인 상태?) — 덤프가 비어있을 수 있음');
      emit('status', { msg: `로그인화면 DOM 덤프 완료: coupang-inspect.txt` });
      emit('done', {});
      setTimeout(() => app.exit(0), 3000);
      return;
    }

    // ── 1) 로그인 (세션 우선) ──
    emit('status', { msg: '쿠팡이츠 세션 확인 중...' });
    log('1) 세션 확인...');
    await nav('https://store.coupangeats.com/merchant/login');
    log('   Akamai 센서 대기(~10초)...');
    // Akamai JS 센서가 돌며 _abck/bm_sz 를 세팅할 시간. 고정 10초는 기계적이라 분산.
    await jsleep(10000);
    await humanMouse(rnd(2, 4));
    let url = webView.webContents.getURL();

    // Akamai 차단 문구가 화면에 떠 있으면 = 봇감지/throttle → 즉시 중단(재시도가 차단을 키움).
    if (await hasBlockText()) {
      throw new Error('Akamai 차단 감지(권한 없음/페이지 오류) — 즉시 중단, 쿨다운 필요');
    }

    if (isLogin(url)) {
      // 세션 없음/만료
      log('   세션 없음/만료');

      // 로그인 화면 DOM(체크박스+라벨/id/name)을 진단파일에 항상 덤프 — 추측 대신 실측으로
      // '로그인 상태 유지' 셀렉터를 확정하기 위함(orders 진단과 동일 방식). 다음 세션만료 때
      // 자동 캡처되니 coupang-inspect.txt 를 개발자에게 보내면 정밀 보완.
      try {
        const dump = await webView.webContents.executeJavaScript(JS_DUMP_LOGIN);
        log(`   로그인화면 체크박스: ${dump}`);
        try { fs.appendFileSync(INSPECT_FILE, `\n===== LOGIN ${new Date().toISOString()} =====\n${dump}\n`); } catch {}
      } catch {}
      // 라벨이 명확히 '로그인 상태 유지'류인 체크박스만 켠다(엉뚱한 박스 안 건드림). 세션 수명↑.
      const keep = await webView.webContents.executeJavaScript(JS_CHECK_KEEP_LOGIN).catch(() => null);
      if (keep && keep.found) log(`   '로그인 상태 유지' 체크: ${keep.label || ''} (checked=${keep.checked})`);
      else log(`   '로그인 상태 유지' 라벨 매칭 실패(box ${keep ? keep.count : '?'}개) — DOM 덤프로 보완 예정`);

      // a) 자동 로그인 — 사람 같은 타이핑(jsLogin)으로 1회만. 세션 만료 시 무인 복구용.
      //    Akamai 최고위험 지점이라: 1회만, 차단 신호 뜨면 즉시 중단. config.coupangAutoLogin 로 끔.
      if (AUTO_LOGIN) {
        log('   자동 로그인 시도 (사람 같은 타이핑, 1회)');
        await humanMouse(rnd(2, 4));
        const hf = await webView.webContents.executeJavaScript(`({i:!!document.getElementById('loginId'),p:!!document.getElementById('password')})`);
        if (hf.i && hf.p) {
          const lr = await webView.webContents.executeJavaScript(jsLogin(config.id, config.pw));
          if (lr.success) { log('   자동 로그인 제출 — 응답 대기...'); await jsleep(10000); url = webView.webContents.getURL(); }
        }
        // 자동 로그인 직후 차단 문구 뜨면 즉시 중단(난타 금지). 메시지에 'Akamai' → 전역 쿨다운.
        if (await hasBlockText()) {
          throw new Error('Akamai 차단 감지(자동 로그인 직후) — 즉시 중단, 쿨다운 필요');
        }
        if (!isLogin(url)) log('   자동 로그인 성공 — 세션 저장됨 (이후 자동 재사용)');
      }

      // b) 자동 로그인이 실패/비활성이면 수동 로그인 대기(--show, 사람이 있을 때만 의미).
      if (isLogin(url)) {
        if (SHOW) {
          emit('status', { msg: '쿠팡이츠 세션 만료 — 창에서 직접 로그인해 주세요 (180초 대기)' });
          log('   세션 만료 — 수동 로그인 대기 180초 (--show)');
          url = await waitForLoginRedirect(180000);
        }
        if (await hasBlockText()) {
          throw new Error('Akamai 차단 감지(로그인 화면) — 즉시 중단, 쿨다운 필요');
        }
        if (isLogin(url)) {
          emit('error', { error: '쿠팡이츠 세션 만료 — 자동 로그인 실패. 사무실 PC 창에서 1회 로그인 필요' });
          throw new Error('세션 만료 — 재인증 필요');
        }
        log('   수동 로그인 성공 — 세션 저장됨 (이후 자동 재사용)');
      }
    } else {
      log('   기존 세션 재사용 (로그인 스킵)');
    }
    log(`   -> ${url}`);
    log('   로그인 완료');

    const defId = (url.match(/\/(\d+)$/) || [])[1] || '';
    log(`   기본 storeId: ${defId}`);
    await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
    await jsleep(1000);
    await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});

    // ── 2) 매장 탐색 ──
    emit('status', { msg: '매장 탐색 중...' });
    log('\n2) 매장 탐색...');
    await nav(`https://store.coupangeats.com/merchant/management/home/${defId}`);
    await jsleep(5000);
    await humanMouse(rnd(1, 3));
    await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
    await jsleep(2000);
    await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});

    // 매장 페이지에 Akamai/오류 토스트(매장목록 실패·페이지 작동안함)면 throttle → 즉시 중단.
    // (빈손으로 진행해 done 만 찍고 끝내면 #58 쿨다운이 안 걸려 30분마다 또 두드림)
    if (await hasBlockText()) {
      throw new Error('Akamai throttle: 매장 페이지 조회 차단 — 즉시 중단, 쿨다운 필요');
    }

    const sr = await webView.webContents.executeJavaScript(JS_FIND_STORES);
    log(`   결과: success=${sr.success} method=${sr.method||'-'} stores=${sr.stores?.length||0}`);

    let stores = [];
    if (sr.success && sr.stores.length > 0) {
      stores = sr.stores;
      for (const s of stores) {
        if (!s.storeId) {
          await nav(`https://store.coupangeats.com/merchant/management/home/${defId}`);
          await jsleep(4000);
          await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
          await jsleep(1000);
          await webView.webContents.executeJavaScript(`(async function(){
            const s=ms=>new Promise(r=>setTimeout(r,ms));
            const sel = document.querySelector('.home-store-selector .button.extend-select') ||
                        document.querySelector('.home-store-selector') ||
                        document.querySelector('[class*="store-selector"]');
            if (sel) sel.click();
            await s(1500);
            const target = ${JSON.stringify(s.storeName)};
            const items = document.querySelectorAll('[class*="extend"] *, [class*="select"] *, [class*="dropdown"] *, [class*="option"] *, li, div');
            for (const item of items) {
              const text = (item.innerText?.trim() || '').split('\\n')[0].trim();
              if (text === target && item.offsetHeight > 0 && item.offsetHeight < 60) {
                item.click(); break;
              }
            }
          })()`);
          await jsleep(5000);
          const newUrl = webView.webContents.getURL();
          const idMatch = newUrl.match(/\/(\d{5,})/);
          if (idMatch && idMatch[1] !== defId) {
            s.storeId = idMatch[1];
          } else {
            const pageStoreId = await webView.webContents.executeJavaScript(`(function(){
              const url = window.location.href;
              const m = url.match(/(\\d{5,})/);
              return m ? m[1] : '';
            })()`);
            if (pageStoreId && pageStoreId !== defId) s.storeId = pageStoreId;
          }
        }
        if (!s.storeId) s.storeId = defId;
      }
    } else {
      // 매장 탐색 실패 + 기본 storeId(defId)도 없으면 = 페이지/세션 이상(throttle 추정) → 중단.
      if (!defId) {
        throw new Error('매장 식별 실패(defId 없음) — throttle/세션 이상 추정, 즉시 중단');
      }
      const name = await webView.webContents.executeJavaScript(`(function(){
        let n='';document.querySelectorAll('*').forEach(el=>{
          const r=el.getBoundingClientRect();
          if(r.left<280&&r.top>20&&r.top<200&&el.offsetHeight>0&&el.offsetHeight<50){
            const t=el.innerText?.trim()||'';
            if(t.match(/.+점$/)&&t.length>3&&t.length<25&&el.children.length===0)n=t;}});return n})()`);
      stores = [{ storeName: name || `매장_${defId}`, storeId: defId }];
    }

    // 중복 제거
    const uniqueStores = [];
    const seenIds = new Set();
    for (const s of stores) {
      if (!seenIds.has(s.storeId)) { seenIds.add(s.storeId); uniqueStores.push(s); }
    }
    stores = uniqueStores;

    for (const s of stores) {
      emit('shop', { shopName: s.storeName, shopId: s.storeId });
    }

    // ── 3) 매장별 수집 ──
    // UI-구동(--ui-drive, daily 모드): 페이지 자체 XHR 캡처 + 실제 '다음' 클릭. 백필(daily 아님)은 raw fetch.
    const useUi = UI_DRIVE && config.mode === 'daily';
    log(useUi ? '   [모드] UI-구동 수집' : '   [모드] raw-fetch 수집');
    const results = [];
    for (let i = 0; i < stores.length; i++) {
      const st = stores[i];
      // 매장 전환 간격 — 사람이 한 매장을 충분히 본 뒤 다음으로 넘기듯 넉넉히(12~35s).
      // 샵인샵 다중매장을 5초 간격으로 연속 조회하던 게 "권한 없음"의 주요 트리거였다.
      if (i > 0) await hsleep(12000, 35000);
      log(`\n======== 매장 ${i+1}/${stores.length}: ${st.storeName} (${st.storeId}) ========`);
      emit('status', { msg: `${st.storeName} 주문 조회 중...${useUi ? ' (UI)' : ' (API)'}` });
      try {
        results.push(await (useUi ? collectStoreViaUi : collectStore)(st.storeName, st.storeId, dr));
      } catch (err) {
        const msg = err?.message || String(err);
        log(`   ERROR: ${msg}`);
        results.push({ storeName: st.storeName, storeId: st.storeId, error: msg,
          orders: [], dailySummaries: [], totalOrders: 0 });
        // 중단 조건: ① Akamai 차단/throttle(하드블록 예방) ② UI-구동 실패(화면 변경 — 사장님이
        // Slack 받고 수동수집 하기로 함). 재던져서 메인 catch → exit 1 → collect-stores 가
        // 쿨다운 + reportFailure(Slack). UI-구동이 아니고 일반 실패면 다음 매장은 계속 시도.
        if (useUi || /Akamai|권한이 존재하지 않|매장 목록을 불러오지|페이지가 작동하지/.test(msg)) {
          throw new Error((useUi ? '쿠팡 UI-구동 수집 실패 — ' : 'Akamai 차단으로 남은 매장 수집 중단 — ') + msg);
        }
      }
    }

    // ── 4) 결과 ──
    emit('result', {
      site: 'coupangeats',
      shops: results.map(r => ({
        shopName: r.storeName,
        shopId: r.storeId,
        orders: r.orders,
        dailySummaries: r.dailySummaries,
        totalOrders: r.totalOrders || 0,
        grandTotal: r.grandTotal,
        apiSummary: r.apiSummary,
      })),
    });

    rawDumper.flush(config.targetDate || new Date().toISOString().slice(0, 10), { mode: config.mode });

    log('\n=== 쿠팡이츠 워커 완료 ===');
    emit('done', {});

  } catch (err) {
    log(`\nERROR: ${err?.message || err}`);
    emit('error', { error: err?.message || String(err) });
    exitCode = 1; // 실패/차단 → 비정상 종료로 알려 collect-stores 가 쿨다운·보고하게 함
  }
  setTimeout(() => app.exit(exitCode), 5000);
});

app.on('window-all-closed', () => app.exit(exitCode));
