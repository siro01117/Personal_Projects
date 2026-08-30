// "자석 포커스" 스크롤 — 학생이 뭔가를 고르면 다음에 볼 영역을 화면 중앙으로 부드럽게 스크롤하고,
// 그 안 첫 입력에 포커스를 준다. 접힌 밑단(below the fold)에 새로 나타난 영역을 놓치는 문제 방지용.
// 렌더 중에는 절대 DOM 을 건드리지 않는다 — 전부 useEffect(또는 그 안에서 호출) 안에서만 실행된다.
import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = "input, select, textarea, button:not([disabled])";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** el 이 뷰포트 안에 이미 충분히(높이 기준 70% 이상) 보이는지. */
function isSufficientlyVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.height <= 0) return false;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const visibleTop = Math.max(rect.top, 0);
  const visibleBottom = Math.min(rect.bottom, viewportHeight);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  return visibleHeight / rect.height >= 0.7;
}

/** el 안에서 DOM 순서상 첫 포커스 가능 요소를 찾는다. */
function firstFocusable(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
}

/** el 을 화면 중앙으로 부드럽게 스크롤하고(이미 충분히 보이면 생략), 필요하면 첫 입력에 포커스한다. */
export function scrollFocus(el: HTMLElement | null, opts?: { focus?: boolean }): void {
  if (typeof window === "undefined" || !el) return;

  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  if (!isSufficientlyVisible(el)) {
    el.scrollIntoView({ behavior, block: "center" });
  }

  const shouldFocus = opts?.focus !== false;
  if (!shouldFocus) return;
  if (el.contains(document.activeElement)) return;

  const target = firstFocusable(el);
  if (!target) return;
  target.focus();

  // 모바일 온스크린 키보드가 뜨면서 레이아웃이 밀리는 걸 보정하기 위해 한 번 더 스크롤한다.
  requestAnimationFrame(() => {
    el.scrollIntoView({ behavior, block: "center" });
  });
}

/** ref.current 가 가리키는 요소로 deps 변경 시마다 scrollFocus 를 호출한다. 마운트 직후 첫 실행은 건너뛴다
 * (첫 렌더에서 화면이 튀지 않도록). */
export function useScrollFocusOn(
  ref: React.RefObject<HTMLElement | null>,
  deps: unknown[],
  opts?: { focus?: boolean },
): void {
  const didMount = useRef(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    scrollFocus(ref.current, opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
