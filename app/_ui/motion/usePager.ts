"use client";

// 좌우 밀기 (docs/모션.md). 손가락을 따라 트랙을 옮기고, 놓으면 onStep(±1) 을 바로 부른다.
// 상태는 그 자리에서 바뀌고, 화면은 shift(방향) 으로 한 폭 옆에서 0 으로 미끄러진다 — 끝나기를 기다리는 것이 없다.
// 미끄러지는 중에 다시 잡으면 지금 위치에서 이어 간다. 세로로 판정되면 손을 떼고 스크롤에 맡긴다.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { decide, intent, slideMs, velocity, type Axis, type Sample } from "../../_logic/swipe";
import { EASE, reducedMotion } from "./motion";

export type Pager = {
  /** 밀기를 받는 영역 (ref 로 건다). CSS 로 touch-action: pan-y */
  area: (el: HTMLElement | null) => void;
  /** 옮겨지는 트랙 */
  track: RefObject<HTMLDivElement | null>;
  /** 내용이 dir 쪽으로 바뀐 직후(useLayoutEffect)에 부른다: 새 내용이 한 폭 옆에서 들어온다 */
  shift: (dir: 1 | -1) => void;
};

function offsetOf(t: HTMLElement): number {
  const m = getComputedStyle(t).transform;
  return m && m !== "none" ? new DOMMatrixReadOnly(m).m41 : 0;
}

function rest(t: HTMLElement) {
  t.style.transition = "";
  t.style.transform = "";
  t.style.willChange = "";
  t.ontransitionend = null;
}

function place(t: HTMLElement, x: number) {
  t.style.transition = "none";
  t.style.willChange = "transform";
  t.style.transform = `translate3d(${x}px,0,0)`;
}

/** 지금 자리(from)에서 0 으로 */
function glide(t: HTMLElement, from: number) {
  if (Math.abs(from) < 0.5) {
    rest(t);
    return;
  }
  void t.offsetWidth; // 출발 자리를 확정
  t.style.transition = `transform ${slideMs(from, t.clientWidth)}ms ${EASE}`;
  t.style.transform = "translate3d(0,0,0)";
  t.ontransitionend = (e) => {
    if (e.target === t && e.propertyName === "transform") rest(t);
  };
}

export function usePager(onStep: (n: 1 | -1) => void, onGrab?: () => void): Pager {
  const [area, setArea] = useState<HTMLElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const cb = useRef({ onStep, onGrab });
  cb.current = { onStep, onGrab };

  useEffect(() => {
    if (!area) return;
    let g: { x0: number; y0: number; axis: Axis | null; base: number; samples: Sample[]; still: boolean } | null = null;

    const start = (e: TouchEvent) => {
      const p = e.touches[0];
      if (e.touches.length !== 1 || !p) {
        // 두 손가락이면 밀기를 접는다
        if (g?.axis === "x" && track.current && !g.still) glide(track.current, offsetOf(track.current));
        g = null;
        return;
      }
      g = { x0: p.clientX, y0: p.clientY, axis: null, base: 0, samples: [], still: reducedMotion() };
    };

    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      if (!g || !p) return;
      if (g.axis === null) {
        // 브라우저가 이미 스크롤을 시작했으면 세로
        g.axis = e.cancelable ? intent(p.clientX - g.x0, p.clientY - g.y0) : "y";
        if (g.axis !== "x") return;
        const t = track.current;
        g.base = t && !g.still ? offsetOf(t) : 0;
        g.x0 = p.clientX;
        cb.current.onGrab?.();
      }
      if (g.axis !== "x") return;
      if (e.cancelable) e.preventDefault(); // 가로로 정해지면 세로 스크롤을 잠근다
      g.samples.push({ t: e.timeStamp, x: p.clientX });
      if (g.samples.length > 12) g.samples.shift();
      const t = track.current;
      if (t && !g.still) place(t, g.base + (p.clientX - g.x0));
    };

    const end = (e: TouchEvent) => {
      const cur = g;
      g = null;
      if (!cur || cur.axis !== "x") return;
      const p = e.changedTouches[0];
      const t = track.current;
      const dx = p ? p.clientX - cur.x0 : 0;
      if (p) cur.samples.push({ t: e.timeStamp, x: p.clientX });
      const n = e.type === "touchcancel" ? 0 : decide(dx, velocity(cur.samples), t?.clientWidth ?? area.clientWidth);
      // 일단 제자리로 향한다. 넘김이면 상태가 바뀐 뒤 shift 가 한 폭 옆에서 다시 잡는다
      if (t && !cur.still) glide(t, cur.base + dx);
      if (n !== 0) cb.current.onStep(n);
    };

    area.addEventListener("touchstart", start, { passive: true });
    area.addEventListener("touchmove", move, { passive: false });
    area.addEventListener("touchend", end);
    area.addEventListener("touchcancel", end);
    return () => {
      area.removeEventListener("touchstart", start);
      area.removeEventListener("touchmove", move);
      area.removeEventListener("touchend", end);
      area.removeEventListener("touchcancel", end);
    };
  }, [area]);

  return useMemo<Pager>(
    () => ({
      area: setArea,
      track,
      shift: (dir) => {
        const t = track.current;
        if (!t || reducedMotion()) return;
        const w = t.clientWidth;
        // 옆 칸은 한 폭까지만 그려 둔다 — 빠르게 여러 번 넘겨도 그 안에서 다시 시작
        const x = Math.max(-w, Math.min(w, offsetOf(t) + dir * w));
        place(t, x);
        glide(t, x);
      },
    }),
    [],
  );
}
