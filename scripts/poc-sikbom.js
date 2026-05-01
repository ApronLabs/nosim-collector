/**
 * 식봄(foodspring.co.kr) 워커: 노심 서버의 pending_scrape 목록을 소비
 *
 * 실행:
 *   npx electron poc-sikbom.js \
 *     --id=네이버ID --pw=네이버PW \
 *     --storeId=매장UUID --serverUrl=https://no-sim.co.kr --sessionToken=JWT
 *
 * 흐름:
 *   1) GET {serverUrl}/api/stores/{storeId}/supplier-scrapers/sikbom/pending
 *      → [{ supplierOrderId, orderNumber, sikbomOrderId, detailUrl }]
 *   2) 첫 detailUrl로 navigate → 네이버 OAuth 로그인 페이지로 리다이렉트됨
 *   3) 자동 로그인 (ID/PW 입력 + 로그인 버튼 클릭). 캡차/기기등록 감지되면
 *      mainWindow.show() 후 수동 개입 대기
 *   4) 로그인 완료 후 각 pending order를 순회하며 detail 페이지에서 DOM 파싱
 *   5) POST {serverUrl}/api/stores/{storeId}/supplier-scrapers/sikbom
 *      with 파싱된 items/금액/배송정보
 *   6) 3~5초 sleep 후 다음 주문. 한 실행당 최대 MAX_ORDERS_PER_RUN건.
 *
 * 세션은 PocRunner가 전달하는 stable user-data-dir(~/.poc-sikbom-session)에 유지되어
 * 다음 실행부터 네이버 로그인 스킵 (캡차 회피).
 */

const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const POC_VERSION = app.getVersion() || 'unknown';
const SHOW = process.argv.includes('--show');

// ── CLI 인자 파싱 ──
function getArg(name) {
  const a = process.argv.find(a => a.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : '';
}

const config = {
  id: getArg('id'),
  pw: getArg('pw'),
  storeId: getArg('storeId'),
  serverUrl: getArg('serverUrl'),
  sessionToken: getArg('sessionToken'),
  // 스케줄러가 생성해 전달하는 runId. 없으면 자체 생성.
  runId: getArg('runId') || `poc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
};

const LOG_FILE = path.join(__dirname, 'poc-sikbom-log.txt');
const MAX_ORDERS_PER_RUN = 30;
const SLEEP_BETWEEN_ORDERS_MS = 3500;

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
  postTrace('error', 'uncaught', err.message).catch(() => {});
});
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 서버 trace 전송 ──
// 실행 단계마다 POST해서 리드 개발자가 서버에서 실행 상황을 볼 수 있게 한다.
async function postTrace(level, event, message, payload) {
  if (!config.serverUrl || !config.storeId || !config.sessionToken) return;
  try {
    const body = {
      runId: config.runId,
      level,
      event,
      message: message || null,
      payload: payload || null,
    };
    await fetch(
      `${config.serverUrl}/api/stores/${config.storeId}/supplier-scrapers/sikbom/trace`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session-token=${config.sessionToken}`,
        },
        body: JSON.stringify(body),
      }
    );
  } catch (err) {
    log(`trace POST 실패 (${event}): ${err.message}`);
  }
}

// ── 네이버 자동 로그인 스크립트 ──
// 네이버 로그인 페이지 https://nid.naver.com/nidlogin.login
// 기본 셀렉터: #id, #pw, .btn_login / button.btn_login / #frmNIDLogin [type=submit]
function getNaverLoginScript(id, pw) {
  return `(async function() {
    await new Promise(r => setTimeout(r, 800));
    const idInput = document.querySelector('#id') || document.querySelector('input[name="id"]');
    const pwInput = document.querySelector('#pw') || document.querySelector('input[name="pw"]');
    if (!idInput || !pwInput) return { success: false, error: 'naver input not found' };

    function typeInto(el, val) {
      el.focus();
      el.value = '';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, val);
      if (el.value !== val) {
        setter.call(el, val);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    typeInto(idInput, ${JSON.stringify(id)});
    await new Promise(r => setTimeout(r, 250));
    typeInto(pwInput, ${JSON.stringify(pw)});
    await new Promise(r => setTimeout(r, 500));

    // 로그인 버튼: 네이버는 .btn_login, #log.login, button[type=submit] 등 다양
    const candidates = [
      'button.btn_login',
      '.btn_login',
      '#log\\\\.login',
      '#frmNIDLogin button[type="submit"]',
      'button[type="submit"]',
      'input[type="submit"]',
    ];
    for (const sel of candidates) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); return { success: true, used: sel }; }
    }
    // 폴백: form submit
    const form = document.querySelector('#frmNIDLogin') || document.querySelector('form');
    if (form) { form.submit(); return { success: true, used: 'form.submit' }; }
    return { success: false, error: 'naver login button not found' };
  })()`;
}

// ── 캡차/기기등록 감지 ──
function detectNaverBlock() {
  return webView.webContents.executeJavaScript(`(function() {
    const url = location.href;
    const body = document.body ? document.body.innerText || '' : '';
    return {
      captcha: !!document.querySelector('iframe[src*="captcha"]') ||
               body.includes('자동입력방지') || body.includes('자동입력 방지'),
      deviceRegister: url.includes('deviceConfirm') || url.includes('deviceUnlock') ||
                      body.includes('새로운 기기') || body.includes('기기 등록'),
      otp: url.includes('otp') || body.includes('일회용 비밀번호'),
      currentUrl: url.slice(0, 200),
    };
  })()`);
}

// ── 페이지 상태 헬퍼 ──
let mainWindow, webView;

function navigateAndWait(url, timeoutMs = 30000) {
  return new Promise(resolve => {
    let resolved = false;
    const done = () => { if (resolved) return; resolved = true; clearTimeout(t); };
    const t = setTimeout(() => { done(); resolve(); }, timeoutMs);
    webView.webContents.once('did-finish-load', () => { done(); resolve(); });
    webView.webContents.loadURL(url).catch(() => {});
  });
}

function isNaverLoginUrl(url) {
  return url.includes('nid.naver.com') || url.includes('nidlogin');
}

function isFoodspringLoginUrl(url) {
  return url.includes('foodspring.co.kr/login');
}

/** 네이버 로그인 + 식봄 로그인 둘 다 감지 */
function isAnyLoginUrl(url) {
  return isNaverLoginUrl(url) || isFoodspringLoginUrl(url);
}

/** 식봄 주문상세 페이지에 도달했는지 확인 */
function isDetailPageUrl(url) {
  return url.includes('foodspring.co.kr/order/detail/');
}

function waitForLoginComplete(timeoutMs = 30000) {
  return new Promise(resolve => {
    const cur = webView.webContents.getURL();
    if (!isAnyLoginUrl(cur)) { resolve(cur); return; }
    let resolved = false;
    const cleanup = () => {
      if (resolved) return; resolved = true;
      clearInterval(poll); clearTimeout(t);
      webView.webContents.removeListener('did-navigate', onNav);
      webView.webContents.removeListener('did-navigate-in-page', onNav);
    };
    const t = setTimeout(() => { cleanup(); resolve(webView.webContents.getURL()); }, timeoutMs);
    const onNav = (_, url) => { if (!isAnyLoginUrl(url)) { cleanup(); resolve(url); } };
    webView.webContents.on('did-navigate', onNav);
    webView.webContents.on('did-navigate-in-page', onNav);
    const poll = setInterval(() => {
      const url = webView.webContents.getURL();
      if (!isAnyLoginUrl(url)) { cleanup(); resolve(url); }
    }, 1000);
  });
}

// 식봄 로그인 페이지에서 "네이버로 로그인" 버튼/링크를 찾아 클릭하는 스크립트.
// 식봄은 자체 로그인 페이지를 거쳐 네이버 OAuth로 리다이렉트하는 구조.
const CLICK_NAVER_LOGIN_SCRIPT = `(async function() {
  await new Promise(r => setTimeout(r, 1000));
  // 네이버 로그인 링크/버튼 찾기 — 여러 셀렉터 후보
  const selectors = [
    'a[href*="naver"]',
    'button[class*="naver"]',
    '[class*="naver"] a',
    '[class*="Naver"] a',
    'a[class*="sns"]',
    'a[class*="social"]',
    'img[alt*="네이버"]',
    'img[alt*="naver"]',
  ];
  // click 후 URL 변화로 실제 navigate 여부 검증.
  // href="" 같은 placeholder element 가 click 됐을 때 false 반환해서 수동 fallback 으로 빠지게.
  async function tryClick(el, used) {
    const link = el.closest('a') || el;
    const beforeUrl = window.location.href;
    link.click();
    await new Promise(r => setTimeout(r, 1500));
    if (window.location.href !== beforeUrl) {
      return { success: true, used, href: link.href || '', navigated: true };
    }
    return null;
  }
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const r = await tryClick(el, sel);
      if (r) return r;
    }
  }
  // 폴백: 텍스트 기반 검색
  const allLinks = document.querySelectorAll('a, button');
  for (const el of allLinks) {
    const text = (el.textContent || '').trim();
    if (text.includes('네이버') || text.includes('NAVER') || text.includes('naver')) {
      const r = await tryClick(el, 'text:' + text.slice(0, 30));
      if (r) return r;
    }
  }
  return { success: false, error: 'naver login button click 후 URL 변화 없음 — 셀렉터가 placeholder element 를 잡았거나 onclick 핸들러가 막힘' };
})()`;

// ── 서버 API ──
async function fetchPendingOrders() {
  const url = `${config.serverUrl}/api/stores/${config.storeId}/supplier-scrapers/sikbom/pending`;
  const res = await fetch(url, {
    headers: { Cookie: `session-token=${config.sessionToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`pending API ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data || [];
}

async function postScraped(supplierOrderId, scraped) {
  const url = `${config.serverUrl}/api/stores/${config.storeId}/supplier-scrapers/sikbom`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `session-token=${config.sessionToken}`,
    },
    body: JSON.stringify({ supplierOrderId, scraped, pocVersion: POC_VERSION }),
  });
  const text = await res.text();
  log(`   ingest ${supplierOrderId}: ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, ok: res.ok, body: text };
}

// ── 주문상세 DOM 파싱 ──
// 사용자 스크린샷 기반 대략 구조:
//   주문일 : 2026-04-08 10:08:11   주문번호 : MPFI01188381467
//   (상품 row 반복)
//     판매자 : 다봄푸드
//     상품명 (h3/.name)
//     단위 (1.4kg / EA)
//     단가/수량 (11,480원 / 1개)
//     배송완료 / 취소 등
//   배송 정보
//     배송지명, 받는 사람, 연락처
//
// 실제 셀렉터는 첫 실행 시 visible window로 확인 후 이 함수만 조정하면 됨.
// 실패 대비로 body.innerText 정규식 폴백 병행.
const PARSE_DETAIL_SCRIPT = `(function() {
  function parseMoney(s) {
    const m = (s || '').match(/([\\d,]+)/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  }
  function parseQty(s) {
    const m = (s || '').match(/(\\d+)\\s*개/);
    return m ? parseInt(m[1], 10) : 1;
  }

  const text = document.body ? document.body.innerText : '';
  const out = { orderNumber: '', orderDate: '', items: [], delivery: {} };

  // 주문번호/주문일 — 헤더 영역 정규식
  const onMatch = text.match(/주문번호[\\s:]*\\s*(M[A-Z0-9]{3}\\d{6,})/);
  if (onMatch) out.orderNumber = onMatch[1];
  const odMatch = text.match(/주문일[\\s:]*\\s*(\\d{4}-\\d{2}-\\d{2})/);
  if (odMatch) out.orderDate = odMatch[1];

  // 상품 row — 여러 레이아웃에 대응하기 위해 우선순위로 셀렉터 시도
  const rowSelectorCandidates = [
    'table tbody tr',
    '.order-item',
    '.product-row',
    '[class*="OrderItem"]',
    '[class*="orderItem"]',
  ];
  let rows = [];
  for (const sel of rowSelectorCandidates) {
    const found = Array.from(document.querySelectorAll(sel));
    if (found.length > 0) { rows = found; break; }
  }

  for (const row of rows) {
    const cellText = row.innerText || '';
    // 판매자: "판매자 :다봄푸드" 또는 "판매자: 다봄푸드"
    const sellerMatch = cellText.match(/판매자[\\s:]*([^\\n\\r]+?)(?:\\n|$)/);
    const sellerName = sellerMatch ? sellerMatch[1].trim() : '';

    // 상품명: 가장 큰 텍스트 블록 또는 첫 번째 제품 이름
    let productName = '';
    const nameEl = row.querySelector('h3, h4, .name, .product-name, [class*="productName"], [class*="ProductName"]');
    if (nameEl) productName = (nameEl.innerText || '').trim();

    // 금액/수량
    const amountMatches = cellText.match(/([\\d,]+)원\\s*\\/\\s*(\\d+)\\s*개/);
    let subtotal = 0, quantity = 1;
    if (amountMatches) {
      subtotal = parseMoney(amountMatches[1]);
      quantity = parseInt(amountMatches[2], 10);
    }

    if (productName && subtotal > 0) {
      out.items.push({
        productName,
        unitPrice: quantity > 0 ? Math.round(subtotal / quantity) : subtotal,
        quantity,
        subtotal,
        sellerName,
      });
    }
  }

  // 배송 정보
  const recipNameMatch = text.match(/배송지명[^\\n]*\\n\\s*([^\\n]+)/);
  if (recipNameMatch) out.delivery.recipientName = recipNameMatch[1].trim();
  const recipPhoneMatch = text.match(/연락처[^\\n]*\\n\\s*([^\\n]+)/);
  if (recipPhoneMatch) out.delivery.recipientPhone = recipPhoneMatch[1].trim();
  const addressMatch = text.match(/배송주소[^\\n]*\\n\\s*([^\\n]+)/);
  if (addressMatch) out.delivery.deliveryAddress = addressMatch[1].trim();

  return out;
})()`;

async function scrapeOrderDetail(detailUrl) {
  log(`   navigate: ${detailUrl}`);
  await navigateAndWait(detailUrl);
  await sleep(2500);

  // 로그인 페이지로 리다이렉트된 경우 재로그인 1회 (식봄/네이버 양쪽 감지)
  let currentUrl = webView.webContents.getURL();
  if (isAnyLoginUrl(currentUrl)) {
    log('   세션 만료 → 재로그인 시도');
    await performLogin();
    // 로그인 후 detail URL로 다시 이동 (식봄 OAuth callback이 rtn URL로 돌려보내지만 확실히)
    if (!isDetailPageUrl(webView.webContents.getURL())) {
      await navigateAndWait(detailUrl);
      await sleep(2500);
    }
    currentUrl = webView.webContents.getURL();
    if (isAnyLoginUrl(currentUrl)) {
      throw new Error('세션 만료 후 재로그인 실패');
    }
  }

  // 페이지가 SPA라면 렌더 대기
  await sleep(1500);
  const parsed = await webView.webContents.executeJavaScript(PARSE_DETAIL_SCRIPT);
  log(`   parsed: orderNumber=${parsed.orderNumber} items=${parsed.items.length}`);
  return parsed;
}

// ── 로그인 수행 (식봄 자체 로그인 + 네이버 OAuth 2단계) ──
async function performLogin() {
  let currentUrl = webView.webContents.getURL();

  // 어떤 로그인 페이지에도 안 걸리면 이미 세션 유효
  if (!isAnyLoginUrl(currentUrl)) {
    await postTrace('info', 'login-skip', '이미 로그인 상태 (세션 유효)', { url: currentUrl.slice(0, 200) });
    return true;
  }

  // ── Step 1: 식봄 자체 로그인 페이지 → "네이버로 로그인" 버튼 클릭 ──
  if (isFoodspringLoginUrl(currentUrl)) {
    log(`   식봄 로그인 페이지 감지: ${currentUrl.slice(0, 80)}`);
    await postTrace('info', 'foodspring-login', '식봄 로그인 페이지에서 네이버 로그인 버튼 클릭 시도', { url: currentUrl.slice(0, 200) });

    const clickResult = await webView.webContents.executeJavaScript(CLICK_NAVER_LOGIN_SCRIPT);
    log(`   네이버 로그인 버튼 클릭: ${JSON.stringify(clickResult)}`);
    await postTrace('info', 'foodspring-naver-click', `결과: ${JSON.stringify(clickResult)}`);

    if (!clickResult.success) {
      // 버튼을 못 찾으면 visible window로 사장님 수동 개입
      log('   식봄 로그인 페이지에서 네이버 버튼 못 찾음 → 수동 대기');
      await postTrace('warn', 'foodspring-login-manual', '네이버 로그인 버튼 못 찾음 — 수동 개입 대기');
      mainWindow.show();
      emit('status', { msg: '식봄 로그인 페이지에서 네이버 로그인을 선택해주세요.' });
      await waitForLoginComplete(120000);
      await sleep(2000);
    } else {
      // 네이버 OAuth 리다이렉트 대기
      await waitForLoginComplete(20000);
      await sleep(2000);
    }

    currentUrl = webView.webContents.getURL();
  }

  // ── Step 2: 네이버 로그인 페이지 (OAuth 리다이렉트 후) ──
  if (isNaverLoginUrl(currentUrl)) {
    log(`   네이버 로그인 페이지 감지: ${currentUrl.slice(0, 80)}`);
    await postTrace('info', 'login-auto-submit', '네이버 자동 로그인 스크립트 주입', { url: currentUrl.slice(0, 200) });

    const loginResult = await webView.webContents.executeJavaScript(getNaverLoginScript(config.id, config.pw));
    log(`   auto login: ${JSON.stringify(loginResult)}`);
    await postTrace('info', 'login-submitted', `결과: ${JSON.stringify(loginResult)}`);
    await waitForLoginComplete(20000);
    await sleep(2000);

    const block = await detectNaverBlock();
    log(`   block check: ${JSON.stringify(block)}`);
    if (block.captcha || block.deviceRegister || block.otp) {
      log('   캡차/기기등록/OTP 감지 → 수동 개입 대기 (최대 120초)');
      await postTrace('warn', 'login-block', `수동 개입 필요: ${JSON.stringify(block)}`, block);
      mainWindow.show();
      emit('status', { msg: '네이버에서 추가 확인이 필요합니다. 창에서 처리해주세요.' });
      await waitForLoginComplete(120000);
      await sleep(2000);
    }
  }

  // 최종 확인: 로그인 페이지에서 벗어났는지
  const finalUrl = webView.webContents.getURL();
  if (isAnyLoginUrl(finalUrl)) {
    await postTrace('error', 'login-failed', '로그인 실패 — 여전히 로그인 페이지', {
      url: finalUrl.slice(0, 200),
    });
    throw new Error('로그인 실패: ' + finalUrl.slice(0, 100));
  }

  await postTrace('info', 'login-done', '로그인 완료', { url: finalUrl.slice(0, 200) });
  return true;
}

app.whenReady().then(async () => {
  fs.writeFileSync(LOG_FILE, '');

  if (!config.id || !config.pw || !config.storeId || !config.serverUrl || !config.sessionToken) {
    emit('error', { error: '--id --pw --storeId --serverUrl --sessionToken 필수' });
    app.quit();
    return;
  }

  emit('status', { msg: '식봄 스크래퍼 시작 — pending 목록 조회' });
  log(`=== 식봄 워커 시작 runId=${config.runId} ===`);
  await postTrace('info', 'start', 'poc-sikbom.js 시작', { runId: config.runId });

  let pending;
  try {
    pending = await fetchPendingOrders();
  } catch (err) {
    emit('error', { error: `pending API 실패: ${err.message}` });
    log(`[FATAL] pending API: ${err.message}`);
    await postTrace('error', 'pending-fetch-failed', err.message);
    setTimeout(() => app.quit(), 2000);
    return;
  }

  log(`   pending count: ${pending.length}`);
  await postTrace('info', 'pending-fetched', `${pending.length}건`, {
    count: pending.length,
    orderNumbers: pending.slice(0, 10).map(p => p.orderNumber),
  });

  if (pending.length === 0) {
    emit('status', { msg: '수집할 식봄 주문이 없습니다.' });
    emit('done', { site: 'sikbom', processed: 0 });
    await postTrace('info', 'done', '처리할 주문 없음 — 조기 종료', { processed: 0 });
    setTimeout(() => app.quit(), 2000);
    return;
  }

  const batch = pending.slice(0, MAX_ORDERS_PER_RUN);
  log(`   batch: ${batch.length}건 처리 시작`);

  mainWindow = new BrowserWindow({ width: 1200, height: 900, show: SHOW });
  mainWindow.loadURL('about:blank');
  webView = new WebContentsView({
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  mainWindow.contentView.addChildView(webView);
  const [w, h] = mainWindow.getContentSize();
  webView.setBounds({ x: 0, y: 0, width: w, height: h });

  webView.webContents.on('console-message', (_, level, msg) => {
    if (msg.includes('[sikbom]')) log(`  ${msg}`);
  });

  let successCount = 0;
  let failCount = 0;
  const errors = [];

  try {
    // 1) 첫 주문으로 이동 → 네이버 로그인 유도 (세션 지속 시 바로 통과)
    const first = batch[0];
    log(`1) 초기 navigate: ${first.detailUrl}`);
    await postTrace('info', 'nav-initial', `첫 detailUrl로 이동`, { url: first.detailUrl });
    await navigateAndWait(first.detailUrl);
    await sleep(2500);

    await postTrace('info', 'login-start', `현재 URL: ${webView.webContents.getURL().slice(0, 200)}`);
    await performLogin();
    log('2) 로그인 상태 확인 완료');
    await postTrace('info', 'login-done', '로그인 통과');

    // 2) pending 순회
    for (let i = 0; i < batch.length; i++) {
      const order = batch[i];
      emit('status', {
        msg: `[${i + 1}/${batch.length}] ${order.orderNumber} 수집 중`,
      });
      log(`\n[${i + 1}/${batch.length}] ${order.orderNumber} (${order.sikbomOrderId})`);

      try {
        const parsed = await scrapeOrderDetail(order.detailUrl);
        await postTrace('info', 'parse', `${order.orderNumber} 파싱`, {
          orderNumber: order.orderNumber,
          parsedOrderNumber: parsed.orderNumber,
          itemsCount: parsed.items?.length || 0,
          delivery: parsed.delivery,
          urlAfter: webView.webContents.getURL().slice(0, 200),
        });
        if (!parsed.items || parsed.items.length === 0) {
          log(`   ⚠ items 0건 — 셀렉터 불일치 가능성. 스킵`);
          errors.push(`${order.orderNumber}: items 0건`);
          await postTrace('warn', 'parse-empty', `items 0건 — DOM 셀렉터 조정 필요`, {
            orderNumber: order.orderNumber,
            url: webView.webContents.getURL().slice(0, 200),
          });
          failCount++;
          await sleep(SLEEP_BETWEEN_ORDERS_MS);
          continue;
        }

        const itemsSubtotal = parsed.items.reduce((s, it) => s + (it.subtotal || 0), 0);
        const scraped = {
          orderDate: parsed.orderDate || order.orderDate,
          paymentMethod: '식봄',
          productTotal: itemsSubtotal,
          deliveryFee: 0,
          discountAmount: 0,
          totalAmount: itemsSubtotal,
          recipientName: parsed.delivery.recipientName,
          recipientPhone: parsed.delivery.recipientPhone,
          deliveryAddress: parsed.delivery.deliveryAddress,
          items: parsed.items,
        };

        const result = await postScraped(order.supplierOrderId, scraped);
        if (result.ok) {
          successCount++;
          emit('result', {
            site: 'sikbom',
            orderNumber: order.orderNumber,
            itemsCount: parsed.items.length,
            totalAmount: itemsSubtotal,
          });
          await postTrace('info', 'post-ok', `${order.orderNumber} 저장 성공`, {
            orderNumber: order.orderNumber,
            itemsCount: parsed.items.length,
            totalAmount: itemsSubtotal,
          });
        } else {
          failCount++;
          errors.push(`${order.orderNumber}: POST ${result.status}`);
          await postTrace('error', 'post-failed', `${order.orderNumber} POST ${result.status}`, {
            orderNumber: order.orderNumber,
            status: result.status,
            body: (result.body || '').slice(0, 500),
          });
        }
      } catch (err) {
        log(`   ✗ ${err.message}`);
        failCount++;
        errors.push(`${order.orderNumber}: ${err.message}`);
        await postTrace('error', 'order-error', err.message, {
          orderNumber: order.orderNumber,
        });
      }

      if (i < batch.length - 1) {
        await sleep(SLEEP_BETWEEN_ORDERS_MS);
      }
    }

    log(`\n=== 완료 success=${successCount} fail=${failCount} ===`);
    emit('done', {
      site: 'sikbom',
      processed: batch.length,
      success: successCount,
      fail: failCount,
      errors: errors.slice(0, 10),
    });
    await postTrace('info', 'done', `완료 success=${successCount} fail=${failCount}`, {
      processed: batch.length,
      success: successCount,
      fail: failCount,
      errors: errors.slice(0, 10),
    });
  } catch (err) {
    log(`[FATAL] ${err.message}`);
    emit('error', { error: err.message });
    await postTrace('error', 'fatal', err.message);
  } finally {
    setTimeout(() => app.quit(), 5000);
  }
});
