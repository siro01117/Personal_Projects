"use client";

// 우클릭(터치는 길게 누르기) 메뉴 (docs/공통.md 2장). 화면마다 같은 것을 쓴다 — 항목은 화면이 준다(app/_logic/menus).
//  - 우클릭: 기본 메뉴를 막고 연다. 단, 칸(입력 · 고치는 글자)에 커서가 있던 채이거나 그 항목 안 글자를 골라 둔 채면 브라우저 기본 메뉴 그대로
//  - 길게 누르기(터치): 500ms, 그 사이 손가락이 10px 넘게 움직이면 취소. 연 뒤 손을 떼도 누르기(click)가 같이 일어나지 않는다
//  - 키보드: 메뉴 키(ContextMenu) · Shift+F10 — 초점이 든 항목 기준, 그 항목 왼쪽 아래에 연다. 닫히면 초점이 그 항목으로 돌아온다
//  - 메뉴가 떠 있는 동안 그 항목에 data-menu-on (선택 표시 — globals.css). Esc · 바깥 누르기 · 스크롤로 닫힘(Menu)
//  - 항목이 하나도 없으면 열지 않는다(브라우저 기본 메뉴). data-menu-skip 안에서는 길게 누르기를 재지 않는다(제 길게 누르기가 있는 것)
// 탐색기(Explorer)는 고르기와 얽혀 있어 자기 것을 그대로 쓴다 — 같은 규칙.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import type { MenuItem } from "../_logic/menus";
import { Menu, type MenuEntry } from "./Menu";

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP = 10;

/** 항목(act) → Menu 의 줄. run 이 act 를 받아 한다 */
export function toEntries<A extends string>(items: readonly MenuItem<A>[], run: (act: A) => void): MenuEntry[] {
  return items.map((m) => (m === "sep" ? { kind: "sep" } : { kind: "item", icon: m.icon, label: m.label, danger: m.danger, run: () => run(m.act) }));
}

/** 항목 요소에 펼쳐 싣는 것. 그 요소가 따로 쓰는 같은 이름의 처리가 있으면 둘 다 부른다 */
export type MenuBind = {
  "data-menu-on"?: "";
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
  onClickCapture: (e: MouseEvent<HTMLElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
};

const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function inField(target: EventTarget | null, item: HTMLElement): boolean {
  const field = target instanceof Element ? target.closest(FIELD) : null;
  return !!field && item.contains(field);
}

/** 브라우저 기본 메뉴를 둘 곳인가: 커서가 있던 칸 안, 또는 그 항목 안에 골라 둔 글자가 있을 때 */
function wantsNative(target: EventTarget | null, item: HTMLElement, focusedBefore: Element | null): boolean {
  const el = target instanceof Element ? target : null;
  const field = el?.closest<HTMLElement>(FIELD);
  if (field && item.contains(field)) {
    if (field.matches("input, textarea, select")) return true;
    if (focusedBefore && (field === focusedBefore || field.contains(focusedBefore))) return true;
  }
  const sel = typeof getSelection === "function" ? getSelection() : null;
  if (sel && !sel.isCollapsed && sel.rangeCount > 0 && item.contains(sel.getRangeAt(0).commonAncestorContainer)) return true;
  return false;
}

type Open = { key: string; x: number; y: number; entries: MenuEntry[]; back: HTMLElement | null };

export function useContextMenu() {
  const [menu, setMenu] = useState<Open | null>(null);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean; type: string; x: number; y: number; focused: Element | null }>({
    fired: false,
    type: "mouse",
    x: 0,
    y: 0,
    focused: null,
  });
  const menuRef = useRef(menu);
  menuRef.current = menu;

  useEffect(() => () => clearTimeout(press.current.timer), []);

  const close = useCallback(() => {
    const back = menuRef.current?.back ?? null;
    setMenu(null);
    // 키보드로 열었으면 초점을 그 항목으로 돌려준다 (메뉴 안 동작이 다른 곳으로 옮겼으면 그대로)
    if (back) {
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (back.isConnected && (!a || a === document.body)) back.focus({ preventScroll: true });
      });
    }
  }, []);

  const open = useCallback((key: string, x: number, y: number, entries: MenuEntry[], back: HTMLElement | null = null): boolean => {
    if (entries.length === 0) return false;
    setMenu({ key, x, y, entries, back });
    return true;
  }, []);

  /** key = 그 항목의 이름(선택 표시용), build = 열 때 항목 목록(지금 상태로) */
  const bind = (key: string, build: (el: HTMLElement) => MenuEntry[]): MenuBind => {
    const p = press.current;
    const clear = () => clearTimeout(p.timer);
    return {
      "data-menu-on": menu?.key === key ? "" : undefined,
      onPointerDown(e) {
        p.type = e.pointerType;
        p.fired = false;
        p.focused = document.activeElement;
        clear();
        if (e.pointerType !== "touch" || !e.isPrimary) return;
        const el = e.currentTarget;
        // 칸 안 길게 누르기는 글자 고르기 몫, data-menu-skip(보고서 손잡이 — 길게 눌러 끌기)은 그쪽 몫
        if (inField(e.target, el) || (e.target instanceof Element && e.target.closest("[data-menu-skip]"))) return;
        p.x = e.clientX;
        p.y = e.clientY;
        p.timer = setTimeout(() => {
          if (!el.isConnected) return;
          p.fired = open(key, p.x, p.y, build(el));
        }, LONG_PRESS_MS);
      },
      onPointerMove(e) {
        if (e.pointerType !== "touch") return;
        if (Math.abs(e.clientX - p.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - p.y) > LONG_PRESS_SLOP) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onClickCapture(e) {
        // 길게 눌러 연 뒤 손을 떼며 나는 누르기는 버린다
        if (!p.fired) return;
        p.fired = false;
        e.preventDefault();
        e.stopPropagation();
      },
      onContextMenu(e) {
        const el = e.currentTarget;
        if (wantsNative(e.target, el, p.focused)) return;
        const touch = p.type === "touch" && e.button !== 2;
        if (touch && inField(e.target, el)) return;
        e.preventDefault();
        e.stopPropagation();
        if (touch) return; // 터치는 길게 누르기 타이머가 연다
        const kb = e.clientX === 0 && e.clientY === 0;
        const r = el.getBoundingClientRect();
        open(key, kb ? r.left + 8 : e.clientX, kb ? r.top + Math.min(r.height, 40) : e.clientY, build(el));
      },
      onKeyDown(e) {
        if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
        const el = e.currentTarget;
        const focused = document.activeElement;
        if (wantsNative(e.target, el, focused)) return;
        const entries = build(el);
        if (entries.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        open(key, r.left + 8, r.top + Math.min(r.height, 40), entries, focused instanceof HTMLElement ? focused : el);
      },
    };
  };

  const node: ReactNode = menu ? <Menu x={menu.x} y={menu.y} entries={menu.entries} onClose={close} /> : null;
  return { bind, node, open, close, openKey: menu?.key ?? null };
}
