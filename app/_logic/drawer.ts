// 화면 쪽 순수 함수 — 정렬·안 읽음·경로 접기·키보드 이동·옮길 곳 목록. vitest 로 시험한다.

import { REPORT_KINDS, type ReportKind } from "../../lib/blocks";
import type { Folder, Kind } from "../_data/types";

/** 에이전트가 쓴 뒤 아직 열어 보지 않았으면 안 읽음 (설계서 2장: agent_updated_at > read_at) */
export function isUnread(x: { agent_updated_at: string | null; read_at: string | null }): boolean {
  if (x.agent_updated_at === null) return false;
  if (x.read_at === null) return true;
  return Date.parse(x.agent_updated_at) > Date.parse(x.read_at);
}

export type SortMode = "name" | "date";

/**
 * 폴더 먼저, 그다음 보고서. 이름순은 한국어 정렬(한글이 영문보다 앞).
 * 날짜순이어도 폴더끼리는 이름순, 보고서끼리만 최근 것 먼저(같으면 이름순).
 * 날짜는 목록 보기 '고친 때' 열과 같은 값(freshAt): 에이전트가 마지막으로 쓴 때, 없으면 만든 때
 */
export function sortEntries<
  T extends { kind: Kind; name: string; updated_at?: string; agent_updated_at?: string | null; created_at?: string | null },
>(list: readonly T[], mode: SortMode = "name"): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, "ko");
  const at = (e: T) => Date.parse(e.agent_updated_at ?? e.created_at ?? e.updated_at ?? "") || 0;
  const byDate = (a: T, b: T) => at(b) - at(a) || byName(a, b);
  return [...list].sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : mode === "date" && a.kind === "report" ? byDate(a, b) : byName(a, b)));
}

/** Shift 클릭: 기준(anchor)부터 누른 것까지, 목록 순서대로. 기준이 목록에 없으면 누른 것 하나 */
export function selectRange(ids: readonly string[], anchor: string | null, target: string): string[] {
  const a = anchor === null ? -1 : ids.indexOf(anchor);
  const b = ids.indexOf(target);
  if (b < 0) return [];
  if (a < 0) return [target];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Ctrl/⌘ 클릭: 있으면 빼고 없으면 넣는다 */
export function toggleId(sel: readonly string[], id: string): string[] {
  return sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
}

/** tops = 묶음의 맨 위 항목 수 (자손은 세지 않는다) */
export type TrashGroup<T> = { batch: string; deleted_at: string; first: T; tops: number };

/** 휴지통 줄(묶음의 맨 위 항목마다 한 줄) → 묶음 하나에 한 줄. 순서는 들어온 대로(최근 지운 것 먼저) */
export function groupTrash<T extends { batch: string; deleted_at: string }>(rows: readonly T[]): TrashGroup<T>[] {
  const out = new Map<string, TrashGroup<T>>();
  for (const r of rows) {
    const g = out.get(r.batch);
    if (g) g.tops++;
    else out.set(r.batch, { batch: r.batch, deleted_at: r.deleted_at, first: r, tops: 1 });
  }
  return [...out.values()];
}

/** 묶음 이름: 첫 맨 위 항목 이름 + " 외 N개" (N = 나머지 맨 위 항목 수). 하나면 이름만 */
export function trashLabel(name: string, tops: number): string {
  return tops > 1 ? `${name} 외 ${tops - 1}개` : name;
}

/** 복원 결과 알림 (맨 위 항목 기준). 제자리·같은 이름이면 null */
export function restoreNote(
  rows: readonly { id: string; name: string; to_root: boolean; renamed: boolean }[],
  topIds: readonly string[],
): string | null {
  const tops = rows.filter((r) => topIds.includes(r.id));
  if (tops.length === 1) {
    const t = tops[0]!;
    if (t.to_root && t.renamed) return `이름이 겹쳐 ‘${t.name}’ 이름으로 맨 위에 복원했습니다`;
    if (t.to_root) return "맨 위로 복원했습니다";
    if (t.renamed) return `이름이 겹쳐 ‘${t.name}’ 이름으로 복원했습니다`;
    return null;
  }
  const root = tops.some((t) => t.to_root);
  const renamed = tops.some((t) => t.renamed);
  if (root && renamed) return "일부는 맨 위로, 일부는 이름을 바꿔 복원했습니다";
  if (root) return "일부는 맨 위로 복원했습니다";
  if (renamed) return "이름이 겹친 것은 이름을 바꿔 복원했습니다";
  return null;
}

/** 주소의 도메인 (www. 는 뗀다). 주소가 아니면 null */
export function domainOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h ? h.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

/** 맨 위 → id 까지의 폴더 줄. 없는 id 면 null */
export function folderTrail(folders: readonly Folder[], id: string | null): Folder[] | null {
  if (id === null) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: Folder[] = [];
  for (let cur = byId.get(id), guard = 0; cur && guard < 64; guard++) {
    out.unshift(cur);
    cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id);
    if (!cur && out[0]!.parent_id !== null) return null; // 중간이 비었다 (그 사이 지워짐)
  }
  return out.length > 0 ? out : null;
}

/** id 가 ancestor 자신이거나 그 안에 있는지 */
export function isInside(folders: readonly Folder[], id: string | null, ancestor: string): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (let cur = id, guard = 0; cur !== null && guard < 64; guard++) {
    if (cur === ancestor) return true;
    cur = byId.get(cur)?.parent_id ?? null;
  }
  return false;
}

export type Crumb<T> = { kind: "item"; item: T } | { kind: "more"; hidden: T[] };

/**
 * 경로가 길면 가운데를 … 로 접는다. 처음(서랍)과 끝 (max - 2)개는 남긴다.
 * max 이하면 그대로.
 */
export function collapseTrail<T>(trail: readonly T[], max = 4): Crumb<T>[] {
  if (trail.length <= max || max < 3) return trail.map((item) => ({ kind: "item", item }));
  const tail = max - 2;
  return [
    { kind: "item", item: trail[0]! },
    { kind: "more", hidden: trail.slice(1, trail.length - tail) },
    ...trail.slice(trail.length - tail).map((item) => ({ kind: "item" as const, item })),
  ];
}

/**
 * 격자에서 화살표로 옮길 칸. 선택이 없으면(-1) 첫 칸.
 * 좌우는 한 칸, 위아래는 한 줄(cols 칸). 끝을 넘으면 그 자리에 머문다.
 */
export function gridMove(index: number, key: string, count: number, cols: number): number {
  if (count === 0) return -1;
  if (index < 0) return 0;
  const c = Math.max(1, cols);
  switch (key) {
    case "ArrowRight":
      return Math.min(index + 1, count - 1);
    case "ArrowLeft":
      return Math.max(index - 1, 0);
    case "ArrowDown":
      return index + c < count ? index + c : index;
    case "ArrowUp":
      return index - c >= 0 ? index - c : index;
    default:
      return index;
  }
}

/**
 * 옮길 곳 목록 (메뉴의 옮기기). 맨 위(null) + 폴더들, 이름순.
 * 빼는 것: 지금 있는 폴더, 자기 자신, 폴더면 자기 안의 폴더.
 */
export function moveTargets(
  folders: readonly Folder[],
  item: { id: string; kind: Kind; parent_id: string | null },
): (Folder | null)[] {
  const list = folders
    .filter((f) => f.id !== item.id && f.id !== item.parent_id)
    .filter((f) => item.kind !== "folder" || !isInside(folders, f.id, item.id))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return item.parent_id === null ? list : [null, ...list];
}

/** 여러 개를 옮길 곳: 모두에게 뜻이 있는 곳만 (moveTargets 규칙 + canDrop) */
export function moveTargetsAll(
  folders: readonly Folder[],
  items: readonly { id: string; kind: Kind; parent_id: string | null }[],
): (Folder | null)[] {
  if (items.length === 0) return [];
  return moveTargets(folders, items[0]!).filter((f) => items.every((it) => canDrop(folders, it, f === null ? null : f.id)));
}

/** 끌어 놓기가 뜻이 있는지: 자기 자신 위·지금 있는 폴더 위·자기 안은 무동작 */
export function canDrop(
  folders: readonly Folder[],
  item: { id: string; kind: Kind; parent_id: string | null },
  target: string | null,
): boolean {
  if (target === item.id || target === item.parent_id) return false;
  if (item.kind === "folder" && target !== null && isInside(folders, target, item.id)) return false;
  return true;
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** 9월 30일 (올해가 아니면 2025년 9월 30일) */
export function formatDay(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}년 ${md}`;
}

/** 9월 30일 14:05 (올해가 아니면 2025년 9월 30일 14:05) */
export function formatWhen(iso: string | null, now: Date = new Date()): string {
  const day = formatDay(iso, now);
  if (!day) return "";
  const d = new Date(iso!);
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 홈 머리: 9월 30일 수요일 */
export function formatToday(now: Date = new Date()): string {
  return `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEKDAY[now.getDay()]}요일`;
}

/** 로그인 뒤 돌아갈 곳. 같은 사이트 안 경로만 (//다른곳 · 주소 통째 금지) */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

/** 링크로 걸어도 되는 주소면 그대로, 아니면 null (http/https 만) */
export function httpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** blocks 안 그 자리의 글자 (없거나 글자가 아니면 null) */
export function textAt(blocks: unknown, path: readonly (string | number)[]): string | null {
  let here: unknown = blocks;
  for (const seg of path) {
    if (here === null || typeof here !== "object") return null;
    here = (here as Record<string | number, unknown>)[seg];
  }
  return typeof here === "string" ? here : null;
}

/** blocks 의 그 자리 글자를 바꾼 사본 (원본은 그대로) */
export function withTextAt<T>(blocks: T, path: readonly (string | number)[], value: string): T {
  if (path.length === 0) return blocks;
  const copy = structuredClone(blocks);
  let here: unknown = copy;
  for (const seg of path.slice(0, -1)) {
    if (here === null || typeof here !== "object") return blocks;
    here = (here as Record<string | number, unknown>)[seg];
  }
  const last = path[path.length - 1]!;
  if (here === null || typeof here !== "object" || typeof (here as Record<string | number, unknown>)[last] !== "string") return blocks;
  (here as Record<string | number, unknown>)[last] = value;
  return copy;
}

// ---------------------------------------------------------------- 신선도 · 목록 보기 (설계서 7-2장)

const DAY_MS = 24 * 60 * 60 * 1000;

/** 달력 날짜 차이 (시각은 보지 않는다): 오늘 0, 어제 1 */
function dayDiff(d: Date, now: Date): number {
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / DAY_MS);
}

/** 오늘 · 어제 · n일 전(2~6) · n주 전(1~3) · 그보다 오래면 날짜(formatDay). 미래(시계 차이)는 오늘 */
export function relativeDay(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const n = dayDiff(d, now);
  if (n <= 0) return "오늘";
  if (n === 1) return "어제";
  if (n < 7) return `${n}일 전`;
  if (n < 28) return `${Math.floor(n / 7)}주 전`;
  return formatDay(iso, now);
}

/** 신선도 기준 시각: 보고서는 에이전트가 마지막으로 쓴 때(없으면 만든 때), 폴더는 고친 때 */
export function freshAt(e: { kind: Kind; agent_updated_at: string | null; created_at?: string | null; updated_at: string }): string | null {
  if (e.kind === "folder") return e.updated_at;
  return e.agent_updated_at ?? e.created_at ?? e.updated_at;
}

export type ViewMode = "icons" | "list";

/** 목록 보기 '종류' 열 */
export function kindLabel(e: { kind: Kind; report_kind?: ReportKind | null }): string {
  if (e.kind === "folder") return "폴더";
  return e.report_kind ? REPORT_KINDS[e.report_kind] : "보고서";
}

// ---------------------------------------------------------------- 사진 출처 한 줄 (설계서 8-1장)

export type ImageCredit =
  | { kind: "ref"; n: number; title: string; domain: string | null; url: string | null }
  | { kind: "credit"; text: string }
  | { kind: "local"; path: string }
  | null;

/**
 * 사진 아래 출처 한 줄: ref(출처 블록 번호) → credit(짧은 글) → local_path(내 PC 원본) 순으로 하나.
 * 공유 페이지는 local_path 가 이미 빠져 온다(ez_shared_doc). 가리킬 출처가 없는 ref 는 건너뛴다
 */
export function imageCredit(
  b: { ref?: number; credit?: string; local_path?: string },
  sources: readonly { title: string; url: string }[] | undefined,
): ImageCredit {
  const s = b.ref !== undefined ? sources?.[b.ref - 1] : undefined;
  if (b.ref !== undefined && s) return { kind: "ref", n: b.ref, title: s.title, domain: domainOf(s.url), url: httpUrl(s.url) };
  if (b.credit !== undefined) return { kind: "credit", text: b.credit };
  if (b.local_path !== undefined) return { kind: "local", path: b.local_path };
  return null;
}

// ---------------------------------------------------------------- 블록 고르기 · 지우기 · 옮기기 (설계서 3장)
// 순서(order)는 새 순서로 늘어놓은 옛 블록 번호 — DB ez_blocks_arrange 에 그대로 보낸다.

const sortedUnique = (count: number, picked: readonly number[]): number[] =>
  [...new Set(picked)].filter((i) => Number.isInteger(i) && i >= 0 && i < count).sort((a, b) => a - b);

/** 고른 블록을 뺀 순서 */
export function orderWithout(count: number, picked: readonly number[]): number[] {
  const gone = new Set(picked);
  return Array.from({ length: count }, (_, i) => i).filter((i) => !gone.has(i));
}

/**
 * 고른 블록들을 slot 자리에 한 덩어리로 옮긴 순서. slot 은 옛 번호 기준 0~count — 그 번호 블록의 앞(count = 맨 끝).
 * 고른 것끼리는 원래 순서를 지킨다
 */
export function orderMoved(count: number, picked: readonly number[], slot: number): number[] {
  const group = sortedUnique(count, picked);
  const rest = orderWithout(count, group);
  const at = Math.max(0, Math.min(count, Math.trunc(slot)));
  const before = rest.filter((i) => i < at);
  return [...before, ...group, ...rest.slice(before.length)];
}

/** Alt+↑(-1) / Alt+↓(1): 고른 덩어리를 한 칸. 떨어져 있던 것은 맨 위(아래) 것 자리로 모인다. 더 갈 곳이 없으면 그대로 */
export function orderStepped(count: number, picked: readonly number[], dir: -1 | 1): number[] {
  const group = sortedUnique(count, picked);
  if (group.length === 0) return orderWithout(count, []);
  return orderMoved(count, group, dir < 0 ? group[0]! - 1 : group[group.length - 1]! + 2);
}

export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * 끌고 있는 자리(x, y)에서 놓일 자리: 0~boxes.length (그 번호 블록의 앞, 끝이면 맨 뒤). boxes 는 블록 순서대로.
 * 세로로 가장 가까운 블록을 고르고(한 행에 둘이 서면 가로로 가까운 쪽), 그 블록의 위 절반이면 앞, 아래 절반이면 뒤
 */
export function dropSlot(boxes: readonly Box[], x: number, y: number): number {
  let best = -1;
  let bestDy = Infinity;
  let bestDx = Infinity;
  boxes.forEach((r, i) => {
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (dy < bestDy || (dy === bestDy && dx < bestDx)) {
      best = i;
      bestDy = dy;
      bestDx = dx;
    }
  });
  if (best < 0) return 0;
  const r = boxes[best]!;
  return y < (r.top + r.bottom) / 2 ? best : best + 1;
}

/** 놓일 선의 자리: 위아래로 이웃한 두 블록 사이면 가운데, 아니면 그 블록에서 gap 만큼 바깥. 폭은 뒤(없으면 앞) 블록 */
export function dropLine(boxes: readonly Box[], slot: number, gap = 14): { x: number; y: number; w: number } | null {
  if (boxes.length === 0) return null;
  const next = boxes[slot];
  const prev = boxes[slot - 1];
  if (next) {
    const stacked = prev !== undefined && prev.bottom <= next.top;
    return { x: next.left, y: stacked ? (prev.bottom + next.top) / 2 : next.top - gap, w: next.right - next.left };
  }
  if (!prev) return null;
  return { x: prev.left, y: prev.bottom + gap, w: prev.right - prev.left };
}

// ---------------------------------------------------------------- 되돌리기 기록 (설계서 3장 "고치기 도구 줄")
// 기록은 블록을 번호가 아니라 열쇠로 기억한다 — 그 뒤 순서가 바뀌어도 되돌릴 때 지금 번호로 다시 찾는다.

type Seg = string | number;

/** H = 미뤄 둔 지우기(화면 쪽이 쥐고 있는 것). 저장 전일 때만 살릴 수 있다 */
export type UndoEntry<H = unknown> =
  | { kind: "text"; key: string | null; rest: Seg[]; value: string }
  | { kind: "move"; keys: string[] }
  | { kind: "delete"; held: H };

/** 한 화면에서 기억하는 되돌리기 수 */
export const UNDO_MAX = 100;

/** 글자 고치기의 기록: 블록 안이면 블록 열쇠 + 나머지 경로, 제목 · 작성자면 경로 그대로. value = 고치기 전 글자 */
export function undoForText(keys: readonly string[], path: readonly Seg[], value: string): UndoEntry<never> | null {
  const head = path[0];
  if (typeof head !== "number") return path.length === 0 ? null : { kind: "text", key: null, rest: [...path], value };
  const key = keys[head];
  return key === undefined ? null : { kind: "text", key, rest: path.slice(1), value };
}

/** 글자 기록이 가리키는 지금 경로. 그 블록이 없어졌으면 null */
export function undoTextPath(keys: readonly string[], e: { key: string | null; rest: readonly Seg[] }): Seg[] | null {
  if (e.key === null) return [...e.rest];
  const i = keys.indexOf(e.key);
  return i < 0 ? null : [i, ...e.rest];
}

/** 옮기기 전 순서(before)로 돌아가는 order — 지금 번호들을 옛 순서로 늘어놓은 것. 블록 구성이 달라졌으면 null */
export function orderBack(now: readonly string[], before: readonly string[]): number[] | null {
  if (now.length !== before.length) return null;
  const at = new Map(now.map((k, i) => [k, i]));
  if (at.size !== now.length) return null;
  const order: number[] = [];
  for (const k of before) {
    const i = at.get(k);
    if (i === undefined) return null;
    at.delete(k);
    order.push(i);
  }
  return order;
}

/** 기록 하나를 쌓는다. 넘치면 오래된 것부터 버린다 */
export function pushUndo<T>(stack: readonly T[], entry: T, max = UNDO_MAX): T[] {
  const next = [...stack, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
