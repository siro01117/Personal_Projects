"use client";

// 추가 모듈 선택창 (docs/회원.md 4장): 허용된 모듈마다 이름 + 켜기/끄기. 누르면 바로 저장(낙관적 — 끝냄 체크처럼).
// 데스크톱은 단추 옆 작은 창(바깥 · Esc 로 닫힘), 폰은 아래 시트. 켠 것은 사이드바 · 홈에 생긴다.

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef } from "react";
import { pickable, type Me, type ModuleRow } from "../../lib/members";
import { toCss, toScreen } from "../_logic/zoom";
import { Icon } from "./Icon";
import { Presence } from "./motion/Presence";

export const NO_MODULES = "아직 열린 모듈이 없습니다";

export function ModuleList({ me, onToggle }: { me: Me | null; onToggle: (key: string, on: boolean) => void }) {
  const mods = pickable(me);
  return (
    <>
      <div className="dp-h">
        <h2>추가 모듈</h2>
      </div>
      {mods.length === 0 ? (
        <p className="mods-empty">{NO_MODULES}</p>
      ) : (
        <ul className="mods">
          {mods.map((m) => {
            const on = me!.picked.includes(m.key);
            return (
              <li key={m.key}>
                <button type="button" className="sw" role="switch" aria-checked={on} onClick={() => onToggle(m.key, !on)}>
                  <span className="nm">{m.name}</span>
                  <i aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export type PickerAt = { x: number; y: number; place: "right" | "above" };

/** 단추 자리에서 작은 창 자리 — 화면 좌표 (right: 단추 오른쪽 · 아래 맞춤, above: 단추 위 · 왼쪽 맞춤) */
export function anchorOf(el: Element, place: PickerAt["place"]): PickerAt {
  const r = el.getBoundingClientRect();
  // 사이드바 안의 단추면 사이드바 오른쪽 선 밖에
  const right = el.closest(".side")?.getBoundingClientRect().right ?? r.right;
  const gap = toScreen(8);
  return place === "right" ? { x: right + gap, y: r.bottom, place } : { x: r.left, y: r.top - gap, place };
}

export function ModulePicker({
  me,
  at,
  sheet,
  onToggle,
  onClose,
}: {
  me: Me | null;
  /** null 이면 닫힘 */
  at: PickerAt | null;
  /** 폰: 아래 시트 */
  sheet: boolean;
  onToggle: (key: string, on: boolean) => void;
  onClose: () => void;
}) {
  const open = at !== null;
  return (
    <>
      <Presence>{open && sheet && <div className="scrim" onClick={onClose} />}</Presence>
      <Presence>
        {open && sheet && (
          <div className="sheet mods-sheet" role="dialog" aria-label="추가 모듈">
            <span className="grab" />
            <div className="sh-in">
              <ModuleList me={me} onToggle={onToggle} />
            </div>
          </div>
        )}
      </Presence>
      <Presence>{at !== null && !sheet && <PickerPop me={me} at={at} onToggle={onToggle} onClose={onClose} />}</Presence>
    </>
  );
}

/** rest: Presence 가 나가는 동안 붙이는 data-leaving · inert */
function PickerPop({ me, at, onToggle, onClose, ...rest }: { me: Me | null; at: PickerAt; onToggle: (key: string, on: boolean) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(toCss(at.x), toCss(innerWidth) - w - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(toCss(at.y) - h, toCss(innerHeight) - h - 8))}px`;
  }, [at, me]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!ref.current || ref.current.contains(t)) return;
      // 여는 단추를 다시 누르면 그 단추가 닫는다
      if (t?.closest?.("[data-mods-open]")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
      removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={`pop mods-pop ${at.place}`} role="dialog" aria-label="추가 모듈" {...rest}>
      <ModuleList me={me} onToggle={onToggle} />
    </div>
  );
}

/** 사이드바 · 홈의 추가 모듈 한 칸: link 는 새 탭, builtin 은 앱 안 */
export function ModuleLink({ m, href, className, children }: { m: ModuleRow; href: (path: string) => string; className?: string; children: React.ReactNode }) {
  if (m.kind === "builtin") {
    return (
      <Link className={className} href={href(m.href)} title={m.name}>
        {children}
      </Link>
    );
  }
  return (
    <a className={className} href={m.href} target="_blank" rel="noopener noreferrer" title={m.name}>
      {children}
    </a>
  );
}

export function ModuleIcon({ m, className }: { m: ModuleRow; className?: string }) {
  return <Icon name={m.kind === "builtin" ? "proj" : "open"} className={className} />;
}
