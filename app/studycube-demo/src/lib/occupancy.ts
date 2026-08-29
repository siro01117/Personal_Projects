// 좌석 배치도의 "지금 재실/부재" 판정 — 오늘 그 학생의 마지막 순찰 기록(patrol_event)과
// 마지막 출결 기록(attendance_event) 중 시각이 더 늦은 쪽을 따른다. 시각이 같으면 사람이 직접
// 누른 수동 기록(attendance_event)을 우선한다.
// /m/seat(FloorEditor)와 /seat(MobileSeat) 두 화면이 이 로직을 공유해 판정이 갈리지 않게 한다.
// 서버(page.tsx)에서만 호출 — Date.parse 로 절대 시각을 비교하고, title 은 timeLabel 로 미리
// 포맷해 내려준다(클라 렌더에서 new Date()/toLocale* 호출 금지 원칙 준수).
//
// 퇴실 사유(reason) — 출결 기록으로 "퇴실"이 확정된 경우에만 계산한다(우선순위):
//  1) attendance_event.note(수동 퇴실 시 입력한 사유)가 있으면 그대로.
//  2) 없으면 퇴실 시각(KST 분) 기준으로 그 학생의 오늘 스케쥴(scheduleMap — page.tsx 가 이미 조회해
//     둔 것을 그대로 받는다, 새 쿼리 없음)에 그 시각을 덮는 "원 밖" 일정(외부 학원/외부 일정 등 —
//     원내 수업·주간 상담 제외)이 있으면 그 사유를 추정치로 사용(reasonEstimated=true).
//  3) 둘 다 없으면 reason=null(화면에 아무것도 안 보여줌).
// 순찰 기록으로 재실/부재가 결정된 경우(위 분기)는 그 자체로 사유 라벨(예: "학원")이 title 에 이미
// 담기므로 이 계산을 하지 않는다(범위 밖).
import { PATROL_BY_KEY } from "./patrol";
import { timeLabel, minuteOfKST } from "./date";
import type { DaySlot, CheckoutBranch } from "./schedule";

export type OccKind = "in" | "out";
export type SeatOcc = { kind: OccKind; title: string; reason?: string | null; reasonEstimated?: boolean };

export type LastAttRow = { student_id: string; kind: string; at: string; auto: boolean; note?: string | null };
export type LastPatrolRow = { student_id: string; state: string | null; at: string | null };
export type OccScheduleInfo = { hours: { arrive_min: number; leave_min: number } | null; slots: DaySlot[] };

// "원 내부" 사유(자리를 비운 게 아니라 원 안에서 하는 활동) — 이 둘은 "퇴실 추정 사유"에서 제외한다.
// schedule.ts checkoutBranchOf() 의 inside/outside 분류와 같은 기준.
const INSIDE_REASONS = new Set(["원내 수업", "주간 상담"]);

/** 퇴실 시각(KST 분)에 그 학생의 오늘 스케쥴 슬롯 중 걸쳐 있는 "원 밖" 일정의 사유. 없으면 null. */
function outsideScheduleReasonAt(minute: number, slots: DaySlot[]): string | null {
  const hit = slots.find((s) => minute >= s.start && minute < s.end);
  if (!hit || INSIDE_REASONS.has(hit.reason)) return null;
  return hit.reason;
}

export function buildOccupancy(
  attRows: LastAttRow[],
  patrolRows: LastPatrolRow[],
  scheduleMap: Record<string, OccScheduleInfo> = {},
): Record<string, SeatOcc> {
  const attMap = new Map(attRows.map((r) => [r.student_id, r]));
  const patMap = new Map(patrolRows.map((r) => [r.student_id, r]));
  const ids = new Set<string>([...attMap.keys(), ...patMap.keys()]);
  const occ: Record<string, SeatOcc> = {};
  for (const sid of ids) {
    const a = attMap.get(sid);
    const p = patMap.get(sid);
    const aMs = a ? Date.parse(a.at) : -Infinity;
    const pMs = p?.at ? Date.parse(p.at) : -Infinity;
    if (p?.at && pMs > aMs) {
      // 순찰이 더 최신 — 순찰 프리셋의 asIn 으로 재실/부재 간주
      const cfg = p.state ? PATROL_BY_KEY[p.state] : undefined;
      const asIn = cfg?.asIn ?? true;
      occ[sid] = {
        kind: asIn ? "in" : "out",
        title: `순찰 ${timeLabel(p.at)} · ${cfg?.label ?? p.state} · ${asIn ? "입실 간주" : "퇴실 간주"}`,
      };
    } else if (a) {
      // 출결이 더 최신이거나(또는 동시각), 순찰 기록이 아예 없음
      const kind: OccKind = a.kind === "in" ? "in" : "out";
      let reason: string | null = null;
      let reasonEstimated = false;
      let noteSuffix = "";
      if (kind === "out") {
        if (a.note) {
          reason = a.note;
          noteSuffix = ` · ${a.note}`;
        } else {
          const est = outsideScheduleReasonAt(minuteOfKST(a.at), scheduleMap[sid]?.slots ?? []);
          if (est) {
            reason = est;
            reasonEstimated = true;
            noteSuffix = ` · ${est}(스케쥴 추정)`;
          }
        }
      } else if (a.note) {
        noteSuffix = ` · ${a.note}`; // kind==="in" 은 checkIn() 이 note 를 넘기지 않아 실제로는 발생하지 않음(안전망)
      }
      occ[sid] = {
        kind,
        title: `${a.auto ? "자동" : "수동"} ${timeLabel(a.at)} · ${kind === "in" ? "입실" : "퇴실"}${noteSuffix}`,
        reason,
        reasonEstimated,
      };
    }
  }
  return occ;
}

// ---------------- 좌석 배치도 "확인 필요" ----------------
// 스케쥴상 지금 원 안에 있어야 하는데(자습, 또는 원내 사유 일정 — 쉬는시간 제외) 오늘 출결·순찰 기록이
// 전혀 없는 학생 = 아무도 상태를 확인하지 않은 학생. branch 는 호출부(FloorEditor.tsx/MobileSeat.tsx)가
// 이미 계산해 둔 checkoutBranchAt() 결과(스케쥴·자정 넘김 판정을 그대로 재사용, 새 판정 로직 없음)를
// 그대로 받는다 — kind==="inside" 는 study(자습)/scheduled 원내 사유(원내 수업·주간 상담)/break(쉬는시간)
// 셋을 묶은 값이라, label 로 쉬는시간만 걸러낸다(교시 사이엔 자리를 비울 수 있어 확인 대상이 아님 —
// isPatrolExempt() 의 break 제외 규칙과 같은 취지).
// occ 는 buildOccupancy() 결과 그 학생의 엔트리 — attMap∪patMap 어디에도 없으면 엔트리 자체가 없으므로
// occ 부재만으로 "오늘 출결·순찰 기록이 전혀 없음"이 확인된다.
export function needsAttentionCheck(branch: CheckoutBranch, occ: SeatOcc | undefined): boolean {
  if (occ) return false;
  return branch.kind === "inside" && branch.label !== "쉬는시간";
}
