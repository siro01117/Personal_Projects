
import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

// 방 이름·층 수정
export async function updateRoom(formData: FormData) {
  const me = await guard("seat.manage");
  const roomId = s(formData.get("roomId"));
  if (!roomId) return;
  const name = s(formData.get("name"));
  const floorRaw = s(formData.get("floor"));
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (name) { sets.push(`name=$${vals.length + 1}`); vals.push(name); }
  if (floorRaw) {
    const f = parseInt(floorRaw, 10);
    if (Number.isFinite(f)) { sets.push(`floor=$${vals.length + 1}`); vals.push(f); }
  }
  if (formData.has("door_side")) { sets.push(`door_side=$${vals.length + 1}`); vals.push(s(formData.get("door_side"))); }
  if (sets.length === 0) return;
  vals.push(roomId, me.activeBranchId);
  await db.query(
    `update room set ${sets.join(", ")} where id=$${vals.length - 1} and branch_id=$${vals.length}`,
    vals,
  );
  revalidatePath("/m/seat");
}

// 방 삭제 (그 방 좌석도 함께 삭제)
export async function deleteRoom(formData: FormData) {
  const me = await guard("seat.manage");
  const roomId = s(formData.get("roomId"));
  if (!roomId) return;
  await db.query(`delete from seat where room_id=$1 and branch_id=$2`, [roomId, me.activeBranchId]);
  await db.query(`delete from room where id=$1 and branch_id=$2`, [roomId, me.activeBranchId]);
  revalidatePath("/m/seat");
}

// 전체 배치 저장 — 방 블록을 층 도면 위 어디에 놓나 (pos_x, pos_y 일괄)
export async function saveRoomPositions(formData: FormData) {
  const me = await guard("seat.manage");
  let list: { id: string; x: number; y: number }[] = [];
  try {
    list = JSON.parse(String(formData.get("positions") ?? "[]"));
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  const rx = (n: number) => Math.max(0, Math.round(Number(n) || 0));
  for (const p of list) {
    if (!p || typeof p.id !== "string") continue;
    await db.query(`update room set pos_x=$1, pos_y=$2 where id=$3 and branch_id=$4`, [
      rx(p.x),
      rx(p.y),
      p.id,
      me.activeBranchId,
    ]);
  }
  revalidatePath("/m/seat");
}
