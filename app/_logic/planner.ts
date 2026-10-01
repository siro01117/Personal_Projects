// 플래너 화면 계산 (docs/플래너.md 3장). DOM 없이 시험할 수 있는 것만:
// 목록 셋으로 나누기 · 정렬, 사이 sort 값, 시간 정하기의 기본 시작 시각, "10/5 까지" 같은 글자.
// 빈 시간 계산은 lib/schedule 의 planRange + freeSlots 가 한다.

import type { KoreanError } from "../../lib/errors";
import { freeSlots, planRange, weekday, type DateStr, type Place, type Settings, type TaskRow, type Travel } from "../../lib/schedule";
import type { EventRows, TaskLink } from "../_data/types";
import { hm, scheduleKorean, WEEKDAYS } from "./schedule";

/** 끝낸 것은 최근 며칠만 */
export const DONE_DAYS = 14;
/** 시간을 정하지 않은 할 일의 일정 길이 기본값 */
export const DEFAULT_LEN = 60;
/** 기본 시작 시각을 찾기 시작하는 시각 (9:00) */
export const DAY_FROM = 540;
/** 시작 시각 단위 */
export const STEP = 15;

export type Timed = { task: TaskRow; link: TaskLink };
export type Lists = { open: TaskRow[]; timed: Timed[]; done: TaskRow[] };

/**
 * 할 일(시간 없음 · 안 끝남, sort 순) · 시간 정함(이어진 일정의 날짜·시각 순) · 끝냄(최근 14일, 최근 것부터).
 * 끝낸 할 일은 일정이 있어도 끝냄으로 간다
 */
export function splitTasks(tasks: readonly TaskRow[], links: readonly TaskLink[], now: Date = new Date(), days = DONE_DAYS): Lists {
  const linkOf = new Map<string, TaskLink>();
  for (const l of links) if (!linkOf.has(l.task_id)) linkOf.set(l.task_id, l);
  const since = now.getTime() - days * 86_400_000;
  const open: TaskRow[] = [];
  const timed: Timed[] = [];
  const done: TaskRow[] = [];
  for (const t of tasks) {
    if (t.done_at !== null) {
      if (Date.parse(t.done_at) >= since) done.push(t);
      continue;
    }
    const link = linkOf.get(t.id);
    if (link) timed.push({ task: t, link });
    else open.push(t);
  }
  open.sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at));
  timed.sort(
    (a, b) =>
      a.link.date.localeCompare(b.link.date) || (a.link.start_min ?? -1) - (b.link.start_min ?? -1) || a.task.sort - b.task.sort,
  );
  done.sort((a, b) => b.done_at!.localeCompare(a.done_at!));
  return { open, timed, done };
}

/** 두 sort 사이 값. 맨 앞이면 다음 것 - 1, 맨 뒤면 앞 것 + 1 */
export function sortBetween(prev: number | undefined, next: number | undefined): number {
  if (prev === undefined && next === undefined) return 0;
  if (prev === undefined) return next! - 1;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

/** list(지금 순서) 안의 id 를 toIndex 자리로 옮길 때 새 sort. 자리가 그대로면 null */
export function moveSort(list: readonly { id: string; sort: number }[], id: string, toIndex: number): number | null {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return null;
  const rest = list.filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(rest.length, toIndex));
  if (at === from) return null;
  return sortBetween(rest[at - 1]?.sort, rest[at]?.sort);
}

/** 끄는 중 순서: id 를 toIndex 자리로 옮긴 목록 */
export function moved<T extends { id: string }>(list: readonly T[], id: string, toIndex: number): T[] {
  const item = list.find((x) => x.id === id);
  if (!item) return [...list];
  const rest = list.filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(rest.length, toIndex));
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

// ------------------------------------------------------------ 글자

const md = (d: DateStr) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const wd = (d: DateStr) => WEEKDAYS[weekday(d) - 1];

/** "10/5 까지" */
export function dueLabel(due: DateStr): string {
  return `${md(due)} 까지`;
}

/** 마감이 지났나 (오늘 마감은 아직 아님) */
export function overdue(due: DateStr | null, today: DateStr): boolean {
  return due !== null && due < today;
}

/** 시간 정함 줄 오른쪽 "10/3 금 14:00" (종일이면 "10/3 금") */
export function whenLabel(date: DateStr, start: number | null): string {
  return start === null ? `${md(date)} ${wd(date)}` : `${md(date)} ${wd(date)} ${hm(start)}`;
}

/** 할 일 쪽 DB 오류를 화면 문구로 */
export function plannerKorean(err: unknown, authMessage?: string): KoreanError {
  const k = scheduleKorean(err, authMessage);
  if (k.code === "EZ_VERSION") return { code: k.code, message: "방금 다른 곳에서 이 할 일을 고쳤습니다" };
  return k;
}

/** 걸릴 시간 칸 → 분. 빈칸이면 null, 숫자가 아니면 NaN (검사는 validateTask) */
export function parseMinutes(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

// ------------------------------------------------------------ 시간 정하기

const ceilStep = (m: number) => Math.ceil(m / STEP) * STEP;

/**
 * 그날 첫 빈 시간 (15분 단위). 일정·준비·이동을 피하고, 오늘이면 지금 이후. 9시부터 찾는다.
 * rows 는 그날을 그리는 데 필요한 일정 줄(ScheduleData.events(date, date)).
 * 들어갈 자리가 없으면 찾기 시작한 시각 (자정 15분 전을 넘지 않게)
 */
export function firstFreeStart(
  date: DateStr,
  len: number,
  rows: EventRows,
  meta: { places: Place[]; travel: Travel[]; settings: Settings },
  now: { date: DateStr; min: number },
): number {
  const from = date === now.date ? Math.max(DAY_FROM, ceilStep(now.min)) : DAY_FROM;
  const { occurrences, days } = planRange(date, date, rows.events, rows.exceptions, meta.places, meta.travel, meta.settings);
  const day = days[0];
  if (day && from < 1440) {
    for (const s of freeSlots(day, occurrences, len, from, 1440)) {
      const start = ceilStep(s.start);
      if (start + len <= s.end) return start;
    }
  }
  return Math.min(from, 1440 - STEP);
}
