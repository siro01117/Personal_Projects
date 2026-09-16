// 개발용 픽스처 — ?fixture=1 로 AuthGate/Supabase 를 건너뛰고 화면을 확인할 때만 쓴다.
// PlanClient.js 가 `if (process.env.NODE_ENV === 'development')` 안에서만 동적으로
// import 하므로 프로덕션 번들에는 들어가지 않는다.
import { addDaysISO, dowOf, todayISO, uid } from '../../lib/plan-core';

export function buildFixture() {
  const T = todayISO();
  const D = (n) => addDaysISO(T, n);
  // 이번 주 월요일 (반복 일정 시작일로 쓴다 — 요일 계산이 자연스럽도록)
  let mon = T;
  while (dowOf(mon) !== 1) mon = addDaysISO(mon, -1);

  const doc = {
    version: 1,
    settings: { dayStart: 480, dayEnd: 1380, step: 30, buffer: 15, showClasses: true, semester: '2026-2' },
    events: [
      {
        id: 'fx-gym', title: '헬스장', place: '학교 체육관', note: '',
        important: false, date: mon, start: 1080, end: 1140, allDay: false,
        repeat: { freq: 'weekly', days: [1, 3], until: null }, exceptions: {}, color: 3,
      },
      {
        id: 'fx-dinner', title: '동아리 회식', place: '남포동', note: '2차는 자율',
        important: false, date: D(1), start: 1140, end: 1260, allDay: false,
        repeat: null, exceptions: {}, color: 5,
      },
      {
        id: 'fx-wedding', title: '민준 결혼식', place: '해운대 웨딩홀', note: '축의금 준비',
        important: true, date: D(20), start: 720, end: 840, allDay: false,
        repeat: null, exceptions: {}, color: 6,
      },
      {
        id: 'fx-dental', title: '치과 정기검진', place: '학교 앞 치과', note: '',
        important: true, date: D(45), start: 900, end: 960, allDay: false,
        repeat: null, exceptions: {}, color: 2,
      },
      {
        id: 'fx-family', title: '가족 모임', place: '본가', note: '',
        important: true, date: D(4), start: 660, end: 780, allDay: false,
        repeat: null, exceptions: {}, color: 0,
      },
    ],
    tasks: [
      { id: 'fx-t1', title: '무역학개론 과제 3', note: '', duration: 90, priority: 'high', due: D(3), slot: null, done: false, doneAt: null },
      { id: 'fx-t2', title: '경제원론 예습', note: '5장까지', duration: 60, priority: 'normal', due: D(6), slot: null, done: false, doneAt: null },
      { id: 'fx-t3', title: '자격증 인강 밀린 것 듣기', note: '', duration: 120, priority: 'low', due: null, slot: null, done: false, doneAt: null },
      { id: 'fx-t4', title: '방 청소', note: '', duration: 30, priority: 'normal', due: null, slot: null, done: false, doneAt: null },
      { id: 'fx-t5', title: '지난 학기 자료 정리', note: '', duration: 45, priority: 'low', due: null, slot: null, done: true, doneAt: D(-1) },
    ],
    classOverrides: {},
  };

  const classes = [
    {
      courseId: 'fx-c1', title: '무역학개론', color: 1, room: '경상관 401', startDate: D(-30), endDate: D(90),
      meetings: [
        { id: 'm1', day: 2, start: 540, end: 630, room: '경상관 401' },
        { id: 'm2', day: 4, start: 540, end: 630, room: '경상관 401' },
      ],
    },
    {
      courseId: 'fx-c2', title: '경제원론', color: 4, room: '경상관 210', startDate: D(-30), endDate: D(90),
      meetings: [{ id: 'm1', day: 1, start: 630, end: 720, room: '경상관 210' }],
    },
    {
      courseId: 'fx-c3', title: '영어회화', color: 5, room: '인문관 105', startDate: D(-30), endDate: D(90),
      meetings: [{ id: 'm1', day: 3, start: 780, end: 870, room: '인문관 105' }],
    },
  ];

  return { doc, classes };
}

export const fixtureUid = uid;
