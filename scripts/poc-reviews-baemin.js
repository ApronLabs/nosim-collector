'use strict';
// ════════════════════════════════════════════════════════════════════════════
// 배민 리뷰 수집 워커 (Electron) — self-api.baemin.com/v1/review/.../reviews 캡처.
//
// ⚠️ 미검증(2026-07-02): 엔드포인트/스키마는 실측 확정(Claude-in-Chrome)했으나,
//    이 Electron 실행 경로는 '월하화 배민 세션'이 없어 아직 1회 실행 검증을 못 했다.
//    검증 방법: 월하화 배민 계정으로 persist:baemin 세션을 살린 뒤 아래 실행.
//    검증 전까지는 '설계대로 구현된 스캐폴드'로 취급(파서 baemin-review-map 은 검증 완료).
//
// 설계: 매출 수집기(poc-baemin.js)의 검증된 패턴 재사용 —
//   · 같은 persist:baemin 파티션(=매출 로그인 세션 공유, 새 로그인 없음)
//   · UA 마스킹 + webdriver 제거 (동일)
//   · read-only: 로그인 페이지면 자동로그인 안 함(재인증은 매출 단계 몫) → 즉시 실패보고
//   · self-api 는 fetchViaWebview(쿠키+service-channel, 주문 수집과 동일)로 replay
//   · from/to/offset/limit 로 페이지네이션(next=false 까지), 안전 상한
//
// 실행(검증용, 월하화 세션 필요):
//   npx electron scripts/poc-reviews-baemin.js --shopNumber=<n> --from=2026-06-01 --to=2026-07-02 --out=/tmp/reviews.json
//   shopNumber 미지정 시 세션의 /v4/store/shops 목록에서 자동 발견(첫 매장).
// ════════════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, WebContentsView } = require('electron');
const fs = require('fs');

const getArg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : undefined; };
const SHOP = getArg('shopNumber') || '';
const FROM = getArg('from') || new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
const TO = getArg('to') || new Date().toISOString().slice(0, 10);
const OUT = getArg('out') || './reviews-out.json';
const TAB = getArg('tab') || 'all'; // all | no-comment
const LIMIT = Number(getArg('limit') || 20);
const MAX_PAGES = Number(getArg('maxPages') || 200); // 안전 상한(무한루프 차단)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

let mainWindow, webView;

function isLoginUrl(url) { return url.includes('/login') || url.includes('/signin') || url.includes('biz-member'); }

function navigateAndWait(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false; const fin = () => { if (done) return; done = true; clearTimeout(t); resolve(); };
    const t = setTimeout(fin, timeoutMs);
    webView.webContents.once('did-finish-load', fin);
    webView.webContents.loadURL(url).catch(() => {});
  });
}

// self-api GET (쿠키 + service-channel + withCredentials). 주문 수집(poc-baemin)과 동일 계약.
function fetchViaWebview(apiUrl) {
  return webView.webContents.executeJavaScript(`
    (function(){ return new Promise(function(resolve){
      var xhr = new XMLHttpRequest();
      xhr.open('GET', ${JSON.stringify(apiUrl)}, true);
      xhr.setRequestHeader('Accept','application/json, text/plain, */*');
      xhr.setRequestHeader('service-channel','SELF_SERVICE_PC');
      xhr.withCredentials = true;
      xhr.onload = function(){ if(xhr.status>=200&&xhr.status<300){ try{resolve({success:true,data:JSON.parse(xhr.responseText)});}catch(e){resolve({error:'parse:'+e.message});} } else { resolve({error:'HTTP '+xhr.status, status:xhr.status, body:(xhr.responseText||'').slice(0,300)}); } };
      xhr.onerror = function(){ resolve({error:'onerror status='+xhr.status}); };
      xhr.ontimeout = function(){ resolve({error:'timeout'}); };
      xhr.timeout = 30000; xhr.send();
    }); })()
  `);
}

async function discoverShopNumber() {
  // 세션의 매장 목록에서 shopNumber 발견(첫 매장). 실제 운영은 매장 지정 권장.
  const r = await fetchViaWebview('https://self-api.baemin.com/v4/store/shops');
  const shops = r && r.data && (r.data.shops || r.data.list || r.data);
  if (Array.isArray(shops) && shops.length) return String(shops[0].shopNumber || shops[0].shopId || shops[0].id || '');
  return '';
}

async function collectReviews(shop) {
  const all = [];
  for (let page = 0, offset = 0; page < MAX_PAGES; page++, offset += LIMIT) {
    const url = `https://self-api.baemin.com/v1/review/shops/${shop}/reviews/${TAB}` +
      `?from=${FROM}&to=${TO}&offset=${offset}&limit=${LIMIT}`;
    const r = await fetchViaWebview(url);
    if (r && r.error) throw new Error(`리뷰 API 실패(offset ${offset}): ${r.error}`);
    const data = r && r.data;
    const reviews = (data && Array.isArray(data.reviews)) ? data.reviews : [];
    all.push(...reviews);
    out({ type: 'status', msg: `page ${page + 1}: +${reviews.length} (누적 ${all.length})` });
    if (!data || !data.next || reviews.length === 0) break;
    await sleep(600 + Math.floor(Math.random() * 500)); // 페이싱(자연스러운 간격)
  }
  return all;
}

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({ width: 1200, height: 900, show: false });
  await mainWindow.loadURL('about:blank');
  webView = new WebContentsView({ webPreferences: { contextIsolation: false, nodeIntegration: false, partition: 'persist:baemin' } });
  mainWindow.contentView.addChildView(webView);
  const [w, h] = mainWindow.getContentSize();
  webView.setBounds({ x: 0, y: 0, width: w, height: h });
  const chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  webView.webContents.session.setUserAgent(chromeUA);
  webView.webContents.setUserAgent(chromeUA);
  webView.webContents.on('dom-ready', () => {
    webView.webContents.executeJavaScript(`Object.defineProperty(navigator,'webdriver',{get:()=>false});`).catch(() => {});
  });

  try {
    await navigateAndWait('https://self.baemin.com');
    await sleep(2500);
    if (isLoginUrl(webView.webContents.getURL())) {
      // read-only 원칙: 리뷰 워커는 재로그인 안 함(reCAPTCHA·세션 오염 위험). 세션은 매출 수집이 살려둔다.
      out({ type: 'error', error: '배민 세션 없음/만료 — 매출 수집으로 세션 확보 후 재시도(리뷰는 재로그인 안 함)' });
      app.quit(); return;
    }
    const shop = SHOP || (await discoverShopNumber());
    if (!shop) { out({ type: 'error', error: 'shopNumber 확보 실패' }); app.quit(); return; }
    out({ type: 'status', msg: `리뷰 수집 shop=${shop} ${FROM}~${TO} tab=${TAB}` });
    const reviews = await collectReviews(shop);
    fs.writeFileSync(OUT, JSON.stringify({ shopNumber: shop, from: FROM, to: TO, count: reviews.length, reviews }, null, 2));
    out({ type: 'result', shopNumber: shop, count: reviews.length, out: OUT });
  } catch (err) {
    out({ type: 'error', error: (err && err.message) || String(err) });
  } finally {
    app.quit();
  }
});
