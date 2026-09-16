// 일정(/plan) 빈 시간 계산 + 후보 제안 — 순수 함수. supabase 를 절대 import 하지 않는다.
//
// 확장 지점: 다음 단계에서 "이동시간·피로도" 를 반영하려면 새 scorer 함수를
// (cand, ctx) => ({ score, reason? }) 모양으로 만들어 아래 DEFAULT_SCORERS 배열에
// 추가하면 된다. suggest() 는 scorers 를 그대로 순회해 점수를 합산하므로 이 파일의
// 나머지 부분은 건드릴 필요가 없다.
import { addDaysISO, diffDaysISO } from './plan-core.js';

/**
 * dateISO 하루 안에서 비어 있는 구간을 계산한다.
 * settings.buffer 만큼 앞뒤 여유를 두고 바쁜 구간을 뺀다.
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

function dayLoadOf(occurrences, dateISO) {
  return occurrences
    .filter((o) => o.date === dateISO && !o.allDay && o.start != null && o.end != null)
    .reduce((s, o) => s + (o.end - o.start), 0);
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
    const dayLoad = dayLoadOf(occurrences, date);
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
