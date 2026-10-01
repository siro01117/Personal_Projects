"use client";

// 폰 주 미니어처 (목업 '주'): 글자 없이 블록만 — 지점 색 + 지점 심볼, 이동·준비는 회색, 늦음은 빨강, 식사는 뺀다.
// 7시–24시를 화면 높이에 맞춘다. 날짜(머리나 열)를 누르면 그날 하루 보기로.

import type { DateStr, Place } from "../../../lib/schedule";
import { WEEKDAYS, type DayColumn } from "../../_logic/schedule";
import { PlaceSymbol } from "./PlaceSymbol";

const M0 = 420;
const M1 = 1440;
const pct = (m: number) => `${((Math.min(M1, Math.max(M0, m)) - M0) / (M1 - M0)) * 100}%`;

export function MiniWeek({
  cols,
  today,
  now,
  places,
  onPick,
}: {
  cols: DayColumn[];
  today: DateStr;
  now: number;
  places: Map<string, Place>;
  onPick: (d: DateStr) => void;
}) {
  const hours = [8, 10, 12, 14, 16, 18, 20, 22];
  return (
    <>
      <div className="mini-head">
        <span />
        {cols.map((c, i) => (
          <button type="button" key={c.date} className={c.date === today ? "sd today" : "sd"} onClick={() => onPick(c.date)} aria-label={`${c.date} 하루 보기`}>
            <span className="w">{WEEKDAYS[i]}</span>
            <span className="d num">{Number(c.date.slice(8))}</span>
          </button>
        ))}
      </div>
      <div className="mini-all" aria-hidden="true">
        <span />
        {cols.map((c) => (
          <i key={c.date} className={c.allDay.length > 0 ? "on" : undefined} />
        ))}
      </div>
      <div className="mini">
        <div className="mini-axis" aria-hidden="true">
          {hours.map((h) => (
            <span key={h} style={{ top: pct(h * 60) }}>
              {h}
            </span>
          ))}
        </div>
        <div className="mini-cols">
          {cols.map((c) => (
            <div key={c.date} className="mcol" onClick={() => onPick(c.date)}>
              {hours.map((h) => (
                <span key={h} className="hl" style={{ top: pct(h * 60) }} />
              ))}
              {c.items.map(({ item, lanes, left, width }) => {
                if (item.kind === "meal" || item.end <= M0) return null;
                const style = {
                  top: pct(item.start),
                  height: `calc(${pct(item.end)} - ${pct(item.start)})`,
                  ...(lanes > 1 ? { left: `calc(2px + (100% - 4px) * ${left})`, width: `calc((100% - 4px) * ${width})`, right: "auto" } : {}),
                };
                if (item.kind === "band") {
                  const warn = item.seg.kind === "travel" && item.seg.late > 0;
                  return <i key={item.id} className={`mb band${item.seg.kind === "prep" ? " prep" : ""}${warn ? " warn" : ""}`} style={style} />;
                }
                const place = item.occ.place_id ? places.get(item.occ.place_id) : undefined;
                return (
                  <i key={item.id} className={place ? `mb pc-${place.color}` : "mb"} style={style}>
                    {place && <PlaceSymbol symbol={place.symbol} />}
                  </i>
                );
              })}
              {c.date === today && now >= M0 && <div className="now" style={{ top: pct(now) }} />}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
