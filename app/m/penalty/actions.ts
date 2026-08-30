import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";
import { PENALTY_BY_KEY, weekStartKey } from "@/lib/penalty";
import { PATROL_BY_KEY } from "@/lib/patrol";
import { todayKey as todayStr } from "@/lib/date"; // KST 기준(서버 UTC 어긋남 방지)

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

// 수동 벌점 부여 (프리셋 사유). points 는 프리셋에서 스냅샷 → 나중 프리셋 바꿔도 과거 불변.
// date: 선택 요일(이번 주 범위·미래 아님으로 클램프). 없으면 오늘.
export async function givePenalty(formData: FormData) {
  const me = await guard("penalty.manage");
  const id = s(formData.get("studentId"));
  const reason = s(formData.get("reason"));
  const note = s(formData.get("note"));
  if (!id || !reason) return;
  const preset = PENALTY_BY_KEY[reason];
  if (!preset) return;
  const today = todayStr();
  const ws = weekStartKey(new Date());
  const wanted = s(formData.get("date"));
  const date = wanted && wanted >= ws && wanted <= today ? wanted : today; // 이번 주·오늘까지만
  await db.query(
    `insert into penalty_event(branch_id, student_id, reason, points, note, date, created_by)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [me.activeBranchId, id, reason, preset.points, note, date, me.id],
  );
  revalidatePath("/m/penalty");
}

// 수동 벌점 1건 삭제(정정)
export async function removePenalty(formData: FormData) {
  const me = await guard("penalty.manage");
  const id = s(formData.get("id"));
  if (!id) return;
  await db.query(`delete from penalty_event where id=$1 and branch_id=$2`, [id, me.activeBranchId]);
  revalidatePath("/m/penalty");
}

// 한 학생의 이번 주 벌점 내역 (순찰 + 수동 합쳐 시간순). 순찰 것은 삭제 불가(순찰 기록에서 정정).
export async function getStudentPenaltyWeek(studentId: string) {
  const me = await guard("penalty.view");
  const ws = weekStartKey(new Date());
  const [pat, man] = await Promise.all([
    db.query<{ id: string; state: string; points: number; at: string; date: string }>(
      `select id, state, points, at::text as at, date::text as date from patrol_event
        where student_id=$1 and branch_id=$2 and date >= $3 and points <> 0 order by at`,
      [studentId, me.activeBranchId, ws],
    ),
    db.query<{ id: string; reason: string; points: number; note: string | null; at: string; date: string }>(
      `select id, reason, points, note, at::text as at, date::text as date from penalty_event
        where student_id=$1 and branch_id=$2 and date >= $3 order by at`,
      [studentId, me.activeBranchId, ws],
    ),
  ]);
  const rows = [
    ...pat.rows.map((r) => ({ source: "patrol" as const, id: r.id, label: `순찰 · ${PATROL_BY_KEY[r.state]?.label ?? r.state}`, points: r.points, note: null as string | null, at: r.at, date: r.date })),
    ...man.rows.map((r) => ({ source: "manual" as const, id: r.id, label: PENALTY_BY_KEY[r.reason]?.label ?? r.reason, points: r.points, note: r.note, at: r.at, date: r.date })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));
  return rows;
}
