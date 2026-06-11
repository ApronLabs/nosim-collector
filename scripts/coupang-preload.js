'use strict';
// 쿠팡 주문 API(/order/condition) 응답 가로채기 (preload — 페이지 스크립트보다 먼저 실행).
//
// 목적: 페이지가 "스스로"(사용자가 메뉴/조회/페이지넘김을 클릭했을 때) 쏘는 주문 XHR 의
// 응답을 window.__coupangCapture 에 모은다. UI-구동 수집(#3)에서 우리가 raw fetch 로 또
// 쏘지 않고, 사람 동작으로 발생한 자연 요청을 그대로 재사용하기 위함(클릭→XHR 인과 = 사람).
// 지금은 진단(--inspect-coupang)에서 "페이지가 자동조회를 하는지/응답 모양"을 확인하는 데 쓴다.
//
// contextIsolation:false 라 preload 와 페이지가 window 를 공유 → executeJavaScript 로 읽을 수 있다.
(function () {
  try {
    if (window.__coupangCaptureInstalled) return;
    window.__coupangCaptureInstalled = true;
    window.__coupangCapture = [];
    const push = (entry) => {
      try {
        window.__coupangCapture.push(entry);
        if (window.__coupangCapture.length > 50) window.__coupangCapture.shift();
      } catch (e) { /* noop */ }
    };
    const isOrderUrl = (u) => typeof u === 'string' && u.indexOf('/order/condition') !== -1;

    // fetch 후킹
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try {
          const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
          if (isOrderUrl(url)) {
            p.then((res) => {
              res.clone().json().then((j) => push({ via: 'fetch', ts: Date.now(), data: j })).catch(() => {});
            }).catch(() => {});
          }
        } catch (e) { /* noop */ }
        return p;
      };
    }

    // XMLHttpRequest 후킹 (axios 등 XHR 사용 대비)
    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__cpUrl = url || '';
      return OrigOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (isOrderUrl(this.__cpUrl)) {
          this.addEventListener('load', function () {
            try { push({ via: 'xhr', ts: Date.now(), data: JSON.parse(this.responseText) }); } catch (e) { /* noop */ }
          });
        }
      } catch (e) { /* noop */ }
      return OrigSend.apply(this, arguments);
    };
  } catch (e) { /* preload 실패가 페이지/수집을 막지 않는다 */ }
})();
