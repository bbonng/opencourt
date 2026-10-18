/* 데모 전용: 앱스크립트 대신 페이지 안에서 서버 로직(Core)을 돌린다.
 * 앱 코드보다 먼저 실행되어 fetch('demo://…') 요청을 가로챈다. */
(function () {
  'use strict';
  const KEY = 'oc:demo-db-v1';
  let db = {};
  try { db = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { db = {}; }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} };
  const rid = (n) => Array.from({ length: n }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]).join('');
  const ctx = (isHost, dev) => ({ now: Date.now(), isHost: !!isHost, dev: String(dev || ''), id: rid });

  function handle(method, url, body) {
    const Core = window.Core;
    if (method === 'GET') {
      const q = new URL(url).searchParams;
      const s = db[q.get('e')];
      if (!s) return { error: '모임을 찾을 수 없습니다.' };
      if (q.get('v') && +q.get('v') === s.v) return { same: true, v: s.v };
      return { ok: true, v: s.v, state: Core.publicState(s, q.get('k') === s.hostKey) };
    }
    const b = JSON.parse(body || '{}');
    if (b.a === 'create') {
      const s = Core.newEvent(b.event || {}, ctx(true, b.dev));
      db[s.id] = s; persist();
      return { ok: true, id: s.id, hostKey: s.hostKey, v: s.v, state: Core.publicState(s, true) };
    }
    if (b.a === 'act') {
      const s = db[b.e];
      if (!s) return { error: '모임을 찾을 수 없습니다.' };
      const isHost = !!b.k && b.k === s.hostKey;
      const r = Core.apply(s, b.action || {}, ctx(isHost, b.dev)) || {};
      if (r.error) return { error: r.error, v: s.v };
      persist();
      return { ok: true, result: r, v: s.v, state: Core.publicState(s, isHost) };
    }
    return { error: '알 수 없는 요청입니다.' };
  }

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : String(input && input.href || input && input.url || input);
    if (!url.startsWith('demo:')) return realFetch(input, init);
    const method = (init && init.method) || 'GET';
    const out = handle(method, url, init && init.body);
    return new Promise((res) => setTimeout(() => res({ ok: true, json: async () => JSON.parse(JSON.stringify(out)) }), 180));
  };

  // ---------- 예시 모임 만들기 (경기 진행 중인 상태로) ----------
  function seed() {
    const Core = window.Core;
    const c = ctx(true, 'demo-host');
    const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
    const date = d.toISOString().slice(0, 10) + 'T07:00';
    const s = Core.newEvent({ title: '일요일 아침 오픈코트', sport: 'pickleball', courts: 2, date, place: '대구일중 테니스장',
      hostName: '이길봉', hostLevel: '3.5', hostLevelSelf: true, dev: 'demo-host' }, c);
    s.note = '공과 패들은 준비되어 있습니다. 편한 운동화만 챙겨 오세요.';
    const people = [['김도윤', '3.85', false], ['이서연', '3.0', true], ['박지호', '3.5', true], ['최하은', '4.12', false],
      ['정우진', '2.5', true], ['강민서', '', false], ['윤채원', '4.0', true], ['임나래', '3.0', true]];
    people.forEach(([n, lv, self], i) => Core.apply(s, { type: 'rsvp', name: n, level: lv || undefined, levelSelf: self, status: 'yes' }, ctx(false, 'demo-' + i)));
    Core.apply(s, { type: 'rsvp', name: '한지민', status: 'no' }, ctx(false, 'demo-x'));
    Core.apply(s, { type: 'settings', fields: { balanceLevel: true } }, c);
    Core.apply(s, { type: 'draw' }, c);
    Core.apply(s, { type: 'start' }, c);
    // 1라운드 두 코트는 이미 끝난 상태로
    const scores = [[11, 7], [9, 11]];
    Core.allMatches(s).filter((m) => m.state === 'play').forEach((m, i) => {
      Core.apply(s, { type: 'score', mid: m.id, sa: scores[i][0], sb: scores[i][1], by: m.a[0] }, ctx(false, ''));
    });
    // 지금 경기 중인 코트는 몇 분 전에 시작한 것처럼
    Core.allMatches(s).forEach((m) => { if (m.state === 'play') { const real = Core.findMatch(s, m.id); real.startAt = Date.now() - (4 + Math.floor(Math.random() * 6)) * 60000; } });
    db = { [s.id]: s }; persist();
    try {
      const host = s.players.find((p) => p.src === 'host');
      const ev = {}; ev[s.id] = { k: s.hostKey, title: s.title, date: s.date, sport: s.sport, pid: host.id, hostPid: host.id, role: 'host', seen: Date.now() };
      localStorage.setItem('oc:events', JSON.stringify(ev));
    } catch (e) {}
    return s;
  }

  // ---------- 보는 사람 바꾸기 ----------
  function current() { const ids = Object.keys(db); return ids.length ? db[ids[ids.length - 1]] : null; }
  function viewAs(role) {
    const oc = window.__oc, A = oc.A;
    let s = current();
    if (!s) s = seed();
    A.drafts = {}; A.formErr = {}; A.tab = null; A.v = 0; A.watch = false; A.sheet = null;
    const sheet = document.getElementById('sheet'); if (sheet) { sheet.removeAttribute('data-open'); sheet.hidden = true; }
    document.querySelector('.app').inert = false; document.getElementById('dock').inert = false;
    if (role === 'home') { A.eid = null; A.k = null; A.pid = null; oc.render(); window.scrollTo(0, 0); return; }
    A.eid = s.id;
    if (role === 'host') { A.k = s.hostKey; A.pid = (s.players.find((p) => p.src === 'host') || {}).id || null; }
    else if (role === 'join') { A.k = null; A.pid = null; }
    else { A.k = null; A.pid = (s.players.find((p) => p.name === role) || {}).id || null; }
    A.loaded = false; oc.render(); oc.poll(); window.scrollTo(0, 0);
  }
  window.__ocGo = function (id, tab) {
    const A = window.__oc.A;
    let m = {}; try { m = (JSON.parse(localStorage.getItem('oc:events') || '{}'))[id] || {}; } catch (e) {}
    A.eid = id; A.k = m.k || null; A.pid = m.pid || null; A.tab = tab || null; A.v = 0; A.loaded = false; A.drafts = {};
    const sel = document.getElementById('demo-who'); if (sel) sel.value = A.k ? 'host' : 'join';
    window.__oc.render(); window.__oc.poll(); window.scrollTo(0, 0);
  };

  // 다른 코트 사람들이 결과를 넣은 것처럼
  function others() {
    const Core = window.Core, oc = window.__oc, A = oc.A;
    const s = db[A.eid] || current();
    if (!s || s.phase !== 'live') { oc.toast('경기 중일 때만 쓸 수 있습니다.', true); return; }
    const playing = Core.allMatches(s).filter((m) => m.state === 'play');
    const mine = (m) => A.pid && m.a.concat(m.b).includes(A.pid);
    const targets = playing.filter((m) => !mine(m));
    if (!targets.length) { oc.toast(playing.length ? '지금은 내 경기만 남았습니다. 내 결과를 넣어 보세요.' : '진행 중인 경기가 없습니다.', !playing.length); return; }
    targets.forEach((m) => {
      const w = Math.random() < 0.5, lose = Math.floor(Math.random() * 10);
      Core.apply(s, { type: 'score', mid: m.id, sa: w ? 11 : lose, sb: w ? lose : 11, by: m.a[1] }, ctx(false, ''));
    });
    persist();
    oc.toast(`다른 코트 ${targets.length}경기 결과가 들어왔습니다.`);
    oc.poll();
  }

  window.addEventListener('DOMContentLoaded', () => {
    const bar = document.getElementById('demo-bar');
    bar.addEventListener('change', (e) => { if (e.target.id === 'demo-who') viewAs(e.target.value); });
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.demo === 'others') others();
      if (b.dataset.demo === 'reset') {
        if (b.dataset.armed) { db = {}; persist(); try { localStorage.removeItem('oc:events'); } catch (er) {} seed(); delete b.dataset.armed; b.textContent = '처음 상태로'; viewAs(document.getElementById('demo-who').value); window.__oc.toast('예시 모임을 처음 상태로 되돌렸습니다.'); }
        else { b.dataset.armed = '1'; b.textContent = '한 번 더 누르면 초기화'; setTimeout(() => { delete b.dataset.armed; b.textContent = '처음 상태로'; }, 3000); }
      }
    });
  });
  window.addEventListener('load', () => {
    if (!current()) seed();
    viewAs(document.getElementById('demo-who').value);
  });
})();
