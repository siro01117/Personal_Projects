"use client";
// 데모용 인메모리 스토어 — 원본의 DB(Postgres) 자리를 대신한다. 전부 브라우저 메모리에만 있고
// 새로고침하면 seed.ts 가 다시 평가되어 초기 상태로 리셋된다(의도된 동작).
// mockActions(actions.ts/attendanceActions.ts/roomActions.ts/patrolActions.ts)가 이 스토어를
// FormData 어댑터로 감싸 원본과 같은 export 시그니처를 유지한다.
import { todayKey, minuteOfKST } from "./date";
import { buildOccupancy, type SeatOcc, type LastAttRow, type LastPatrolRow } from "./occupancy";
import { PATROL_BY_KEY } from "./patrol";
import type { ActualAttendance, DaySlot, Period } from "./schedule";
import {
  rooms as seedRooms, seats as seedSeats, students as seedStudents,
  attendanceEvents as seedAttEvents, patrolEvents as seedPatrolEvents, patrolSessions as seedPatrolSessions,
  scheduleMap as seedScheduleMap, periods as seedPeriods, newId,
  type Room, type Seat, type Student, type AttEvent, type PatrolEvent, type PatrolSession, type ScheduleEntry,
} from "./seed";

export type { Room, Seat, Student };

type DailyStatus = { student_id: string; date: string; status: string; reason: string | null };

const state = {
  rooms: seedRooms as Room[],
  seats: seedSeats as Seat[],
  students: seedStudents as Student[],
  attendanceEvents: seedAttEvents as AttEvent[],
  dailyStatus: [] as DailyStatus[],
  patrolEvents: seedPatrolEvents as PatrolEvent[],
  patrolSessions: seedPatrolSessions as PatrolSession[],
};

const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((l) => l());
}
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------- 파생 계산(오늘 재실/부재, 실제 출결 요약) ----------------
function attToday(): { rows: LastAttRow[]; actual: Record<string, ActualAttendance> } {
  const today = todayKey();
  const byStudent = new Map<string, AttEvent[]>();
  for (const e of state.attendanceEvents) {
    if (e.date !== today) continue;
    (byStudent.get(e.student_id) ?? byStudent.set(e.student_id, []).get(e.student_id)!).push(e);
  }
  const rows: LastAttRow[] = [];
  const actual: Record<string, ActualAttendance> = {};
  for (const [sid, list] of byStudent) {
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const last = sorted[sorted.length - 1];
    const firstIn = sorted.find((e) => e.kind === "in");
    rows.push({ student_id: sid, kind: last.kind, at: last.at, auto: last.auto, note: last.note });
    actual[sid] = {
      firstInMin: firstIn ? minuteOfKST(firstIn.at) : null,
      lastOutMin: last.kind === "out" ? minuteOfKST(last.at) : null,
    };
  }
  return { rows, actual };
}

function patrolToday(): LastPatrolRow[] {
  const today = todayKey();
  const byStudent = new Map<string, PatrolEvent[]>();
  for (const e of state.patrolEvents) {
    if (e.date !== today) continue;
    (byStudent.get(e.student_id) ?? byStudent.set(e.student_id, []).get(e.student_id)!).push(e);
  }
  const rows: LastPatrolRow[] = [];
  for (const [sid, list] of byStudent) {
    const last = [...list].sort((a, b) => b.at.localeCompare(a.at))[0];
    rows.push({ student_id: sid, state: last.state, at: last.at });
  }
  return rows;
}

export type Snapshot = {
  rooms: Room[]; seats: Seat[]; students: Student[];
  occupancy: Record<string, SeatOcc>; actual: Record<string, ActualAttendance>;
  scheduleMap: Record<string, ScheduleEntry>; periods: Period[];
  lastPatrolAt: string | null; initialRoomId: string | null;
};

let cache: Snapshot | null = null;
let cacheVersion = -1;
let version = 0;

export function getSnapshot(): Snapshot {
  if (cache && cacheVersion === version) return cache;
  const { rows: attRows, actual } = attToday();
  const patRows = patrolToday();
  const occupancy = buildOccupancy(attRows, patRows, seedScheduleMap);
  const lastPatrolAt = state.patrolSessions.reduce<string | null>(
    (max, s) => (max == null || s.started_at > max ? s.started_at : max),
    null,
  );
  cache = {
    rooms: state.rooms,
    seats: state.seats,
    students: state.students,
    occupancy,
    actual,
    scheduleMap: seedScheduleMap,
    periods: seedPeriods,
    lastPatrolAt,
    initialRoomId: state.rooms[0]?.id ?? null,
  };
  cacheVersion = version;
  return cache;
}

function touch() {
  version++;
  notify();
}

// ---------------- 좌석/방(actions.ts 대응) ----------------
export function addStudent(input: { name: string; level: string | null; grade: string | null; is_repeat: boolean; school: string | null; guardian_phone: string | null; student_phone: string | null; birthdate: string | null; gender: string | null }) {
  state.students = [...state.students, {
    id: newId("stu"), name: input.name, level: input.level, grade: input.grade, is_repeat: input.is_repeat,
    school: input.school, status: "enrolled", birthdate: input.birthdate, gender: input.gender,
    guardian_phone: input.guardian_phone, student_phone: input.student_phone, enrolled_at: todayKey(),
  }];
  touch();
}

export function createRoom(name: string, floor: number, count: number) {
  const id = newId("room");
  state.rooms = [...state.rooms, { id, name, floor, cols: 6, rows: Math.max(1, Math.ceil(count / 6)), pos_x: 40, pos_y: 40, door_side: null }];
  if (count > 0) {
    const newSeats: Seat[] = [];
    for (let i = 0; i < count; i++) {
      const col = i % 6, row = Math.floor(i / 6);
      newSeats.push({
        id: newId("seat"), room_id: id, grid_x: 40 + col * 100, grid_y: 40 + row * 80,
        number: i + 1, label: String(i + 1), seat_type: null, facing: "down", status: "empty", current_student_id: null,
      });
    }
    state.seats = [...state.seats, ...newSeats];
  }
  touch();
  return id;
}

export function saveSeatPositions(roomId: string, positions: { id: string; x: number; y: number }[], removed: string[]) {
  const isNew = (id: string) => id.startsWith("tmp");
  const posMap = new Map(positions.filter((p) => !isNew(p.id)).map((p) => [p.id, p]));
  state.seats = state.seats
    .filter((s) => !removed.includes(s.id))
    .map((s) => {
      const p = posMap.get(s.id);
      return p ? { ...s, grid_x: Math.max(0, Math.round(p.x)), grid_y: Math.max(0, Math.round(p.y)) } : s;
    });
  const news = positions.filter((p) => isNew(p.id));
  if (news.length) {
    const existingNums = state.seats.filter((s) => s.room_id === roomId).map((s) => s.number ?? 0);
    let n = (existingNums.length ? Math.max(...existingNums) : 0) + 1;
    const added: Seat[] = news.map((p) => ({
      id: newId("seat"), room_id: roomId, grid_x: Math.max(0, Math.round(p.x)), grid_y: Math.max(0, Math.round(p.y)),
      number: n, label: String(n++), seat_type: null, facing: "down", status: "empty", current_student_id: null,
    }));
    state.seats = [...state.seats, ...added];
  }
  touch();
}

export function updateSeat(seatId: string, patch: Partial<Pick<Seat, "number" | "label" | "seat_type" | "facing">>) {
  state.seats = state.seats.map((s) => (s.id === seatId ? { ...s, ...patch } : s));
  touch();
}

export function removeSeat(seatId: string) {
  state.seats = state.seats.filter((s) => s.id !== seatId);
  touch();
}

export function assignSeat(seatId: string, studentId: string) {
  state.seats = state.seats.map((s) => {
    if (s.current_student_id === studentId) return { ...s, current_student_id: null, status: "empty" };
    if (s.id === seatId) return { ...s, current_student_id: studentId, status: "occupied" };
    return s;
  });
  touch();
}

export function releaseSeat(seatId: string) {
  state.seats = state.seats.map((s) => (s.id === seatId ? { ...s, current_student_id: null, status: "empty" } : s));
  touch();
}

export function setSeatStatus(seatId: string, status: string) {
  state.seats = state.seats.map((s) => {
    if (s.id !== seatId) return s;
    if (status === "maintenance" || status === "empty") return { ...s, status, current_student_id: null };
    return { ...s, status };
  });
  touch();
}

// ---------------- 방(roomActions.ts 대응) ----------------
export function updateRoom(roomId: string, patch: Partial<Pick<Room, "name" | "floor" | "door_side">>) {
  state.rooms = state.rooms.map((r) => (r.id === roomId ? { ...r, ...patch } : r));
  touch();
}

export function deleteRoom(roomId: string) {
  state.seats = state.seats.filter((s) => s.room_id !== roomId);
  state.rooms = state.rooms.filter((r) => r.id !== roomId);
  touch();
}

export function saveRoomPositions(positions: { id: string; x: number; y: number }[]) {
  const posMap = new Map(positions.map((p) => [p.id, p]));
  state.rooms = state.rooms.map((r) => {
    const p = posMap.get(r.id);
    return p ? { ...r, pos_x: Math.max(0, Math.round(p.x)), pos_y: Math.max(0, Math.round(p.y)) } : r;
  });
  touch();
}

// ---------------- 출결(attendanceActions.ts 대응) ----------------
function recordAtt(studentId: string, kind: "in" | "out", auto: boolean, note: string | null) {
  state.attendanceEvents = [...state.attendanceEvents, {
    id: newId("att"), student_id: studentId, kind, auto, date: todayKey(), at: new Date().toISOString(), note, created_by: "demo",
  }];
  touch();
}
export function checkIn(studentId: string) {
  recordAtt(studentId, "in", false, null);
}
export function checkOut(studentId: string, note: string | null) {
  recordAtt(studentId, "out", false, note);
}
export function undoLastEvent(studentId: string, date: string) {
  const list = state.attendanceEvents.filter((e) => e.student_id === studentId && e.date === date).sort((a, b) => a.at.localeCompare(b.at));
  const last = list[list.length - 1];
  if (!last) return;
  state.attendanceEvents = state.attendanceEvents.filter((e) => e.id !== last.id);
  touch();
}
export function getAttendanceEvents(studentId: string, date: string) {
  return state.attendanceEvents
    .filter((e) => e.student_id === studentId && e.date === date)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((e) => ({ kind: e.kind, auto: e.auto, at: e.at }));
}
export function getDailyStatus(studentId: string, date: string) {
  const row = state.dailyStatus.find((d) => d.student_id === studentId && d.date === date);
  return row ? { status: row.status, reason: row.reason } : null;
}
export function setAbsent(studentId: string, reason: string | null, date: string) {
  const exists = state.dailyStatus.some((d) => d.student_id === studentId && d.date === date);
  state.dailyStatus = exists
    ? state.dailyStatus.map((d) => (d.student_id === studentId && d.date === date ? { ...d, status: "absent", reason } : d))
    : [...state.dailyStatus, { student_id: studentId, date, status: "absent", reason }];
  touch();
}
export function clearDailyStatus(studentId: string, date: string) {
  state.dailyStatus = state.dailyStatus.filter((d) => !(d.student_id === studentId && d.date === date));
  touch();
}

// ---------------- 순찰(patrolActions.ts 대응) ----------------
function ensureCheckedInFromPatrol(studentId: string) {
  const today = todayKey();
  const list = state.attendanceEvents.filter((e) => e.student_id === studentId && e.date === today).sort((a, b) => a.at.localeCompare(b.at));
  const last = list[list.length - 1];
  if (last?.kind === "in") return;
  state.attendanceEvents = [...state.attendanceEvents, {
    id: newId("att"), student_id: studentId, kind: "in", auto: true, date: today, at: new Date().toISOString(), note: null, created_by: "demo",
  }];
}
export function recordPatrol(studentId: string, stateKey: string, sessionId: string | null) {
  const preset = PATROL_BY_KEY[stateKey];
  if (!preset) return;
  const seat = state.seats.find((s) => s.current_student_id === studentId) ?? null;
  state.patrolEvents = state.patrolEvents.filter((e) => !(e.student_id === studentId && e.session_id === sessionId));
  state.patrolEvents = [...state.patrolEvents, {
    id: newId("pe"), student_id: studentId, state: stateKey, points: preset.points, session_id: sessionId,
    seat_id: seat?.id ?? null, date: todayKey(), at: new Date().toISOString(), created_by: "demo",
  }];
  if (stateKey === "seated") ensureCheckedInFromPatrol(studentId);
  touch();
}
export function clearPatrolMark(studentId: string, sessionId: string | null) {
  state.patrolEvents = state.patrolEvents.filter((e) => !(e.student_id === studentId && e.session_id === sessionId));
  touch();
}
export function startPatrol(sessionId: string) {
  if (state.patrolSessions.some((s) => s.id === sessionId)) return;
  state.patrolSessions = [...state.patrolSessions, { id: sessionId, started_at: new Date().toISOString(), ended_at: null, created_by: "demo", started_by_name: "나(데모 관리자)" }];
  touch();
}
export function endPatrol(sessionId: string) {
  const sess = state.patrolSessions.find((s) => s.id === sessionId);
  if (!sess || sess.ended_at) return;
  state.patrolSessions = state.patrolSessions.map((s) => (s.id === sessionId ? { ...s, ended_at: new Date().toISOString() } : s));
  const marks = state.patrolEvents.filter((e) => e.session_id === sessionId);
  const today = todayKey();
  for (const m of marks) {
    const asIn = PATROL_BY_KEY[m.state]?.asIn ?? true;
    const kind: "in" | "out" = asIn ? "in" : "out";
    const list = state.attendanceEvents.filter((e) => e.student_id === m.student_id && e.date === today).sort((a, b) => a.at.localeCompare(b.at));
    const last = list[list.length - 1];
    if (last?.kind === kind) continue;
    state.attendanceEvents = [...state.attendanceEvents, {
      id: newId("att"), student_id: m.student_id, kind, auto: true, date: today, at: m.at, note: "순찰 자동 처리", created_by: "demo",
    }];
  }
  touch();
}
export function getPatrolSessionDetail(sessionId: string) {
  return state.patrolEvents
    .filter((e) => e.session_id === sessionId)
    .map((e) => ({
      student_id: e.student_id,
      seat_id: e.seat_id,
      name: state.students.find((s) => s.id === e.student_id)?.name ?? "",
      state: e.state,
      points: e.points,
      at: e.at,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}
export function getPatrolEvents(studentId: string, date: string) {
  return state.patrolEvents
    .filter((e) => e.student_id === studentId && e.date === date)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((e) => ({ state: e.state, points: e.points, at: e.at }));
}
// 데모는 미종료 세션을 시드하지 않는다 — "이어하기" 흐름은 항상 새로 시작으로 처리(주변 기능, 조용한 no-op).
export function getOpenPatrolSession() {
  return null;
}

// ---------------- 순찰 부가 기능(FloorEditor 핵심 흐름 밖 — 그래도 같은 시그니처로 제공) ----------------
export function recordPatrolBulk(items: { studentId: string; state: string }[], sessionId: string | null) {
  for (const it of items) {
    if (!PATROL_BY_KEY[it.state]) continue;
    recordPatrol(it.studentId, it.state, sessionId);
  }
}
export function removePatrolEvent(id: string) {
  state.patrolEvents = state.patrolEvents.filter((e) => e.id !== id);
  touch();
}
export function undoLastPatrol(studentId: string) {
  const today = todayKey();
  const list = state.patrolEvents.filter((e) => e.student_id === studentId && e.date === today).sort((a, b) => a.at.localeCompare(b.at));
  const last = list[list.length - 1];
  if (!last) return;
  state.patrolEvents = state.patrolEvents.filter((e) => e.id !== last.id);
  touch();
}
export function deletePatrolSession(sessionId: string) {
  state.patrolEvents = state.patrolEvents.filter((e) => e.session_id !== sessionId);
  state.patrolSessions = state.patrolSessions.filter((s) => s.id !== sessionId);
  touch();
}
export function getPatrolSessions(date?: string) {
  const d = date ?? todayKey();
  return state.patrolSessions
    .filter((s) => s.started_at.slice(0, 10) === d || todayKey() === d)
    .map((s) => {
      const marks = state.patrolEvents.filter((e) => e.session_id === s.id);
      return {
        id: s.id, started_at: s.started_at, ended_at: s.ended_at,
        started_kst: s.started_at, ended_kst: s.ended_at,
        marked: marks.length, penalty: marks.reduce((n, m) => n + m.points, 0),
      };
    })
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}
export function getPatrolDates(): string[] {
  return [...new Set(state.patrolSessions.map((s) => todayKey()))];
}
export function setPatrolMark(sessionId: string, studentId: string, stateKey: string, seatId: string | null) {
  const preset = PATROL_BY_KEY[stateKey];
  if (!preset) return;
  state.patrolEvents = state.patrolEvents.filter((e) => !(e.student_id === studentId && e.session_id === sessionId));
  const sess = state.patrolSessions.find((s) => s.id === sessionId);
  state.patrolEvents = [...state.patrolEvents, {
    id: newId("pe"), student_id: studentId, state: stateKey, points: preset.points, session_id: sessionId,
    seat_id: seatId, date: sess?.started_at.slice(0, 10) ?? todayKey(), at: new Date().toISOString(), created_by: "demo",
  }];
  if (stateKey === "seated") ensureCheckedInFromPatrol(studentId);
  touch();
}
