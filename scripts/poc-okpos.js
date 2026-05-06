/**
 * OKPOS POS 매출 수집 워커
 * 실행: npx electron poc-okpos.js --id=아이디 --pw=비밀번호 --mode=backfill|daily --targetDate=YYYY-MM-DD
 *       --storeId=매장UUID --serverUrl=http://localhost:3000 --sessionToken=JWT토큰
 *
 * 수집 항목:
 *   - daily 모드: 지정 날짜 매출 (일자별 API)
 *   - backfill 모드: 전전달 1일 ~ D-1 (일자별 API 날짜 범위 조회)
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { sweepMissingDates } = require('./lib/date-sweep');
const POC_VERSION = app.getVersion() || 'unknown';

// 노심 OkposSales 인터페이스에 맞춘 0매출 페이로드 (영업 안 한/POS 데이터 없는 날 마커용)
const ZERO_OKPOS_SALES = Object.freeze({
  totalSaleAmount: 0,
  netSaleAmount: 0,
  receiptCount: 0,
  customerCount: 0,
  vatAmount: 0,
  cardAmount: 0,
  cashAmount: 0,
  cashReceiptAmount: 0,
  totalDiscount: 0,
});

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

const SHOW = process.argv.includes('--show');
const LOGIN_URL = 'https://nice.okpos.co.kr/';
const LOG_FILE = path.join(__dirname, 'poc-okpos-log.txt');

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
function formatDateCompact(dateStr) {
  // YYYY-MM-DD → YYYYMMDD
  return dateStr.replace(/-/g, '');
}
function formatDateFromCompact(compactDate) {
  // YYYYMMDD → YYYY-MM-DD
  if (!compactDate || compactDate.length !== 8) return compactDate;
  return `${compactDate.substring(0, 4)}-${compactDate.substring(4, 6)}-${compactDate.substring(6, 8)}`;
}

// ── 날짜 범위 계산 ──
function getYesterday() {
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return formatDate(yesterday);
}
function getTwoMonthsAgo() {
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const twoMonthsAgo = new Date(yesterday.getFullYear(), yesterday.getMonth() - 2, 1);
  return formatDate(twoMonthsAgo);
}

// ── mode에 따른 날짜 범위 결정 ──
function getDateRangeByMode() {
  if (config.mode === 'daily') {
    if (!config.targetDate) throw new Error('daily 모드에서는 --targetDate=YYYY-MM-DD 필요');
    return { startDate: config.targetDate, endDate: config.targetDate };
  }
  // backfill: 전전달 1일 ~ D-1
  return { startDate: getTwoMonthsAgo(), endDate: getYesterday() };
}

// ── 매출지킴이 API 전송 ──
async function sendToSalesKeeper(targetDate, platformStoreId, salesData, rawData) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return null;
  const url = `${config.serverUrl}/api/stores/${config.storeId}/crawler/okpos`;

  const body = JSON.stringify({
    targetDate,
    platformStoreId,
    sales: salesData,
    rawData,
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
    const status = res.status;
    log(`   API 전송 ${targetDate}: ${status}`);
    return { status, ok: res.ok };
  } catch (err) {
    log(`   API 전송 실패 ${targetDate}: ${err.message}`);
    emit('error', { error: `API 전송 실패 (${targetDate}): ${err.message}` });
    return null;
  }
}

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'AutomationControllerForTesting,EnableAutomation');
app.commandLine.appendSwitch('lang', 'ko-KR');

// ── 프레임 헬퍼 ──
function findFrameByUrl(win, pattern) {
  for (const f of win.webContents.mainFrame.framesInSubtree) {
    if (f.url.includes(pattern)) return f;
  }
  return null;
}
function findFrameByName(win, name) {
  for (const f of win.webContents.mainFrame.framesInSubtree) {
    if (f.name === name) return f;
  }
  return null;
}
async function exec(frame, script, label) {
  try { return await frame.executeJavaScript(script); }
  catch (err) { log(`[${label}] 실패: ${err.message}`); return null; }
}

// ── XHR 인터셉트 ──
const INTERCEPT_SCRIPT = `(function() {
  if (window._intercepted) return;
  window._intercepted = true;
  window._captures = [];
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(m, u, ...r) { this._url = u; this._method = m; return origOpen.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.setRequestHeader = function(n, v) { return origSetH.call(this, n, v); };
  XMLHttpRequest.prototype.send = function(body) {
    let bs = null;
    if (body) {
      if (typeof body === 'string') bs = body;
      else if (body instanceof URLSearchParams) bs = body.toString();
      else if (body instanceof FormData) { try { const e = []; for (const [k,v] of body.entries()) e.push(k+'='+v); bs = e.join('&'); } catch {} }
    }
    const url = this._url;
    this.addEventListener('load', function() {
      window._captures.push({ url, body: bs?.substring(0, 5000), status: this.status, response: this.responseText, ts: Date.now() });
    });
    return origSend.call(this, body);
  };
})()`;

// ── 필드 맵핑 ──
const FIELD_MAP = {
  SALE_DATE: '일자', SALE_YOIL: '요일', SALE_MONTH: '년월',
  SHOP_CD: '매장코드', SHOP_NM: '매장명', WORK_DAY_CNT: '영업일수',
  TOT_SALE_AMT: '총매출', TOT_DC_AMT: '총할인', DCM_SALE_AMT: '실매출',
  NO_TAX_SALE_AMT: '가액', VAT_AMT: '부가세',
  TOT_SALE_CNT: '영수건수', DCM_TOT_RATE: '영수단가',
  FD_GST_CNT_T: '고객수', SALE_PER_GST: '객단가',
  FD_GST_CNT_1: '남', FD_GST_CNT_2: '여',
  TABLE_CNT: '테이블수', SALE_PER_TABLE: '테이블단가', GST_PER_TABLE: '회전율',
  SVC_TIP_AMT: '봉사료', TOT_ETC_AMT: '에누리',
  TOT_PAY_AMT: '결제합계', CASH_AMT2: '단순현금', CASH_BILL_AMT: '현금영수',
  CRD_CARD_AMT: '신용카드', WES_AMT: '외상',
  TK_GFT_AMT: '상품권', TK_FOD_AMT: '식권', CST_POINT_AMT: '회원포인트',
  GEN_DCM_SALE_AMT: '일반매출', PKG_DCM_SALE_AMT: '포장매출', DLV_DCM_SALE_AMT: '배달매출',
  DC_GEN_AMT: '할인_일반', DC_SVC_AMT: '할인_서비스', DC_CPN_AMT: '할인_쿠폰',
};

// ── 페이지 조회 공통 함수 ──
async function queryPage(win, pageUrl, iframPattern, dateField1, dateField2, startVal, endVal, label) {
  log(`\n--- ${label} ---`);

  // MainFrm 이동
  log(`  페이지 로드: ${pageUrl}`);
  await exec(win.webContents.mainFrame, `window.MainFrm.location = '${pageUrl}'`, 'nav');
  await sleep(8000);

  // IBTab iframe 찾기
  const dataFrame = findFrameByUrl(win, iframPattern);
  if (!dataFrame) {
    log(`  ERROR: ${iframPattern} 미발견`);
    for (const f of win.webContents.mainFrame.framesInSubtree) {
      if (f.url !== 'about:blank' && f.url.includes('/sale/')) log(`    ${f.name}: ${f.url}`);
    }
    return null;
  }
  log(`  데이터 프레임: ${dataFrame.url}`);

  // XHR 인터셉트
  await exec(dataFrame, INTERCEPT_SCRIPT, 'intercept');

  // 날짜 설정 (자동 감지)
  log(`  날짜: ${startVal} ~ ${endVal}`);
  const dateResult = await exec(dataFrame, `
    (function() {
      var d1 = document.getElementById('${dateField1}');
      var d2 = document.getElementById('${dateField2}');
      if (!d1 || !d2) {
        var inputs = document.querySelectorAll('input[type="text"]');
        var dateInputs = [];
        for (var i = 0; i < inputs.length; i++) {
          var inp = inputs[i];
          var val = inp.value || '';
          var name = (inp.name || '').toLowerCase();
          var id = (inp.id || '').toLowerCase();
          if (val.match(/\\d{4}-\\d{2}/) || name.indexOf('date') >= 0 || id.indexOf('date') >= 0) {
            dateInputs.push(inp);
          }
        }
        if (dateInputs.length >= 2) { d1 = dateInputs[0]; d2 = dateInputs[1]; }
        else if (dateInputs.length === 1) { d1 = dateInputs[0]; }
      }
      if (!d1) return 'NO_DATE_INPUT';
      if (typeof $ !== 'undefined' && d1.id) {
        $('#' + d1.id).val('${startVal}');
        if (d2 && d2.id) $('#' + d2.id).val('${endVal}');
      } else {
        d1.value = '${startVal}';
        if (d2) d2.value = '${endVal}';
      }
      return (d1.value) + ' ~ ' + (d2 ? d2.value : '?') + ' [' + (d1.name||d1.id) + ', ' + (d2?(d2.name||d2.id):'') + ']';
    })()
  `, 'date');
  log(`  확인: ${dateResult}`);

  // 조회 버튼 클릭
  const sr = await exec(dataFrame, `
    (function() {
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim() === '조회' && b.offsetHeight > 0) { b.click(); return 'clicked'; }
      }
      if (typeof fnSearch === 'function') { fnSearch(1); return 'fnSearch(1)'; }
      return 'NOT_FOUND';
    })()
  `, 'search');
  log(`  조회: ${sr}`);

  await sleep(8000);

  // 캡처 데이터 수집
  const caps = await exec(dataFrame, `JSON.stringify(window._captures || [])`, 'caps');
  const captured = caps ? JSON.parse(caps) : [];
  log(`  캡처: ${captured.length}건`);

  // 성공 응답 파싱
  for (const c of captured) {
    if (c.status === 200 && c.response) {
      try {
        const json = JSON.parse(c.response);
        if (json.Result?.Code === 0 && json.Data) {
          log(`  데이터: ${json.Data.length}행`);
          return json.Data;
        }
      } catch {}
    }
  }

  // 실패 시 상세 로그
  log('  데이터 없음. 캡처 상세:');
  for (const c of captured) {
    log(`    [${c.status}] ${c.url}`);
    if (c.body) {
      const dateMatch = c.body.match(/date1_1=([^&]+).*date1_2=([^&]+)/);
      if (dateMatch) log(`    날짜: ${dateMatch[1]} ~ ${dateMatch[2]}`);
    }
    if (c.response) {
      try {
        const json = JSON.parse(c.response);
        if (json.Data) { log(`    데이터 행: ${json.Data.length}`); return json.Data; }
      } catch {
        log(`    응답 (잘림): ${c.response.substring(0, 200)}...`);
      }
    }
  }
  return null;
}

// ── 일자별 데이터를 날짜별로 분리 ──
function splitByDate(dailyData) {
  const byDate = {};
  for (const row of dailyData) {
    const compactDate = row.SALE_DATE; // YYYYMMDD
    const dateKey = formatDateFromCompact(compactDate); // YYYY-MM-DD
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push(row);
  }
  return byDate;
}

// ── 일자별 데이터를 결과 구조로 변환 ──
function mapDailyRow(d) {
  return {
    date: formatDateFromCompact(d.SALE_DATE),
    totalSaleAmount: parseInt(d.TOT_SALE_AMT) || 0,
    netSaleAmount: parseInt(d.DCM_SALE_AMT) || 0,
    receiptCount: parseInt(d.TOT_SALE_CNT) || 0,
    cardAmount: parseInt(d.CRD_CARD_AMT) || 0,
    cashAmount: parseInt(d.CASH_AMT2) || 0,
    cashReceiptAmount: parseInt(d.CASH_BILL_AMT) || 0,
    vatAmount: parseInt(d.VAT_AMT) || 0,
    totalDiscountAmount: parseInt(d.TOT_DC_AMT) || 0,
    totalPayAmount: parseInt(d.TOT_PAY_AMT) || 0,
    guestCount: parseInt(d.FD_GST_CNT_T) || 0,
    pricePerGuest: parseInt(d.SALE_PER_GST) || 0,
    generalSaleAmount: parseInt(d.GEN_DCM_SALE_AMT) || 0,
    packageSaleAmount: parseInt(d.PKG_DCM_SALE_AMT) || 0,
    deliverySaleAmount: parseInt(d.DLV_DCM_SALE_AMT) || 0,
    creditAmount: parseInt(d.WES_AMT) || 0,
    giftCertificateAmount: parseInt(d.TK_GFT_AMT) || 0,
    mealTicketAmount: parseInt(d.TK_FOD_AMT) || 0,
    memberPointAmount: parseInt(d.CST_POINT_AMT) || 0,
    serviceTipAmount: parseInt(d.SVC_TIP_AMT) || 0,
  };
}

// ── 메인 ──
app.whenReady().then(async () => {
  fs.writeFileSync(LOG_FILE, '');

  if (!config.id || !config.pw) {
    emit('error', { error: '--id=ID --pw=PW 필요' });
    app.quit(); return;
  }

  const { startDate, endDate } = getDateRangeByMode();
  emit('status', { msg: `OKPOS 수집 시작 (${config.mode}: ${startDate} ~ ${endDate})` });
  log(`=== OKPOS 워커: ${config.mode} (${startDate} ~ ${endDate}) ===`);

  const win = new BrowserWindow({
    width: 1400, height: 900, show: SHOW,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  try {
    // ━━━ 1. 로그인 ━━━
    emit('status', { msg: 'OKPOS 로그인 중...' });
    log('\n[1] 로그인...');
    await win.loadURL(LOGIN_URL);
    await sleep(2000);
    await exec(win.webContents.mainFrame, `
      (function() {
        var id = document.getElementById('user_id');
        var pw = document.getElementById('user_pwd');
        if (!id || !pw) return 'NOT_FOUND';
        id.value = '${config.id}'; pw.value = '${config.pw}';
        id.closest('form')?.submit();
        return 'OK';
      })()
    `, 'login').then(r => log(`  ${r}`));

    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      if (win.webContents.getURL().includes('top_frame')) { log('  로그인 성공'); break; }
    }
    await sleep(2000);

    // ━━━ 2. 팝업 처리 ━━━
    log('\n[2] 팝업...');
    const popup = findFrameByName(win, 'divPopupFrame0');
    if (popup && popup.url.includes('agreement')) {
      await exec(popup, `
        (function() {
          document.querySelectorAll('input[type="checkbox"]').forEach(function(c) { c.checked = true; });
          for (var i = 0; i < document.querySelectorAll('button, input[type="button"], a, [onclick]').length; i++) {
            var b = document.querySelectorAll('button, input[type="button"], a, [onclick]')[i];
            var t = (b.textContent || b.value || '').trim();
            var oc = b.getAttribute('onclick') || '';
            if (t.indexOf('동의') >= 0 || t.indexOf('확인') >= 0 || oc.indexOf('fnAgreement') >= 0) { b.click(); return t; }
          }
          return 'no btn';
        })()
      `, 'popup').then(r => log(`  ${r}`));
      await sleep(1500);
    }

    // ━━━ 3. 메뉴 URL 조회 ━━━
    emit('status', { msg: '메뉴 URL 조회 중...' });
    log('\n[3] 메뉴 URL 조회...');
    const menuFrame = findFrameByName(win, 'MenuVFrm');
    const menuUrls = await exec(menuFrame, `
      (function() {
        if (typeof AL === 'undefined') return JSON.stringify({ error: 'NO_AL' });
        var daily = null;
        for (var i = 0; i < AL.length; i++) {
          var item = AL[i];
          if (item.PGM_LCLS_NM === '매출관리' && item.PGM_MCLS_NM === '매출현황') {
            if (item.PGM_NM === '일자별') daily = item.PGM_FILE_NM;
          }
        }
        return JSON.stringify({ daily: daily });
      })()
    `, 'menu');
    const urls = JSON.parse(menuUrls);
    log(`  일자별: ${urls.daily}`);

    if (!urls.daily) {
      emit('error', { error: '메뉴 URL 미발견' });
      throw new Error('메뉴 URL 미발견');
    }

    // ━━━ 4. 일자별 조회 (날짜 범위) ━━━
    emit('status', { msg: `일자별 조회 중 (${startDate} ~ ${endDate})...` });
    log(`\n[4] 일자별 조회 (${startDate} ~ ${endDate})...`);

    const dailyData = await queryPage(
      win, urls.daily, 'day_total010', 'date1_1', 'date1_2',
      startDate, endDate, `일자별 조회 (${startDate} ~ ${endDate})`
    );

    if (!dailyData || dailyData.length === 0) {
      emit('error', { error: '일자별 데이터 없음' });
      throw new Error('일자별 데이터 없음');
    }

    log(`\n[5] 데이터 처리 (${dailyData.length}행)...`);

    // shopId 추출 (첫 행에서)
    const shopCd = dailyData[0]?.SHOP_CD || config.id.toUpperCase();
    const shopName = dailyData[0]?.SHOP_NM || '';

    // ━━━ 5. 날짜별 분리 + API 전송 ━━━
    const byDate = splitByDate(dailyData);
    const sortedDates = Object.keys(byDate).sort();

    log(`  ${sortedDates.length}일치 데이터 (${sortedDates[0]} ~ ${sortedDates[sortedDates.length - 1]})`);

    const mappedOrders = [];
    for (const dateKey of sortedDates) {
      const rows = byDate[dateKey];
      for (const row of rows) {
        const mapped = mapDailyRow(row);
        mappedOrders.push(mapped);

        // 매출지킴이 API 전송 (날짜별)
        await sendToSalesKeeper(dateKey, shopCd, mapped, row);
      }
    }

    // 0건 마커 sweep — 요청 기간 중 매출 데이터 없는 날짜에도 0매출 페이로드로 sync log 남김
    const sweepStat = await sweepMissingDates(startDate, endDate, sortedDates, (md) =>
      sendToSalesKeeper(md, shopCd, { ...ZERO_OKPOS_SALES }, {})
    );
    if (sweepStat.sent > 0) log(`   0건 마커: ${sweepStat.sent}/${sweepStat.total}일`);

    // ━━━ 6. 결과 요약 로그 ━━━
    log('\n--- 결과 요약 ---');
    const yoilMap = { '1': '일', '2': '월', '3': '화', '4': '수', '5': '목', '6': '금', '7': '토' };
    for (const row of dailyData) {
      const d = row.SALE_DATE;
      const dateFmt = formatDateFromCompact(d);
      log(`  [일자별] ${dateFmt} (${yoilMap[row.SALE_YOIL] || row.SALE_YOIL})`);
      log(`    총매출: ${Number(row.TOT_SALE_AMT || 0).toLocaleString()} | 실매출: ${Number(row.DCM_SALE_AMT || 0).toLocaleString()}`);
      log(`    영수건수: ${row.TOT_SALE_CNT} | 고객: ${row.FD_GST_CNT_T}`);
      log(`    카드: ${Number(row.CRD_CARD_AMT || 0).toLocaleString()} | 현금: ${Number(row.CASH_AMT2 || 0).toLocaleString()} | 현금영수: ${Number(row.CASH_BILL_AMT || 0).toLocaleString()}`);
    }

    // ━━━ 7. 결과 emit ━━━
    emit('result', {
      site: 'okpos',
      shops: [{
        shopName: shopName,
        shopId: shopCd,
        orders: mappedOrders,
      }],
    });

    log('\n=== OKPOS 워커 완료 ===');
    emit('done', {});

  } catch (err) {
    log(`\nERROR: ${err?.message || JSON.stringify(err) || err}`);
    emit('error', { error: err?.message || String(err) });
  }

  setTimeout(() => app.quit(), 5000);
});

app.on('window-all-closed', () => app.quit());
