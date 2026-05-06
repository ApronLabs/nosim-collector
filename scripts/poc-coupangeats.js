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
const LOG_FILE = path.join(__dirname, 'poc-coupangeats-log.txt');

// ── stdout JSON 프로토콜 ──
function emit(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  return `(async function(){
    const s=ms=>new Promise(r=>setTimeout(r,ms));await s(2000);
    const i=document.getElementById('loginId'),p=document.getElementById('password');
    if(!i||!p)return{success:false,error:'no form'};
    function t(el,v){el.focus();el.click();
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}));
      for(let c=0;c<v.length;c++){set.call(el,el.value+v[c]);el.dispatchEvent(new Event('input',{bubbles:true}));}
      el.dispatchEvent(new Event('change',{bubbles:true}));}
    t(i,${JSON.stringify(id)});await s(300);t(p,${JSON.stringify(pw)});await s(500);
    const b=Array.from(document.querySelectorAll('button')).find(b=>b.innerText.trim()==='로그인');
    if(!b)return{success:false,error:'no btn'};b.click();return{success:true};
  })()`;
}

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
      // x-request-meta 생성 (Akamai 우회용)
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

/* ─────────── 매장별 수집 (XHR API) ─────────── */
async function collectStore(name, id, dr) {
  log(`\n===== ${name} (${id}) =====`);

  // 주문 페이지로 이동 (쿠키가 해당 매장 컨텍스트에 세팅되도록)
  const url = `https://store.coupangeats.com/merchant/management/orders/${id}`;
  await nav(url);
  await sleep(5000);
  await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
  await sleep(1000);
  await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});

  // XHR API 호출 (JSON.stringify로 반환 → JSON.parse로 파싱, 직렬화 문제 방지)
  log(`   API 호출: storeId=${id}, ${dr.startDash}(${dr.startMs}) ~ ${dr.endDash}(${dr.endMs})`);
  const apiResultStr = await webView.webContents.executeJavaScript(jsFetchOrders(id, dr.startMs, dr.endMs));
  const apiResult = JSON.parse(apiResultStr);

  if (!apiResult.success) {
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
          if (!res.ok) return JSON.stringify({ success: false, error: 'HTTP ' + res.status });
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
      } else {
        log(`   페이지 ${page} 실패: ${pageResult.error}`);
      }
    }
  }

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
      items: (o.items || []).map(i => ({ name: i.name, quantity: i.quantity })),
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
    app.quit(); return;
  }

  const dr = getDateRangeByMode();
  emit('status', { msg: `쿠팡이츠 수집 시작 (${config.mode}: ${dr.startDash} ~ ${dr.endDash})` });
  log(`=== 쿠팡이츠 워커: ${config.mode} (${dr.startDash} ~ ${dr.endDash}) ===`);
  log(`   타임스탬프: ${dr.startMs} ~ ${dr.endMs}`);

  mainWindow = new BrowserWindow({ width: 1200, height: 900, show: SHOW });
  mainWindow.loadURL('about:blank');
  webView = new WebContentsView({ webPreferences: { contextIsolation: false, nodeIntegration: false } });
  mainWindow.contentView.addChildView(webView);
  const [w, h] = mainWindow.getContentSize();
  webView.setBounds({ x: 0, y: 0, width: w, height: h });

  try {
    const ses = webView.webContents.session;
    await ses.clearStorageData(); await ses.clearCache();
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    ses.setUserAgent(ua); webView.webContents.setUserAgent(ua);

    // ── 1) 로그인 ──
    emit('status', { msg: '쿠팡이츠 로그인 중...' });
    log('1) 로그인...');
    await nav('https://store.coupangeats.com/merchant/login');
    log('   Akamai 10초...');
    await sleep(10000);
    const hf = await webView.webContents.executeJavaScript(`({i:!!document.getElementById('loginId'),p:!!document.getElementById('password')})`);
    if (!hf.i || !hf.p) { await sleep(5000);
      const r = await webView.webContents.executeJavaScript(`({i:!!document.getElementById('loginId'),p:!!document.getElementById('password')})`);
      if (!r.i || !r.p) throw new Error('로그인 폼 없음');
    }
    const lr = await webView.webContents.executeJavaScript(jsLogin(config.id, config.pw));
    if (!lr.success) throw new Error(`로그인 실패: ${lr.error}`);
    log('   로그인 응답 10초...');
    await sleep(10000);
    let url = webView.webContents.getURL();
    log(`   -> ${url}`);
    if (isLogin(url)) {
      emit('error', { error: '쿠팡이츠 로그인 실패' });
      throw new Error('로그인 잔류');
    }
    log('   로그인 완료');

    const defId = (url.match(/\/(\d+)$/) || [])[1] || '';
    log(`   기본 storeId: ${defId}`);
    await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
    await sleep(1000);
    await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});

    // ── 2) 매장 탐색 ──
    emit('status', { msg: '매장 탐색 중...' });
    log('\n2) 매장 탐색...');
    await nav(`https://store.coupangeats.com/merchant/management/home/${defId}`);
    await sleep(5000);
    await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
    await sleep(2000);
    await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});

    const sr = await webView.webContents.executeJavaScript(JS_FIND_STORES);
    log(`   결과: success=${sr.success} method=${sr.method||'-'} stores=${sr.stores?.length||0}`);

    let stores = [];
    if (sr.success && sr.stores.length > 0) {
      stores = sr.stores;
      for (const s of stores) {
        if (!s.storeId) {
          await nav(`https://store.coupangeats.com/merchant/management/home/${defId}`);
          await sleep(4000);
          await webView.webContents.executeJavaScript(JS_DISMISS).catch(()=>{});
          await sleep(1000);
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
          await sleep(5000);
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

    // ── 3) 매장별 수집 (XHR API) ──
    const results = [];
    for (let i = 0; i < stores.length; i++) {
      const st = stores[i];
      log(`\n======== 매장 ${i+1}/${stores.length}: ${st.storeName} (${st.storeId}) ========`);
      emit('status', { msg: `${st.storeName} 주문 조회 중... (API)` });
      try {
        results.push(await collectStore(st.storeName, st.storeId, dr));
      } catch (err) {
        log(`   ERROR: ${err?.message || err}`);
        results.push({ storeName: st.storeName, storeId: st.storeId, error: err?.message || String(err),
          orders: [], dailySummaries: [], totalOrders: 0 });
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
  }
  setTimeout(() => app.quit(), 5000);
});

app.on('window-all-closed', () => app.quit());
