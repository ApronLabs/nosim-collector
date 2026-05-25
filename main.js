/**
 * 매출지킴이 바코드 스캐너 v3 - Electron 메인 프로세스
 *
 * EC2 API 연동 + 로그인 + 매장 선택 UI
 * Global Key Listener로 포커스 없이도 바코드 감지
 * 매출 크롤러 (배민/요기요/쿠팡이츠) 통합
 */

// 패키징된 앱에서 PocRunner가 --poc-script 플래그로 재실행할 때 poc 스크립트만 로드
const __pocArg = process.argv.find(a => a.startsWith('--poc-script='));
if (__pocArg) {
  const name = __pocArg.split('=')[1];
  if (/^[a-z]+$/.test(name)) {
    // asarUnpack된 스크립트를 절대 경로로 로드
    const scriptPath = require('path').join(process.resourcesPath, 'app.asar.unpacked', 'scripts', `poc-${name}.js`);
    require(scriptPath);
  }
  return;
}

// sudo-prompt의 Node.util.isObject 호환 이슈 (node-global-key-listener 권한 설정)
process.on('unhandledRejection', (reason) => {
  const msg = String(reason);
  if (msg.includes('isObject') || msg.includes('sudo-prompt')) return; // 무시
  console.error('[unhandledRejection]', reason);
});

require('dotenv').config({ path: ['.env.local', '.env'] });
const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// electron-log: %APPDATA%/barcode-scanner/logs/main.log 에 기록
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const path = require('path');
const { Crawler } = require('./scripts/crawler');
const { AutoCrawlScheduler } = require('./scripts/scheduler');

// 자동화 감지 우회: Electron/Chromium 플래그
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'AutomationControllerForTesting,EnableAutomation');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('lang', 'ko-KR');
app.commandLine.appendSwitch('accept-lang', 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7');

// 크롤러 상태
let crawler = null;
let crawlResults = {};
let crawlErrors = [];
let scheduler = null;

let Store = null;
let store = null;

function initStore() {
  if (!Store) {
    Store = require('electron-store');
    store = new Store({
      name: 'barcode-scanner-config',
      defaults: {
        lastStoreId: null,
        lastStoreName: null,
        serverUrl: 'https://no-sim.co.kr',
      },
    });
    // .env.local의 SERVER_URL이 있으면 store 값 강제 업데이트
    if (process.env.SERVER_URL) {
      store.set('serverUrl', process.env.SERVER_URL);
    }
  }
  return store;
}

// Authenticated fetch helper - handles cookie + 401 detection
async function authenticatedFetch(url, options = {}) {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  const cookies = await session.defaultSession.cookies.get({ url: serverUrl, name: 'session-token' });
  const token = cookies.length > 0 ? cookies[0].value : '';

  const mergedOptions = {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `session-token=${token}`,
    },
  };

  const response = await fetch(url, mergedOptions);

  if (response.status === 401) {
    // Clear cookie
    try {
      await session.defaultSession.cookies.remove(serverUrl, 'session-token');
    } catch (e) { /* ignore */ }
    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-expired');
    }
    return { unauthorized: true, response };
  }

  return { unauthorized: false, response };
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow = null;

app.setName('매출지킴이 바코드 스캐너');

// ========================================
// Global Key Listener - 바코드 스캐너 감지
// ========================================

const BARCODE_CONFIG = {
  INPUT_THRESHOLD_MS: 100,
  MIN_LENGTH: 4,
  BUFFER_TIMEOUT_MS: 300,
};

let keyBuffer = '';
let lastKeyTime = 0;
let bufferTimeout = null;
let fastKeyCount = 0;
let keyListener = null;

// ========================================
// Serial Port - CH340 바코드 리더기
// ========================================

const SERIAL_CONFIG = {
  BAUD_RATES: [9600, 115200],
  CH340_VENDOR_ID: '1A86',
  POLL_INTERVAL_MS: 5000,
};

// 다중 시리얼 포트 지원: { path: { port, parser } }
const serialPorts = {};
let serialPollTimer = null;

function keyToChar(event) {
  const { name, state } = event;
  if (state !== 'DOWN') return null;

  if (name === 'RETURN') return '\n';
  if (name.match(/^[0-9]$/)) return name;
  if (name.match(/^NUMPAD [0-9]$/)) return name.replace('NUMPAD ', '');
  if (name.match(/^[A-Z]$/)) return name.toLowerCase();
  if (name === 'MINUS' || name === 'NUMPAD MINUS') return '-';
  if (name === 'PERIOD' || name === 'NUMPAD PERIOD') return '.';
  if (name === 'SLASH' || name === 'NUMPAD SLASH') return '/';

  return null;
}

function handleBarcodeDetected(barcode) {
  console.log(`  [SCAN] 바코드 감지됨: ${barcode}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('barcode-scanned', barcode);
  }
}

function processKeyEvent(event) {
  const char = keyToChar(event);
  if (!char) return;

  const now = Date.now();
  const timeDiff = now - lastKeyTime;
  lastKeyTime = now;

  if (bufferTimeout) clearTimeout(bufferTimeout);

  const isFastInput = timeDiff < BARCODE_CONFIG.INPUT_THRESHOLD_MS;

  if (isFastInput) {
    fastKeyCount++;
  } else {
    if (keyBuffer.length > 0 && fastKeyCount < 2) {
      keyBuffer = '';
      fastKeyCount = 0;
    }
  }

  if (char === '\n') {
    if (keyBuffer.length >= BARCODE_CONFIG.MIN_LENGTH && fastKeyCount >= 2) {
      handleBarcodeDetected(keyBuffer);
    }
    keyBuffer = '';
    fastKeyCount = 0;
    return;
  }

  keyBuffer += char;

  bufferTimeout = setTimeout(() => {
    if (keyBuffer.length > 0) {
      if (keyBuffer.length >= BARCODE_CONFIG.MIN_LENGTH && fastKeyCount >= 2) {
        handleBarcodeDetected(keyBuffer);
      }
      keyBuffer = '';
      fastKeyCount = 0;
    }
  }, BARCODE_CONFIG.BUFFER_TIMEOUT_MS);
}

function initGlobalKeyListener() {
  try {
    const { GlobalKeyboardListener } = require('node-global-key-listener');
    const listener = new GlobalKeyboardListener();
    listener.addListener((event) => processKeyEvent(event));
    keyListener = listener;
    console.log('  [KEY] Global Key Listener 활성화');
    return true;
  } catch (err) {
    console.error('  [KEY] Global Key Listener 실패:', err.message);
    keyListener = null;
    return false;
  }
}

// ========================================
// Serial Port Functions (다중 포트 지원)
// ========================================

function isCH340Port(p) {
  const vid = (p.vendorId || '').toUpperCase();
  const mfr = (p.manufacturer || '').toUpperCase();
  const pnp = (p.pnpId || '').toUpperCase();
  return vid === SERIAL_CONFIG.CH340_VENDOR_ID
    || mfr.includes('CH340') || mfr.includes('WCH')
    || pnp.includes('CH340') || pnp.includes('WCH');
}

async function findAllCH340Ports() {
  try {
    const ports = await SerialPort.list();
    const all = ports.map(p => `${p.path}(${p.manufacturer || 'N/A'})`).join(', ');
    console.log(`  [SERIAL] 전체 포트: ${all || '없음'}`);
    return ports.filter(isCH340Port);
  } catch (err) {
    console.error('  [SERIAL] 포트 목록 조회 실패:', err.message);
    return [];
  }
}

function sendSerialStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const connectedPorts = Object.keys(serialPorts).filter(p => serialPorts[p].port && serialPorts[p].port.isOpen);
  mainWindow.webContents.send('serial-status', {
    connected: connectedPorts.length > 0,
    ports: connectedPorts,
    count: connectedPorts.length,
  });
}

function tryOpenPort(portPath, baudRate) {
  return new Promise((resolve) => {
    try {
      const port = new SerialPort({
        path: portPath,
        baudRate: baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });

      const parser = port.pipe(new ReadlineParser({ delimiter: '\r' }));

      parser.on('data', (data) => {
        const barcode = data.trim();
        if (barcode.length >= BARCODE_CONFIG.MIN_LENGTH) {
          console.log(`  [SERIAL ${portPath}] 바코드 수신: ${barcode}`);
          handleBarcodeDetected(barcode);
        }
      });

      port.on('error', (err) => {
        console.error(`  [SERIAL ${portPath}] 오류:`, err.message);
      });

      port.on('close', () => {
        console.log(`  [SERIAL ${portPath}] 포트 닫힘`);
        delete serialPorts[portPath];
        sendSerialStatus();
      });

      port.open((err) => {
        if (err) {
          console.error(`  [SERIAL ${portPath}] 열기 실패 (${baudRate}):`, err.message);
          resolve(null);
        } else {
          console.log(`  [SERIAL ${portPath}] 연결됨 @ ${baudRate} baud`);
          resolve({ port, parser });
        }
      });
    } catch (err) {
      console.error(`  [SERIAL ${portPath}] 연결 오류:`, err.message);
      resolve(null);
    }
  });
}

async function connectOnePort(portPath) {
  if (serialPorts[portPath] && serialPorts[portPath].port && serialPorts[portPath].port.isOpen) {
    return true;
  }

  for (const baudRate of SERIAL_CONFIG.BAUD_RATES) {
    const result = await tryOpenPort(portPath, baudRate);
    if (result) {
      serialPorts[portPath] = result;
      sendSerialStatus();
      return true;
    }
  }
  return false;
}

function closeOnePort(portPath) {
  const entry = serialPorts[portPath];
  if (entry && entry.port && entry.port.isOpen) {
    try { entry.port.close(); } catch (e) { /* ignore */ }
  }
  delete serialPorts[portPath];
}

function closeAllSerialPorts() {
  for (const portPath of Object.keys(serialPorts)) {
    closeOnePort(portPath);
  }
}

async function autoDetectAndConnect() {
  try {
    const availablePorts = await SerialPort.list();
    const availablePaths = new Set(availablePorts.map(p => p.path));

    // 분리된 포트 정리
    for (const connectedPath of Object.keys(serialPorts)) {
      if (!availablePaths.has(connectedPath)) {
        console.log(`  [SERIAL ${connectedPath}] 장치 분리 감지`);
        closeOnePort(connectedPath);
        sendSerialStatus();
      }
    }

    // 새 CH340 포트 연결
    const ch340Ports = availablePorts.filter(isCH340Port);
    for (const p of ch340Ports) {
      if (!serialPorts[p.path]) {
        await connectOnePort(p.path);
      }
    }
  } catch (e) {
    // ignore
  }
}

function startSerialPolling() {
  autoDetectAndConnect();
  serialPollTimer = setInterval(() => autoDetectAndConnect(), SERIAL_CONFIG.POLL_INTERVAL_MS);
}

function stopSerialPolling() {
  if (serialPollTimer) {
    clearInterval(serialPollTimer);
    serialPollTimer = null;
  }
  closeAllSerialPorts();
}

// ========================================
// IPC Handlers
// ========================================

// IPC: 로그인
ipcMain.handle('login', async (event, { email, password }) => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  try {
    const response = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, message: data.error || '로그인 실패' };
    }
    const setCookie = response.headers.getSetCookie?.() || [];
    let sessionToken = null;
    for (const cookie of setCookie) {
      const match = cookie.match(/session-token=([^;]+)/);
      if (match) {
        sessionToken = match[1];
        break;
      }
    }
    if (sessionToken) {
      await session.defaultSession.cookies.set({
        url: serverUrl,
        name: 'session-token',
        value: sessionToken,
        path: '/',
      });
    }
    return { success: true, user: data.user, token: sessionToken };
  } catch (err) {
    return { success: false, message: '서버 연결 실패: ' + err.message };
  }
});

// IPC: 매장 목록 조회
ipcMain.handle('get-stores', async () => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  try {
    const { unauthorized, response } = await authenticatedFetch(`${serverUrl}/api/stores`);
    if (unauthorized) {
      return { success: false, code: 'UNAUTHORIZED', message: '세션이 만료되었습니다' };
    }
    if (!response.ok) {
      return { success: false, message: '매장 목록 조회 실패' };
    }
    const data = await response.json();
    return { success: true, stores: data.data || [], role: data.role || 'staff' };
  } catch (err) {
    return { success: false, message: '서버 연결 실패: ' + err.message };
  }
});

// IPC: 바코드 조회
ipcMain.handle('lookup-barcode', async (event, { barcode, storeId }) => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  try {
    const { unauthorized, response } = await authenticatedFetch(
      `${serverUrl}/api/inventory/barcode?barcode=${encodeURIComponent(barcode)}&storeId=${encodeURIComponent(storeId)}`
    );
    if (unauthorized) {
      return { success: false, code: 'UNAUTHORIZED', message: '세션이 만료되었습니다' };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, message: err.error || '조회 실패' };
    }
    const data = await response.json();
    return { success: true, item: data.item };
  } catch (err) {
    return { success: false, message: '서버 연결 실패: ' + err.message };
  }
});

// IPC: 재고 변경
ipcMain.handle('update-inventory', async (event, payload) => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  try {
    const { unauthorized, response } = await authenticatedFetch(`${serverUrl}/api/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (unauthorized) {
      return { success: false, code: 'UNAUTHORIZED', message: '세션이 만료되었습니다' };
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, message: err.error || '재고 변경 실패' };
    }
    const data = await response.json();
    return { success: true, ...data };
  } catch (err) {
    return { success: false, message: '서버 연결 실패: ' + err.message };
  }
});

// IPC: 화면 전환
ipcMain.on('navigate', (event, page) => {
  if (!mainWindow) return;
  // 크롤러 화면은 넓은 윈도우 필요
  if (page === 'crawler') {
    mainWindow.setSize(1200, 900);
    mainWindow.center();
  } else {
    const [w] = mainWindow.getSize();
    if (w > 800) {
      mainWindow.setSize(700, 750);
      mainWindow.center();
    }
  }
  const filePath = path.join(__dirname, 'renderer', `${page}.html`);
  mainWindow.loadFile(filePath);
});

// IPC: 설정 저장/조회
// IPC: 앱 버전
ipcMain.handle('get-app-version', () => app.getVersion());

// IPC: 로그인 정보 저장/불러오기 (30일 만료)
const SAVED_LOGIN_TTL = 30 * 24 * 60 * 60 * 1000; // 30일

ipcMain.handle('get-saved-login', () => {
  const s = initStore();
  const saved = s.get('savedLogin');
  if (!saved) return null;
  if (Date.now() - saved.savedAt > SAVED_LOGIN_TTL) {
    s.delete('savedLogin');
    return null;
  }
  return { email: saved.email, password: saved.password };
});

ipcMain.handle('save-login', (event, { email, password }) => {
  const s = initStore();
  s.set('savedLogin', { email, password, savedAt: Date.now() });
  return { success: true };
});

ipcMain.handle('clear-saved-login', () => {
  const s = initStore();
  s.delete('savedLogin');
  return { success: true };
});

ipcMain.handle('get-config', () => {
  const s = initStore();
  return {
    serverUrl: s.get('serverUrl'),
    lastStoreId: s.get('lastStoreId'),
    lastStoreName: s.get('lastStoreName'),
  };
});

ipcMain.handle('save-config', (event, config) => {
  const s = initStore();
  if (config.lastStoreId !== undefined) s.set('lastStoreId', config.lastStoreId);
  if (config.lastStoreName !== undefined) s.set('lastStoreName', config.lastStoreName);
  if (config.serverUrl !== undefined) s.set('serverUrl', config.serverUrl);
  return { success: true };
});

// IPC: 글로벌 키 리스너 상태
ipcMain.handle('get-key-listener-status', () => {
  return { active: keyListener !== null };
});

// IPC: 시리얼 포트 상태
ipcMain.handle('get-serial-status', () => {
  const connectedPorts = Object.keys(serialPorts).filter(p => serialPorts[p].port && serialPorts[p].port.isOpen);
  return {
    connected: connectedPorts.length > 0,
    ports: connectedPorts,
    count: connectedPorts.length,
  };
});

// IPC: 시리얼 포트 재연결
ipcMain.handle('serial-reconnect', async () => {
  closeAllSerialPorts();
  await autoDetectAndConnect();
  const connectedPorts = Object.keys(serialPorts);
  return {
    success: connectedPorts.length > 0,
    ports: connectedPorts,
    count: connectedPorts.length,
  };
});

// IPC: 시리얼 포트 목록
ipcMain.handle('list-serial-ports', async () => {
  try {
    const ports = await SerialPort.list();
    return { success: true, ports };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ========================================
// Crawler IPC Handlers
// ========================================

const crawlSiteNames = { baemin: '배달의민족', yogiyo: '요기요', coupangeats: '쿠팡이츠' };
const crawlStatusNames = {
  starting: '시작...',
  logging_in: '자동 로그인 중...',
  crawling: '데이터 추출 중...',
  manual_login_required: '하단 브라우저에서 직접 로그인하세요 (60초 대기)',
};

ipcMain.handle('trigger-crawl', async (_event, opts) => {
  if (!scheduler) return { error: 'Scheduler not initialized' };

  crawlResults = {};
  crawlErrors = [];

  try {
    const result = await scheduler.runBackfillAndDaily({
      source: 'manual',
      sites: opts.sites,
      credentials: opts.credentials,
      onStatus: (msg) => {
        const statusStr = typeof msg === 'object'
          ? `${crawlSiteNames[msg.site] || msg.site || ''} ${msg.page || ''} ${crawlStatusNames[msg.status] || msg.status || ''}`
          : String(msg);
        try { mainWindow.webContents.send('status', statusStr); } catch {}
        try { mainWindow.webContents.send('crawl-status', msg); } catch {}
        console.log('[crawler-status]', statusStr);
      },
      onResult: (data) => {
        console.log('[crawler] 결과 수신:', data.site, data.pageType);
        if (data.site) {
          if (!crawlResults[data.site]) crawlResults[data.site] = {};
          crawlResults[data.site][data.pageType || 'default'] = data;
        }
        try { mainWindow.webContents.send('crawl-result', data); } catch {}
      },
      onError: (data) => {
        crawlErrors.push(data);
        try { mainWindow.webContents.send('crawl-error', data); } catch {}
      },
      onComplete: (data) => {
        try {
          mainWindow.webContents.send('crawl-complete', {
            results: crawlResults,
            errors: crawlErrors,
            ...data,
          });
        } catch {}
        console.log('[crawler] 크롤링 완료');
      },
    });

    return result?.error ? { success: false, error: result.error } : { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-results', () => {
  return { results: crawlResults, errors: crawlErrors };
});

ipcMain.handle('get-crawl-credentials', async (event, storeId) => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  const sid = storeId || s.get('lastStoreId') || '';
  if (!sid) return null;
  try {
    const url = `${serverUrl}/api/suppliers/platform-accounts?storeId=${encodeURIComponent(sid)}&withCredentials=true`;
    const { unauthorized, response } = await authenticatedFetch(url);
    if (unauthorized) return null;
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[crawl-credentials] GET error:', err.error);
      return null;
    }
    const data = await response.json();
    // platform-accounts 응답을 { baemin: { id, pw }, ... } 형태로 변환
    const creds = {};
    (data.data || []).forEach((p) => {
      if (p.registered && p.loginId) {
        creds[p.platform] = { id: p.loginId, pw: p.loginPassword || '' };
      }
    });
    return creds;
  } catch (err) {
    console.error('[crawl-credentials] GET 실패:', err.message);
    return null;
  }
});

ipcMain.handle('save-crawl-credentials', async (event, credentials) => {
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  const sid = s.get('lastStoreId') || '';
  if (!sid) return { success: false, error: '매장이 선택되지 않았습니다' };
  try {
    const platforms = Object.keys(credentials);
    for (const platform of platforms) {
      const { id, pw } = credentials[platform];
      if (!id) continue;
      const { unauthorized, response } = await authenticatedFetch(
        `${serverUrl}/api/suppliers/platform-accounts`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storeId: sid,
            platform,
            loginId: id,
            loginPassword: pw || '',
          }),
        }
      );
      if (unauthorized) return { success: false, error: '세션 만료' };
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: err.error || `${platform} 저장 실패` };
      }
    }
    return { success: true };
  } catch (err) {
    console.error('[crawl-credentials] save 실패:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('clear-results', () => {
  crawlResults = {};
  crawlErrors = [];
  return { success: true };
});

// IPC: 수집 현황 (상태판) — 수집 대상 매장 × 플랫폼 × 날짜별 수집 성공 여부
// 수집 대상은 scripts/collect-stores.config.json 한 곳에서 관리(수집 스크립트와 동일 소스).
// 매장이 늘면 config 에만 추가하면 수집·보드 양쪽에 자동 반영. 분점 등 미대상 매장은 안 뜸.
ipcMain.handle('get-collection-status', async (_event, { startDate, endDate } = {}) => {
  const fs = require('fs');
  const s = initStore();
  const serverUrl = s.get('serverUrl');
  if (!serverUrl) return { success: false, message: '서버가 설정되지 않았습니다.' };
  if (!startDate || !endDate) return { success: false, message: 'startDate, endDate가 필요합니다.' };

  const DATE_PLATFORMS = ['baemin', 'yogiyo', 'coupangeats', 'ddangyoyo', 'okpos'];
  const PLATFORM_LABELS = { baemin: '배민', yogiyo: '요기요', coupangeats: '쿠팡이츠', ddangyoyo: '땡겨요', okpos: 'OKPOS' };

  // 수집 대상 매장 목록 (수집 스크립트와 공유하는 단일 소스)
  let targetStores = [];
  try {
    const cfgPath = path.join(__dirname, 'scripts', 'collect-stores.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    targetStores = (cfg.stores || []).filter((st) => st.storeId);
  } catch (err) {
    return { success: false, message: '수집 대상 설정을 읽지 못했습니다: ' + err.message };
  }

  let unauthorized = false;
  try {
    const result = await Promise.all(targetStores.map(async (store) => {
      const platforms = (store.platforms || []).filter((p) => DATE_PLATFORMS.includes(p));
      if (platforms.length === 0) return { storeId: store.storeId, name: store.name, platforms: [] };

      let syncedDates = {};
      try {
        const ssUrl = `${serverUrl}/api/stores/${encodeURIComponent(store.storeId)}/crawler/sync-status`
          + `?sources=${platforms.join(',')}&startDate=${startDate}&endDate=${endDate}`;
        const ssRes = await authenticatedFetch(ssUrl);
        if (ssRes.unauthorized) { unauthorized = true; }
        else if (ssRes.response.ok) {
          const ssData = await ssRes.response.json();
          syncedDates = ssData.syncedDates || {};
        }
      } catch (err) {
        console.error('[collection-status] sync-status 실패:', store.storeId, err.message);
      }

      return {
        storeId: store.storeId,
        name: store.name,
        platforms: platforms.map((p) => ({ platform: p, label: PLATFORM_LABELS[p] || p, dates: syncedDates[p] || [] })),
      };
    }));

    if (unauthorized) return { success: false, code: 'UNAUTHORIZED', message: '세션이 만료되었습니다.' };
    return { success: true, stores: result };
  } catch (err) {
    console.error('[collection-status] 오류:', err.message);
    return { success: false, message: '수집 현황 조회 실패: ' + err.message };
  }
});

// IPC: 스케줄러 상태 조회
ipcMain.handle('get-scheduler-status', () => {
  if (!scheduler) return { enabled: false };
  return scheduler.getStatus();
});

// IPC: 수동 백필 트리거
ipcMain.handle('trigger-backfill', async () => {
  if (!scheduler) return { success: false, error: '스케줄러 미초기화' };
  try {
    const result = await scheduler.runBackfillAndDaily({ source: 'manual' });
    return result?.error ? { success: false, error: result.error } : { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 크롤링 결과 JSON 파일 저장
ipcMain.handle('save-crawl-json', async (_event, data) => {
  const fs = require('fs');
  const savePath = path.join(__dirname, `crawl-result-${new Date().toISOString().slice(0, 10)}.json`);
  try {
    fs.writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf8');
    console.log('[crawler] JSON 저장:', savePath);
    return { success: true, path: savePath };
  } catch (err) {
    console.error('[crawler] JSON 저장 실패:', err.message);
    return { success: false, error: err.message };
  }
});

// IPC: 엑셀 내보내기
ipcMain.handle('export-excel', async (_event, data) => {
  const XLSX = require('xlsx');
  const { dialog } = require('electron');

  const SITE_NAMES = { baemin: '배민', yogiyo: '요기요', coupangeats: '쿠팡이츠', ddangyoyo: '땡겨요' };

  // 플랫폼별 주문 → 엑셀 행 변환
  function orderToRow(site, o) {
    if (site === 'baemin') {
      return {
        '주문일': o.orderedAt || '',
        '주문번호': o.orderId || '',
        '주문내역': o.menuSummary || '',
        '매출액': o.menuAmount || 0,
        '유형': o.channel || '',
        '결제': o.paymentMethod || '',
        '배달팁': o.deliveryTip || 0,
        '즉시할인': o.instantDiscount || 0,
        '중개이용료': o.commissionFee || 0,
        '결제수수료': o.pgFee || 0,
        '배달비': o.deliveryCost || 0,
        '부가세': o.vat || 0,
        '만나서결제': o.meetPayment || 0,
        '플랫폼할인': o.platformDiscount || 0,
        '정산예정': o.settlementAmount || 0,
        '정산일': o.settlementDate || '',
      };
    } else if (site === 'yogiyo') {
      return {
        '주문일': o.orderedAt || '',
        '주문번호': o.orderId || '',
        '주문내역': o.menuSummary || '',
        '매출액': o.menuAmount || 0,
        '유형': o.channel || '',
        '결제': o.paymentMethod || '',
        '배달비수입': o.deliveryIncome || 0,
        '중개이용료': o.commissionFee || 0,
        '결제수수료': o.pgFee || 0,
        '배달비': o.deliveryCost || 0,
        '광고비': o.adFee || 0,
        '부가세': o.vat || 0,
        '가게할인': o.storeDiscount || 0,
        '정산예정': o.settlementAmount || 0,
        '정산일': o.settlementDate || '',
      };
    } else if (site === 'coupangeats') {
      return {
        '주문일': o.orderedAt || '',
        '주문번호': o.orderId || '',
        '주문내역': o.menuSummary || '',
        '매출액': o.totalPayment || 0,
        '중개이용료': o.commissionFee || 0,
        '결제수수료': o.pgFee || 0,
        '배달비': o.deliveryCost || 0,
        '광고비': o.adFee || 0,
        '부가세': o.vat || 0,
        '가게할인': o.storeDiscount || 0,
        '즉시할인': o.instantDiscount || 0,
        '일회용컵': o.cupDeposit || 0,
        '우대수수료': o.favorableFee || 0,
        '정산예정': o.settlementAmount || 0,
        '정산일': o.settlementDate || '',
      };
    } else if (site === 'ddangyoyo') {
      return {
        '주문일': o.orderedAt || '',
        '주문번호': o.orderId || '',
        '주문내역': o.menuSummary || '',
        '매출액': o.menuAmount || 0,
        '유형': o.orderType || '',
        '정산예정': o.settlementAmount || 0,
      };
    }
    return { ...o };
  }

  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '엑셀 내보내기',
      defaultPath: `매출데이터_${new Date().toISOString().slice(0, 10)}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (!filePath) return { success: false, cancelled: true };

    const wb = XLSX.utils.book_new();
    const results = data.results || {};

    // 매장별로 데이터 수집: { shopName: [{ 플랫폼, ...orderRow }] }
    const shopMap = {};

    for (const [site, pages] of Object.entries(results)) {
      for (const [pageKey, pageData] of Object.entries(pages)) {
        if (pageKey === 'salesKeeper') continue;
        const siteName = SITE_NAMES[site] || site;

        // shops 배열이 있으면 매장별로 분리
        if (pageData.shops && pageData.shops.length > 0) {
          for (const shop of pageData.shops) {
            const shopName = shop.shopName || siteName;
            if (!shopMap[shopName]) shopMap[shopName] = [];
            (shop.orders || []).forEach(o => {
              shopMap[shopName].push({ '플랫폼': siteName, ...orderToRow(site, o) });
            });
          }
        } else {
          // 기존 호환: shops 없으면 플랫폼명을 매장명으로
          const orders = pageData.apiOrders || pageData.orders || [];
          if (orders.length === 0) continue;
          // 매장 구분 없으면 '전체'로 묶음
          const shopName = '전체';
          if (!shopMap[shopName]) shopMap[shopName] = [];
          orders.forEach(o => {
            shopMap[shopName].push({ '플랫폼': siteName, ...orderToRow(site, o) });
          });
        }
      }
    }

    // 시트 생성: 매장별 시트
    for (const [shopName, rows] of Object.entries(shopMap)) {
      if (rows.length === 0) continue;

      const ws = XLSX.utils.json_to_sheet(rows);

      // 컬럼 너비 자동 조절
      const colWidths = Object.keys(rows[0] || {}).map(key => {
        const maxLen = Math.max(key.length, ...rows.map(r => String(r[key] || '').length));
        return { wch: Math.min(Math.max(maxLen + 2, 8), 30) };
      });
      ws['!cols'] = colWidths;

      // 시트명은 31자 제한 (Excel 제한)
      const sheetName = shopName.substring(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    if (wb.SheetNames.length === 0) {
      return { success: false, error: '내보낼 데이터가 없습니다.' };
    }

    XLSX.writeFile(wb, filePath);
    console.log('[crawler] 엑셀 저장:', filePath);
    return { success: true, path: filePath };
  } catch (err) {
    console.error('[crawler] 엑셀 저장 실패:', err.message);
    return { success: false, error: err.message };
  }
});

// ========================================
// Window & App Lifecycle
// ========================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 750,
    resizable: true,
    show: false, // HTML 렌더 완료 후 show — 흰 화면 깜빡임 방지 + 오버레이 먼저 보이게
    title: '매출지킴이 바코드 스캐너',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));

  // F12로 개발자도구 토글
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  console.log('========================================');
  console.log('  매출지킴이 바코드 스캐너 v' + app.getVersion());
  console.log('========================================');

  createWindow();
  initGlobalKeyListener();
  startSerialPolling();

  // 자동 크롤링 스케줄러
  const schedulerStore = initStore();
  scheduler = new AutoCrawlScheduler({
    mainWindow,
    store: schedulerStore,
    authenticatedFetch,
    getCredentials: async (storeId) => {
      const s = initStore();
      const serverUrl = s.get('serverUrl');
      const sid = storeId || s.get('lastStoreId') || '';
      if (!sid) return null;
      try {
        const url = `${serverUrl}/api/suppliers/platform-accounts?storeId=${encodeURIComponent(sid)}&withCredentials=true`;
        const { unauthorized, response } = await authenticatedFetch(url);
        if (unauthorized) return null;
        if (!response.ok) return null;
        const data = await response.json();
        const creds = {};
        (data.data || []).forEach((p) => {
          if (p.registered && p.loginId) {
            creds[p.platform] = { id: p.loginId, pw: p.loginPassword || '' };
          }
        });
        return creds;
      } catch (err) {
        console.error('[scheduler] 계정 조회 실패:', err.message);
        return null;
      }
    },
  });
  scheduler.start();

  // ── Auto updater (강제 업데이트 — 사용자 개입 없음) ──
  // 앱 시작 즉시 업데이트 체크. 업데이트 있으면 자동 다운로드 → 자동 재시작.
  // 로그인 화면에 블로킹 오버레이("업데이트 확인 중...")가 떠서 사용자가 skip 불가.
  // 오버레이 제어는 renderer의 login.js에서 'update-status' IPC 이벤트로 처리.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  let updateResolved = false;
  function sendUpdateStatus(status, extra = {}) {
    // 'downloading'은 반복 전송(프로그레스), 나머지는 1회만
    if (status !== 'downloading' && updateResolved) return;
    if (status !== 'downloading') updateResolved = true;
    mainWindow?.webContents.send('update-status', { status, ...extra });
  }

  autoUpdater.on('update-available', (info) => {
    console.log('  [UPDATE] 업데이트 발견:', info.version);
    sendUpdateStatus('update-available', { version: info.version });
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-not-available', () => {
    console.log('  [UPDATE] 최신 버전');
    sendUpdateStatus('no-update');
  });

  autoUpdater.on('download-progress', (p) => {
    mainWindow?.webContents.send('update-status', {
      status: 'downloading',
      percent: Math.round(p.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[UPDATE] 다운로드 완료:', info.version);
    sendUpdateStatus('downloaded');
    // installer.nsh의 customInit 매크로가 taskkill로 앱을 강제 종료하므로
    // 여기서는 단순히 quitAndInstall만 호출하면 된다.
    setTimeout(() => {
      log.info('[UPDATE] quitAndInstall 호출');
      autoUpdater.quitAndInstall(true, true);
    }, 1500);
  });

  autoUpdater.on('error', (err) => {
    log.error('[UPDATE] 에러:', err.message);
    sendUpdateStatus('error');
  });

  // 즉시 체크 + 15초 네트워크 타임아웃 (GitHub CDN 느릴 때 대비)
  autoUpdater.checkForUpdates().catch(() => sendUpdateStatus('error'));
  setTimeout(() => sendUpdateStatus('timeout'), 15000);
});

app.on('window-all-closed', () => {
  if (scheduler) scheduler.stop();
  if (crawler) crawler.destroy();
  stopSerialPolling();
  try {
    if (keyListener) {
      keyListener.kill();
      keyListener = null;
    }
  } catch (e) {
    console.error('  [KEY] Listener 종료 오류:', e.message);
  }
  app.quit();
});

app.on('before-quit', () => {
  if (scheduler) scheduler.stop();
  if (crawler) crawler.destroy();
  stopSerialPolling();
  try {
    if (keyListener) {
      keyListener.kill();
      keyListener = null;
    }
  } catch (e) {
    console.error('  [KEY] Listener 종료 오류:', e.message);
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
