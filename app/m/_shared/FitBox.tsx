"use client";

// 고정 크기 캔버스(좌석맵 등)를 부모 폭에 맞춰 축소해 보여주는 래퍼.
// 좌석 절대배치(654~680px)가 폰 화면(≈300px)을 넘치는 문제를 좌표 로직 수정 없이 해결한다.
// - 넘칠 때만 축소(확대는 안 함, max=1) → 데스크톱·패드는 지금과 동일한 크기 유지.
// - transform: scale 사용(CSS zoom 금지 — 클릭 좌표계가 어긋남).
import { useEffect, useRef, useState } from "react";

export default function FitBox({ w, h, children }: { w: number; h: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const avail = el.clientWidth;
      setScale(avail > 0 && w > avail ? avail / w : 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w]);

  return (
    <div ref={ref} style={{ width: "100%", height: h * scale, overflow: "hidden" }}>
      <div style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "0 0" }}>{children}</div>
    </div>
  );
}
