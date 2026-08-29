// 데모용 클라이언트 모크 — 원본(patrolActions.ts)과 같은 export 이름·시그니처.
import * as store from "../../../lib/store";

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

export async function recordPatrol(formData: FormData) {
  const id = s(formData.get("studentId"));
  const state = s(formData.get("state"));
  const sessionId = s(formData.get("sessionId"));
  if (!id || !state) return;
  store.recordPatrol(id, state, sessionId);
}

export async function recordPatrolBulk(formData: FormData) {
  const sessionId = s(formData.get("sessionId"));
  let items: { studentId: string; state: string }[];
  try { items = JSON.parse(s(formData.get("items")) ?? "[]"); } catch { return; }
  if (!Array.isArray(items) || items.length === 0) return;
  store.recordPatrolBulk(items, sessionId);
}

export async function removePatrolEvent(formData: FormData) {
  const id = s(formData.get("id"));
  if (!id) return;
  store.removePatrolEvent(id);
}

export async function undoLastPatrol(formData: FormData) {
  const id = s(formData.get("studentId"));
  if (!id) return;
  store.undoLastPatrol(id);
}

export async function startPatrol(formData: FormData) {
  const id = s(formData.get("sessionId"));
  if (!id) return;
  store.startPatrol(id);
}

export async function endPatrol(formData: FormData) {
  const id = s(formData.get("sessionId"));
  if (!id) return;
  store.endPatrol(id);
}

export async function deletePatrolSession(formData: FormData) {
  const id = s(formData.get("sessionId"));
  if (!id) return;
  store.deletePatrolSession(id);
}

export async function getPatrolSessions(date?: string) {
  return store.getPatrolSessions(date);
}

export async function getPatrolDates(): Promise<string[]> {
  return store.getPatrolDates();
}

export async function getPatrolSessionDetail(sessionId: string) {
  return store.getPatrolSessionDetail(sessionId);
}

export async function setPatrolMark(formData: FormData) {
  const sessionId = s(formData.get("sessionId"));
  const id = s(formData.get("studentId"));
  const state = s(formData.get("state"));
  const seatId = s(formData.get("seatId"));
  if (!sessionId || !id || !state) return;
  store.setPatrolMark(sessionId, id, state, seatId);
}

export async function clearPatrolMark(formData: FormData) {
  const sessionId = s(formData.get("sessionId"));
  const id = s(formData.get("studentId"));
  if (!sessionId || !id) return;
  store.clearPatrolMark(id, sessionId);
}

// 미종료 순찰 세션 — 데모는 항상 없음(주변 기능, 조용한 no-op). "이어하기" 대신 매번 새로 시작한다.
export type OpenPatrolSession = {
  sessionId: string;
  startedByName: string;
  markedCount: number;
  dayLabel: string;
  timeLabel: string;
  lastLabel: string | null;
};

export async function getOpenPatrolSession(): Promise<OpenPatrolSession | null> {
  return store.getOpenPatrolSession();
}

export async function getPatrolEvents(studentId: string, date: string) {
  return store.getPatrolEvents(studentId, date);
}
