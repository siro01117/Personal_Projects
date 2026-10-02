// 모임 목록 정렬 (docs/모임.md 5장): 날짜 · 묶음 · 역할 (+ 오름/내림). 거르지 않고 정렬만 한다.
// 묶음 · 역할로 정렬하면 값이 바뀌는 자리에 경계 묶음이 선다 — 플래너의 sortGroups 와 같은 방식.

import type { Role } from "../schedule";
import type { Circle, MeetRow } from "./types";

export const MEET_SORT_KEYS = ["date", "circle", "role"] as const;
export type MeetSortKey = (typeof MEET_SORT_KEYS)[number];
export type MeetSortDir = "asc" | "desc";
export type MeetSort = { key: MeetSortKey; dir: MeetSortDir };
export const DEFAULT_MEET_SORT: MeetSort = { key: "date", dir: "asc" };
/** 묶음 · 역할 없는 묶음의 라벨 */
export const MEET_NONE_LABEL = "없음";

/** 어느 카드의 줄인가 — 날짜의 '가까운 것부터' 가 카드마다 다르다 */
export type MeetCard = "todo" | "upcoming" | "past";

/** 기억해 둔 정렬 글자(JSON `{key, dir}`) → 정렬. 못 읽거나 값이 이상하면 날짜 · 오름 */
export function parseMeetSort(raw: string | null | undefined): MeetSort {
  if (!raw) return DEFAULT_MEET_SORT;
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== "object" || o === null) return DEFAULT_MEET_SORT;
    const { key, dir } = o as { key?: unknown; dir?: unknown };
    if (!MEET_SORT_KEYS.includes(key as MeetSortKey) || (dir !== "asc" && dir !== "desc")) return DEFAULT_MEET_SORT;
    return { key: key as MeetSortKey, dir };
  } catch {
    return DEFAULT_MEET_SORT;
  }
}

type Row = Pick<MeetRow, "id" | "circle_id" | "meet_date" | "start_min" | "poll" | "created_at">;

/** 날짜 열쇠: 정해졌으면 그 날짜 · 시각, 맞추는 중이면 첫 후보 날짜, 미정이면 없음 */
function when(m: Row): string | null {
  if (m.meet_date !== null) return `${m.meet_date} ${String(m.start_min ?? 0).padStart(4, "0")}`;
  return m.poll?.dates[0] ?? null;
}

/**
 * 한 카드 안의 날짜 순서. 가까운 것부터(near) — 다가오는 모임 · 정할 것은 이른 날짜부터, 지난 모임은 최근 것부터.
 * 날짜가 없는 것(미정)은 늘 맨 뒤, 그 안에서는 최근에 만든 것부터
 */
export function byDate<T extends Row>(rows: readonly T[], card: MeetCard, near = true): T[] {
  const sign = (card === "past") === near ? -1 : 1;
  const dated: { row: T; at: string }[] = [];
  const rest: T[] = [];
  for (const row of rows) {
    const at = when(row);
    if (at === null) rest.push(row);
    else dated.push({ row, at });
  }
  dated.sort((a, b) => sign * a.at.localeCompare(b.at) || a.row.created_at.localeCompare(b.row.created_at));
  rest.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return [...dated.map((x) => x.row), ...rest];
}

/** 경계 묶음. kind: all = 구분 없는 한 묶음(날짜), circle / role = 그 값의 묶음(key 는 그 id), none = 없음 */
export type MeetGroup<T> = { key: string; label: string; kind: "all" | "circle" | "role" | "none"; items: T[] };

/** 그 모임의 살아 있는 묶음 (묶음이 없거나 지운 묶음이면 null) */
export function circleOf(m: Pick<MeetRow, "circle_id">, circles: readonly Circle[]): Circle | null {
  return m.circle_id === null ? null : (circles.find((c) => c.id === m.circle_id) ?? null);
}

/** 그 모임이 물려받는 살아 있는 역할 id — 묶음의 역할 (묶음이 없거나 지운 역할이면 null) */
export function roleIdOf(m: Pick<MeetRow, "circle_id">, circles: readonly Circle[], roles: readonly Pick<Role, "id">[]): string | null {
  const id = circleOf(m, circles)?.role_id ?? null;
  return id !== null && roles.some((r) => r.id === id) ? id : null;
}

/**
 * 한 카드의 줄을 정렬해 경계 묶음으로 나눈다.
 * 날짜: 한 묶음. 오름 = 가까운 것부터(byDate), 내림 = 그 반대.
 * 묶음 · 역할: 묶음은 이름순(한글 먼저), 역할은 목록(sort) 순으로 묶고 없는 것(지운 묶음 · 지운 역할 포함)은 늘 맨 뒤.
 *   묶음 안은 가까운 것부터, 내림이면 묶음 순서만 뒤집는다. 줄이 없으면 빈 배열
 */
export function sortMeets<T extends Row>(
  rows: readonly T[],
  sort: MeetSort,
  card: MeetCard,
  by: { circles: readonly Circle[]; roles: readonly Pick<Role, "id" | "name" | "sort">[] },
): MeetGroup<T>[] {
  if (rows.length === 0) return [];
  if (sort.key === "date") return [{ key: "all", label: "", kind: "all", items: byDate(rows, card, sort.dir === "asc") }];
  const kind = sort.key;
  const heads =
    kind === "circle"
      ? [...by.circles].sort((a, b) => a.name.localeCompare(b.name, "ko")).map((c) => ({ id: c.id, name: c.name }))
      : [...by.roles].sort((a, b) => a.sort - b.sort).map((r) => ({ id: r.id, name: r.name }));
  if (sort.dir === "desc") heads.reverse();
  const idOf = (row: T) => (kind === "circle" ? (circleOf(row, by.circles)?.id ?? null) : roleIdOf(row, by.circles, by.roles));
  const near = byDate(rows, card);
  const groups: MeetGroup<T>[] = heads.map((h) => ({ key: h.id, label: h.name, kind, items: near.filter((r) => idOf(r) === h.id) }));
  groups.push({ key: "none", label: MEET_NONE_LABEL, kind: "none", items: near.filter((r) => idOf(r) === null) });
  return groups.filter((g) => g.items.length > 0);
}
