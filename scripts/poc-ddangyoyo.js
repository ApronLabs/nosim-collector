/**
 * 땡겨요 워커: 매장별 수집
 * 실행: npx electron poc-ddangyoyo.js --id=아이디 --pw=비밀번호 --mode=backfill|daily --targetDate=YYYY-MM-DD
 *       --storeId=매장UUID --serverUrl=http://localhost:3000 --sessionToken=JWT토큰
 */

const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const { RawDumper } = require('./lib/raw-dumper');
const { sweepMissingDates } = require('./lib/date-sweep');
const POC_VERSION = app.getVersion() || 'unknown';
const rawDumper = new RawDumper('ddangyoyo');

// Electron 자동화 감지 비활성화
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

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

const LOG_FILE = path.join(__dirname, 'poc-ddangyoyo-log.txt');

// ── stdout JSON 프로토콜 ──
function emit(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  fs.appendFileSync(LOG_FILE, `[FATAL] ${err.message}\n`);
  emit('error', { error: err.message });
});

// ── mode에 따른 날짜 범위 ──
function getDateRangeByMode() {
  if (config.mode === 'daily') {
    if (!config.targetDate) throw new Error('daily 모드에서는 --targetDate=YYYY-MM-DD 필요');
    const compact = config.targetDate.replace(/-/g, '');
    return {
      startDate: config.targetDate,
      endDate: config.targetDate,
      startDateCompact: compact,
      endDateCompact: compact,
    };
  }
  // backfill — 올해 1월 1일부터 D-1까지 (v3.5.4부터 전 기간 백필)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const end = yesterday;
  const start = new Date(yesterday.getFullYear(), 0, 1);
  const fmt = (d) => d.toISOString().split('T')[0];
  const fmtCompact = (d) => fmt(d).replace(/-/g, '');
  return {
    startDate: fmt(start),
    endDate: fmt(end),
    startDateCompact: fmtCompact(start),
    endDateCompact: fmtCompact(end),
  };
}

// ── 매출지킴이 API 전송 ──
async function sendToSalesKeeper(platform, targetDate, shopId, settlement, orders, orderCount) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return null;
  const url = `${config.serverUrl}/api/stores/${config.storeId}/crawler/${platform}`;
  const body = JSON.stringify({ targetDate, platformStoreId: shopId, settlement, orders, orderCount, pocVersion: POC_VERSION });
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

// ── 인터셉트 스크립트 ──
const INTERCEPT_SCRIPT = `(function() {
  if (window._ddIntercepted) return;
  window._ddIntercepted = true;
  window._ddCaptures = [];

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const opts = args[1] || {};
    const response = await origFetch.apply(this, args);
    if (url.includes('boss.ddangyo.com') || url.includes('/o2o/')) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        try {
          const json = JSON.parse(text);
          window._ddCaptures.push({
            url, data: json, ts: Date.now(),
            method: opts.method || 'GET',
            body: opts.body || null,
            contentType: opts.headers?.['Content-Type'] || null,
          });
          console.log('[intercept] fetch: ' + url.substring(0, 120));
        } catch {}
      } catch {}
    }
    return response;
  };

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._ddUrl = url;
    this._ddMethod = method;
    this._ddHeaders = {};
    return origXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._ddHeaders) this._ddHeaders[name] = value;
    return origXHRSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this._ddBody = args[0] || null;
    this.addEventListener('load', function() {
      const url = this._ddUrl || '';
      if (url.includes('boss.ddangyo.com') || url.includes('/o2o/')) {
        try {
          const json = JSON.parse(this.responseText);
          window._ddCaptures.push({
            url, data: json, ts: Date.now(),
            method: this._ddMethod || 'GET',
            body: this._ddBody,
            headers: this._ddHeaders || {},
            contentType: (this._ddHeaders || {})['Content-Type'] || null,
          });
          console.log('[intercept] XHR (' + (this._ddMethod || '?') + '): ' + url.substring(0, 120));
        } catch {}
      }
    });
    return origXHRSend.apply(this, args);
  };

  console.log('[intercept] 땡겨요 API 인터셉트 설치 완료');
  true;
})();`;

// ── DB SalesOrder 매핑 ──
function parseAmount(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  return parseInt(String(str).replace(/[^0-9\-]/g, ''), 10) || 0;
}

function parseDateTime(setlDt, setlTm) {
  if (!setlDt) return '';
  const y = setlDt.substring(0, 4);
  const m = setlDt.substring(4, 6);
  const d = setlDt.substring(6, 8);
  if (!setlTm) return `${y}-${m}-${d}`;
  const hh = setlTm.substring(0, 2);
  const mm = setlTm.substring(2, 4);
  const ss = setlTm.substring(4, 6);
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function mapToSalesOrder(order, storeName) {
  rawDumper.add(order);
  const menuNm = (order.menu_nm || '').trim();
  const saleAmt = parseAmount(order.sale_amt);
  const settlAmt = parseAmount(order.tot_setl_amt);
  const orderedAt = parseDateTime(order.setl_dt, order.setl_tm);

  // v3.9.7+: attachSettlementToOrders 로 _settlement 가 세팅됐으면 해당 값 사용
  const s = order._settlement || {};

  return {
    orderId: order.ord_id || '',
    orderIdInternal: order.ord_no || '',
    orderedAt,
    orderType: order.ord_tp_nm || '',
    menuSummary: menuNm,
    menuAmount: saleAmt,
    settlementAmount: settlAmt,
    totalFee: saleAmt - settlAmt,
    channel: order.ord_tp_nm || 'DELIVERY',
    orderStatus: order.ord_prog_stat_cd === '40' ? 'COMPLETED' : order.ord_prog_stat_cd || '',
    isRegularCustomer: order.regl_cust_yn === 'Y',
    storeName: storeName,
    items: [],
    // v3.9.7+: 정산상세 API 기반 수수료 비례분배 (paym_plan_dt 그룹 × sale_amt 비율)
    commissionFee: s.commissionFee ?? 0,
    pgFee: s.pgFee ?? 0,
    deliveryFee: s.deliveryFee ?? 0,
    storeDiscount: s.storeDiscount ?? 0,
    platformSubsidy: s.platformSubsidy ?? 0,
    paymPlanDt: order._paymPlanDt ?? null,
    rawOrder: order,
  };
}

// ── 정산상세 수집 (v3.9.7+) ──
// 1) requestImdtlPaymAmt 로 입금 완료된 paym_plan_dt 리스트
// 2) 각각 requestQryCalculateDetail 로 dlt_ajst (수수료 합) + dlt_amtList (주문별 입금액)
async function collectSettlementDetails(view, patstoNo, startDateCompact, endDateCompact) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json, text/plain, */*',
  };
  const bizRegNo = '2172801090'; // TODO: 매장별로 다를 수 있으나 현재 1 매장만 지원

  // Step 1: 입금일 리스트
  const listBody = JSON.stringify({
    dma_para: [{
      patsto_no: patstoNo,
      biz_reg_no: bizRegNo,
      sotid: '0000',
      inq_st_dt: startDateCompact,
      inq_ed_dt: endDateCompact,
      page_num: 1,
      page_row_cnt: 100,
      rowStatus: 'R',
    }],
  });

  const listRes = await view.webContents.executeJavaScript(`(async function() {
    try {
      const r = await fetch('https://boss.ddangyo.com/o2o/shop/pu/requestImdtlPaymAmt', {
        method: 'POST', headers: ${JSON.stringify(headers)},
        credentials: 'include', body: ${JSON.stringify(listBody)},
      });
      return { ok: r.ok, status: r.status, data: await r.json() };
    } catch (e) { return { ok: false, error: e.message }; }
  })()`);

  if (!listRes.ok) {
    log(`   정산 리스트 조회 실패: ${listRes.error || listRes.status}`);
    return [];
  }
  const paymPlans = (listRes.data?.dlt_data_result_list || [])
    .filter(p => p.wtran_rslt_cd === '0000'); // 입금완료
  log(`   입금완료 paym_plan_dt: ${paymPlans.length}건`);

  // Step 2: 각 paym_plan_dt 상세
  const details = [];
  for (const plan of paymPlans) {
    const detailBody = JSON.stringify({
      dlt_param_req: [{
        paym_plan_dt: plan.paym_plan_dt,
        ajst_div_cd: plan.ajst_div_cd || '001',
        paym_plan_no: plan.paym_plan_no || '',
        tab_gubun: '',
        patsto_no: patstoNo,
        paym_div_cd: '',
        wtran_rslt_cd: '0000',
        rowStatus: 'R',
      }],
    });
    const detailRes = await view.webContents.executeJavaScript(`(async function() {
      try {
        const r = await fetch('https://boss.ddangyo.com/o2o/shop/pu/requestQryCalculateDetail', {
          method: 'POST', headers: ${JSON.stringify(headers)},
          credentials: 'include', body: ${JSON.stringify(detailBody)},
        });
        return { ok: r.ok, status: r.status, data: await r.json() };
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);

    if (!detailRes.ok) continue;
    const ajst = detailRes.data?.dlt_ajst || null;
    const rows = detailRes.data?.dlt_amtList || [];
    if (ajst) {
      details.push({
        paymPlanDt: plan.paym_plan_dt,
        ajst,
        rows,
      });
    }
    await sleep(400); // rate-limit
  }
  log(`   정산상세 수집: ${details.length}건`);
  return details;
}

// 주문에 비례분배 적용: 매칭된 paym_plan_dt 그룹별 sale_amt 비율
function attachSettlementToOrders(orders, settlementDetails) {
  // Step 1: 매칭 — dlt_amtList row 는 단건 주문이 아닌 "해당 paym_plan_dt 의 setl_dt 별 집계".
  // setl_dt 단위로 paym_plan_dt 귀속.
  //
  // 한 setl_dt 에 여러 row (일반/조정 등) 일 수 있으므로 paym_amt 합 검증:
  //   설 정산 row 들의 paym_amt 합 == 주문들 tot_setl_amt 합 이면 매칭.
  //   일치 안 해도 setl_dt 기반 1차 매칭은 시도 (부분 정산 허용).
  for (const detail of settlementDetails) {
    const setlDtSet = new Set(detail.rows.map(r => r.setl_dt).filter(Boolean));
    for (const o of orders) {
      if (o._paymPlanDt) continue;
      if (setlDtSet.has(o.setl_dt)) o._paymPlanDt = detail.paymPlanDt;
    }
  }

  // Step 2: paym_plan_dt 별 그룹화
  const groups = {};
  for (const o of orders) {
    if (!o._paymPlanDt) continue;
    const key = o._paymPlanDt;
    if (!groups[key]) {
      const detail = settlementDetails.find(d => d.paymPlanDt === key);
      groups[key] = { ajst: detail?.ajst || null, orders: [] };
    }
    groups[key].orders.push(o);
  }

  // Step 3: 비례분배 (sale_amt 비율, 마지막 주문에 잔차)
  for (const [paymPlanDt, grp] of Object.entries(groups)) {
    if (!grp.ajst || !grp.orders.length) continue;
    const totalSale = grp.orders.reduce((a, o) => a + parseAmount(o.sale_amt), 0);
    if (totalSale === 0) continue;

    const ajst = grp.ajst;
    const totals = {
      commission: Math.abs(ajst.ord_medi_amt || 0),
      pg: Math.abs(ajst.setl_ajst_amt || 0),
      delivery: Math.abs(ajst.delv_agnt_amt || 0),
      storeDiscount: Math.abs(ajst.patsto_coup_amt || 0),
      platformSubsidy: Math.abs(ajst.plfm_coup_amt || 0),
    };
    const alloc = { commission: 0, pg: 0, delivery: 0, storeDiscount: 0, platformSubsidy: 0 };

    for (let i = 0; i < grp.orders.length; i++) {
      const o = grp.orders[i];
      const isLast = i === grp.orders.length - 1;
      const ratio = parseAmount(o.sale_amt) / totalSale;
      const dist = (key) => isLast ? totals[key] - alloc[key] : Math.round(totals[key] * ratio);

      const commission = dist('commission');
      const pg = dist('pg');
      const delivery = dist('delivery');
      const storeDiscount = dist('storeDiscount');
      const platformSubsidy = dist('platformSubsidy');

      o._settlement = { commissionFee: commission, pgFee: pg, deliveryFee: delivery, storeDiscount, platformSubsidy };
      alloc.commission += commission; alloc.pg += pg; alloc.delivery += delivery;
      alloc.storeDiscount += storeDiscount; alloc.platformSubsidy += platformSubsidy;
    }
  }

  // Step 4: 통계
  const matched = orders.filter(o => o._paymPlanDt).length;
  log(`   주문 비례분배: ${matched}/${orders.length}건 매칭 (매칭 안 된 주문은 수수료 0 유지)`);
}

// ── 메인 ──
app.whenReady().then(async () => {
  fs.writeFileSync(LOG_FILE, '');

  if (!config.id || !config.pw) {
    emit('error', { error: '--id=ID --pw=PW 필요' });
    app.quit(); return;
  }

  const dates = getDateRangeByMode();
  emit('status', { msg: `땡겨요 수집 시작 (${config.mode}: ${dates.startDate} ~ ${dates.endDate})` });
  log(`=== 땡겨요 워커: ${config.mode} (${dates.startDate} ~ ${dates.endDate}) ===`);

  const win = new BrowserWindow({ width: 1400, height: 900, show: false });
  const view = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  view.webContents.setUserAgent(chromeUA);

  view.webContents.on('dom-ready', () => {
    view.webContents.executeJavaScript(`
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

  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1400, height: 900 });

  const navigateAndWait = (url) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); resolve(); };
    const t = setTimeout(finish, 30000);
    view.webContents.once('did-finish-load', finish);
    view.webContents.loadURL(url).catch(() => {});
  });

  try {
    // ══════════════════════════════════════════
    // Step 1: 로그인
    // ══════════════════════════════════════════
    emit('status', { msg: '땡겨요 로그인 중...' });
    log('Step 1: 로그인 페이지 로드');
    await navigateAndWait('https://boss.ddangyo.com');
    await sleep(5000);

    await view.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});

    const hasForm = await view.webContents.executeJavaScript(`(function() {
      return {
        hasId: !!document.getElementById('mf_ibx_mbrId'),
        hasPw: !!document.getElementById('mf_sct_pwd'),
        hasBtn: !!document.getElementById('mf_btn_webLogin'),
      };
    })()`);
    log(`로그인 폼: ID=${hasForm.hasId}, PW=${hasForm.hasPw}, Btn=${hasForm.hasBtn}`);

    if (!hasForm.hasId || !hasForm.hasPw) {
      log('로그인 폼 못 찾음 -- 이미 로그인 됨?');
    } else {
      const idEscaped = JSON.stringify(config.id);
      const pwEscaped = JSON.stringify(config.pw);
      await view.webContents.executeJavaScript(`(async function() {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const idInput = document.getElementById('mf_ibx_mbrId');
        const pwInput = document.getElementById('mf_sct_pwd');
        if (!idInput || !pwInput) return { success: false, error: 'form not found' };

        function typeInto(el, val) {
          el.focus();
          el.value = '';
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, val);
          if (el.value !== val) {
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        typeInto(idInput, ${idEscaped});
        await sleep(300);
        typeInto(pwInput, ${pwEscaped});
        await sleep(500);

        const loginBtn = document.getElementById('mf_btn_webLogin');
        if (loginBtn) loginBtn.click();
        return { success: true };
      })()`);

      log('로그인 버튼 클릭 완료, 대기 중...');
      await sleep(10000);
    }

    const stillLogin = await view.webContents.executeJavaScript(`(function() {
      const idField = document.getElementById('mf_ibx_mbrId');
      return idField && idField.offsetHeight > 0;
    })()`);

    if (stillLogin) {
      emit('error', { error: '로그인 실패! ID/PW 확인 필요' });
      app.quit(); return;
    }
    log('로그인 성공!');

    // ══════════════════════════════════════════
    // Step 2: 주문내역 페이지 이동 + API 패턴 캡처
    // ══════════════════════════════════════════
    emit('status', { msg: '주문내역 페이지 이동 중...' });
    log('Step 2: 주문내역 페이지 이동');
    await view.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});

    await view.webContents.executeJavaScript(`(function() {
      const links = Array.from(document.querySelectorAll('a'));
      const orderLink = links.find(a => a.innerText.trim() === '주문내역');
      if (orderLink) { orderLink.click(); return 'menu-click'; }
      location.hash = '#SH0402';
      return 'hash-nav';
    })()`);

    await sleep(8000);
    await view.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
    await sleep(3000);

    // ══════════════════════════════════════════
    // Step 3: API 패턴 캡처
    // ══════════════════════════════════════════
    log('Step 3: API 패턴 캡처');

    let apiInfo = await view.webContents.executeJavaScript(`(function() {
      const c = window._ddCaptures || [];
      for (let i = c.length - 1; i >= 0; i--) {
        if (c[i].url.includes('requestQryOrderList') || (c[i].data && c[i].data.dlt_result)) {
          return {
            url: c[i].url,
            method: c[i].method || 'GET',
            body: c[i].body || null,
            headers: c[i].headers || {},
            contentType: c[i].contentType || null,
            resultCount: (c[i].data?.dlt_result || []).length,
            totalCount: c[i].data?.dlt_result_single?.tot_cnt || 0,
          };
        }
      }
      return null;
    })()`);

    if (!apiInfo) {
      log('  초기 캡처 없음 -> 조회 버튼 클릭');
      await view.webContents.executeJavaScript(`(function() {
        window._ddIntercepted = false;
        window._ddCaptures = [];
      })()`);
      await view.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});
      await view.webContents.executeJavaScript(`(function() {
        const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
        const searchBtn = btns.find(b => (b.innerText || b.value || '').trim() === '조회');
        if (searchBtn) searchBtn.click();
      })()`);
      await sleep(5000);

      apiInfo = await view.webContents.executeJavaScript(`(function() {
        const c = window._ddCaptures || [];
        for (let i = c.length - 1; i >= 0; i--) {
          if (c[i].url.includes('requestQryOrderList') || (c[i].data && c[i].data.dlt_result)) {
            return {
              url: c[i].url,
              method: c[i].method || 'GET',
              body: c[i].body || null,
              headers: c[i].headers || {},
              contentType: c[i].contentType || null,
              resultCount: (c[i].data?.dlt_result || []).length,
              totalCount: c[i].data?.dlt_result_single?.tot_cnt || 0,
            };
          }
        }
        return null;
      })()`);
    }

    if (!apiInfo) {
      emit('error', { error: 'API 캡처 실패' });
      app.quit(); return;
    }

    log(`  API URL: ${apiInfo.url}`);

    let baseBody;
    try { baseBody = JSON.parse(apiInfo.body); } catch(e) { baseBody = null; }

    if (!baseBody || !baseBody.dma_para) {
      emit('error', { error: 'dma_para 구조 파싱 실패' });
      app.quit(); return;
    }

    const apiHeaders = Object.keys(apiInfo.headers).length > 0
      ? apiInfo.headers
      : { 'Content-Type': 'application/json; charset=UTF-8' };

    // ══════════════════════════════════════════
    // Step 4: 매장 목록 추출
    // ══════════════════════════════════════════
    emit('status', { msg: '매장 목록 추출 중...' });
    log('Step 4: 매장 목록 추출');

    // 드롭다운 클릭
    await view.webContents.executeJavaScript(`(function() {
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .join('');
        if (directText.includes('가게전체') || directText.includes('가게 전체')) {
          const clickTarget = el.closest('button, a, [role="combobox"], [role="listbox"], select, .selectbox') || el;
          clickTarget.click();
          return { clicked: true };
        }
      }
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const inp of inputs) {
        if ((inp.value || '').includes('가게전체') || (inp.value || '').includes('가게 전체')) {
          const parent = inp.closest('[class*="select"], [class*="combo"]') || inp.parentElement;
          if (parent) parent.click();
          return { clicked: true };
        }
      }
      return { clicked: false };
    })()`);
    await sleep(2000);

    let storeList = await view.webContents.executeJavaScript(`(function() {
      const stores = [];
      let idx = 0;
      while (true) {
        const el = document.getElementById('mf_wfm_contents_gen_patstoSelector_' + idx + '_tbx_patstoItem');
        if (!el) break;
        const name = el.textContent.trim();
        if (name && !name.includes('가게전체') && !name.includes('가게 전체')) {
          stores.push({ name, selectorIndex: idx });
        }
        idx++;
      }
      if (stores.length > 0) return { source: 'ws-patstoSelector', stores };

      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const opts = Array.from(sel.options);
        const hasAll = opts.some(o => o.textContent.trim().includes('가게전체'));
        if (hasAll) {
          for (const o of opts) {
            const name = o.textContent.trim();
            if (!name.includes('가게전체') && !name.includes('가게 전체') && name) {
              stores.push({ name, value: o.value });
            }
          }
          return { source: 'select', stores };
        }
      }

      return { source: 'not-found', stores: [] };
    })()`);

    // 팝업 닫기
    await view.webContents.executeJavaScript(`(function() {
      const closeBtn = Array.from(document.querySelectorAll('button, a, span')).find(el => {
        const t = el.textContent.trim();
        return t === 'X' || t === '닫기' || el.className?.includes('close');
      });
      if (closeBtn) closeBtn.click();
      document.body.click();
    })()`);
    await sleep(1000);

    // 매장 목록이 비어있으면 API로 탐색
    if (storeList.stores.length === 0) {
      log('  UI에서 매장 목록 추출 실패, API body 기반 매장 탐색...');
      const rpsntNo = baseBody.dma_para.rpsnt_patsto_no;

      const testBody = JSON.parse(JSON.stringify(baseBody));
      testBody.dma_para.setl_dt_st = dates.startDateCompact;
      testBody.dma_para.setl_dt_ed = dates.endDateCompact;
      testBody.dma_para.page_row_cnt = 500;
      testBody.dma_para.page_num = 1;
      testBody.dma_para.patsto_no = '0000000';
      testBody.dma_para.patsto_nm = '가게전체';

      const testResult = await view.webContents.executeJavaScript(`(async function() {
        try {
          const resp = await fetch(${JSON.stringify(apiInfo.url)}, {
            method: 'POST',
            headers: ${JSON.stringify(apiHeaders)},
            credentials: 'include',
            body: ${JSON.stringify(JSON.stringify(testBody))},
          });
          const data = await resp.json();
          const orders = data.dlt_result || [];
          const storeMap = {};
          for (const o of orders) {
            const no = o.patsto_no || '';
            const nm = o.patsto_nm || o.store_nm || '';
            if (no && no !== '0000000') storeMap[no] = nm || no;
          }
          return { success: true, totalOrders: orders.length, storeMap };
        } catch(e) { return { success: false, error: e.message }; }
      })()`);

      if (testResult.success && Object.keys(testResult.storeMap).length > 0) {
        storeList = {
          source: 'api-orders',
          stores: Object.entries(testResult.storeMap).map(([no, nm]) => ({ name: nm, value: no })),
        };
      } else {
        storeList = {
          source: 'fallback-rpsnt',
          stores: [{ name: '매장', value: rpsntNo }],
        };
      }
    }

    log(`\n총 ${storeList.stores.length}개 매장 발견:`);
    for (const s of storeList.stores) {
      log(`  - ${s.name} (${s.value || 'no-id'})`);
      emit('shop', { shopName: s.name, shopId: s.value || '' });
    }

    // ══════════════════════════════════════════
    // Step 5: 매장별 주문 데이터 수집
    // ══════════════════════════════════════════
    emit('status', { msg: '매장별 주문 수집 시작' });
    log('\nStep 5: 매장별 주문 수집 시작');

    const allStoreResults = {};

    for (let si = 0; si < storeList.stores.length; si++) {
      const store = storeList.stores[si];
      log(`\n-- [${si + 1}/${storeList.stores.length}] ${store.name} --`);

      let storePatNo = store.value || null;

      if (store.selectorIndex !== undefined && !storePatNo) {
        await view.webContents.executeJavaScript(`
          window._ddIntercepted = false;
          window._ddCaptures = [];
        `);
        await view.webContents.executeJavaScript(INTERCEPT_SCRIPT).catch(() => {});

        await view.webContents.executeJavaScript(`(function() {
          const trigger = document.getElementById('mf_wfm_contents_tbx_selectedPatstoItem')
            || document.getElementById('mf_wfm_contents_wq_uuid_499');
          if (trigger) {
            const parent = trigger.closest('a, button, div[class*="pop_call"]') || trigger;
            parent.click();
          }
        })()`);
        await sleep(1000);

        await view.webContents.executeJavaScript(`(function() {
          const clickLine = document.getElementById('mf_wfm_contents_gen_patstoSelector_${store.selectorIndex}_grp_clickLine');
          if (clickLine) { clickLine.click(); return { clicked: true }; }
          const tbx = document.getElementById('mf_wfm_contents_gen_patstoSelector_${store.selectorIndex}_tbx_patstoItem');
          if (tbx) { const parent = tbx.closest('a, li, div') || tbx; parent.click(); return { clicked: true }; }
          return { clicked: false };
        })()`);
        await sleep(3000);

        const capturedStoreApi = await view.webContents.executeJavaScript(`(function() {
          const c = window._ddCaptures || [];
          for (let i = c.length - 1; i >= 0; i--) {
            if (c[i].url.includes('requestQryOrderList') && c[i].body) {
              try {
                const b = JSON.parse(c[i].body);
                if (b.dma_para && b.dma_para.patsto_no !== '0000000') {
                  return { patsto_no: b.dma_para.patsto_no, patsto_nm: b.dma_para.patsto_nm };
                }
              } catch(e) {}
            }
          }
          return null;
        })()`);

        if (capturedStoreApi) {
          storePatNo = capturedStoreApi.patsto_no;
        } else {
          storePatNo = baseBody.dma_para.rpsnt_patsto_no;
        }
      }

      // API body 수정
      const reqBody = JSON.parse(JSON.stringify(baseBody));
      reqBody.dma_para.setl_dt_st = dates.startDateCompact;
      reqBody.dma_para.setl_dt_ed = dates.endDateCompact;
      reqBody.dma_para.page_row_cnt = 500;
      reqBody.dma_para.page_num = 1;

      if (storePatNo) {
        reqBody.dma_para.patsto_no = storePatNo;
      }
      reqBody.dma_para.patsto_nm = store.name;
      store.value = storePatNo || store.value || '';

      log(`  요청: patsto_no=${reqBody.dma_para.patsto_no}, ${dates.startDateCompact}~${dates.endDateCompact}`);

      const reqBodyStr = JSON.stringify(reqBody);
      const result = await view.webContents.executeJavaScript(`(async function() {
        try {
          const resp = await fetch(${JSON.stringify(apiInfo.url)}, {
            method: 'POST',
            headers: ${JSON.stringify(apiHeaders)},
            credentials: 'include',
            body: ${JSON.stringify(reqBodyStr)},
          });
          const data = await resp.json();
          return {
            success: true,
            orders: data.dlt_result || [],
            summary: data.dlt_result_single || {},
          };
        } catch(e) {
          return { success: false, error: e.message };
        }
      })()`);

      if (!result.success) {
        log(`  API 호출 실패: ${result.error}`);
        continue;
      }

      let allOrders = result.orders;
      const totalExpected = result.summary.tot_cnt || allOrders.length;
      log(`  응답: ${allOrders.length}건 / 총 ${totalExpected}건`);

      emit('progress', { current: allOrders.length, total: totalExpected, date: dates.startDate });

      // 페이지네이션
      let pageNum = 2;
      while (allOrders.length < totalExpected && pageNum <= 20) {
        reqBody.dma_para.page_num = pageNum;
        const pageBodyStr = JSON.stringify(reqBody);

        const pageResult = await view.webContents.executeJavaScript(`(async function() {
          try {
            const resp = await fetch(${JSON.stringify(apiInfo.url)}, {
              method: 'POST',
              headers: ${JSON.stringify(apiHeaders)},
              credentials: 'include',
              body: ${JSON.stringify(pageBodyStr)},
            });
            const data = await resp.json();
            return { success: true, orders: data.dlt_result || [] };
          } catch(e) {
            return { success: false, error: e.message };
          }
        })()`);

        if (!pageResult.success || pageResult.orders.length === 0) break;

        const existingIds = new Set(allOrders.map(o => o.ord_id || o.ord_no));
        const uniqueNew = pageResult.orders.filter(o => !existingIds.has(o.ord_id || o.ord_no));
        if (uniqueNew.length === 0) break;

        allOrders = allOrders.concat(uniqueNew);
        pageNum++;
        await sleep(1000);
      }

      // 탐사용: 첫 주문의 raw 필드 키 로그 (수수료 필드 spec 파악)
      if (allOrders.length > 0) {
        const sample = allOrders[0];
        const keys = Object.keys(sample).sort();
        log(`   [탐사] raw order 필드 ${keys.length}개: ${keys.join(', ')}`);
        // 수수료 관련 잠재 필드 값 찍기
        const candidates = ['ord_medi_amt', 'setl_ajst_amt', 'delv_agnt_amt', 'delvfee_amt', 'patstos_coup_amt', 'medi_amt', 'ajst_amt', 'coup_amt', 'medi_use_fee', 'setl_fee'];
        const found = candidates.filter(k => k in sample).map(k => `${k}=${sample[k]}`);
        if (found.length) log(`   [탐사] 수수료 후보 필드: ${found.join(' / ')}`);
      }

      // v3.9.7+: 정산상세 API 호출 → 주문별 수수료 비례분배
      log(`  정산상세 수집 시작 (${dates.startDateCompact} ~ ${dates.endDateCompact})`);
      try {
        const settlementDetails = await collectSettlementDetails(
          view, store.value, dates.startDateCompact, dates.endDateCompact,
        );
        if (settlementDetails.length > 0) {
          attachSettlementToOrders(allOrders, settlementDetails);
        } else {
          log(`   정산상세 없음 (D+3~7 지연, 또는 입금완료 row 0)`);
        }
      } catch (e) {
        log(`   정산상세 수집 실패: ${e.message}`);
      }

      // 날짜별 그룹핑
      const byDate = {};
      for (const order of allOrders) {
        const dt = order.setl_dt || 'unknown';
        if (!byDate[dt]) byDate[dt] = [];
        byDate[dt].push(order);
      }

      const dailySummaries = {};
      const sortedDates = Object.keys(byDate).sort();
      const sentDates = []; // YYYY-MM-DD — 0건 sweep 비교용

      for (const dt of sortedDates) {
        const orders = byDate[dt];
        const mapped = orders.map(o => mapToSalesOrder(o, store.name));
        let daySale = 0, daySettl = 0;
        for (const o of mapped) {
          daySale += o.menuAmount;
          daySettl += o.settlementAmount;
        }
        const dateFormatted = dt.length === 8
          ? `${dt.substring(0,4)}-${dt.substring(4,6)}-${dt.substring(6,8)}`
          : dt;
        dailySummaries[dateFormatted] = {
          date: dateFormatted,
          dateCompact: dt,
          orderCount: orders.length,
          totalSaleAmount: daySale,
          totalSettlementAmount: daySettl,
          totalFee: daySale - daySettl,
          orders: mapped,
        };

        // 날짜별 매출지킴이 API 전송 (땡겨요 형식: settlement + orders + orderCount)
        await sendToSalesKeeper('ddangyoyo', dateFormatted, store.value, {
          ordAmt: daySale,
          paynAmt: daySettl,
        }, mapped, orders.length);
        sentDates.push(dateFormatted);
      }

      // 0건 마커 sweep — 요청 기간 중 주문 없는 날짜에도 빈 페이로드로 sync log 남김
      const sweepStat = await sweepMissingDates(dates.startDate, dates.endDate, sentDates, (md) =>
        sendToSalesKeeper('ddangyoyo', md, store.value, { ordAmt: 0, paynAmt: 0 }, [], 0)
      );
      if (sweepStat.sent > 0) log(`   0건 마커: ${sweepStat.sent}/${sweepStat.total}일`);

      // 매장 합계
      let storeSale = 0, storeSettl = 0;
      for (const ds of Object.values(dailySummaries)) {
        storeSale += ds.totalSaleAmount;
        storeSettl += ds.totalSettlementAmount;
      }

      allStoreResults[store.name] = {
        storeName: store.name,
        storeId: store.value || '',
        dateRange: { start: dates.startDate, end: dates.endDate },
        totalDays: sortedDates.length,
        totalOrders: allOrders.length,
        totalSaleAmount: storeSale,
        totalSettlementAmount: storeSettl,
        totalFee: storeSale - storeSettl,
        dailySummaries,
      };

      log(`  매장 합계: ${sortedDates.length}일 / ${allOrders.length}건 / 매출:${storeSale.toLocaleString()} / 정산:${storeSettl.toLocaleString()}`);

      if (si < storeList.stores.length - 1) await sleep(2000);
    }

    // ══════════════════════════════════════════
    // Step 6: 결과 emit
    // ══════════════════════════════════════════
    log('\nStep 6: 결과 출력');

    let grandSale = 0, grandSettl = 0, grandOrders = 0;
    for (const sr of Object.values(allStoreResults)) {
      grandSale += sr.totalSaleAmount;
      grandSettl += sr.totalSettlementAmount;
      grandOrders += sr.totalOrders;
    }

    emit('result', {
      site: 'ddangyoyo',
      shops: Object.values(allStoreResults).map(sr => {
        // dailySummaries 내의 orders를 하나의 배열로 합침
        const allOrders = Object.values(sr.dailySummaries || {}).flatMap(ds => ds.orders || []);
        return {
          shopName: sr.storeName,
          shopId: sr.storeId,
          orders: allOrders,
          totalOrders: sr.totalOrders,
          totalSaleAmount: sr.totalSaleAmount,
          totalSettlementAmount: sr.totalSettlementAmount,
          dailySummaries: sr.dailySummaries,
        };
      }),
    });

    rawDumper.flush(config.targetDate || new Date().toISOString().slice(0, 10), { mode: config.mode });

    log(`전체 합계: ${Object.keys(allStoreResults).length}매장 / ${grandOrders}건 / 매출:${grandSale.toLocaleString()} / 정산:${grandSettl.toLocaleString()}`);
    log('=== 땡겨요 워커 완료 ===');
    emit('done', {});

  } catch (err) {
    log(`에러: ${err.message}`);
    emit('error', { error: err?.message || String(err) });
  }

  setTimeout(() => app.quit(), 2000);
});

app.on('window-all-closed', () => { /* keep alive */ });
