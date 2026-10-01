// 지점 표시 = 색. 아이콘은 쓰지 않는다 (색과 아이콘을 같이 쓰면 이중 표시 — 2026-10-01 결정).
// 색 바탕이 있는 곳(일정 블록)에는 아무것도 덧붙이지 않고, 색 바탕이 없는 곳(플래너 줄 · 지점 칩 · 상세 머리)에만 이 점을 둔다.
// 색은 부모의 pc-<색> 클래스가 정한 --pc-ink.

export function PlaceDot({ className }: { className?: string }) {
  return <span className={className ? `pdot ${className}` : "pdot"} aria-hidden="true" />;
}
