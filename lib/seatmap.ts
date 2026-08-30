// 좌석 지오메트리 공용 상수 — FloorEditor.tsx(:38,:40)·PatrolBoard.tsx(:17)에 복붙돼 있던 값의 공용판.
// (FloorEditor는 병렬 리팩터 중이라 건드리지 않고, 신규 화면부터 이 모듈을 쓴다.)
export const SW = 82;        // 좌석 폭
export const SH = 60;        // 좌석 높이
export const CELL_X = 100;   // 격자 셀 가로
export const CELL_Y = 80;    // 격자 셀 세로
export const ORIGIN = 40;    // 방 원점 여백
export const PER_ROW = 6;    // grid 좌표 없는 좌석의 기본 줄바꿈

export type SeatXY = { grid_x: number | null; grid_y: number | null };

/** 좌석의 px 좌표 — grid 좌표 없으면 인덱스 기반 기본 배치(PatrolBoard와 동일 규칙). */
export function xyOf(s: SeatXY, i: number): { x: number; y: number } {
  return {
    x: s.grid_x == null ? ORIGIN + (i % PER_ROW) * CELL_X : s.grid_x,
    y: s.grid_y == null ? ORIGIN + Math.floor(i / PER_ROW) * CELL_Y : s.grid_y,
  };
}

/** 방 콘텐츠 크기(fit 계산용) — 좌석들의 우하단 끝 + 여백. */
export function boundsOf(pts: { x: number; y: number }[]): { w: number; h: number } {
  if (!pts.length) return { w: 260, h: 160 };
  return {
    w: Math.max(...pts.map((p) => p.x + SW)) + 32,
    h: Math.max(...pts.map((p) => p.y + SH)) + 32,
  };
}
