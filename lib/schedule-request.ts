// 학생 일정 변경 신청(schedule_request) 승인·되돌리기 로직 — 관리자 수동 처리(m/schedule/requestActions.ts)와
// 학생 신청 즉시 자동 승인(f/[slug]/forms/schedule-request-actions.ts, 지점 설정 schedule_auto_approve)
// 둘 다 같은 경로를 타야 "자동 승인 켜면 신청 즉시 승인" 이 수동 승인과 완전히 같은 결과를 만든다 —
// 그래서 로직을 여기 한 곳에 둔다.
//
// 신청 갈래(req_kind, src/lib/schedule.ts REQUEST_KINDS 가 단일 출처) 3가지:
// - temp: 특정 날짜 하루만 바뀜 — 승인하면 schedule_exception 을 만들어 request.exception_id 로 연결(기존 로직).
// - rule_edit: 기존 정기 규칙(target_rule_id) 하나의 요일/시간/사유/제목을 바꿈 — 승인하면 그 schedule_rule
//   행을 실제로 update. 되돌리기 위해 수정 "전" 값을 prev_snapshot(jsonb)에 남긴다.
// - rule_delete: 기존 정기 규칙(target_rule_id) 하나를 영구 삭제 — 승인하면 그 행을 delete. 되돌릴 때
//   재생성할 수 있도록 삭제 "전" 값 전체를 prev_snapshot 에 남긴다.
//
// target_rule_id 는 schedule_rule 에 on delete set null 로 걸려 있다(cascade 아님) — 그래서:
// - 신청이 대기 중일 때 그 규칙이 "다른 경로"(예: m/schedule 정기 편집 화면에서 직접 삭제)로 사라지면
//   target_rule_id 만 null 이 되고 신청 행 자체는 남는다 → 승인 시도 시 "대상이 이미 사라졌다"로 반려.
// - rule_delete 신청 자신을 승인해 우리가 그 규칙을 지울 때도, 방금 approved 로 표시한 이 신청 행이
//   cascade 로 함께 사라지지 않는다(prev_snapshot 이 살아남아야 되돌리기가 가능하다).
import { db } from "./db";
import { asJsonObject } from "./jsonb";

type RequestRow = {
  id: string;
  branch_id: string;
  student_id: string;
  date: string | null;
  kind: string;
  reason: string;
  title: string | null;
  start_min: number;
  end_min: number;
  skip_rule_id: string | null;
  status: string;
  req_kind: string;
  target_rule_id: string | null;
  days: string | null;
};

/** schedule_rule 한 행의 스냅샷(prev_snapshot jsonb 모양) — rule_edit/rule_delete 되돌리기의 복원 소스. */
export type RuleSnapshot = {
  id: string;
  reason: string;
  kind: string;
  title: string;
  start_min: number;
  end_min: number;
  days: string;
};

const NOT_FOUND_NOTE = "대상 정기 일정이 이미 삭제되어 처리할 수 없어요.";

export type ApproveOutcome =
  | { status: "approved"; reqKind: "temp"; exceptionId: string }
  | { status: "approved"; reqKind: "rule_edit" | "rule_delete" }
  | { status: "rejected"; note: string };

/** 대기 중인 신청 하나를 승인. decidedBy=null 이면 자동 승인(사람이 결정하지 않음)으로 기록한다.
 * branchId 로 지점을 한정해 다른 지점의 신청 id 로는 승인이 걸리지 않게 한다.
 * rule_edit/rule_delete 인데 target_rule_id 가 이미 null(다른 경로로 삭제됨)이거나 그 규칙을 찾을 수 없으면
 * 예외를 던지지 않고 그 자리에서 반려(status='rejected', note=사유) 처리해 결과를 돌려준다 — 자동 승인
 * 배치 하나가 이 케이스 때문에 통째로 실패하면 안 되기 때문(다른 항목은 계속 처리돼야 함). */
export async function approveScheduleRequest(
  id: string,
  branchId: string,
  decidedBy: string | null,
): Promise<ApproveOutcome> {
  const r = await db.query<RequestRow>(
    `select id, branch_id, student_id, date::text as date, kind, reason, title, start_min, end_min,
            skip_rule_id, status, req_kind, target_rule_id, days
       from schedule_request where id=$1 and branch_id=$2`,
    [id, branchId],
  );
  const row = r.rows[0];
  if (!row) throw new Error("신청을 찾을 수 없습니다");
  if (row.status !== "pending") throw new Error("이미 처리된 신청입니다");

  if (row.req_kind === "rule_edit" || row.req_kind === "rule_delete") {
    return approveRuleChange(row, decidedBy);
  }

  // ---- temp: 기존 로직 — schedule_exception 을 만들어 연결 ----
  const exc = await db.query<{ id: string }>(
    `insert into schedule_exception(branch_id, student_id, reason, kind, title, start_min, end_min, date, skip_rule_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id`,
    [row.branch_id, row.student_id, row.reason, row.kind, row.title ?? "", row.start_min, row.end_min, row.date, row.skip_rule_id],
  );
  const exceptionId = exc.rows[0]?.id;
  if (!exceptionId) throw new Error("일정 반영에 실패했습니다");

  await db.query(
    `update schedule_request
        set status='approved', exception_id=$1, note=null, decided_at=now(), decided_by=$2
      where id=$3`,
    [exceptionId, decidedBy, id],
  );
  return { status: "approved", reqKind: "temp", exceptionId };
}

async function rejectMissingTarget(id: string, decidedBy: string | null): Promise<ApproveOutcome> {
  await db.query(
    `update schedule_request set status='rejected', note=$1, decided_at=now(), decided_by=$2 where id=$3`,
    [NOT_FOUND_NOTE, decidedBy, id],
  );
  return { status: "rejected", note: NOT_FOUND_NOTE };
}

async function approveRuleChange(row: RequestRow, decidedBy: string | null): Promise<ApproveOutcome> {
  if (!row.target_rule_id) return rejectMissingTarget(row.id, decidedBy);

  const cur = await db.query<{ id: string; reason: string; kind: string; title: string; start_min: number; end_min: number; days: string }>(
    `select id, reason, kind, title, start_min, end_min, days
       from schedule_rule where id=$1 and branch_id=$2 and student_id=$3`,
    [row.target_rule_id, row.branch_id, row.student_id],
  );
  const rule = cur.rows[0];
  if (!rule) return rejectMissingTarget(row.id, decidedBy);

  const snapshot: RuleSnapshot = {
    id: rule.id, reason: rule.reason, kind: rule.kind, title: rule.title,
    start_min: rule.start_min, end_min: rule.end_min, days: rule.days,
  };

  if (row.req_kind === "rule_edit") {
    if (!row.days) throw new Error("요일 정보가 없습니다");
    const upd = await db.query(
      `update schedule_rule set reason=$1, kind=$2, title=$3, start_min=$4, end_min=$5, days=$6
        where id=$7 and branch_id=$8 and student_id=$9 returning id`,
      [row.reason, row.kind, row.title ?? "", row.start_min, row.end_min, row.days, row.target_rule_id, row.branch_id, row.student_id],
    );
    if (upd.rows.length === 0) return rejectMissingTarget(row.id, decidedBy);
    await db.query(
      `update schedule_request
          set status='approved', prev_snapshot=$1::jsonb, note=null, decided_at=now(), decided_by=$2
        where id=$3`,
      [JSON.stringify(snapshot), decidedBy, row.id],
    );
    return { status: "approved", reqKind: "rule_edit" };
  }

  // rule_delete
  const del = await db.query<{ id: string }>(
    `delete from schedule_rule where id=$1 and branch_id=$2 and student_id=$3 returning id`,
    [row.target_rule_id, row.branch_id, row.student_id],
  );
  if (del.rows.length === 0) return rejectMissingTarget(row.id, decidedBy);
  await db.query(
    `update schedule_request
        set status='approved', prev_snapshot=$1::jsonb, note=null, decided_at=now(), decided_by=$2
      where id=$3`,
    [JSON.stringify(snapshot), decidedBy, row.id],
  );
  return { status: "approved", reqKind: "rule_delete" };
}

/** 승인 취소(되돌리기) — 신청을 다시 대기 상태로 되돌린다.
 * - temp: 연결된 schedule_exception 을 삭제.
 * - rule_edit: prev_snapshot(수정 전 값)으로 schedule_rule 을 되돌려 update. 그 사이 규칙이 다른 경로로
 *   삭제됐으면(target_rule_id 가 null) 실패.
 * - rule_delete: prev_snapshot 으로 schedule_rule 행을 재생성(가능하면 같은 id) 하고, 신청의
 *   target_rule_id 를 복원된 id 로 다시 연결한다. */
export async function revertScheduleRequest(id: string, branchId: string): Promise<void> {
  const r = await db.query<RequestRow & { exception_id: string | null; prev_snapshot: RuleSnapshot | null }>(
    `select id, branch_id, student_id, date::text as date, kind, reason, title, start_min, end_min,
            skip_rule_id, status, req_kind, target_rule_id, days, exception_id, prev_snapshot
       from schedule_request where id=$1 and branch_id=$2 and status='approved'`,
    [id, branchId],
  );
  const row = r.rows[0];
  // 운영에서는 jsonb 가 문자열로 온다(lib/jsonb.ts) — 스냅샷도 읽기 전에 정규화한다.
  if (row) row.prev_snapshot = asJsonObject(row.prev_snapshot) as RuleSnapshot | null;
  if (!row) throw new Error("승인된 신청이 아닙니다");

  if (row.req_kind === "rule_edit") {
    const snap = row.prev_snapshot;
    if (!snap) throw new Error("복원할 이전 값이 없습니다");
    if (!row.target_rule_id) throw new Error("대상 정기 일정을 찾을 수 없어요(다른 경로로 삭제됨).");
    const upd = await db.query<{ id: string }>(
      `update schedule_rule set reason=$1, kind=$2, title=$3, start_min=$4, end_min=$5, days=$6
        where id=$7 and branch_id=$8 and student_id=$9 returning id`,
      [snap.reason, snap.kind, snap.title, snap.start_min, snap.end_min, snap.days, row.target_rule_id, row.branch_id, row.student_id],
    );
    if (upd.rows.length === 0) throw new Error("대상 정기 일정을 찾을 수 없어요(다른 경로로 삭제됨).");
  } else if (row.req_kind === "rule_delete") {
    const snap = row.prev_snapshot;
    if (!snap) throw new Error("복원할 이전 값이 없습니다");
    let restoredId = snap.id;
    const ins = await db.query<{ id: string }>(
      `insert into schedule_rule(id, branch_id, student_id, reason, kind, title, start_min, end_min, days)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do nothing
       returning id`,
      [snap.id, row.branch_id, row.student_id, snap.reason, snap.kind, snap.title, snap.start_min, snap.end_min, snap.days],
    );
    if (ins.rows.length === 0) {
      // 같은 id 가 이미 쓰이고 있으면(극히 드묾) 새 id 로 복원한다.
      const ins2 = await db.query<{ id: string }>(
        `insert into schedule_rule(branch_id, student_id, reason, kind, title, start_min, end_min, days)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         returning id`,
        [row.branch_id, row.student_id, snap.reason, snap.kind, snap.title, snap.start_min, snap.end_min, snap.days],
      );
      restoredId = ins2.rows[0]?.id ?? snap.id;
    }
    await db.query(`update schedule_request set target_rule_id=$1 where id=$2`, [restoredId, id]);
  }

  await db.query(
    `update schedule_request
        set status='pending', exception_id=null, prev_snapshot=null, note=null, decided_at=null, decided_by=null
      where id=$1`,
    [id],
  );
  if (row.exception_id) {
    await db.query(`delete from schedule_exception where id=$1 and branch_id=$2`, [row.exception_id, branchId]);
  }
}

/** 지점의 자동 승인 설정(branch_setting.schedule_auto_approve = '1') 여부. */
export async function isAutoApproveOn(branchId: string): Promise<boolean> {
  const r = await db.query<{ value: string }>(
    `select value from branch_setting where branch_id=$1 and key='schedule_auto_approve'`,
    [branchId],
  );
  return r.rows[0]?.value === "1";
}
