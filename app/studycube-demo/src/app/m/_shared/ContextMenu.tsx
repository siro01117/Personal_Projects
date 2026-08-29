"use client";

// 데스크톱식 우클릭 컨텍스트 메뉴. 커서 위치에 뜨고 뷰포트 밖으로 안 넘치게 보정.
// 바깥 클릭 · Esc · 스크롤 · 리사이즈 시 닫힘. 항목 클릭 시에도 닫힘.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  dot?: string;    // 앞에 붙는 색 점 (순찰 상태 등)
  right?: string;  // 오른쪽 보조 텍스트 (벌점 +2 등)
};

export default function ContextMenu({
  x, y, items, header, onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  header?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });

  // 마운트 후 실제 크기 재서 뷰포트 안으로 클램프
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    let left = x, top = y;
    if (left + width > window.innerWidth - pad) left = window.innerWidth - width - pad;
    if (top + height > window.innerHeight - pad) top = window.innerHeight - height - pad;
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top), ready: true });
  }, [x, y, items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <>
      {/* 바깥 클릭 캡처 (우클릭도 닫기) */}
      <div
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        style={{ position: "fixed", inset: 0, zIndex: 80 }}
      />
      <div
        ref={ref}
        style={{
          position: "fixed", left: pos.left, top: pos.top, zIndex: 81, minWidth: 188,
          background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12,
          boxShadow: "0 12px 34px rgba(20,22,30,.28)", padding: 6,
          visibility: pos.ready ? "visible" : "hidden",
        }}
      >
        {header && (
          <div style={{ padding: "5px 10px 8px", fontSize: 11.5, color: "var(--faint)", fontWeight: 700, borderBottom: "1px solid var(--line)", marginBottom: 4, whiteSpace: "nowrap" }}>
            {header}
          </div>
        )}
        {items.map((it, i) =>
          it.separator ? (
            <div key={i} style={{ height: 1, background: "var(--line)", margin: "4px 2px" }} />
          ) : (
            <button
              key={i}
              disabled={it.disabled}
              onClick={() => { if (it.disabled) return; it.onClick?.(); onClose(); }}
              onMouseEnter={(e) => { if (!it.disabled) (e.currentTarget as HTMLButtonElement).style.background = "var(--panel2)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px",
                border: "none", background: "transparent", borderRadius: 8,
                cursor: it.disabled ? "default" : "pointer", textAlign: "left",
                fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap",
                color: it.disabled ? "var(--faint)" : it.danger ? "var(--danger)" : "var(--ink)",
              }}
            >
              {it.dot && <span style={{ width: 9, height: 9, borderRadius: "50%", background: it.dot, flexShrink: 0 }} />}
              <span>{it.label}</span>
              {it.right && <span style={{ marginLeft: "auto", paddingLeft: 12, fontSize: 12, fontWeight: 700, color: "var(--danger)" }}>{it.right}</span>}
            </button>
          ),
        )}
      </div>
    </>
  );
}
