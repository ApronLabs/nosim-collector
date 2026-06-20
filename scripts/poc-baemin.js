/**
 * 배민 워커: 매장별 수집
 * 실행: npx electron poc-baemin.js --id=아이디 --pw=비밀번호 --mode=backfill|daily --targetDate=YYYY-MM-DD
 *       --storeId=매장UUID --serverUrl=http://localhost:3000 --sessionToken=JWT토큰
 */

const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const { RawDumper } = require('./lib/raw-dumper');
const { sweepMissingDates } = require('./lib/date-sweep');

const POC_VERSION = app.getVersion() || 'unknown';
const rawDumper = new RawDumper('baemin');

// ── CLI 인자 파싱 ──
function getArg(name) {
  const a = process.argv.find(a => a.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : '';
}

const config = {
  id: getArg('id'),
  pw: getArg('pw'),
  mode: getArg('mode') || 'backfill',       // backfill | daily
  targetDate: getArg('targetDate'),           // YYYY-MM-DD (daily 모드용)
  storeId: getArg('storeId'),                 // 매출지킴이 매장 UUID
  serverUrl: getArg('serverUrl'),             // http://localhost:3000
  sessionToken: getArg('sessionToken'),       // JWT 토큰
};

const os = require('os');
const LOG_FILE = path.join(os.homedir(), 'poc-baemin-log.txt');

// ── stdout JSON 프로토콜 ──
function emit(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
}
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  fs.appendFileSync(LOG_FILE, `[FATAL] ${err.message}\n`);
  emit('error', { error: err.message });
});
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 날짜 포맷 (로컬 시간 기준, UTC 변환 방지) ──
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ── 백필 시작일 — 올해 1월 1일 ──
// v3.5.4부터 매장이 보유한 전체 기간(최대 1월 1일~)에 대해 백필을 돌려
// 노심 백필 스크립트가 raw_data 기반 재해석을 할 수 있게 한다.
function getBackfillStart() {
  const now = new Date();
  return formatDate(new Date(now.getFullYear(), 0, 1));
}
function getYesterday() {
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return formatDate(yesterday);
}

// ── mode에 따른 날짜 범위 결정 ──
function getDateRangeByMode() {
  if (config.mode === 'daily') {
    if (!config.targetDate) throw new Error('daily 모드에서는 --targetDate=YYYY-MM-DD 필요');
    return { startDate: config.targetDate, endDate: config.targetDate };
  }
  // backfill: 1월 1일 ~ D-1 (v3.5.4부터 전 기간 백필)
  return { startDate: getBackfillStart(), endDate: getYesterday() };
}

// ── 배민 CPC 광고비 수집 ──
// /v2/statistics/campaign/cpc/metrics/{shopNumber}?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// → dailyMetrics[].spentBudget (일별 광고비, 원 단위)
async function collectAdCost(shopNumber, startDate, endDate, settlementDateMap = new Map()) {
  // 배민 광고비 API는 조회 기간 1개월 제한 → 월별 분할 호출
  const months = splitMonths(startDate, endDate);
  const allCosts = [];

  for (const month of months) {
    const apiUrl = `https://self-api.baemin.com/v2/statistics/campaign/cpc/metrics/${shopNumber}?startDate=${month.start}&endDate=${month.end}`;
    log(`   광고비 API: ${month.start} ~ ${month.end}`);
    const result = await fetchViaWebview(apiUrl);

    if (result?.error) {
      log(`   광고비 API 에러 (${month.start}): ${result.error}`);
      continue;
    }

    const dailyMetrics = result?.data?.dailyMetrics || [];
    // ★ v3.9.0: settlement_date 포함 (해당 매출일의 주문 depositDueDate 재사용).
    // 배민 CPC API는 settlement_date를 제공하지 않으므로 주문 데이터 맵에서 조회.
    const costs = dailyMetrics
      .filter(m => m.spentBudget > 0)
      .map(m => ({
        date: m.date,
        amount: m.spentBudget,
        settlementDate: settlementDateMap.get(m.date) || null,
      }));
    allCosts.push(...costs);

    if (months.length > 1) await sleep(1000);
  }

  const withSettleDate = allCosts.filter(c => c.settlementDate).length;
  log(`   광고비 합계: ${allCosts.length}일 / ${allCosts.reduce((a, c) => a + c.amount, 0)}원 (settlement_date 매핑: ${withSettleDate}/${allCosts.length})`);
  return allCosts;
}

// ── 광고비 별도 전송 ──
async function sendAdCostToSalesKeeper(shopId, dailyAdCosts) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return null;
  if (!dailyAdCosts || dailyAdCosts.length === 0) return null;

  const url = `${config.serverUrl}/api/stores/${config.storeId}/crawler/baemin/ad-cost`;
  const body = JSON.stringify({
    platformStoreId: shopId,
    dailyAdCosts,
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
    log(`   광고비 API 전송: ${res.status} (${dailyAdCosts.length}일)`);
    return { status: res.status, ok: res.ok };
  } catch (err) {
    log(`   광고비 API 전송 실패: ${err.message}`);
    return null;
  }
}

// ── 매출지킴이 API 전송 ──
async function sendToSalesKeeper(platform, targetDate, shopId, shopName, orders) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return null;
  const url = `${config.serverUrl}/api/stores/${config.storeId}/crawler/${platform}`;

  // POC 내부 필드명 → API 기대 필드명으로 변환
  const mappedOrders = orders.map(o => ({
    orderId: o.orderId || o.orderNo,
    orderedAt: o.orderedAt || o.date,
    orderType: o.deliveryType || null,
    orderStatus: o.orderStatus || null, // CLOSED | CANCELLED
    channel: null,
    paymentMethod: o.payType || null,
    menuSummary: o.menuSummary || null,
    menuAmount: o.menuAmount || 0,
    deliveryIncome: o.deliveryTip || 0,
    tipIncome: 0,
    // v3.9.2: 각 수수료 공급가 + VAT 이원 전송
    commissionFee: o.commissionFee || 0,
    commissionFeeVat: o.commissionFeeVat || 0,
    pgFee: o.pgFee || 0,
    pgFeeVat: o.pgFeeVat || 0,
    deliveryCost: o.deliveryCost || 0,
    deliveryFeeVat: o.deliveryFeeVat || 0,
    tipDiscount: o.deliveryTipDiscount || 0,
    tipDiscountVat: o.deliveryTipDiscountVat || 0,
    // v3.9.2: 매장 순부담 할인 (DISCOUNT_AMOUNT net), UI 표시 즉시할인 별도
    storeDiscount: o.storeDiscount || 0,
    instantDiscount: o.instantDiscount || 0,
    // v3.5.8: 쿠폰 할인 분리
    ownerCouponDiscount: o.ownerCouponDiscount || 0,
    platformSubsidy: o.platformSubsidy || 0,
    // v3.10.0: 배민 타임세일 분담분 ("주문금액 즉시할인 지원", DISCOUNT_AMOUNT.depth3Items)
    platformInstantSubsidy: o.platformInstantSubsidy || 0,
    vat: o.vat || 0,
    smallOrderFee: 0,
    cupDeposit: 0,
    meetPayment: o.meetAmount || 0,
    settlementAmount: o.depositDueAmount || 0,
    settlementDate: o.depositDueDate || null,
    // v3.5.4: 원본 API item 전달 (노심 route raw_data에 저장됨)
    rawItem: o.rawItem || null,
  }));

  const body = JSON.stringify({
    targetDate,
    platformStoreId: shopId,
    brandName: shopName,
    pocVersion: POC_VERSION,
    orders: mappedOrders,
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
    const status = res.status;
    log(`   API 전송 ${targetDate}: ${status}`);
    return { status, ok: res.ok };
  } catch (err) {
    log(`   API 전송 실패 ${targetDate}: ${err.message}`);
    emit('error', { error: `API 전송 실패 (${targetDate}): ${err.message}` });
    return null;
  }
}

// ── fetch/XHR 인터셉트 스크립트 ──
const INTERCEPT_SCRIPT = `(function() {
  if (window._baeminIntercepted) return;
  window._baeminIntercepted = true;
  window._baeminApiCaptures = [];

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (url.includes('self-api.baemin.com') || url.includes('/api/')) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        try {
          const json = JSON.parse(text);
          window._baeminApiCaptures.push({ url, data: json, ts: Date.now() });
          console.log('[intercept] fetch 캡처: ' + url.substring(0, 120));
        } catch {}
      } catch {}
    }
    return response;
  };

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._interceptUrl = url;
    this._interceptHeaders = {};
    return origXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._interceptHeaders) this._interceptHeaders[name] = value;
    return origXHRSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      const url = this._interceptUrl || '';
      if (url.includes('self-api.baemin.com') || url.includes('/api/')) {
        try {
          const json = JSON.parse(this.responseText);
          window._baeminApiCaptures.push({ url, data: json, headers: this._interceptHeaders, ts: Date.now() });
          console.log('[intercept] XHR 캡처: ' + url.substring(0, 120));
        } catch {}
      }
    });
    return origXHRSend.apply(this, args);
  };
})()`;

// ── 자동 로그인 스크립트 ──
function getAutoLoginScript(id, pw) {
  return `(async function() {
    await new Promise(r => setTimeout(r, 1000));
    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
    let idInput = null, pwInput = null;
    inputs.forEach(inp => { if ((inp.type||'').toLowerCase() === 'password') pwInput = inp; });
    inputs.forEach(inp => {
      if (inp === pwInput) return;
      const t = (inp.type||'').toLowerCase();
      if (t !== 'submit' && t !== 'button' && t !== 'file' && !idInput) idInput = inp;
    });
    if (!idInput || !pwInput) return { success: false, error: 'input not found (' + inputs.length + ')' };
    function typeInto(el, val) {
      el.focus();
      el.value = '';
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, val);
      if (el.value !== val) {
        nativeSetter.call(el, val);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    typeInto(idInput, ${JSON.stringify(id)});
    await new Promise(r => setTimeout(r, 300));
    typeInto(pwInput, ${JSON.stringify(pw)});
    await new Promise(r => setTimeout(r, 500));
    const btns = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
    for (const btn of btns) {
      const t = (btn.textContent||'').trim();
      if (t.includes('로그인') || t.includes('Login') || t.includes('Sign') || t.includes('LOG IN')) { btn.click(); return { success: true }; }
    }
    const sub = document.querySelector('button[type="submit"]');
    if (sub) { sub.click(); return { success: true }; }
    const forms = document.querySelectorAll('form');
    if (forms.length > 0) { forms[0].submit(); return { success: true, method: 'form.submit' }; }
    return { success: false, error: 'button not found' };
  })()`;
}

let mainWindow, webView;

// ── navigateAndWait ──
function navigateAndWait(url, timeoutMs = 30000) {
  return new Promise(resolve => {
    let resolved = false;
    const done = () => { if (resolved) return; resolved = true; clearTimeout(t); };
    const t = setTimeout(() => { done(); resolve(); }, timeoutMs);
    webView.webContents.once('did-finish-load', () => { done(); resolve(); });
    webView.webContents.loadURL(url).catch(() => {});
  });
}

function isLoginUrl(url) {
  return url.includes('/login') || url.includes('/signin') || url.includes('biz-member');
}

function waitForLoginRedirect(timeoutMs = 30000) {
  return new Promise(resolve => {
    const cur = webView.webContents.getURL();
    if (!isLoginUrl(cur)) { resolve(cur); return; }
    let resolved = false;
    const cleanup = () => {
      if (resolved) return; resolved = true;
      clearInterval(poll); clearTimeout(t);
      webView.webContents.removeListener('did-navigate', onNav);
      webView.webContents.removeListener('did-navigate-in-page', onNav);
    };
    const t = setTimeout(() => { cleanup(); resolve(webView.webContents.getURL()); }, timeoutMs);
    const onNav = (_, url) => { if (!isLoginUrl(url)) { cleanup(); resolve(url); } };
    webView.webContents.on('did-navigate', onNav);
    webView.webContents.on('did-navigate-in-page', onNav);
    const poll = setInterval(() => {
      const url = webView.webContents.getURL();
      if (!isLoginUrl(url)) { cleanup(); resolve(url); }
    }, 1000);
  });
}

// ── 웹뷰 XHR로 API 호출 ──
function fetchViaWebview(apiUrl) {
  return webView.webContents.executeJavaScript(`
    (function() {
      return new Promise(function(resolve) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', ${JSON.stringify(apiUrl)}, true);
        xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
        xhr.setRequestHeader('service-channel', 'SELF_SERVICE_PC');
        xhr.withCredentials = true;
        xhr.onload = function() {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve({ success: true, data: JSON.parse(xhr.responseText) }); }
            catch (e) { resolve({ error: 'JSON parse: ' + e.message }); }
          } else {
            resolve({ error: 'HTTP ' + xhr.status + ' ' + xhr.responseText.substring(0, 200), body: xhr.responseText.substring(0, 500) });
          }
        };
        xhr.onerror = function() {
          resolve({ error: 'XHR onerror (status=' + xhr.status + ', readyState=' + xhr.readyState + ')' });
        };
        xhr.ontimeout = function() {
          resolve({ error: 'XHR timeout' });
        };
        xhr.timeout = 30000;
        xhr.send();
      });
    })()
  `);
}

// ── 배민1플러스 상생요금제 수수료율 수집 (당일 비용 추정용) ──
// /v4/store/shop-owners/{shopOwnerNo} → baemin1PlusSalesScale.details:
//   serviceFee(중개이용료율 %) · min/maxDeliveryFee(배달비 범위) · koreanName(등급).
// 당일 주문은 배민이 settle 을 NOT_READY 로 비워줘 비용이 0 → 노심이 이 율로 추정
//   (중개료 = 율 × (메뉴 − 매장부담 즉시할인))하게 율을 전달한다. 등급은 매출규모따라
//   변동(changeDate)하므로 매 수집마다 최신값으로 갱신한다.
async function collectFeeRate(shopOwnerNumber) {
  try {
    const r = await fetchViaWebview(`https://self-api.baemin.com/v4/store/shop-owners/${shopOwnerNumber}`);
    if (r?.error) { log(`   수수료율 API 에러: ${r.error}`); return null; }
    const d = r?.data?.baemin1PlusSalesScale?.details;
    if (!d || d.serviceFee == null) { log('   수수료율 정보 없음 (baemin1PlusSalesScale)'); return null; }
    const rate = {
      serviceFee: d.serviceFee,                  // % (예: 7.8)
      minDeliveryFee: d.minDeliveryFee ?? null,
      maxDeliveryFee: d.maxDeliveryFee ?? null,
      gradeName: d.koreanName ?? null,           // "상위 35% 이내"
      gradeCode: d.detailCode ?? null,           // "NORMAL"
      changeDate: r.data.baemin1PlusSalesScaleChangeDate ?? null,
    };
    log(`   수수료율: 중개 ${rate.serviceFee}% · 배달 ${rate.minDeliveryFee}~${rate.maxDeliveryFee} · ${rate.gradeName}`);
    return rate;
  } catch (err) {
    log(`   수수료율 수집 실패: ${err.message}`);
    return null;
  }
}

// 수수료율을 노심에 전송 (매장owner당 1회). 노심은 store_id 단위로 저장해 당일 비용 추정에 쓴다.
async function sendFeeRateToSalesKeeper(rate) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return null;
  if (!rate || rate.serviceFee == null) return null;
  const url = `${config.serverUrl}/api/stores/${config.storeId}/crawler/baemin/fee-rate`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `session-token=${config.sessionToken}` },
      body: JSON.stringify({ ...rate, pocVersion: POC_VERSION }),
    });
    log(`   수수료율 전송: ${res.status}`);
    return { status: res.status, ok: res.ok };
  } catch (err) {
    log(`   수수료율 전송 실패: ${err.message}`);
    return null;
  }
}

// ── 데이터 매핑 함수 ──
// v3.9.2: 배민 정산명세서 A+B+C+D 블록 구조와 원 단위 일치하도록 필드 재정의.
//   - sale_price: orderBrokerageItems[ORDER_AMOUNT] (할인 전 주문금액, 옵션 포함)
//   - storeDiscount: orderBrokerageItems[DISCOUNT_AMOUNT] 절대값 (고객할인비용, 매장 순부담)
//   - commissionFee/deliveryCost/deliveryTipDiscount/pgFee: 각 code 별 공급가 (양수 정규화)
//   - *FeeVat: 공급가 비례분배 (배민은 deductionAmountTotalVat 합계만 제공)
// 원본은 rawItem 에 보존 — 필요 시 노심 백필이 재추출 가능.
function mapOrder(item) {
  rawDumper.add(item);
  const o = item.order, s = item.settle;
  const findCode = (items, code) => (items || []).find(i => i.code === code)?.amount ?? 0;
  // v3.10.0+: depth3Items 에서 특정 subCode 의 amount 추출.
  // 예: orderBrokerageItems 의 DISCOUNT_AMOUNT > depth3Items > WOOWABROS_ORDER_IMMEDIATE_DISCOUNT
  const findDepth3 = (items, parentCode, subCode) => {
    const parent = (items || []).find(i => i.code === parentCode);
    if (!parent || !Array.isArray(parent.depth3Items)) return 0;
    return parent.depth3Items.find(i => i.code === subCode)?.amount ?? 0;
  };

  // orderedAt KST suffix (v3.5.8 유지)
  let orderedAt = o.orderDateTime || '';
  if (orderedAt && !orderedAt.includes('+') && !orderedAt.includes('Z')) {
    orderedAt = orderedAt + '+09:00';
  }

  // 공급가 (모두 양수로 정규화)
  const saleAmount = findCode(s?.orderBrokerageItems, 'ORDER_AMOUNT') || o.payAmount || 0;
  const storeDiscount = Math.abs(findCode(s?.orderBrokerageItems, 'DISCOUNT_AMOUNT'));
  // v3.10.0+: "주문금액 즉시할인 지원" (타임세일 배민분담). DISCOUNT_AMOUNT.depth3Items 중
  // WOOWABROS_ORDER_IMMEDIATE_DISCOUNT code 가 양수로 주어짐 (배민이 매장에 지원하는 금액).
  // 2026-04-22 고기왕김치찜 사장님 피드백 반영 (엑셀 J열 "플랫폼지원" 누락 버그 수정).
  const platformInstantSubsidy = findDepth3(
    s?.orderBrokerageItems,
    'DISCOUNT_AMOUNT',
    'WOOWABROS_ORDER_IMMEDIATE_DISCOUNT'
  );
  const commissionFee = Math.abs(findCode(s?.orderBrokerageItems, 'ADVERTISE_FEE'));
  const deliveryCost = Math.abs(findCode(s?.deliveryItems, 'DELIVERY_SUPPLY_PRICE'));
  const deliveryTipDiscount = Math.abs(findCode(s?.deliveryItems, 'DEVLIERY_TIP_INSTANT_DISCOUNT'));
  const pgFee = Math.abs(findCode(s?.etcItems, 'SERVICE_FEE'));

  // VAT 공급가 비례분배 (배민은 합계만 제공)
  const vatTotal = Math.abs(s?.deductionAmountTotalVat ?? 0);
  const supplySum = commissionFee + deliveryCost + deliveryTipDiscount + pgFee;
  const allocVat = (supply) => supplySum > 0 ? Math.round(vatTotal * supply / supplySum) : 0;
  const commissionFeeVat = allocVat(commissionFee);
  const deliveryFeeVat = allocVat(deliveryCost);
  const deliveryTipDiscountVat = allocVat(deliveryTipDiscount);
  // 잔차는 pgFeeVat 에 몰아넣어 반올림 누적 오차 0 보장
  const pgFeeVat = Math.max(0, vatTotal - commissionFeeVat - deliveryFeeVat - deliveryTipDiscountVat);

  return {
    orderNo: o.orderNumber,
    orderId: o.orderNumber,
    orderedAt,
    date: o.orderDateTime,
    deliveryType: o.deliveryType,
    orderStatus: o.status || null,
    payType: o.payType,
    menuSummary: o.itemsSummary,
    // 주문금액 — 할인 전. 배민 정산서 "총매출"과 일치.
    menuAmount: saleAmount,
    deliveryTip: o.deliveryTip || 0,
    // v3.9.8+: instantDiscount 필드 제거.
    // 과거 totalInstantDiscountAmount(고객 관점 GROSS) 를 함께 보내서 노심 엑셀에서
    // storeDiscount + instantDiscount 이중 집계되는 버그가 있었음. storeDiscount 만으로 충분.
    instantDiscount: 0,
    // 고객할인비용 — 매장 순부담 (DISCOUNT_AMOUNT depth3 합산된 net 값)
    storeDiscount,
    ownerCouponDiscount: o.ownerChargeCouponDiscountAmount || 0,
    platformSubsidy: o.baeminChargeCouponDiscountAmount || 0,
    // v3.10.0+: 배민 타임세일 분담분 — 노심 DB 의 baemin_platform_subsidy 컬럼으로 저장.
    platformInstantSubsidy,
    // 각 수수료: 공급가 + VAT 이원
    commissionFee,
    commissionFeeVat,
    pgFee,
    pgFeeVat,
    deliveryCost,
    deliveryFeeVat,
    deliveryTipDiscount,
    deliveryTipDiscountVat,
    vat: vatTotal,
    meetAmount: s?.meetAmount || 0,
    depositDueAmount: s?.depositDueAmount || 0,
    depositDueDate: s?.depositDueDate || '',
    rawItem: item,
  };
}

// ── 월별 구간 분할 ──
function splitMonths(startDate, endDate) {
  const months = [];
  const [sy, sm, sdd] = startDate.split('-').map(Number);
  const [ey, em, edd] = endDate.split('-').map(Number);
  const sd = new Date(sy, sm - 1, sdd);
  const ed = new Date(ey, em - 1, edd);
  let cursor = new Date(sd);
  while (cursor <= ed) {
    const monthStart = formatDate(cursor);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const monthEndStr = monthEnd > ed ? endDate : formatDate(monthEnd);
    if (monthStart <= monthEndStr) {
      months.push({ start: monthStart, end: monthEndStr });
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return months;
}

// ── 매장 1개에 대한 주문 수집 ──
async function collectOrdersForShop(shopOwnerNumber, shopNumber, startDate, endDate) {
  const months = splitMonths(startDate, endDate);
  log(`   ${months.length}개 월별 구간으로 분할 조회`);

  const LIMIT = 100;
  const allOrders = [];

  // CLOSED + CANCELLED 별도 패스 (배민 API가 콤마 구분 미지원)
  const statuses = ['CLOSED', 'CANCELLED'];

  for (const orderStatus of statuses) {
    log(`\n   === ${orderStatus} 주문 수집 ===`);

  for (let mi = 0; mi < months.length; mi++) {
    const month = months[mi];
    log(`\n   -- [${mi + 1}/${months.length}] ${month.start} ~ ${month.end} (${orderStatus}) --`);
    let offset = 0;
    let totalSize = null;
    let pageNum = 0;

    while (true) {
      pageNum++;
      const apiUrl = `https://self-api.baemin.com/v4/orders?offset=${offset}&limit=${LIMIT}&purchaseType=&startDate=${month.start}&endDate=${month.end}&shopOwnerNumber=${shopOwnerNumber}&shopNumbers=${shopNumber}&orderStatus=${orderStatus}`;

      let result;
      let retries = 0;
      const MAX_RETRIES = 5;

      while (retries <= MAX_RETRIES) {
        result = await fetchViaWebview(apiUrl);

        if (result?.error && result.error.includes('429')) {
          retries++;
          const waitSec = 10 + (10 * retries);
          log(`   429 Rate Limit -> ${waitSec}초 대기 후 재시도 (${retries}/${MAX_RETRIES})...`);
          await sleep(waitSec * 1000);
          continue;
        }
        break;
      }

      if (result?.error) {
        log(`   API 에러: ${result.error}${result.body ? ' | body: ' + result.body : ''}`);
        break;
      }

      const data = result.data;
      if (totalSize === null) {
        totalSize = data.totalSize || 0;
        log(`   총 주문: ${totalSize}건`);
      }

      const contents = data.contents || [];
      allOrders.push(...contents);

      // 진행 상황 emit
      emit('progress', { current: allOrders.length, total: totalSize, date: month.start });

      offset += LIMIT;
      if (offset >= totalSize || contents.length === 0) break;

      await sleep(3000);
    }

    if (mi < months.length - 1) {
      await sleep(5000);
    }
  }

  } // end statuses loop

  return allOrders;
}

// ── 주문 데이터를 날짜별로 그룹핑 ──
function buildDailySummary(mapped) {
  const byDate = {};
  for (const m of mapped) {
    const dateKey = m.date ? m.date.split('T')[0] : 'unknown';
    if (!byDate[dateKey]) {
      byDate[dateKey] = { date: dateKey, orders: [], count: 0, totalMenuAmount: 0, totalDepositDue: 0 };
    }
    byDate[dateKey].orders.push(m);
    byDate[dateKey].count++;
    byDate[dateKey].totalMenuAmount += m.menuAmount || 0;
    byDate[dateKey].totalDepositDue += m.depositDueAmount || 0;
  }

  const sortedDates = Object.keys(byDate).sort();
  const dailySummary = sortedDates.map(d => ({
    date: d,
    orderCount: byDate[d].count,
    totalMenuAmount: byDate[d].totalMenuAmount,
    totalDepositDue: byDate[d].totalDepositDue,
  }));

  return { dailySummary, byDate, sortedDates };
}

app.whenReady().then(async () => {
  fs.writeFileSync(LOG_FILE, '');

  if (!config.id || !config.pw) {
    emit('error', { error: '--id=ID --pw=PW 필요' });
    app.quit(); return;
  }

  const { startDate, endDate } = getDateRangeByMode();
  emit('status', { msg: `배민 수집 시작 (${config.mode}: ${startDate} ~ ${endDate})` });
  log(`=== 배민 워커: ${config.mode} (${startDate} ~ ${endDate}) ===`);

  mainWindow = new BrowserWindow({ width: 1200, height: 900, show: false });
  mainWindow.loadURL('about:blank');

  // ── persist:baemin 파티션 ──
  // 배민이 2026-04-20 경 로그인 페이지에 reCAPTCHA v2 를 도입. 자동 로그인 스크립트로는
  // "로봇이 아닙니다" 체크박스를 통과할 수 없음. 대신 세션 쿠키(특히 "자동 로그인"
  // 체크 시 발급되는 30일 쿠키)를 영속 파티션에 저장해 로그인 페이지 진입 빈도를
  // 최소화. 앱 재시작/자동 업데이트 후에도 쿠키 유지됨.
  webView = new WebContentsView({
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      partition: 'persist:baemin',
    },
  });
  mainWindow.contentView.addChildView(webView);
  const [w, h] = mainWindow.getContentSize();
  webView.setBounds({ x: 0, y: 0, width: w, height: h });

  // ── UA 마스킹 + webdriver 플래그 제거 ──
  // 배민이 Electron UA("...Electron/40.x Safari/537.36") 문자열로 봇 감지하는 것으로 보임.
  // 쿠팡이츠/땡겨요 POC 와 동일 패턴.
  const chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  webView.webContents.session.setUserAgent(chromeUA);
  webView.webContents.setUserAgent(chromeUA);
  webView.webContents.on('dom-ready', () => {
    webView.webContents.executeJavaScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      delete window.process; delete window.require;
      delete window.__electron_webpack; delete window.__electronLog;
      delete window.Buffer; delete window.global;
      if (!window.chrome) {
        window.chrome = {
          app: { isInstalled: false },
          runtime: { id: undefined, connect: function(){}, sendMessage: function(){} },
          loadTimes: function(){ return {}; }, csi: function(){ return {}; },
        };
      }
      Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    `).catch(() => {});
  });

  webView.webContents.on('console-message', (_, level, msg) => {
    if (msg.includes('[intercept]') || msg.includes('[baemin-filter]')) log(`  ${msg}`);
  });

  try {
    // ── 1) 로그인 ──
    // 평상시 경로: persist:baemin 쿠키로 self.baemin.com 에 바로 인증됨 → 로그인 페이지
    // 진입 없이 크롤링 진행. 로그인 페이지로 리다이렉트되면 세션 만료이며, reCAPTCHA
    // 때문에 자동 로그인 불가 → 사장님 화면에 창 띄워서 수동 로그인 대기.
    emit('status', { msg: '배민 세션 확인 중...' });
    log('1) 배민 세션 확인 (persist:baemin 쿠키 기반)...');
    await navigateAndWait('https://self.baemin.com');
    await sleep(3000);

    let url = webView.webContents.getURL();
    if (isLoginUrl(url)) {
      log(`   세션 만료 감지 — 수동 로그인 대기 (180초)`);
      log(`   로그인 페이지: ${url.substring(0, 80)}`);
      emit('status', { msg: '배민 세션 만료 — 로그인 창에서 "자동 로그인" 체크 후 로그인해 주세요' });

      // ID/PW 자동 입력 + "자동 로그인" 체크박스 자동 체크 — reCAPTCHA + 로그인 버튼만 사장님 처리.
      // 30일 쿠키(cookie30d) 발급받아 다음 회부터 로그인 페이지 진입 없이 크롤링.
      // React 호환 native setter 사용 (단순 .value= 는 React state 와 desync).
      const idJson = JSON.stringify(config.id || '');
      const pwJson = JSON.stringify(config.pw || '');
      await sleep(1500); // 폼 렌더 대기
      await webView.webContents.executeJavaScript(`(function() {
        function setNativeValue(el, value) {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
                      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const result = { idFilled: false, pwFilled: false, autoLoginChecked: false };

        const idInput = document.querySelector('input[name="id"]')
                     || document.querySelector('input[type="text"]:not([disabled])');
        if (idInput) {
          setNativeValue(idInput, ${idJson});
          result.idFilled = true;
        }
        const pwInput = document.querySelector('input[type="password"]');
        if (pwInput) {
          setNativeValue(pwInput, ${pwJson});
          result.pwFilled = true;
        }

        const labels = document.querySelectorAll('label, span, div');
        for (const label of labels) {
          const text = (label.textContent || '').trim();
          if (text === '자동 로그인') {
            const parent = label.closest('label') || label.parentElement;
            const checkbox = parent?.querySelector('input[type="checkbox"]');
            if (checkbox && !checkbox.checked) { checkbox.click(); result.autoLoginChecked = true; }
            break;
          }
        }
        return result;
      })()`).then(r => log(`   자동 입력: ${JSON.stringify(r)}`)).catch(() => {});

      // 자동 입력 후 로그인 버튼 자동 click 시도.
      // reCAPTCHA 가 떠있으면 click 막혀서 페이지 변화 없음 → 그대로 mainWindow.show() 후 사장님 수동.
      // reCAPTCHA 없는 경우 (대다수) 자동 통과.
      await sleep(1500);
      await webView.webContents.executeJavaScript(`(function() {
        const byType = document.querySelector('button[type="submit"]');
        if (byType) { byType.click(); return { clicked: 'submit' }; }
        const buttons = [...document.querySelectorAll('button')];
        const loginBtn = buttons.find(b => (b.textContent || '').trim() === '로그인');
        if (loginBtn) { loginBtn.click(); return { clicked: 'text' }; }
        return { clicked: false };
      })()`).then(r => log(`   로그인 버튼 자동 click: ${JSON.stringify(r)}`)).catch(() => {});

      mainWindow.show();
      mainWindow.focus();

      await waitForLoginRedirect(180000);
      await sleep(2000);

      url = webView.webContents.getURL();
      if (isLoginUrl(url)) {
        mainWindow.hide();
        emit('error', { error: '배민 세션 만료 — 3분 내 수동 로그인 안됨. 다음 스케줄에 재시도.' });
        throw new Error('배민 세션 만료 timeout');
      }

      mainWindow.hide();
      log('   수동 로그인 성공 — 세션 쿠키 저장됨 (이후 30일 자동)');
    }
    log('   -> 로그인 완료');

    // ── 2) 홈 페이지에서 인터셉트 -> shopOwnerNumber + 매장 목록 캡처 ──
    emit('status', { msg: '매장 정보 수집 중...' });
    log('2) 홈 이동 -> shopOwnerNumber + 매장 목록 캡처...');
    webView.webContents.once('dom-ready', () => {
      webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
    });
    await navigateAndWait('https://self.baemin.com/orders/history');
    await sleep(3000);
    await webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
    await sleep(3000);

    // shopOwnerNumber 캡처 — 여러 방법 시도
    let shopOwnerNumber = null;

    // 방법 1: API 인터셉트에서 캡처
    let captureResult = await webView.webContents.executeJavaScript(`(function() {
      const c = window._baeminApiCaptures || [];
      for (const x of c) {
        const m = x.url.match(/shopOwnerNumber=(\\d+)/);
        if (m) return { shopOwnerNumber: m[1], headers: x.headers || {}, url: x.url };
      }
      return null;
    })()`);

    if (captureResult) {
      shopOwnerNumber = captureResult.shopOwnerNumber;
      log(`   -> shopOwnerNumber (인터셉트): ${shopOwnerNumber}`);
    }

    // 방법 2: 팝업 닫고 재시도
    if (!shopOwnerNumber) {
      log('   shopOwnerNumber 미캡처 -- 팝업 닫기 + 재시도...');
      await webView.webContents.executeJavaScript(`(function() {
        document.querySelectorAll('button').forEach(b => {
          if (b.innerText.includes('오늘 하루') || b.innerText.includes('닫기')) b.click();
        });
      })()`);
      await sleep(5000);
      await webView.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
      await sleep(5000);

      captureResult = await webView.webContents.executeJavaScript(`(function() {
        const c = window._baeminApiCaptures || [];
        for (const x of c) {
          const m = x.url.match(/shopOwnerNumber=(\\d+)/);
          if (m) return { shopOwnerNumber: m[1] };
        }
        return null;
      })()`);
      if (captureResult) shopOwnerNumber = captureResult.shopOwnerNumber;
    }

    // 방법 3: 셀렉트박스에서 shopNumber 추출 → shops API로 shopOwnerNumber 조회
    if (!shopOwnerNumber) {
      log('   shopOwnerNumber 미캡처 -- 셀렉트박스에서 shopNumber 추출 시도...');
      const shopNumber = await webView.webContents.executeJavaScript(`(function() {
        // 셀렉트박스 option에서 숫자 추출 (예: "[음식배달] 매장명 / 카테고리 14830273")
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          for (const opt of sel.options) {
            const m = opt.text.match(/(\\d{8,})/);
            if (m) return m[1];
            if (opt.value && opt.value.match(/^\\d{5,}$/)) return opt.value;
          }
        }
        // 폴백: 드롭다운 텍스트에서 숫자 추출
        const dropdownEl = document.querySelector('[class*="dropdown"], [class*="select"]');
        if (dropdownEl) {
          const m = dropdownEl.innerText.match(/(\\d{8,})/);
          if (m) return m[1];
        }
        return null;
      })()`);

      if (shopNumber) {
        log(`   shopNumber from DOM: ${shopNumber}`);
        // /v4/store/shops/{shopNumber} API 호출 → shopOwnerNumber 추출
        const shopInfo = await fetchViaWebview(`https://self-api.baemin.com/v4/store/shops/${shopNumber}`);
        if (shopInfo?.data) {
          shopOwnerNumber = shopInfo.data.shopOwnerNumber || shopInfo.data.shopOwnerNo;
          if (!shopOwnerNumber) {
            // 응답 객체에서 shopOwnerNumber 키 탐색
            const json = JSON.stringify(shopInfo.data);
            const ownerMatch = json.match(/"shopOwner(?:Number|No)"\s*:\s*"?(\d+)"?/);
            if (ownerMatch) shopOwnerNumber = ownerMatch[1];
          }
          log(`   -> shopOwnerNumber (API): ${shopOwnerNumber}`);
        }
      }
    }

    // 방법 4: 페이지 URL 또는 쿠키에서 추출
    if (!shopOwnerNumber) {
      const pageUrl = webView.webContents.getURL();
      const urlMatch = pageUrl.match(/shopOwnerNumber=(\d+)/);
      if (urlMatch) shopOwnerNumber = urlMatch[1];
    }

    if (!shopOwnerNumber) {
      emit('error', { error: 'shopOwnerNumber 캡처 실패 (4가지 방법 모두)' });
      throw new Error('shopOwnerNumber 캡처 실패');
    }
    log(`   -> shopOwnerNumber: ${shopOwnerNumber}`);

    // 수수료율(상생요금제)은 하루 1회만 조회·전송 — 등급은 매출규모따라 가끔 변동(자주 조회 불필요).
    // 당일(NOT_READY) 비용 추정용. 전송 성공 시 마커에 그날 날짜 기록 → 같은 날 재실행 시 skip.
    const feeMarker = path.join(os.homedir(), `.poc-baemin-feerate-${String(config.storeId || 'x').slice(0, 8)}`);
    const kstDay = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    let feeFetchedToday = false;
    try { feeFetchedToday = fs.readFileSync(feeMarker, 'utf8').trim() === kstDay; } catch {}
    if (!feeFetchedToday) {
      const feeRate = await collectFeeRate(shopOwnerNumber);
      if (feeRate && (await sendFeeRateToSalesKeeper(feeRate))?.ok) {
        try { fs.writeFileSync(feeMarker, kstDay); } catch {}
      }
    }

    // ── 3) 매장 목록 API 호출 ──
    emit('status', { msg: '매장 목록 조회 중...' });
    log('3) 매장 목록 조회...');

    const shopsApiUrl = `https://self-api.baemin.com/v4/store/shops/search?shopOwnerNo=${shopOwnerNumber}&lastOffsetId=&pageSize=50&desc=true`;
    const shopsResult = await fetchViaWebview(shopsApiUrl);

    if (shopsResult?.error) {
      log(`   매장 목록 API 에러: ${shopsResult.error}`);
      throw new Error('매장 목록 조회 실패');
    }

    const shopsData = shopsResult.data;
    let shops = [];
    if (Array.isArray(shopsData.contents)) {
      shops = shopsData.contents;
    } else if (Array.isArray(shopsData.shops)) {
      shops = shopsData.shops;
    } else if (Array.isArray(shopsData.data)) {
      shops = shopsData.data;
    } else if (Array.isArray(shopsData)) {
      shops = shopsData;
    } else {
      for (const key of Object.keys(shopsData)) {
        if (Array.isArray(shopsData[key]) && shopsData[key].length > 0) {
          shops = shopsData[key];
          break;
        }
      }
    }

    if (shops.length === 0) {
      log('   shops/search 직접 호출 실패 -> 캡처 데이터에서 추출 시도...');
      const capturedShops = await webView.webContents.executeJavaScript(`(function() {
        const c = window._baeminApiCaptures || [];
        for (const x of c) {
          if (x.url.includes('shops/search')) return x.data;
        }
        return null;
      })()`);

      if (capturedShops) {
        if (Array.isArray(capturedShops.contents)) shops = capturedShops.contents;
        else if (Array.isArray(capturedShops.shops)) shops = capturedShops.shops;
        else if (Array.isArray(capturedShops.data)) shops = capturedShops.data;
        else {
          for (const key of Object.keys(capturedShops)) {
            if (Array.isArray(capturedShops[key]) && capturedShops[key].length > 0) {
              shops = capturedShops[key];
              break;
            }
          }
        }
      }
    }

    if (shops.length === 0) {
      log('   API 실패 -> DOM 셀렉트박스에서 매장 추출 시도...');
      await navigateAndWait('https://self.baemin.com');
      await sleep(3000);

      const domShops = await webView.webContents.executeJavaScript(`(function() {
        const results = [];
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          for (const opt of sel.options) {
            const text = opt.textContent.trim();
            const value = opt.value;
            if (text && value && !text.includes('선택')) {
              results.push({ text, value });
            }
          }
        }
        if (results.length === 0) {
          const items = document.querySelectorAll('[role="option"], [role="listbox"] li, .shop-select-item');
          items.forEach(item => {
            results.push({ text: item.textContent.trim(), value: item.getAttribute('data-value') || '' });
          });
        }
        return results;
      })()`);

      if (domShops && domShops.length > 0) {
        shops = domShops.map(d => {
          const numMatch = d.text.match(/(\d{5,})/);
          const nameMatch = d.text.match(/\]\s*(.+?)\s*\//);
          return {
            shopNumber: numMatch ? numMatch[1] : d.value,
            shopName: nameMatch ? nameMatch[1].trim() : d.text,
            rawText: d.text,
          };
        });
      }
    }

    // shops 배열에서 shopNumber, shopName 정규화
    const normalizedShops = shops.map(s => {
      const shopNumber = String(s.shopNumber || s.shopNo || s.id || s.number || '');
      const shopName = s.shopName || s.name || s.title || s.rawText || '';
      return { shopNumber, shopName, raw: s };
    }).filter(s => s.shopNumber);

    log(`\n=== 총 ${normalizedShops.length}개 매장 발견 ===`);
    for (const s of normalizedShops) {
      log(`   - [${s.shopNumber}] ${s.shopName}`);
    }

    if (normalizedShops.length === 0) {
      emit('error', { error: '매장 목록을 찾을 수 없습니다' });
      throw new Error('매장 목록을 찾을 수 없습니다');
    }

    // ── 4) 매장별 순회 수집 ──
    emit('status', { msg: `매장별 수집 시작 (${startDate} ~ ${endDate})` });
    log(`\n4) 매장별 수집 시작 (${startDate} ~ ${endDate})...`);

    const shopResults = [];

    for (let si = 0; si < normalizedShops.length; si++) {
      const shop = normalizedShops[si];
      log(`\n매장 [${si + 1}/${normalizedShops.length}] ${shop.shopName} (${shop.shopNumber})`);
      emit('shop', { shopName: shop.shopName, shopId: shop.shopNumber });

      const allOrders = await collectOrdersForShop(shopOwnerNumber, shop.shopNumber, startDate, endDate);
      log(`   매장 "${shop.shopName}" 수집 완료: ${allOrders.length}건`);

      // 데이터 매핑
      const mapped = allOrders.map(mapOrder);
      const { dailySummary, byDate, sortedDates } = buildDailySummary(mapped);

      // 날짜별로 매출지킴이 API 전송
      for (const dateKey of sortedDates) {
        const dayOrders = byDate[dateKey].orders;
        await sendToSalesKeeper('baemin', dateKey, shop.shopNumber, shop.shopName, dayOrders);
      }

      // 0건 마커 sweep — 요청 기간 중 주문 없는 날짜에도 빈 페이로드로 sync log 남김
      const sweepStat = await sweepMissingDates(startDate, endDate, sortedDates, (d) =>
        sendToSalesKeeper('baemin', d, shop.shopNumber, shop.shopName, [])
      );
      if (sweepStat.sent > 0) log(`   0건 마커: ${sweepStat.sent}/${sweepStat.total}일`);

      // ★ v3.5.8: CPC 광고비 수집 + 별도 엔드포인트 전송
      // ★ v3.9.0: 주문 데이터에서 매출일 → settlement_date 맵 구성 (광고비 settlement_date 정확도)
      const settlementDateMap = new Map();
      for (const m of mapped) {
        if (m.orderStatus === 'CANCELLED') continue;
        if (!m.date || !m.depositDueDate) continue;
        const dateKey = String(m.date).slice(0, 10);
        if (!settlementDateMap.has(dateKey)) {
          settlementDateMap.set(dateKey, m.depositDueDate);
        }
      }
      log(`\n   광고비(CPC) 수집: ${startDate} ~ ${endDate} (settle 맵 ${settlementDateMap.size}일)`);
      const adCosts = await collectAdCost(shop.shopNumber, startDate, endDate, settlementDateMap);
      if (adCosts.length > 0) {
        await sendAdCostToSalesKeeper(shop.shopNumber, adCosts);
      }

      // 매장별 합계
      const totals = mapped.reduce((a, m) => {
        a.menu += m.menuAmount;
        a.comm += m.commissionFee;
        a.pg += m.pgFee;
        a.dep += m.depositDueAmount;
        return a;
      }, { menu: 0, comm: 0, pg: 0, dep: 0 });

      shopResults.push({
        shopName: shop.shopName,
        shopId: shop.shopNumber,
        orders: mapped,
        dailySummary,
        totals: {
          totalOrders: mapped.length,
          totalDays: sortedDates.length,
          menuAmount: totals.menu,
          commissionFee: totals.comm,
          pgFee: totals.pg,
          depositDueAmount: totals.dep,
        },
      });

      if (si < normalizedShops.length - 1) {
        await sleep(10000);
      }
    }

    // ── 5) 결과 emit ──
    log('\n5) 결과 출력...');

    emit('result', {
      site: 'baemin',
      shops: shopResults.map(s => ({
        shopName: s.shopName,
        shopId: s.shopId,
        orders: s.orders,
        dailySummary: s.dailySummary,
        totals: s.totals,
      })),
    });

    rawDumper.flush(config.targetDate || endDate, { mode: config.mode });

    log('\n=== 배민 워커 완료 ===');
    emit('done', {});

  } catch (err) {
    log(`\nERROR: ${err?.message || JSON.stringify(err) || err}`);
    emit('error', { error: err?.message || String(err) });
  }

  setTimeout(() => app.quit(), 5000);
});

app.on('window-all-closed', () => app.quit());
