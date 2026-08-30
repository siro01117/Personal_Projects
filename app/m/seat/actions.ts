
import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

// 방 안 다음 번호 = (그 방 최대 번호)+1
async function nextNumber(roomId: string): Promise<number> {
  const r = await db.query<{ max: number | null }>(
    `select max(number) as max from seat where room_id = $1`,
    [roomId],
  );
  return (r.rows[0]?.max ?? 0) + 1;
}

// ---------------- 학생 (좌석 화면에서 바로 추가) ----------------
export async function addStudent(formData: FormData) {
  const me = await guard("student.edit");
  const name = s(formData.get("name"));
  if (!name) throw new Error("이름을 입력하세요");
  const level = s(formData.get("level"));
  await db.query(
    `insert into student
       (branch_id,name,level,grade,is_repeat,school,guardian_phone,student_phone,birthdate,gender,status,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'enrolled',$11)`,
    [
      me.activeBranchId,
      name,
      level,
      level === "adult" ? null : s(formData.get("grade")),
      level === "adult" ? formData.get("is_repeat") != null : false,
      s(formData.get("school")),
      s(formData.get("guardian_phone")),
      s(formData.get("student_phone")),
      s(formData.get("birthdate")),
      s(formData.get("gender")),
      me.id,
    ],
  );
  revalidatePath("/m/seat");
  revalidatePath("/m/student");
}

// (setStudentStatus 는 student/actions.ts 의 것을 쓴다 — 이쪽 중복본은 좌석 정리 로직이 없어 제거)

// ---------------- 방(교실) ----------------
// 좌석 격자(FloorEditor 와 동일) — ORIGIN·GAP 전부 STEP(20)의 배수라 화면 격자에 딱 맞음
const GAP_X = 100, GAP_Y = 80, ORIGIN_X = 40, ORIGIN_Y = 40, PER_ROW = 6;

export async function createRoom(formData: FormData) {
  const me = await guard("seat.manage");
  const name = s(formData.get("name"));
  if (!name) throw new Error("방 이름을 입력하세요");
  const num = (v: FormDataEntryValue | null, d: number) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const floor = num(formData.get("floor"), 4);
  const count = Math.min(num(formData.get("count"), 0), 200);

  const r = await db.query<{ id: string }>(
    `insert into room(branch_id,name,floor,cols,rows) values ($1,$2,$3,8,6) returning id`,
    [me.activeBranchId, name, floor],
  );
  const roomId = r.rows[0].id;

  if (count > 0) {
    for (let i = 0; i < count; i++) {
      const col = i % PER_ROW, row = Math.floor(i / PER_ROW);
      await db.query(
        `insert into seat(branch_id,room_id,grid_x,grid_y,number,label,status,facing)
         values ($1,$2,$3,$4,$5,$6,'empty','down')`,
        [me.activeBranchId, roomId, ORIGIN_X + col * GAP_X, ORIGIN_Y + row * GAP_Y, i + 1, String(i + 1)],
      );
    }
  }
  revalidatePath("/m/seat");
  // 원본은 next/navigation의 redirect()(서버 액션 전용)를 썼다. 데모는 서버 액션이 아니라
  // 일반 함수라 그 메커니즘이 없으므로 브라우저 네비게이션으로 대체(동작은 동일: 새 방으로 이동).
  if (typeof window !== "undefined") window.location.href = "/m/seat?room=" + roomId;
}

// 도면 배치 저장 — 드래그로 옮긴 좌석 위치 일괄 반영(+새 좌석 tmp id 는 생성)
export async function saveSeatPositions(formData: FormData) {
  const me = await guard("seat.manage");
  const roomId = s(formData.get("roomId"));
  if (!roomId) return;
  let list: { id: string; x: number; y: number }[] = [];
  try {
    list = JSON.parse(String(formData.get("positions") ?? "[]"));
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  const branch = me.activeBranchId;
  const rx = (n: number) => Math.max(0, Math.round(Number(n) || 0));
  const isNew = (id: string) => typeof id === "string" && id.startsWith("tmp");

  for (const p of list.filter((p) => p && !isNew(p.id))) {
    await db.query(
      `update seat set grid_x=$1, grid_y=$2 where id=$3 and branch_id=$4 and room_id=$5`,
      [rx(p.x), rx(p.y), p.id, branch, roomId],
    );
  }
  const news = list.filter((p) => p && isNew(p.id));
  if (news.length) {
    let n = await nextNumber(roomId);
    for (const p of news) {
      const number = n++;
      await db.query(
        `insert into seat(branch_id,room_id,grid_x,grid_y,number,label,status,facing)
         values ($1,$2,$3,$4,$5,$6,'empty','down')`,
        [branch, roomId, rx(p.x), rx(p.y), number, String(number)],
      );
    }
  }
  // 편집 중 삭제한 좌석(실제 id만) 제거
  let removed: string[] = [];
  try {
    removed = JSON.parse(String(formData.get("removed") ?? "[]"));
  } catch {
    removed = [];
  }
  for (const id of Array.isArray(removed) ? removed : []) {
    if (typeof id === "string" && !isNew(id)) {
      await db.query(`delete from seat where id=$1 and branch_id=$2 and room_id=$3`, [id, branch, roomId]);
    }
  }
  revalidatePath("/m/seat");
}

// 격자 한 칸에 좌석 생성 (생성 순 자동번호)
export async function placeSeat(formData: FormData) {
  const me = await guard("seat.manage");
  const roomId = s(formData.get("roomId"));
  const gx = parseInt(String(formData.get("gridX") ?? ""), 10);
  const gy = parseInt(String(formData.get("gridY") ?? ""), 10);
  if (!roomId || !Number.isFinite(gx) || !Number.isFinite(gy)) return;
  const number = await nextNumber(roomId);
  await db.query(
    `insert into seat(branch_id,room_id,grid_x,grid_y,number,label,status)
     values ($1,$2,$3,$4,$5,$6,'empty')`,
    [me.activeBranchId, roomId, gx, gy, number, String(number)],
  );
  revalidatePath("/m/seat");
}

// 한 방에 N개 대량 생성 — 빈 칸을 행 우선으로 채움, startNumber부터
export async function bulkCreateSeats(formData: FormData) {
  const me = await guard("seat.manage");
  const roomId = s(formData.get("roomId"));
  const count = Math.min(Math.max(parseInt(String(formData.get("count") ?? ""), 10) || 0, 1), 200);
  if (!roomId) return;
  const room = await db.query<{ cols: number; rows: number }>(`select cols, rows from room where id=$1`, [roomId]);
  if (!room.rows[0]) throw new Error("방 없음");
  const existing = await db.query<{ grid_x: number; grid_y: number }>(
    `select grid_x, grid_y from seat where room_id=$1`,
    [roomId],
  );
  const taken = new Set(existing.rows.map((r) => `${r.grid_x},${r.grid_y}`));
  const startRaw = parseInt(String(formData.get("startNumber") ?? ""), 10);
  let number = Number.isFinite(startRaw) ? startRaw : await nextNumber(roomId);

  let made = 0;
  for (let y = 0; y < room.rows[0].rows && made < count; y++) {
    for (let x = 0; x < room.rows[0].cols && made < count; x++) {
      const px = ORIGIN_X + x * GAP_X, py = ORIGIN_Y + y * GAP_Y; // 셀 → 픽셀(격자)
      if (taken.has(`${px},${py}`)) continue;
      await db.query(
        `insert into seat(branch_id,room_id,grid_x,grid_y,number,label,status)
         values ($1,$2,$3,$4,$5,$6,'empty')`,
        [me.activeBranchId, roomId, px, py, number, String(number)],
      );
      number++;
      made++;
    }
  }
  revalidatePath("/m/seat");
}

export async function updateSeat(formData: FormData) {
  const me = await guard("seat.manage");
  const seatId = s(formData.get("seatId"));
  if (!seatId) return;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const numRaw = s(formData.get("number"));
  if (numRaw != null) {
    const n = parseInt(numRaw, 10);
    if (Number.isFinite(n)) {
      sets.push(`number=$${vals.length + 1}`); vals.push(n);
      sets.push(`label=$${vals.length + 1}`); vals.push(String(n));
    }
  }
  if (formData.has("seat_type")) { sets.push(`seat_type=$${vals.length + 1}`); vals.push(s(formData.get("seat_type"))); }
  if (formData.has("facing")) { sets.push(`facing=$${vals.length + 1}`); vals.push(s(formData.get("facing"))); }
  if (sets.length === 0) return;
  vals.push(seatId, me.activeBranchId);
  await db.query(
    `update seat set ${sets.join(", ")} where id=$${vals.length - 1} and branch_id=$${vals.length}`,
    vals,
  );
  revalidatePath("/m/seat");
}

export async function removeSeat(formData: FormData) {
  const me = await guard("seat.manage");
  const seatId = s(formData.get("seatId"));
  if (!seatId) return;
  await db.query(`delete from seat where id=$1 and branch_id=$2`, [seatId, me.activeBranchId]);
  revalidatePath("/m/seat");
}

export async function assignSeat(formData: FormData) {
  const me = await guard("seat.manage");
  const seatId = s(formData.get("seatId"));
  const studentId = s(formData.get("studentId"));
  if (!seatId || !studentId) throw new Error("좌석과 학생을 선택하세요");
  const branch = me.activeBranchId;
  // 한 학생 = 한 좌석: 이 학생이 앉아있던 다른 좌석 비우기
  await db.query(
    `update seat set current_student_id=null, status='empty', assigned_at=null
      where branch_id=$1 and current_student_id=$2`,
    [branch, studentId],
  );
  await db.query(
    `update seat set current_student_id=$1, status='occupied', assigned_at=now()
      where id=$2 and branch_id=$3`,
    [studentId, seatId, branch],
  );
  revalidatePath("/m/seat");
}

export async function releaseSeat(formData: FormData) {
  const me = await guard("seat.manage");
  const seatId = s(formData.get("seatId"));
  if (!seatId) return;
  await db.query(
    `update seat set current_student_id=null, status='empty', assigned_at=null
      where id=$1 and branch_id=$2`,
    [seatId, me.activeBranchId],
  );
  revalidatePath("/m/seat");
}

export async function setSeatStatus(formData: FormData) {
  const me = await guard("seat.manage");
  const seatId = s(formData.get("seatId"));
  const status = s(formData.get("status"));
  if (!seatId || !status) return;
  if (status === "maintenance" || status === "empty") {
    await db.query(
      `update seat set status=$1, current_student_id=null, assigned_at=null where id=$2 and branch_id=$3`,
      [status, seatId, me.activeBranchId],
    );
  } else {
    await db.query(`update seat set status=$1 where id=$2 and branch_id=$3`, [status, seatId, me.activeBranchId]);
  }
  revalidatePath("/m/seat");
}
