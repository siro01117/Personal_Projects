// 데모용 클라이언트 모크 — 원본(attendanceActions.ts)과 같은 export 시그니처.
import * as store from "../../../lib/store";
import { todayKey as todayStr } from "../../../lib/date";

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

export async function checkIn(formData: FormData) {
  const id = s(formData.get("studentId"));
  if (!id) return;
  store.checkIn(id);
}

export async function checkOut(formData: FormData) {
  const id = s(formData.get("studentId"));
  if (!id) return;
  const note = s(formData.get("note"));
  store.checkOut(id, note);
}

export async function undoLastEvent(formData: FormData) {
  const id = s(formData.get("studentId"));
  const date = s(formData.get("date")) ?? todayStr();
  if (!id) return;
  store.undoLastEvent(id, date);
}

export async function getAttendanceEvents(studentId: string, date: string) {
  return store.getAttendanceEvents(studentId, date);
}

export async function getDailyStatus(studentId: string, date: string) {
  return store.getDailyStatus(studentId, date);
}

export async function setAbsent(formData: FormData) {
  const id = s(formData.get("studentId"));
  const reason = s(formData.get("reason"));
  const date = s(formData.get("date")) ?? todayStr();
  if (!id) return;
  store.setAbsent(id, reason, date);
}

export async function clearDailyStatus(formData: FormData) {
  const id = s(formData.get("studentId"));
  const date = s(formData.get("date")) ?? todayStr();
  if (!id) return;
  store.clearDailyStatus(id, date);
}
