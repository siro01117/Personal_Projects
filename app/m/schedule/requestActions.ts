// 학생 일정 변경 신청(schedule_request) 관리 — 조회·승인·반려·되돌리기 + 지점 자동 승인 설정.
// 3갈래(req_kind, src/lib/schedule.ts REQUEST_KINDS 가 단일 출처): temp(임시 변경)/rule_edit(정기 수정)/
// rule_delete(정기 삭제). 실제 승인·되돌리기 로직(schedule_rule/schedule_exception 갱신)은
// src/lib/schedule-request.ts 를 그대로 재사용한다(학생 신청 즉시 자동 승인 경로와 완전히 같은 코드를
// 타야 결과가 갈리지 않는다).
import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";
import { dateTimeLabel, weekdayOf } from "@/lib/date";
import { type ScheduleKind, type RequestType, type RequestKind, requestTimeLabel, daysLabelOf } from "@/lib/schedule";
import { approveScheduleRequest, revertScheduleRequest, isAutoApproveOn, type RuleSnapshot } from "@/lib/schedule-request";

const s = (v: FormDataEntryValue | null): string => String(v ?? "").trim();
const pad2 = (n: number) => String(n).padStart(2, "0");
function fmtClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}
function fmtLeave(min: number): string {
  return min >= 1440 ? `다음날 ${fmtClock(min)}` : fmtClock(min);
}
function fmtRange(start: number, end: number): string {
  return `${fmtClock(start)}–${fmtLeave(end)}`;
}
function dateLabelOf(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  const WD_KR = ["일", "월", "화", "수", "목", "금", "토"];
  return `${m}월 ${d}일 (${WD_KR[weekdayOf(date)]})`;
}
function dow1to7(date: string): number {
  return ((weekdayOf(date) + 6) % 7) + 1;
}

export type RequestStatus = "pending" | "approved" | "rejected";
export type RequestRow = {
  id: string;
  studentId: string;
  studentName: string;
  seatNumber: number | null;
  reqKind: RequestKind;
  date: string | null;
  dateLabel: string | null; // rule_edit/rule_delete 는 특정 날짜가 없어 null
  kind: ScheduleKind;
  reason: string;
  title: string | null;
  reqType: RequestType; // temp 에서만 의미 있음(그 외엔 표시하지 않음)
  timeLabel: string; // 종류별 요약 표기(temp=시간, rule_edit=새 요일·시간, rule_delete=삭제될 요일·시간)
  status: RequestStatus;
  note: string | null;
  mode: "add" | "replace";
  createdLabel: string;
  createdAt: string; // 정렬용 원시 timestamptz(표시는 라벨만 쓴다)
  decidedLabel: string | null;
  decidedByName: string | null;
};

type RequestRowDb = {
  id: string; student_id: string; student_name: string; seat_number: number | null;
  req_kind: string; date: string | null; kind: ScheduleKind; reason: string; title: string | null;
  req_type: string; start_min: number; end_min: number; days: string | null;
  skip_rule_id: string | null; status: string; note: string | null;
  created_at: string; decided_at: string | null; decided_by_name: string | null;
};
function summaryOf(r: RequestRowDb): string {
  if (r.req_kind === "rule_edit" || r.req_kind === "rule_delete") {
    const days = r.days ? daysLabelOf(r.days) : "";
    return days ? `${days} ${fmtRange(r.start_min, r.end_min)}` : fmtRange(r.start_min, r.end_min);
  }
  return requestTimeLabel(r.req_type, r.start_min, r.end_min);
}
const toRow = (r: RequestRowDb): RequestRow => ({
  id: r.id, studentId: r.student_id, studentName: r.student_name, seatNumber: r.seat_number,
  reqKind: (r.req_kind as RequestKind) ?? "temp",
  date: r.date, dateLabel: r.date ? dateLabelOf(r.date) : null,
  kind: r.kind, reason: r.reason, title: r.title,
  reqType: r.req_type as RequestType,
  timeLabel: summaryOf(r), status: r.status as RequestStatus, note: r.note,
  mode: r.skip_rule_id ? "replace" : "add",
  createdLabel: dateTimeLabel(r.created_at), createdAt: r.created_at,
  decidedLabel: r.decided_at ? dateTimeLabel(r.decided_at) : null,
  decidedByName: r.decided_by_name,
});

// ---------------- 목록 + 자동 승인 설정 ----------------
export type RequestListResult = { rows: RequestRow[]; autoApprove: boolean; pendingCount: number };

export async function listRequests(): Promise<RequestListResult> {
  const me = await guard("schedule.view");
  const [rows, auto] = await Promise.all([
    db.query<RequestRowDb>(
      `select rq.id, rq.student_id, st.name as student_name, seat.number as seat_number,
              rq.req_kind, rq.date::text as date, rq.kind, rq.reason, rq.title, rq.req_type,
              rq.start_min, rq.end_min, rq.days, rq.skip_rule_id,
              rq.status, rq.note, rq.created_at, rq.decided_at, p.name as decided_by_name
         from schedule_request rq
         join student st on st.id = rq.student_id
         left join seat on seat.current_student_id = st.id and seat.branch_id = st.branch_id
         left join person p on p.id = rq.decided_by
        where rq.branch_id=$1
        order by (case when rq.status='pending' then 0 else 1 end), rq.created_at desc`,
      [me.activeBranchId],
    ),
    isAutoApproveOn(me.activeBranchId ?? ""),
  ]);
  const mapped = rows.rows.map(toRow);
  return { rows: mapped, autoApprove: auto, pendingCount: mapped.filter((r) => r.status === "pending").length };
}

export async function setAutoApprove(on: boolean): Promise<void> {
  const me = await guard("schedule.manage");
  await db.query(
    `insert into branch_setting(branch_id, key, value) values ($1,'schedule_auto_approve',$2)
     on conflict (branch_id, key) do update set value=excluded.value, updated_at=now()`,
    [me.activeBranchId, on ? "1" : "0"],
  );
  revalidatePath("/m/schedule");
}

// ---------------- 행 펼침 ----------------
// temp: 그 날짜의 그 학생 시간표(겹치는 정기 일정 판단용, 기존 그대로).
// rule_edit/rule_delete: 대상 정기 일정의 "현재" 값(current, 아직 있으면 실시간 조회 / 이미 처리돼
// 사라졌으면 prev_snapshot 으로) 과 rule_edit 의 "신청" 값(proposed) 을 나란히 보여줄 수 있게 both 반환.
export type DetailRuleRow = { kind: ScheduleKind; reason: string; title: string; start: number; end: number };
export type RuleCompareRow = DetailRuleRow & { daysLabel: string };
export type RequestDetail = {
  reqKind: RequestKind;
  rules: DetailRuleRow[];
  hours: { arrive: number; leave: number } | null;
  existingExceptions: DetailRuleRow[];
  current: RuleCompareRow | null;
  proposed: RuleCompareRow | null;
};

export async function getRequestDetail(id: string): Promise<RequestDetail> {
  const me = await guard("schedule.view");
  const req = await db.query<{
    student_id: string; date: string | null; req_kind: string; target_rule_id: string | null;
    kind: ScheduleKind; reason: string; title: string | null; start_min: number; end_min: number;
    days: string | null; prev_snapshot: RuleSnapshot | null;
  }>(
    `select student_id, date::text as date, req_kind, target_rule_id, kind, reason, title, start_min, end_min, days, prev_snapshot
       from schedule_request where id=$1 and branch_id=$2`,
    [id, me.activeBranchId],
  );
  const row = req.rows[0];
  if (!row) throw new Error("신청을 찾을 수 없습니다");
  const reqKind = (row.req_kind as RequestKind) ?? "temp";

  if (reqKind === "rule_edit" || reqKind === "rule_delete") {
    let current: RuleCompareRow | null = null;
    if (row.target_rule_id) {
      const cur = await db.query<{ kind: ScheduleKind; reason: string; title: string; start_min: number; end_min: number; days: string }>(
        `select kind, reason, title, start_min, end_min, days from schedule_rule where id=$1 and branch_id=$2`,
        [row.target_rule_id, me.activeBranchId],
      );
      const c = cur.rows[0];
      if (c) current = { kind: c.kind, reason: c.reason, title: c.title, start: c.start_min, end: c.end_min, daysLabel: daysLabelOf(c.days) };
    }
    if (!current && row.prev_snapshot) {
      const snap = row.prev_snapshot;
      current = { kind: snap.kind as ScheduleKind, reason: snap.reason, title: snap.title, start: snap.start_min, end: snap.end_min, daysLabel: daysLabelOf(snap.days) };
    }
    const proposed: RuleCompareRow | null =
      reqKind === "rule_edit"
        ? { kind: row.kind, reason: row.reason, title: row.title ?? "", start: row.start_min, end: row.end_min, daysLabel: daysLabelOf(row.days ?? "") }
        : null;
    return { reqKind, rules: [], hours: null, existingExceptions: [], current, proposed };
  }

  // temp
  if (!row.date) throw new Error("날짜 정보가 없습니다");
  const dow = dow1to7(row.date);
  const [rules, hours, excs] = await Promise.all([
    db.query<{ kind: ScheduleKind; reason: string; title: string; start_min: number; end_min: number; days: string }>(
      `select kind, reason, title, start_min, end_min, days from schedule_rule where branch_id=$1 and student_id=$2`,
      [me.activeBranchId, row.student_id],
    ),
    db.query<{ arrive_min: number; leave_min: number }>(
      `select arrive_min, leave_min from schedule_hours where branch_id=$1 and student_id=$2 and day=$3`,
      [me.activeBranchId, row.student_id, dow],
    ),
    db.query<{ kind: ScheduleKind; reason: string; title: string; start_min: number; end_min: number }>(
      `select kind, reason, title, start_min, end_min from schedule_exception
        where branch_id=$1 and student_id=$2 and date=$3`,
      [me.activeBranchId, row.student_id, row.date],
    ),
  ]);

  return {
    reqKind,
    rules: rules.rows.filter((r) => r.days.split(",").map(Number).includes(dow))
      .map((r) => ({ kind: r.kind, reason: r.reason, title: r.title, start: r.start_min, end: r.end_min })),
    hours: hours.rows[0] ? { arrive: hours.rows[0].arrive_min, leave: hours.rows[0].leave_min } : null,
    existingExceptions: excs.rows.map((r) => ({ kind: r.kind, reason: r.reason, title: r.title, start: r.start_min, end: r.end_min })),
    current: null, proposed: null,
  };
}

// ---------------- 승인/반려/되돌리기 ----------------
/** target_rule_id 가 이미 사라진 rule_edit/rule_delete 는 approveScheduleRequest 가 예외를 던지지 않고
 * status='rejected' 로 직접 반려 처리한 뒤 그 결과를 돌려준다 — 여기서는 그 경우만 사람이 보는 에러로
 * 변환해 던진다(관리자 화면이 err 배너로 보여준다. 목록은 어차피 revalidatePath 로 반려 상태가 반영됨). */
export async function approveRequest(id: string): Promise<void> {
  const me = await guard("schedule.manage");
  const outcome = await approveScheduleRequest(id, me.activeBranchId ?? "", me.id);
  revalidatePath("/m/schedule");
  if (outcome.status === "rejected") throw new Error(outcome.note);
}

export async function rejectRequest(formData: FormData): Promise<void> {
  const me = await guard("schedule.manage");
  const id = s(formData.get("id"));
  const note = s(formData.get("note")) || null;
  if (!id) throw new Error("요청을 확인하세요");
  const r = await db.query(
    `update schedule_request set status='rejected', note=$1, decided_at=now(), decided_by=$2
      where id=$3 and branch_id=$4 and status='pending' returning id`,
    [note, me.id, id, me.activeBranchId],
  );
  if (r.rows.length === 0) throw new Error("대기 중인 신청이 아닙니다");
  revalidatePath("/m/schedule");
}

/** 승인 취소(되돌리기) — 종류별 복원은 src/lib/schedule-request.ts revertScheduleRequest 가 담당. */
export async function revertRequest(id: string): Promise<void> {
  const me = await guard("schedule.manage");
  await revertScheduleRequest(id, me.activeBranchId ?? "");
  revalidatePath("/m/schedule");
}
