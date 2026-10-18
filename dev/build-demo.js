// 미리 보기(데모)판: 서버 대신 페이지 안에서 Core를 돌림. 연수·체험용
// 사용: node dev/build-demo.js  →  demo/index.html (bbonng.github.io/opencourt/demo/)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const src = R('src/app.html');
const style = src.match(/<style>[\s\S]*?<\/style>/)[0];
let body = src.match(/<body>([\s\S]*)<\/body>/)[1];
const css = style.replace('</style>', `
.demo{background:var(--ink);color:var(--paper);padding-block:10px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.demo-in{max-width:560px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;font-size:13px}
.demo b{font-weight:700;margin-right:2px}
.demo select{flex:1;min-width:150px;font-size:14px;padding:7px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--paper) 30%,transparent);background:transparent;color:var(--paper)}
.demo select option{color:#13201B;background:#fff}
.demo button{border:1px solid color-mix(in srgb,var(--paper) 30%,transparent);background:transparent;color:var(--paper);border-radius:999px;padding:7px 12px;font-size:13px;font-weight:500}
.demo button[data-armed]{background:var(--danger);border-color:var(--danger);color:#fff}
.demo p{flex-basis:100%;margin:0;opacity:.75;font-size:12.5px}
</style>`);
const bar = `<div class="demo" id="demo-bar"><div class="demo-in">
  <b>미리 보기</b>
  <label class="vh" for="demo-who">보는 사람</label>
  <select id="demo-who">
    <option value="김도윤">참가자 김도윤의 폰</option>
    <option value="이서연">참가자 이서연의 폰</option>
    <option value="host">호스트 이길봉의 폰</option>
    <option value="join">초대 링크를 처음 연 사람</option>
    <option value="home">새 모임 만들기 화면</option>
  </select>
  <button type="button" class="press" data-demo="others">다른 코트 결과 넣기</button>
  <button type="button" class="press" data-demo="reset">처음 상태로</button>
  <p>연수용 예시입니다. 실제 서버에 저장되지 않고 이 브라우저 안에서만 돌아갑니다. 사람을 바꿔 가며 같은 모임을 각자 폰에서 보는 화면을 확인하세요.</p>
</div></div>`;
body = body
  .replace('<a class="skip" href="#view">본문으로 건너뛰기</a>', '<a class="skip" href="#view">본문으로 건너뛰기</a>\n' + bar)
  .replace('<script>/*ENGINE*/</script>', () => `<script>${R('dev/demo-shim.js')}</script>\n<script>${R('src/engine.js')}</script>`)
  .replace('<script>/*CORE*/</script>', () => `<script>${R('src/core.js')}</script>`)
  .replace(/const API_URL = '[^']*';/, "const API_URL = 'demo://exec';")
  .replace("if ('serviceWorker' in navigator && !LOCAL)", "if (false)");
let out = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>오픈코트 · 예시</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#EDF1EE" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E1512" media="(prefers-color-scheme: dark)">
<link rel="icon" href="../icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=IBM+Plex+Sans+KR:wght@400;500;700&display=swap">
${css}
</head>
<body>${body}</body>
</html>
`;
// 실제 앱과 같은 주소(bbonng.github.io)라서 저장 칸 이름을 분리: 데모 기록이 실제 앱 '최근 모임'에 섞이지 않게
out = out.split("'oc:events'").join("'ocdemo:events'").split("'oc:dev'").join("'ocdemo:dev'");
fs.writeFileSync(path.join(root, 'demo/index.html'), out);
for (const [, js] of out.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(js);
console.log('demo built: demo/index.html', out.length, 'chars');
