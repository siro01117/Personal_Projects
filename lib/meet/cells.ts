// 시간 맞추기의 칸 (docs/모임.md 2 · 3장). 칸 하나는 30분, 날짜별 '되는 칸의 시작 분' 으로 적는다.
// 맞추기 설정 · 칸 검사, 내 되는 시간 자동 채우기(일정 · 준비 · 이동을 뺀, 통째로 비는 칸만), 칠하기(끌기 범위 → 새 칸 집합).
// 같은 검사를 DB(0011 ez_poll_ok · 0012 ez_cells_ok · ez_meet_answer)도 한다.

import {
  addDays,
  freeSlots,
  isDateStr,
  planRange,
  spillsOver,
  type DateStr,
  type DayPlan,
  type EventException,
  type EventRow,
  type Issue,
  type Occurrence,
  type Place,
  type Segment,
  type Settings,
  type Travel,
} from "../schedule";
import type { Cells, Poll } from "./types";

/** 칸 하나의 길이 (분) */
export const SLOT_MIN = 30;
export const POLL_DATES_MAX = 31;
export const POLL_DURATION_MIN = 30;
export const POLL_DURATION_MAX = 480;
/** 새 맞추기의 기본: 09:00~22:00, 1시간 */
export const DEFAULT_POLL: Omit<Poll, "dates"> = { day_from: 540, day_to: 1320, duration_min: 60 };
/** 한 사람이 적어 둘 수 있는 날짜 수 (후보 날짜를 바꾸면 밖으로 나간 날짜도 남는다 — 0012 ez_cells_ok 와 같다) */
export const CELL_DATES_MAX = 100;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** 맞추기 설정 검사 (0011 ez_poll_ok 와 같다). 문제가 없으면 빈 목록 */
export function validatePoll(v: unknown, path = "poll"): Issue[] {
  if (!isObj(v)) return [{ path, reason: "맞추기 설정이 객체가 아닙니다" }];
  const out: Issue[] = [];
  const dates = v.dates;
  if (!Array.isArray(dates) || dates.length === 0) out.push({ path: `${path}.dates`, reason: "후보 날짜를 하나 이상 골라 주세요" });
  else if (dates.length > POLL_DATES_MAX) out.push({ path: `${path}.dates`, reason: `후보 날짜는 ${POLL_DATES_MAX}개까지입니다 (지금 ${dates.length}개)` });
  else if (dates.some((d) => !isDateStr(d))) out.push({ path: `${path}.dates`, reason: "후보 날짜는 YYYY-MM-DD 입니다" });
  else if (dates.some((d, i) => i > 0 && (d as string) <= (dates[i - 1] as string))) out.push({ path: `${path}.dates`, reason: "후보 날짜는 겹치지 않게 이른 날짜부터 씁니다" });
  const from = v.day_from;
  const to = v.day_to;
  if (!isInt(from) || !isInt(to) || from % SLOT_MIN !== 0 || to % SLOT_MIN !== 0 || from < 0 || to > 1440 || from >= to) {
    out.push({ path: `${path}.day_from`, reason: "하루 범위는 30분 단위로, 시작이 끝보다 이르고 24:00 까지입니다" });
  }
  const len = v.duration_min;
  if (!isInt(len) || len % SLOT_MIN !== 0 || len < POLL_DURATION_MIN || len > POLL_DURATION_MAX) {
    out.push({ path: `${path}.duration_min`, reason: "모임 길이는 30분 단위로 30분~8시간입니다" });
  } else if (out.length === 0 && len > (to as number) - (from as number)) {
    out.push({ path: `${path}.duration_min`, reason: "모임 길이가 하루 범위보다 깁니다" });
  }
  return out;
}

/** 같은 설정인가 (칸 순서와 상관없이 — DB 의 jsonb 는 열쇠 순서를 바꿔 돌려준다) */
export function samePoll(a: Poll | null, b: Poll | null): boolean {
  if (a === null || b === null) return a === b;
  return a.day_from === b.day_from && a.day_to === b.day_to && a.duration_min === b.duration_min && a.dates.length === b.dates.length && a.dates.every((d, i) => d === b.dates[i]);
}

/** 하루 범위 안 칸들의 시작 분 */
export function pollSlots(poll: Pick<Poll, "day_from" | "day_to">): number[] {
  const out: number[] = [];
  for (let m = poll.day_from; m + SLOT_MIN <= poll.day_to; m += SLOT_MIN) out.push(m);
  return out;
}

/**
 * 남이 보내는 칸 검사 (0012 ez_meet_answer 와 같다): 날짜는 후보 날짜, 칸은 30분 단위로 하루 범위 안, 겹침 없음.
 * 문제가 없으면 빈 목록
 */
export function validateCells(v: unknown, poll: Poll, path = "cells"): Issue[] {
  if (!isObj(v)) return [{ path, reason: "칸이 객체가 아닙니다" }];
  const dates = new Set(poll.dates);
  for (const [d, list] of Object.entries(v)) {
    if (!dates.has(d)) return [{ path: `${path}.${d}`, reason: "후보 날짜가 아닙니다" }];
    if (!Array.isArray(list)) return [{ path: `${path}.${d}`, reason: "칸 목록이 배열이 아닙니다" }];
    const seen = new Set<number>();
    for (const m of list) {
      if (!isInt(m) || m % SLOT_MIN !== 0) return [{ path: `${path}.${d}`, reason: "칸은 30분 단위입니다" }];
      if (m < poll.day_from || m + SLOT_MIN > poll.day_to) return [{ path: `${path}.${d}`, reason: "하루 범위 밖의 칸입니다" }];
      if (seen.has(m)) return [{ path: `${path}.${d}`, reason: "같은 칸이 두 번 있습니다" }];
      seen.add(m);
    }
  }
  return [];
}

/** 날짜순 · 칸은 이른 순 · 겹침 없이. 빈 날짜는 뺀다 */
export function cleanCells(cells: Cells): Cells {
  const out: Cells = {};
  for (const d of Object.keys(cells).sort()) {
    const list = [...new Set(cells[d])].sort((a, b) => a - b);
    if (list.length > 0) out[d] = list;
  }
  return out;
}

/** 지금 설정 안의 칸만 (후보 날짜 · 하루 범위). 밖으로 나간 칸은 계산에서 빠질 뿐 지우지 않는다 (7장) */
export function clipCells(cells: Cells | null, poll: Poll): Cells {
  const out: Cells = {};
  if (!cells) return out;
  for (const d of poll.dates) {
    const list = (cells[d] ?? []).filter((m) => m % SLOT_MIN === 0 && m >= poll.day_from && m + SLOT_MIN <= poll.day_to);
    if (list.length > 0) out[d] = [...new Set(list)].sort((a, b) => a - b);
  }
  return out;
}

export function sameCells(a: Cells | null, b: Cells | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(cleanCells(a)) === JSON.stringify(cleanCells(b));
}

export function hasCell(cells: Cells | null, date: DateStr, min: number): boolean {
  return cells?.[date]?.includes(min) === true;
}

// ------------------------------------------------------------ 내 되는 시간

/** 자동 채우기에 필요한 일정을 읽을 범위 (첫 후보 전날 ~ 마지막 후보) */
export function pollRange(poll: Poll): { from: DateStr; to: DateStr } {
  return { from: addDays(poll.dates[0]!, -1), to: poll.dates[poll.dates.length - 1]! };
}

type Band = Extract<Segment, { kind: "prep" | "travel" }>;

/**
 * 계산된 날들에서 후보 날짜마다 통째로 비는 30분 칸.
 * plan 은 planRange(pollRange(poll).from, .to, …) — 전날 띠(귀가 등)가 자정을 넘어오면 그 부분도 바쁜 시간으로 친다.
 * 종일 일정은 바쁜 것으로 안 친다 (busyOf 그대로)
 */
export function autoCells(poll: Poll, plan: { occurrences: Occurrence[]; days: DayPlan[] }): Cells {
  const byDate = new Map(plan.days.map((d) => [d.date, d]));
  const slots = pollSlots(poll);
  const out: Cells = {};
  for (const date of poll.dates) {
    const day = byDate.get(date) ?? { date, segments: [], carry: null };
    const before = addDays(date, -1);
    const spill = (byDate.get(before)?.segments ?? [])
      .filter((s): s is Band => (s.kind === "prep" || s.kind === "travel") && s.end > 1440)
      .map((s) => ({ ...s, date, start: Math.max(0, s.start - 1440), end: s.end - 1440 }));
    const occs = plan.occurrences.filter((o) => o.date === date || (o.date === before && spillsOver(o)));
    const free = freeSlots({ ...day, segments: [...day.segments, ...spill] }, occs, SLOT_MIN, poll.day_from, poll.day_to);
    const list = slots.filter((m) => free.some((f) => f.start <= m && m + SLOT_MIN <= f.end));
    if (list.length > 0) out[date] = list;
  }
  return out;
}

/** 일정에서 내 되는 칸을 구한다. events · exceptions 는 pollRange 를 그리는 데 필요한 것 (ScheduleData.events 와 같다) */
export function myFreeCells(poll: Poll, events: EventRow[], exceptions: EventException[], places: Place[], travel: Travel[], settings: Settings): Cells {
  const r = pollRange(poll);
  return autoCells(poll, planRange(r.from, r.to, events, exceptions, places, travel, settings));
}

// ------------------------------------------------------------ 칠하기

export type CellAt = { date: DateStr; min: number };

/**
 * 끌기: 시작 칸 ~ 지금 칸의 사각 범위(후보 날짜의 순서 × 시각)를 칠하거나(on) 지운 새 칸 집합.
 * 설정 밖의 칸(줄인 날짜 · 범위)은 그대로 둔다. 범위가 설정을 벗어나면 안쪽만
 */
export function paintRect(cells: Cells | null, poll: Poll, from: CellAt, to: CellAt, on: boolean): Cells {
  const out: Cells = {};
  for (const [d, list] of Object.entries(cells ?? {})) out[d] = [...list];
  const i0 = poll.dates.indexOf(from.date);
  const i1 = poll.dates.indexOf(to.date);
  if (i0 < 0 || i1 < 0) return cleanCells(out);
  const lo = Math.max(poll.day_from, Math.min(from.min, to.min));
  const hi = Math.min(poll.day_to - SLOT_MIN, Math.max(from.min, to.min));
  for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
    const d = poll.dates[i]!;
    const set = new Set(out[d] ?? []);
    for (const m of pollSlots(poll)) {
      if (m < lo || m > hi) continue;
      if (on) set.add(m);
      else set.delete(m);
    }
    out[d] = [...set];
  }
  return cleanCells(out);
}

/** 누른 칸이 칠해져 있으면 지우기, 아니면 칠하기 */
export function paintMode(cells: Cells | null, at: CellAt): boolean {
  return !hasCell(cells, at.date, at.min);
}
