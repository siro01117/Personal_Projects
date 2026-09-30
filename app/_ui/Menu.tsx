"use client";

// 우클릭·길게 누르기 메뉴 (목업 .menu). 화면 밖으로 넘치지 않게 자리를 잡고, 바깥을 누르거나 스크롤·Esc 면 닫힌다.

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type MenuEntry =
  | { kind: "item"; icon: IconName; label: string; danger?: boolean; run: () => void; keep?: boolean }
  | { kind: "sep" }
  | { kind: "head"; label: string };

export function Menu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
    el.querySelector<HTMLButtonElement>("button")?.focus();
  }, [x, y, entries]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const scroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", down, true);
    addEventListener("scroll", scroll, true);
    addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      removeEventListener("scroll", scroll, true);
      removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const n = buttons.length;
      if (!n) return;
      const next = i < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      buttons[next]?.focus();
    } else if (e.key === "Tab") {
      onClose();
    }
  };

  const body: ReactNode[] = entries.map((m, i) => {
    if (m.kind === "sep") return <hr key={i} />;
    if (m.kind === "head") return <div className="h" key={i}>{m.label}</div>;
    return (
      <button
        type="button"
        role="menuitem"
        key={i}
        className={m.danger ? "danger" : undefined}
        title={m.label}
        onClick={() => {
          if (!m.keep) onClose();
          m.run();
        }}
      >
        <Icon name={m.icon} />
        {m.label}
      </button>
    );
  });

  return (
    <div className="menu" role="menu" ref={ref} style={{ left: x, top: y }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      {body}
    </div>
  );
}
