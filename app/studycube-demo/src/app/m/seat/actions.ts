// 데모용 클라이언트 모크 — 원본(actions.ts)의 서버 액션과 같은 export 이름·시그니처(FormData → Promise)를
// 유지하되 'use server' 없이 브라우저에서 그대로 실행되고, DB 대신 src/lib/store.ts(인메모리)를 조작한다.
import * as store from "../../../lib/store";

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

export async function addStudent(formData: FormData) {
  const name = s(formData.get("name"));
  if (!name) throw new Error("이름을 입력하세요");
  const level = s(formData.get("level"));
  store.addStudent({
    name,
    level,
    grade: level === "adult" ? null : s(formData.get("grade")),
    is_repeat: level === "adult" ? formData.get("is_repeat") != null : false,
    school: s(formData.get("school")),
    guardian_phone: s(formData.get("guardian_phone")),
    student_phone: s(formData.get("student_phone")),
    birthdate: s(formData.get("birthdate")),
    gender: s(formData.get("gender")),
  });
}

export async function createRoom(formData: FormData) {
  const name = s(formData.get("name"));
  if (!name) throw new Error("방 이름을 입력하세요");
  const num = (v: FormDataEntryValue | null, d: number) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const floor = num(formData.get("floor"), 4);
  const count = Math.min(num(formData.get("count"), 0), 200);
  store.createRoom(name, floor, count);
}

export async function saveSeatPositions(formData: FormData) {
  const roomId = s(formData.get("roomId"));
  if (!roomId) return;
  let list: { id: string; x: number; y: number }[] = [];
  try { list = JSON.parse(String(formData.get("positions") ?? "[]")); } catch { return; }
  if (!Array.isArray(list)) return;
  let removed: string[] = [];
  try { removed = JSON.parse(String(formData.get("removed") ?? "[]")); } catch { removed = []; }
  store.saveSeatPositions(roomId, list, Array.isArray(removed) ? removed : []);
}

export async function placeSeat(formData: FormData) {
  const roomId = s(formData.get("roomId"));
  const gx = parseInt(String(formData.get("gridX") ?? ""), 10);
  const gy = parseInt(String(formData.get("gridY") ?? ""), 10);
  if (!roomId || !Number.isFinite(gx) || !Number.isFinite(gy)) return;
  store.saveSeatPositions(roomId, [{ id: "tmp" + Date.now(), x: gx, y: gy }], []);
}

export async function bulkCreateSeats(formData: FormData) {
  const roomId = s(formData.get("roomId"));
  const count = Math.min(Math.max(parseInt(String(formData.get("count") ?? ""), 10) || 0, 1), 200);
  if (!roomId) return;
  const positions = Array.from({ length: count }, (_, i) => ({ id: `tmp${Date.now()}_${i}`, x: 0, y: 0 }));
  store.saveSeatPositions(roomId, positions, []);
}

export async function updateSeat(formData: FormData) {
  const seatId = s(formData.get("seatId"));
  if (!seatId) return;
  const patch: Record<string, unknown> = {};
  const numRaw = s(formData.get("number"));
  if (numRaw != null) {
    const n = parseInt(numRaw, 10);
    if (Number.isFinite(n)) { patch.number = n; patch.label = String(n); }
  }
  if (formData.has("seat_type")) patch.seat_type = s(formData.get("seat_type"));
  if (formData.has("facing")) patch.facing = s(formData.get("facing"));
  if (Object.keys(patch).length === 0) return;
  store.updateSeat(seatId, patch);
}

export async function removeSeat(formData: FormData) {
  const seatId = s(formData.get("seatId"));
  if (!seatId) return;
  store.removeSeat(seatId);
}

export async function assignSeat(formData: FormData) {
  const seatId = s(formData.get("seatId"));
  const studentId = s(formData.get("studentId"));
  if (!seatId || !studentId) throw new Error("좌석과 학생을 선택하세요");
  store.assignSeat(seatId, studentId);
}

export async function releaseSeat(formData: FormData) {
  const seatId = s(formData.get("seatId"));
  if (!seatId) return;
  store.releaseSeat(seatId);
}

export async function setSeatStatus(formData: FormData) {
  const seatId = s(formData.get("seatId"));
  const status = s(formData.get("status"));
  if (!seatId || !status) return;
  store.setSeatStatus(seatId, status);
}
