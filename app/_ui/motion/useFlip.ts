"use client";

// 목록 재배치 (FLIP, docs/모션.md). 커밋마다 줄의 자리를 재서
//  - 자리가 바뀐 줄은 옛 자리에서 새 자리로 미끄러지고
//  - 새로 생긴 줄은 살짝 내려오며 나타나고
//  - 사라진 줄은 복제가 제자리에서 흐려진다(데이터는 이미 지워졌다).
// Web Animations 로 transform · opacity 만 — 줄은 움직이는 중에도 눌린다. 진행 중이던 것은 지금 자리에서 이어 간다.
// 자리는 모두 CSS px 로 잰다(rectCss) — transform · left/top · scrollTop 과 같은 단위라 넓은 화면 확대(zoom) 아래에서도 거리가 맞는다.
// 줄은 data-flip 또는 data-id 로 구분한다. [data-flip-skip] 안의 줄은 등장 · 퇴장을 하지 않는다(접기/펴기가 대신 한다).

import { useLayoutEffect, useRef, type RefObject } from "react";
import { rectCss, type Rect } from "../../_logic/zoom";
import { EASE, EASE_IN, MS, reducedMotion } from "./motion";

type Rec = { el: HTMLElement; x: number; y: number; w: number; h: number; parent: HTMLElement | null; skip: boolean };

/** 한 번에 이보다 많이 사라지면(목록이 통째로 바뀜) 복제를 만들지 않는다 */
const GHOST_MAX = 12;

export type FlipOptions = {
  /** 사라지는 줄의 복제가 붙기 직전. true 를 돌려주면 잠깐 머물렀다 흐려진다 */
  onGhost?: (ghost: HTMLElement, id: string) => boolean | void;
  /** 있으면 true 를 돌려준 커밋에서만 움직인다. 자리는 매번 잰다 — 순서가 바뀔 때만 움직이고 싶은 목록(보고서 블록)용 */
  when?: () => boolean;
};

export function useFlip(container: RefObject<HTMLElement | null>, selector: string, options?: FlipOptions): void {
  const prev = useRef<Map<string, Rec> | null>(null);
  const lastWidth = useRef(0);
  const running = useRef(new WeakMap<HTMLElement, Animation>());
  const opts = useRef(options);
  opts.current = options;

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) {
      prev.current = null;
      return;
    }
    const els = [...root.querySelectorAll<HTMLElement>(selector)];
    const still = reducedMotion() || typeof root.animate !== "function";
    const rr = rectCss(root);
    const ox = rr.left - root.scrollLeft;
    const oy = rr.top - root.scrollTop;

    // 움직이던 줄: 지금 보이는 자리와 놓인 자리의 차이를 읽고 끊는다
    const flying = new Map<HTMLElement, { dx: number; dy: number }>();
    const cut: { el: HTMLElement; a: Animation; r: Rect }[] = [];
    for (const el of els) {
      const a = running.current.get(el);
      if (a && a.playState === "running") cut.push({ el, a, r: rectCss(el) });
    }
    for (const c of cut) c.a.cancel();

    const next = new Map<string, Rec>();
    for (const el of els) {
      const id = el.dataset.flip ?? el.dataset.id;
      if (!id) continue;
      const r = rectCss(el);
      next.set(id, { el, x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, parent: el.parentElement, skip: el.closest("[data-flip-skip]") !== null });
    }
    for (const c of cut) {
      const r = rectCss(c.el);
      flying.set(c.el, { dx: c.r.left - r.left, dy: c.r.top - r.top });
    }

    const before = prev.current;
    const resized = Math.abs(rr.width - lastWidth.current) > 0.5;
    prev.current = next;
    lastWidth.current = rr.width;
    if (!before || still || resized) return;
    if (opts.current?.when && !opts.current.when()) return;

    const byEl = new Map<HTMLElement, Rec>();
    for (const rec of before.values()) byEl.set(rec.el, rec);
    const gone: Rec[] = [];
    const goneId = new Map<Rec, string>();
    for (const [id, rec] of before) {
      if (!next.has(id) && !rec.el.isConnected) {
        gone.push(rec);
        goneId.set(rec, id);
      }
    }

    for (const [id, now] of next) {
      const was = before.get(id) ?? byEl.get(now.el);
      if (was) {
        const f = flying.get(now.el);
        const dx = was.x + (f?.dx ?? 0) - now.x;
        const dy = was.y + (f?.dy ?? 0) - now.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        const a = now.el.animate([{ transform: `translate3d(${dx}px,${dy}px,0)` }, { transform: "translate3d(0,0,0)" }], { duration: MS.base, easing: EASE });
        running.current.set(now.el, a);
        continue;
      }
      // 임시 id 가 진짜 id 로 바뀐 것: 같은 자리에서 사라지고 생겼다 — 아무것도 하지 않는다
      const twin = gone.findIndex((g) => Math.abs(g.x - now.x) < 2 && Math.abs(g.y - now.y) < 2);
      if (twin >= 0) {
        gone.splice(twin, 1);
        continue;
      }
      if (now.skip) continue;
      const a = now.el.animate(
        [
          { opacity: 0, transform: "translate3d(0,-6px,0)" },
          { opacity: 1, transform: "translate3d(0,0,0)" },
        ],
        { duration: MS.base, easing: EASE },
      );
      running.current.set(now.el, a);
    }

    if (gone.length > GHOST_MAX) return;
    for (const rec of gone) {
      if (rec.skip) continue;
      const host = rec.parent?.isConnected ? rec.parent : root;
      if (getComputedStyle(host).position === "static") continue;
      const hr = rectCss(host);
      const g = rec.el.cloneNode(true) as HTMLElement;
      g.removeAttribute("data-id");
      g.removeAttribute("data-flip");
      g.removeAttribute("id");
      g.setAttribute("data-ghost", "");
      g.setAttribute("aria-hidden", "true");
      g.inert = true;
      Object.assign(g.style, {
        position: "absolute",
        left: `${rec.x + ox - hr.left - host.clientLeft + host.scrollLeft}px`,
        top: `${rec.y + oy - hr.top - host.clientTop + host.scrollTop}px`,
        width: `${rec.w}px`,
        height: `${rec.h}px`,
        margin: "0",
        boxSizing: "border-box",
        pointerEvents: "none",
      });
      const hold = opts.current?.onGhost?.(g, goneId.get(rec) ?? "") === true;
      host.appendChild(g);
      const ms = hold ? MS.slow : MS.fast;
      const done = () => g.remove();
      g.animate(hold ? [{ opacity: 1 }, { opacity: 1, offset: 0.45 }, { opacity: 0 }] : [{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: EASE_IN, fill: "forwards" }).onfinish = done;
      setTimeout(done, ms + 80);
    }
  });
}
