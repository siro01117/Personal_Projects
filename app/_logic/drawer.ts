// 화면 쪽 순수 함수 — 정렬·안 읽음·경로 접기·키보드 이동·옮길 곳 목록. vitest 로 시험한다.

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
 * 날짜순이어도 폴더끼리는 이름순, 보고서끼리만 최근 고친 것 먼저(같으면 이름순)
 */
export function sortEntries<T extends { kind: Kind; name: string; updated_at?: string }>(list: readonly T[], mode: SortMode = "name"): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, "ko");
  const byDate = (a: T, b: T) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "") || byName(a, b);
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
