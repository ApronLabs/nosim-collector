# 노심 매출 수집기 (nosim-collector)

사무실 Windows PC에서 **배달 플랫폼 + POS 매출 데이터를 자동 수집해 노심으로 전송**하는 프로그램.

> 이 레포는 원래 바코드 스캐너(`barcode-scanner`)였으나, 현재 핵심 기능은 매출 수집이라 `nosim-collector`로 개명했다. 바코드 스캔 모드(입고/출고)는 레거시로 남아있다(아래 참고).

## 수집 대상

| 채널 | 플랫폼 |
|---|---|
| 배달 | 배민 · 쿠팡이츠 · 요기요 · 땡겨요 |
| POS | OKPOS |

수집한 주문·매출·메뉴 라인·수수료·정산 데이터를 노심 API(HTTPS public)로 전송한다. 매장 자격증명은 로컬에 저장하지 않고 노심 API에서 받아온다. 플랫폼 로그인 세션은 매장별로 `~/.poc-<platform>-session-<storeId8>`에 영속(앱 이름·설치 경로와 무관).

---

## 운영 (사무실 Windows PC)

`nosim.cmd` 더블클릭 → 콘솔 메뉴:

| 메뉴 | 동작 |
|---|---|
| **1) 배포** | 최신 코드 받기 (`git pull`, 의존성 바뀌면 `npm install`) |
| **2) 자동수집 켜기** | 30분마다 현재 영업일 자동 수집 (Windows 예약작업 등록) |
| **3) 자동수집 끄기** | 예약작업 해제 |
| **4) 지금 수집** | 현재 영업일 1회 수집 (테스트) |

- 자동수집은 Electron 앱이 아니라 **PowerShell 예약작업 → `node scripts/collect-stores.js`** 로 돈다.
- 배포(메뉴 1) 후 재시작 불필요 — 자동수집이 켜져 있으면 다음 30분 틱부터 새 코드로 수집한다.

### 새 PC 설치
```powershell
cd $env:USERPROFILE\Desktop
git clone https://github.com/ApronLabs/nosim-collector.git
cd nosim-collector
npm install
copy .env.example .env   # SERVER_URL 등 설정
```
상세: [docs/WINDOWS-AUTO-COLLECT.md](docs/WINDOWS-AUTO-COLLECT.md)

---

## 개발자용

### 로컬 실행
```bash
npm install
npm start            # Electron 앱 (바코드 스캐너 UI)
node scripts/collect-stores.js --help   # 수집기 직접 실행
```

### 빌드 / 릴리스 (Electron 인스톨러)
```bash
npm run build:win    # Windows .exe (dist/)
git tag v3.13.0 && git push origin v3.13.0   # → GitHub Actions 가 빌드+Release
```
앱 자동 업데이트는 GitHub Releases(`ApronLabs/nosim-collector`) 기반.

---

## 레거시: 바코드 스캐너 모드

Electron 앱(`npm start`)은 USB 바코드 스캐너 입력을 받아 노심 재고를 ±1 하는 기능도 갖고 있다(입고/출고 + TTS 음성). 현재 운영의 핵심은 아니며 매출 수집이 주 용도다.

- **입고**: 바코드 스캔 → 재고 +1
- **출고**: `-` 접두사 바코드 스캔 → 재고 -1
- 미등록 바코드는 노심 웹에서 품목에 바코드를 먼저 등록해야 인식된다.
