// 겹침과 추천 시간 (docs/모임.md 3장). 설정 밖으로 나간 칸은 계산에서 뺀다.

import type { DateStr } from "../schedule";
import { clipCells, pollSlots, SLOT_MIN } from "./cells";
import type { MeetAt } from "./status";
import type { Cells, Poll } from "./types";

/** 겹침 · 추천을 계산할 때 필요한 사람 한 줄 */
export type Painter = { name: string; cells: Cells | null; is_owner: boolean };

export const cellKey = (date: DateStr, min: number) => `${date}|${min}`;

export type Overlap = {
  /** 칠한 사람 수 (cells 가 있는 사람 — 진하기의 분모) */
  painted: number;
  /** 칸마다 되는 사람 이름들 (사람 줄 순서). 아무도 안 되는 칸은 없다 */
  at: Map<string, string[]>;
};

export function overlap(people: readonly Painter[], poll: Poll): Overlap {
  const at = new Map<string, string[]>();
  let painted = 0;
  for (const p of people) {
    if (p.cells === null) continue;
    painted += 1;
    const mine = clipCells(p.cells, poll);
    for (const d of poll.dates) {
      for (const m of mine[d] ?? []) {
        const k = cellKey(d, m);
        const list = at.get(k);
        if (list) list.push(p.name);
        else at.set(k, [p.name]);
      }
    }
  }
  return { painted, at };
}

/** 색 진하기: 되는 수 ÷ 칠한 사람 수를 4단으로 (0 = 아무도 없음) */
export function overlapLevel(count: number, painted: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || painted <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / painted) * 4))) as 1 | 2 | 3 | 4;
}

export type Suggestion = {
  date: DateStr;
  start: number;
  end: number;
  /** 끝까지 다 되는 사람 수 */
  count: number;
  names: string[];
  /** 내가 되는가 */
  mine: boolean;
};

export const SUGGEST_MAX = 5;

/**
 * 추천 시간: 길이만큼 이어진 칸 묶음(30분씩 밀어 가며)마다 끝까지 다 되는 사람.
 * 차례: 사람 수 많은 순 → 내가 되는 것 먼저 → 이른 날짜 · 이른 시각. 겹치는 묶음은 앞선 것 하나만.
 * 0명짜리 · 이미 시작 시각이 지난 것은 뺀다. limit 개까지
 */
export function suggestTimes(people: readonly Painter[], poll: Poll, at: MeetAt, limit = SUGGEST_MAX): Suggestion[] {
  const clipped = people
    .filter((p) => p.cells !== null)
    .map((p) => {
      const mine = clipCells(p.cells, poll);
      return { p, sets: new Map(poll.dates.map((d) => [d, new Set(mine[d] ?? [])])) };
    });
  const need = poll.duration_min / SLOT_MIN;
  const all: Suggestion[] = [];
  for (const date of poll.dates) {
    if (date < at.date) continue;
    for (const start of pollSlots(poll)) {
      const end = start + poll.duration_min;
      if (end > poll.day_to) break;
      if (date === at.date && start <= at.min) continue;
      const who = clipped.filter(({ sets }) => {
        const set = sets.get(date)!;
        for (let i = 0; i < need; i++) if (!set.has(start + i * SLOT_MIN)) return false;
        return true;
      });
      if (who.length === 0) continue;
      all.push({ date, start, end, count: who.length, names: who.map((w) => w.p.name), mine: who.some((w) => w.p.is_owner) });
    }
  }
  all.sort((a, b) => b.count - a.count || Number(b.mine) - Number(a.mine) || a.date.localeCompare(b.date) || a.start - b.start);
  const out: Suggestion[] = [];
  for (const s of all) {
    if (out.length >= limit) break;
    if (out.some((o) => o.date === s.date && o.start < s.end && s.start < o.end)) continue;
    out.push(s);
  }
  return out;
}
