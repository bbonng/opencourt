// src/engine.js + src/core.js 를 서버(server/Code.gs)와 화면(index.html)에 하나로 묶는다
// 사용: node dev/build.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const engine = R('src/engine.js'), core = R('src/core.js');
const banner = '/* ====== 아래는 대진 엔진과 진행 로직입니다. 직접 고치지 말고 src/ 를 고친 뒤 node dev/build.js ====== */\n';
fs.writeFileSync(path.join(root, 'server/Code.gs'), R('server/glue.gs') + '\n\n' + banner + engine + '\n\n' + core + '\n');
const html = R('src/app.html').replace('/*ENGINE*/', () => engine).replace('/*CORE*/', () => core);
fs.writeFileSync(path.join(root, 'index.html'), html);
for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(js);
new Function(R('server/Code.gs'));
console.log('built: index.html', html.length, 'chars / server/Code.gs', R('server/Code.gs').length, 'chars');
