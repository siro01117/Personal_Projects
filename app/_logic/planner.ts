// 플래너 화면 계산 (docs/플래너.md 3장 · 7장). DOM 없이 시험할 수 있는 것만:
// 목록 넷으로 나누기(지남 · 할 일 · 시간 정함 · 끝냄) · 지남 판정, 사이 sort 값, 시간 정하기의 기본 시작 시각,
// "10/5 까지" · "1/2" · "매주 월" 같은 글자, 체크 항목 줄 읽기, 수정 칸의 '이번만 / 앞으로도', 정렬과 구분 묶음(7-12).
// 빈 시간 계산은 lib/schedule 의 planRange + freeSlots 가 한다.

import type { KoreanError } from "../../lib/errors";
import {
  addDays,
  CHECK_ITEM_MAX,
  CHECKLIST_MAX,
  daysBetween,
  DEFAULT_SETTINGS,
  DUE_AFTER_MAX,
  expand,
  freeSlots,
  planRange,
  ROLE_NAME_MAX,
  roleForPlace,
  weekday,
  type CheckItem,
  type DateStr,
  type Place,
  type Role,
  type Settings,
  type TaskRow,
  type TaskRule,
  type Travel,
} from "../../lib/schedule";
import type { EventRows, TaskLink } from "../_data/types";
import { hm, nowIn, repeatLabel, scheduleKorean, WEEKDAYS } from "./schedule";

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

/** 줄의 체크 수 "1/2". 다 했으면 all. 체크 항목이 없으면 null */
export function checkLabel(list: readonly CheckItem[]): { text: string; all: boolean } | null {
  if (list.length === 0) return null;
  const n = list.filter((c) => c.done).length;
  return { text: `${n}/${list.length}`, all: n === list.length };
}

/** 반복 한 줄: "매주 월" · "매일" · 일정에 딸렸으면 "자료구조 끝나면" */
export function ruleLabel(rule: TaskRule, eventTitle?: string | null): string {
  if (rule.kind === "event") return eventTitle ? `${eventTitle} 끝나면` : "일정 끝나면";
  return repeatLabel(rule.repeat) ?? "";
}

// ------------------------------------------------------------ 체크 항목

/** 수정 칸의 여러 줄 → 항목 글자. 한 줄에 하나, 앞뒤 공백을 떼고 빈 줄은 버린다. 넘치면 issue */
export function parseChecks(text: string): { texts: string[]; issue: string | null } {
  const texts = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  let issue: string | null = null;
  if (texts.length > CHECKLIST_MAX) issue = `체크 항목은 ${CHECKLIST_MAX}개까지입니다 (지금 ${texts.length}개)`;
  else if (texts.some((t) => [...t].length > CHECK_ITEM_MAX)) issue = `체크 항목 하나는 ${CHECK_ITEM_MAX}자까지입니다`;
  return { texts, issue };
}

/** 고친 글자에 체크를 얹는다: 글자가 같은 항목은 체크를 지킨다 (같은 글자가 여럿이면 앞에서부터 하나씩) */
export function mergeChecklist(prev: readonly CheckItem[], texts: readonly string[]): CheckItem[] {
  const left = prev.map((c) => ({ ...c }));
  return texts.map((t) => {
    const i = left.findIndex((c) => c.t === t);
    if (i < 0) return { t, done: false };
    const [hit] = left.splice(i, 1);
    return { t, done: hit!.done };
  });
}

/** i 번째 항목의 체크를 바꾼 목록 */
export function toggleCheck(list: readonly CheckItem[], i: number, done: boolean): CheckItem[] {
  return list.map((c, k) => (k === i ? { ...c, done } : c));
}

// ------------------------------------------------------------ 수정 칸

export type RepeatKind = "none" | "daily" | "weekly" | "event";

/** 수정 칸의 값. 글 칸은 빈 글자 = 없음 */
export type TaskDraft = {
  title: string;
  due: string;
  /** 마감을 딸려 둔 일정 (due 는 그 회차 날짜) */
  dueEvent: { id: string; title: string } | null;
  est: string;
  note: string;
  place_id: string | null;
  /** 체크 항목 — 한 줄에 하나 */
  checks: string;
  /** event = 일정에 딸린 규칙에서 온 할 일 (여기서는 멈추기만) */
  repeat: RepeatKind;
  days: number[];
  /** 마감까지 며칠 (빈칸 = 마감 없음) */
  dueAfter: string;
  role_id: string | null;
  /** 역할을 손으로 골랐다 — 지점을 바꿔도 역할을 덮지 않는다 */
  roleManual: boolean;
};

/**
 * 할 일 → 수정 칸. rule = 이 할 일이 나온 살아 있는 규칙 (없으면 null).
 * autoRole = 지금 지점이 주는 역할(roleForPlace). 역할이 그것과 다르면 손으로 고른 것으로 본다
 */
export function taskDraft(t: TaskRow, rule: TaskRule | null, titles: Readonly<Record<string, string>> = {}, autoRole: string | null = null): TaskDraft {
  const r = rule?.repeat ?? null;
  return {
    title: t.title,
    due: t.due ?? "",
    dueEvent: t.due_event_id ? { id: t.due_event_id, title: titles[t.due_event_id] ?? "" } : null,
    est: t.est_min === null ? "" : String(t.est_min),
    note: t.note ?? "",
    place_id: t.place_id,
    checks: t.checklist.map((c) => c.t).join("\n"),
    repeat: !rule ? "none" : rule.kind === "event" ? "event" : r?.freq === "weekly" ? "weekly" : "daily",
    days: r?.freq === "weekly" ? [...r.days].sort((a, b) => a - b) : [],
    dueAfter: rule?.due_after == null ? "" : String(rule.due_after),
    role_id: t.role_id,
    roleManual: t.role_id !== null && t.role_id !== autoRole,
  };
}

/** 지점을 고른다. 역할을 손으로 고른 적이 없으면 그 지점의 역할을 채운다(맞는 역할이 없으면 그대로) */
export function draftWithPlace(d: TaskDraft, place: Pick<Place, "id" | "role"> | null, roles: Role[]): TaskDraft {
  const next = { ...d, place_id: place?.id ?? null };
  if (d.roleManual) return next;
  const r = roleForPlace(place, roles);
  return r ? { ...next, role_id: r.id } : next;
}

/** 역할 칩을 직접 눌렀다 */
export function draftWithRole(d: TaskDraft, role_id: string | null): TaskDraft {
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

export type TaskScope = "once" | "future";

/** 반복 설정(매일 / 매주 요일 · 마감까지 며칠)을 바꿨나 */
export function repeatChanged(d: TaskDraft, base: TaskDraft): boolean {
  return d.repeat !== base.repeat || (d.repeat === "weekly" && d.days.join() !== base.days.join()) || d.dueAfter.trim() !== base.dueAfter.trim();
}

/** 규칙이 만들 할 일의 모양(제목 · 걸릴 시간 · 지점 · 역할 · 메모 · 체크 항목 글자)을 바꿨나 */
export function templateChanged(d: TaskDraft, base: TaskDraft): boolean {
  return (
    d.title.trim() !== base.title.trim() ||
    d.est.trim() !== base.est.trim() ||
    d.note !== base.note ||
    d.place_id !== base.place_id ||
    d.role_id !== base.role_id ||
    parseChecks(d.checks).texts.join("\n") !== parseChecks(base.checks).texts.join("\n")
  );
}

/**
 * 저장할 때 고를 범위. 반복에서 온 할 일(base.repeat 이 none 이 아님)만:
 * 반복 설정을 바꾸면 '앞으로도' 만, 모양만 바꾸면 '이번만 / 앞으로도'. 반복을 끄거나 새로 켜면 빈 목록(그냥 저장)
 */
export function taskScopes(d: TaskDraft, base: TaskDraft): TaskScope[] {
  if (base.repeat === "none" || d.repeat === "none") return [];
  if (repeatChanged(d, base)) return ["future"];
  return templateChanged(d, base) ? ["once", "future"] : [];
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
