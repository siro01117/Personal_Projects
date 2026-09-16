// node scripts/plan-selftest.mjs
// lib/plan-core.js 와 lib/plan-suggest.js 만 import 한다(supabase 없이 node 에서 바로 돈다).
import {
  normalize, expand, moveOnce, moveFollowing, removeOnce, removeFollowing,
  addDaysISO, dowOf, todayISO,
} from '../lib/plan-core.js';
import { freeIntervals, suggest, travelBlocks } from '../lib/plan-suggest.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

const T = todayISO();
const D = (n) => addDaysISO(T, n);

/* ------------------------------------------------------ 1. 주간 반복 전개 */
{
  const doc = normalize({
    events: [{
      id: 'gym', title: '운동', date: D(0), start: 420, end: 480,
      repeat: { freq: 'weekly', days: [dowOf(D(0)), dowOf(D(2))] }, color: 1,
    }],
  });
  const occs = expand(doc, [], D(0), D(13)); // 2주
  ok('weekly repeat expands to 4 occurrences over 2 weeks', occs.length === 4, `got ${occs.length}`);
}

/* ---------------------------------------------------- 2. exceptions skip */
{
  const doc = normalize({
    events: [{
      id: 'gym', title: '운동', date: D(0), start: 420, end: 480,
      repeat: { freq: 'weekly', days: [dowOf(D(0))] },
      exceptions: { [D(7)]: { skip: true } },
    }],
  });
  const occs = expand(doc, [], D(0), D(13));
  ok('exception skip removes that occurrence', occs.length === 1 && occs[0].date === D(0));
}

/* --------------------------------------- 3. exceptions 이동(범위 밖→안) */
{
  const doc = normalize({
    events: [{
      id: 'gym', title: '운동', date: D(0), start: 420, end: 480,
      repeat: { freq: 'weekly', days: [dowOf(D(0))] },
      exceptions: { [D(28)]: { date: D(5), start: 500, end: 560 } }, // 4주 뒤 회차를 이번주로 당김
    }],
  });
  const occs = expand(doc, [], D(0), D(6));
  const moved = occs.find((o) => o.moved && o.date === D(5));
  ok('exception moved-in from far outside range is included', !!moved, JSON.stringify(occs.map((o) => o.date)));
  ok('moved occurrence keeps original date/time in .original', moved && moved.original.date === D(28) && moved.original.start === 420);
}

/* ----------------------------------------------------- 4. moveFollowing */
{
  // 매주 월/수 반복, 3주치 만들고 두 번째 주 수요일부터 목요일로 옮긴다.
  const startMon = (() => { // 가장 가까운 월요일부터 시작 (안정적인 케이스를 위해 고정 날짜 사용)
    let d = D(0);
    while (dowOf(d) !== 1) d = addDaysISO(d, 1);
    return d;
  })();
  const wed1 = addDaysISO(startMon, 2);
  const wed2 = addDaysISO(startMon, 9);
  const doc = normalize({
    events: [{ id: 'ev1', title: '스터디', date: startMon, start: 600, end: 660, repeat: { freq: 'weekly', days: [1, 3] } }],
  });
  const occs = expand(doc, [], startMon, addDaysISO(startMon, 27));
  const target = occs.find((o) => o.date === wed2);
  const moved = moveFollowing(doc, target, { date: addDaysISO(wed2, 1), start: 700 }); // 목요일로, 3주째부터
  const oldEv = moved.events.find((e) => e.id === 'ev1');
  const newEv = moved.events.find((e) => e.id !== 'ev1');
  ok('moveFollowing splits: old event gets until = origDate-1', oldEv.repeat.until === addDaysISO(wed2, -1), oldEv.repeat.until);
  ok('moveFollowing creates a new event with new day substituted', newEv && newEv.repeat.days.includes(dowOf(addDaysISO(wed2, 1))) && newEv.repeat.days.includes(1));
  ok('moveFollowing new event starts at target date', newEv && newEv.date === addDaysISO(wed2, 1) && newEv.start === 700);

  // 시작일 자체를 옮기면 분할 없이 원본이 통째로 바뀐다.
  const target0 = occs.find((o) => o.date === startMon);
  const movedStart = moveFollowing(doc, target0, { date: addDaysISO(startMon, 1), start: 610 });
  ok('moveFollowing on the very first occurrence rewrites the original in place (no split)',
    movedStart.events.length === 1 && movedStart.events[0].date === addDaysISO(startMon, 1) && movedStart.events[0].start === 610);
}

/* ----------------------------------------------------- 5. removeFollowing */
{
  const doc = normalize({
    events: [{ id: 'ev2', title: '반복', date: D(0), start: 600, end: 660, repeat: { freq: 'daily' } }],
  });
  const occs = expand(doc, [], D(0), D(10));
  const third = occs[2];
  const removed = removeFollowing(doc, third);
  const ev = removed.events.find((e) => e.id === 'ev2');
  ok('removeFollowing sets until = origDate-1', ev.repeat.until === addDaysISO(third.date, -1));
  const occs2 = expand(removed, [], D(0), D(10));
  ok('removeFollowing removes it and everything after', occs2.every((o) => o.date < third.date));
}

/* -------------------------------------------------------- 6. removeOnce */
{
  const doc = normalize({
    events: [{ id: 'ev3', title: '반복', date: D(0), start: 600, end: 660, repeat: { freq: 'daily' } }],
  });
  const occs = expand(doc, [], D(0), D(3));
  const removed = removeOnce(doc, occs[1]);
  const occs2 = expand(removed, [], D(0), D(3));
  ok('removeOnce only removes that single occurrence', occs2.length === 3 && !occs2.some((o) => o.date === occs[1].date));
}

/* ------------------------------------------------------- 7. moveOnce */
{
  const doc = normalize({ events: [{ id: 'ev4', title: '단발', date: D(2), start: 600, end: 660 }] });
  const occs = expand(doc, [], D(0), D(10));
  const moved = moveOnce(doc, occs[0], { date: D(5), start: 700 });
  const occs2 = expand(moved, [], D(0), D(10));
  ok('moveOnce on a single event mutates the event directly', occs2.length === 1 && occs2[0].date === D(5) && occs2[0].start === 700 && occs2[0].end === 760);
}

/* ------------------------------------------------------- 8. classOverrides */
{
  const classes = [{
    courseId: 'c1', title: '무역학개론', color: 2, room: '경상관101', startDate: D(-14), endDate: D(60),
    meetings: [{ id: 'm1', day: dowOf(D(0)), start: 540, end: 630, room: '경상관101' }],
  }];
  const doc = normalize({});
  const occs = expand(doc, classes, D(0), D(13));
  ok('class meetings expand weekly', occs.filter((o) => o.source === 'class').length === 2);
  const target = occs.find((o) => o.source === 'class');
  const moved = moveOnce(doc, target, { date: D(1), start: 700 });
  const occs2 = expand(moved, classes, D(0), D(13));
  ok('class moveOnce records into classOverrides and reflects on expand', occs2.some((o) => o.source === 'class' && o.date === D(1) && o.start === 700));
}

/* -------------------------------------------------- 9. freeIntervals */
{
  const settings = { dayStart: 480, dayEnd: 1200, step: 30, buffer: 15 };
  const occs = [{ date: D(0), start: 600, end: 660, allDay: false }];
  const free = freeIntervals(occs, D(0), settings);
  ok('freeIntervals applies buffer around busy block', free.length === 2 && free[0].end === 585 && free[1].start === 675,
    JSON.stringify(free));

  const freeNow = freeIntervals(occs, D(0), settings, { nowMin: 500, todayISO: D(0) });
  ok('freeIntervals clamps to nowMin on today', freeNow[0].start === 500);
}

/* ------------------------------------------------------------ 10. suggest */
{
  const settings = { dayStart: 480, dayEnd: 1200, step: 30, buffer: 15 };
  const occs = [{ date: D(0), start: 600, end: 660, allDay: false }];
  const res = suggest({
    occurrences: occs, duration: 60, fromISO: D(0), days: 5, settings, nowISO: D(0),
    target: { date: D(0), start: 900 }, limit: 3,
  });
  ok('suggest excludes the original slot itself', !res.some((r) => r.date === D(0) && r.start === 900));
  ok('suggest returns candidates spread across dates when possible',
    new Set(res.map((r) => r.date)).size === Math.min(3, res.length), JSON.stringify(res));

  const withDue = suggest({
    occurrences: [], duration: 30, fromISO: D(0), days: 10, settings, nowISO: D(0),
    target: { due: D(2), priority: 'normal' }, limit: 5,
  });
  ok('suggest excludes candidates after the due date', withDue.every((r) => r.date <= D(2)), JSON.stringify(withDue.map((r) => r.date)));
}

/* --------------------------------------------- 11. 스큐 근무(읽기 전용) */
{
  const shifts = [
    { id: 'sc_a', date: D(1), start: 1200, end: 1290, kind: 'class', title: '공통수학1', place: '본점 1번' },
    { id: 'sc_b', date: D(30), start: 1200, end: 1290, kind: 'counter', title: '카운터', place: '본점' }, // 범위 밖
    null, // kv 가 이상하게 들어와도 그냥 무시돼야 한다
  ];
  const doc = normalize({});

  ok('normalize defaults showWork to true', doc.settings.showWork === true);
  ok('expand still works without the 5th argument (기존 호출 호환)', expand(doc, [], D(0), D(6)).length === 0);

  const occs = expand(doc, [], D(0), D(6), shifts);
  const work = occs.filter((o) => o.source === 'work');
  ok('work shifts expand only inside the range', work.length === 1 && work[0].date === D(1) && work[0].start === 1200,
    JSON.stringify(work.map((o) => o.date)));
  ok('work occurrence is a plain non-recurring block with title/place kept',
    work[0] && work[0].recurring === false && work[0].moved === false && work[0].allDay === false
    && work[0].important === false && work[0].title === '공통수학1' && work[0].place === '본점 1번'
    && work[0].original.date === D(1));

  const off = normalize({ settings: { showWork: false } });
  ok('showWork=false hides work entirely', expand(off, [], D(0), D(6), shifts).every((o) => o.source !== 'work'));

  // 빈 시간 제안은 expand 결과를 그대로 받으므로 근무도 자동으로 바쁜 시간이 된다.
  const settings = { dayStart: 480, dayEnd: 1380, step: 30, buffer: 0 };
  const free = freeIntervals(expand(doc, [], D(1), D(1), shifts), D(1), settings);
  ok('freeIntervals counts work as busy time',
    free.some((f) => f.end === 1200) && free.some((f) => f.start === 1290), JSON.stringify(free));
  const sug = suggest({
    occurrences: expand(doc, [], D(1), D(1), shifts), duration: 60, fromISO: D(1), days: 1,
    settings, nowISO: D(1), target: null, limit: 20,
  });
  ok('suggest never proposes a slot overlapping work', sug.every((c) => c.end <= 1200 || c.start >= 1290),
    JSON.stringify(sug.map((c) => c.start)));
}

/* ------------------------------------------------- 8. 이동시간 (지점 행렬) */
{
  // 집 --20-- 학교 --10-- 체육관 (집↔체육관은 안 적음 = 0)
  const settings = {
    dayStart: 480, dayEnd: 1380, step: 30, buffer: 0,
    homeId: 'home',
    places: [{ id: 'home', name: '집' }, { id: 'sch', name: '학교' }, { id: 'gym', name: '체육관' }],
    travel: { 'home|sch': 20, 'gym|sch': 10 },
  };
  const occ = (key, start, end, placeId, travelMin = null) => ({
    key, date: D(0), start, end, allDay: false, placeId, travelMin, title: key,
  });

  {
    const b = travelBlocks([occ('a', 600, 660, 'sch')], D(0), settings);
    // 집 → 학교 20분, 끝나고 학교 → 집 20분
    ok('집에서 나가고 돌아오는 이동이 잡힌다',
      b.length === 2 && b[0][0] === 580 && b[0][1] === 600 && b[1][0] === 660 && b[1][1] === 680,
      JSON.stringify(b));
  }
  {
    const b = travelBlocks([occ('a', 600, 660, 'sch'), occ('b', 700, 760, 'sch')], D(0), settings);
    // 같은 지점으로 이어지면 중간 이동이 없다 — 나갈 때와 돌아올 때 둘뿐
    ok('같은 지점끼리는 이동이 없다', b.length === 2, JSON.stringify(b));
  }
  {
    const b = travelBlocks([occ('a', 600, 660, 'sch'), occ('b', 700, 760, 'gym')], D(0), settings);
    ok('지점이 바뀌면 사이에 이동이 낀다',
      b.some(([x, y]) => x === 690 && y === 700), JSON.stringify(b));
    // 체육관 → 집은 행렬에 없다. 모르는 값을 지어내지 않는다
    ok('행렬에 없는 쌍은 0 으로 둔다', b.length === 2, JSON.stringify(b));
  }
  {
    const b = travelBlocks([occ('a', 600, 660, 'sch', 45)], D(0), settings);
    ok('일정에 적은 이동시간이 행렬을 이긴다',
      b[0][0] === 555 && b[0][1] === 600, JSON.stringify(b));
  }
  {
    const b = travelBlocks([occ('a', 600, 660, '', 30)], D(0), settings);
    ok('지점 없이 이동시간만 적어도 잡힌다', b.length === 1 && b[0][0] === 570, JSON.stringify(b));
  }
  {
    const b = travelBlocks([occ('a', 600, 660, 'sch')], D(0), { ...settings, homeId: '' });
    ok('집을 안 정하면 왕복을 세지 않는다', b.length === 0, JSON.stringify(b));
  }
  {
    const free = freeIntervals([occ('a', 600, 660, 'sch')], D(0), settings);
    // 08:00 ~ 09:40(580) · 11:20(680) 이후
    ok('빈 시간에서 이동시간이 빠진다',
      free[0].end === 580 && free[1].start === 680, JSON.stringify(free));
  }
  {
    const sug = suggest({
      occurrences: [occ('a', 600, 660, 'sch')], duration: 30, fromISO: D(0), days: 1,
      settings, nowISO: D(0), target: null, limit: 20,
    });
    ok('이동 구간에는 후보를 두지 않는다',
      sug.every((c) => c.end <= 580 || c.start >= 680),
      JSON.stringify(sug.filter((c) => c.end > 580 && c.start < 680)));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
