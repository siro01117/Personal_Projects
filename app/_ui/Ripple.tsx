"use client";

// 누른 자리에서 퍼지는 물결 (목업과 같다: .btn · .iconbtn · .tile)

import { useEffect } from "react";
import { rectCss, toCss } from "../_logic/zoom";

export function Ripple() {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = (e.target as Element | null)?.closest?.(".btn,.iconbtn,.tile:not(.is-later)");
      if (!t || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const r = rectCss(t);
      const z = Math.max(r.width, r.height);
      const d = document.createElement("span");
      d.className = "rp";
      d.style.width = d.style.height = `${z}px`;
      d.style.left = `${toCss(e.clientX) - r.left - z / 2}px`;
      d.style.top = `${toCss(e.clientY) - r.top - z / 2}px`;
      t.appendChild(d);
      setTimeout(() => d.remove(), 520);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
  return null;
}
