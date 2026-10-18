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
    if (p.a === 'state') return out_(readState_(p.e, p.k, p.v, p.dev));
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
  return { ok: true, id: s.id, hostKey: s.hostKey, v: s.v, state: Core.publicState(s, true, true) };
}

function act_(body) {
  var s = load_(body.e);
  if (!s) return { error: '모임을 찾을 수 없습니다. 링크를 다시 확인해 주세요.' };
  var viaKey = !!body.k && body.k === s.hostKey;
  var isHost = Core.hostCheck(s, body.k, body.dev);
  var before = s.phase;
  var r = Core.apply(s, body.action || {}, ctx_(isHost, body.dev)) || {};
  if (r.error) return { error: r.error, v: s.v };
  save_(s, false);
  if (s.phase === 'done' && before !== 'done') writeResults_(s);
  return { ok: true, result: r, v: s.v, state: Core.publicState(s, Core.hostCheck(s, body.k, body.dev), viaKey) };
}

function readState_(id, key, knownV, dev) {
  if (!id) return { error: '모임 ID가 없습니다.' };
  var cache = CacheService.getScriptCache();
  var v = cache.get('v:' + id);
  if (v && knownV && String(knownV) === v) return { same: true, v: Number(v) };
  var s = load_(id);
  if (!s) return { error: '모임을 찾을 수 없습니다. 링크를 다시 확인해 주세요.' };
  return { ok: true, v: s.v, state: Core.publicState(s, Core.hostCheck(s, key, dev), !!key && key === s.hostKey) };
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


/* ====== 아래는 대진 엔진과 진행 로직입니다. 직접 고치지 말고 src/ 를 고친 뒤 node dev/build.js ====== */
/* 오픈코트 복식 대진 엔진
 * - rotation: 라운드마다 짝을 바꾸는 친선전 (개인 순위)
 * - fixed   : 호스트가 정한 고정 복식 팀 리그 (팀 순위)
 * 브라우저(window.Engine)와 Node(require) 양쪽에서 동작
 */
(function (root) {
  'use strict';

  // ---------- 유틸 ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  const pk = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const inc = (m, k, v = 1) => m.set(k, (m.get(k) || 0) + v);

  // 급수: A(5) B(4) C(3) D(2) 초심(1), 미지정은 3으로 취급
  const LEVELS = [
    { key: 'A', label: 'A', v: 5 },
    { key: 'B', label: 'B', v: 4 },
    { key: 'C', label: 'C', v: 3 },
    { key: 'D', label: 'D', v: 2 },
    { key: 'E', label: '초심', v: 1 },
  ];
  const levelValue = (lv) => (LEVELS.find((l) => l.key === lv) || { v: 3 }).v;

  // 0..k-1 의 모든 완전매칭 (k 짝수)
  const matchCache = {};
  function matchings(k) {
    if (matchCache[k]) return matchCache[k];
    const res = [], used = new Array(k).fill(false), cur = [];
    (function rec() {
      let i = 0;
      while (i < k && used[i]) i++;
      if (i === k) { res.push(cur.slice()); return; }
      used[i] = true;
      for (let j = i + 1; j < k; j++) {
        if (used[j]) continue;
        used[j] = true; cur.push([i, j]);
        rec();
        cur.pop(); used[j] = false;
      }
      used[i] = false;
    })();
    return (matchCache[k] = res);
  }

  function combinations(arr, r, limit, rnd) {
    // arr에서 r개 고르는 조합 (너무 많으면 무작위 limit개 표본)
    const out = [];
    const total = choose(arr.length, r);
    if (total <= limit) {
      (function rec(start, cur) {
        if (cur.length === r) { out.push(cur.slice()); return; }
        for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
      })(0, []);
      return out;
    }
    const seen = new Set();
    let guard = 0;
    while (out.length < limit && guard++ < limit * 20) {
      const pick = shuffle(arr, rnd).slice(0, r);
      const key = pick.slice().sort().join(',');
      if (!seen.has(key)) { seen.add(key); out.push(pick); }
    }
    return out;
  }
  function choose(n, r) {
    if (r < 0 || r > n) return 0;
    let c = 1;
    for (let i = 0; i < r; i++) c = (c * (n - i)) / (i + 1);
    return Math.round(c);
  }

  // ---------- 기록 집계 ----------
  function buildStats(rounds) {
    const s = {
      partner: new Map(), opp: new Map(),
      played: new Map(), rested: new Map(), restedLast: new Set(),
      sameCourtLast: new Set(),
    };
    rounds.forEach((r, idx) => {
      const last = idx === rounds.length - 1;
      r.matches.forEach((m) => {
        const [a1, a2] = m.a, [b1, b2] = m.b;
        inc(s.partner, pk(a1, a2)); inc(s.partner, pk(b1, b2));
        [a1, a2].forEach((x) => [b1, b2].forEach((y) => inc(s.opp, pk(x, y))));
        [a1, a2, b1, b2].forEach((p) => inc(s.played, p));
        if (last) [a1, a2, b1, b2].forEach((p) => s.sameCourtLast.add(p));
      });
      (r.rest || []).forEach((p) => {
        inc(s.rested, p);
        if (last) s.restedLast.add(p);
      });
    });
    return s;
  }

  // ---------- 로테이션: 한 라운드 ----------
  const W = { partner: 1000, opp: 30, level: 60, restRepeat: 400 };

  function bestPairing(ids, stats, levelOf, balance, rnd) {
    const k = ids.length;
    const P = shuffle(ids, rnd);
    const pc = (i, j) => stats.partner.get(pk(P[i], P[j])) || 0;
    const oc = (i, j) => stats.opp.get(pk(P[i], P[j])) || 0;
    const lv = P.map(levelOf);

    if (k > 12) return localSearchPairing(P, pc, oc, lv, balance, rnd);

    const ms = shuffle(matchings(k), rnd);
    const groupings = matchings(k / 2);
    let best = null, bestCost = Infinity;
    for (const m of ms) {
      let partnerCost = 0;
      for (const [i, j] of m) partnerCost += W.partner * pc(i, j);
      if (partnerCost >= bestCost) continue;
      for (const g of groupings) {
        let cost = partnerCost;
        for (const [x, y] of g) {
          const [a1, a2] = m[x], [b1, b2] = m[y];
          cost += W.opp * (oc(a1, b1) + oc(a1, b2) + oc(a2, b1) + oc(a2, b2));
          if (balance) cost += W.level * Math.abs(lv[a1] + lv[a2] - lv[b1] - lv[b2]);
          if (cost >= bestCost) break;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = g.map(([x, y]) => ({ a: [P[m[x][0]], P[m[x][1]]], b: [P[m[y][0]], P[m[y][1]]] }));
        }
      }
    }
    return { matches: best, cost: bestCost };
  }

  // 13명 이상이 동시에 코트에 서는 경우(코트 4면 이상) — 지역 탐색
  function localSearchPairing(P, pc, oc, lv, balance, rnd) {
    const k = P.length;
    const costOf = (ord) => {
      let c = 0;
      for (let t = 0; t < k; t += 4) {
        const [a1, a2, b1, b2] = [ord[t], ord[t + 1], ord[t + 2], ord[t + 3]];
        c += W.partner * (pc(a1, a2) + pc(b1, b2));
        c += W.opp * (oc(a1, b1) + oc(a1, b2) + oc(a2, b1) + oc(a2, b2));
        if (balance) c += W.level * Math.abs(lv[a1] + lv[a2] - lv[b1] - lv[b2]);
      }
      return c;
    };
    let bestOrd = null, bestCost = Infinity;
    for (let rs = 0; rs < 40; rs++) {
      let ord = shuffle([...Array(k).keys()], rnd), cost = costOf(ord), improved = true;
      while (improved) {
        improved = false;
        for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
          [ord[i], ord[j]] = [ord[j], ord[i]];
          const c = costOf(ord);
          if (c < cost) { cost = c; improved = true; } else [ord[i], ord[j]] = [ord[j], ord[i]];
        }
      }
      if (cost < bestCost) { bestCost = cost; bestOrd = ord.slice(); }
    }
    const matches = [];
    for (let t = 0; t < k; t += 4) {
      const o = bestOrd;
      matches.push({ a: [P[o[t]], P[o[t + 1]]], b: [P[o[t + 2]], P[o[t + 3]]] });
    }
    return { matches, cost: bestCost };
  }

  function nextRotationRound(presentIds, courts, history, levelOf, balance, rnd) {
    const n = presentIds.length;
    const used = Math.min(courts, Math.floor(n / 4));
    if (used < 1) return null;
    const k = used * 4, restN = n - k;
    const stats = buildStats(history);

    // 쉬는 사람 고르기: 출전 비율이 높은 사람부터 쉼 (경기 수 균등이 1순위)
    // 직전에 쉰 사람이 또 쉬는 건 금지가 아니라 비용으로 — 금지하면 같은 4명끼리만 도는 고착이 생김
    const rate = (p) => {
      const pl = stats.played.get(p) || 0, rs = stats.rested.get(p) || 0;
      return pl + rs === 0 ? -1 : pl / (pl + rs);
    };
    const restKey = (p) => Math.round(rate(p) * 1e6) / 1e6;

    let restSets = [[]];
    if (restN > 0) {
      const sorted = shuffle(presentIds, rnd).sort((x, y) => restKey(y) - restKey(x));
      const cutoff = restKey(sorted[restN - 1]);
      const sure = sorted.filter((p) => restKey(p) > cutoff + 1e-9);
      const tie = sorted.filter((p) => Math.abs(restKey(p) - cutoff) < 1e-9);
      const need = restN - sure.length;
      const lim = k >= 12 ? 8 : 24;
      restSets = combinations(tie, need, lim, rnd).map((c) => sure.concat(c));
    }

    let best = null;
    for (const rest of restSets) {
      const restSet = new Set(rest);
      const act = presentIds.filter((p) => !restSet.has(p));
      const r = bestPairing(act, stats, levelOf, balance, rnd);
      const restCost = rest.filter((p) => stats.restedLast.has(p)).length * W.restRepeat;
      const cost = r.cost + restCost;
      if (!best || cost < best.cost) best = { ...r, cost, rest };
    }
    return {
      matches: best.matches.map((m, i) => ({ court: i + 1, a: m.a, b: m.b, sa: null, sb: null })),
      rest: best.rest,
    };
  }

  // ---------- 고정 복식: 팀 리그 ----------
  function circleOrder(teamIds) {
    let t = teamIds.slice();
    if (t.length % 2) t.push(null);
    const n = t.length, list = [];
    for (let r = 0; r < n - 1; r++) {
      for (let i = 0; i < n / 2; i++) {
        const a = t[i], b = t[n - 1 - i];
        if (a != null && b != null) list.push([a, b]);
      }
      t = [t[0], t[n - 1]].concat(t.slice(1, n - 1));
    }
    return list;
  }

  function planFixed(event, lockedRounds) {
    const teams = event.teams.filter((t) => t.p.every((p) => isPresent(event, p)));
    const teamOf = {};
    teams.forEach((t) => (teamOf[t.id] = t));
    const done = new Set();
    const games = new Map(), restedLast = new Set();
    lockedRounds.forEach((r, idx) => {
      r.matches.forEach((m) => {
        done.add(pk(m.ta, m.tb)); inc(games, m.ta); inc(games, m.tb);
      });
      if (idx === lockedRounds.length - 1) (r.restTeams || []).forEach((t) => restedLast.add(t));
    });
    let remaining = circleOrder(teams.map((t) => t.id)).filter(([a, b]) => !done.has(pk(a, b)));
    const out = [];
    const C = Math.min(event.courts, Math.floor(teams.length / 2));
    if (C < 1) return out;
    let lastRest = restedLast;
    while (remaining.length) {
      const order = remaining
        .map((m, i) => ({ m, i }))
        .sort((x, y) => {
          const pri = (mm) => (games.get(mm[0]) || 0) + (games.get(mm[1]) || 0)
            - 3 * ((lastRest.has(mm[0]) ? 1 : 0) + (lastRest.has(mm[1]) ? 1 : 0));
          return pri(x.m) - pri(y.m) || x.i - y.i;
        });
      const busy = new Set(), pick = [];
      for (const { m, i } of order) {
        if (pick.length >= C) break;
        if (busy.has(m[0]) || busy.has(m[1])) continue;
        busy.add(m[0]); busy.add(m[1]); pick.push(i);
      }
      const ms = pick.map((i) => remaining[i]);
      remaining = remaining.filter((_, i) => !pick.includes(i));
      ms.forEach(([a, b]) => { inc(games, a); inc(games, b); });
      const restTeams = teams.map((t) => t.id).filter((t) => !busy.has(t));
      lastRest = new Set(restTeams);
      out.push({
        matches: ms.map(([a, b], i) => ({
          court: i + 1, ta: a, tb: b, a: teamOf[a].p.slice(), b: teamOf[b].p.slice(), sa: null, sb: null,
        })),
        restTeams,
        rest: restTeams.flatMap((t) => teamOf[t].p),
      });
    }
    return out;
  }

  // ---------- 공통 ----------
  function isPresent(event, pid) {
    const p = event.players.find((x) => x.id === pid);
    return !!(p && p.present);
  }
  // 결과가 있거나, 코트에 배정되어 진행 중인 경기가 하나라도 있으면 그 라운드는 고정
  const isLocked = (r) => r.locked || r.matches.some((m) => m.sa != null || (m.state && m.state !== 'wait'));

  // 점수가 하나라도 들어간 라운드까지는 그대로 두고, 그 뒤만 다시 짠다
  function splitLocked(rounds) {
    let last = -1;
    rounds.forEach((r, i) => { if (isLocked(r)) last = i; });
    return rounds.slice(0, last + 1);
  }

  function scheduleScore(rounds, presentIds, levelOf, balance) {
    const s = buildStats(rounds);
    let repeat = 0, oppSq = 0, lvl = 0, consecRest = 0;
    s.partner.forEach((c) => { if (c > 1) repeat += c - 1; });
    s.opp.forEach((c) => { oppSq += c * c; });
    const pl = presentIds.map((p) => s.played.get(p) || 0);
    const spread = pl.length ? Math.max(...pl) - Math.min(...pl) : 0;
    for (let i = 1; i < rounds.length; i++) {
      const prev = new Set(rounds[i - 1].rest || []);
      (rounds[i].rest || []).forEach((p) => { if (prev.has(p)) consecRest++; });
    }
    if (balance) rounds.forEach((r) => r.matches.forEach((m) => {
      lvl += Math.abs(levelOf(m.a[0]) + levelOf(m.a[1]) - levelOf(m.b[0]) - levelOf(m.b[1]));
    }));
    return {
      total: repeat * 1000 + spread * 500 + consecRest * 400 + oppSq * 2 + lvl * 20,
      repeat, spread, consecRest, oppSq, lvl,
    };
  }

  /**
   * plan(event, opts) → 새 rounds 배열
   * opts.rounds: 로테이션 총 라운드 수 (기본: 추천값)
   * opts.restarts: 전체 일정 재시도 횟수 (가장 공평한 일정 채택)
   */
  function plan(event, opts = {}) {
    const locked = splitLocked(event.rounds || []);
    // 종목별 실력 환산은 호출하는 쪽(core)이 넘겨줌. 없으면 기본 급수표 사용
    const levelOf = opts.levelOf || ((pid) => {
      const p = event.players.find((x) => x.id === pid);
      return levelValue(p && p.level);
    });
    const seed = opts.seed != null ? opts.seed : (Date.now() & 0xffffffff);

    if (event.mode === 'fixed') {
      const fut = planFixed(event, locked);
      return locked.concat(fut).map((r, i) => ({ ...r, no: i + 1 }));
    }

    const present = event.players.filter((p) => p.present).map((p) => p.id);
    const total = opts.rounds || recommendRounds(present.length, event.courts).rounds;
    const need = Math.max(0, total - locked.length);
    const balance = !!event.balanceLevel;
    const restarts = opts.restarts || defaultRestarts(present.length, event.courts);

    let best = null;
    for (let t = 0; t < restarts; t++) {
      const rnd = mulberry32(seed + t * 7919);
      const rounds = locked.slice();
      for (let i = 0; i < need; i++) {
        const r = nextRotationRound(present, event.courts, rounds, levelOf, balance, rnd);
        if (!r) break;
        rounds.push(r);
      }
      const sc = scheduleScore(rounds, present, levelOf, balance);
      if (!best || sc.total < best.sc.total) best = { rounds, sc };
      if (sc.total === 0) break;
    }
    return best.rounds.map((r, i) => ({ ...r, no: i + 1 }));
  }

  function defaultRestarts(n, courts) {
    const k = Math.min(courts, Math.floor(n / 4)) * 4;
    if (k >= 12) return 6;
    if (k >= 8) return 30;
    return 60;
  }

  // 모두가 한 번씩 짝이 되려면 몇 라운드가 필요한가
  function recommendRounds(n, courts) {
    const used = Math.min(courts, Math.floor(n / 4));
    if (used < 1) return { rounds: 0, used: 0, perRoundRest: n, gamesEach: 0 };
    const pairs = (n * (n - 1)) / 2;               // 가능한 짝 수
    const rounds = Math.ceil(pairs / (2 * used));   // 한 경기에 짝 2개 소화
    return {
      rounds, used, perRoundRest: n - used * 4,
      gamesEach: +((rounds * used * 4) / n).toFixed(1),
    };
  }

  // ---------- 순위 ----------
  function standings(event) {
    const rows = new Map();
    const fixed = event.mode === 'fixed';
    const ensure = (id, name) => {
      if (!rows.has(id)) rows.set(id, { id, name, g: 0, w: 0, l: 0, pf: 0, pa: 0 });
      return rows.get(id);
    };
    const nameOf = (pid) => (event.players.find((p) => p.id === pid) || { name: '?' }).name;
    const teamName = (tid) => {
      const t = event.teams.find((x) => x.id === tid);
      return t ? t.p.map(nameOf).join(' · ') : '?';
    };
    if (fixed) event.teams.forEach((t) => ensure(t.id, teamName(t.id)));
    else event.players.filter((p) => p.present || hasPlayed(event, p.id)).forEach((p) => ensure(p.id, p.name));

    (event.rounds || []).forEach((r) => r.matches.forEach((m) => {
      if (m.sa == null || m.sb == null) return;
      const sides = fixed ? [[m.ta], [m.tb]] : [m.a, m.b];
      const sc = [m.sa, m.sb];
      [0, 1].forEach((s) => sides[s].forEach((id) => {
        const row = ensure(id, fixed ? teamName(id) : nameOf(id));
        row.g++; row.pf += sc[s]; row.pa += sc[1 - s];
        if (sc[s] > sc[1 - s]) row.w++; else row.l++;
      }));
    }));

    const list = [...rows.values()].map((r) => ({
      ...r, diff: r.pf - r.pa, rate: r.g ? r.w / r.g : 0,
    }));
    list.sort((a, b) => b.rate - a.rate || b.diff - a.diff || b.pf - a.pf || a.name.localeCompare(b.name, 'ko'));
    list.forEach((r, i) => {
      const prev = list[i - 1];
      r.rank = prev && prev.rate === r.rate && prev.diff === r.diff && prev.pf === r.pf ? prev.rank : i + 1;
    });
    return list;
  }
  function hasPlayed(event, pid) {
    return (event.rounds || []).some((r) => r.matches.some((m) => m.sa != null && (m.a.includes(pid) || m.b.includes(pid))));
  }

  const Engine = {
    LEVELS, levelValue, plan, standings, recommendRounds, buildStats, scheduleScore, isLocked, pk,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);


/* 오픈코트 진행 로직 (서버 = 앱스크립트, 화면 = PWA 가 같은 코드를 씀)
 *
 * 상태(state) 하나에 모임 전체가 들어 있고, 모든 변경은 apply(state, action, ctx) 로만 일어난다.
 * phase: rsvp(참석 응답) → ready(대진 완료) → live(경기 중) → done(종료)
 * 경기(match) state: wait(대기) → play(코트 배정, 진행 중) → done(결과 입력) / void(취소)
 */
(function (root) {
  'use strict';
  const Engine = root.Engine || (typeof require !== 'undefined' ? require('./engine.js') : null);

  const SPORTS = {
    pickleball: { label: '피클볼', target: 11, minutes: 12, cap: null, levelKind: 'dupr' },
    badminton:  { label: '배드민턴', target: 21, minutes: 15, cap: 30, levelKind: 'grade' },
  };
  const GRADES = [
    { k: 'E', label: '초심', v: 1 }, { k: 'D', label: 'D', v: 2 }, { k: 'C', label: 'C', v: 3 },
    { k: 'B', label: 'B', v: 4 }, { k: 'A', label: 'A', v: 5 }, { k: 'S', label: '자강', v: 6 },
  ];
  const SELF_DUPR = ['2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0'];

  // ---------- 실력 ----------
  function levelLabel(sport, p) {
    if (!p || !p.level) return '';
    if (SPORTS[sport].levelKind === 'grade') {
      const g = GRADES.find((x) => x.k === p.level);
      return g ? g.label : '';
    }
    return p.levelSelf ? `${p.level} 자가` : `DUPR ${p.level}`;
  }
  function levelNum(sport, p) {
    if (!p || !p.level) return null;
    if (SPORTS[sport].levelKind === 'grade') {
      const g = GRADES.find((x) => x.k === p.level);
      return g ? g.v : null;
    }
    const n = parseFloat(p.level);
    return isFinite(n) ? n * 2 : null; // DUPR 0.5 차이 = 급수 1단계로 취급
  }
  function cleanLevel(sport, level) {
    if (level == null || level === '') return '';
    if (SPORTS[sport].levelKind === 'grade') return GRADES.some((g) => g.k === level) ? level : '';
    const n = parseFloat(level);
    if (!isFinite(n) || n < 1 || n > 8.5) return '';
    return String(Math.round(n * 1000) / 1000);
  }
  function makeLevelOf(state) {
    const known = state.players.map((p) => levelNum(state.sport, p)).filter((v) => v != null).sort((a, b) => a - b);
    const median = known.length ? known[Math.floor(known.length / 2)] : 3;
    const map = {};
    state.players.forEach((p) => { const v = levelNum(state.sport, p); map[p.id] = v == null ? median : v; });
    return (pid) => (map[pid] != null ? map[pid] : median);
  }

  // ---------- 생성 ----------
  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  }
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

  function newEvent(input, ctx) {
    const sport = SPORTS[input.sport] ? input.sport : 'pickleball';
    const s = {
      id: ctx.id(8), hostKey: ctx.id(14), v: 1, created: ctx.now,
      title: str(input.title, 40) || '오픈코트',
      date: str(input.date, 20), place: str(input.place, 40), note: str(input.note, 200),
      sport, courts: clampInt(input.courts, 1, 8, 2), mode: input.mode === 'fixed' ? 'fixed' : 'rotation',
      target: clampInt(input.target, 5, 31, SPORTS[sport].target),
      minutes: clampInt(input.minutes, 5, 40, SPORTS[sport].minutes),
      balanceLevel: !!input.balanceLevel, totalRounds: null,
      phase: 'rsvp', dirty: false, players: [], teams: [], rounds: [], cohosts: [],
    };
    if (input.hostName) {
      s.players.push({ id: ctx.id(6), name: str(input.hostName, 16), level: cleanLevel(sport, input.hostLevel),
        levelSelf: !!input.hostLevelSelf, status: 'yes', src: 'host', present: true, dev: str(input.dev, 40) });
    }
    return s;
  }

  // ---------- 조회용 계산 ----------
  const allMatches = (s) => s.rounds.flatMap((r, ri) => r.matches.map((m) => Object.assign({ ri }, m)));
  const findMatch = (s, mid) => {
    for (const r of s.rounds) for (const m of r.matches) if (m.id === mid) return m;
    return null;
  };
  const presentSet = (s) => new Set(s.players.filter((p) => p.present).map((p) => p.id));
  const playersOf = (m) => m.a.concat(m.b);
  const totalRounds = (s) => s.totalRounds || Engine.recommendRounds(s.players.filter((p) => p.present).length, s.courts).rounds;

  // 진행 가능한 가장 앞 라운드 (취소·불참자 포함 경기는 건너뜀)
  function frontRound(s) {
    const pres = presentSet(s);
    return s.rounds.findIndex((r) => r.matches.some((m) =>
      m.state === 'play' || (m.state === 'wait' && playersOf(m).every((p) => pres.has(p)))));
  }

  // 비는 코트에 다음 경기를 자동 배정 (현재 라운드와 바로 다음 라운드까지만 당겨 씀)
  function assign(s, ctx) {
    if (s.phase !== 'live') return 0;
    const busy = new Set(), courtBusy = new Set(), pres = presentSet(s);
    allMatches(s).forEach((m) => {
      if (m.state === 'play') { playersOf(m).forEach((p) => busy.add(p)); courtBusy.add(m.court); }
    });
    const fr = frontRound(s);
    if (fr < 0) return 0;
    let n = 0;
    for (let ri = fr; ri <= fr + 1 && ri < s.rounds.length; ri++) {
      for (const m of s.rounds[ri].matches) {
        if (m.state !== 'wait') continue;
        const ps = playersOf(m);
        if (ps.some((p) => busy.has(p) || !pres.has(p))) continue;
        let c = null;
        if (m.court && m.court <= s.courts && !courtBusy.has(m.court)) c = m.court;
        else for (let k = 1; k <= s.courts; k++) if (!courtBusy.has(k)) { c = k; break; }
        if (c == null) return n;
        m.state = 'play'; m.court = c; m.startAt = ctx.now;
        courtBusy.add(c); ps.forEach((p) => busy.add(p)); n++;
      }
    }
    return n;
  }

  function draw(s, ctx) {
    // 진행 중에 다시 짜는 경우: 이미 시작했거나 끝난 경기가 있는 라운드는 남기고,
    // 그 안에서도 아직 시작 안 한 경기에 불참자가 있으면 취소 처리
    const pres = presentSet(s);
    s.rounds.forEach((r) => {
      if (!Engine.isLocked(r)) return;
      r.matches.forEach((m) => {
        if (m.state === 'wait' && playersOf(m).some((p) => !pres.has(p))) m.state = 'void';
      });
    });
    const ev = { mode: s.mode, courts: s.courts, balanceLevel: s.balanceLevel, players: s.players, teams: s.teams, rounds: s.rounds };
    const opts = { levelOf: makeLevelOf(s) };
    if (s.mode === 'rotation') opts.rounds = totalRounds(s);
    const rounds = Engine.plan(ev, opts);
    rounds.forEach((r) => r.matches.forEach((m) => {
      if (!m.id) m.id = ctx.id(6);
      if (!m.state) m.state = 'wait';
    }));
    s.rounds = rounds;
    s.dirty = false;
    if (s.phase === 'rsvp') s.phase = 'ready';
    assign(s, ctx);
  }

  function markDirty(s) { if (s.rounds.length && s.phase !== 'done') s.dirty = true; }

  // ---------- 동작 ----------
  const HOST_ONLY = new Set(['settings', 'addPlayer', 'setPlayer', 'removePlayer', 'setTeams', 'draw', 'start', 'finish', 'reopen', 'reset', 'voidMatch', 'setCohost']);

  // 호스트 판별: 만든 사람의 호스트 키(또는 공동 호스트 링크)를 가졌거나,
  // 지정된 호스트이면서 그 사람이 초대 링크로 응답했던 바로 그 폰인 경우
  function hostCheck(s, key, dev) {
    if (key && key === s.hostKey) return true;
    if (!dev) return false;
    const p = s.players.find((x) => x.dev && x.dev === dev);
    return !!(p && (s.cohosts || []).includes(p.id));
  }

  function err(msg) { return { error: msg }; }

  /** apply(state, action, ctx) → { ok:true } 또는 { error } (state 는 제자리 수정)
   *  ctx: { now, id(len), isHost, dev } */
  function apply(s, a, ctx) {
    if (HOST_ONLY.has(a.type) && !ctx.isHost) return err('호스트만 할 수 있는 작업입니다.');
    const P = (pid) => s.players.find((p) => p.id === pid);
    let r;
    switch (a.type) {
      case 'rsvp': r = rsvp(s, a, ctx); break;
      case 'settings': r = settings(s, a); break;
      case 'addPlayer': {
        const name = str(a.name, 16);
        if (!name) return err('이름을 입력하세요.');
        if (s.players.some((p) => p.name === name)) return err(`${name} 님은 이미 명단에 있습니다.`);
        const p = { id: ctx.id(6), name, level: cleanLevel(s.sport, a.level), levelSelf: !!a.levelSelf, status: 'yes', src: 'walkin', present: true, dev: '' };
        s.players.push(p); markDirty(s); r = { ok: true, pid: p.id };
        break;
      }
      case 'setPlayer': {
        const p = P(a.pid); if (!p) return err('없는 참가자입니다.');
        if (a.present != null && p.present !== !!a.present) { p.present = !!a.present; markDirty(s); }
        if (a.level !== undefined) { p.level = cleanLevel(s.sport, a.level); p.levelSelf = !!a.levelSelf; if (s.balanceLevel) markDirty(s); }
        if (a.name) { const n = str(a.name, 16); if (n && !s.players.some((q) => q !== p && q.name === n)) p.name = n; }
        r = { ok: true }; break;
      }
      case 'removePlayer': {
        const played = allMatches(s).some((m) => m.state !== 'wait' && m.state !== 'void' && playersOf(m).includes(a.pid));
        if (played) { const p = P(a.pid); if (p) p.present = false; }
        else { s.players = s.players.filter((p) => p.id !== a.pid); s.teams = s.teams.filter((t) => !t.p.includes(a.pid)); }
        markDirty(s); r = { ok: true }; break;
      }
      case 'setTeams': {
        const ids = new Set(s.players.map((p) => p.id)), used = new Set();
        const teams = [];
        for (const t of (a.teams || [])) {
          if (!Array.isArray(t) || t.length !== 2 || t[0] === t[1] || !ids.has(t[0]) || !ids.has(t[1]) || used.has(t[0]) || used.has(t[1])) continue;
          used.add(t[0]); used.add(t[1]);
          const old = s.teams.find((x) => x.p.includes(t[0]) && x.p.includes(t[1]));
          teams.push({ id: old ? old.id : ctx.id(6), p: [t[0], t[1]] });
        }
        s.teams = teams; markDirty(s); r = { ok: true }; break;
      }
      case 'draw': {
        if (s.phase === 'done') return err('종료된 모임입니다.');
        const n = s.players.filter((p) => p.present).length;
        if (s.mode === 'rotation' && n < 4) return err('참석자가 4명 이상이어야 대진을 짤 수 있습니다.');
        if (s.mode === 'fixed' && s.teams.filter((t) => t.p.every((id) => (P(id) || {}).present)).length < 2) return err('팀이 2개 이상 있어야 합니다.');
        if (a.fresh && s.phase !== 'live') s.rounds = [];
        draw(s, ctx); r = { ok: true }; break;
      }
      case 'start':
        if (!s.rounds.length) return err('먼저 대진을 짜세요.');
        s.phase = 'live'; s.startedAt = s.startedAt || ctx.now; assign(s, ctx); r = { ok: true }; break;
      case 'score': r = score(s, a, ctx); break;
      case 'voidMatch': {
        const m = findMatch(s, a.mid); if (!m) return err('없는 경기입니다.');
        if (m.state === 'done') return err('결과가 들어간 경기는 취소할 수 없습니다. 점수를 고치세요.');
        m.state = 'void'; assign(s, ctx); r = { ok: true }; break;
      }
      case 'finish': s.phase = 'done'; s.finishedAt = ctx.now; r = { ok: true }; break;
      case 'reopen': s.phase = 'live'; assign(s, ctx); r = { ok: true }; break;
      case 'setCohost': {
        const p = P(a.pid); if (!p) return err('없는 참가자입니다.');
        s.cohosts = s.cohosts || [];
        if (a.on) {
          if (!p.dev) return err(`${p.name} 님은 아직 자기 폰으로 응답하지 않았습니다. 초대 링크를 열어 자기 이름을 누르면 지정할 수 있습니다.`);
          if (!s.cohosts.includes(p.id)) s.cohosts.push(p.id);
        } else {
          s.cohosts = s.cohosts.filter((id) => id !== p.id);
        }
        r = { ok: true }; break;
      }
      case 'reset':
        if (s.phase === 'live' || s.phase === 'done') {
          if (allMatches(s).some((m) => m.state === 'done') && !a.force) return err('결과가 있는 경기는 지울 수 없습니다.');
        }
        s.rounds = []; s.phase = 'rsvp'; s.dirty = false; r = { ok: true }; break;
      default: return err('알 수 없는 요청입니다.');
    }
    if (r && !r.error) s.v = (s.v || 0) + 1;
    return r;
  }

  function rsvp(s, a, ctx) {
    if (s.phase === 'done') return err('이미 종료된 모임입니다.');
    const name = str(a.name, 16);
    let p = a.pid ? s.players.find((x) => x.id === a.pid) : null;
    if (!p && name) {
      const same = s.players.find((x) => x.name === name);
      if (same) {
        // 같은 이름: 호스트가 미리 넣어 둔 이름이거나, 같은 폰이면 본인으로 보고 이어 씀
        if (!same.dev || same.dev === ctx.dev) p = same;
        else return err(`${name} 님은 이미 다른 폰에서 응답했습니다. 이름 뒤에 구분할 글자를 붙여 주세요.`);
      }
    }
    if (!p) {
      if (!name) return err('이름을 입력하세요.');
      p = { id: ctx.id(6), name, level: '', levelSelf: false, status: 'yes', src: 'invite', present: false, dev: '' };
      s.players.push(p);
      if (a.status === undefined) a.status = 'yes';
    }
    if (ctx.dev && !p.dev) p.dev = ctx.dev;
    if (a.level !== undefined) { p.level = cleanLevel(s.sport, a.level); p.levelSelf = !!a.levelSelf; }
    if (a.status === 'yes' || a.status === 'no') {
      p.status = a.status;
      const was = p.present;
      p.present = a.status === 'yes';
      if (was !== p.present) markDirty(s);
    }
    return { ok: true, pid: p.id };
  }

  function settings(s, a) {
    const f = a.fields || {};
    if (f.title !== undefined) s.title = str(f.title, 40) || s.title;
    if (f.date !== undefined) s.date = str(f.date, 20);
    if (f.place !== undefined) s.place = str(f.place, 40);
    if (f.note !== undefined) s.note = str(f.note, 200);
    if (f.sport && SPORTS[f.sport] && f.sport !== s.sport) {
      const was = SPORTS[s.sport];
      s.sport = f.sport;
      if (s.target === was.target) s.target = SPORTS[f.sport].target;
      if (s.minutes === was.minutes) s.minutes = SPORTS[f.sport].minutes;
      s.players.forEach((p) => { p.level = ''; p.levelSelf = false; }); // 급수 ↔ DUPR 은 호환 안 됨
      markDirty(s);
    }
    if (f.courts !== undefined) { s.courts = clampInt(f.courts, 1, 8, s.courts); markDirty(s); }
    if (f.mode && (f.mode === 'fixed' || f.mode === 'rotation') && f.mode !== s.mode) {
      if (s.phase === 'live' || s.phase === 'done') return err('경기 중에는 방식을 바꿀 수 없습니다.');
      s.mode = f.mode; s.rounds = []; s.phase = 'rsvp'; s.dirty = false;
    }
    if (f.target !== undefined) s.target = clampInt(f.target, 5, 31, s.target);
    if (f.minutes !== undefined) s.minutes = clampInt(f.minutes, 5, 40, s.minutes);
    if (f.balanceLevel !== undefined) { s.balanceLevel = !!f.balanceLevel; markDirty(s); }
    if (f.totalRounds !== undefined) { s.totalRounds = f.totalRounds == null ? null : clampInt(f.totalRounds, 1, 40, null); markDirty(s); }
    return { ok: true };
  }

  function score(s, a, ctx) {
    if (s.phase !== 'live' && !(ctx.isHost && s.phase === 'done')) return err('경기 중일 때만 결과를 넣을 수 있습니다.');
    const m = findMatch(s, a.mid);
    if (!m) return err('없는 경기입니다.');
    if (m.state === 'void') return err('취소된 경기입니다.');
    if (m.state === 'wait' && !ctx.isHost) return err('아직 시작하지 않은 경기입니다.');
    const sa = parseInt(a.sa, 10), sb = parseInt(a.sb, 10);
    if (!isFinite(sa) || !isFinite(sb) || sa < 0 || sb < 0 || sa > 99 || sb > 99) return err('점수를 확인해 주세요.');
    if (sa === sb) return err('동점은 입력할 수 없습니다. 이긴 팀을 정해 주세요.');
    // 호스트는 모든 경기, 참가자는 자기 경기만. 참가자는 보낸 값이 아니라 '초대 링크로 응답한 폰'으로 서버가 직접 확인
    let by;
    if (ctx.isHost) by = a.by && s.players.some((p) => p.id === a.by) ? a.by : 'host';
    else {
      const me = ctx.dev ? s.players.find((p) => p.dev && p.dev === ctx.dev) : null;
      if (!me || !playersOf(m).includes(me.id)) return err('자기 경기 결과만 넣을 수 있습니다. 다른 경기는 호스트에게 부탁해 주세요.');
      by = me.id;
    }
    const wasDone = m.state === 'done';
    // 같은 코트 사람들이 거의 동시에 누른 경우: 먼저 들어간 결과를 지키고, 고치기는 명시적으로만
    if (wasDone && !a.edit) {
      const who = m.by === 'host' ? '호스트' : ((s.players.find((p) => p.id === m.by) || {}).name || '다른 사람');
      return err(`${who} 님이 이미 결과를 넣었습니다 (${m.sa}:${m.sb}). 틀렸다면 기록에서 눌러 고쳐 주세요.`);
    }
    m.sa = sa; m.sb = sb; m.state = 'done'; m.by = by; m.at = ctx.now;
    if (wasDone) m.edited = true;
    if (!m.court) m.court = 1;
    assign(s, ctx);
    return { ok: true };
  }

  // ---------- 화면용 요약 ----------
  // 참가자 한 명의 시점: 지금 경기, 다음 경기, 쉬는 중인지
  function myView(s, pid) {
    const name = (id) => (s.players.find((p) => p.id === id) || { name: '?' }).name;
    const ms = allMatches(s).filter((m) => m.state !== 'void' && playersOf(m).includes(pid));
    const done = ms.filter((m) => m.state === 'done');
    const pending = ms.filter((m) => m.state !== 'done');
    const side = (m) => (m.a.includes(pid) ? 'a' : 'b');
    const describe = (m) => {
      const my = m[side(m)], op = m[side(m) === 'a' ? 'b' : 'a'];
      return { id: m.id, round: m.ri + 1, court: m.court, state: m.state, side: side(m),
        partner: my.find((x) => x !== pid), opponents: op, match: m };
    };
    const current = pending.find((m) => m.state === 'play');
    const next = pending.find((m) => m.state === 'wait');
    let wait = null;
    if (!current && next) {
      // 왜 아직 못 하는지: 같이 뛸 사람이 다른 코트에서 경기 중이거나, 코트가 꽉 찼거나, 라운드 차례가 아님
      const playing = allMatches(s).filter((m) => m.state === 'play');
      const busy = new Map();
      playing.forEach((m) => playersOf(m).forEach((p) => busy.set(p, m.court)));
      const blockers = playersOf(next).filter((p) => p !== pid && busy.has(p)).map((p) => ({ id: p, name: name(p), court: busy.get(p) }));
      const fr = frontRound(s);
      const resting = next.ri > fr + 1 || (fr >= 0 && (s.rounds[fr].rest || []).includes(pid) && next.ri > fr);
      wait = { blockers, courtsFull: playing.length >= s.courts, resting, ahead: Math.max(0, next.ri - Math.max(fr, 0)) };
    }
    let w = 0, l = 0, pf = 0, pa = 0;
    done.forEach((m) => {
      const mine = side(m) === 'a' ? m.sa : m.sb, theirs = side(m) === 'a' ? m.sb : m.sa;
      pf += mine; pa += theirs; if (mine > theirs) w++; else l++;
    });
    return {
      current: current ? describe(current) : null,
      next: next ? describe(next) : null,
      after: pending.filter((m) => m !== current && m !== next).slice(0, 2).map(describe),
      wait, record: { w, l, g: done.length, diff: pf - pa }, remaining: pending.length,
      history: done.map(describe),
    };
  }

  // 전체 코트 현황과 다음 대기 경기들
  function boardView(s) {
    const courts = [];
    for (let c = 1; c <= s.courts; c++) courts.push({ court: c, match: null });
    const playing = allMatches(s).filter((m) => m.state === 'play');
    playing.forEach((m) => { const slot = courts.find((x) => x.court === m.court); if (slot && !slot.match) slot.match = m; else courts.push({ court: m.court, match: m }); });
    const queue = allMatches(s).filter((m) => m.state === 'wait');
    const done = allMatches(s).filter((m) => m.state === 'done');
    return { courts, queue, doneCount: done.length, total: done.length + queue.length + playing.length };
  }

  // 남에게 보낼 때 호스트 키와 기기 식별값은 뺀다
  // viaKey: 호스트 키로 들어온 사람에게만 키를 돌려준다 (지정 호스트는 해제되면 권한이 바로 사라지도록 키를 주지 않음)
  function publicState(s, isHost, viaKey) {
    const c = JSON.parse(JSON.stringify(s));
    if (!viaKey) delete c.hostKey;
    c.cohosts = c.cohosts || [];
    c.youHost = !!isHost;
    c.players.forEach((p) => { p.claimed = !!p.dev; delete p.dev; });
    return c;
  }

  const Core = {
    SPORTS, GRADES, SELF_DUPR, levelLabel, levelNum, cleanLevel, makeLevelOf,
    newEvent, apply, assign, hostCheck, myView, boardView, publicState, allMatches, findMatch, totalRounds, frontRound,
    standings: (s) => Engine.standings(s),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);

