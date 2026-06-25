/**
 * OKPOS 디스커버리 워커 — "상품관리(메뉴판)" 프로그램 구조 발견용 (읽기 전용).
 *
 * 왜: 자동소진 카탈로그를 "판매 파생"이 아니라 "등록 메뉴판 전체"에서 끌어오려면
 *     OKPOS 상품/메뉴 관리 프로그램의 URL·필드를 알아야 한다. 그게 매장마다 AL(프로그램 목록)에
 *     어떤 PGM_LCLS_NM/PGM_MCLS_NM/PGM_NM 로 들어있는지 한 번 찍어보는 스크립트.
 *
 * 하는 일(데이터 변경 0):
 *   1) 로그인(poc-okpos.js 와 동일 흐름) → 팝업 처리 → MenuVFrm 의 AL 획득
 *   2) AL 전체(프로그램 트리)를 로그/콘솔로 덤프
 *   3) 상품/메뉴/품목 키워드로 "메뉴판 후보" 프로그램을 추려서 강조
 *   → 이 출력(poc-okpos-discover-log.txt)을 개발(상윤)에게 주면 실제 메뉴판 크롤을 완성.
 *
 * 실행(크롤러 PC, OKPOS 로그인):
 *   npx electron scripts/poc-okpos-discover.js --id=아이디 --pw=비밀번호 [--show]
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

function getArg(name) {
  const a = process.argv.find((a) => a.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : '';
}
const config = { id: getArg('id'), pw: getArg('pw') };
const SHOW = process.argv.includes('--show');
const LOGIN_URL = 'https://nice.okpos.co.kr/';
const LOG_FILE = path.join(__dirname, 'poc-okpos-discover-log.txt');

function emit(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}
function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  if (SHOW) process.stdout.write(line + '\n');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  fs.appendFileSync(LOG_FILE, `[FATAL] ${err.message}\n`);
  emit('error', { error: err.message });
});

function findFrameByName(win, name) {
  for (const f of win.webContents.mainFrame.framesInSubtree) {
    if (f.name === name) return f;
  }
  return null;
}
async function exec(frame, script, label) {
  try {
    return await frame.executeJavaScript(script);
  } catch (err) {
    log(`[${label}] 실패: ${err.message}`);
    return null;
  }
}

// 메뉴판(상품관리) 후보로 볼 키워드 — 대/중/소분류 어디든 걸리면 후보.
const MENU_KEYWORDS = ['상품', '메뉴', '품목', '단품', '메뉴판', '상품관리', '품목관리', '메뉴관리', 'PROD'];

app.whenReady().then(async () => {
  fs.writeFileSync(LOG_FILE, '');
  if (!config.id || !config.pw) {
    emit('error', { error: '--id=ID --pw=PW 필요' });
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: SHOW,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  try {
    // ━━━ 1. 로그인 ━━━
    emit('status', { msg: 'OKPOS 로그인 중...' });
    log('\n[1] 로그인...');
    await win.loadURL(LOGIN_URL);
    await sleep(2000);
    await exec(
      win.webContents.mainFrame,
      `
      (function() {
        var id = document.getElementById('user_id');
        var pw = document.getElementById('user_pwd');
        if (!id || !pw) return 'NOT_FOUND';
        id.value = '${config.id}'; pw.value = '${config.pw}';
        id.closest('form')?.submit();
        return 'OK';
      })()
    `,
      'login',
    ).then((r) => log(`  ${r}`));

    let loggedIn = false;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      if (win.webContents.getURL().includes('top_frame')) {
        log('  로그인 성공');
        loggedIn = true;
        break;
      }
    }
    if (!loggedIn) {
      emit('error', { error: '로그인 실패 (id/pw 확인)' });
      app.quit();
      return;
    }
    await sleep(2000);

    // ━━━ 2. 팝업(약관 동의) 처리 ━━━
    log('\n[2] 팝업...');
    const popup = findFrameByName(win, 'divPopupFrame0');
    if (popup && popup.url.includes('agreement')) {
      await exec(
        popup,
        `
        (function() {
          document.querySelectorAll('input[type="checkbox"]').forEach(function(c) { c.checked = true; });
          var btns = document.querySelectorAll('button, input[type="button"], a, [onclick]');
          for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            var t = (b.textContent || b.value || '').trim();
            var oc = b.getAttribute('onclick') || '';
            if (t.indexOf('동의') >= 0 || t.indexOf('확인') >= 0 || oc.indexOf('fnAgreement') >= 0) { b.click(); return t; }
          }
          return 'no btn';
        })()
      `,
        'popup',
      ).then((r) => log(`  ${r}`));
      await sleep(1500);
    }

    // ━━━ 3. AL(프로그램 목록) 덤프 ━━━
    emit('status', { msg: '프로그램 목록(AL) 조회 중...' });
    log('\n[3] 프로그램 목록(AL) 덤프...');
    const menuFrame = findFrameByName(win, 'MenuVFrm');
    if (!menuFrame) {
      emit('error', { error: 'MenuVFrm 프레임 미발견 (로그인 직후 화면 구조 변경?)' });
      app.quit();
      return;
    }
    const alJson = await exec(
      menuFrame,
      `
      (function() {
        if (typeof AL === 'undefined') return JSON.stringify({ error: 'NO_AL' });
        return JSON.stringify(AL.map(function(it) {
          return {
            lcls: it.PGM_LCLS_NM, mcls: it.PGM_MCLS_NM, pgm: it.PGM_NM,
            file: it.PGM_FILE_NM, code: it.PGM_CD || it.PGM_ID || null
          };
        }));
      })()
    `,
      'AL',
    );
    const parsed = JSON.parse(alJson || '{"error":"EXEC_FAILED"}');
    if (parsed.error) {
      emit('error', { error: `AL 조회 실패: ${parsed.error}` });
      app.quit();
      return;
    }

    const all = parsed;
    log(`\n[전체 프로그램 ${all.length}개]`);
    for (const p of all) {
      log(`  ${p.lcls} > ${p.mcls} > ${p.pgm}   [file=${p.file}]`);
    }

    // ━━━ 4. 메뉴판(상품관리) 후보 추림 ━━━
    const candidates = all.filter((p) => {
      const hay = `${p.lcls} ${p.mcls} ${p.pgm}`;
      return MENU_KEYWORDS.some((k) => hay.includes(k));
    });
    log(`\n========================================`);
    log(`★ 메뉴판/상품 후보 ${candidates.length}개 (이걸 개발에게 전달):`);
    for (const p of candidates) {
      log(`  ◆ ${p.lcls} > ${p.mcls} > ${p.pgm}   [file=${p.file}]`);
    }
    log(`========================================`);
    log(`\n로그 파일: ${LOG_FILE}`);
    log(`이 파일 전체를 개발(상윤)에게 주면 메뉴판 크롤을 완성합니다.`);

    emit('done', {
      totalPrograms: all.length,
      candidateCount: candidates.length,
      candidates,
      logFile: LOG_FILE,
    });
  } catch (err) {
    log(`[ERROR] ${err.message}`);
    emit('error', { error: err.message });
  } finally {
    await sleep(1000);
    app.quit();
  }
});
