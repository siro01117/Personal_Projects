// 데모용 클라이언트 모크 — 원본(roomActions.ts)과 같은 export 시그니처.
import * as store from "../../../lib/store";

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

export async function updateRoom(formData: FormData) {
  const roomId = s(formData.get("roomId"));
  if (!roomId) return;
  const patch: Record<string, unknown> = {};
  const name = s(formData.get("name"));
  if (name) patch.name = name;
  const floorRaw = s(formData.get("floor"));
  if (floorRaw) {
    const f = parseInt(floorRaw, 10);
    if (Number.isFinite(f)) patch.floor = f;
  }
  if (formData.has("door_side")) patch.door_side = s(formData.get("door_side"));
  if (Object.keys(patch).length === 0) return;
  store.updateRoom(roomId, patch);
}

export async function deleteRoom(formData: FormData) {
  const roomId = s(formData.get("roomId"));
  if (!roomId) return;
  store.deleteRoom(roomId);
}

export async function saveRoomPositions(formData: FormData) {
  let list: { id: string; x: number; y: number }[] = [];
  try { list = JSON.parse(String(formData.get("positions") ?? "[]")); } catch { return; }
  if (!Array.isArray(list)) return;
  store.saveRoomPositions(list);
}
