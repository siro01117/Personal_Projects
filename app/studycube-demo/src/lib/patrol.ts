// 순찰 상태 프리셋 (정적 우선 원칙 — 코드 상수로 고정, 바꿀 일 생기면 여기 숫자만 수정).
// 'use client' 아님 → 서버 액션/페이지·클라 컴포넌트 공용.
// 색은 여기서 직접 정의하지 않고 src/lib/semantic-color.ts 의 SEMANTIC 을 끌어온다 —
// 스케쥴 사유 색(schedule.ts)과 같은 hue 를 쓰기 위한 단일 출처. key/label/points 는 DB 저장값이라
// 절대 바꾸지 않는다(이 파일에서 바뀌는 건 dot/bg/bd 색상 계산뿐).
import { type SemanticKey, solid, tint, line } from "./semantic-color";

export type PatrolKind = "normal" | "excused" | "penalty";

// 순찰 마크(실제로 찍힌 상태) 색 농도 — 스케쥴 쪽(tint 기본 16%, ghostTint 기본 12%)보다
// 진하게 채워 "확인된 것"이 한눈에 보이도록 한다. 테두리도 절반 이상 진하게.
const MARK_BG_PCT = 24;
const MARK_BD_PCT = 60;
function markColors(key: SemanticKey): { dot: string; bg: string; bd: string } {
  return { dot: solid(key), bg: tint(key, MARK_BG_PCT), bd: line(key, MARK_BD_PCT) };
}

export type PatrolState = {
  key: string;      // DB 저장 키 (고정)
  label: string;    // 표시
  points: number;   // 벌점 (0 = 벌점 아님) — 기본값, 필요 시 여기서 조정
  kind: PatrolKind; // normal=정상 / excused=사유있는 이석 / penalty=벌점
  present: boolean; // 순찰 상태선택 시트의 재석/이석 그룹핑용 — 입석·수면·딴짓=true, 지각·자리비움·학원·원내 수업·주간 상담=false
                     // (지각은 "아직 도착 전"이라 이석 그룹). asIn 과 목적이 달라 원내 수업/주간 상담에서 값이 갈린다(지각은 asIn 도 false).
  asIn: boolean;    // 좌석 배치도 재실 판정용(오늘 마지막 순찰 기록 기준) — true=입실 간주(실제로 자리에 있었거나
                     // 원 내부에 있었음), false=퇴실 간주. 입실 간주: 입석·수면·딴짓·원내 수업·주간 상담.
                     // 퇴실 간주: 지각·자리비움·학원(지각은 "아직 도착 전"이라 퇴실 간주 — present 와 달리 원내 수업/주간 상담=true).
  dot: string;      // 상태 점 색
  bg: string;       // 좌석 배경
  bd: string;       // 좌석 테두리
};

// 순서 = 순찰 메뉴에 뜨는 순서. 재석(자리에 있음) 먼저, 그다음 이석(자리 비움).
// 색은 SEMANTIC 기준색에서 파생(markColors) — 스케쥴 사유 색과 같은 hue 를 공유한다:
// seated↔자습(present), in_class↔원내 수업(inClass), academy↔외부 학원(academy), counsel↔주간 상담(counsel), away↔외부 일정(away).
export const PATROL_STATES: PatrolState[] = [
  // ── 재석: 자리에 있음 ──
  { key: "seated",   label: "입석", points: 0, kind: "normal",  present: true,  asIn: true,  ...markColors("present") },
  { key: "sleep",    label: "수면", points: 1, kind: "penalty", present: true,  asIn: true,  ...markColors("sleep") },
  { key: "distract", label: "딴짓", points: 2, kind: "penalty", present: true,  asIn: true,  ...markColors("distract") },
  // ── 이석: 자리 비움(단, 아래 중 in_class·counsel 은 원 내부 활동이라 asIn 은 true) ──
  { key: "late",     label: "지각",     points: 1, kind: "penalty", present: false, asIn: false, ...markColors("late") },     // 늦게 옴(아직 도착 전) — 퇴실 간주
  { key: "away",     label: "자리비움", points: 2, kind: "penalty", present: false, asIn: false, ...markColors("away") },     // 무단이탈 — 퇴실 간주
  { key: "academy",  label: "학원",     points: 0, kind: "excused", present: false, asIn: false, ...markColors("academy") }, // 원 밖 — 퇴실 간주
  { key: "in_class", label: "원내 수업", points: 0, kind: "excused", present: false, asIn: true,  ...markColors("inClass") }, // 원 내부에서 하는 수업 — 학원과 짝이되 원 내부라 입실 간주. counsel 과 인접 배치.
  { key: "counsel",  label: "주간 상담", points: 0, kind: "excused", present: false, asIn: true,  ...markColors("counsel") }, // key는 그대로 counsel(DB 저장값 고정) — 라벨만 변경. 상담도 원 내부이므로 입실 간주
];

export const PATROL_BY_KEY: Record<string, PatrolState> = Object.fromEntries(
  PATROL_STATES.map((s) => [s.key, s]),
);

export function patrolPoints(key: string): number {
  return PATROL_BY_KEY[key]?.points ?? 0;
}
