// 스케쥴 입력 개방 판정 — 조회(DB) 담당. 판정 자체(순수 로직)는 schedule-window.ts.
// 학생 1명 기준 쿼리 2개(제출 이력·유효한 활성화)로 끝난다 — 목록 화면(관리자 "입력 활성화")처럼
// 여러 학생을 한 번에 봐야 할 때는 이 함수를 학생마다 부르지 말고, windowActions.ts 처럼 제출 이력·
// 활성화를 한 번만 불러온 뒤 evaluateEdit 을 학생마다 메모리에서 돌려라(DB 왕복 없이).
import { db } from "./db";
import { asJsonObject } from "./jsonb";
import { evaluateEdit, type EditState } from "./schedule-window";

type SubmissionLookupRow = {
  payload: unknown;
  first_submitted_at: string | null;
  created_at: string;
  status: string;
  note: string | null;
};

export type EditResolution = {
  state: EditState;
  /** 이 학생의 마지막 제출 payload(스케쥴 폼이 저장한 그대로) — 없으면 한 번도 제출한 적 없음. */
  lastPayload: Record<string, unknown> | null;
  /** 마지막 제출 시각(가장 최근 제출/수정) — KST 라벨은 호출부가 date.ts 로 직접 포맷할 것. */
  lastSubmittedAt: string | null;
  /** 마지막 제출의 처리 상태(pending/done/rejected) — 없으면(한 번도 제출한 적 없음) null. */
  lastStatus: "pending" | "done" | "rejected" | null;
  /** 반려 사유(있다면) — 관리자 화면(m/schedule "제출 반영")의 반려 note 그대로. */
  lastNote: string | null;
};

/** 한 학생의 스케쥴 입력 개방 판정 — 기준은 submission.type 뿐이다. payload->>'_slug' 는 부가 키라
 *  값이 다르거나 예전 제출에 없으면 실제로는 제출했는데도 못 찾는 문제가 있었다(2026-08-22 수정) —
 *  type='schedule' 은 registry.ts 상 슬러그 sch9m2vt 하나뿐이라 type 만으로 충분하다. */
export async function resolveEditState(
  branchId: string,
  studentId: string,
  type: string,
): Promise<EditResolution> {
  const [subRows, grantRows] = await Promise.all([
    db.query<SubmissionLookupRow>(
      `select payload, first_submitted_at, created_at, status, note
         from submission
        where branch_id=$1 and student_id=$2 and type=$3
        order by created_at desc limit 1`,
      [branchId, studentId, type],
    ),
    db.query<{ id: string }>(
      `select id from schedule_grant where branch_id=$1 and student_id=$2 and consumed_at is null limit 1`,
      [branchId, studentId],
    ),
  ]);

  const sub = subRows.rows[0] ?? null;
  const firstSubmittedAt = sub?.first_submitted_at ? new Date(sub.first_submitted_at) : null;
  const hasActiveGrant = grantRows.rows.length > 0;

  const state = evaluateEdit({ firstSubmittedAt, hasActiveGrant });
  return {
    state,
    lastPayload: sub ? asJsonObject(sub.payload) : null,
    lastSubmittedAt: sub ? sub.created_at : null,
    lastStatus: sub ? (sub.status as "pending" | "done" | "rejected") : null,
    lastNote: sub?.note ?? null,
  };
}

/** 제출 성공 직후 그 학생의 유효한(아직 소진되지 않은) 활성화를 소진시킨다 — 관리자가 활성화해서
 *  연 개방은 1회용이라, 제출 하나가 끝나면 다시 잠겨야 한다. 활성화가 없었다면(=첫 제출로 연 경우)
 *  0행이 바뀌고 조용히 끝난다 — 소진할 게 없는 게 정상이라 에러가 아니다. */
export async function consumeActiveGrant(branchId: string, studentId: string): Promise<void> {
  await db.query(
    `update schedule_grant set consumed_at=now() where branch_id=$1 and student_id=$2 and consumed_at is null`,
    [branchId, studentId],
  );
}
