// 일정(/plan) 빈 시간 계산 + 후보 제안 — 순수 함수. supabase 를 절대 import 하지 않는다.
//
// 이동시간은 scorer 가 아니라 **바쁜 시간**으로 반영한다(travelBlocks). 오가는 시간은
// 선호가 아니라 물리적으로 못 쓰는 시간이라, 감점보다 빈 구간에서 빼는 게 맞다.
//
// 확장 지점: 선호(예: 피로도)를 반영하려면 새 scorer 함수를
// (cand, ctx) => ({ score, reason? }) 모양으로 만들어 아래 DEFAULT_SCORERS 배열에
// 추가하면 된다. suggest() 는 scorers 를 그대로 순회해 점수를 합산하므로 이 파일의
// 나머지 부분은 건드릴 필요가 없다. ctx 에는 dayLoad(이동 포함)·occurrences·settings 가 있다.
import { addDaysISO, diffDaysISO, travelMinutes } from './plan-core.js';

/**
 * 하루의 이동 구간 목록. 일정 사이를 오가는 시간은 실제로 비어 있지 않으므로
 * 바쁜 시간으로 친다.
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
  const out = [];
  let at = home;          // 직전에 있던 지점
  let lastKnownEnd = null; // 지점이 확인된 마지막 일정의 끝

  for (const o of timed) {
    const to = o.placeId || '';
    const own = o.travelMin != null && o.travelMin > 0 ? o.travelMin : null;
    const mins = own != null ? own : travelMinutes(settings, at, to);
    if (mins > 0) out.push([o.start - mins, o.start]);
    if (to) { at = to; lastKnownEnd = o.end; }
    else if (own != null) lastKnownEnd = o.end;
  }

  if (home && at && at !== home && lastKnownEnd != null) {
    const back = travelMinutes(settings, at, home);
    if (back > 0) out.push([lastKnownEnd, lastKnownEnd + back]);
  }
  return out.filter(([a, b]) => b > a);
}

/**
 * dateISO 하루 안에서 비어 있는 구간을 계산한다.
 * settings.buffer 만큼 앞뒤 여유를 두고 바쁜 구간을 빼고, 이동 구간도 바쁜 것으로 친다.
 * opts.nowMin 이 있고 dateISO 가 opts.todayISO 와 같으면 그 이전 시간은 후보에서 뺀다.
 */
export function freeIntervals(occurrences, dateISO, settings, opts = {}) {
  const dayStart = Number(settings?.dayStart ?? 480);
  const dayEnd = Number(settings?.dayEnd ?? 1380);
  const buffer = Number(settings?.buffer ?? 0);

  let lo = dayStart;
  if (opts.nowMin != null && opts.todayISO === dateISO) lo = Math.max(lo, opts.nowMin);
  if (lo >= dayEnd) return [];

  const busy = occurrences
    .filter((o) => o.date === dateISO && !o.allDay && o.start != null && o.end != null)
    .map((o) => [Math.max(dayStart, o.start - buffer), Math.min(dayEnd, o.end + buffer)])
    .concat(
      // 이동 구간에는 버퍼를 붙이지 않는다 — 여유가 아니라 이미 쓰고 있는 시간이다
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

// 그 날 이미 바쁜 정도가 적을수록 가점.
function lightDay(cand, ctx) {
  const score = Math.max(0, 4 - ctx.dayLoad / 60);
  return { score, reason: ctx.dayLoad <= 60 ? '여유 있는 날' : undefined };
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

// 너무 이르거나(08:00 이전) 늦은(21:00 이후) 시각은 약하게 감점.
function reasonableHours(cand) {
  let score = 0;
  if (cand.start < 8 * 60) score -= 3;
  if (cand.start + (cand.end - cand.start) > 22 * 60) score -= 3;
  return { score };
}

export const DEFAULT_SCORERS = [sameTime, nearDate, lightDay, beforeDue, reasonableHours];

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
    const list = [];

    for (const iv of free) {
      const firstStart = Math.ceil(iv.start / step) * step;
      for (let start = firstStart; start + duration <= iv.end; start += step) {
        if (target && target.date === date && target.start === start) continue; // 원래 자리 제외
        const cand = { date, start, end: start + duration };
        const ctx = { dayLoad, occurrences, target, settings, todayISO };
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
