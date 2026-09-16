// 개발용 픽스처 — ?fixture=1 로 AuthGate/Supabase 를 건너뛰고 화면을 확인할 때만 쓴다.
// DashClient.js 가 `if (process.env.NODE_ENV === 'development')` 안에서만 동적으로
// import 하므로 프로덕션 번들에는 들어가지 않는다.
// 규칙이 실제로 뭘 띄우는지 보려고 급함/확인/참고가 하나씩은 나오게 짜둔다.
import { addDaysISO, todayISO } from '../../lib/plan-core';
import { normalizeSessions } from '../../lib/dash';

export function buildFixture() {
  const T = todayISO();
  const D = (n) => addDaysISO(T, n);
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

  const snapshot = {
    at: new Date(Date.now() - 4 * 60000).toISOString(),
    host: 'D-',
    repos: [
      {
        name: 'Personal_Projects', path: 'C:/…', branch: 'main', upstream: 'origin/main',
        ahead: 2, behind: 0,
        unpushed: [
          { sha: '6cc47e7', subject: 'fix(plan): 개요 섹션 간격 중복 제거', at: ago(0.2) },
          { sha: '1a2b3c4', subject: 'feat(dash): 현황 대시보드', at: ago(5) },
        ],
        dirty: { n: 2, files: ['app/globals.css', 'lib/dash-rules.js'] },
        lastCommit: { sha: '6cc47e7', subject: 'fix(plan): 개요 섹션 간격 중복 제거', at: ago(0.2) },
      },
      {
        name: 'studycube.cloud', path: 'C:/…', branch: 'main', upstream: 'origin/main',
        ahead: 0, behind: 3, unpushed: [],
        dirty: { n: 0, files: [] },
        lastCommit: { sha: '9f3a944', subject: 'refactor(study): 진도 탭 단순화', at: ago(1) },
      },
      {
        name: 'Studycube_info', path: 'C:/…', branch: 'main', upstream: 'origin/main',
        ahead: 0, behind: 0, unpushed: [], dirty: { n: 0, files: [] },
        lastCommit: { sha: 'ae0aff7', subject: 'data: 상법 2주차 요약', at: ago(5) },
      },
    ],
    vault: {
      ok: true, notes: 472,
      daily: { date: D(-1), note: `데일리/${D(-1)}.md`, mtime: ago(1) },
      openItems: [
        { note: '도쿄 2026-08', path: '자료/일본여행/도쿄 2026-08.md', heading: '미결', text: '숙소 결제 확인', done: false, mtime: ago(28) },
        { note: '도쿄 2026-08', path: '자료/일본여행/도쿄 2026-08.md', heading: '미결', text: '공항 이동편 예약', done: false, mtime: ago(28) },
        { note: '웹앱 작업 로그 2026-09', path: '프로젝트/스터디큐브/웹앱 작업 로그 2026-09.md', heading: '미결', text: '스케쥴 입력 활성화 — 2주 미제출 39명', done: false, mtime: ago(16) },
        { note: '2026-09-16', path: `데일리/${D(-1)}.md`, heading: '미결', text: 'Main 공유 Everyone 권한 회수', done: false, mtime: ago(1) },
      ],
    },
  };

  const plan = {
    version: 1,
    settings: { dayStart: 480, dayEnd: 1380, step: 30, buffer: 15, showClasses: true, showWork: true, semester: '2026-2' },
    events: [
      { id: 'fx-a', title: '무역학개론', place: '본관 201', date: T, start: 540, end: 650, allDay: false, repeat: null, exceptions: {}, color: 1, important: false },
      { id: 'fx-b', title: '학과 상담', place: '학과 사무실', date: T, start: 620, end: 700, allDay: false, repeat: null, exceptions: {}, color: 4, important: false },
      { id: 'fx-c', title: '헬스장', place: '학교 체육관', date: T, start: 1080, end: 1140, allDay: false, repeat: null, exceptions: {}, color: 3, important: false },
      // '앞으로' 줄을 확인하려면 important 가 붙은 먼 약속이 있어야 한다
      { id: 'fx-d', title: '가족 모임', place: '본가', date: D(4), start: 660, end: 780, allDay: false, repeat: null, exceptions: {}, color: 2, important: true },
      { id: 'fx-e', title: '민준 결혼식', place: '해운대 웨딩홀', date: D(20), start: 720, end: 840, allDay: false, repeat: null, exceptions: {}, color: 5, important: true },
      { id: 'fx-f', title: '치과 정기검진', place: '학교 앞 치과', date: D(45), start: 900, end: 960, allDay: false, repeat: null, exceptions: {}, color: 6, important: true },
    ],
    tasks: [
      { id: 'fx-t1', title: '무역학개론 과제 3', duration: 90, due: D(-2), done: false, slot: null, priority: 2 },
      { id: 'fx-t2', title: '경제원론 예습', duration: 60, due: D(1), done: false, slot: null, priority: 1 },
      { id: 'fx-t3', title: '방 청소', duration: 30, due: null, done: false, slot: null, priority: 0 },
    ],
    classOverrides: {},
  };

  const sessions = normalizeSessions({
    list: [
      { id: 'plan', title: '일정 모듈 /plan', status: 'active', repo: 'Personal_Projects', at: ago(0.1),
        note: '여백 중복·7일 띠 정렬 정리 끝', awaiting: '이동시간·피로도 scorer 기준',
        next: ['scorer 구현', '실제 일정 입력'] },
      { id: 'vault', title: '볼트 노트 최신화', status: 'paused', at: ago(4),
        blocked: '라칸 포털 노트가 저장소 실태와 어긋남 — 어디까지 고칠지 미정' },
      { id: 'cube', title: '스터디큐브 배포', status: 'active', repo: 'studycube.cloud', at: ago(1),
        note: '미배포 커밋 정리 중' },
    ],
  });

  return { snapshot, sessions, plan };
}
