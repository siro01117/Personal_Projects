// 모임의 상태는 칸에서 읽는다 (docs/모임.md 2장) — 따로 적어 두지 않는다.

import { daysBetween, type DateStr } from "../schedule";
import type { MeetRow } from "./types";

/** polling = 맞추는 중 · open = 미정 · upcoming = 다가옴 · past = 지난 모임 */
export type MeetStatus = "polling" | "open" | "upcoming" | "past";

/** 지금: 오늘 날짜와 0시부터 센 분 (Asia/Seoul) */
export type MeetAt = { date: DateStr; min: number };

type Timed = Pick<MeetRow, "meet_date" | "start_min" | "end_min" | "poll">;

/** 시간이 정해졌나 */
export function decided(m: Pick<MeetRow, "meet_date">): boolean {
  return m.meet_date !== null;
}

/**
 * 시간 없음 + poll 있음 = 맞추는 중 · 시간 없음 + poll 없음 = 미정 · 시간 있고 아직 안 끝남 = 다가옴 · 끝남 = 지난 모임.
 * 끝 시각이 지금과 같으면 지난 것 (플래너의 지남과 같은 경계)
 */
export function meetStatus(m: Timed, at: MeetAt): MeetStatus {
  if (m.meet_date === null || m.end_min === null) return m.poll ? "polling" : "open";
  return daysBetween(m.meet_date, at.date) * 1440 + at.min >= m.end_min ? "past" : "upcoming";
}

export type MeetLists<T> = { todo: T[]; upcoming: T[]; past: T[] };

/** 카드 셋으로: 정할 것(맞추는 중 · 미정) · 다가오는 모임 · 지난 모임. 순서는 받은 그대로 (정렬은 sortMeets) */
export function splitMeets<T extends Timed>(meets: readonly T[], at: MeetAt): MeetLists<T> {
  const out: MeetLists<T> = { todo: [], upcoming: [], past: [] };
  for (const m of meets) {
    const s = meetStatus(m, at);
    if (s === "upcoming") out.upcoming.push(m);
    else if (s === "past") out.past.push(m);
    else out.todo.push(m);
  }
  return out;
}
