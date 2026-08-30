// 학생 정기 스케쥴 제출(submission, type='schedule') 검토·반영 — ScheduleDemo.tsx 사이드바
// "제출 반영" 항목에서 진입하는 독립 뷰의 서버액션.
// 비교·검증은 src/lib/schedule-import.ts(JSON 일괄 반영과 동일 로직) + src/lib/schedule-submission.ts
// (payload → 그 로직이 받는 모양으로 감싸는 어댑터)를 그대로 재사용한다 — 재발명하지 않는다.
// 목록·비교 조회는 지점 전체를 3쿼리로(학생별 루프 없음), 반영은 선택된 제출들을 묶어서 처리한다.
import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";
import { dateTimeLabel } from "@/lib/date";
import { adaptSubmissionPayload } from "@/lib/schedule-submission";
import { asJsonObject } from "@/lib/jsonb";
import { applySubmissionsCore, isScheduleAutoApplyOn, type ApplySubmissionsResult } from "@/lib/schedule-submission-apply";

const s = (v: FormDataEntryValue | null): string => String(v ?? "").trim();

// ---------------- 목록 + 비교용 베이스 조회 ----------------
export type SubStatus = "pending" | "done" | "rejected";

export type SubmissionRow = {
  id: string;
  studentId: string | null;
  studentName: string;
  studentMatched: boolean; // student_id 가 있고 실제 student 행과 조인이 됐는지 — false 면 "학생 미연결"
  seatNumber: number | null;
  status: SubStatus;
  note: string | null;
  payload: unknown; // 원시 jsonb — 화면(클라)이 adaptSubmissionPayload 로 검증·정규화한다
  createdLabel: string; // 마지막 제출(수정) 시각
  createdAt: string; // 정렬용 원시 timestamptz(표시는 라벨만 쓴다)
  firstSubmittedLabel: string | null; // 최초 제출 시각(재제출해도 안 바뀜)
  firstSubmittedAt: string | null; // 정렬용 원시 timestamptz
  processedLabel: string | null;
  processedByName: string | null;
};

export type BaseHours = { studentId: string; day: number; arrive: number; leave: number };
export type BaseAcademy = { studentId: string; reason: string; title: string; days: number[]; start: number; end: number };
export type SubmissionsBase = {
  submissions: SubmissionRow[];
  hours: BaseHours[];
  academies: BaseAcademy[];
  /** 지점의 자동 반영 설정(schedule_auto_apply) — 기본 켜짐(isScheduleAutoApplyOn 과 동일 규칙). */
  autoApply: boolean;
};

type SubmissionRowDb = {
  id: string;
  student_id: string | null;
  student_name: string | null;
  seat_number: number | null;
  submitter_name: string | null;
  payload: unknown;
  status: string;
  note: string | null;
  created_at: string;
  first_submitted_at: string | null;
  processed_at: string | null;
  processed_by_name: string | null;
};

export async function loadSubmissionsBase(): Promise<SubmissionsBase> {
  const me = await guard("schedule.view");
  const branchId = me.activeBranchId;
  if (!branchId) throw new Error("소속 지점을 확인할 수 없습니다");

  const [subRows, hoursRows, ruleRows, autoApply] = await Promise.all([
    db.query<SubmissionRowDb>(
      `select sub.id, sub.student_id, st.name as student_name, seat.number as seat_number,
              sub.submitter_name, sub.payload, sub.status, sub.note,
              sub.created_at::text as created_at, sub.first_submitted_at::text as first_submitted_at,
              sub.processed_at::text as processed_at, p.name as processed_by_name
         from submission sub
         left join student st on st.id = sub.student_id
         left join seat on seat.current_student_id = st.id and seat.branch_id = sub.branch_id
         left join person p on p.id = sub.processed_by
        where sub.branch_id=$1 and sub.type='schedule'
        order by (case when sub.status='pending' then 0 else 1 end), sub.created_at desc`,
      [branchId],
    ),
    db.query<{ student_id: string; day: number; arrive_min: number; leave_min: number }>(
      `select student_id, day, arrive_min, leave_min from schedule_hours where branch_id=$1`,
      [branchId],
    ),
    db.query<{ student_id: string; reason: string; title: string; start_min: number; end_min: number; days: string }>(
      `select student_id, reason, title, start_min, end_min, days from schedule_rule where branch_id=$1 and kind='academy'`,
      [branchId],
    ),
    isScheduleAutoApplyOn(branchId),
  ]);

  const submissions: SubmissionRow[] = subRows.rows.map((r) => ({
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name ?? r.submitter_name ?? "(알 수 없음)",
    studentMatched: r.student_id != null && r.student_name != null,
    seatNumber: r.seat_number,
    status: (r.status as SubStatus) ?? "pending",
    note: r.note,
    payload: r.payload,
    createdLabel: dateTimeLabel(r.created_at),
    createdAt: r.created_at,
    firstSubmittedLabel: r.first_submitted_at ? dateTimeLabel(r.first_submitted_at) : null,
    firstSubmittedAt: r.first_submitted_at,
    processedLabel: r.processed_at ? dateTimeLabel(r.processed_at) : null,
    processedByName: r.processed_by_name,
  }));

  return {
    submissions,
    hours: hoursRows.rows.map((r) => ({ studentId: r.student_id, day: r.day, arrive: r.arrive_min, leave: r.leave_min })),
    academies: ruleRows.rows.map((r) => ({
      studentId: r.student_id,
      reason: r.reason,
      title: r.title,
      days: r.days ? r.days.split(",").map(Number).filter((n) => Number.isFinite(n)) : [],
      start: r.start_min,
      end: r.end_min,
    })),
    autoApply,
  };
}

// ---------------- 자동 반영 설정 ----------------
export async function setAutoApply(on: boolean): Promise<void> {
  const me = await guard("schedule.manage");
  await db.query(
    `insert into branch_setting(branch_id, key, value) values ($1,'schedule_auto_apply',$2)
     on conflict (branch_id, key) do update set value=excluded.value, updated_at=now()`,
    [me.activeBranchId, on ? "1" : "0"],
  );
  revalidatePath("/m/schedule");
}

// ---------------- 반영 ----------------
// 실제 반영 로직(재조회·검증·delete+insert)은 src/lib/schedule-submission-apply.ts applySubmissionsCore
// 하나로 통일돼 있다 — 자동 반영(f/actions.ts submitForm)도 같은 함수를 그대로 쓴다(두 경로가 갈리면
// "자동 반영"과 "관리자가 수동 반영"의 결과가 달라질 수 있다). 여기서는 권한(guard)과 id 파싱만 맡는다.
export async function applySubmissions(idsJson: string): Promise<ApplySubmissionsResult> {
  const me = await guard("schedule.manage");
  const branchId = me.activeBranchId;
  if (!branchId) throw new Error("소속 지점을 확인할 수 없습니다");

  let ids: unknown;
  try {
    ids = JSON.parse(idsJson);
  } catch {
    throw new Error("입력값을 확인하세요");
  }
  if (!Array.isArray(ids)) throw new Error("입력값을 확인하세요");
  const uniqIds = ids.filter((x): x is string => typeof x === "string" && x.length > 0);

  const result = await applySubmissionsCore(branchId, uniqIds);
  // processed_by 는 applySubmissionsCore 가 null 로 남기므로(자동 반영엔 처리자가 없다), 관리자가
  // 직접 반영한 건은 여기서 me.id 로 덮어써서 "처리 M월 D일 HH:MM (이름)" 이 정확히 보이게 한다.
  if (result.appliedIds.length > 0) {
    const updParams: string[] = [me.id, branchId];
    const ph = result.appliedIds.map((id) => {
      updParams.push(id);
      return `$${updParams.length}`;
    });
    await db.query(`update submission set processed_by=$1 where branch_id=$2 and id in (${ph.join(",")})`, updParams);
  }
  revalidatePath("/m/schedule");
  return result;
}

// ---------------- 반려 ----------------
export async function rejectSubmission(formData: FormData): Promise<void> {
  const me = await guard("schedule.manage");
  const id = s(formData.get("id"));
  const note = s(formData.get("note")) || null;
  if (!id) throw new Error("요청을 확인하세요");
  const r = await db.query(
    `update submission set status='rejected', note=$1, processed_by=$2, processed_at=now()
      where id=$3 and branch_id=$4 and type='schedule' and status='pending' returning id`,
    [note, me.id, id, me.activeBranchId],
  );
  if (r.rows.length === 0) throw new Error("대기 중인 제출이 아닙니다");
  revalidatePath("/m/schedule");
}

// ---------------- 삭제(테스트 제출 · 처리 끝난 제출) ----------------
// 삭제 가능한 건: (1) 테스트 제출(payload._test===true 이거나 student_id 가 null) — 실제 학생 데이터가
// 아니므로 상태와 무관하게 삭제 가능, (2) 처리가 끝난 제출(status='done'|'rejected') — 검토가 이미
// 끝나 시간표(또는 반려 사유)에 결과가 남아있으므로 기록만 지워도 안전하다.
// 대기 중(pending)인 진짜 제출은 여기서 막는다 — 실수로 지우면 검토 대상이 통째로 사라지고 학생에게는
// 아무 처리도 안 된 것처럼 보인다. 화면(SubmissionsView.tsx)은 그 경우 삭제 버튼을 비활성화하고
// "반려한 뒤 삭제하세요" 안내만 보여주지만, 클라가 어떤 값을 보내든 서버가 다시 판정해서 거부한다.
export type DeleteSubmissionsResult = { deleted: number; failed: { id: string; error: string }[] };

function isDeletablePayload(payload: unknown, studentId: string | null): boolean {
  return asJsonObject(payload)?._test === true || studentId == null;
}

export async function deleteSubmissions(idsJson: string): Promise<DeleteSubmissionsResult> {
  const me = await guard("schedule.manage");
  const branchId = me.activeBranchId;
  if (!branchId) throw new Error("소속 지점을 확인할 수 없습니다");

  let ids: unknown;
  try {
    ids = JSON.parse(idsJson);
  } catch {
    throw new Error("입력값을 확인하세요");
  }
  if (!Array.isArray(ids)) throw new Error("입력값을 확인하세요");
  const uniqIds = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (uniqIds.length === 0) return { deleted: 0, failed: [] };

  const params: string[] = [branchId];
  const ph = uniqIds.map((id) => {
    params.push(id);
    return `$${params.length}`;
  });
  const rows = await db.query<{ id: string; student_id: string | null; payload: unknown; status: string }>(
    `select id, student_id, payload, status from submission where branch_id=$1 and type='schedule' and id in (${ph.join(",")})`,
    params,
  );
  const found = new Map(rows.rows.map((r) => [r.id, r]));

  const deletableIds: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of uniqIds) {
    const row = found.get(id);
    if (!row) { failed.push({ id, error: "제출을 찾을 수 없습니다" }); continue; }
    const isTest = isDeletablePayload(row.payload, row.student_id);
    if (isTest || row.status === "done" || row.status === "rejected") {
      deletableIds.push(id);
    } else {
      failed.push({ id, error: "대기 중인 제출은 반려한 뒤 삭제할 수 있습니다" });
    }
  }

  if (deletableIds.length === 0) return { deleted: 0, failed };

  const delParams: string[] = [branchId];
  const delPh = deletableIds.map((id) => {
    delParams.push(id);
    return `$${delParams.length}`;
  });
  await db.query(`delete from submission where branch_id=$1 and id in (${delPh.join(",")})`, delParams);
  revalidatePath("/m/schedule");
  return { deleted: deletableIds.length, failed };
}
