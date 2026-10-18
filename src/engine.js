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
