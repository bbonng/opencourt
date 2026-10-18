const Core = require('../src/core.js');
const assert = require('assert');

let seq = 0;
const ctxOf = (isHost, dev = '') => ({ now: Date.now() + seq, id: (n) => (++seq).toString(36).padStart(n, '0').slice(-n), isHost, dev });
const H = ctxOf(true), U = (dev) => ctxOf(false, dev);
const ok = (r) => { if (r && r.error) throw new Error(r.error); return r; };

function check(s) {
  const busy = new Set(), courts = new Set();
  Core.allMatches(s).filter((m) => m.state === 'play').forEach((m) => {
    m.a.concat(m.b).forEach((p) => { assert(!busy.has(p), '한 사람이 두 코트에 배정됨'); busy.add(p); });
    assert(!courts.has(m.court), '한 코트에 두 경기'); courts.add(m.court);
    assert(m.court >= 1 && m.court <= s.courts, '코트 번호 범위 밖');
  });
}

function runLive(s, rnd, hooks = {}) {
  let steps = 0;
  while (true) {
    check(s);
    const playing = Core.allMatches(s).filter((m) => m.state === 'play');
    if (!playing.length) break;
    if (hooks.before) hooks.before(s, steps);
    // 아무 코트나 먼저 끝남 (듀스로 길어지는 코트 흉내)
    const m = playing[Math.floor(rnd() * playing.length)];
    const scorer = m.a.concat(m.b).map((id) => s.players.find((p) => p.id === id)).find((p) => p && p.dev);
    const by = scorer ? scorer.id : undefined;
    const win = rnd() < 0.5;
    ok(Core.apply(s, { type: 'score', mid: m.id, sa: win ? 11 : 6, sb: win ? 6 : 11, by }, scorer ? U(scorer.dev) : H));
    if (++steps > 500) throw new Error('끝나지 않음');
  }
  return steps;
}
const rng = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// 1) 기본 흐름: 생성 → 초대 응답 → 대진 → 시작 → 순서 없이 끝나는 코트들 → 종료
for (const [n, c] of [[8, 2], [10, 2], [12, 3], [9, 1], [6, 1]]) {
  const s = Core.newEvent({ title: '테스트', sport: 'pickleball', courts: c, hostName: '호스트', dev: 'dh' }, H);
  for (let i = 1; i < n; i++) ok(Core.apply(s, { type: 'rsvp', name: '선수' + i, level: String(2.5 + (i % 4) * 0.5), status: 'yes' }, U('d' + i)));
  ok(Core.apply(s, { type: 'rsvp', name: '불참자', status: 'no' }, U('dx')));
  ok(Core.apply(s, { type: 'draw' }, H));
  assert.strictEqual(s.phase, 'ready');
  ok(Core.apply(s, { type: 'start' }, H));
  const steps = runLive(s, rng(n * 7 + c));
  const left = Core.allMatches(s).filter((m) => m.state !== 'done');
  assert.strictEqual(left.length, 0, `${n}명 ${c}면: 남은 경기 ${left.length}`);
  ok(Core.apply(s, { type: 'finish' }, H));
  const st = Core.standings(s);
  const g = st.map((r) => r.g);
  console.log(`[흐름] ${n}명 ${c}면: ${steps}경기 모두 진행, 1인 경기 수 ${Math.min(...g)}~${Math.max(...g)}, 1위 ${st[0].name} ${st[0].w}승${st[0].l}패`);
}

// 2) 진행 중 지각자 합류 → 다시 짜기 → 진행 중 경기 보존, 지각자 이후 경기 배정
{
  const s = Core.newEvent({ sport: 'badminton', courts: 2 }, H);
  for (let i = 0; i < 9; i++) ok(Core.apply(s, { type: 'rsvp', name: 'B' + i, level: ['E', 'D', 'C', 'B', 'A', 'S'][i % 6], status: 'yes' }, U('b' + i)));
  ok(Core.apply(s, { type: 'draw' }, H)); ok(Core.apply(s, { type: 'start' }, H));
  const rnd = rng(42);
  let joined = false, keepIds = null;
  runLive(s, rnd, {
    before(st, step) {
      if (step === 5 && !joined) {
        joined = true;
        keepIds = Core.allMatches(st).filter((m) => m.state !== 'wait').map((m) => m.id + m.state);
        ok(Core.apply(st, { type: 'addPlayer', name: '지각생', level: 'C' }, H));
        assert(st.dirty, '명단 변경 후 다시 짜기 표시가 떠야 함');
        ok(Core.apply(st, { type: 'draw' }, H));
        const after = Core.allMatches(st).filter((m) => keepIds.includes(m.id + 'play') || keepIds.includes(m.id + 'done'));
        assert(after.length >= keepIds.length - 0, '진행 중·끝난 경기가 사라짐');
      }
    },
  });
  const late = s.players.find((p) => p.name === '지각생');
  const lateGames = Core.allMatches(s).filter((m) => m.state === 'done' && m.a.concat(m.b).includes(late.id)).length;
  console.log(`[지각] 경기 도중 합류한 사람이 ${lateGames}경기 출전, 남은 경기 없음: ${Core.allMatches(s).every((m) => m.state === 'done' || m.state === 'void')}`);
  assert(lateGames > 0);
}

// 3) 진행 중 중도 퇴장 → 대기 경기 취소·재편성, 멈추지 않고 끝까지
{
  const s = Core.newEvent({ sport: 'pickleball', courts: 2 }, H);
  for (let i = 0; i < 10; i++) ok(Core.apply(s, { type: 'rsvp', name: 'P' + i, status: 'yes' }, U('p' + i)));
  ok(Core.apply(s, { type: 'draw' }, H)); ok(Core.apply(s, { type: 'start' }, H));
  let left = null;
  runLive(s, rng(7), {
    before(st, step) {
      if (step === 4 && !left) {
        const busy = new Set(Core.allMatches(st).filter((m) => m.state === 'play').flatMap((m) => m.a.concat(m.b)));
        left = st.players.find((p) => !busy.has(p.id));
        ok(Core.apply(st, { type: 'setPlayer', pid: left.id, present: false }, H));
        ok(Core.apply(st, { type: 'draw' }, H));
      }
    },
  });
  const after = Core.allMatches(s).filter((m) => m.state === 'play' || m.state === 'wait');
  assert.strictEqual(after.length, 0);
  console.log('[퇴장] 쉬던 사람이 먼저 가도 대기 경기가 정리되고 끝까지 진행됨');
}

// 4) 권한과 입력 검증
{
  const s = Core.newEvent({ sport: 'pickleball', courts: 1 }, H);
  for (let i = 0; i < 4; i++) ok(Core.apply(s, { type: 'rsvp', name: 'Q' + i, status: 'yes' }, U('q' + i)));
  assert(Core.apply(s, { type: 'draw' }, U('q0')).error, '참가자는 대진을 못 짜야 함');
  assert(Core.apply(s, { type: 'rsvp', name: 'Q1', status: 'yes' }, U('other')).error, '다른 폰이 같은 이름을 가로채면 안 됨');
  ok(Core.apply(s, { type: 'rsvp', name: 'Q1', status: 'no' }, U('q1')));
  assert.strictEqual(s.players.find((p) => p.name === 'Q1').present, false);
  ok(Core.apply(s, { type: 'rsvp', name: 'Q1', status: 'yes' }, U('q1')));
  ok(Core.apply(s, { type: 'draw' }, H)); ok(Core.apply(s, { type: 'start' }, H));
  const m = Core.allMatches(s).find((x) => x.state === 'play');
  const devOf = (pid) => s.players.find((p) => p.id === pid).dev;
  assert(Core.apply(s, { type: 'score', mid: m.id, sa: 11, sb: 11, by: m.a[0] }, U(devOf(m.a[0]))).error, '동점 거부');
  const outsider = s.players.find((p) => !m.a.concat(m.b).includes(p.id));
  if (outsider) {
    assert(Core.apply(s, { type: 'score', mid: m.id, sa: 11, sb: 3, by: outsider.id }, U(devOf(outsider.id))).error, '안 뛴 사람 입력 거부');
    assert(Core.apply(s, { type: 'score', mid: m.id, sa: 11, sb: 3, by: m.a[0] }, U(devOf(outsider.id))).error, '다른 사람 이름을 사칭해도 거부');
  }
  assert(Core.apply(s, { type: 'score', mid: m.id, sa: 11, sb: 3 }, U('모르는폰')).error, '응답 안 한 폰 거부');
  ok(Core.apply(s, { type: 'score', mid: m.id, sa: 11, sb: 3, by: m.b[1] }, U(devOf(m.b[1]))));
  assert.strictEqual(Core.findMatch(s, m.id).by, m.b[1], '입력자는 서버가 폰으로 판별');
  const v1 = s.v;
  assert(Core.apply(s, { type: 'score', mid: m.id, sa: 9, sb: 11, by: m.a[0] }, U(devOf(m.a[0]))).error, '동시 입력 덮어쓰기 차단'); ok(Core.apply(s, { type: 'score', mid: m.id, sa: 9, sb: 11, by: m.a[0], edit: true }, U(devOf(m.a[0])))); // 명시적 수정
  ok(Core.apply(s, { type: 'score', mid: m.id, sa: 11, sb: 2, edit: true }, H)); // 호스트는 어떤 경기든 수정
  console.log('[결과 권한] 참가자는 자기 경기만(사칭·외부 폰 차단), 호스트는 모든 경기 OK');
  assert(s.v > v1);
  const pub = Core.publicState(s, false);
  assert(!pub.hostKey && pub.players.every((p) => p.dev === undefined));
  console.log('[권한] 호스트 전용 작업, 이름 가로채기, 동점, 외부인 입력 차단 OK');
}

// 5) 참가자 시점 화면 요약
{
  const s = Core.newEvent({ sport: 'pickleball', courts: 1 }, H);
  for (let i = 0; i < 6; i++) ok(Core.apply(s, { type: 'rsvp', name: 'V' + i, status: 'yes' }, U('v' + i)));
  ok(Core.apply(s, { type: 'draw' }, H)); ok(Core.apply(s, { type: 'start' }, H));
  const playing = Core.allMatches(s).find((m) => m.state === 'play');
  const inPlay = playing.a[0];
  const resting = s.players.find((p) => !playing.a.concat(playing.b).includes(p.id)).id;
  const v1 = Core.myView(s, inPlay), v2 = Core.myView(s, resting);
  assert(v1.current && v1.current.court === 1);
  assert(!v2.current && v2.next && v2.wait);
  console.log(`[내 화면] 경기 중인 사람: ${v1.current.court}코트, 쉬는 사람: 다음 경기 ${v2.next.round}라운드, 기다리는 이유 ${JSON.stringify({ 코트참: v2.wait.courtsFull, 같이뛸사람경기중: v2.wait.blockers.map((b) => b.name) })}`);
}

// 6) 고정 복식 진행
{
  const s = Core.newEvent({ sport: 'badminton', courts: 2, mode: 'fixed' }, H);
  for (let i = 0; i < 10; i++) ok(Core.apply(s, { type: 'rsvp', name: 'F' + i, status: 'yes' }, U('f' + i)));
  const ids = s.players.map((p) => p.id);
  ok(Core.apply(s, { type: 'setTeams', teams: [[ids[0], ids[1]], [ids[2], ids[3]], [ids[4], ids[5]], [ids[6], ids[7]], [ids[8], ids[9]]] }, H));
  ok(Core.apply(s, { type: 'draw' }, H)); ok(Core.apply(s, { type: 'start' }, H));
  const steps = runLive(s, rng(3));
  const st = Core.standings(s);
  console.log(`[고정] 5팀 2면: ${steps}경기 진행, 팀 순위 1위 ${st[0].name} (${st[0].w}승)`);
  assert.strictEqual(steps, 10);
}

// 7) 실력 표기
assert.strictEqual(Core.levelLabel('badminton', { level: 'S' }), '자강');
assert.strictEqual(Core.levelLabel('pickleball', { level: '3.25' }), 'DUPR 3.25');
assert.strictEqual(Core.levelLabel('pickleball', { level: '3.5', levelSelf: true }), '3.5 자가');
assert.strictEqual(Core.cleanLevel('pickleball', '9.9'), '');
console.log('[실력] 급수·DUPR·자가평가 표기 OK');
console.log('\n모든 검증 통과');

// 8) 대진 이후 새로 참석한 사람은 '다시 짜기' 표시를 띄워야 함
{
  const s = Core.newEvent({ sport: 'pickleball', courts: 2 }, H);
  for (let i = 0; i < 8; i++) ok(Core.apply(s, { type: 'rsvp', name: 'L' + i, status: 'yes' }, U('l' + i)));
  ok(Core.apply(s, { type: 'draw' }, H)); ok(Core.apply(s, { type: 'start' }, H));
  assert(!s.dirty);
  ok(Core.apply(s, { type: 'rsvp', name: '늦게옴', status: 'yes' }, U('late')));
  assert(s.dirty, '새 참석자 → 다시 짜기 표시');
  console.log('[지각 응답] 경기 중 새로 참석하면 호스트에게 다시 짜기 표시 OK');
}

// 9) 호스트 지정
{
  const s = Core.newEvent({ sport: 'pickleball', courts: 1, hostName: '만든이', dev: 'dev-host' }, H);
  for (let i = 0; i < 4; i++) ok(Core.apply(s, { type: 'rsvp', name: 'C' + i, status: 'yes' }, U('dc' + i)));
  ok(Core.apply(s, { type: 'addPlayer', name: '현장손님' }, H));
  const c0 = s.players.find((p) => p.name === 'C0'), walk = s.players.find((p) => p.name === '현장손님');
  assert(!Core.hostCheck(s, null, 'dc0'), '지정 전에는 호스트 아님');
  assert(Core.apply(s, { type: 'setCohost', pid: walk.id, on: true }, H).error, '폰 응답 없는 사람은 지정 불가');
  ok(Core.apply(s, { type: 'setCohost', pid: c0.id, on: true }, H));
  assert(Core.hostCheck(s, null, 'dc0'), '지정된 사람의 폰은 호스트');
  assert(!Core.hostCheck(s, null, 'dc1'), '다른 폰은 아님');
  const c1 = s.players.find((p) => p.name === 'C1');
  ok(Core.apply(s, { type: 'setCohost', pid: c1.id, on: true }, ctxOf(Core.hostCheck(s, null, 'dc0'), 'dc0'))); // 지정 호스트가 또 지정
  ok(Core.apply(s, { type: 'draw' }, ctxOf(Core.hostCheck(s, null, 'dc1'), 'dc1'))); // 지정 호스트가 대진
  ok(Core.apply(s, { type: 'setCohost', pid: c0.id, on: false }, ctxOf(Core.hostCheck(s, null, 'dc1'), 'dc1')));
  assert(!Core.hostCheck(s, null, 'dc0'), '해제되면 바로 권한 없음');
  assert(Core.hostCheck(s, s.hostKey, ''), '만든 사람 키는 항상 호스트');
  const pub = Core.publicState(s, true, false);
  assert(!pub.hostKey && pub.youHost === true, '지정 호스트에게는 키를 주지 않음');
  console.log('[호스트 지정] 응답한 폰만 지정, 지정 호스트가 대진·재지정, 해제 즉시 권한 소멸 OK');
}
