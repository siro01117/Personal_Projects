"use client";

// 격자 한 열 안에 그리는 것: 일정 블록 · 준비/이동 띠 · 식사 점선 · 지금 선. 데스크톱 주간과 폰 하루가 같이 쓴다.
// 블록이 좁아지면 말줄임 대신 덜 중요한 것부터 뺀다(CSS 컨테이너 쿼리). 제목 줄 수는 높이에서 정한다(blockFit).

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { Occurrence, Place } from "../../../lib/schedule";
import { blockFit, DRAFT_ID, duration, hm, PX_PER_MIN, timeRange, type GridItem, type Laid } from "../../_logic/schedule";
import { PlaceSymbol } from "./PlaceSymbol";

export type GridCtx = {
  places: Map<string, Place>;
  sourceLabel: (source: string) => string;
  /** 할 일에서 온 일정: 끝냈으면 true, 아니면 false. 할 일이 아니면 null */
  taskDone: (taskId: string | null) => boolean | null;
  selKey: string | null;
  /** 고치는 중인 회차 (끌기 손잡이) */
  editKey: string | null;
  dragging: boolean;
  onPick: (o: Occurrence, el: HTMLElement) => void;
  /** 고치는 중인 블록을 잡음 (데스크톱 마우스만) */
  onGrab?: (e: ReactPointerEvent<HTMLElement>, o: Occurrence, mode: "move" | "resize") => void;
};

function laneStyle(l: { lanes: number; left: number; width: number }): CSSProperties {
  if (l.lanes <= 1) return {};
  return {
    left: `calc(4px + (100% - 8px) * ${l.left})`,
    width: `calc((100% - 8px) * ${l.width} - 2px)`,
    right: "auto",
  };
}

export function occTitle(o: Occurrence, ctx: GridCtx): string {
  const parts = [o.title];
  if (!o.all_day && o.start_min !== null && o.end_min !== null) parts.push(timeRange(o.start_min, o.end_min));
  const place = o.place_id ? ctx.places.get(o.place_id) : undefined;
  if (place) parts.push(place.name);
  if (o.source && ctx.sourceLabel(o.source) !== place?.name) parts.push(ctx.sourceLabel(o.source));
  return parts.join(" · ");
}

export function ColumnItems({ items, from, ctx }: { items: Laid<GridItem>[]; from: number; ctx: GridCtx }) {
  return (
    <>
      {items.map((laid) => {
        const { item } = laid;
        const top = (item.start - from) * PX_PER_MIN;
        const height = (item.end - item.start) * PX_PER_MIN;
        if (item.kind === "meal") {
          const name = item.seg.meal === "lunch" ? "점심" : "저녁";
          return (
            <div
              key={item.id}
              className={height < 30 ? "meal short" : "meal"}
              style={{ top, height }}
              title={`${name} ${timeRange(item.seg.start, item.seg.end)}`}
            >
              {name}
            </div>
          );
        }
        if (item.kind === "band") {
          const s = item.seg;
          const late = s.kind === "travel" ? s.late : 0;
          const name = s.kind === "prep" ? "준비" : s.label;
          const mins = s.end - s.start;
          const cls = `band${s.kind === "prep" ? " prep" : ""}${late > 0 ? " warn" : ""}`;
          return (
            <div
              key={item.id}
              className={cls}
              style={{ top, height: Math.max(1, height - 1), ...laneStyle(laid) }}
              title={`${name} ${duration(mins)} · ${timeRange(s.start, s.end)}${late > 0 ? ` · ${late}분 늦음` : ""}`}
            >
              {height >= 11 &&
                (late > 0 ? (
                  <>
                    <b>{late}분</b>
                    <span className="m">늦음</span>
                  </>
                ) : (
                  <>
                    <b>{name}</b>
                    <span className="m">{mins}</span>
                  </>
                ))}
            </div>
          );
        }
        return <EventBlock key={item.id} item={item} top={top} height={height} style={laneStyle(laid)} ctx={ctx} />;
      })}
    </>
  );
}

function EventBlock({
  item,
  top,
  height,
  style,
  ctx,
}: {
  item: Extract<GridItem, { kind: "ev" }>;
  top: number;
  height: number;
  style: CSSProperties;
  ctx: GridCtx;
}) {
  const o = item.occ;
  const place = o.place_id ? ctx.places.get(o.place_id) : undefined;
  const fit = blockFit(height);
  const done = ctx.taskDone(o.task_id);
  const editing = ctx.editKey === o.key;
  const cls = [
    "ev",
    place ? `pc-${place.color} has-ps` : "",
    o.source ? "ext" : "",
    ctx.selKey === o.key || editing ? "sel" : "",
    item.cutTop ? "cut-t" : "",
    item.cutBottom ? "cut-b" : "",
    fit.short ? "short" : "",
    fit.showTime ? "" : "no-h",
    editing ? "editing" : "",
    editing && ctx.dragging ? "dragging" : "",
    o.event_id === DRAFT_ID ? "draft" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      style={{ top, height, ...style, ["--lines" as string]: fit.lines }}
      title={occTitle(o, ctx)}
      role="button"
      tabIndex={0}
      data-key={o.key}
      onClick={(e) => {
        e.stopPropagation();
        if (!ctx.dragging) ctx.onPick(o, e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          ctx.onPick(o, e.currentTarget);
        }
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={editing && ctx.onGrab ? (e) => ctx.onGrab!(e, o, "move") : undefined}
    >
      <div className="r">
        {place && <PlaceSymbol symbol={place.symbol} />}
        {done !== null && <i className={done ? "tk done" : "tk"} aria-hidden="true" />}
        <span className="t">{o.title}</span>
        {o.source && <span className="src">{ctx.sourceLabel(o.source)}</span>}
      </div>
      {o.start_min !== null && o.end_min !== null && (
        <span className="h">
          <span className="hs">{hm(o.start_min)}</span>
          <span className="he">–{hm(o.end_min)}</span>
        </span>
      )}
      {editing && ctx.onGrab && !item.cutTop && (
        <span
          className="grip"
          aria-hidden="true"
          onPointerDown={(e) => {
            e.stopPropagation();
            ctx.onGrab!(e, o, "resize");
          }}
        />
      )}
    </div>
  );
}

/** 시간 축 글자 (from+1시간 ~ to−1시간) + 지금 시각 */
export function Axis({ from, to, now }: { from: number; to: number; now: number | null }) {
  const hours: number[] = [];
  for (let m = from + 60; m < to; m += 60) hours.push(m);
  return (
    <div className="axis">
      {hours.map((m) => (
        <span key={m} style={{ top: (m - from) * PX_PER_MIN }}>
          {m / 60}:00
        </span>
      ))}
      {now !== null && now >= from && now <= to && (
        <b className="nowpill" style={{ top: (now - from) * PX_PER_MIN }}>
          {hm(now)}
        </b>
      )}
    </div>
  );
}

export function NowLine({ from, to, now }: { from: number; to: number; now: number }) {
  if (now < from || now > to) return null;
  return <div className="now" style={{ top: (now - from) * PX_PER_MIN }} />;
}

/** 종일 줄 한 칸 (종일 일정 · '점심 틈 없음') */
export function AllDayCell({
  allDay,
  missing,
  ctx,
}: {
  allDay: Occurrence[];
  missing: ("lunch" | "dinner")[];
  ctx: GridCtx;
}) {
  return (
    <>
      {allDay.map((o) => {
        const place = o.place_id ? ctx.places.get(o.place_id) : undefined;
        return (
          <button
            type="button"
            key={o.key}
            className={`allday${place ? ` pc-${place.color}` : ""}${ctx.selKey === o.key || ctx.editKey === o.key ? " sel" : ""}`}
            title={occTitle(o, ctx)}
            onClick={(e) => ctx.onPick(o, e.currentTarget)}
          >
            {place && <PlaceSymbol symbol={place.symbol} />}
            <span>{o.title}</span>
          </button>
        );
      })}
      {missing.map((m) => (
        <span key={m} className="nofit">
          {m === "lunch" ? "점심 틈 없음" : "저녁 틈 없음"}
        </span>
      ))}
    </>
  );
}
