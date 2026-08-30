// 출결 일일 상태(결석 사유 등). attendance 테이블의 status/reason 에 대응.
// 'use client' 아님 → 서버 액션·클라 공용.

// 결석 사유 프리셋. 무단결석은 벌점 프리셋(penalty.ts absent=3)과 별개 —
// 결석 상태는 출결 기록이고, 벌점은 필요 시 벌점 모듈에서 따로 부여한다.
export const ABSENCE_REASONS: { key: string; label: string }[] = [
  { key: "sick",      label: "병결" },
  { key: "excused",   label: "사유결" },
  { key: "unexcused", label: "무단결석" },
  { key: "etc",       label: "기타" },
];

export const ABSENCE_BY_KEY: Record<string, string> = Object.fromEntries(
  ABSENCE_REASONS.map((r) => [r.key, r.label]),
);

// 결석 사유 라벨. 프리셋 키면 라벨로, 아니면(직접 입력) 그대로.
export function absenceReasonLabel(reason: string | null): string {
  if (!reason) return "";
  return ABSENCE_BY_KEY[reason] ?? reason;
}

// 좌석 배치도 퇴실 확인창 사유 프리셋(src/lib/schedule.ts checkoutBranchOf 와 짝). 라벨을 그대로
// attendance_event.note 에 저장하므로 key 없이 라벨 배열만 둔다 — "기타"만 자유 입력칸을 연다.
export const CHECKOUT_REASON_PRESETS = ["조퇴(사유 있음)", "병원", "학원 추가 일정", "귀가", "무단 이탈", "기타"] as const;
export const CHECKOUT_OTHER_REASON = "기타";

// 퇴실 사유별 색 — 어떤 사유가 어떤 의미색인지의 매핑만 여기 둔다(색 자체는 semantic-color.ts SEMANTIC
// 이 유일한 정의처 — 화면에서 새 헥스를 추가하지 않는 원칙과 동일하게 이 파일도 SemanticKey 만 참조한다).
// 무단 이탈만 경고색(distract, 빨강주황)으로 눈에 띄게, 나머지는 채도 낮은 프리셋 중 사유 성격에 맞는 hue.
export const CHECKOUT_REASON_KEY: Record<(typeof CHECKOUT_REASON_PRESETS)[number], import("./semantic-color").SemanticKey> = {
  "조퇴(사유 있음)": "counsel",     // 개인 사유 조율 — 상담과 같은 톤(자주)
  "병원": "away",                  // 자리를 비우는 외부 사유 — away(금색)
  "학원 추가 일정": "academy",     // 외부 학원과 의미가 그대로 같음 — academy(파랑)
  "귀가": "leaveHome",             // 정상 하원 — 전용 슬레이트 블루그레이
  "무단 이탈": "distract",         // 경고색 — 눈에 띄게
  "기타": "none",                  // 무채색
};
