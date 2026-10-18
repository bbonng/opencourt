# 오픈코트

친선 복식 경기(피클볼·배드민턴) 대진표 PWA.
초대 링크로 참석 응답을 받고, 경기가 시작되면 각자 폰에 내 코트와 짝이 뜨며, 결과는 뛴 사람이 직접 넣습니다.

- 앱 주소: https://bbonng.github.io/opencourt/
- 서버: Google Apps Script (`server/Code.gs`)

## 흐름

초대 링크 → 이름·실력(급수/DUPR) 입력 후 참석·불참 → 호스트가 대진 짜기 → 경기 시작 → 비는 코트에 다음 경기 자동 배정 → 경기가 끝나면 4명 중 아무나 결과 입력 → 호스트가 경기 종료 → 1·2·3등, 시트 `경기 기록` 탭에 결과 저장

## 폴더

| 경로 | 내용 |
|---|---|
| `index.html` | 실제 앱 (빌드 결과, 직접 고치지 않음) |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | PWA 설치용 |
| `src/app.html` | 화면 원본 |
| `src/engine.js` | 대진 엔진 (짝 중복 최소, 경기 수 균등, 실력 균형) |
| `src/core.js` | 진행 로직 (참석, 대진, 자동 코트 배정, 결과, 순위) — 서버와 화면이 같이 씀 |
| `server/glue.gs` | 앱스크립트 서버 원본 (시트 저장, 잠금, 캐시) |
| `server/Code.gs` | 앱스크립트에 붙여 넣는 파일 (빌드 결과) |
| `dev/` | 빌드, 테스트, 모의 서버 |

## 고칠 때

```bash
# src/ 또는 server/glue.gs 를 고친 뒤
node dev/build.js        # index.html, server/Code.gs 다시 만들기
node dev/core.test.js    # 진행 로직 검증
node dev/mock.js         # 실제 Code.gs로 도는 모의 서버
# → http://localhost:8787/?api=http://localhost:8787/exec
```

`server/Code.gs`가 바뀌었으면 앱스크립트에 다시 붙여 넣고 **배포 → 배포 관리 → 수정 → 새 버전**으로 재배포합니다. 웹 앱 주소는 그대로 유지됩니다.

## 서버 처음 설치

1. 새 구글 시트 → **확장 프로그램 → Apps Script**
2. `server/Code.gs` 전체를 붙여 넣고 저장 → `setup` 함수 한 번 실행
3. **배포 → 새 배포 → 웹 앱** (실행: 나, 액세스: 모든 사용자)
4. 웹 앱 주소를 `src/app.html`의 `API_URL`에 넣고 `node dev/build.js`
