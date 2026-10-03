// 확인 모드 일정·플래너 데이터 — 목업(docs/mockup/schedule-v1.html)과 같은 지점 4곳 · 이동시간 · 일정.
// 날짜는 오늘이 속한 주(월요일) 기준 상대 날짜라 언제 열어도 이번 주에 보인다. 개발 모드에서만 불린다.
// 모임(meetDemo.ts)에 딸린 일정 · 모임에서 나온 할 일도 여기 들어 있다 (origin_kind = 'meet').

import { addDays, DEFAULT_SETTINGS, type DateStr } from "../../lib/schedule";
import { mondayOf, nowIn } from "../_logic/schedule";
import type { ScheduleSeed } from "./scheduleMemory";

const ID = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const DEMO_PLACES = { home: ID(1), school: ID(2), work: ID(3), cafe: ID(4) } as const;
const P = DEMO_PLACES;
/** 역할 넷: 기본 셋 + 지점에서 오지 않는 동아리 */
export const DEMO_ROLES = { univ: ID(401), teach: ID(402), me: ID(403), club: ID(404) } as const;
const R = DEMO_ROLES;
export const DEMO_CIRCLES = { apptive: ID(501), study: ID(502) } as const;
/** 모임과 딸린 일정의 id (meetDemo 의 모임이 가리킨다) */
export const DEMO_MEETS = { kickoff: ID(601), week3: ID(602), regular: ID(603), dinner: ID(604), plan: ID(605), after: ID(606) } as const;
export const DEMO_MEET_EVENTS = { kickoff: ID(131), week3: ID(132), regular: ID(133), dinner: ID(134) } as const;

/** 확인 모드 모임의 날짜 (모임 씨앗과 일정 씨앗이 같은 값을 쓴다) */
export function demoMeetDays(now: Date = new Date()): { kickoff: DateStr; week3: DateStr; regular: DateStr; dinner: DateStr; poll: DateStr[] } {
  const today = nowIn(DEFAULT_SETTINGS.tz, now).date;
  return {
    kickoff: addDays(today, -7),
    week3: addDays(today, -3),
    regular: addDays(today, 2),
    dinner: addDays(today, 5),
    poll: [8, 9, 10, 12].map((k) => addDays(today, k)),
  };
}

export function scheduleSeed(now: Date = new Date()): ScheduleSeed {
  const today = nowIn(DEFAULT_SETTINGS.tz, now).date;
  const W = mondayOf(today);
  const d = (k: number): DateStr => addDays(W, k);
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const md = demoMeetDays(now);
  const M = DEMO_MEETS;
  const ME = DEMO_MEET_EVENTS;
  const meetOrigin = (id: string) => ({ origin_kind: "meet" as const, origin_id: id });

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
      { id: ID(125), title: "송현이 누나 결혼식", date: addDays(today, 10), start_min: 720, end_min: 840 },
      // 모임에서 온 약속 (모임에 시간을 적으면 생긴다)
      { id: ME.kickoff, title: "APPTIVE 킥오프", date: md.kickoff, start_min: 1140, end_min: 1260, place_id: P.cafe, ...meetOrigin(M.kickoff) },
      { id: ME.week3, title: "알고리즘 스터디 3주차", date: md.week3, start_min: 960, end_min: 1080, place_id: P.school, where_text: "도서관 4층 스터디룸", ...meetOrigin(M.week3) },
      { id: ME.regular, title: "APPTIVE 정기 회의", date: md.regular, start_min: 1140, end_min: 1260, place_id: P.cafe, ...meetOrigin(M.regular) },
      { id: ME.dinner, title: "고등학교 동창 저녁", date: md.dinner, start_min: 1110, end_min: 1230, where_text: "서면 삼겹살집", ...meetOrigin(M.dinner) },
      // 어제 잡아 둔 시간이 지나간 할 일 (지남 묶음)
      { id: ID(126), title: "교수님 메일 답장", date: addDays(today, -1), start_min: 930, end_min: 960, task_id: ID(209) },
    ],
    roles: [
      { id: R.univ, name: "대학", from_place: "school", sort: 1, version: 1 },
      { id: R.teach, name: "강사", from_place: "work", sort: 2, version: 1 },
      { id: R.me, name: "개인", from_place: "home", sort: 3, version: 1 },
      { id: R.club, name: "동아리", from_place: null, sort: 4, version: 1 },
    ],
    tasks: [
      {
        id: ID(201),
        title: "팀플 발표 자료",
        est_min: 60,
        sort: 1,
        role_id: R.univ,
        place_id: P.school,
        note: "도입은 짧게. 사례 둘, 결론에 질문 하나",
        // 단계 안의 단계 · 단계별 걸릴 시간 (docs/플래너.md 7-16)
        checklist: [
          { t: "자료 조사", done: true, est: 15 },
          {
            t: "슬라이드 초안",
            done: false,
            sub: [
              { t: "도입", done: true, est: 10 },
              { t: "사례 둘", done: false, est: 25 },
              { t: "결론", done: false, est: 10 },
            ],
          },
          { t: "발표 대본 다듬기", done: false, est: 20 },
        ],
        // 작업대 첫째
        bench_order: 1,
      },
      {
        id: ID(202),
        title: "운영체제 과제 3",
        due: d(6),
        est_min: 120,
        sort: 2,
        place_id: P.school,
        role_id: R.univ,
        note: "스케줄링 문제는 강의 7장 예제부터 https://example.com/os/ch7\n제출은 PDF 하나",
        checklist: [
          { t: "문제 1 풀이", done: true },
          { t: "문제 2 풀이", done: false },
          { t: "보고서 정리", done: false },
        ],
        // 작업대 둘째
        bench_order: 2,
      },
      { id: ID(203), title: "자취방 계약서 확인", est_min: 30, sort: 3, role_id: R.me },
      { id: ID(204), title: "APPTIVE 회고 정리", sort: 4, place_id: P.cafe, role_id: R.club },
      { id: ID(205), title: "도서관 책 반납", sort: 5, done_at: ago(60 * 20), role_id: R.univ },
      { id: ID(206), title: "장학금 서류 제출", due: addDays(today, -1), est_min: 20, sort: 0.5, role_id: R.univ },
      { id: ID(207), title: "엄마 생일 선물 고르기", due: addDays(today, 4), est_min: 45, note: "향수 말고 다른 것. 예산 5만 원 안쪽", sort: 6, role_id: R.me, bench_order: 3 },
      { id: ID(208), title: "자료구조 퀴즈 복습", sort: 7, done_at: ago(60 * 24 * 3), role_id: R.univ },
      // 역할 없는 것 하나
      { id: ID(209), title: "교수님 메일 답장", est_min: 30, sort: 8 },
      // 일정에 딸린 마감
      { id: ID(210), title: "축의금 봉투 준비", due: addDays(today, 10), due_event_id: ID(125), sort: 9, role_id: R.me },
      { id: ID(212), title: "다음 주 수업 자료 인쇄", est_min: 20, sort: 9.5, place_id: P.work, role_id: R.teach },
      // 주간 반복 규칙의 이번 주 회차
      // 모임에서 나온 할 일 (묶음의 역할 · 모임의 지점을 물려받는다)
      { id: ID(221), title: "킥오프 회의록 공유", sort: 11, done_at: ago(60 * 24 * 6), role_id: R.club, place_id: P.cafe, ...meetOrigin(M.kickoff) },
      { id: ID(222), title: "화면 흐름 초안 그리기", est_min: 90, sort: 12, role_id: R.club, place_id: P.cafe, ...meetOrigin(M.kickoff) },
      { id: ID(223), title: "회의 안건 미리 올리기", due: md.regular, sort: 13, role_id: R.club, place_id: P.cafe, ...meetOrigin(M.regular) },
      { id: ID(211), title: "주간 정리", due: d(6), est_min: 40, sort: 10, rule_id: ID(301), rule_date: d(0), role_id: R.me, checklist: [{ t: "받은 편지함 비우기", done: false }, { t: "다음 주 일정 확인", done: false }] },
    ],
    // 시간 기록 몇 구간 (7-16): 어제 · 오늘. 열린 구간은 없다 — 시작은 사람이 누른다
    work: [
      { task_id: ID(201), started_at: ago(60 * 26), ended_at: ago(60 * 26 - 35) },
      { task_id: ID(201), started_at: ago(200), ended_at: ago(160) },
      { task_id: ID(202), started_at: ago(60 * 25), ended_at: ago(60 * 25 - 50) },
      { task_id: ID(202), started_at: ago(120), ended_at: ago(95) },
      { task_id: ID(211), started_at: ago(60 * 27), ended_at: ago(60 * 27 - 15) },
    ],
    rules: [
      {
        id: ID(301),
        kind: "cycle",
        title: "주간 정리",
        est_min: 40,
        checklist: ["받은 편지함 비우기", "다음 주 일정 확인"],
        repeat: { freq: "weekly", days: [1] },
        start: d(-14),
        due_after: 6,
        last_made: d(0),
        role_id: R.me,
      },
      // 수업(반복 일정)에 딸린 규칙 — 열 때 roll 이 가장 최근에 끝난 수업의 할 일을 만든다. 단계 틀이 든 채 작업대에 올라간다 (7-16)
      {
        id: ID(302),
        kind: "event",
        title: "자료구조 내용 정리",
        est_min: 30,
        place_id: P.school,
        event_id: ID(101),
        due_after: 6,
        role_id: R.univ,
        checklist: ["필기 옮기기", { t: "예제 풀기", est: 20, sub: ["기본", "응용"] }],
        bench: true,
      },
    ],
  };
}
