// 모션 공용 값과 작은 도구 (docs/모션.md). 값은 globals.css 의 --m-* · --ease-out 과 같다.

export const EASE = "cubic-bezier(.2,.8,.2,1)";
export const EASE_IN = "cubic-bezier(.4,0,1,1)";
export const MS = { fast: 140, base: 180, slow: 240 } as const;

/** 움직임 줄이기 설정이면 JS 로 움직이는 것도 전부 끈다 */
export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const sliding = new WeakMap<Element, Animation>();

/**
 * 방향대로 짧게 미끄러져 들어온다 (dir 1 = 다음: 오른쪽에서, -1 = 이전: 왼쪽에서).
 * 진행 중이던 것은 끊고 새로 시작한다. 조작은 막지 않는다.
 */
export function slideIn(els: Iterable<Element>, dir: 1 | -1, px = 28, ms: number = MS.base): void {
  if (reducedMotion()) return;
  for (const el of els) {
    if (typeof el.animate !== "function") return;
    sliding.get(el)?.cancel();
    const a = el.animate(
      [
        { transform: `translate3d(${dir * px}px,0,0)`, opacity: 0 },
        { transform: "translate3d(0,0,0)", opacity: 1 },
      ],
      { duration: ms, easing: EASE },
    );
    sliding.set(el, a);
  }
}

/**
 * 곧 지워질 요소의 복제를 제자리에 두고 흐리게 내보낸다 (데이터는 기다리지 않고 바로 지운다).
 * 요소가 absolute 로 놓여 있어야 한다 (일정 블록).
 */
export function ghostOut(el: HTMLElement | null, ms: number = MS.fast): void {
  if (!el || !el.parentElement || reducedMotion() || typeof el.animate !== "function") return;
  const g = el.cloneNode(true) as HTMLElement;
  g.removeAttribute("data-key");
  g.removeAttribute("tabindex");
  g.setAttribute("data-ghost", "");
  g.setAttribute("aria-hidden", "true");
  g.inert = true;
  g.style.pointerEvents = "none";
  el.parentElement.appendChild(g);
  const done = () => g.remove();
  g.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(.96)" }], { duration: ms, easing: EASE_IN, fill: "forwards" }).onfinish = done;
  setTimeout(done, ms + 80);
}
