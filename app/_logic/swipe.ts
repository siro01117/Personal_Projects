// 좌우 밀기의 판정 (docs/모션.md). 화면 없이 계산만 — 방향 의도 · 속도 · 넘길지 · 길이.

/** 방향을 정하기 전에 움직여야 하는 거리(px) */
export const SLOP = 8;
/** 가로로 보려면 가로가 세로의 이 배보다 커야 한다 */
export const X_BIAS = 1.2;
/** 넘김으로 치는 끌린 거리 (폭의 비율) */
export const COMMIT_RATIO = 0.25;
/** 넘김으로 치는 속도 (px/ms) */
export const FLING = 0.35;
/** 속도를 재는 구간 (ms) */
export const VELOCITY_WINDOW = 100;

export type Axis = "x" | "y";
export type Sample = { t: number; x: number };

/** 처음 움직임의 방향. 아직 모자라면 null */
export function intent(dx: number, dy: number, slop = SLOP): Axis | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < slop) return null;
  return ax > ay * X_BIAS ? "x" : "y";
}

/** 마지막 구간의 가로 속도 (px/ms, 왼쪽이 음수). 표본이 모자라면 0 */
export function velocity(samples: readonly Sample[], window = VELOCITY_WINDOW): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i]!;
    if (last.t - s.t > window) break;
    first = s;
  }
  const dt = last.t - first.t;
  return dt <= 0 ? 0 : (last.x - first.x) / dt;
}

/**
 * 놓았을 때 넘길지. 1 = 다음(왼쪽으로 밂), -1 = 이전, 0 = 제자리.
 * 빠르게 튕기면 거리가 짧아도 넘기고, 끌린 쪽과 반대로 튕기면 취소한다.
 */
export function decide(dx: number, vx: number, width: number): -1 | 0 | 1 {
  if (width <= 0) return 0;
  if (Math.abs(vx) >= FLING) {
    if (dx !== 0 && Math.sign(vx) !== Math.sign(dx)) return 0;
    return vx < 0 ? 1 : -1;
  }
  if (Math.abs(dx) >= width * COMMIT_RATIO) return dx < 0 ? 1 : -1;
  return 0;
}

/** 남은 거리에 맞춘 길이 (ms). 멀수록 길게, min~max 사이 */
export function slideMs(distance: number, width: number, min = 140, max = 240): number {
  if (width <= 0) return min;
  const r = Math.min(1, Math.abs(distance) / width);
  return Math.round(min + (max - min) * r);
}
