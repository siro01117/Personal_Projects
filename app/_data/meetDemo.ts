// 확인 모드 모임 데이터 — 묶음 2개, 다가오는 모임 · 미정 · 맞추는 중(링크 켜짐, 둘이 칠해 둠) · 지난 모임, 참석 표시.
// 공개 페이지 확인: /m/demo-meet-link-0000001?demo=1 (민서 · 도윤의 핀은 1234). 새로 고치면 처음으로 돌아간다.
// 딸린 일정과 할 일은 일정 쪽 씨앗(scheduleDemo.ts)에 같은 id 로 들어 있다. 날짜는 오늘 기준 상대 날짜. 개발 모드에서만 불린다.

import type { Cells } from "../../lib/meet";
import type { MeetSeed } from "./meetMemory";
import { DEMO_CIRCLES, DEMO_MEET_EVENTS, DEMO_MEETS, DEMO_PLACES, DEMO_ROLES, demoMeetDays } from "./scheduleDemo";

/** 공개 페이지 확인용 고정 열쇠 */
export const DEMO_MEET_TOKEN = "demo-meet-link-0000001";
/** 확인 모드에서 이미 들어온 사람들의 핀 */
export const DEMO_MEET_PIN = "1234";

/** from 부터 to 앞까지 30분 칸 */
const span = (from: number, to: number): number[] => Array.from({ length: (to - from) / 30 }, (_, i) => from + i * 30);

export function meetSeed(now: Date = new Date()): MeetSeed {
  const d = demoMeetDays(now);
  const [p0, p1, p2, p3] = d.poll as [string, string, string, string];
  const minseo: Cells = { [p0]: span(600, 870), [p1]: span(780, 1020), [p3]: span(1080, 1260) };
  const doyun: Cells = { [p0]: span(720, 960), [p2]: span(1080, 1260), [p3]: span(1140, 1320) };
  const C = DEMO_CIRCLES;
  const M = DEMO_MEETS;
  const E = DEMO_MEET_EVENTS;
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  return {
    circles: [
      { id: C.apptive, name: "APPTIVE 1팀", role_id: DEMO_ROLES.club, members: ["민서", "도윤", "하린", "지후"] },
      { id: C.study, name: "알고리즘 스터디", role_id: DEMO_ROLES.univ, members: ["서연", "준우"] },
    ],
    meets: [
      {
        id: M.kickoff,
        title: "APPTIVE 킥오프",
        circle_id: C.apptive,
        place_id: DEMO_PLACES.cafe,
        meet_date: d.kickoff,
        start_min: 1140,
        end_min: 1260,
        event_id: E.kickoff,
        note: "이번 학기 목표를 정했다. 주 1회 정기 회의, 화요일 저녁.\n역할: 민서 디자인 · 도윤 서버 · 하린 앱",
        created_at: ago(60 * 24 * 12),
        me: "yes",
        people: [
          { name: "민서", attend: "yes" },
          { name: "도윤", attend: "yes" },
          { name: "하린", attend: "no" },
          { name: "지후", attend: "yes" },
        ],
      },
      {
        id: M.week3,
        title: "알고리즘 스터디 3주차",
        circle_id: C.study,
        place_id: DEMO_PLACES.school,
        place_text: "도서관 4층 스터디룸",
        meet_date: d.week3,
        start_min: 960,
        end_min: 1080,
        event_id: E.week3,
        created_at: ago(60 * 24 * 9),
        me: "yes",
        people: [
          { name: "서연", attend: "yes" },
          { name: "준우", attend: null },
        ],
      },
      {
        id: M.regular,
        title: "APPTIVE 정기 회의",
        circle_id: C.apptive,
        place_id: DEMO_PLACES.cafe,
        meet_date: d.regular,
        start_min: 1140,
        end_min: 1260,
        event_id: E.regular,
        note: "화면 흐름 검토, 다음 스프린트 범위",
        created_at: ago(60 * 24 * 5),
        me: "yes",
        people: [
          { name: "민서", attend: "yes" },
          { name: "도윤", attend: "no" },
          { name: "하린", attend: null },
          { name: "지후", attend: null },
        ],
      },
      {
        id: M.dinner,
        title: "고등학교 동창 저녁",
        place_text: "서면 삼겹살집",
        meet_date: d.dinner,
        start_min: 1110,
        end_min: 1230,
        event_id: E.dinner,
        created_at: ago(60 * 24 * 3),
        people: [{ name: "태윤" }, { name: "가은" }, { name: "현수" }],
      },
      // 맞추는 중 — 링크가 켜져 있고 민서 · 도윤이 칠해 두었다. 내 칸은 화면을 열 때 일정에서 채워진다
      {
        id: M.plan,
        title: "APPTIVE 기획 회의",
        circle_id: C.apptive,
        place_id: DEMO_PLACES.cafe,
        poll: { dates: d.poll, day_from: 540, day_to: 1320, duration_min: 90 },
        token: DEMO_MEET_TOKEN,
        created_at: ago(60 * 24 * 2),
        people: [{ name: "민서", cells: minseo, pin: DEMO_MEET_PIN }, { name: "도윤", cells: doyun, pin: DEMO_MEET_PIN }, { name: "하린" }, { name: "지후" }],
      },
      {
        id: M.after,
        title: "스터디 뒤풀이",
        circle_id: C.study,
        created_at: ago(60 * 20),
        people: [{ name: "서연" }, { name: "준우" }],
      },
    ],
  };
}
