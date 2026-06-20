const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 디버깅용 로그 파일 (앱 실행 디렉토리에 poc-runner.log)
const LOG_FILE = path.join(os.homedir(), 'poc-runner.log');
function log(msg) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch {}
}

class PocRunner {
  constructor(platform, callbacks = {}) {
    this.platform = platform;
    this.onStatus = callbacks.onStatus || (() => {});
    this.onResult = callbacks.onResult || (() => {});
    this.onError = callbacks.onError || (() => {});
    this.child = null;
    this._tmpDir = null;
  }

  async run(id, pw, options = {}) {
    const isPackaged = __dirname.includes('app.asar');
    const electronPath = isPackaged ? process.execPath : this._getElectronPath();
    const scriptPath = path.join(__dirname, `poc-${this.platform}.js`);

    // 세션 격리: 크롤러별 user-data-dir
    // sikbom: 네이버 OAuth 로그인이 필요해 매 실행 로그인하면 캡차/기기등록에 막힘.
    // baemin: ncapture 보안 화면 도입으로 자동 로그인 불가, 자동로그인 체크박스로
    //   한 달 세션 유지가 의도된 정상 흐름인데 매번 임시 dir 이라 매일 로그인 필요했음.
    // 둘 다 전용 stable 디렉토리 (~/.poc-<platform>-session) 로 쿠키/세션 지속.
    // 다른 플랫폼은 자체 자동 로그인 스크립트가 있어 매번 fresh 임시 dir 로 격리.
    //
    // options.userDataDir: 호출자가 user-data-dir 을 직접 지정 (멀티매장 수집기용).
    //   한 PC 에서 여러 매장의 baemin 을 돌릴 때 매장별 dir 로 격리해야 함 —
    //   공유 시 첫 매장 세션이 재사용돼 잘못된 shopId 반환(2026-05-16 발견).
    //   외부 지정 dir 은 항상 보존(삭제 X) 한다.
    this._useStableDir = ['sikbom', 'baemin'].includes(this.platform);
    if (options.userDataDir) {
      this._tmpDir = options.userDataDir;
      this._useStableDir = true;
    } else if (this._useStableDir) {
      this._tmpDir = path.join(os.homedir(), `.poc-${this.platform}-session`);
    } else {
      this._tmpDir = path.join(os.tmpdir(), `poc-${this.platform}-${Date.now()}`);
    }
    fs.mkdirSync(this._tmpDir, { recursive: true });

    const args = [
      `--user-data-dir=${this._tmpDir}`,
    ];
    // 패키징 모드: exe가 --poc-script 플래그로 poc 스크립트 라우팅
    // 개발 모드: electron에 스크립트 경로 직접 전달
    if (isPackaged) {
      args.push(`--poc-script=${this.platform}`);
    } else {
      args.push(scriptPath);
    }
    args.push(
      `--id=${id}`,
      `--pw=${pw}`,
      `--mode=${options.mode || 'daily'}`,
    );
    if (options.targetDate) args.push(`--targetDate=${options.targetDate}`);
    // 정산·수수료 후행 채움(배민/요기요/땡겨요): daily 모드에서 최근 N일을 한 세션에서
    // 재수집해 정산을 backfill. 단일 로그인이라 추가 부하 없음. 1(기본)=당일만=기존 동작.
    if (options.recollectDays && options.recollectDays > 1) {
      args.push(`--recollectDays=${options.recollectDays}`);
    }
    if (options.salesKeeper) {
      args.push(`--storeId=${options.salesKeeper.salesKeeperStoreId}`);
      args.push(`--serverUrl=${options.salesKeeper.apiBaseUrl}`);
      args.push(`--sessionToken=${options.salesKeeper.sessionToken}`);
    }
    // sikbom: 스케줄러가 생성한 runId를 전달해서 trace 연속성 확보
    if (options.sikbomRunId) {
      args.push(`--runId=${options.sikbomRunId}`);
    }
    // coupangeats: Akamai 봇감지 회피 위해 창을 띄워야 함(--show). 호출자가 옵션으로 지시.
    if (options.show) {
      args.push('--show');
    }
    // coupangeats 진단: 주문페이지 DOM/자체 XHR 덤프 (UI-구동 수집 설계용)
    if (options.inspect) {
      args.push('--inspect-coupang');
    }
    // coupangeats UI-구동 수집: 페이지 자체 XHR 캡처 + 실제 '다음' 클릭
    if (options.uiDrive) {
      args.push('--ui-drive');
    }
    // coupangeats 자동 로그인: 세션 만료 시 사람 같은 타이핑으로 1회 자동 로그인
    if (options.autoLogin) {
      args.push('--auto-login');
    }
    // coupangeats 로그인화면 DOM 수집(임시 세션): 로그인 페이지 체크박스 구조 덤프
    if (options.inspectLogin) {
      args.push('--inspect-login');
    }

    log(`spawn: ${electronPath}`);
    log(`args: ${JSON.stringify(args)}`);
    log(`isPackaged: ${isPackaged}`);

    return new Promise((resolve, reject) => {
      this.child = spawn(electronPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });

      this.child.on('error', (err) => {
        log(`spawn error: ${err.message}`);
      });

      let resultData = null;
      let buffer = '';

      this.child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 마지막 불완전 라인 보존

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            switch (msg.type) {
              case 'status':
                this.onStatus({ site: this.platform, ...msg });
                break;
              case 'result':
                resultData = msg;
                this.onResult({ site: this.platform, ...msg });
                break;
              case 'error':
                this.onError({ site: this.platform, ...msg });
                break;
            }
          } catch {} // JSON 아닌 일반 로그는 무시
        }
      });

      this.child.stderr.on('data', (data) => {
        log(`[${this.platform}:stderr] ${data.toString().trim()}`);
      });

      this.child.on('exit', (code) => {
        log(`[${this.platform}] exit code: ${code}`);
        this._cleanup();
        if (code === 0) resolve(resultData);
        else reject(new Error(`${this.platform} POC 종료 (code ${code})`));
      });
    });
  }

  _cleanup() {
    if (this._tmpDir) {
      // stable 디렉토리는 삭제하지 않음 (세션 지속)
      if (!this._useStableDir) {
        try { fs.rmSync(this._tmpDir, { recursive: true, force: true }); } catch {}
      }
      this._tmpDir = null;
    }
  }

  destroy() {
    if (this.child && !this.child.killed) this.child.kill();
    this._cleanup();
  }

  _getElectronPath() {
    const baseDist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
    switch (process.platform) {
      case 'darwin':
        return path.join(baseDist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
      case 'win32':
        return path.join(baseDist, 'electron.exe');
      case 'linux':
        return path.join(baseDist, 'electron');
      default:
        return path.join(baseDist, 'electron');
    }
  }
}

module.exports = PocRunner;
