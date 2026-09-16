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
 * - 지점도 travelMin 도 없는 일정은 이동을 만들지 않고 "어디 있는지 모른다"로 두어
 *   직전 위치를 그대로 유지한다.
 */
export function travelBlocks(occurrences, dateISO, settings) {
  const timed = occurrences
    .filter((o) => o.date === dateISO && !o.allDay && o.start != null && o.end != null)
    .sort((a, b) => a.start - b.start);
  if (!timed.length) return [];

  const home = settings?.homeId || '';
  const work = settings?.workPlaceId || '';
  const prep = Math.max(0, Number(settings?.prepMin ?? 0));
  const school = settings?.schoolPlaceId || '';
  // 이름표 — 근무지로 가면 출근, 학교로 가면 등교, 집으로 오면 귀가. 모양은 [시작, 끝, 이름표]
  const label = (to) => (!to ? '이동' : to === work ? '출근' : to === school ? '등교' : to === home ? '귀가' : '이동');
  const out = [];
  let at = home;          // 직전에 있던 지점
  let lastKnownEnd = null; // 지점이 확인된 마지막 일정의 끝

  for (const o of timed) {
    const to = o.placeId || '';
    const own = o.travelMin != null && o.travelMin > 0 ? o.travelMin : null;
    const mins = own != null ? own : travelMinutes(settings, at, to);
    if (mins > 0) out.push([o.start - mins, o.start, label(to)]);
    // 집에서 다른 곳으로 나갈 때만 이동 앞에 준비 시간을 붙인다. 이동시간을 모르는 쌍이어도
    // 나가는 건 확실하므로 준비는 붙인다. 중간에 집에 들렀다 다시 나가면 또 붙는다.
    const leavingHome = home && at === home && (to ? to !== home : own != null);
    if (leavingHome && prep > 0) {
      const leaveAt = o.start - Math.max(0, mins);
      out.push([leaveAt - prep, leaveAt, '외출 준비']);
    }
    if (to) { at = to; lastKnownEnd = o.end; }
    else if (own != null) lastKnownEnd = o.end;
  }

  if (home && at && at !== home && lastKnownEnd != null) {
    const back = travelMinutes(settings, at, home);
    if (back > 0) out.push([lastKnownEnd, lastKnownEnd + back, '귀가']);
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
  if (cand.date > t.due) return { score: -Infinity };
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

export const DEFAULT_SCORERS = [
  sameTime, nearDate, lightDay, beforeDue, reasonableHours,
  dayCapacity, restBetween, lateHours,
];

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
        let score = 0;
        const reasons = [];
        let excluded = false;
        for (const scorer of scorers) {
          const r = scorer(cand, ctx);
          if (!r) continue;
          if (r.score === -Infinity) { excluded = true; break; }
          score += r.score;
          if (r.reason) reasons.push(r.reason);
        }
        if (excluded) continue;
        list.push({ ...cand, score, reasons: [...new Set(reasons)] });
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
