// node scripts/dash-selftest.mjs
// lib/dash-rules.js 만 import 한다(supabase 없이 node 에서 바로 돈다).
// 규칙은 순수 함수라 now 를 고정해서 경계값을 그대로 찌를 수 있다.
import { findMisses, countBySeverity, hasFinal, josa, T } from '../lib/dash-rules.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

const NOW = '2026-09-16T12:00:00.000Z';
const TODAY = '2026-09-16';
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();
const minsAgo = (n) => new Date(Date.parse(NOW) - n * 60000).toISOString();

const repo = (over = {}) => ({
  name: 'R', path: '/r', branch: 'main', upstream: 'origin/main',
  ahead: 0, behind: 0, unpushed: [], dirty: { n: 0, files: [] },
  lastCommit: { sha: 'abc', subject: '마지막', at: minsAgo(5) },
  ...over,
});
const snap = (over = {}) => ({
  at: minsAgo(5), host: 'D-', repos: [], vault: { ok: true, openItems: [], daily: null, notes: 0 }, ...over,
});
const run = (i) => findMisses({ now: NOW, today: TODAY, occurrences: [], ...i });
const ids = (m) => m.map((x) => x.id);
const find = (m, id) => m.find((x) => x.id === id);

/* ------------------------------------------------- 1. 대시보드 자기 점검 */
{
  const m = run({ snapshot: null });
  ok('스냅샷이 없으면 그 사실부터 알린다', find(m, 'snapshot:none')?.severity === 'high');
}
{
  const m = run({ snapshot: snap({ at: minsAgo(T.snapshotStaleMin + 5) }) });
  ok('수집이 멈추면 묵은 화면임을 알린다', !!find(m, 'snapshot:stale'));
}
{
  const m = run({ snapshot: snap({ at: minsAgo(T.snapshotStaleMin - 5) }) });
  ok('주기 안이면 조용하다', !find(m, 'snapshot:stale'));
}

/* ------------------------------------------- 2. 작업(저장소) 문구·판정 */
{
  const m = run({ snapshot: snap({ repos: [repo({ name: 'Personal_Projects', ahead: 1, unpushed: [{ sha: 'a', subject: 's', at: daysAgo(3) }] })] }) });
  const hit = find(m, 'git:unpushed:Personal_Projects');
  ok('폴더 이름 대신 부르는 이름을 쓴다',
    hit?.text.includes('라칸 포털') && !hit.text.includes('Personal_Projects'), hit?.text);
}

{
  const m = run({ snapshot: snap({ repos: [repo({
    ahead: 2, unpushed: [{ sha: 'b', subject: '새것', at: daysAgo(1) }, { sha: 'a', subject: '오래된 것', at: daysAgo(6) }],
  })] }) });
  const hit = find(m, 'git:unpushed:R');
  // 개수가 아니라 "가장 오래된 커밋의 나이"로 심각도를 매긴다
  ok('미푸시는 가장 오래된 커밋 나이로 급함 판정', hit?.severity === 'high', hit?.severity);
}
{
  const m = run({ snapshot: snap({ repos: [repo({
    ahead: 1, unpushed: [{ sha: 'a', subject: '방금', at: minsAgo(10) }],
  })] }) });
  ok('방금 커밋한 미푸시는 참고 수준', find(m, 'git:unpushed:R')?.severity === 'info');
}
{
  const m = run({ snapshot: snap({ repos: [repo({ dirty: { n: 3, files: ['a.js', 'b.js', 'c.js'] }, lastCommit: { sha: 'x', subject: 's', at: daysAgo(3) } })] }) });
  ok('오래된 미커밋 변경을 잡는다', find(m, 'git:dirty:R')?.severity === 'warn');
}
{
  const m = run({ snapshot: snap({ repos: [repo({ behind: 4 })] }) });
  ok('원격 뒤처짐은 먼저 받아오라고 말한다', find(m, 'git:behind:R')?.text.includes('받아온'));
}
{
  const m = run({ snapshot: snap({ repos: [repo({ branch: 'feat/x', upstream: null })] }) });
  ok('다른 갈래에 있으면 알린다', find(m, 'git:branch:R')?.text.includes('feat/x'));
}
{
  const m = run({ snapshot: snap({ repos: [repo()] }) });
  ok('깨끗한 레포는 아무 줄도 안 만든다', m.length === 0, JSON.stringify(ids(m)));
}

/* ------------------------------------------------------------ 3. 볼트 */
{
  const item = (over) => ({ note: 'N', path: 'p/N.md', heading: '미결', text: 't', done: false, ...over });
  const m = run({ snapshot: snap({ vault: { ok: true, notes: 1, daily: null, openItems: [
    item({ mtime: daysAgo(T.staleOpenDays + 1) }),
    item({ mtime: daysAgo(T.staleOpenDays + 1) }),
    item({ mtime: daysAgo(1) }),                       // 최근 것은 안 뜬다
    item({ mtime: daysAgo(99), done: true }),          // 끝난 건 안 뜬다
  ] } }) });
  const hit = find(m, 'vault:stale:p/N.md');
  ok('방치된 미결만, 노트 단위로 한 줄', !!hit && m.filter((x) => x.kind === 'note').length === 1);
  ok('노트 안에서 방치된 개수를 센다', hit?.text.includes('2가지'), hit?.text);
}
{
  const m = run({ snapshot: snap({ vault: { ok: true, notes: 1, openItems: [], daily: { date: '2026-09-14', note: 'd.md', mtime: daysAgo(2) } } }) });
  ok('오늘 데일리가 없으면 알린다', !!find(m, 'vault:daily'));
}
{
  const m = run({ snapshot: snap({ vault: { ok: true, notes: 1, openItems: [], daily: { date: TODAY, note: 'd.md', mtime: minsAgo(10) } } }) });
  ok('오늘 데일리가 있으면 조용하다', !find(m, 'vault:daily'));
}

/* --------------------------------------------------- 4. 할 일 · 겹침 */
{
  const plan = { events: [], tasks: [
    { id: 't1', title: '지난 것', due: '2026-09-14', done: false },
    { id: 't2', title: '곧', due: '2026-09-17', done: false },
    { id: 't3', title: '배치됨', due: '2026-09-17', done: false, slot: { date: '2026-09-17', start: 600 } },
    { id: 't4', title: '끝', due: '2026-09-10', done: true },
    { id: 't5', title: '먼 것', due: '2026-10-30', done: false },
  ] };
  const m = run({ snapshot: snap(), plan });
  ok('마감 지난 할 일은 급함', find(m, 'task:over:t1')?.severity === 'high');
  ok('마감 임박 + 미배치만 알린다', !!find(m, 'task:soon:t2') && !find(m, 'task:soon:t3'));
  ok('끝났거나 먼 할 일은 안 뜬다', !find(m, 'task:over:t4') && !find(m, 'task:soon:t5'));
}
{
  const occ = (key, start, end, title) => ({ key, start, end, title, allDay: false });
  const m = run({ snapshot: snap(), occurrences: [occ('a', 600, 720, '수업'), occ('b', 690, 780, '상담')] });
  ok('겹친 일정을 잡는다', !!m.find((x) => x.id.startsWith('plan:overlap:')));
}
{
  const occ = (key, start, end) => ({ key, start, end, title: key, allDay: false });
  const m = run({ snapshot: snap(), occurrences: [occ('a', 600, 660), occ('b', 660, 720)] });
  ok('딱 붙은 일정은 겹침이 아니다', !m.find((x) => x.id.startsWith('plan:overlap:')));
}

/* ------------------------------------------------------------ 5. 세션 */
{
  const sessions = { list: [
    { id: 's1', title: '멈춘 축', status: 'active', at: daysAgo(T.staleSessionDays + 1) },
    { id: 's2', title: '방금 한 축', status: 'active', at: minsAgo(30) },
    { id: 's3', title: '끝난 축', status: 'done', at: daysAgo(30) },
    { id: 's4', title: '물어본 축', status: 'active', at: minsAgo(30), awaiting: '이동시간 기준' },
  ] };
  const m = run({ snapshot: snap(), sessions });
  ok('오래 멈춘 축만 알린다', !!find(m, 'session:stale:s1') && !find(m, 'session:stale:s2'));
  ok('끝난 축은 안 뜬다', !find(m, 'session:stale:s3'));
  ok('답 대기는 따로 올린다', find(m, 'session:awaiting:s4')?.text.includes('이동시간 기준'));
}

/* ------------------------------------------------- 6. 문구는 한 문장 */
{
  const m = run({
    snapshot: snap({
      repos: [repo({ ahead: 2, unpushed: [{ sha: 'a', subject: 's', at: daysAgo(9) }], dirty: { n: 2, files: ['a', 'b'] }, behind: 1, branch: 'feat/x' })],
      vault: { ok: true, notes: 1, daily: { date: '2026-09-10', note: 'd.md', mtime: daysAgo(6) }, openItems: [
        { note: 'N', path: 'N.md', heading: '미결', text: '뭔가', done: false, mtime: daysAgo(40) },
      ] },
    }),
    plan: { events: [], tasks: [{ id: 'x', title: '과제', due: '2026-09-01', done: false }] },
    sessions: { list: [{ id: 's', title: '축', status: 'active', at: daysAgo(5), awaiting: '기준' }] },
    occurrences: [
      { key: 'a', start: 600, end: 720, title: '수업', allDay: false },
      { key: 'b', start: 690, end: 780, title: '상담', allDay: false },
    ],
  });
  ok('빠짐없이 문장이 붙는다', m.length > 8 && m.every((x) => typeof x.text === 'string' && x.text.length > 0));
  ok('제목/부연으로 쪼개지 않는다', m.every((x) => x.title === undefined && x.detail === undefined));
  ok('한 문장이다 — 줄바꿈 없이 마침표로 끝난다',
    m.every((x) => !/[\r\n]/.test(x.text) && /[.。]$/.test(x.text)),
    m.filter((x) => !/[.。]$/.test(x.text)).map((x) => x.text).join(' | '));
}

/* ------------------------------------------------------- 7. 정렬·집계 */
{
  const m = run({
    snapshot: snap({ repos: [repo({ ahead: 1, unpushed: [{ sha: 'a', subject: 's', at: daysAgo(9) }] }), repo({ name: 'R2', behind: 2 })] }),
    plan: { events: [], tasks: [{ id: 'x', title: '지난 것', due: '2026-09-01', done: false }] },
  });
  ok('급한 것이 맨 위로 온다', m[0].severity === 'high', m[0]?.id);
  const c = countBySeverity(m);
  ok('집계가 맞는다', c.high + c.warn + c.info === m.length);
}

/* ------------------------------------------------------------- 8. 조사 */
{
  // 이름이 데이터에서 오므로 받침을 보고 골라야 '라칸 포털를' 이 안 생긴다
  ok('받침 있는 한글', hasFinal('라칸 포털') && hasFinal('스터디큐브 본점') && hasFinal('헬스장'));
  ok('받침 없는 한글', !hasFinal('스터디큐브') && !hasFinal('부산대') && !hasFinal('회의'));
  ok('따옴표·괄호는 넘기고 그 앞 글자를 본다', hasFinal('‘라칸 포털’') && !hasFinal('‘스터디큐브’'));
  ok('숫자는 읽는 소리로', hasFinal('1') && hasFinal('3') && !hasFinal('2') && !hasFinal('5'));
  ok('알파벳은 엘·엠·엔·알만', hasFinal('plan') && !hasFinal('dash') && hasFinal('HTML'));
  ok('빈 값은 받침 없음으로', !hasFinal('') && !hasFinal(null) && !hasFinal(undefined));
  ok('josa 가 골라 붙인다',
    josa('라칸 포털', '을', '를') === '라칸 포털을' && josa('스터디큐브', '을', '를') === '스터디큐브를');
}

{
  // 실제 문장에서 확인 — 받침 유무가 다른 두 저장소
  const behind = (name) => run({ snapshot: snap({ repos: [repo({ name, behind: 2 })] }) })
    .find((x) => x.id.startsWith('git:behind:'))?.text;
  ok('받침에 맞는 조사로 문장이 나온다',
    behind('Personal_Projects').startsWith('라칸 포털을')
    && behind('studycube.cloud').startsWith('스터디큐브를'),
    `${behind('Personal_Projects')} / ${behind('studycube.cloud')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
