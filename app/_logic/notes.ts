// 방명록 · 댓글 · 방문 기록(설계서 7-5장)의 순수 계산 — anchor 뽑기 · 블록 다시 찾기 · 버전 라벨 · 글 나누기 · 새 것 세기 · 방문 규칙. vitest 로 시험한다.

import { blockSchema } from "../../lib/blocks";
import { charCount, takeChars } from "../../lib/names";
import { stripMarks } from "../../lib/marks";
import type { NoteRow, ViewRow } from "../_data/types";

/** 글 한 편의 글자 수 상한 (DB 와 같다) */
export const NOTE_MAX = 1000;
/** 한 기기가 다음 글을 쓸 수 있을 때까지 (DB 와 같다) */
export const NOTE_GAP_MS = 10_000;
/** anchor 글자 수 — 블록의 소제목 또는 첫 60자 */
export const ANCHOR_CHARS = 60;
/** 이 안에 다시 들어오면 같은 방문 (DB 와 같다) */
export const VISIT_GAP_MS = 30 * 60_000;
/** 공개 페이지가 글 목록을 다시 읽는 간격 */
export const NOTES_REFRESH_MS = 30_000;

const WS = /\s+/g;

/** 블록을 다시 찾을 때 쓰는 글자 앞부분: 소제목(h), 없으면 첫 글의 앞 60자 (강조 표시 · 겹친 공백은 뺀다). 글자가 없으면 null */
export function anchorOf(raw: unknown): string | null {
  const r = blockSchema.safeParse(raw);
  const b = r.success ? r.data : null;
  let text = "";
  if (!b) {
    const h = (raw as { h?: unknown } | null)?.h;
    text = typeof h === "string" ? h : "";
  } else if (b.type !== "image" && b.type !== "verdict" && b.h) text = b.h;
  else {
    switch (b.type) {
      case "verdict":
        text = b.v || b.w || "";
        break;
      case "text":
        text = b.body;
        break;
      case "list":
        text = b.items.find((t) => t) ?? "";
        break;
      case "table":
        text = b.cols.join(" · ");
        break;
      case "claims":
        text = b.items.find((c) => c.text)?.text ?? "";
        break;
      case "sources":
        text = b.items.find((s) => s.title)?.title ?? "";
        break;
      case "image":
        text = b.caption || b.alt;
        break;
    }
  }
  const t = stripMarks(text).replace(WS, " ").trim();
  if (t === "") return null;
  return charCount(t) > ANCHOR_CHARS ? takeChars(t, ANCHOR_CHARS) : t;
}

export function anchorsOf(blocks: readonly unknown[]): (string | null)[] {
  return blocks.map(anchorOf);
}

/**
 * 댓글이 붙을 블록 번호. 같은 버전이면 그 번호. 버전이 다르면 anchor 가 같은 블록(원래 자리를 먼저, 그다음 앞에서부터) →
 * 같은 번호(범위 안이면) → 못 찾음(null). 방명록(block 없음)은 null
 */
export function findBlock(anchors: readonly (string | null)[], note: { block: number | null; anchor: string | null; version: number }, current: number): number | null {
  if (note.block === null) return null;
  const n = anchors.length;
  const same = note.block < n ? note.block : null;
  if (note.version === current) return same;
  if (note.anchor !== null) {
    if (same !== null && anchors[same] === note.anchor) return same;
    const i = anchors.indexOf(note.anchor);
    if (i >= 0) return i;
  }
  return same;
}

/** 지금 버전과 다를 때만 "v12", 같으면 "" */
export function versionLabel(version: number, current: number): string {
  return version === current ? "" : `v${version}`;
}

/** 글 쓴 사람의 이름: 주인 글은 ownerLabel, 기기 줄이 지워진 글은 "게스트" */
export function noteLabel(n: Pick<NoteRow, "by_owner" | "label">, ownerLabel: string): string {
  if (n.by_owner) return ownerLabel;
  return n.label ?? "게스트";
}

/** 오래된 것부터 (같으면 id) */
export function sortNotes(notes: readonly NoteRow[]): NoteRow[] {
  return [...notes].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type Placed = {
  /** 방명록 (block 없음) */
  guestbook: NoteRow[];
  /** 블록 번호 → 그 옆에 보일 댓글들 */
  byBlock: Map<number, NoteRow[]>;
  /** 블록을 못 찾은 댓글 — 목록에만 "원래 n번째 블록" 으로 */
  lost: NoteRow[];
};

/** 글들을 방명록 · 블록별 댓글 · 못 찾은 댓글로 나눈다 */
export function placeNotes(notes: readonly NoteRow[], anchors: readonly (string | null)[], current: number): Placed {
  const out: Placed = { guestbook: [], byBlock: new Map(), lost: [] };
  for (const n of sortNotes(notes)) {
    if (n.block === null) {
      out.guestbook.push(n);
      continue;
    }
    const i = findBlock(anchors, n, current);
    if (i === null) out.lost.push(n);
    else {
      const list = out.byBlock.get(i) ?? [];
      list.push(n);
      out.byBlock.set(i, list);
    }
  }
  return out;
}

/** 블록 번호 → 댓글 수 */
export function noteCounts(placed: Placed): Map<number, number> {
  return new Map([...placed.byBlock].map(([i, list]) => [i, list.length]));
}

/** 못 찾은 댓글의 자리 글자: "원래 3번째 블록" (번호는 1부터) */
export function lostLabel(n: { block: number | null }): string {
  return n.block === null ? "" : `원래 ${n.block + 1}번째 블록`;
}

export type NewCounts = { viewers: number; guestbook: number; comments: number };

/**
 * 마지막으로 창을 연 때(seen) 이후에 온 것 — 처음 온 사람(first_at) · 방명록 · 댓글(남이 쓴 것만, 지운 것은 이미 빠져 있다).
 * seen 이 없으면(한 번도 안 열었다) 전부 새 것
 */
export function newSince(views: readonly ViewRow[], notes: readonly NoteRow[], seen: string | null): NewCounts {
  const t = seen === null ? -Infinity : Date.parse(seen);
  const after = (iso: string) => Date.parse(iso) > t;
  const mine = notes.filter((n) => !n.by_owner && after(n.created_at));
  return {
    viewers: views.filter((v) => after(v.first_at)).length,
    guestbook: mine.filter((n) => n.block === null).length,
    comments: mine.filter((n) => n.block !== null).length,
  };
}

export const hasNew = (c: NewCounts): boolean => c.viewers + c.guestbook + c.comments > 0;

const SEEN_KEY = (itemId: string) => `ezwork.seen:${itemId}`;

/** 이 기기에서 그 보고서의 창을 마지막으로 연 때 (없으면 null) */
export function seenAt(store: Pick<Storage, "getItem"> | null, itemId: string): string | null {
  try {
    const v = store?.getItem(SEEN_KEY(itemId));
    return v && !Number.isNaN(Date.parse(v)) ? v : null;
  } catch {
    return null;
  }
}

export function markSeen(store: Pick<Storage, "setItem"> | null, itemId: string, now: Date): void {
  try {
    store?.setItem(SEEN_KEY(itemId), now.toISOString());
  } catch {
    /* 기억만 못 한다 */
  }
}

/** 마지막 방문이 이 안에 살아 있으면 같은 방문 (메모리 구현 · 화면 설명용. DB 는 같은 규칙을 자기 시계로 센다) */
export function isCurrentVisit(lastAt: string, now: Date): boolean {
  const t = Date.parse(lastAt);
  return !Number.isNaN(t) && now.getTime() - t <= VISIT_GAP_MS;
}

/** 다음 글을 쓸 수 있는 때까지 남은 ms (0 이면 지금) */
export function noteWaitMs(lastWroteAt: number | null, now: number): number {
  if (lastWroteAt === null) return 0;
  return Math.max(0, lastWroteAt + NOTE_GAP_MS - now);
}

// ------------------------------------------------------------ 블록 옆 댓글 패널 (설계서 7-6장)

/**
 * 패널 자리. slot 340 = 종이와의 틈 16 + 패널 324 — 종이는 slot 의 절반(170)만큼 왼쪽으로 밀려 "종이 + 패널" 이 가운데.
 * edge: 종이 · 패널이 doc-body 가장자리에서 떨어지는 최소 거리. minPage: 이보다 좁은 종이는 블록 아래(7-5 방식)
 */
export const SIDE = { slot: 340, gap: 16, edge: 16, minPage: 760 } as const;
export const SIDE_CARD = SIDE.slot - SIDE.gap;

/**
 * shift: 종이를 옮길 거리(≤ 0). x · y: 패널의 왼쪽 위, 밀리기 전 종이 기준(패널은 종이 안에 있어 같이 밀린다).
 * width: 자리가 모자라 종이를 좁혀야 할 때의 종이 폭(없으면 그대로)
 */
export type SidePlace = { shift: number; x: number; y: number; width?: number };

/**
 * 블록 옆 패널을 어디에 둘지. 넓으면 종이를 170 밀고 패널을 종이 오른쪽 16 옆에.
 * 왼쪽 자리가 모자라면 덜 밀고(종이가 가장자리 16 안으로), 그래도 오른쪽이 모자라면 **종이를 좁혀서** 나란히 세운다
 * (가장자리 16 · 종이 · 틈 16 · 패널 324 · 가장자리 16). 패널이 종이를 덮지 않는다.
 * body: doc-body 폭, left: 밀리기 전 종이 왼쪽(doc-body 기준), page: 종이의 원래 폭(좁히기 전), top: 블록 위(종이 기준).
 * 종이가 좁으면(좁힌 뒤에도 minPage 미만이면) null → 블록 아래 방식
 */
export function sidePlace(g: { body: number; left: number; page: number; top: number }): SidePlace | null {
  if (g.page < SIDE.minPage) return null;
  const y = Math.max(0, Math.round(g.top));
  // 글자가 흐려지지 않게 정수 px — 가장자리 16 을 넘지 않는 쪽으로 자른다. -0 은 0 으로
  const shift = Math.ceil(Math.min(0, Math.max(-SIDE.slot / 2, SIDE.edge - g.left))) || 0;
  const room = g.body - SIDE.edge - SIDE_CARD - (g.left + shift); // 밀린 종이 왼쪽에서 패널 왼쪽까지 쓸 수 있는 거리
  if (room >= g.page + SIDE.gap) return { shift, x: g.page + SIDE.gap, y };
  // 오른쪽이 모자란다: 종이를 가장자리에 붙이고(shift) 남는 폭만큼 좁힌다
  const tight = Math.ceil(Math.min(0, SIDE.edge - g.left)) || 0;
  const width = Math.floor(g.body - SIDE.edge - SIDE.slot - (g.left + tight));
  if (width < SIDE.minPage) return null;
  return { shift: tight, x: width + SIDE.gap, y, width };
}
