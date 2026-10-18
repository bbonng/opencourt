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
    if (!ctx.isHost && a.by && !playersOf(m).includes(a.by)) return err('이 경기에 뛴 사람만 결과를 넣을 수 있습니다.');
    const wasDone = m.state === 'done';
    // 같은 코트 사람들이 거의 동시에 누른 경우: 먼저 들어간 결과를 지키고, 고치기는 명시적으로만
    if (wasDone && !a.edit) {
      const who = m.by === 'host' ? '호스트' : ((s.players.find((p) => p.id === m.by) || {}).name || '다른 사람');
      return err(`${who} 님이 이미 결과를 넣었습니다 (${m.sa}:${m.sb}). 틀렸다면 기록에서 눌러 고쳐 주세요.`);
    }
    m.sa = sa; m.sb = sb; m.state = 'done'; m.by = a.by || (ctx.isHost ? 'host' : ''); m.at = ctx.now;
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
