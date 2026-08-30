// 의미색 단일 출처 — "예정된 행위"(스케쥴 고스트·블록)와 "실제 찍은 상태"(순찰 마크)가
// 같은 의미면 같은 hue 를 쓰도록 여기서만 기준색을 정의한다. 순찰(src/lib/patrol.ts)과
// 스케쥴(src/lib/schedule.ts), 퇴실 사유(src/lib/attendance.ts CHECKOUT_REASON_KEY) 양쪽이
// 이 파일의 SEMANTIC 만 참조하고, 화면(FloorEditor 등)은 그 lib 들이 계산해 내려주는 값을
// 그대로 쓴다 — 화면에 새 헥스 색을 추가하지 않는다.
//
// 농도 규칙(모든 화면 공통, README 삼아 여기 적어둔다):
//   solid(key)     실제로 확정된 값(순찰 마크 dot·글자) — 기준색 그대로, 가장 진함.
//   tint(key,pct)  옅은 배경 채움 — 스케쥴 확정 블록은 기본 16%, 순찰 마크 배경은 더 진하게 24% 정도로 호출.
//   ghostTint(key,pct) 더 옅은 배경 — 아직 확정 안 된 예상(순찰 고스트) 표시, 기본 12%.
//   ink(key)       옅은 배경 위에서도 대비가 나오는 어두운 글자색(검정을 78% 섞음).
//   line(key,pct)  테두리·스트립 — 기본은 기준색 그대로(100%), 더 옅게 쓰려면 pct 를 낮춘다.
// 순수 함수 — DOM 의존 없음(문자열만 반환, color-mix 는 브라우저가 렌더링 시점에 계산).

export const SEMANTIC = {
  present:  "#12b886", // 자리에 있음: 순찰 '입석', 스케쥴 '자습' — 기존 --ok 와 같은 초록(가장 흔한 상태라 브랜드 기본색 재사용)
  academy:  "#4b88dd", // 외부 학원: 순찰 '학원', 스케쥴 '외부 학원' — 파랑
  inClass:  "#835cc1", // 원내 수업 — 보라(academy 와 다른 hue — 이전엔 kind=academy 로 묶여 구분이 안 됐던 부분)
  counsel:  "#ae4798", // 상담: 순찰 '상담', 스케쥴 '주간 상담' — 자주/마젠타
  away:     "#c1aa15", // 자리비움 / 외부 일정 — 금색(danger·warn 과 겹치지 않는 hue)
  late:     "#e27a12", // 지각 — 주황
  sleep:    "#e1474e", // 수면 — 빨강
  distract: "#f1481e", // 딴짓 — 빨강주황(sleep 과는 톤을 다르게 눌러 구분)
  none:     "var(--faint)", // 등원전 / 하원 / 기타 — 무채색(디자인 토큰 그대로 사용)
  leaveHome: "#5c6f8e", // 정상 귀가 — 위 색들과 겹치지 않는 슬레이트 블루그레이(퇴실 사유 버튼 전용, 차분한 톤)
} as const;

export type SemanticKey = keyof typeof SEMANTIC;

/** 실제로 확정된 값에 쓰는 순색(pure color) — 순찰 마크의 점·글자색 등. */
export function solid(key: SemanticKey): string {
  return SEMANTIC[key];
}

/** 옅은 배경 채움. pct 는 기준색을 섞는 비율(%) — 기본 16(스케쥴 확정 블록 기준),
 * 순찰 마크처럼 "채워진 느낌"이 더 필요하면 호출부에서 20~26 정도로 올려 쓴다. */
export function tint(key: SemanticKey, pct = 16): string {
  return `color-mix(in srgb, ${SEMANTIC[key]} ${pct}%, var(--card))`;
}

/** tint 보다 한 단계 더 옅은 배경 — 아직 확정 안 된 예상(고스트)에 쓴다. 기본 12,
 * 가장 흔한 자습/입석은 호출부에서 더 낮은 pct(예: 4~5)를 넘겨 "가장 옅게" 만든다. */
export function ghostTint(key: SemanticKey, pct = 12): string {
  return `color-mix(in srgb, ${SEMANTIC[key]} ${pct}%, var(--card))`;
}

/** 옅은 배경 위에서도 대비가 나오는 어두운 글자색(검정을 섞어 눌러줌). */
export function ink(key: SemanticKey): string {
  return `color-mix(in srgb, ${SEMANTIC[key]} 78%, black)`;
}

/** 테두리·좌측 스트립 색. 기본은 기준색 그대로(100%) — 더 옅게 쓰려면 pct 를 낮춰 호출한다. */
export function line(key: SemanticKey, pct = 100): string {
  return `color-mix(in srgb, ${SEMANTIC[key]} ${pct}%, transparent)`;
}
