// 플래너 화면 계산 (docs/플래너.md 3장 · 7장). DOM 없이 시험할 수 있는 것만:
// 목록 넷으로 나누기(지남 · 할 일 · 시간 정함 · 끝냄) · 지남 판정, 사이 sort 값, 시간 정하기의 기본 시작 시각,
// "10/5 까지" · "1/2" · "매주 월" 같은 글자, 체크 항목 줄 읽기, 수정 칸의 '이번만 / 앞으로도', 정렬과 구분 묶음(7-12),
// 작업대의 떼어내기(7-13), 역할 필터(7-14), 작업대 목록 · 가져오기 후보 · 순서(7-15),
// 지금 단계 · 진행 막대 · 시간 기록 글자 · 반복 카드(규칙의 다음 회차 · 규칙 칸) · 기록 표(7-16).
// 단계(체크 항목) 자체를 다루는 함수는 lib/schedule/steps.ts, 시간 기록 계산은 lib/schedule/work.ts.
// 빈 시간 계산은 lib/schedule 의 planRange + freeSlots 가 한다.

import type { KoreanError } from "../../lib/errors";
import {
  addDays,
  currentStep,
  daysBetween,
  DEFAULT_SETTINGS,
  detachStep,
  DUE_AFTER_MAX,
  estSum,
  expand,
  flatSteps,
  formatStepLines,
  freeSlots,
  liveWork,
  mergeSteps,
  occursOn,
  parseStepLines,
  planRange,
  ROLE_NAME_MAX,
  roleForPlace,
  ruleChecks,
  secToMin,
  stepProgress,
  stepsFromRule,
  validateTask,
  weekday,
  type CheckItem,
  type DateStr,
  type EventRow,
  type Occurrence,
  type Place,
  type RemovedStep,
  type Repeat,
  type Role,
  type RuleCheck,
  type Settings,
  type TaskRow,
  type TaskRule,
  type Travel,
  type WorkDay,
} from "../../lib/schedule";
import type { EventRows, TaskLink } from "../_data/types";
import { duration, hm, nowIn, repeatLabel, scheduleKorean, WEEKDAYS } from "./schedule";

/** 끝낸 것은 최근 며칠만 */
export const DONE_DAYS = 14;
/** 시간을 정하지 않은 할 일의 일정 길이 기본값 */
export const DEFAULT_LEN = 60;
/** 기본 시작 시각을 찾기 시작하는 시각 (9:00) */
export const DAY_FROM = 540;
/** 시작 시각 단위 */
export const STEP = 15;

export type Timed = { task: TaskRow; link: TaskLink };
/** 지남 묶음의 한 줄. why = 무엇이 지났나 (둘 다면 일정 쪽) */
export type Late = { task: TaskRow; link: TaskLink | null; why: "event" | "due" };
export type Lists = { late: Late[]; open: TaskRow[]; timed: Timed[]; done: TaskRow[] };
/** 지금: 오늘 날짜와 0시부터 센 분 (Asia/Seoul) */
export type At = { date: DateStr; min: number };

/**
 * 이어진 일정이 끝났나: 날짜가 지났거나, 오늘이고 끝 시각이 됐다. 자정을 넘기는 일정은 다음 날 그 시각,
 * 종일 일정은 그날이 다 가야(다음 날부터). 반복 일정은 다음 회차가 있으니 지남으로 치지 않는다
 */
export function eventEnded(link: TaskLink, at: At): boolean {
  if (link.repeating) return false;
  const end = link.start_min === null || link.end_min === null ? 1440 : link.end_min;
  return daysBetween(link.date, at.date) * 1440 + at.min >= end;
}

/** 안 끝낸 할 일의 무엇이 지났나. 일정과 마감이 둘 다 지났으면 일정. 안 지났으면 null */
export function lateOf(task: TaskRow, link: TaskLink | null | undefined, at: At): "event" | "due" | null {
  if (task.done_at !== null) return null;
  if (link && eventEnded(link, at)) return "event";
  return overdue(task.due, at.date) ? "due" : null;
}

/** 지남 줄의 정렬 열쇠: 지난 때 (오래된 것부터) */
function lateKey(l: Late): string {
  if (l.why === "event" && l.link) return `${l.link.date} ${String(l.link.start_min ?? 0).padStart(4, "0")}`;
  return `${l.task.due ?? ""} 9999`;
}

/**
 * 지남(이어진 일정이 끝났거나 마감이 지난 것, 오래된 것부터) · 할 일(시간 없음 · 안 끝남, sort 순) ·
 * 시간 정함(이어진 일정의 날짜·시각 순) · 끝냄(최근 14일, 최근 것부터).
 * 끝낸 할 일은 일정이 있어도 끝냄으로 간다. at = 지금(주입) — 안 주면 now 를 Asia/Seoul 로 읽는다
 */
export function splitTasks(
  tasks: readonly TaskRow[],
  links: readonly TaskLink[],
  now: Date = new Date(),
  at: At = nowIn(DEFAULT_SETTINGS.tz, now),
  days = DONE_DAYS,
): Lists {
  const linkOf = new Map<string, TaskLink>();
  for (const l of links) if (!linkOf.has(l.task_id)) linkOf.set(l.task_id, l);
  const since = now.getTime() - days * 86_400_000;
  const late: Late[] = [];
  const open: TaskRow[] = [];
  const timed: Timed[] = [];
  const done: TaskRow[] = [];
  for (const t of tasks) {
    if (t.done_at !== null) {
      if (Date.parse(t.done_at) >= since) done.push(t);
      continue;
    }
    const link = linkOf.get(t.id);
    const why = lateOf(t, link, at);
    if (why) late.push({ task: t, link: link ?? null, why });
    else if (link) timed.push({ task: t, link });
    else open.push(t);
  }
  late.sort((a, b) => lateKey(a).localeCompare(lateKey(b)) || a.task.sort - b.task.sort);
  open.sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at));
  timed.sort(
    (a, b) =>
      a.link.date.localeCompare(b.link.date) || (a.link.start_min ?? -1) - (b.link.start_min ?? -1) || a.task.sort - b.task.sort,
  );
  done.sort((a, b) => b.done_at!.localeCompare(a.done_at!));
  return { late, open, timed, done };
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

// ------------------------------------------------------------ 역할 (7-11)

/** 줄 오른쪽에 보일 역할 이름. 역할이 없거나 지운 역할이면 null (역할 정렬일 때는 화면이 구분 라벨에 적고 줄에서는 뺀다) */
export function roleText(task: Pick<TaskRow, "role_id">, roles: readonly Role[]): string | null {
  if (task.role_id === null) return null;
  return roles.find((r) => r.id === task.role_id)?.name ?? null;
}

// ------------------------------------------------------------ 정렬 (7-12)

export const SORT_KEYS = ["manual", "role", "place", "time"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir };
export const DEFAULT_SORT: Sort = { key: "manual", dir: "asc" };
export const SORT_LABEL: Record<SortKey, string> = { manual: "직접", role: "역할", place: "장소", time: "소요시간" };
/** 역할 · 지점 없는 묶음의 라벨 */
export const NONE_LABEL = "없음";

/** 기억해 둔 정렬 글자(JSON `{key, dir}`) → 정렬. 못 읽거나 값이 이상하면 직접 · 오름 */
export function parseSort(raw: string | null | undefined): Sort {
  if (!raw) return DEFAULT_SORT;
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== "object" || o === null) return DEFAULT_SORT;
    const { key, dir } = o as { key?: unknown; dir?: unknown };
    if (!SORT_KEYS.includes(key as SortKey) || (dir !== "asc" && dir !== "desc")) return DEFAULT_SORT;
    return { key: key as SortKey, dir };
  } catch {
    return DEFAULT_SORT;
  }
}

/** 정렬할 한 줄: 할 일과 (있으면) 이어진 일정 */
export type SortRow = { task: TaskRow; link?: TaskLink | null };
/** 구분 묶음. kind: all = 구분 없는 한 묶음(직접 · 시간), role / place = 그 값의 묶음(key 는 그 id), none = 없음 */
export type SortGroup<T> = { key: string; label: string; kind: "all" | "role" | "place" | "none"; items: T[] };

/** 소요시간 정렬의 값: 걸릴 시간(분). 안 적었으면 null */
export function estOf(row: SortRow): number | null {
  return row.task.est_min;
}

/**
 * 한 묶음(지남 · 할 일 · 시간 정함 · 끝냄 가운데 하나)의 줄을 정렬해 구분 묶음으로 나눈다. rows 는 직접 순서로 받는다.
 * 직접: 한 묶음, 그대로. 역할 · 장소: 목록(sort) 순서대로 묶고 없는 것(지운 역할 · 지운 지점 포함)은 늘 맨 뒤,
 * 묶음 안은 직접 순서, 내림이면 묶음 순서만 뒤집는다. 소요시간: 한 묶음, 걸릴 시간 순(오름 = 짧은 것부터),
 * 안 적은 것은 늘 맨 뒤, 같으면 직접 순서. 줄이 없으면 빈 배열
 */
export function sortGroups<T extends SortRow>(
  rows: readonly T[],
  sort: Sort,
  by: { roles: readonly Pick<Role, "id" | "name" | "sort">[]; places: readonly Pick<Place, "id" | "name" | "sort" | "deleted">[] },
): SortGroup<T>[] {
  if (rows.length === 0) return [];
  if (sort.key === "manual") return [{ key: "all", label: "", kind: "all", items: [...rows] }];
  if (sort.key === "time") {
    const known: { row: T; at: number }[] = [];
    const rest: T[] = [];
    for (const row of rows) {
      const at = estOf(row);
      if (at === null) rest.push(row);
      else known.push({ row, at });
    }
    const sign = sort.dir === "asc" ? 1 : -1;
    known.sort((a, b) => sign * (a.at - b.at)); // 같은 값이면 직접 순서 그대로(안정 정렬)
    return [{ key: "all", label: "", kind: "all", items: [...known.map((x) => x.row), ...rest] }];
  }
  const kind = sort.key;
  const heads = (kind === "role" ? [...by.roles] : by.places.filter((p) => !p.deleted)).sort((a, b) => a.sort - b.sort);
  if (sort.dir === "desc") heads.reverse();
  const idOf = (row: T) => (kind === "role" ? row.task.role_id : row.task.place_id);
  const known = new Set(heads.map((h) => h.id));
  const groups: SortGroup<T>[] = heads.map((h) => ({ key: h.id, label: h.name, kind, items: rows.filter((r) => idOf(r) === h.id) }));
  const none = rows.filter((r) => {
    const id = idOf(r);
    return id === null || !known.has(id);
  });
  groups.push({ key: "none", label: NONE_LABEL, kind: "none", items: none });
  return groups.filter((g) => g.items.length > 0);
}

// ------------------------------------------------------------ 역할 필터 (7-14)

/** 역할 필터에서 '역할 없음' 줄의 열쇠 */
export const NO_ROLE = "none";

/** 필터의 열쇠: 역할 id, 역할이 없거나 지운 역할이면 NO_ROLE */
export function roleKey(task: Pick<TaskRow, "role_id">, roles: readonly Pick<Role, "id">[]): string {
  return task.role_id !== null && roles.some((r) => r.id === task.role_id) ? task.role_id : NO_ROLE;
}

/**
 * 기억해 둔 필터 글자(끈 열쇠들의 JSON 배열) → 끈 열쇠들. 못 읽으면 빈 배열(전부 켬).
 * 켠 것이 아니라 끈 것을 기억한다 — 새로 만든 역할은 처음부터 켜져 있다
 */
export function parseRoleOff(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const o: unknown = JSON.parse(raw);
    return Array.isArray(o) ? [...new Set(o.filter((x): x is string => typeof x === "string" && x !== ""))] : [];
  } catch {
    return [];
  }
}

/** 하나라도 꺼져 있나 (지금 있는 역할 · 역할 없음 기준. 지운 역할의 열쇠는 안 친다) */
export function roleFilterOn(off: readonly string[], roles: readonly Pick<Role, "id">[]): boolean {
  return off.some((k) => k === NO_ROLE || roles.some((r) => r.id === k));
}

/** 그 열쇠를 켜거나 끈 목록 */
export function toggleRoleOff(off: readonly string[], key: string, on: boolean): string[] {
  const rest = off.filter((k) => k !== key);
  return on ? rest : [...rest, key];
}

/** 꺼진 역할의 줄을 뺀다 */
export function filterByRole<T extends { task: Pick<TaskRow, "role_id"> }>(rows: readonly T[], off: readonly string[], roles: readonly Pick<Role, "id">[]): T[] {
  if (off.length === 0) return [...rows];
  const hide = new Set(off);
  return rows.filter((r) => !hide.has(roleKey(r.task, roles)));
}

// ------------------------------------------------------------ 작업대 (7-13)

/** 작업대에 올라간 할 일들, 올린 순서 (끝낸 것은 DB 가 내리지만 화면이 먼저 바뀌는 사이를 위해 한 번 더 거른다) */
export function benchList(tasks: readonly TaskRow[]): TaskRow[] {
  return tasks
    .filter((t) => t.bench_order !== null && t.done_at === null)
    .sort((a, b) => a.bench_order! - b.bench_order! || a.created_at.localeCompare(b.created_at));
}

/**
 * 가져오기 후보 (7-15): 아직 안 올라간 열린 할 일 — 지남 · 할 일 · 시간 정함 순(각 묶음 안은 플래너와 같은 순서),
 * 역할 필터(7-14)에서 끈 역할은 뺀다
 */
export function benchCandidates(
  tasks: readonly TaskRow[],
  links: readonly TaskLink[],
  now: Date,
  at: At,
  off: readonly string[],
  roles: readonly Pick<Role, "id">[],
): TaskRow[] {
  const l = splitTasks(tasks, links, now, at);
  const all = [...l.late.map((x) => x.task), ...l.open, ...l.timed.map((x) => x.task)].filter((t) => t.bench_order === null);
  return filterByRole(all.map((task) => ({ task })), off, roles).map((r) => r.task);
}

/** 작업대에서 앞 · 뒤 (집중 화면의 ‹ ›). 맨 앞 · 맨 뒤면 null */
export function benchSides(list: readonly Pick<TaskRow, "id">[], id: string): { prev: string | null; next: string | null } {
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return { prev: null, next: null };
  return { prev: list[i - 1]?.id ?? null, next: list[i + 1]?.id ?? null };
}

/** 메모의 첫 줄 (빈 줄은 건너뛴다). 없으면 null */
export function firstLine(note: string | null): string | null {
  const line = (note ?? "").split("\n").find((x) => x.trim() !== "");
  return line ? line.trim() : null;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/**
 * 메모 글을 주소와 나머지로 나눈다 (집중 화면의 메모 — 읽기 상태에서 주소가 눌린다, 7-16). http · https 만.
 * 주소 끝의 문장 부호(. , ; : ! ? ) ] })는 주소에서 뺀다
 */
export function splitLinks(text: string): { text: string; url?: string }[] {
  const out: { text: string; url?: string }[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]}]+$/, "");
    try {
      const u = new URL(url);
      if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") continue;
    } catch {
      continue;
    }
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: url, url });
    at = m.index + url.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** 지금 단계의 글자 (첫 번째 안 끝난 줄). 단계가 없거나 다 끝났으면 null */
export function currentStepText(list: readonly CheckItem[]): string | null {
  const k = currentStep(list);
  return k === null ? null : (flatSteps(list)[k]?.t ?? null);
}

/** 작업대 카드의 한 줄: 지금 단계, 단계가 하나도 없으면 메모 첫 줄 (7-16) */
export function benchLine(task: Pick<TaskRow, "checklist" | "note">): string | null {
  return task.checklist.length > 0 ? currentStepText(task.checklist) : firstLine(task.note);
}

/** 얇은 진행 막대의 비율 0~1 (끝낸 줄 / 전체 줄). 단계가 없으면 null — 막대를 그리지 않는다 */
export function progressOf(list: readonly CheckItem[]): number | null {
  const p = stepProgress(list);
  return p ? p.done / p.total : null;
}

/** 카드의 "오늘 40분" — 오늘 잰 것이 있을 때만 */
export function todayLabel(task: Pick<TaskRow, "work">, nowMs: number): string | null {
  const w = liveWork(task.work, nowMs);
  return w.today > 0 ? `오늘 ${duration(secToMin(w.today))}` : null;
}

/** 집중 화면 머리 줄의 한 토막. over = 단계 합이 걸릴 시간을 넘었다(걸릴 시간 글자만 키위) */
export type FocusBit = { key: "est" | "steps" | "today" | "total"; text: string; over?: boolean };

/**
 * 집중 화면 머리 한 줄 "걸릴 시간 1시간 · 단계 합 50분 · 오늘 40분 · 누적 1시간 20분" — 있는 것만.
 * 누적은 오늘과 다를 때만(같으면 같은 말을 두 번 하지 않는다)
 */
export function focusMeta(task: Pick<TaskRow, "est_min" | "checklist" | "work">, nowMs: number): FocusBit[] {
  const out: FocusBit[] = [];
  const sum = estSum(task.checklist);
  if (task.est_min !== null) out.push({ key: "est", text: `걸릴 시간 ${duration(task.est_min)}`, ...(sum > task.est_min ? { over: true } : {}) });
  if (sum > 0) out.push({ key: "steps", text: `단계 합 ${duration(sum)}` });
  const w = liveWork(task.work, nowMs);
  const today = secToMin(w.today);
  const total = secToMin(w.total);
  if (today > 0) out.push({ key: "today", text: `오늘 ${duration(today)}` });
  if (total > 0 && total !== today) out.push({ key: "total", text: `누적 ${duration(total)}` });
  return out;
}

/** 지금 시간이 가고 있는 할 일 (한 번에 하나). 없으면 null */
export function runningTask(tasks: readonly TaskRow[]): TaskRow | null {
  return tasks.find((t) => t.work?.running && t.done_at === null) ?? null;
}

/** 끝낸 단계가 이만큼을 넘으면 접는다 (7-16) */
export const DONE_FOLD = 8;

/**
 * 떼어내기: k 번째 줄(평탄 번호)이 새 할 일이 된다. 제목 = 그 줄, 역할 · 지점 · 마감(딸린 일정 포함)은 지금 할 일에서 물려받는다.
 * 윗단이면 아랫단이 새 할 일의 단계가 된다. 돌려주는 것: 새 할 일 입력, 그 줄을 뺀 단계, 되돌릴 자리. 없는 줄이면 null
 */
export function detachTaskStep(
  task: Pick<TaskRow, "checklist" | "role_id" | "place_id" | "due" | "due_event_id">,
  k: number,
): {
  input: { title: string; role_id: string | null; place_id: string | null; due: DateStr | null; due_event_id: string | null; checklist: CheckItem[] };
  rest: CheckItem[];
  removed: RemovedStep;
} | null {
  const d = detachStep(task.checklist, k);
  if (!d) return null;
  return {
    input: { title: d.title, role_id: task.role_id, place_id: task.place_id, due: task.due, due_event_id: task.due_event_id, checklist: d.checklist },
    rest: d.rest,
    removed: d.removed,
  };
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

/** 지남 줄 오른쪽: 지난 일정이면 "10/1 목 15:30 지남", 지난 마감이면 "9/27 까지" */
export function lateLabel(l: Late): string {
  if (l.why === "event" && l.link) return `${whenLabel(l.link.date, l.link.start_min)} 지남`;
  return l.task.due ? dueLabel(l.task.due) : "";
}

/** 줄의 체크 수 "1/2" (아랫단까지 센다). 다 했으면 all. 체크 항목이 없으면 null */
export function checkLabel(list: readonly CheckItem[]): { text: string; all: boolean } | null {
  const p = stepProgress(list);
  return p ? { text: `${p.done}/${p.total}`, all: p.all } : null;
}

/** 반복 한 줄: "매주 월" · "매일" · 일정에 딸렸으면 "자료구조 끝날 때마다"(제목을 모르면 "일정이 끝날 때마다") */
export function ruleLabel(rule: TaskRule, eventTitle?: string | null): string {
  if (rule.kind === "event") return eventTitle ? `${eventTitle} 끝날 때마다` : "일정이 끝날 때마다";
  return repeatLabel(rule.repeat) ?? "";
}

/**
 * 규칙의 다음 회차 날짜 (반복 카드의 줄). 멈춘 규칙 · 알 수 없으면 null.
 * 주기 규칙: 오늘 이후(이미 만든 회차 다음)의 첫 날. 일정에 딸린 규칙: 그 일정의 다음 회차 — occ 는 오늘부터 펼친 회차들
 */
export function ruleNext(rule: TaskRule, today: DateStr, occ: readonly Pick<Occurrence, "event_id" | "on_date" | "date">[] = []): DateStr | null {
  if (rule.paused) return null;
  if (rule.kind === "event") {
    const made = rule.last_made ?? "";
    return (
      occ
        .filter((o) => o.event_id === rule.event_id && o.on_date > made && o.date >= today)
        .map((o) => o.date)
        .sort()[0] ?? null
    );
  }
  if (!rule.repeat || !rule.start) return null;
  const base = { date: rule.start, repeat: rule.repeat } as EventRow;
  let from = today > rule.start ? today : rule.start;
  if (rule.last_made && rule.last_made >= from) from = addDays(rule.last_made, 1);
  for (let k = 0; k < 370; k++) {
    const d = addDays(from, k);
    if (occursOn(base, d)) return d;
  }
  return null;
}

/** 반복 카드의 줄 순서: 멈춘 것은 뒤로, 그 안은 다음 회차가 가까운 순(모르면 뒤), 같으면 제목 */
export function sortRules<T extends { rule: TaskRule; next: DateStr | null }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.rule.paused) - Number(b.rule.paused) ||
      (a.next ?? "9999").localeCompare(b.next ?? "9999") ||
      a.rule.title.localeCompare(b.rule.title, "ko"),
  );
}

// ------------------------------------------------------------ 수정 칸

/** 수정 칸의 값. 글 칸은 빈 글자 = 없음. 반복 설정은 여기 없다 — 반복 카드의 규칙에서 (7-16) */
export type TaskDraft = {
  title: string;
  due: string;
  /** 마감을 딸려 둔 일정 (due 는 그 회차 날짜) */
  dueEvent: { id: string; title: string } | null;
  est: string;
  note: string;
  place_id: string | null;
  /** 체크 항목 — 한 줄에 하나, 들여 쓰면 아랫단 */
  checks: string;
  role_id: string | null;
  /** 역할을 손으로 골랐다 — 지점을 바꿔도 역할을 덮지 않는다 */
  roleManual: boolean;
};

/**
 * 할 일 → 수정 칸. autoRole = 지금 지점이 주는 역할(roleForPlace). 역할이 그것과 다르면 손으로 고른 것으로 본다
 */
export function taskDraft(t: TaskRow, titles: Readonly<Record<string, string>> = {}, autoRole: string | null = null): TaskDraft {
  return {
    title: t.title,
    due: t.due ?? "",
    dueEvent: t.due_event_id ? { id: t.due_event_id, title: titles[t.due_event_id] ?? "" } : null,
    est: t.est_min === null ? "" : String(t.est_min),
    note: t.note ?? "",
    place_id: t.place_id,
    checks: formatStepLines(t.checklist),
    role_id: t.role_id,
    roleManual: t.role_id !== null && t.role_id !== autoRole,
  };
}

// ------------------------------------------------------------ 규칙 칸 (반복 카드, 7-16)

export type RuleKind = "daily" | "weekly" | "event";

/** 규칙 수정 칸의 값. event = 일정에 딸린 규칙(주기는 못 바꾼다) */
export type RuleDraft = {
  title: string;
  est: string;
  note: string;
  place_id: string | null;
  role_id: string | null;
  roleManual: boolean;
  /** 단계 틀 — 한 줄에 하나, 들여 쓰면 아랫단 */
  checks: string;
  kind: RuleKind;
  days: number[];
  /** 마감까지 며칠 (빈칸 = 마감 없음) */
  dueAfter: string;
  /** 회차가 생기면 작업대에 올리기 */
  bench: boolean;
};

/** 규칙 → 수정 칸 */
export function ruleDraft(rule: TaskRule, autoRole: string | null = null): RuleDraft {
  const r = rule.repeat;
  return {
    title: rule.title,
    est: rule.est_min === null ? "" : String(rule.est_min),
    note: rule.note ?? "",
    place_id: rule.place_id,
    role_id: rule.role_id,
    roleManual: rule.role_id !== null && rule.role_id !== autoRole,
    checks: formatStepLines(stepsFromRule(rule.checklist)),
    kind: rule.kind === "event" ? "event" : r?.freq === "weekly" ? "weekly" : "daily",
    days: r?.freq === "weekly" ? [...r.days].sort((a, b) => a - b) : [],
    dueAfter: rule.due_after == null ? "" : String(rule.due_after),
    bench: rule.bench,
  };
}

/** "반복으로 만들기": 할 일의 모양을 옮긴 새 규칙 칸. 처음에는 매주, 오늘 요일 */
export function ruleDraftFromTask(t: TaskRow, today: DateStr, autoRole: string | null = null): RuleDraft {
  return {
    title: t.title,
    est: t.est_min === null ? "" : String(t.est_min),
    note: t.note ?? "",
    place_id: t.place_id,
    role_id: t.role_id,
    roleManual: t.role_id !== null && t.role_id !== autoRole,
    checks: formatStepLines(t.checklist),
    kind: "weekly",
    days: [weekday(today)],
    dueAfter: "",
    bench: false,
  };
}

/** 규칙 칸 → 저장할 칸들. prev = 고치기 전 단계 틀(걸릴 시간을 글자로 이어받는다). 틀리면 issue */
export function ruleDraftPatch(
  d: RuleDraft,
  prev: readonly RuleCheck[],
): { issue: string } | { patch: Pick<TaskRule, "title" | "note" | "est_min" | "place_id" | "role_id" | "checklist" | "due_after" | "bench">; repeat: Exclude<Repeat, null> | null } {
  const title = d.title.trim();
  const est = parseMinutes(d.est);
  const note = d.note.trim() === "" ? null : d.note;
  const bad = validateTask({ title, est_min: est, note })[0];
  if (bad) return { issue: bad.path === "title" && title === "" ? "제목을 써 주세요" : bad.reason };
  const lines = parseStepLines(d.checks);
  if (lines.issue) return { issue: lines.issue };
  const dueAfter = parseDueAfter(d.dueAfter);
  if (Number.isNaN(dueAfter)) return { issue: `마감까지는 0~${DUE_AFTER_MAX}일입니다` };
  if (d.kind === "weekly" && d.days.length === 0) return { issue: "요일을 하나 이상 고르세요" };
  return {
    patch: {
      title,
      note,
      est_min: est,
      place_id: d.place_id,
      role_id: d.role_id,
      checklist: ruleChecks(mergeSteps(stepsFromRule(prev), lines.lines)),
      due_after: dueAfter,
      bench: d.bench,
    },
    repeat: d.kind === "daily" ? { freq: "daily" } : d.kind === "weekly" ? { freq: "weekly", days: [...d.days].sort((a, b) => a - b) } : null,
  };
}

type RoleDraft = { place_id: string | null; role_id: string | null; roleManual: boolean };

/** 지점을 고른다. 역할을 손으로 고른 적이 없으면 그 지점의 역할을 채운다(맞는 역할이 없으면 그대로). 할 일 칸 · 규칙 칸 공용 */
export function draftWithPlace<D extends RoleDraft>(d: D, place: Pick<Place, "id" | "role"> | null, roles: Role[]): D {
  const next = { ...d, place_id: place?.id ?? null };
  if (d.roleManual) return next;
  const r = roleForPlace(place, roles);
  return r ? { ...next, role_id: r.id } : next;
}

/** 역할 칩을 직접 눌렀다 */
export function draftWithRole<D extends RoleDraft>(d: D, role_id: string | null): D {
  return { ...d, role_id, roleManual: true };
}

/** 마감까지 며칠 칸 → 숫자. 빈칸이면 null, 0~60 정수가 아니면 NaN */
export function parseDueAfter(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return Number.NaN;
  const n = Number(t);
  return n <= DUE_AFTER_MAX ? n : Number.NaN;
}

// ------------------------------------------------------------ 기록 표 (7-16, /planner/log)

/** 표의 한 줄. task = 할 일(역할 · 지점 이름 옆에), role = 역할 소계(정렬이 역할일 때). cells = 월~일 분, total = 주 합계 */
export type LogRow =
  | { kind: "task"; id: string; title: string; role: string | null; place: string | null; cells: number[]; total: number }
  | { kind: "role"; id: string; label: string; cells: number[]; total: number };

export type LogTable = { days: DateStr[]; rows: LogRow[]; sum: { cells: number[]; total: number } };

/**
 * 한 주의 기록 표. week = 할 일 × 날짜 초(ez_work_week), monday = 그 주 월요일.
 * 칸은 분(1분이 안 돼도 기록이 있으면 1), 합계는 보이는 칸의 합 — 화면의 숫자끼리 맞게.
 * byRole 이 아니면 주 합계가 큰 순. byRole 이면 역할 목록 순서로 묶고(역할 없는 것은 맨 뒤) 묶음 끝에 소계 줄
 */
export function weekTable(
  week: readonly WorkDay[],
  monday: DateStr,
  tasks: readonly Pick<TaskRow, "id" | "title" | "role_id" | "place_id">[],
  by: { roles: readonly Pick<Role, "id" | "name" | "sort">[]; places: readonly Pick<Place, "id" | "name">[] },
  byRole = false,
): LogTable {
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const col = new Map(days.map((d, i) => [d, i]));
  const taskOf = new Map(tasks.map((t) => [t.id, t]));
  const roleName = new Map(by.roles.map((r) => [r.id, r.name]));
  const placeName = new Map(by.places.map((p) => [p.id, p.name]));
  const secs = new Map<string, number[]>();
  for (const w of week) {
    const i = col.get(w.day);
    if (i === undefined || !taskOf.has(w.task_id) || w.seconds <= 0) continue;
    const row = secs.get(w.task_id) ?? Array.from({ length: 7 }, () => 0);
    row[i]! += w.seconds;
    secs.set(w.task_id, row);
  }
  const total = (cells: readonly number[]) => cells.reduce((n, x) => n + x, 0);
  const addCells = (a: readonly number[], b: readonly number[]) => a.map((x, i) => x + b[i]!);
  type TaskLine = Extract<LogRow, { kind: "task" }> & { role_id: string | null };
  const lines: TaskLine[] = [...secs.entries()].map(([id, row]) => {
    const t = taskOf.get(id)!;
    const cells = row.map(secToMin);
    const known = t.role_id !== null && roleName.has(t.role_id);
    return {
      kind: "task",
      id,
      title: t.title,
      role: known ? roleName.get(t.role_id!)! : null,
      place: t.place_id ? (placeName.get(t.place_id) ?? null) : null,
      cells,
      total: total(cells),
      role_id: known ? t.role_id : null,
    };
  });
  lines.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title, "ko"));
  const strip = ({ role_id: _, ...row }: TaskLine): LogRow => row;
  const zero = Array.from({ length: 7 }, () => 0);
  const sumCells = lines.reduce((acc, l) => addCells(acc, l.cells), zero);
  let rows: LogRow[];
  if (!byRole) rows = lines.map(strip);
  else {
    rows = [];
    const heads: { id: string | null; label: string }[] = [...by.roles].sort((a, b) => a.sort - b.sort).map((r) => ({ id: r.id, label: r.name }));
    heads.push({ id: null, label: NONE_LABEL });
    for (const h of heads) {
      const group = lines.filter((l) => l.role_id === h.id);
      if (group.length === 0) continue;
      rows.push(...group.map(strip));
      const cells = group.reduce((acc, l) => addCells(acc, l.cells), zero);
      rows.push({ kind: "role", id: `role:${h.id ?? "none"}`, label: h.label, cells, total: total(cells) });
    }
  }
  return { days, rows, sum: { cells: sumCells, total: total(sumCells) } };
}

/** 표 머리의 날짜 "월 5" */
export function logDayLabel(d: DateStr): string {
  return `${wd(d)} ${Number(d.slice(8, 10))}`;
}

// ------------------------------------------------------------ 일정에 딸린 마감

/** 마감으로 고를 수 있는 일정 회차 하나. due = 할 일에 넣을 날짜(반복이면 규칙상 회차 날짜) */
export type DueOption = { key: string; event_id: string; due: DateStr; date: DateStr; title: string };

/** 오늘부터 days 일 안의 일정 회차 (종일 포함), 날짜 · 시각 순 */
export function dueOptions(rows: EventRows, today: DateStr, days = 60): DueOption[] {
  return expand(rows.events, rows.exceptions, today, addDays(today, days))
    .filter((o) => o.date >= today)
    .map((o) => ({ key: o.key, event_id: o.event_id, due: o.repeating ? o.on_date : o.date, date: o.date, title: o.title }));
}

/** 고르는 목록의 날짜 "10/11 일" */
export function dateLabel(d: DateStr): string {
  return `${md(d)} ${wd(d)}`;
}

/** 할 일 쪽 DB 오류를 화면 문구로 */
export function plannerKorean(err: unknown, authMessage?: string): KoreanError {
  const o = typeof err === "object" && err !== null ? (err as { message?: unknown; details?: unknown; code?: unknown }) : null;
  const text = o ? `${String(o.message ?? "")} ${String(o.details ?? "")}` : String(err);
  if (text.includes("ez_roles")) {
    if (o?.code === "23505") {
      return text.includes("from_place")
        ? { code: "ROLE_PLACE_TAKEN", message: "그 지점 역할에서 오는 역할이 이미 있습니다" }
        : { code: "NAME_TAKEN", message: "같은 이름의 역할이 이미 있습니다" };
    }
    if (o?.code === "23514") return { code: "BAD_NAME", message: `역할 이름은 앞뒤 공백 없이 1~${ROLE_NAME_MAX}자입니다` };
  }
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
