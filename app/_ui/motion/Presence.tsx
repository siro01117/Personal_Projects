"use client";

// 조건부로 그리던 것이 사라질 때 잠깐 더 그린다 (docs/모션.md). 나가는 동안 data-leaving 이 붙고(CSS 가 나가는 애니메이션을 건다)
// inert + pointer-events:none 이라 뒤의 화면이 바로 눌린다. 상태는 이미 바뀌었고 화면만 뒤따른다.
// 움직임 줄이기면 바로 없앤다. 자식은 요소 하나(또는 없음).

import { cloneElement, useEffect, useReducer, useRef, type ReactElement } from "react";
import { MS, reducedMotion } from "./motion";

export function Presence({ children, ms = MS.fast }: { children: ReactElement | null | false | undefined; ms?: number }) {
  const live = children || null;
  const kept = useRef<ReactElement | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  if (live) kept.current = live;
  const on = live !== null;

  useEffect(() => {
    if (on || !kept.current) return;
    const id = setTimeout(() => {
      kept.current = null;
      redraw();
    }, ms);
    return () => clearTimeout(id);
  }, [on, ms]);

  if (live) return live;
  if (!kept.current) return null;
  if (reducedMotion()) {
    kept.current = null;
    return null;
  }
  return cloneElement(kept.current as ReactElement<Record<string, unknown>>, { "data-leaving": "", inert: true });
}
