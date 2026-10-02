"use client";

// 시간 맞추기 격자 (docs/모임.md 5장). 열 = 후보 날짜, 행 = 30분. 주최자 화면과 공개 페이지가 같이 쓴다.
// 겹침은 키위 4단 진하기(되는 수 ÷ 칠한 사람 수). 내 칸 표시: 주최자는 안쪽 점, 공개 페이지는 진한 테두리(겹침은 옅게).
// editable 이면 끌어서 칠한다 — 시작 칸이 칠해져 있으면 지우기, 아니면 칠하기. 시작 칸 ~ 지금 칸의 사각 범위가 미리 보이고 손을 떼면 onPaint.
// 폰: 시간 열은 왼쪽에 붙어 있고 날짜가 많으면 가로로 넘긴다. 칠할 수 있을 때는 칸 위에서 누른 채 움직이면 칠하기(그동안 스크롤 없음) —
// 가로로 넘기려면 날짜 머리를 잡고, 세로 스크롤은 격자 밖에서. 계산은 lib/meet (overlap · paintRect).

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cellKey, clipCells, overlap, overlapLevel, paintMode, paintRect, pollSlots, SLOT_MIN, type CellAt, type Cells, type Painter, type Poll } from "../../../lib/meet";
import type { DateStr } from "../../../lib/schedule";
import { gridDay } from "../../_logic/meet";
import { hm } from "../../_logic/schedule";

export type GridPick = { date: DateStr; start: number; end: number };

type Drag = { from: CellAt; to: CellAt; on: boolean };

export function MeetGrid({
  poll,
  people,
  me,
  variant,
  editable,
  focus = null,
  pick = null,
  cellH,
  label,
  onPick,
  onPaint,
}: {
  poll: Poll;
  people: readonly Painter[];
  /** 내 이름 (없으면 내 칸 표시 없음) */
  me: string | null;
  variant: "host" | "guest";
  /** 내 칸을 칠할 수 있다 */
  editable: boolean;
  /** 이 사람 것만 강조 */
  focus?: string | null;
  /** 보고 있는 시간 (추천 시간 줄이나 칸을 눌렀을 때) */
  pick?: GridPick | null;
  /** 칸 높이 px */
  cellH: number;
  label: string;
  /** 칠하는 중이 아닐 때 칸을 눌렀다 */
  onPick?: (at: CellAt) => void;
  /** 손을 뗐다 — 새 칸 집합 (설정 밖의 칸은 그대로 들어 있다) */
  onPaint?: (cells: Cells) => void;
}) {
  const slots = useMemo(() => pollSlots(poll), [poll]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const mine = people.find((p) => p.name === me) ?? null;
  /** 끄는 동안에는 놓았을 때의 내 칸을 미리 보인다 */
  const myCells = useMemo(() => (mine && drag ? paintRect(mine.cells, poll, drag.from, drag.to, drag.on) : (mine?.cells ?? null)), [mine, drag, poll]);
  const shown = useMemo(() => {
    const list = people.map((p) => (mine && p.name === mine.name && drag ? { ...p, cells: myCells } : p));
    return focus === null ? list : list.filter((p) => p.name === focus);
  }, [people, mine, drag, myCells, focus]);
  const ov = useMemo(() => overlap(shown, poll), [shown, poll]);
  const mySet = useMemo(() => {
    const c = clipCells(myCells, poll);
    return new Set(poll.dates.flatMap((d) => (c[d] ?? []).map((m) => cellKey(d, m))));
  }, [myCells, poll]);

  const cellOf = (el: Element | null): CellAt | null => {
    const c = el?.closest<HTMLElement>("[data-c]");
    if (!c || !root.current?.contains(c)) return null;
    const date = poll.dates[Number(c.dataset.d)];
    const min = slots[Number(c.dataset.s)];
    return date !== undefined && min !== undefined ? { date, min } : null;
  };

  function down(e: ReactPointerEvent<HTMLDivElement>) {
    if (!editable || (e.pointerType === "mouse" && e.button !== 0)) return;
    const at = cellOf(e.target as Element);
    if (!at) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 잡지 못해도 움직임은 elementFromPoint 로 따라간다
    }
    const d: Drag = { from: at, to: at, on: paintMode(clipCells(mine?.cells ?? null, poll), at) };
    dragRef.current = d;
    setDrag(d);
  }

  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const at = cellOf(document.elementFromPoint(e.clientX, e.clientY));
    if (!at || (at.date === d.to.date && at.min === d.to.min)) return;
    const next = { ...d, to: at };
    dragRef.current = next;
    setDrag(next);
  }

  function up(commit: boolean) {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDrag(null);
    if (commit) onPaint?.(paintRect(mine?.cells ?? null, poll, d.from, d.to, d.on));
  }

  const cls = ["mg", variant, editable ? "edit" : "", drag ? "drag" : "", focus !== null ? "focus" : ""].filter(Boolean).join(" ");
  return (
    <div
      ref={root}
      className={cls}
      role="grid"
      aria-label={label}
      style={{ "--ch": `${cellH}px`, "--cols": poll.dates.length } as React.CSSProperties}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={() => up(true)}
      onPointerCancel={() => up(false)}
      onClick={(e) => {
        if (editable || !onPick) return;
        const at = cellOf(e.target as Element);
        if (at) onPick(at);
      }}
    >
      <div className="mg-in">
        <div className="mg-row mg-head" role="row">
          <span className="mg-t" />
          {poll.dates.map((d) => {
            const g = gridDay(d);
            return (
              <span className="mg-d num" role="columnheader" key={d}>
                {g.md}
                <i>{g.wd}</i>
              </span>
            );
          })}
        </div>
        {slots.map((min, si) => (
          <div className={min % 60 === 0 ? "mg-row hour" : "mg-row"} role="row" key={min}>
            <span className="mg-t num" role="rowheader">
              {min % 60 === 0 ? hm(min).slice(0, 2) : ""}
            </span>
            {poll.dates.map((d, di) => {
              const k = cellKey(d, min);
              const names = ov.at.get(k);
              const level = focus !== null ? (names ? 4 : 0) : overlapLevel(names?.length ?? 0, ov.painted);
              const inPick = pick !== null && pick.date === d && min >= pick.start && min < pick.end;
              // 내 칸의 테두리는 덩어리의 맨 바깥에만: 이웃이 내 칸이 아닌 쪽(t · r · b · l)만 적는다
              const isMe = mySet.has(k);
              const out = (dd: number, m: number) => {
                const nd = poll.dates[di + dd];
                return nd === undefined || !mySet.has(cellKey(nd, m));
              };
              const me = isMe
                ? `${out(0, min - SLOT_MIN) ? "t" : ""}${out(1, min) ? "r" : ""}${out(0, min + SLOT_MIN) ? "b" : ""}${out(-1, min) ? "l" : ""}`
                : undefined;
              const edge = inPick ? `${min === pick.start ? "a" : ""}${min + SLOT_MIN >= pick.end ? "z" : ""}` || "m" : undefined;
              return (
                <span
                  key={d}
                  className="c"
                  role="gridcell"
                  data-c=""
                  data-d={di}
                  data-s={si}
                  data-l={level}
                  data-me={me}
                  data-pick={edge}
                  title={names?.join(", ")}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
