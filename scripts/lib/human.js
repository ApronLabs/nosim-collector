'use strict';
// 사람 같은 상호작용 헬퍼 — Akamai 행동센서의 "기계적" 오탐을 줄이기 위한 것.
//
// 철학: Akamai 를 "뚫는"(센서/_abck 스푸핑) 게 아니라, 가맹점 본인 세션에서 도는
// 정당 자동화가 사람과 통계적으로 구분되지 않게 타이밍·입력·지문 일관성에 자연스러운
// 분산을 준다. 안티봇은 오탐이 실사용자 전환율을 죽이므로 임계를 보수적으로 잡는다 —
// 사람과 구분 안 되는 트래픽은 차단 대상이 아니다. (reference_akamai_detection_sustainable_path)
//
// 여기 함수들은 전부 순수 — electron 없이 단위테스트 가능 (human.test.js).

/** [min, max) 정수 난수. */
function rnd(min, max) {
  if (max <= min) return Math.floor(min);
  return Math.floor(min + Math.random() * (max - min));
}

/** base(ms) 를 중심으로 ±pct(0~1) 흔든 정수. 최소 0. 고정 sleep 의 기계적 등간격 제거용. */
function jitter(base, pct = 0.2) {
  const span = base * pct;
  return Math.max(0, Math.round(base - span + Math.random() * span * 2));
}

/**
 * 실행 환경에 일관된 깨끗한 Chrome UA 생성.
 *
 * 기존 워커는 Windows 수집 PC 에서도 Mac UA 를 하드코딩해 navigator.platform(Win32)
 * 과 불일치 → 그 자체가 디바이스 일관성 위반(봇신호)이었다. 실제 OS + 실제 Chromium
 * 메이저 버전으로 맞춰 불일치 오탐을 없앤다. (스푸핑이 아니라 "있는 그대로"로 정렬)
 *
 * Chrome UA 관례상 마이너는 0.0.0 으로 고정 표기되므로 메이저만 실버전을 쓴다.
 * 실버전 사용은 2026 Akamai 의 "Chrome 131 주장인데 PQ 키 없음" 류 버전-지문 불일치도 피한다.
 */
function buildUserAgent(platform, chromeVersion) {
  const major = String(chromeVersion || '').split('.')[0];
  const ver = (major && /^\d+$/.test(major) ? major : '120') + '.0.0.0';
  let osPart;
  if (platform === 'win32') osPart = 'Windows NT 10.0; Win64; x64';
  else if (platform === 'darwin') osPart = 'Macintosh; Intel Mac OS X 10_15_7';
  else osPart = 'X11; Linux x86_64';
  return `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
}

/**
 * 사람 타이핑 글자별 지연(ms) 시퀀스 — 길이만큼. 각 70~190ms, 가끔(8%) 더 긴 망설임.
 * 0ms 간격 연타(초인적 속도)는 강한 봇신호라 자동입력 시 이 분포로 친다.
 */
function typingDelays(len, randomFn = Math.random) {
  const out = [];
  for (let i = 0; i < len; i++) {
    let d = 70 + Math.floor(randomFn() * 120); // 70~190
    if (randomFn() < 0.08) d += 150 + Math.floor(randomFn() * 250); // 가끔 멈칫
    out.push(d);
  }
  return out;
}

module.exports = { rnd, jitter, buildUserAgent, typingDelays };
