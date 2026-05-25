# 사무실 윈도우 PC — 매장별 매출 자동 수집 세팅

무인 사무실 PC 가 **매일 정해진 시각에 본점 3곳의 전날 매출**을 자동 수집하도록 세팅하는 가이드.

- **수집(실행)**: 헤드리스 스크립트 `scripts/collect-stores.js` 가 매장을 **하나씩 순차**(매장마다 독립 자식 프로세스)로 돌림 → 절대 안 꼬임.
- **자동화**: Windows **작업 스케줄러**가 매일 1회 위 스크립트를 호출.
- **표시(대시보드)**: 다음 PR 에서 Electron 앱을 상태판으로 변경 예정. (이 문서 범위 아님)

대상 매장·플랫폼은 `scripts/collect-stores.config.json` 에 정의 — 유신본점(baemin·yogiyo), 월하화본점(baemin·okpos), 고기왕김치찜 정릉본점(baemin·yogiyo·coupangeats·ddangyoyo).

---

## ⚠️ 전제: "로그인된 채 화면 켜진 PC"

이 PC 는 순수 백그라운드(session 0) 서버가 **아니다**. 다음이 화면에 떠야 사람이/스크립트가 통과할 수 있다:

- **coupangeats**: `--show` 로 창을 띄워야 Akamai 봇감지를 회피.
- **baemin**: 세션 만료(약 30일) 시 reCAPTCHA 창이 떠서 사람이 한 번 클릭.

그래서 작업 스케줄러는 **"로그온한 사용자 세션(Interactive)"** 에서 실행하도록 등록한다. PC 설정:

1. **자동 로그인** 켜기 (`netplwiz` → "사용자 이름과 암호를 입력해야..." 체크 해제).
2. **절전/최대 절전 끄기**, **화면 잠금 해제** (제어판 → 전원 옵션 → 디스플레이/절전 "안 함").
3. 재부팅 후에도 자동 로그인되어 데스크톱이 떠 있는 상태 유지.

---

## 1. 사전 설치 (맨바닥 새 PC, 1회)

### 1-1. Node.js LTS
<https://nodejs.org> 에서 **LTS (x64)** 설치. 설치 후 새 PowerShell 에서 확인:

```powershell
node -v   # v20 이상
npm -v
```

### 1-2. Git
<https://git-scm.com/download/win> 설치 (기본 옵션). 또는 GitHub Desktop.

### 1-3. repo 클론
```powershell
cd $env:USERPROFILE\Desktop
git clone https://github.com/ApronLabs/barcode-scanner.git
cd barcode-scanner
```

### 1-4. 의존성 설치
```powershell
npm install
```

> **네이티브 모듈 빌드가 실패하면** (serialport / node-global-key-listener):
> 이 두 모듈은 **수집에는 쓰이지 않는다**(바코드 스캐너 GUI 전용). x64 윈도우면 보통 prebuilt
> 바이너리로 그냥 설치된다. 만약 컴파일 에러가 나면:
> - 빠른 길: 에러를 무시하고 `node_modules\electron` 과 `rebrowser-puppeteer-core` 만
>   제대로 깔렸는지 확인 후 진행 (수집은 electron + puppeteer 만 필요).
> - 정공법: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
>   의 "C++ build tools" + Python 설치 후 `npm install` 재시도.
> `npm run rebuild` (electron-rebuild) 는 **수집용으로는 불필요**.

---

## 2. 노심 계정 설정 (1회)

repo 루트에 `.env` 파일을 만들고 노심 로그인 계정을 넣는다. (이 파일은 `.gitignore` 처리되어 커밋 안 됨)

```dotenv
NOSIM_EMAIL=gtod8010@naver.com
NOSIM_PASSWORD=여기에_노심_비밀번호
```

- **플랫폼별 비밀번호(배민/요기요/…)는 적지 않는다.** 스크립트가 노심 API 에서 매번 복호화해 가져온다.
- 서버 주소를 바꾸려면 `NOSIM_SERVER_URL` 도 추가 가능 (기본 `https://no-sim.co.kr`).

---

## 3. 첫 수집 — 수동 1회 (baemin 세션 만들기)

baemin 은 첫 로그인 때 reCAPTCHA / "자동 로그인 유지" 체크를 **사람이 한 번** 통과해야
이후 약 30일 자동 로그인된다. 그래서 작업 등록 전에 **수동으로 한 번** 돌려 매장별 세션을 만든다.

```powershell
# 먼저 설정·로그인·계정조회만 점검 (electron 안 띄움)
node scripts\collect-stores.js --dry-run

# 실제 수집 1회 — 매장별 baemin 창이 뜨면 캡차/자동로그인 체크 직접 통과
node scripts\collect-stores.js
```

또는 `scripts\collect-now.cmd` 더블클릭(같은 동작 + 끝나면 멈춤).

- 매장별로 `~\.poc-baemin-session-<매장id앞8자리>` 세션 폴더가 생기며 30일 유지된다.
- coupangeats 창도 잠깐 떴다 사라진다(정상).

---

## 4. 작업 스케줄러 등록

**작업 2개**를 한 번에 등록 — `scripts\register-tasks.cmd` 더블클릭 (또는 cmd 실행):

| 작업 | 대상 | 주기 | skip |
|---|---|---|---|
| `NosimSalesCollect` | **어제** (백필/마무리) | 11:00~17:00, 30분 간격 | 이미 수집된 건 skip, 미수집만 재시도 |
| `NosimSalesCollectToday` | **오늘** (실시간) | 10:00~다음날 04:00, 30분 간격 | **skip 안 함** — 매번 재수집해 새 주문 흡수 (중복은 노심 upsert 가 방지) |

개별 등록/조정:
```powershell
# 어제 백필
powershell -ExecutionPolicy Bypass -File scripts\register-collect-task.ps1 -Time "11:00" -EveryMinutes 30 -ForHours 6
# 당일 실시간 (10:00부터 18시간 = 04:00 까지)
powershell -ExecutionPolicy Bypass -File scripts\register-collect-task.ps1 -TaskName "NosimSalesCollectToday" -ExtraArgs "--today" -Time "10:00" -EveryMinutes 30 -ForHours 18
```

- 매일 **11:00 부터 30분 간격으로 6시간(11~17시) 반복** 실행 (로그온 사용자 세션).
- **미수집 매장만 재시도**: 매 실행 때 `sync-status` 로 이미 수집된 매장×플랫폼은 skip,
  실패해 안 된 것만 (재)수집. 다 되면 이후 반복은 즉시 no-op(창도 안 뜸). → 11시 한 매장이
  캡차/네트워크로 실패해도 30분 뒤 그 매장만 자동 재시도.
- 작업 이름은 **`NosimSalesCollect`** (영문). PowerShell 5.1 이 BOM 없는 스크립트를 한글 코드페이지로 읽어 한글 작업이름이 깨지면 `0x8007007B` 로 등록 실패 → 이름은 ASCII 로 고정.
- PC 가 그 시각에 꺼져 있었으면 켜진 직후 자동 실행(`StartWhenAvailable`).
- 바로 테스트: `Start-ScheduledTask -TaskName "NosimSalesCollect"`
- 해제: `Unregister-ScheduledTask -TaskName "NosimSalesCollect" -Confirm:$false`

---

## 5. 확인 / 로그

- 실행 로그: repo 의 `collect-logs\collect-<날짜>.log` (매장·플랫폼별 결과 + 요약).
- 수집 결과는 노심에 적재되므로, 노심 매출 화면 또는 (다음 PR 의) 상태판에서 날짜별 확인.

---

## 운영 메모 / 사람 개입이 필요한 경우

| 증상 | 원인 | 조치 |
|---|---|---|
| baemin 창이 뜬 채 멈춤 | 세션 만료(~30일) → reCAPTCHA | 화면에서 직접 캡차/자동로그인 체크 통과 (1회) |
| coupangeats 실패 | 창이 안 떠서 Akamai 차단 | PC 가 로그온/화면 켜진 상태인지 확인 |
| 특정 플랫폼 "인증정보 없음" skip | 노심에 해당 매장 플랫폼 계정 미등록/만료 | 노심 앱에서 플랫폼 계정 재등록 |
| 전 매장 로그인 실패 | `.env` 의 노심 계정/비번 오류 | `.env` 확인, `--dry-run` 으로 점검 |

매장 추가/플랫폼 변경은 코드 수정 없이 `scripts/collect-stores.config.json` 만 편집하면 된다.
