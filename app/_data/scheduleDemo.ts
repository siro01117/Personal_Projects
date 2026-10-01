// 확인 모드 일정·플래너 데이터 — 목업(docs/mockup/schedule-v1.html)과 같은 지점 4곳 · 이동시간 · 일정.
// 날짜는 오늘이 속한 주(월요일) 기준 상대 날짜라 언제 열어도 이번 주에 보인다. 개발 모드에서만 불린다.

import { addDays, DEFAULT_SETTINGS, type DateStr } from "../../lib/schedule";
import { mondayOf, nowIn } from "../_logic/schedule";
import type { ScheduleSeed } from "./scheduleMemory";

const ID = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const DEMO_PLACES = { home: ID(1), school: ID(2), work: ID(3), cafe: ID(4) } as const;
const P = DEMO_PLACES;

export function scheduleSeed(now: Date = new Date()): ScheduleSeed {
  const today = nowIn(DEFAULT_SETTINGS.tz, now).date;
  const W = mondayOf(today);
  const d = (k: number): DateStr => addDays(W, k);
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

  return {
    places: [
      { id: P.home, name: "집", role: "home", symbol: "home", color: "sand", sort: 1, deleted: false },
      { id: P.school, name: "학교", role: "school", symbol: "school", color: "sky", sort: 2, deleted: false },
      { id: P.work, name: "스터디큐브", role: "work", symbol: "work", color: "violet", sort: 3, deleted: false },
      { id: P.cafe, name: "카페", role: null, symbol: "cafe", color: "peach", sort: 4, deleted: false },
    ],
    travel: [
      { a: P.home, b: P.school, minutes: 30 },
      { a: P.home, b: P.work, minutes: 20 },
      { a: P.home, b: P.cafe, minutes: 15 },
      { a: P.school, b: P.cafe, minutes: 20 },
      { a: P.school, b: P.work, minutes: 25 },
      { a: P.work, b: P.cafe, minutes: 15 },
    ].map((t) => (t.a < t.b ? t : { a: t.b, b: t.a, minutes: t.minutes })),
    sources: [
      { source: "univ", label: "대학", synced_at: ago(60 * 24 * 20) },
      { source: "studycube", label: "스터디큐브", synced_at: ago(95) },
    ],
    events: [
      // 대학 시간표 (바깥 일정, 매주 반복)
      { id: ID(101), title: "자료구조", date: d(-14), start_min: 630, end_min: 720, place_id: P.school, repeat: { freq: "weekly", days: [1, 3] }, source: "univ", external_id: "ds-2026-2" },
      { id: ID(102), title: "운영체제", date: d(-13), start_min: 780, end_min: 870, place_id: P.school, repeat: { freq: "weekly", days: [2, 4] }, source: "univ", external_id: "os-2026-2" },
      // 스큐 근무 (바깥 일정)
      ...[0, 2, 4].map((k) => ({
        id: ID(110 + k),
        title: "스큐 근무",
        date: d(k),
        start_min: 1020,
        end_min: 1320,
        place_id: P.work,
        source: "studycube",
        external_id: `shift-${d(k)}`,
      })),
      // 내가 만든 것
      { id: ID(120), title: "스터디", date: d(1), start_min: 1080, end_min: 1130, place_id: P.school },
      {
        id: ID(121),
        title: "APPTIVE 회의",
        date: d(-6),
        start_min: 1140,
        end_min: 1260,
        place_id: P.cafe,
        repeat: { freq: "weekly", days: [2] },
        note: "회고, 다음 스프린트 범위",
      },
      { id: ID(122), title: "팀플 정리", date: d(3), start_min: 930, end_min: 990, note: "발표 자료 역할 나누기", task_id: ID(201) },
      { id: ID(123), title: "마감 작업", date: d(4), start_min: 1380, end_min: 1500 },
      { id: ID(124), title: "본가", date: d(5), start_min: null, end_min: null },
    ],
    tasks: [
      { id: ID(201), title: "팀플 발표 자료", est_min: 60, sort: 1 },
      { id: ID(202), title: "운영체제 과제 3", due: d(6), est_min: 120, sort: 2 },
      { id: ID(203), title: "자취방 계약서 확인", est_min: 30, sort: 3 },
      { id: ID(204), title: "APPTIVE 회고 정리", sort: 4 },
      { id: ID(205), title: "도서관 책 반납", sort: 5, done_at: ago(60 * 20) },
      { id: ID(206), title: "장학금 서류 제출", due: addDays(today, -1), est_min: 20, sort: 0.5 },
      { id: ID(207), title: "엄마 생일 선물 고르기", due: addDays(today, 4), est_min: 45, note: "향수 말고 다른 것. 예산 5만 원 안쪽", sort: 6 },
      { id: ID(208), title: "자료구조 퀴즈 복습", sort: 7, done_at: ago(60 * 24 * 3) },
    ],
  };
}
