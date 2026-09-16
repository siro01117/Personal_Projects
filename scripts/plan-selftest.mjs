// node scripts/plan-selftest.mjs
// lib/plan-core.js 와 lib/plan-suggest.js 만 import 한다(supabase 없이 node 에서 바로 돈다).
import {
  normalize, expand, moveOnce, moveFollowing, removeOnce, removeFollowing,
  addDaysISO, dowOf, todayISO, weekDays, weekLabel, mergePlan,
} from '../lib/plan-core.js';
import {
  dayCapacity, freeIntervals, lateHours, restBetween, suggest, travelBlocks,
} from '../lib/plan-suggest.js';

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

/* --------------------------------------------------------- 9. 피로도 */
{
  const base = {
    dayStart: 480, dayEnd: 1380, step: 30, buffer: 15,
    dailyLimit: 480, minRest: 30, places: [], travel: {}, homeId: '',
  };
  const cand = (start, dur = 60) => ({ date: D(0), start, end: start + dur });

  /* 1) 하루 총량 */
  {
    const light = dayCapacity(cand(600), { dayLoad: 120, settings: base });
    const full = dayCapacity(cand(600), { dayLoad: 460, settings: base });
    const over = dayCapacity(cand(600), { dayLoad: 700, settings: base });
    ok('한도의 절반 아래면 밀어준다', light.score > 0 && light.reason === '여유 있는 날');
    ok('한도를 막 넘기면 조금 깎는다', full.score < 0 && full.score > -3, String(full.score));
    ok('많이 넘길수록 더 깎되 바닥이 있다', over.score < full.score && over.score >= -8, String(over.score));
    ok('한도를 0 으로 두면 규칙이 꺼진다',
      dayCapacity(cand(600), { dayLoad: 900, settings: { ...base, dailyLimit: 0 } }) === null);
  }

  /* 2) 앞뒤 간격 */
  {
    const ctx = (busy) => ({ busy, settings: base });
    const tight = restBetween(cand(600), ctx([[480, 595]]));   // 앞 일정이 5분 전에 끝남
    const loose = restBetween(cand(600), ctx([[480, 540]]));   // 60분 떨어짐
    const both = restBetween(cand(600), ctx([[480, 595], [665, 700]])); // 앞뒤 다 붙음
    ok('앞 일정에 붙으면 깎는다', tight.score < 0, String(tight.score));
    ok('충분히 떨어지면 안 깎는다', loose.score === 0, String(loose.score));
    ok('앞뒤로 다 붙으면 더 깎는다', both.score < tight.score, `${both.score} vs ${tight.score}`);
    ok('휴식 기준을 0 으로 두면 규칙이 꺼진다',
      restBetween(cand(600), { busy: [[480, 595]], settings: { ...base, minRest: 0 } }) === null);
  }

  /* 3) 늦은 시각 */
  {
    const ctx = (dayLoad) => ({ dayLoad, settings: base });
    const noon = lateHours(cand(720), ctx(120));
    const night = lateHours(cand(1260), ctx(120));   // 21:00~22:00
    const nightHeavy = lateHours(cand(1260), ctx(460)); // 같은 시각인데 하루가 길었음
    ok('이른 시각은 안 깎는다', noon.score === 0, String(noon.score));
    ok('늦을수록 깎는다', night.score < 0, String(night.score));
    ok('하루가 길었으면 같은 늦은 시각을 더 깎는다',
      nightHeavy.score < night.score, `${nightHeavy.score} vs ${night.score}`);
  }

  /* 4) 합쳐서 — 꽉 찬 날보다 빈 날을 고른다 */
  {
    const heavy = [];
    for (let i = 0; i < 7; i += 1) {
      heavy.push({ key: `h${i}`, date: D(1), start: 480 + i * 70, end: 480 + i * 70 + 60, allDay: false, title: 'x' });
    }
    const sug = suggest({
      occurrences: heavy, duration: 60, fromISO: D(1), days: 2,
      settings: base, nowISO: D(1), target: null, limit: 3,
    });
    ok('꽉 찬 날 대신 다음 날을 먼저 권한다', sug[0].date === D(2), JSON.stringify(sug.map((c) => c.date)));
  }
}

/* ------------------------------------------------ 10. 이번 주는 월요일부터 */
{
  const wed = '2026-09-16'; // 수요일
  const w = weekDays(wed);
  ok('이번 주는 월요일에서 시작한다', w[0] === '2026-09-14' && dowOf(w[0]) === 1, w.join(','));
  ok('일요일에서 끝나고 7칸이다', w.length === 7 && w[6] === '2026-09-20' && dowOf(w[6]) === 0);
  ok('오늘이 맨 앞이 아니라 제 요일 자리에 있다', w.indexOf(wed) === 2);
  ok('월요일이면 그대로 시작', weekDays('2026-09-14')[0] === '2026-09-14');
  ok('일요일은 그 주의 끝으로 본다(다음 주 시작 아님)', weekDays('2026-09-20')[0] === '2026-09-14');
  ok('달이 바뀌어도 맞다', weekDays('2026-10-01')[0] === '2026-09-28');
}

{
  ok('주 이동 머리말', weekLabel(0) === '이번 주' && weekLabel(1) === '다음 주'
    && weekLabel(-1) === '지난 주' && weekLabel(3) === '3주 뒤' && weekLabel(-2) === '2주 전');
  // 수요일에서 다음 주로 넘기면 다음 월요일(9/21)이 들어온다 — 창성이형 밥약이 빠졌던 경우
  const next = weekDays(addDaysISO('2026-09-16', 7));
  ok('다음 주로 넘기면 다음 월요일부터', next[0] === '2026-09-21' && next.includes('2026-09-21'));
}

{
  // 자정을 넣으려다 00:00(0)이나 12:00(720)이 들어간 경우
  ok('하루 끝이 시작보다 앞이면 자정으로 본다', normalize({ settings: { dayStart: 480, dayEnd: 0 } }).settings.dayEnd === 1440);
  ok('정오처럼 시작보다 뒤면 그대로 둔다', normalize({ settings: { dayStart: 480, dayEnd: 720 } }).settings.dayEnd === 720);
  ok('자정(1440)은 그대로', normalize({ settings: { dayStart: 480, dayEnd: 1440 } }).settings.dayEnd === 1440);
  ok('하루를 넘는 값은 자정으로 자른다', normalize({ settings: { dayStart: 480, dayEnd: 2000 } }).settings.dayEnd === 1440);
  const free = freeIntervals([], '2026-09-16', normalize({ settings: { dayStart: 480, dayEnd: 0 } }).settings);
  ok('그래서 빈 시간이 다시 나온다', free.length === 1 && free[0].end === 1440, JSON.stringify(free));
}

/* --------------------------------------------- 11. 출근 · 귀가 · 외출 준비 */
{
  // 집 --35-- 스큐, 집 --30-- 부산대, 스큐 --70-- 부산대 (실제 설정과 같은 모양)
  const st = normalize({ settings: {
    dayStart: 480, dayEnd: 1440, buffer: 0, homeId: 'home', workPlaceId: 'cube', prepMin: 35,
    places: [{ id: 'home', name: '집' }, { id: 'cube', name: '스터디큐브' }, { id: 'pnu', name: '부산대' }],
    travel: { 'cube|home': 35, 'home|pnu': 30, 'cube|pnu': 70 },
  } }).settings;
  const D0 = '2026-09-16';
  const ev = (key, start, end, placeId) => ({ key, date: D0, start, end, allDay: false, placeId, title: key });

  {
    const b = travelBlocks([ev('work', 1200, 1290, 'cube')], D0, st);
    const labels = b.map((x) => x[2]).join(',');
    ok('근무만 있는 날: 외출 준비 → 출근 → 귀가', labels === '외출 준비,출근,귀가', labels);
    // 20:00 수업 → 출근 19:25 → 준비 18:50
    ok('준비는 출발 직전에 35분', b[0][0] === 1130 && b[0][1] === 1165 && b[1][0] === 1165 && b[1][1] === 1200,
      JSON.stringify(b));
    ok('귀가는 근무 끝나고 35분', b[2][0] === 1290 && b[2][1] === 1325);
  }
  {
    // 학교 → 근무: 집에서 한 번만 나간다 → 준비도 한 번
    const b = travelBlocks([ev('class', 600, 700, 'pnu'), ev('work', 1200, 1290, 'cube')], D0, st);
    ok('집에서 한 번 나가면 준비도 한 번', b.filter((x) => x[2] === '외출 준비').length === 1, JSON.stringify(b));
    ok('학교→스큐 이동은 출근', b.some((x) => x[2] === '출근' && x[1] === 1200 && x[0] === 1130));
    ok('학교 지점을 안 정했으면 학교로 가는 건 그냥 이동', b.some((x) => x[2] === '이동' && x[1] === 600));
    const b2 = travelBlocks([ev('class', 600, 700, 'pnu')], D0, { ...st, schoolPlaceId: 'pnu' });
    ok('학교 지점을 정하면 등교', b2.some((x) => x[2] === '등교' && x[1] === 600), JSON.stringify(b2));
  }
  {
    // 오전 학교 → 집 들렀다 → 저녁 근무: 두 번 나가므로 준비도 두 번
    const b = travelBlocks([ev('class', 600, 700, 'pnu'), ev('rest', 800, 900, 'home'), ev('work', 1200, 1290, 'cube')], D0, st);
    ok('집에 들렀다 다시 나가면 준비가 또 붙는다', b.filter((x) => x[2] === '외출 준비').length === 2, JSON.stringify(b));
    ok('집으로 가는 중간 이동도 귀가', b.some((x) => x[2] === '귀가' && x[1] === 800));
  }
  {
    const b = travelBlocks([ev('work', 1200, 1290, 'cube')], D0, { ...st, prepMin: 0 });
    ok('준비 0분이면 안 붙는다', !b.some((x) => x[2] === '외출 준비'));
  }
  {
    const shifts = [{ id: 'w1', date: D0, start: 1200, end: 1290, title: '공통수학1', place: '본점 1번' }];
    const occ = expand({ ...normalize({}), settings: st }, [], D0, D0, shifts);
    ok('스큐 근무에 근무지가 붙는다', occ[0]?.placeId === 'cube', JSON.stringify(occ[0]));
    const free = freeIntervals(occ, D0, st);
    ok('준비·출근·귀가가 빈 시간에서 빠진다', free.every((f) => f.end <= 1130 || f.start >= 1325), JSON.stringify(free));
  }
}

{
  // 수업에도 지점이 붙어야 '학교 → 스큐' 가 70분으로 잡힌다
  const st = normalize({ settings: {
    dayStart: 480, dayEnd: 1440, buffer: 0, homeId: 'home', workPlaceId: 'cube', schoolPlaceId: 'pnu', prepMin: 35,
    places: [{ id: 'home', name: '집' }, { id: 'cube', name: '스터디큐브' }, { id: 'pnu', name: '부산대' }],
    travel: { 'cube|home': 35, 'home|pnu': 30, 'cube|pnu': 70 },
  } }).settings;
  const D0 = '2026-09-16'; // 수요일(dow 3)
  const classes = [{ courseId: 'c1', title: '열린사고', color: 1, startDate: '2026-09-01', endDate: '2026-12-31',
    meetings: [{ id: 'm1', day: 3, start: 960, end: 1060 }] }];
  const shifts = [{ id: 'w1', date: D0, start: 1200, end: 1290, title: '공통수학1' }];
  const occ = expand({ ...normalize({}), settings: st }, classes, D0, D0, shifts);
  ok('수업에 수업 장소가 붙는다', occ.find((o) => o.source === 'class')?.placeId === 'pnu');
  const b = travelBlocks(occ, D0, st);
  ok('수업 → 근무 날은 학교에서 바로 출근(70분)', b.some((x) => x[2] === '출근' && x[0] === 1130 && x[1] === 1200), JSON.stringify(b));
  ok('준비는 아침 한 번(수업 가기 전)', b.filter((x) => x[2] === '외출 준비').length === 1
    && b.find((x) => x[2] === '외출 준비')[1] === 930, JSON.stringify(b));
}

/* ------------------------------------------------------- 12. 저장 시 합치기 */
{
  const ev = (id, title, date = '2026-09-18') => ({ id, title, date, start: 600, end: 660, allDay: false });
  const tk = (id, title) => ({ id, title });
  const base = normalize({ events: [ev('a', '밥약')], tasks: [], settings: { prepMin: 0 } });

  // 실제로 겪은 일: 밖에서 일정 8개 추가 → 열어둔 탭이 할 일 하나 추가해 저장
  {
    const server = normalize({ ...base, events: [...base.events, ev('x1', 'OT'), ev('x2', '아이디어톤')],
      tasks: [tk('t9', 'IDEA TREE')], settings: { ...base.settings, prepMin: 35 } });
    const local = normalize({ ...base, tasks: [tk('t1', '모니터 교체')] });
    const m = mergePlan(base, local, server);
    ok('밖에서 넣은 일정이 안 지워진다', m.events.map((e) => e.id).join() === 'a,x1,x2', m.events.map((e) => e.id).join());
    ok('양쪽 할 일이 다 남는다', m.tasks.map((t) => t.id).sort().join() === 't1,t9', m.tasks.map((t) => t.id).join());
    ok('밖에서 바꾼 설정이 유지된다', m.settings.prepMin === 35);
  }
  {
    const server = normalize({ ...base, events: [...base.events, ev('x1', 'OT')] });
    const local = normalize({ ...base, events: [] }); // 이 탭에서 밥약을 지움
    const m = mergePlan(base, local, server);
    ok('이 탭에서 지운 건 지워진다', !m.events.some((e) => e.id === 'a') && m.events.some((e) => e.id === 'x1'));
  }
  {
    const server = normalize({ ...base, events: [ev('a', '밥약(밖에서 고침)')] });
    const local = normalize({ ...base });
    const m = mergePlan(base, local, server);
    ok('이 탭이 안 건드린 일정은 서버 수정본을 따른다', m.events[0].title === '밥약(밖에서 고침)');
    const local2 = normalize({ ...base, events: [ev('a', '밥약(탭에서 고침)')] });
    ok('이 탭이 고친 일정은 탭 것이 이긴다', mergePlan(base, local2, server).events[0].title === '밥약(탭에서 고침)');
  }
  {
    const server = normalize({ ...base, settings: { ...base.settings, prepMin: 35 } });
    const local = normalize({ ...base, settings: { ...base.settings, dailyLimit: 360 } });
    const m = mergePlan(base, local, server);
    ok('설정은 키 단위로 합친다', m.settings.prepMin === 35 && m.settings.dailyLimit === 360);
  }
  {
    // base 를 모르는 옛 대기열: 지우지 않고 얹기만
    const server = normalize({ ...base, events: [...base.events, ev('x1', 'OT')] });
    const pending = normalize({ ...base, events: [ev('n1', '새 일정')] });
    const m = mergePlan(null, pending, server);
    ok('기준본을 모르면 지우지 않는다', ['a', 'x1', 'n1'].every((id) => m.events.some((e) => e.id === id)), m.events.map((e) => e.id).join());
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
