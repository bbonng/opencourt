// 앱스크립트 흉내 서버: 실제 server/Code.gs 를 그대로 불러와 SpreadsheetApp 등만 가짜로 바꿔 실행한다.
// 화면 파일(app/)도 같이 서빙. 사용: node dev/mock.js [port]
const fs = require('fs'), path = require('path'), http = require('http'), vm = require('vm'), crypto = require('crypto');
const PORT = +process.argv[2] || 8787;
const LATENCY = +(process.env.LATENCY || 250); // 앱스크립트 응답 지연 흉내 (ms)

// ---- 가짜 구글 서비스 ----
function makeSheet(name) {
  const rows = [];
  const sheet = {
    name, rows,
    getLastRow: () => rows.length,
    appendRow: (r) => { rows.push(r.slice()); },
    setFrozenRows: () => {},
    deleteRow: (r) => { rows.splice(r - 1, 1); },
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValue: () => (rows[r - 1] || [])[c - 1] ?? '',
      setValue: (v) => { rows[r - 1] = rows[r - 1] || []; rows[r - 1][c - 1] = v; },
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues: (vals) => vals.forEach((row, i) => row.forEach((v, j) => { rows[r - 1 + i] = rows[r - 1 + i] || []; rows[r - 1 + i][c - 1 + j] = v; })),
      createTextFinder: (text) => ({
        matchEntireCell: () => ({
          findNext: () => {
            for (let i = 0; i < nr; i++) if (String((rows[r - 1 + i] || [])[c - 1]) === text) return { getRow: () => r + i };
            return null;
          },
        }),
      }),
    }),
  };
  return sheet;
}
const sheets = {};
const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };
const cacheStore = new Map();
const services = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  CacheService: { getScriptCache: () => ({ get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null), put: (k, v) => cacheStore.set(k, String(v)), remove: (k) => cacheStore.delete(k) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
  Utilities: { getUuid: () => crypto.randomUUID() },
  console,
};
const code = fs.readFileSync(path.join(__dirname, '../server/Code.gs'), 'utf8');
const ctx = vm.createContext(Object.assign({}, services));
vm.runInContext(code, ctx, { filename: 'Code.gs' });
ctx.setup();

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
let queue = Promise.resolve(); // 앱스크립트 잠금처럼 한 번에 하나씩
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (u.pathname === '/exec') {
    const send = (out) => setTimeout(() => { res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(out.s); }, LATENCY);
    if (req.method === 'GET') return send(ctx.doGet({ parameter: Object.fromEntries(u.searchParams) }));
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { queue = queue.then(() => send(ctx.doPost({ postData: { contents: body } }))); });
    return;
  }
  if (u.pathname === '/__sheets') { res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors)); return res.end(JSON.stringify(Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, v.rows])))); }
  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  const f = path.join(__dirname, '..', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }, cors));
    res.end(data);
  });
}).listen(PORT, () => console.log(`mock on http://localhost:${PORT}/?api=http://localhost:${PORT}/exec`));
