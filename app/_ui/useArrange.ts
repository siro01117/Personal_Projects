"use client";

// 보고서 블록 고르기 · 지우기 · 옮기기의 조작 (설계서 3장 "사람이 블록을 고르고 · 지우고 · 옮기기"). 글자 고치기 모드에서만 돈다.
//  - 고르기: 블록을 넘는 끌기(마우스) = 시작 블록 ~ 지금 블록, 손잡이 누르기 / Shift(범위) / Ctrl·⌘(하나씩), 터치는 손잡이를 누를 때마다 더하고 빼기,
//            Ctrl·⌘+A(칸 밖에서), Esc · 다른 곳 누르기 = 풀림 (아래 도구 줄 .edit-bar 를 누르는 것은 풀림이 아니다)
//  - Esc 는 두 단계: 고른 게 있으면 풀고, 없고 칸에 커서도 없으면 고치기 모드를 끈다(onDone). Ctrl·⌘+Z(칸 밖에서) = 되돌리기(onUndo)
//  - 지우기: Delete / Backspace(칸 밖에서) — 실제로 지우고 저장하는 것은 ReportView (onDelete)
//  - 옮기기: 손잡이 끌기(터치는 길게 눌러 끌기), 고른 것은 한 덩어리. 놓일 자리는 선 하나(.drop-line). Alt+↑/↓ 한 칸. 화면 끝 가까이 끌면 스크롤
// 순서 계산 · 놓일 자리 판정은 app/_logic/drawer (순수 함수 + 시험). 여기는 포인터와 키만 다룬다.
// 끄는 동안에는 순서를 바꾸지 않는다 — 놓을 때 한 번 바꾸고, 나머지 블록이 비켜 주는 모션은 ReportView 의 useFlip 이 한다.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { isSameOrder } from "../../lib/blocks";
import { dropLine, dropSlot, orderMoved, orderStepped, selectRange, toggleId, type Box } from "../_logic/drawer";
import type { ArrangeCtx } from "./Blocks";

/** 터치: 손잡이를 이만큼 누르고 있으면 끌기 시작 */
const HOLD_MS = 320;
/** 마우스: 이만큼 움직여야 끌기 */
const DRAG_PX = 5;
/** 터치: 길게 누르기 전에 이만큼 움직이면 끌기 아님 */
const SLOP_PX = 10;
/** 화면 위아래 이 안쪽으로 끌면 스크롤 */
const EDGE_PX = 72;
const SCROLL_MAX = 18;

export type ArrangeOptions = {
  editing: boolean;
  /** 지금 순서의 블록 열쇠 */
  keys: readonly string[];
  /** 블록들이 든 영역 (.doc-body) */
  body: RefObject<HTMLElement | null>;
  /** 놓일 자리 선 */
  line: RefObject<HTMLElement | null>;
  /** 고른 블록 번호들을 지운다 */
  onDelete: (picked: number[]) => void;
  /** 새 순서(옛 번호들)로 바꾼다 */
  onMove: (order: number[]) => void;
  /** Ctrl·⌘+Z (칸 밖에서) */
  onUndo?: () => void;
  /** 고른 것 없이 Esc (칸 밖에서) — 고치기 모드 끄기 */
  onDone?: () => void;
};

export type Arrange = {
  ctx: ArrangeCtx;
  selected: ReadonlySet<string>;
  /** 고른 것 지우기 (도구 줄의 휴지통) */
  remove: () => void;
  /** 전부 고르기. 전부 골라져 있으면 풀기 */
  toggleAll: () => void;
  allSelected: boolean;
  /** 고른 덩어리를 한 칸 위(-1) · 아래(1)로 */
  step: (dir: -1 | 1) => void;
  /** 우클릭 메뉴를 연 블록: 고른 것에 없으면 그것만 고른다(있으면 고른 것 그대로) */
  pick: (key: string) => void;
  canUp: boolean;
  canDown: boolean;
  /** .doc-body 의 onPointerDown · onClick */
  onBodyDown: (e: PointerEvent<HTMLElement>) => void;
  onBodyClick: (e: MouseEvent<HTMLElement>) => void;
};

const EMPTY: ReadonlySet<string> = new Set();

function inField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && typeof el.tagName === "string" && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

export function useArrange(options: ArrangeOptions): Arrange {
  const { editing, keys } = options;
  const [sel, setSel] = useState<string[]>([]);
  const [moving, setMoving] = useState<ReadonlySet<string>>(EMPTY);

  const opts = useRef(options);
  opts.current = options;
  const selRef = useRef(sel);
  selRef.current = sel;
  const anchor = useRef<string | null>(null);
  /** 진행 중인 끌기(고르기 · 옮기기)를 그 자리에서 그만둔다 */
  const cancel = useRef<(() => void) | null>(null);
  const justDragged = useRef(false);
  const lastPointer = useRef("mouse");
  const bodyPointer = useRef("mouse");

  // 없어진 블록(지움 · 새로 불러옴)은 고른 것에서 빠진다
  const selected = useMemo<ReadonlySet<string>>(() => {
    if (sel.length === 0) return EMPTY;
    const live = new Set(keys);
    return new Set(sel.filter((k) => live.has(k)));
  }, [sel, keys]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const pickedIndexes = () => opts.current.keys.flatMap((k, i) => (selectedRef.current.has(k) ? [i] : []));

  const remove = useCallback(() => {
    const picked = pickedIndexes();
    if (picked.length === 0) return;
    opts.current.onDelete(picked);
  }, []);

  const selectAll = useCallback(() => {
    getSelection()?.removeAllRanges();
    setSel([...opts.current.keys]);
    anchor.current = opts.current.keys[0] ?? null;
  }, []);

  const toggleAll = useCallback(() => {
    const all = opts.current.keys;
    if (all.length > 0 && selectedRef.current.size === all.length) {
      setSel([]);
      anchor.current = null;
    } else selectAll();
  }, [selectAll]);

  const step = useCallback((dir: -1 | 1) => {
    const all = opts.current.keys;
    const picked = pickedIndexes();
    if (picked.length === 0) return;
    const order = orderStepped(all.length, picked, dir);
    if (isSameOrder(all.length, order)) return;
    const lead = all[dir < 0 ? picked[0]! : picked[picked.length - 1]!]!;
    opts.current.onMove(order);
    // 옮긴 블록이 화면 밖으로 나가면 따라간다
    requestAnimationFrame(() => {
      const el = [...(opts.current.body.current?.querySelectorAll<HTMLElement>("[data-bk]") ?? [])].find((n) => n.dataset.bk === lead);
      el?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  const pick = useCallback((key: string) => {
    if (selectedRef.current.has(key)) return;
    getSelection()?.removeAllRanges();
    setSel([key]);
    anchor.current = key;
  }, []);

  // 고치기 모드를 끄면 고르기가 풀리고, 하던 끌기도 그만둔다
  useEffect(() => {
    if (editing) return;
    cancel.current?.();
    setSel([]);
    anchor.current = null;
  }, [editing]);

  useEffect(() => () => cancel.current?.(), []);

  // ------------------------------------------------------------ 화면 끝 스크롤

  /** 끄는 동안 포인터가 화면 위아래 끝 가까이 있으면 스크롤하고, 그때마다 tick 을 부른다. 멈추는 함수를 돌려준다 */
  const autoScroll = (point: () => number, tick: () => void): (() => void) => {
    let raf = 0;
    const step = () => {
      const y = point();
      const h = window.innerHeight;
      const v = y < EDGE_PX ? -Math.ceil(((EDGE_PX - y) / EDGE_PX) * SCROLL_MAX) : y > h - EDGE_PX ? Math.ceil(((y - (h - EDGE_PX)) / EDGE_PX) * SCROLL_MAX) : 0;
      if (v !== 0) {
        const before = window.scrollY;
        window.scrollBy(0, Math.max(-SCROLL_MAX, Math.min(SCROLL_MAX, v)));
        if (window.scrollY !== before) tick();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  };

  // ------------------------------------------------------------ 끌어서 고르기 (마우스)

  const onBodyDown = useCallback((e: PointerEvent<HTMLElement>) => {
    if (!opts.current.editing || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".grip,.edit-bar")) return;
    bodyPointer.current = e.pointerType;
    // 터치는 누르는 순간이 스크롤의 시작일 수 있다 — 풀림은 톡 눌렀을 때(onBodyClick)
    if (e.pointerType !== "mouse") return;
    // 다른 곳 누르기 = 풀림
    if (selRef.current.length > 0) setSel([]);
    anchor.current = null;
    const root = opts.current.body.current;
    if (!root) return;
    cancel.current?.();

    const origin = target.closest<HTMLElement>("[data-bk]")?.dataset.bk ?? null;
    const pointerId = e.pointerId;
    let first = origin;
    let ranging = false;
    let x = e.clientX;
    let y = e.clientY;
    let last = "";
    let stopScroll: (() => void) | null = null;

    const update = () => {
      const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-bk]");
      const cur = hit && root.contains(hit) ? (hit.dataset.bk ?? null) : null;
      if (cur === null) return;
      if (!ranging) {
        // 한 블록 안에서만 끌면 평소처럼 글자 선택
        if (origin !== null && cur === origin) return;
        ranging = true;
        first ??= cur;
        (document.activeElement as HTMLElement | null)?.blur?.();
        root.setAttribute("data-picking", "");
        stopScroll = autoScroll(() => y, update);
      }
      getSelection()?.removeAllRanges();
      const range = selectRange(opts.current.keys, first, cur);
      const sig = range.join("|");
      if (sig === last) return;
      last = sig;
      anchor.current = first;
      setSel(range);
    };
    const move = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      x = ev.clientX;
      y = ev.clientY;
      update();
    };
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      stopScroll?.();
      root.removeAttribute("data-picking");
      if (cancel.current === end) cancel.current = null;
    };
    const up = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId === pointerId) end();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    cancel.current = end;
  }, []);

  const onBodyClick = useCallback((e: MouseEvent<HTMLElement>) => {
    if (bodyPointer.current === "mouse" || (e.target as HTMLElement).closest(".grip,.edit-bar")) return;
    if (selRef.current.length > 0) setSel([]);
    anchor.current = null;
  }, []);

  // ------------------------------------------------------------ 손잡이: 누르기 = 고르기, 끌기 = 옮기기

  const onGripClick = useCallback((e: MouseEvent<HTMLButtonElement>, key: string) => {
    if (justDragged.current) return;
    // Shift+누르기가 글자 선택을 늘려 놓는다 — 블록을 고를 때는 글자 선택이 없다
    getSelection()?.removeAllRanges();
    const all = opts.current.keys;
    const cur = selRef.current;
    if (e.shiftKey && anchor.current !== null && all.includes(anchor.current)) {
      setSel(selectRange(all, anchor.current, key));
      return;
    }
    const touch = e.detail !== 0 && lastPointer.current === "touch";
    if (touch || e.ctrlKey || e.metaKey) setSel(toggleId(cur, key));
    else setSel([key]);
    anchor.current = key;
  }, []);

  const onGripDown = useCallback((e: PointerEvent<HTMLButtonElement>, key: string) => {
    lastPointer.current = e.pointerType;
    if (!opts.current.editing || e.button !== 0) return;
    const root = opts.current.body.current;
    if (!root) return;
    cancel.current?.();

    const touch = e.pointerType === "touch";
    const pointerId = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let x = x0;
    let y = y0;
    let started = false;
    let group: string[] = [];
    let slot = -1;
    let stopScroll: (() => void) | null = null;
    let hold: ReturnType<typeof setTimeout> | undefined;

    const update = () => {
      const els = [...root.querySelectorAll<HTMLElement>("[data-bk]")];
      const boxes: Box[] = els.map((el) => el.getBoundingClientRect());
      slot = dropSlot(boxes, x, y);
      const at = dropLine(boxes, slot);
      const bar = opts.current.line.current;
      if (!bar) return;
      if (!at) return void bar.removeAttribute("data-on");
      bar.style.width = `${at.w}px`;
      bar.style.transform = `translate3d(${at.x}px,${at.y}px,0)`;
      bar.setAttribute("data-on", "");
    };
    const start = () => {
      started = true;
      justDragged.current = true;
      const picked = selectedRef.current;
      // 고른 블록의 손잡이면 고른 것 전부, 아니면 그 블록만(그 블록을 고른다)
      group = picked.has(key) ? opts.current.keys.filter((k) => picked.has(k)) : [key];
      if (!picked.has(key)) {
        setSel([key]);
        anchor.current = key;
      }
      setMoving(new Set(group));
      (document.activeElement as HTMLElement | null)?.blur?.();
      getSelection()?.removeAllRanges();
      root.setAttribute("data-picking", "");
      stopScroll = autoScroll(() => y, update);
      update();
    };
    const move = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      x = ev.clientX;
      y = ev.clientY;
      if (!started) {
        const far = Math.hypot(x - x0, y - y0);
        if (touch) {
          if (far > SLOP_PX) end();
          return;
        }
        if (far < DRAG_PX) return;
        start();
        return;
      }
      update();
    };
    const end = () => {
      clearTimeout(hold);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", abort);
      stopScroll?.();
      root.removeAttribute("data-picking");
      opts.current.line.current?.removeAttribute("data-on");
      if (started) {
        setMoving(EMPTY);
        // 놓은 뒤 따라오는 click 이 고르기를 바꾸지 않게
        setTimeout(() => (justDragged.current = false), 0);
      }
      if (cancel.current === end) cancel.current = null;
    };
    const up = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const drop = started && slot >= 0;
      end();
      if (!drop) return;
      const all = opts.current.keys;
      const picked = group.map((k) => all.indexOf(k)).filter((i) => i >= 0);
      const order = orderMoved(all.length, picked, slot);
      if (picked.length > 0 && !isSameOrder(all.length, order)) opts.current.onMove(order);
    };
    const abort = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId === pointerId) end();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", abort);
    cancel.current = end;
    if (touch) hold = setTimeout(start, HOLD_MS);
  }, []);

  // ------------------------------------------------------------ 키보드

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      // 한글 조합 중 키는 글자 확정용
      if (e.isComposing || e.keyCode === 229) return;
      if (document.querySelector(".lightbox")) return;
      const field = inField(e.target);
      if (e.key === "Escape") {
        if (cancel.current) {
          cancel.current();
          return;
        }
        // 칸 안의 Esc 는 그 칸이 한다(글자 되돌리고 나감). 다른 것이 이미 쓴 Esc 도 건드리지 않는다
        if (field || e.defaultPrevented) return;
        if (selectedRef.current.size > 0) {
          setSel([]);
          anchor.current = null;
        } else {
          if (selRef.current.length > 0) setSel([]);
          opts.current.onDone?.();
        }
        return;
      }
      // 칸 안에 커서가 있으면 평소 글자 동작
      if (field) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && !e.shiftKey && (e.code === "KeyA" || e.key === "a" || e.key === "A")) {
        e.preventDefault();
        selectAll();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && (e.code === "KeyZ" || e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        opts.current.onUndo?.();
        return;
      }
      if (selectedRef.current.size === 0) return;
      if ((e.key === "Delete" || e.key === "Backspace") && !mod && !e.altKey) {
        e.preventDefault();
        remove();
        return;
      }
      if (e.altKey && !mod && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        step(e.key === "ArrowUp" ? -1 : 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, remove, selectAll, step]);

  const ctx = useMemo<ArrangeCtx>(() => ({ selected, moving, onGripDown, onGripClick }), [selected, moving, onGripDown, onGripClick]);
  const count = keys.length;
  const picked = keys.flatMap((k, i) => (selected.has(k) ? [i] : []));
  const canStep = (dir: -1 | 1) => picked.length > 0 && !isSameOrder(count, orderStepped(count, picked, dir));
  return {
    ctx,
    selected,
    remove,
    toggleAll,
    allSelected: count > 0 && selected.size === count,
    step,
    pick,
    canUp: canStep(-1),
    canDown: canStep(1),
    onBodyDown,
    onBodyClick,
  };
}
