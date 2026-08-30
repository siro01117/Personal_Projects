// 학생 스케쥴 입력 개방 판정 — 순수 함수(DB·세션 의존 없음). 실제 조회는 schedule-window-server.ts.
//
// 규칙(2026-08-22, 기간 개념 완전 폐지):
//   1) 한 번도 제출한 적 없는 학생 → 언제나 열림.
//   2) 제출하는 순간 잠김 — 유예 기간 없음.
//   3) 관리자가 그 학생을 골라 활성화하면(schedule_grant, 1회용) 다시 열림. 그 학생이 제출하면
//      활성화가 소진되어 다시 잠긴다.
// "언제 열리는지/언제까지 열려있는지" 같은 기간 안내는 더 이상 없다 — 열림/잠김 두 상태뿐.

export type EditReason = "first" | "grant";

export type EditState = { open: true; reason: EditReason } | { open: false; reason: "locked" };

export type EditFacts = {
  /** 이 학생의 첫 제출 시각. 한 번도 제출한 적 없으면 null. */
  firstSubmittedAt: Date | null;
  /** 이 학생에게 아직 소진되지 않은(consumed_at is null) 관리자 활성화가 있는지. */
  hasActiveGrant: boolean;
};

export function evaluateEdit(facts: EditFacts): EditState {
  if (facts.firstSubmittedAt == null) return { open: true, reason: "first" };
  if (facts.hasActiveGrant) return { open: true, reason: "grant" };
  return { open: false, reason: "locked" };
}
