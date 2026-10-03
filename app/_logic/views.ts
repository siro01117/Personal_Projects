// 읽은 사람(설계서 7-4장)의 순수 계산 — 라벨 · 70초 판정 · 읽은 시간 · 기기 힌트 · 화면 가운데 블록 · 아바타 줄 · 라이브 합치기. vitest 로 시험한다.

import type { Presence, ViewRow } from "../_data/types";
import { relativeDay } from "./drawer";

/** last_at 이 이 안이면 지금 보는 중 (핑 30초 간격의 두 배 + 여유) */
export const LIVE_MS = 70_000;
/** 공개 페이지가 살아 있음을 알리는 간격 */
export const PING_MS = 30_000;
/** 한 핑에 더할 수 있는 읽은 초의 상한 (DB 도 같은 값으로 자른다) */
export const SEEN_MAX_SEC = 60;
/** 기록 창에 처음 보이는 줄 수 — 넘으면 "더 보기" */
export const HISTORY_FIRST = 20;
/** 아바타 줄에 보이는 사람 수 — 넘으면 +n */
export const AVATARS_MAX = 4;
/** 기기 열쇠 모양 (22자 base64url) */
export const DEVICE_RE = /^[A-Za-z0-9_-]{22}$/;
/** 이름 글자 수 상한 */
export const VIEWER_NAME_MAX = 20;

/** 보이는 이름: 적은 이름, 없으면 "게스트 n" */
export function viewerLabel(v: { name: string | null; guest_no: number }): string {
  return v.name ?? `게스트 ${v.guest_no}`;
}

export function isLive(lastAt: string, now: Date): boolean {
  const t = Date.parse(lastAt);
  return !Number.isNaN(t) && now.getTime() - t <= LIVE_MS;
}

/** 최근 것부터 (같으면 게스트 번호 순) */
export function sortViews(rows: readonly ViewRow[]): ViewRow[] {
  return [...rows].sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at) || a.guest_no - b.guest_no);
}

/** 읽은 시간: 1분 미만은 "1분 미만", 그 밖에는 "n분" (60분 넘으면 "n시간 m분") */
export function readTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "1분 미만";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}시간` : `${h}시간 ${rest}분`;
}

/** 마지막으로 본 때: 방금(70초 안) · n분 전 · n시간 전(오늘 안) · 그 뒤는 relativeDay(어제 · n일 전 · 날짜) */
export function seenAgo(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = now.getTime() - t;
  if (diff <= LIVE_MS) return "방금";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}분 전`;
  const day = relativeDay(iso, now);
  if (day !== "오늘") return day;
  return `${Math.floor(min / 60)}시간 전`;
}

/** 기기 힌트 한 줄: "폰 · Safari" · "PC · Chrome" 처럼 사람이 읽기 좋은 것만 (80자 안) */
export function uaHint(ua: string): string {
  const u = ua || "";
  const phone = /Mobi|Android|iPhone|iPad|iPod/i.test(u) ? (/iPad|Tablet/i.test(u) ? "태블릿" : "폰") : "PC";
  let browser = "브라우저";
  if (/Edg\//.test(u)) browser = "Edge";
  else if (/SamsungBrowser/i.test(u)) browser = "삼성 브라우저";
  else if (/Whale/i.test(u)) browser = "Whale";
  else if (/OPR\/|Opera/i.test(u)) browser = "Opera";
  else if (/Firefox\//.test(u)) browser = "Firefox";
  else if (/CriOS|Chrome\//.test(u)) browser = "Chrome";
  else if (/Safari\//.test(u) && /Apple/i.test(u)) browser = "Safari";
  return `${phone} · ${browser}`;
}

/** 무작위 16바이트 → 22자 base64url (기기 열쇠) */
export function deviceKey(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 이 기기의 열쇠: 있으면 그것, 없으면 만들어 둔다. 저장소가 없으면 그때그때 새 열쇠 (기록이 기기마다 안 모일 뿐) */
export function deviceOf(store: Pick<Storage, "getItem" | "setItem"> | null, random: (n: number) => Uint8Array): string {
  const KEY = "ezwork.device";
  try {
    const v = store?.getItem(KEY);
    if (v && DEVICE_RE.test(v)) return v;
  } catch {
    /* 못 읽으면 새로 */
  }
  const d = deviceKey(random(16));
  try {
    store?.setItem(KEY, d);
  } catch {
    /* 기억만 못 한다 */
  }
  return d;
}

/**
 * 화면 가운데(center)에 걸린 블록 번호. rects 는 블록마다 화면 기준 top · bottom (번호 순).
 * 가운데에 걸린 블록이 없으면(행 사이 여백) 가운데에 가장 가까운 블록. 블록이 없으면 null
 */
export function centerBlock(rects: readonly { top: number; bottom: number }[], center: number): number | null {
  let best: number | null = null;
  let dist = Infinity;
  rects.forEach((r, i) => {
    if (r.top <= center && center < r.bottom) {
      if (dist !== 0) {
        best = i;
        dist = 0;
      }
      return;
    }
    const d = center < r.top ? r.top - center : center - r.bottom;
    if (d < dist) {
      best = i;
      dist = d;
    }
  });
  return best;
}

/** 블록 번호 → 그 블록이 속한 절의 제목 (차례의 그 번호 이하 가장 가까운 항목). 앞에 제목이 없으면 "맨 위" */
export function sectionTitle(toc: readonly [number, string][], block: number | null): string {
  if (block === null) return "";
  let name: string | null = null;
  for (const [i, n] of toc) {
    if (i > block) break;
    name = n;
  }
  return name ?? "맨 위";
}

/** 지금 보는 사람 하나 (라이브 + 기록을 합친 것). block 은 라이브가 있을 때만 */
export type LivePerson = { device: string; label: string; block: number | null };

/**
 * 지금 보는 중: presence 에 있는 사람(위치 포함) + 기록에서 70초 안인데 presence 에 없는 사람(위치 없음).
 * presence 가 null 이면(Realtime 안 됨) 기록만으로. 라벨은 presence 것을 먼저(이름을 방금 바꿨을 수 있다). 라벨순(한국어 · 숫자는 수로)
 */
export function liveNow(presence: readonly Presence[] | null, rows: readonly ViewRow[], now: Date): LivePerson[] {
  const out = new Map<string, LivePerson>();
  for (const p of presence ?? []) out.set(p.device, { device: p.device, label: p.label, block: p.block });
  for (const r of rows) {
    if (out.has(r.device) || !isLive(r.last_at, now)) continue;
    out.set(r.device, { device: r.device, label: viewerLabel(r), block: null });
  }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label, "ko", { numeric: true }));
}

/** 아바타 줄: 앞 max 명 + 나머지 수 */
export function avatarRow<T>(people: readonly T[], max: number = AVATARS_MAX): { shown: T[]; more: number } {
  if (people.length <= max) return { shown: [...people], more: 0 };
  return { shown: people.slice(0, max), more: people.length - max };
}

/** 아바타 글자: 이름 첫 글자(공백 뒤는 뗀다). "게스트 n" 은 번호 */
export function avatarText(label: string): string {
  const m = /^게스트 (\d+)$/.exec(label);
  if (m) return m[1]!;
  const t = label.trim();
  return t === "" ? "?" : [...t][0]!.toUpperCase();
}

/** 키위 농담 번호 0~5 — 기기 열쇠로 정해 같은 사람은 늘 같은 색 */
export function avatarTone(device: string, tones = 6): number {
  let h = 0;
  for (let i = 0; i < device.length; i++) h = (h * 31 + device.charCodeAt(i)) >>> 0;
  return h % tones;
}

/** 블록 번호 → 그 블록을 보는 사람들 (block 이 있는 사람만) */
export function byBlock(people: readonly LivePerson[]): Map<number, LivePerson[]> {
  const out = new Map<number, LivePerson[]>();
  for (const p of people) {
    if (p.block === null) continue;
    const list = out.get(p.block) ?? [];
    list.push(p);
    out.set(p.block, list);
  }
  return out;
}
