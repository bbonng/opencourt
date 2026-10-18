/* ================================================================
 * 오픈코트 서버 (Google Apps Script)
 *
 * 설치
 *  1) 새 구글 시트를 만들고 [확장 프로그램 → Apps Script] 를 연다
 *  2) Code.gs 내용을 모두 지우고 이 파일 전체를 붙여 넣고 저장
 *  3) 함수 목록에서 setup 을 한 번 실행 (권한 허용) → '모임', '경기 기록' 시트가 생김
 *  4) [배포 → 새 배포 → 웹 앱]  실행: 나 / 액세스 권한: 모든 사용자 → 배포
 *  5) 나온 웹 앱 URL(…/exec)을 앱의 index.html 맨 위 API_URL 에 넣는다
 * ================================================================ */

var SHEET_EVENTS = '모임';
var SHEET_RESULTS = '경기 기록';
var CACHE_TTL = 21600; // 6시간 (최대값)

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ev = ss.getSheetByName(SHEET_EVENTS) || ss.insertSheet(SHEET_EVENTS);
  if (ev.getLastRow() === 0) {
    ev.appendRow(['모임ID', '제목', '종목', '날짜', '장소', '상태', '참석', '수정 시각', '데이터']);
    ev.setFrozenRows(1);
  }
  var rs = ss.getSheetByName(SHEET_RESULTS) || ss.insertSheet(SHEET_RESULTS);
  if (rs.getLastRow() === 0) {
    rs.appendRow(['모임ID', '모임', '날짜', '라운드', '코트', '팀 A', '팀 B', 'A 점수', 'B 점수', '이긴 팀', '입력', '입력 시각']);
    rs.setFrozenRows(1);
  }
  return '준비 완료';
}

// ---------- HTTP ----------
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.a === 'state') return out_(readState_(p.e, p.k, p.v));
    return out_({ ok: true, name: '오픈코트 서버', time: new Date().toISOString() });
  } catch (err) {
    return out_({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.a === 'create') return out_(withLock_(function () { return create_(body); }));
    if (body.a === 'act') return out_(withLock_(function () { return act_(body); }));
    return out_({ error: '알 수 없는 요청입니다.' });
  } catch (err) {
    return out_({ error: String(err && err.message || err) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: '동시에 입력이 몰렸습니다. 잠시 후 다시 눌러 주세요.' };
  try { return fn(); } finally { lock.releaseLock(); }
}

function ctx_(isHost, dev) {
  return {
    now: Date.now(), isHost: !!isHost, dev: String(dev || '').slice(0, 40),
    id: function (n) { return Utilities.getUuid().replace(/-/g, '').slice(0, n || 8); },
  };
}

// ---------- 동작 ----------
function create_(body) {
  var s = Core.newEvent(body.event || {}, ctx_(true, body.dev));
  save_(s, true);
  return { ok: true, id: s.id, hostKey: s.hostKey, v: s.v, state: Core.publicState(s, true) };
}

function act_(body) {
  var s = load_(body.e);
  if (!s) return { error: '모임을 찾을 수 없습니다. 링크를 다시 확인해 주세요.' };
  var isHost = !!body.k && body.k === s.hostKey;
  var before = s.phase;
  var r = Core.apply(s, body.action || {}, ctx_(isHost, body.dev)) || {};
  if (r.error) return { error: r.error, v: s.v };
  save_(s, false);
  if (s.phase === 'done' && before !== 'done') writeResults_(s);
  return { ok: true, result: r, v: s.v, state: Core.publicState(s, isHost) };
}

function readState_(id, key, knownV) {
  if (!id) return { error: '모임 ID가 없습니다.' };
  var cache = CacheService.getScriptCache();
  var v = cache.get('v:' + id);
  if (v && knownV && String(knownV) === v) return { same: true, v: Number(v) };
  var s = load_(id);
  if (!s) return { error: '모임을 찾을 수 없습니다. 링크를 다시 확인해 주세요.' };
  return { ok: true, v: s.v, state: Core.publicState(s, !!key && key === s.hostKey) };
}

// ---------- 저장 ----------
function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) { setup(); sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
  return sh;
}

function rowOf_(id) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('row:' + id);
  var sh = sheet_(SHEET_EVENTS);
  if (hit) {
    var r = Number(hit);
    if (r <= sh.getLastRow() && sh.getRange(r, 1).getValue() === id) return r;
  }
  var f = sh.getRange(1, 1, Math.max(1, sh.getLastRow()), 1).createTextFinder(id).matchEntireCell(true).findNext();
  if (!f) return 0;
  cache.put('row:' + id, String(f.getRow()), CACHE_TTL);
  return f.getRow();
}

function load_(id) {
  if (!id) return null;
  var cache = CacheService.getScriptCache();
  var json = cache.get('st:' + id);
  if (!json) {
    var r = rowOf_(id);
    if (!r) return null;
    json = sheet_(SHEET_EVENTS).getRange(r, 9).getValue();
    if (!json) return null;
    putCache_(id, json);
  }
  return JSON.parse(json);
}

function putCache_(id, json) {
  var cache = CacheService.getScriptCache();
  var s = JSON.parse(json);
  if (json.length < 95000) cache.put('st:' + id, json, CACHE_TTL); // 캐시 한 칸 100KB 제한
  cache.put('v:' + id, String(s.v), CACHE_TTL);
}

function save_(s, isNew) {
  var json = JSON.stringify(s);
  var sh = sheet_(SHEET_EVENTS);
  var phase = { rsvp: '참석 받는 중', ready: '대진 완료', live: '경기 중', done: '종료' }[s.phase] || s.phase;
  var present = s.players.filter(function (p) { return p.present; }).length;
  var row = [s.id, s.title, Core.SPORTS[s.sport].label, s.date, s.place, phase, present, new Date(), json];
  var r = isNew ? 0 : rowOf_(s.id);
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]);
  else { sh.appendRow(row); CacheService.getScriptCache().put('row:' + s.id, String(sh.getLastRow()), CACHE_TTL); }
  putCache_(s.id, json);
}

// 종료 시 사람이 읽기 좋은 결과표를 남긴다 (다시 열고 종료하면 덮어씀)
function writeResults_(s) {
  var sh = sheet_(SHEET_RESULTS);
  var last = sh.getLastRow();
  if (last > 1) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) if (ids[i][0] === s.id) sh.deleteRow(i + 2);
  }
  var name = function (pid) { var p = s.players.filter(function (x) { return x.id === pid; })[0]; return p ? p.name : '?'; };
  var rows = [];
  s.rounds.forEach(function (r, ri) {
    r.matches.forEach(function (m) {
      if (m.state !== 'done') return;
      var A = m.a.map(name).join(', '), B = m.b.map(name).join(', ');
      var by = m.by === 'host' ? '호스트' : (m.by ? name(m.by) : '');
      rows.push([s.id, s.title, s.date, ri + 1, m.court, A, B, m.sa, m.sb, m.sa > m.sb ? A : B, by, m.at ? new Date(m.at) : '']);
    });
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}
