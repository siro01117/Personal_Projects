// 데모 전용 더미 데이터 시드 — 고정 시드 PRNG로 결정적 생성.
// 실제 studycube DB 스키마(room/seat/student/attendance_event/patrol_event/patrol_session)의
// row 모양을 그대로 흉내낸다. 새로고침하면 이 모듈이 다시 평가되어 초기 상태로 리셋된다.
import { todayKey, minuteOfKST } from "./date";
import { PATROL_BY_KEY } from "./patrol";
import type { DaySlot, Period } from "./schedule";

// ---------------- PRNG(mulberry32) — 고정 시드 → 매 로드 같은 데이터 ----------------
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260829);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const shuffle = <T,>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
let idSeq = 0;
export const newId = (prefix: string) => `${prefix}_${(++idSeq).toString(36)}`;

const TODAY = todayKey();
// 시드 시각은 전부 "지금(로드 시점)보다 과거"로만 만든다 — 그래야 사용자가 실시간으로 누르는
// 입/퇴실·순찰 조작이 항상 가장 최신 기록이 되어 화면에 곧바로 반영된다(occupancy 는 최신 시각 우선).
const NOW_MIN = minuteOfKST(new Date().toISOString());
const WIN_END = Math.max(520, NOW_MIN - 12); // 지금보다 12분 이상 과거까지만
const WIN_START = Math.max(400, WIN_END - 420); // 최대 7시간 폭
/** KST 날짜(TODAY) + 분(minute-of-day) → UTC ISO 문자열. date.ts 의 minuteOfKST/timeLabel 이
 * Asia/Seoul 로 되돌려 읽으므로, 절대 시각만 맞으면 표시는 항상 의도한 KST 시각으로 나온다. */
function kstToISO(minute: number, dateKey: string = TODAY): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const hh = Math.floor(minute / 60);
  const mm = minute % 60;
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, int(0, 59))).toISOString();
}

// ---------------- 학생 이름 ----------------
const NAMES = [
  "김민준", "이서연", "박도윤", "최지우", "정하윤", "강시우", "조서준", "윤예은",
  "장주원", "임하은", "한지호", "오수아", "서준서", "신유나", "권민서", "황지안",
  "안도현", "송채원", "전우진", "홍서윤", "고은우", "문가은", "양시윤", "손하람",
  "배서현", "백준혁", "노아인", "허지민", "남궁준", "심유진", "구태양", "탁예린",
  "곽민재", "성지호", "여수빈", "차은호", "주다인", "우현서", "라온이", "표승민",
  "설아름", "동현우", "천서아", "지민호", "빈시아", "옥지훈", "매하율", "육지안",
];

type Level = "middle" | "high" | "adult";
function levelGrade(): { level: Level; grade: string | null; is_repeat: boolean } {
  const r = rnd();
  if (r < 0.32) return { level: "middle", grade: String(int(1, 3)), is_repeat: false };
  if (r < 0.86) return { level: "high", grade: String(int(1, 3)), is_repeat: false };
  return { level: "adult", grade: null, is_repeat: rnd() < 0.5 };
}
const SCHOOLS_MID = ["해운중", "남천중", "동래중", "수영중", "연산중"];
const SCHOOLS_HIGH = ["해운대고", "남천고", "동래고", "부산고", "혜안고"];

export type Student = {
  id: string; name: string; level: string | null; grade: string | null; is_repeat: boolean | null;
  school: string | null; status: string; birthdate: string | null; gender: string | null;
  guardian_phone: string | null; student_phone: string | null; enrolled_at: string | null;
};

export const students: Student[] = NAMES.map((name, i) => {
  const { level, grade, is_repeat } = levelGrade();
  const school = level === "adult" ? null : pick(level === "middle" ? SCHOOLS_MID : SCHOOLS_HIGH);
  const birthYear = level === "middle" ? 2011 + int(0, 2) : level === "high" ? 2008 + int(0, 2) : int(1998, 2006);
  const enrolledMonthsAgo = int(1, 18);
  const enrolled = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - enrolledMonthsAgo, int(1, 28)));
  return {
    id: newId("stu"),
    name,
    level,
    grade,
    is_repeat,
    school,
    status: "enrolled",
    birthdate: `${birthYear}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`,
    gender: i % 2 === 0 ? "male" : "female",
    guardian_phone: `010-${int(1000, 9999)}-${int(1000, 9999)}`,
    student_phone: `010-${int(1000, 9999)}-${int(1000, 9999)}`,
    enrolled_at: enrolled.toISOString().slice(0, 10),
  };
});

// ---------------- 방/좌석 ----------------
export type Room = { id: string; name: string; floor: number; cols: number; rows: number; pos_x: number; pos_y: number; door_side: string | null };
export type Seat = {
  id: string; room_id: string | null; grid_x: number | null; grid_y: number | null;
  number: number | null; label: string; seat_type: string | null; facing: string | null;
  status: string; current_student_id: string | null;
};

const GAP_X = 100, GAP_Y = 80, ORIGIN_X = 40, ORIGIN_Y = 40;
const ROOM_DEFS = [
  { name: "A실", floor: 4, perRow: 6, count: 18, door: "top" },
  { name: "B실", floor: 4, perRow: 5, count: 15, door: "left" },
  { name: "C실", floor: 5, perRow: 6, count: 17, door: "top" },
  { name: "D실", floor: 5, perRow: 5, count: 10, door: "right" },
] as const;

export const rooms: Room[] = ROOM_DEFS.map((rd, i) => ({
  id: newId("room"),
  name: rd.name,
  floor: rd.floor,
  cols: rd.perRow,
  rows: Math.ceil(rd.count / rd.perRow),
  pos_x: (i % 2) * 420 + 40,
  pos_y: Math.floor(i / 2) * 320 + 40,
  door_side: rd.door,
}));

export const seats: Seat[] = [];
let seatNumber = 1;
rooms.forEach((room, ri) => {
  const rd = ROOM_DEFS[ri];
  for (let i = 0; i < rd.count; i++) {
    const col = i % rd.perRow, row = Math.floor(i / rd.perRow);
    seats.push({
      id: newId("seat"),
      room_id: room.id,
      grid_x: ORIGIN_X + col * GAP_X,
      grid_y: ORIGIN_Y + row * GAP_Y,
      number: seatNumber,
      label: String(seatNumber),
      seat_type: null,
      facing: "down",
      status: "empty",
      current_student_id: null,
    });
    seatNumber++;
  }
});

// 학생 45명을 좌석에 배정(총 60석 중 45), 2석은 점검중으로 표시
const assignable = shuffle(seats.map((s) => s.id));
const studentPool = shuffle(students.map((s) => s.id));
const ASSIGNED_COUNT = 45;
for (let i = 0; i < ASSIGNED_COUNT; i++) {
  const seat = seats.find((s) => s.id === assignable[i])!;
  seat.current_student_id = studentPool[i];
  seat.status = "occupied";
}
for (let i = ASSIGNED_COUNT; i < ASSIGNED_COUNT + 2; i++) {
  const seat = seats.find((s) => s.id === assignable[i]);
  if (seat) seat.status = "maintenance";
}
const assignedStudentIds = new Set(studentPool.slice(0, ASSIGNED_COUNT));
const unassignedStudentIds = studentPool.slice(ASSIGNED_COUNT);

// ---------------- 스케쥴(등하원 + 일정 블록) — 매일 같은 고정 패턴 ----------------
export type ScheduleEntry = { hours: { arrive_min: number; leave_min: number } | null; slots: DaySlot[] };
export const scheduleMap: Record<string, ScheduleEntry> = {};
export const periods: Period[] = [
  { start: 570, end: 690 },   // 09:30–11:30
  { start: 700, end: 820 },   // 11:40–13:40
  { start: 850, end: 1020 },  // 14:10–17:00
  { start: 1050, end: 1260 }, // 17:30–21:00
];
const EXTRA_REASONS: { reason: string; kind: string; dur: number }[] = [
  { reason: "외부 학원", kind: "academy", dur: 120 },
  { reason: "원내 수업", kind: "academy", dur: 90 },
  { reason: "주간 상담", kind: "counsel", dur: 30 },
  { reason: "외부 일정", kind: "absent", dur: 60 },
];
for (const s of students) {
  const hasSchedule = rnd() < 0.9; // 10%는 스케쥴 정보 자체가 없음(고스트 "정보없음")
  if (!hasSchedule) { scheduleMap[s.id] = { hours: null, slots: [] }; continue; }
  const arrive = pick([540, 570, 600, 780, 800]); // 09:00/09:30/10:00/13:00/13:20
  const leave = pick([1230, 1260, 1290, 1320]);   // 20:30/21:00/21:30/22:00
  const slots: DaySlot[] = [];
  if (rnd() < 0.35) {
    const ex = pick(EXTRA_REASONS);
    const start = int(arrive + 60, Math.max(arrive + 61, leave - ex.dur - 30));
    slots.push({ start, end: start + ex.dur, reason: ex.reason, kind: ex.kind });
  }
  scheduleMap[s.id] = { hours: { arrive_min: arrive, leave_min: leave }, slots };
}

// ---------------- 오늘 출결 이벤트 ----------------
export type AttEvent = { id: string; student_id: string; kind: "in" | "out"; auto: boolean; date: string; at: string; note: string | null; created_by: string };
export const attendanceEvents: AttEvent[] = [];
const CHECKOUT_NOTES = ["조퇴(사유 있음)", "병원", "학원 추가 일정", "귀가", null, null];

const presentIds = shuffle([...assignedStudentIds]);
// 대부분은 8~15시 사이 등원(자연스러운 분포: 등교 전 이른 시간대에 몰림)
presentIds.forEach((sid, i) => {
  const arriveMin = int(WIN_START, Math.max(WIN_START + 1, WIN_END - 40)); // 등원은 지금보다 충분히 이전
  attendanceEvents.push({ id: newId("att"), student_id: sid, kind: "in", auto: false, date: TODAY, at: kstToISO(arriveMin), note: null, created_by: "demo" });
});
// 그중 일부는 퇴실 후 재입실(외출~복귀) — 전부 WIN_END(=지금 근처) 이전
shuffle(presentIds).slice(0, 6).forEach((sid) => {
  const first = attendanceEvents.find((e) => e.student_id === sid)!;
  const firstMin = Math.round(new Date(first.at).getUTCHours() * 60 + new Date(first.at).getUTCMinutes() + 540) % 1440;
  const outMin = Math.min(WIN_END - 20, firstMin + int(20, 60));
  const backMin = Math.min(WIN_END - 5, outMin + int(5, 15));
  attendanceEvents.push({ id: newId("att"), student_id: sid, kind: "out", auto: false, date: TODAY, at: kstToISO(outMin), note: pick(CHECKOUT_NOTES), created_by: "demo" });
  attendanceEvents.push({ id: newId("att"), student_id: sid, kind: "in", auto: false, date: TODAY, at: kstToISO(backMin), note: null, created_by: "demo" });
});
// 몇 명은 완전히 하원 처리 — 역시 WIN_END 이전
shuffle(presentIds).slice(0, 7).forEach((sid) => {
  const first = attendanceEvents.filter((e) => e.student_id === sid).sort((a, b) => a.at.localeCompare(b.at))[0];
  if (!first) return;
  const firstMin = Math.round(new Date(first.at).getUTCHours() * 60 + new Date(first.at).getUTCMinutes() + 540) % 1440;
  const outMin = Math.min(WIN_END - 15, firstMin + int(30, 90));
  attendanceEvents.push({ id: newId("att"), student_id: sid, kind: "out", auto: false, date: TODAY, at: kstToISO(outMin), note: pick(CHECKOUT_NOTES), created_by: "demo" });
});

// ---------------- 순찰 세션 2개(오전/오후) ----------------
export type PatrolEvent = { id: string; student_id: string; state: string; points: number; session_id: string | null; seat_id: string | null; date: string; at: string; created_by: string };
export type PatrolSession = { id: string; started_at: string; ended_at: string | null; created_by: string; started_by_name: string };
export const patrolSessions: PatrolSession[] = [];
export const patrolEvents: PatrolEvent[] = [];

const PATROL_KEYS = Object.keys(PATROL_BY_KEY);
function seedPatrolSession(startMin: number, endMin: number, markCount: number) {
  const sess: PatrolSession = { id: newId("psess"), started_at: kstToISO(startMin), ended_at: kstToISO(endMin), created_by: "demo", started_by_name: "관리자(데모)" };
  patrolSessions.push(sess);
  const candidates = shuffle([...assignedStudentIds]).slice(0, markCount);
  candidates.forEach((sid, i) => {
    const state = pick(PATROL_KEYS);
    const preset = PATROL_BY_KEY[state];
    const at = kstToISO(int(startMin, endMin));
    const seat = seats.find((s) => s.current_student_id === sid) ?? null;
    patrolEvents.push({
      id: newId("pe"), student_id: sid, state, points: preset.points,
      session_id: sess.id, seat_id: seat?.id ?? null, date: TODAY, at, created_by: "demo",
    });
  });
}
// 오전 순찰(이른 시간대) / 오후 순찰(WIN_END 바로 이전 = "가장 최근" 기록) — 전부 지금보다 과거.
seedPatrolSession(WIN_START + 20, WIN_START + 50, int(15, 25));
seedPatrolSession(WIN_END - 35, WIN_END - 10, int(15, 25));

export const TODAY_KEY = TODAY;
export { unassignedStudentIds };
