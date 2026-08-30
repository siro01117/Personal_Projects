
import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";
import { todayKey as todayStr } from "@/lib/date"; // KST 기준(서버 UTC 어긋남 방지)

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

async function record(branchId: string | null, studentId: string, kind: "in" | "out", auto: boolean, by: string, note: string | null = null) {
  await db.query(
    `insert into attendance_event(branch_id, student_id, kind, auto, date, created_by, note)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [branchId, studentId, kind, auto, todayStr(), by, note],
  );
}

// 입실 기록 (불변)
// /m/seat(데스크톱)·/seat(모바일) 두 화면 모두 이 출결이 재실/부재 판정에 들어가므로 둘 다 갱신한다
// (예전엔 /m/seat 만 revalidate 해서 /seat 화면 수동 버튼이 로컬 낙관적 state 없인 반영되지 않았다).
export async function checkIn(formData: FormData) {
  const me = await guard("attendance.edit");
  const id = s(formData.get("studentId"));
  if (!id) return;
  await record(me.activeBranchId, id, "in", false, me.id);
  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 퇴실 기록 (불변)
export async function checkOut(formData: FormData) {
  const me = await guard("attendance.edit");
  const id = s(formData.get("studentId"));
  if (!id) return;
  const note = s(formData.get("note"));
  await record(me.activeBranchId, id, "out", false, me.id, note);
  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 마지막 기록 취소(오입력 정정용)
export async function undoLastEvent(formData: FormData) {
  const me = await guard("attendance.edit");
  const id = s(formData.get("studentId"));
  const date = s(formData.get("date")) ?? todayStr();
  if (!id) return;
  await db.query(
    `delete from attendance_event
      where id = (select id from attendance_event
                   where student_id=$1 and branch_id=$2 and date=$3
                   order by at desc limit 1)`,
    [id, me.activeBranchId, date],
  );
  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 특정 학생·날짜의 입·퇴실 기록 조회 (팝업용)
export async function getAttendanceEvents(studentId: string, date: string) {
  const me = await guard("attendance.view");
  const r = await db.query<{ kind: string; auto: boolean; at: string }>(
    `select kind, auto, at::text as at
       from attendance_event
      where student_id=$1 and branch_id=$2 and date=$3
      order by at`,
    [studentId, me.activeBranchId, date],
  );
  return r.rows;
}

// ---------------- 일일 결석 상태 (attendance 테이블: 학생×하루 1행) ----------------
// 입·퇴실 이벤트(attendance_event)와 별개. 결석은 "그날 상태 + 사유"로 남긴다.

// 특정 학생·날짜의 일일 상태 조회 (없으면 정상 등원으로 간주 → null)
export async function getDailyStatus(studentId: string, date: string) {
  const me = await guard("attendance.view");
  const r = await db.query<{ status: string; reason: string | null }>(
    `select status, reason from attendance where student_id=$1 and branch_id=$2 and date=$3`,
    [studentId, me.activeBranchId, date],
  );
  return r.rows[0] ?? null;
}

// 결석 처리(사유 포함). 같은 날 다시 부르면 사유만 갱신(upsert).
export async function setAbsent(formData: FormData) {
  const me = await guard("attendance.edit");
  const id = s(formData.get("studentId"));
  const reason = s(formData.get("reason"));
  const date = s(formData.get("date")) ?? todayStr();
  if (!id) return;
  await db.query(
    `insert into attendance(branch_id, student_id, date, status, reason, created_by)
     values ($1,$2,$3,'absent',$4,$5)
     on conflict (student_id, date)
     do update set status='absent', reason=excluded.reason, updated_at=now()`,
    [me.activeBranchId, id, date, reason, me.id],
  );
  revalidatePath("/m/seat");
  revalidatePath("/m/student");
}

// 결석 취소 = 그 날 일일 상태 행 제거(정상 등원으로 되돌림)
export async function clearDailyStatus(formData: FormData) {
  const me = await guard("attendance.edit");
  const id = s(formData.get("studentId"));
  const date = s(formData.get("date")) ?? todayStr();
  if (!id) return;
  await db.query(
    `delete from attendance where student_id=$1 and branch_id=$2 and date=$3`,
    [id, me.activeBranchId, date],
  );
  revalidatePath("/m/seat");
  revalidatePath("/m/student");
}
