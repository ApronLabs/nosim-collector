const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),
  getStores: () => ipcRenderer.invoke('get-stores'),
  lookupBarcode: (barcode, storeId) => ipcRenderer.invoke('lookup-barcode', { barcode, storeId }),
  updateInventory: (data) => ipcRenderer.invoke('update-inventory', data),
  navigate: (page) => ipcRenderer.send('navigate', page),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getKeyListenerStatus: () => ipcRenderer.invoke('get-key-listener-status'),
  getSerialStatus: () => ipcRenderer.invoke('get-serial-status'),
  serialReconnect: () => ipcRenderer.invoke('serial-reconnect'),
  listSerialPorts: () => ipcRenderer.invoke('list-serial-ports'),
  onBarcodeScanned: (callback) => ipcRenderer.on('barcode-scanned', (_, barcode) => callback(barcode)),
  onSerialStatus: (callback) => ipcRenderer.on('serial-status', (_, status) => callback(status)),
  onSessionExpired: (callback) => ipcRenderer.on('session-expired', () => callback()),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, data) => callback(data)),
  getSavedLogin: () => ipcRenderer.invoke('get-saved-login'),
  saveLogin: (email, password) => ipcRenderer.invoke('save-login', { email, password }),
  clearSavedLogin: () => ipcRenderer.invoke('clear-saved-login'),
});

// 크롤러 API
contextBridge.exposeInMainWorld('crawler', {
  triggerCrawl: (opts) => ipcRenderer.invoke('trigger-crawl', opts),
  getResults: () => ipcRenderer.invoke('get-results'),
  clearResults: () => ipcRenderer.invoke('clear-results'),
  getCredentials: (storeId) => ipcRenderer.invoke('get-crawl-credentials', storeId),
  saveCredentials: (creds) => ipcRenderer.invoke('save-crawl-credentials', creds),
  onStatus: (callback) => ipcRenderer.on('status', (_, msg) => callback(msg)),
  onCrawlStatus: (callback) => ipcRenderer.on('crawl-status', (_, data) => callback(data)),
  onCrawlResult: (callback) => ipcRenderer.on('crawl-result', (_, data) => callback(data)),
  onCrawlError: (callback) => ipcRenderer.on('crawl-error', (_, data) => callback(data)),
  onCrawlComplete: (callback) => ipcRenderer.on('crawl-complete', (_, data) => callback(data)),
  saveCrawlJson: (data) => ipcRenderer.invoke('save-crawl-json', data),
  exportExcel: (data) => ipcRenderer.invoke('export-excel', data),
  getSchedulerStatus: () => ipcRenderer.invoke('get-scheduler-status'),
  triggerBackfill: () => ipcRenderer.invoke('trigger-backfill'),
  onSchedulerUpdate: (callback) => ipcRenderer.on('scheduler-update', (_, data) => callback(data)),
  // 수집 현황 상태판: 수집 대상 매장(config) × 플랫폼 × 날짜별 수집 성공 여부
  getCollectionStatus: (range) => ipcRenderer.invoke('get-collection-status', range),
});
