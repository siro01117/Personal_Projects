// 빈 시간. 일정·준비·이동을 뺀 조각 (식사 추천은 바쁜 시간으로 치지 않는다).

import { addDays } from "./dates";
import { spillsOver } from "./expand";
import type { DayPlan, Occurrence } from "./types";

export type Slot = { start: number; end: number };

/** from~to 에서 busy 를 뺀 조각들 (시작 순, 길이 0 은 뺀다) */
export function gaps(from: number, to: number, busy: Slot[]): Slot[] {
  const sorted = busy.filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const out: Slot[] = [];
  let cur = from;
  for (const b of sorted) {
    if (b.end <= cur) continue;
    if (b.start >= to) break;
    if (b.start > cur) out.push({ start: cur, end: b.start });
    cur = Math.max(cur, b.end);
    if (cur >= to) break;
  }
  if (cur < to) out.push({ start: cur, end: to });
  return out;
}

/** 그날 바쁜 구간: 시각 있는 회차, 전날에서 넘어온 회차(0~끝), 준비·이동 */
export function busyOf(day: DayPlan, occs: Occurrence[]): Slot[] {
  const prev = addDays(day.date, -1);
  const busy: Slot[] = [];
  for (const o of occs) {
    if (o.all_day || o.start_min === null || o.end_min === null) continue;
    if (o.date === day.date) busy.push({ start: o.start_min, end: o.end_min });
    else if (o.date === prev && spillsOver(o)) busy.push({ start: 0, end: o.end_min - 1440 });
  }
  for (const s of day.segments) {
    if (s.kind === "prep" || s.kind === "travel") busy.push({ start: s.start, end: s.end });
  }
  return busy;
}

/**
 * minMinutes 이상인 빈 시간 (dayFrom~dayTo 안).
 * occs 에는 그날 회차를 준다. 전날 자정을 넘긴 회차를 섞어 주면 넘어온 부분도 뺀다.
 */
export function freeSlots(day: DayPlan, occs: Occurrence[], minMinutes: number, dayFrom = 0, dayTo = 1440): Slot[] {
  return gaps(dayFrom, dayTo, busyOf(day, occs)).filter((g) => g.end - g.start >= Math.max(1, minMinutes));
}
