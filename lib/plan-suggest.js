// 일정(/plan) 빈 시간 계산 + 후보 제안 — 순수 함수. supabase 를 절대 import 하지 않는다.
//
// 이동시간은 scorer 가 아니라 **바쁜 시간**으로 반영한다(travelBlocks). 오가는 시간은
// 선호가 아니라 물리적으로 못 쓰는 시간이라, 감점보다 빈 구간에서 빼는 게 맞다.
//
// 피로도는 세 가지 감점으로 나눠 넣었다 — 하루 총량(dayCapacity) · 앞뒤 간격(restBetween) ·
// 늦은 시각(lateHours). 일정별 강도 태그는 일부러 넣지 않았다: 일정을 넣을 때마다
// 태그를 고르는 수고가 생기는데 위 셋은 이미 있는 데이터만으로 계산된다.
//
// 확장 지점: 선호(예: 피로도)를 반영하려면 새 scorer 함수를
// (cand, ctx) => ({ score, reason? }) 모양으로 만들어 아래 DEFAULT_SCORERS 배열에
// 추가하면 된다. suggest() 는 scorers 를 그대로 순회해 점수를 합산하므로 이 파일의
// 나머지 부분은 건드릴 필요가 없다. ctx 에는 dayLoad(이동 포함)·occurrences·settings 가 있다.
import { addDaysISO, diffDaysISO, travelMinutes } from './plan-core.js';

/**
 * 하루의 이동 구간 목록 — [시작, 끝, 이름표('외출 준비'|'출근'|'등교'|'귀가'|'이동')].
 * 일정 사이를 오가는 시간과 나가기 전 준비 시간은 실제로 비어 있지 않으므로 바쁜 시간으로 친다.
 *
 * 규칙
 * - 하루는 settings.homeId(집)에서 시작해 집으로 끝난다. homeId 가 없으면 왕복을 안 센다.
 * - 지점이 같으면 0. 행렬에 없는 쌍도 0 — 모르는 건 지어내지 않는다.
 * - 일정에 travelMin 이 직접 적혀 있으면(일회성) 행렬보다 우선한다.
 * - 지점도 travelMin 도 없는 일정·할 일은 이동을 만들지 않고 직전 위치를 유지한다.
 *   대신 준비·이동과 겹치면 준비·이동이 비켜 간다(들어갈 땐 일찍, 나올 땐 늦게).
 */
// 밖에서 틈이 생겼을 때 집에 들르려면 집에 적어도 이만큼은 있을 수 있어야 한다(분)
// 집이 학교와 스터디큐브 사이라 들르는 게 손해가 적다 → 50분만 있어도 들른다
export const HOME_STAY_MIN = 50;
// 아침에 이미 준비하고 나갔다면, 집에 들렀다 다시 나갈 땐 준비를 이만큼만(분)
export const REPREP_MIN = 10;

export function travelBlocks(occurrences, dateISO, settings) {
  const all = occurrences
    .filter((o) => o.date === dateISO && !o.allDay && o.start != null && o.end != null)
    .sort((a, b) => a.start - b.start);
  if (!all.length) return [];

  // 지점도 직접 적은 이동시간도 없는 일정·할 일은 동선을 만들지 않는다('떠 있는 것').
  // 대신 준비·이동이 이것과 겹치면 준비·이동을 비켜 옮긴다(아래 resolve).
  const floats = all.filter((o) => !o.placeId && !(o.travelMin > 0));
  const timed = all.filter((o) => o.placeId || o.travelMin > 0);

  const home = settings?.homeId || '';
  const work = settings?.workPlaceId || '';
  const prep = Math.max(0, Number(settings?.prepMin ?? 0));
  const school = settings?.schoolPlaceId || '';
  // 이름표 — 근무지로 가면 출근, 학교로 가면 등교, 집으로 오면 귀가. 모양은 [시작, 끝, 이름표]
  const label = (to) => (!to ? '이동' : to === work ? '출근' : to === school ? '등교' : to === home ? '귀가' : '이동');

  // 먼저 '다리'(leg)만 모은다 — 들어가는 다리는 도착 시각에, 나오는 다리는 출발 시각에 붙는다.
  //   in : { arrive, travel, prep, label, floor }  준비+이동이 arrive 로 끝난다. floor 이전으로는 못 당긴다
  //   out: { depart, travel, label, ceil }          depart 에 출발한다. 도착이 ceil 을 넘으면 못 늦춘다
  const legs = [];
  let prepped = false;     // 오늘 이미 한 번 준비하고 나갔는지
  const reprep = Math.min(prep, REPREP_MIN);
  let at = home;           // 직전에 있던 지점
  let lastKnownEnd = null; // 지점이 확인된 마지막 일정의 끝

  for (const o of timed) {
    const to = o.placeId || '';
    const own = o.travelMin != null && o.travelMin > 0 ? o.travelMin : null;
    // 밖에서 다음 일정까지 틈이 길면 집에 들렀다 온다. 몇 시간씩 밖에서 기다린다고 보면
    // '오전에 학원 가서 저녁 근무까지 대기' 같은 비현실적인 동선이 나온다.
    // 귀가·준비·재출발을 빼고도 집에서 HOME_STAY_MIN 이상 있을 수 있을 때만 들른다.
    if (home && at && at !== home && to && to !== home && lastKnownEnd != null) {
      const back = travelMinutes(settings, at, home);
      const again = travelMinutes(settings, home, to);
      if (back > 0 && again > 0 && o.start - lastKnownEnd - (back + reprep + again) >= HOME_STAY_MIN) {
        legs.push({ kind: 'out', depart: lastKnownEnd, travel: back, label: '귀가', ceil: o.start - again - reprep });
        at = home;
      }
    }
    const mins = own != null ? own : travelMinutes(settings, at, to);
    // 집에서 다른 곳으로 나갈 때만 이동 앞에 준비 시간을 붙인다. 이동시간을 모르는 쌍이어도
    // 나가는 건 확실하므로 준비는 붙인다. 중간에 집에 들렀다 다시 나가면 또 붙는다.
    const leavingHome = home && at === home && (to ? to !== home : own != null);
    const p = leavingHome ? (prepped ? reprep : prep) : 0;
    if (leavingHome) prepped = true;
    if (mins > 0 || p > 0) {
      legs.push({
        kind: 'in', arrive: o.start, travel: Math.max(0, mins), prep: p, label: label(to),
        floor: lastKnownEnd ?? 0,
      });
    }
    if (to) { at = to; lastKnownEnd = o.end; }
    else if (own != null) lastKnownEnd = o.end;
  }

  if (home && at && at !== home && lastKnownEnd != null) {
    const back = travelMinutes(settings, at, home);
    if (back > 0) legs.push({ kind: 'out', depart: lastKnownEnd, travel: back, label: '귀가', ceil: 1440 });
  }

  // 떠 있는 것과 겹치면 비켜 옮긴다.
  //  - 들어가는 다리: 더 일찍 나선다. 떠 있는 것은 도착해서 하는 것으로 본다
  //  - 나오는 다리: 더 늦게 나선다. 떠 있는 것을 마치고 출발한다
  // 앞(뒤) 일정 때문에 옮길 자리가 없으면 원래 자리에 둔다 — 그 겹침은 그대로 남아 checkSlot 이 막는다.
  const hits = (a, b) => floats.filter((f) => f.start < b && a < f.end);
  const out = [];
  for (const leg of legs) {
    if (leg.kind === 'in') {
      let end = leg.arrive;
      for (let guard = 0; guard < 20; guard += 1) {
        const hit = hits(end - leg.travel - leg.prep, end).filter((f) => f.end <= leg.arrive);
        if (!hit.length) break;
        end = Math.min(...hit.map((f) => f.start));
      }
      if (end - leg.travel - leg.prep < leg.floor) end = leg.arrive; // 당길 자리가 없다
      if (leg.travel > 0) out.push([end - leg.travel, end, leg.label]);
      if (leg.prep > 0) out.push([end - leg.travel - leg.prep, end - leg.travel, '외출 준비']);
    } else {
      let start = leg.depart;
      for (let guard = 0; guard < 20; guard += 1) {
        const hit = hits(start, start + leg.travel).filter((f) => f.start >= leg.depart);
        if (!hit.length) break;
        start = Math.max(...hit.map((f) => f.end));
      }
      if (start + leg.travel > leg.ceil) start = leg.depart; // 늦출 자리가 없다
      out.push([start, start + leg.travel, leg.label]);
    }
  }
  return out.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
}

/**
 * dateISO 하루 안에서 비어 있는 구간을 계산한다.
 * settings.buffer 만큼 앞뒤 여유를 두고 바쁜 구간을 빼고, 이동 구간도 바쁜 것으로 친다.
 * opts.nowMin 이 있고 dateISO 가 opts.todayISO 와 같으면 그 이전 시간은 후보에서 뺀다.
 */
/**
 * 하루의 바쁜 구간(일정 + 이동)을 겹침 없이 병합해 돌려준다.
 * buffer 는 일정에만 붙인다 — 이동은 여유가 아니라 이미 쓰고 있는 시간이다.
 */
export function busyIntervals(occurrences, dateISO, settings, buffer = 0) {
  const dayStart = Number(settings?.dayStart ?? 480);
  const dayEnd = Number(settings?.dayEnd ?? 1380);

  const busy = occurrences
    .filter((o) => o.date === dateISO && !o.allDay && o.start != null && o.end != null)
    .map((o) => [Math.max(dayStart, o.start - buffer), Math.min(dayEnd, o.end + buffer)])
    .concat(
      travelBlocks(occurrences, dateISO, settings)
        .map(([a, b]) => [Math.max(dayStart, a), Math.min(dayEnd, b)]),
    )
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
    else merged.push([...b]);
  }
  return merged;
}

export function freeIntervals(occurrences, dateISO, settings, opts = {}) {
  const dayStart = Number(settings?.dayStart ?? 480);
  const dayEnd = Number(settings?.dayEnd ?? 1380);
  const buffer = Number(settings?.buffer ?? 0);

  let lo = dayStart;
  if (opts.nowMin != null && opts.todayISO === dateISO) lo = Math.max(lo, opts.nowMin);
  if (lo >= dayEnd) return [];

  const merged = busyIntervals(occurrences, dateISO, settings, buffer);

  const free = [];
  let cur = lo;
  for (const [s, e] of merged) {
    if (s > cur) free.push({ start: cur, end: Math.min(s, dayEnd) });
    cur = Math.max(cur, e);
  }
  if (cur < dayEnd) free.push({ start: cur, end: dayEnd });
  return free.filter((f) => f.end > f.start);
}

function dayLoadOf(occurrences, dateISO, settings) {
  const events = occurrences
    .filter((o) => o.date === dateISO && !o.allDay && o.start != null && o.end != null)
    .reduce((s, o) => s + (o.end - o.start), 0);
  // 오가는 시간도 그 날의 부담이다 — lightDay scorer 가 이걸 같이 본다
  const travel = travelBlocks(occurrences, dateISO, settings)
    .reduce((s, [a, b]) => s + (b - a), 0);
  return events + travel;
}

/* ------------------------------------------------------------ scorers */

// 옮기기: 원래 시작 시각과 가까울수록 가점.
function sameTime(cand, ctx) {
  if (!ctx.target || ctx.target.start == null) return null;
  const diff = Math.abs(cand.start - ctx.target.start);
  const score = Math.max(0, 8 - diff / 30);
  return { score, reason: diff <= 30 ? '같은 시간대' : undefined };
}

// 원래 날짜(옮기기) 또는 오늘(할 일)에 가까울수록 가점.
function nearDate(cand, ctx) {
  const base = ctx.target?.date || ctx.todayISO;
  if (!base) return null;
  const d = Math.abs(diffDaysISO(base, cand.date));
  const score = Math.max(0, 5 - d);
  return { score, reason: d <= 1 ? '가까운 날짜' : undefined };
}

// 그 날 이미 바쁜 정도가 적을수록 가점. (이유 문구는 dayCapacity 가 단다 — 둘이
// 같은 말을 두 번 하면 후보마다 '여유 있는 날'이 겹쳐 붙는다.)
function lightDay(cand, ctx) {
  return { score: Math.max(0, 4 - ctx.dayLoad / 60) };
}

// 할 일: 마감 이후는 완전히 제외, 마감이 가까울수록 약하게 감점(급하니 빨리 배치되게),
// 우선순위 high 면 이른 날짜에 가점.
function beforeDue(cand, ctx) {
  const t = ctx.target;
  if (!t || !t.due) return null;
  if (cand.date > t.due) return { score: -Infinity, why: '마감이 지난 날' };
  const daysToDue = diffDaysISO(cand.date, t.due);
  let score = Math.max(0, 2 - daysToDue * 0.15);
  if (t.priority === 'high') score += Math.max(0, 4 - daysToDue * 0.5);
  return { score };
}

// 너무 이른 시각은 약하게 감점. 늦은 시각은 dayCapacity/lateHours 가 따로 본다.
function reasonableHours(cand) {
  return { score: cand.start < 8 * 60 ? -3 : 0 };
}

/* ------------------------------------------------- 피로도 (전부 감점형) */

// 1) 하루 총량 — 일정+이동에 이 후보까지 더해 settings.dailyLimit 을 넘으면
//    넘긴 만큼 감점한다. "못 넣는다"가 아니라 "덜 권한다".
export function dayCapacity(cand, ctx) {
  const limit = Number(ctx.settings?.dailyLimit ?? 0);
  if (limit <= 0) return null;
  const total = ctx.dayLoad + (cand.end - cand.start);
  const over = total - limit;
  if (over <= 0) {
    // 한도의 절반도 안 찬 날은 가볍게 밀어준다
    return { score: total <= limit / 2 ? 1.5 : 0, reason: total <= limit / 2 ? '여유 있는 날' : undefined };
  }
  return { score: -Math.min(8, over / 30) };
}

// 2) 앞뒤 일정과의 간격 — settings.minRest 만큼 못 띄우면 모자란 만큼 감점.
//    freeIntervals 의 buffer 가 "아예 불가능한 거리"라면 이쪽은 "가능하지만 빡빡한 거리"다.
export function restBetween(cand, ctx) {
  const rest = Number(ctx.settings?.minRest ?? 0);
  if (rest <= 0 || !ctx.busy?.length) return null;

  let before = Infinity, after = Infinity;
  for (const [s, e] of ctx.busy) {
    if (e <= cand.start) before = Math.min(before, cand.start - e);
    if (s >= cand.end) after = Math.min(after, s - cand.end);
  }
  const short = (gap) => (gap === Infinity ? 0 : Math.max(0, rest - gap));
  const lack = short(before) + short(after);
  if (lack <= 0) return { score: 0 };
  return { score: -Math.min(6, lack / 10) };
}

// 3) 늦은 시각 — 고정 감점이 아니라 늦을수록 점점, 그리고 그 날이 이미 길었으면 더.
//    하루가 길었으면 더 일찍 접는 쪽으로 기운다.
export function lateHours(cand, ctx) {
  const dayEnd = Number(ctx.settings?.dayEnd ?? 1380);
  const soft = dayEnd - 120; // 하루 끝 2시간 전부터 슬슬 감점
  if (cand.end <= soft) return { score: 0 };
  const late = (cand.end - soft) / 60;
  const limit = Number(ctx.settings?.dailyLimit ?? 0);
  const heavy = limit > 0 ? Math.max(0, ctx.dayLoad / limit - 0.6) : 0;
  return { score: -(late * 1.5 + late * heavy * 3) };
}

/* ------------------------------------------------------------ 동선 */

// 장소가 정해진 일정·할 일(target.placeId)은 그 자리에 넣었을 때의 동선을 **실제로 다시 계산**한다.
// 화면의 출근·귀가와 같은 travelBlocks 를 그대로 써서, 후보를 넣기 전·후의 이동을 비교한다.
//  - 이동·준비가 기존 일정이나 후보 자신과 **새로** 부딪치면 제외(원래 빡빡했던 건 탓하지 않는다)
//  - 늘어난 이동이 10분 이하면 '가는 길에' 가점, 그보다 많으면 늘어난 만큼 감점
export function routeFit(cand, ctx) {
  const placeId = ctx.target?.placeId;
  const own = ctx.target?.travelMin > 0 ? ctx.target.travelMin : null;
  if (!placeId && own == null) return null;
  const s = ctx.settings;
  const day = ctx.occurrences.filter(
    (o) => o.date === cand.date && !o.allDay && o.start != null && o.end != null,
  );
  const probe = {
    key: '__cand', date: cand.date, start: cand.start, end: cand.end, allDay: false,
    placeId: placeId || '', travelMin: own,
  };
  const withCand = [...day, probe];
  const before = travelBlocks(day, cand.date, s);
  const after = travelBlocks(withCand, cand.date, s);

  const clashes = (blocks, list) => blocks.filter(([a, b]) => list.some((o) => a < o.end && o.start < b)).length;
  if (clashes(after, withCand) > clashes(before, day)) return { score: -Infinity, why: '오가는 길이 앞뒤 일정과 부딪침' };

  const total = (bs) => bs.reduce((t, [a, b]) => t + (b - a), 0);
  const added = total(after) - total(before);
  if (added <= 10) return { score: 3, reason: '가는 길에' };
  return { score: -Math.min(8, added / 15), reason: `이동 +${added}분` };
}

/* ------------------------------------------------------------ 식사 */

// 고정 일정이 아니라 **그 날 비는 자리에 맞춰 떠다니는** 추천이다. 일정이 바뀌면 같이 옮겨간다.
// 창(from~to) 안의 빈 자리 중 원하는 시각(ideal)에 가장 가까운 곳을 고른다. 이동·준비 시간도 피한다.
export const MEALS = [
  { key: 'lunch', label: '점심', from: 660, to: 840, ideal: 720 },   // 11:00–14:00, 12:00 선호
  { key: 'dinner', label: '저녁', from: 1020, to: 1230, ideal: 1080 }, // 17:00–20:30, 18:00 선호
];
const MEAL_FLOOR = 20; // 이보다 짧으면 '먹을 틈이 없다'로 본다
// 제목에 이런 말이 있는 일정이 식사 창에 걸치면 그 끼니는 그 일정으로 해결된 것으로 본다
// (창성이형 밥약 · 동아리 회식 · 가족 저녁 …). 따로 추천하면 두 번 먹으라는 얘기가 된다.
const MEAL_WORDS = /밥|식사|회식|점심|저녁|브런치|런치|디너|맛집|뒤풀이/;

export function mealSlots(occurrences, dateISO, settings) {
  const want = Math.max(0, Number(settings?.mealMin ?? 40));
  if (!want) return [];
  const hasDay = occurrences.some((o) => o.date === dateISO && !o.allDay && o.start != null && o.end != null);
  if (!hasDay) return []; // 아무 일정 없는 날은 굳이 표시하지 않는다
  // 식사 창이 하루 시작·끝 설정에 잘리지 않게 하루 전체를 본다
  const busy = busyIntervals(occurrences, dateISO, { ...settings, dayStart: 0, dayEnd: 1440 }, 0);
  const taken = [];
  const out = [];
  const mealEvents = occurrences.filter((o) => o.date === dateISO && !o.allDay && o.start != null
    && o.end != null && MEAL_WORDS.test(o.title || ''));
  for (const m of MEALS) {
    const by = mealEvents.find((o) => o.start < m.to && m.from < o.end);
    if (by) {
      out.push({ key: m.key, label: m.label, start: by.start, end: by.end, covered: true, by: by.title });
      continue;
    }
    const blocks = [...busy, ...taken].sort((a, b) => a[0] - b[0]);
    const free = [];
    let cur = m.from;
    for (const [a, b] of blocks) {
      if (b <= cur) continue;
      if (a >= m.to) break;
      if (a > cur) free.push([cur, Math.min(a, m.to)]);
      cur = Math.max(cur, b);
    }
    if (cur < m.to) free.push([cur, m.to]);

    let best = null;
    for (const [a, b] of free) {
      const len = Math.min(want, b - a);
      if (len < MEAL_FLOOR) continue;
      // 원하는 시각에 가장 가깝게, 5분 단위로
      const lo = a, hi = b - len;
      let start = Math.round(Math.min(Math.max(m.ideal, lo), hi) / 5) * 5;
      if (start < lo) start = lo;
      if (start > hi) start = hi;
      const cost = (len < want ? 1000 : 0) + Math.abs(start - m.ideal);
      if (!best || cost < best.cost) best = { start, len, cost };
    }
    if (best) {
      out.push({ key: m.key, label: m.label, start: best.start, end: best.start + best.len, short: best.len < want });
      taken.push([best.start, best.start + best.len]);
    } else {
      out.push({ key: m.key, label: m.label, start: m.ideal, end: m.ideal, missing: true });
    }
  }
  return out;
}

// 후보를 넣었을 때 식사 자리가 사라지면(원래 제대로 들어가던 끼니가 짧아지거나 없어지면) 감점.
// 식사는 떠다니는 추천이라 못 넣는 건 아니고, 다른 자리가 있으면 그쪽을 먼저 권하는 정도다.
export function mealRoom(cand, ctx) {
  if (!(Number(ctx.settings?.mealMin ?? 40) > 0)) return null;
  const day = ctx.occurrences.filter((o) => o.date === cand.date);
  const probe = {
    key: '__cand', date: cand.date, start: cand.start, end: cand.end, allDay: false,
    placeId: ctx.target?.placeId || '', travelMin: ctx.target?.travelMin ?? null,
  };
  const good = (xs) => mealSlots(xs, cand.date, ctx.settings).filter((m) => !m.missing && !m.short && !m.covered).length;
  const lost = good(day) - good([...day, probe]);
  return { score: lost > 0 ? -4 * lost : 0 };
}

export const DEFAULT_SCORERS = [
  sameTime, nearDate, lightDay, beforeDue, reasonableHours,
  dayCapacity, restBetween, lateHours, routeFit, mealRoom,
];

// 후보 한 칸의 점수 — suggest() 와 시간표 끌어넣기(checkSlot)가 같은 판정을 쓴다.
export function scoreCandidate(cand, ctx, scorers = DEFAULT_SCORERS) {
  let score = 0;
  const reasons = [];
  for (const scorer of scorers) {
    const r = scorer(cand, ctx);
    if (!r) continue;
    if (r.score === -Infinity) return { excluded: true, why: r.why || '넣을 수 없는 자리', score: -Infinity, reasons };
    score += r.score;
    if (r.reason) reasons.push(r.reason);
  }
  return { excluded: false, score, reasons: [...new Set(reasons)] };
}

/**
 * 사람이 시간표에서 직접 고른 자리를 평가한다. 제안과 달리 하루 시작·끝 설정과 버퍼로
 * 막지 않는다(사람이 고른 것이므로) — 대신 지난 시간·기존 일정·이동과의 겹침은 막고,
 * 나머지는 제안과 같은 이유표(가는 길에 · 이동 +N분 …)로 알려준다.
 * -> { ok, why? , score?, reasons? }
 */
export function checkSlot({ occurrences, date, start, duration, settings, target, todayISO, nowMin }) {
  const cand = { date, start, end: start + duration };
  if (date < todayISO || (date === todayISO && nowMin != null && start < nowMin)) {
    return { ok: false, why: '지난 시간' };
  }
  if (cand.end > 1440) return { ok: false, why: '자정을 넘김' };
  const day = occurrences.filter((o) => o.date === date && !o.allDay && o.start != null && o.end != null);
  if (day.some((o) => o.start < cand.end && cand.start < o.end)) {
    return { ok: false, why: '다른 일정과 겹침' };
  }
  // 이동·준비는 고정이 아니다 — 이 할 일을 넣은 뒤 다시 계산한 동선과 부딪치는지 본다.
  // (장소 없는 할 일은 동선을 바꾸지 않으니, 기존 출근·준비 시간과 겹치면 그대로 막힌다)
  const probe = {
    key: '__cand', date, start, end: cand.end, allDay: false,
    placeId: target?.placeId || '', travelMin: target?.travelMin ?? null,
  };
  const before = travelBlocks(day, date, settings);
  const after = travelBlocks([...day, probe], date, settings);
  if (after.some(([a, b]) => a < cand.end && cand.start < b)) {
    return { ok: false, why: '준비·이동을 옮길 틈이 없음' };
  }
  // 이 자리에 넣으면 준비·출발·귀가가 밀린다 — 무엇이 몇 시로 가는지 알려준다
  const moved = [];
  for (const label of ['외출 준비', '출근', '등교', '이동', '귀가']) {
    const b0 = before.filter((x) => x[2] === label).map((x) => x[0]);
    const b1 = after.filter((x) => x[2] === label).map((x) => x[0]);
    if (b0.length !== b1.length) continue; // 동선 자체가 바뀐 경우는 routeFit 이유표가 말한다
    b0.forEach((t, i) => {
      if (t === b1[i]) return;
      const hh = String(Math.floor(b1[i] / 60)).padStart(2, '0'), mm = String(b1[i] % 60).padStart(2, '0');
      // 읽는 소리 받침: …0(십·영) · …3(삼) · …6(육) 은 '으로', 나머지는 '로'(ㄹ 받침 포함)
      const ro = /[036]$/.test(mm) ? '으로' : '로';
      moved.push(`${label} ${hh}:${mm}${ro} ${b1[i] < t ? '당김' : '늦춤'}`);
    });
  }
  const ctx = {
    dayLoad: dayLoadOf(occurrences, date, settings),
    busy: busyIntervals(occurrences, date, settings),
    occurrences, target, settings, todayISO,
  };
  const r = scoreCandidate(cand, ctx);
  if (r.excluded) return { ok: false, why: r.why };
  return { ok: true, score: r.score, reasons: [...moved, ...r.reasons] };
}

/**
 * suggest({ occurrences, duration, fromISO, days, settings, nowISO, nowMin, target, scorers, limit })
 * target: 옮기기 { date, start } | 할 일 { due, priority }
 * -> [{ date, start, end, score, reasons: [...] }]
 */
export function suggest({
  occurrences, duration, fromISO, days = 7, settings, nowISO, nowMin,
  target, scorers = DEFAULT_SCORERS, limit = 3,
}) {
  const step = Number(settings?.step ?? 30) || 30;
  const todayISO = nowISO || fromISO;
  const byDate = new Map();

  for (let i = 0; i < days; i++) {
    const date = addDaysISO(fromISO, i);
    const free = freeIntervals(occurrences, date, settings, { nowMin, todayISO });
    const dayLoad = dayLoadOf(occurrences, date, settings);
    const busy = busyIntervals(occurrences, date, settings); // 버퍼 없는 실제 점유 — restBetween 용
    const list = [];

    for (const iv of free) {
      const firstStart = Math.ceil(iv.start / step) * step;
      for (let start = firstStart; start + duration <= iv.end; start += step) {
        if (target && target.date === date && target.start === start) continue; // 원래 자리 제외
        const cand = { date, start, end: start + duration };
        const ctx = { dayLoad, busy, occurrences, target, settings, todayISO };
        const r = scoreCandidate(cand, ctx, scorers);
        if (r.excluded) continue;
        list.push({ ...cand, score: r.score, reasons: r.reasons });
      }
    }
    list.sort((a, b) => b.score - a.score);
    byDate.set(date, list);
  }

  // 날짜 분산 — 각 날짜의 최고점 후보부터 라운드로 채우고, limit 을 못 채우면 다음 순위로.
  const dates = [...byDate.keys()];
  const result = [];
  let round = 0;
  while (result.length < limit) {
    let added = false;
    for (const d of dates) {
      const cand = byDate.get(d)[round];
      if (cand) { result.push(cand); added = true; if (result.length >= limit) break; }
    }
    if (!added) break;
    round++;
  }
  result.sort((a, b) => b.score - a.score);
  return result.slice(0, limit);
}
