'use client';

// 7일 시간 그리드 — app/m/schedule/ScheduleDemo.tsx 의 주간 타임테이블(시각 축 + 열별 absolute
// 배치 + layoutDay 겹침 분할 + now 라인)을 rk 스타일로 새로 짠 것. 인라인 style 은 좌표 계산에만
// 쓰고 나머지는 globals.css 의 rk-pl-* 클래스를 쓴다.
//
// 표시 범위는 고정된 dayStart~dayEnd 가 아니라 그 주 occurrence 의 실제 범위(-1h~+1h, 최소 8시간,
// dayStart/dayEnd 를 넘지 않게)로 잘라 불필요하게 긴 그리드를 없앤다 — 중첩 스크롤의 원인이었다.
import { useMemo, useState } from 'react';
import { dowOf, fmtTime, nowMinutes, todayISO } from '../../lib/plan-core';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const MIN_SPAN = 8 * 60;

function layoutDay(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const clusters = [];
  for (const b of sorted) {
    if (cluster.length && b.start < clusterEnd) { cluster.push(b); clusterEnd = Math.max(clusterEnd, b.end); }
    else { if (cluster.length) clusters.push(cluster); cluster = [b]; clusterEnd = b.end; }
  }
  if (cluster.length) clusters.push(cluster);
  for (const c of clusters) c.forEach((b, i) => out.push({ ...b, col: i, cols: c.length }));
  return out;
}

// 그 주 occurrence 들이 실제로 걸쳐 있는 [start,end] — 없으면 09~18 기본값.
function visibleRange(occurrences, dayStart, dayEnd) {
  let lo = Infinity, hi = -Infinity;
  for (const o of occurrences) {
    if (o.allDay || o.start == null || o.end == null) continue;
    if (o.start < lo) lo = o.start;
    if (o.end > hi) hi = o.end;
  }
  if (lo === Infinity) return [Math.max(dayStart, 540), Math.min(dayEnd, 1080)];
  lo = Math.max(dayStart, lo - 60);
  hi = Math.min(dayEnd, hi + 60);
  if (hi - lo < MIN_SPAN) {
    const mid = (lo + hi) / 2;
    lo = Math.max(dayStart, mid - MIN_SPAN / 2);
    hi = Math.min(dayEnd, lo + MIN_SPAN);
    lo = Math.max(dayStart, hi - MIN_SPAN);
  }
  return [lo, hi];
}

export default function WeekGrid({ occurrences, days, settings, onSlotClick, onOccClick, rowH = 40 }) {
  const { dayStart: fullStart, dayEnd: fullEnd, step } = settings;
  const today = todayISO();
  const [dayStart, dayEnd] = useMemo(
    () => visibleRange(occurrences.filter((o) => days.includes(o.date)), fullStart, fullEnd),
    [occurrences, days, fullStart, fullEnd],
  );
  const totalH = ((dayEnd - dayStart) / 60) * rowH;
  const yPx = (m) => ((Math.max(dayStart, Math.min(dayEnd, m)) - dayStart) / 60) * rowH;

  const hours = useMemo(() => {
    const out = [];
    for (let m = Math.ceil(dayStart / 60) * 60; m <= dayEnd; m += 60) out.push(m);
    return out;
  }, [dayStart, dayEnd]);

  const byDay = useMemo(() => {
    const map = new Map(days.map((d) => [d, []]));
    for (const o of occurrences) {
      if (map.has(o.date) && !o.allDay && o.start != null && o.end != null) map.get(o.date).push(o);
    }
    const out = new Map();
    for (const [d, list] of map) out.set(d, layoutDay(list));
    return out;
  }, [occurrences, days]);

  const nowMin = nowMinutes();
  const [hover, setHover] = useState(null); // { day, top, height }

  function slotFromEvent(e, currentTarget) {
    const rect = currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const raw = dayStart + ratio * (dayEnd - dayStart);
    const snapped = Math.round(raw / step) * step;
    return Math.min(dayEnd - step, Math.max(dayStart, snapped));
  }

  return (
    <div className="rk-pl-week-wrap">
      <div className="rk-pl-week">
        <div className="rk-pl-axis-head" aria-hidden="true" />
        {days.map((d) => (
          <div key={`h-${d}`} className={'rk-pl-week-hcell' + (d === today ? ' is-today' : '')}>
            <div className="rk-pl-week-dow">{DOW[dowOf(d)]}</div>
            <div className="rk-pl-week-dnum rk-num">{Number(d.slice(8, 10))}</div>
          </div>
        ))}
        <div className="rk-pl-axis" style={{ height: totalH }}>
          {hours.map((m) => (
            <span key={m} style={{ top: yPx(m) }}>{fmtTime(m)}</span>
          ))}
          {days.includes(today) && nowMin >= dayStart && nowMin <= dayEnd && (
            <span className="rk-pl-axis-now rk-num" style={{ top: yPx(nowMin) }}>{fmtTime(nowMin)}</span>
          )}
        </div>
        {days.map((d) => {
          const blocks = byDay.get(d) || [];
          const isToday = d === today;
          const isPastDay = d < today;
          const showHover = hover && hover.day === d;
          return (
            <div
              key={d}
              className={'rk-pl-col' + (isToday ? ' is-today' : '')}
              style={{ height: totalH }}
              onMouseMove={(e) => {
                if (e.target !== e.currentTarget) { setHover(null); return; }
                const start = slotFromEvent(e, e.currentTarget);
                setHover({ day: d, top: yPx(start), height: (step / 60) * rowH });
              }}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => {
                if (e.target !== e.currentTarget) return;
                onSlotClick?.(d, slotFromEvent(e, e.currentTarget));
              }}
            >
              {showHover && <div className="rk-pl-slot-hover" style={{ top: hover.top, height: hover.height }} aria-hidden="true" />}
              {isToday && nowMin >= dayStart && nowMin <= dayEnd && (
                <div className="rk-pl-now" style={{ top: yPx(nowMin) }} />
              )}
              {blocks.map((b) => {
                const top = yPx(b.start);
                const height = Math.max(16, yPx(b.end) - top - 2);
                const w = 100 / b.cols;
                const isPast = isPastDay || (isToday && b.end <= nowMin);
                return (
                  <button
                    key={b.key}
                    type="button"
                    className={'rk-pl-block' + (b.important ? ' is-important' : '') + (isPast ? ' is-past' : '')}
                    style={{
                      '--c': `var(--s${(b.color % 7) + 1})`,
                      top, height,
                      left: `calc(${b.col * w}% + 1px)`,
                      width: `calc(${w}% - 2px)`,
                    }}
                    onClick={(e) => { e.stopPropagation(); onOccClick?.(b, e.currentTarget.getBoundingClientRect()); }}
                    title={`${b.title} ${fmtTime(b.start)}–${fmtTime(b.end)}`}
                  >
                    <span className="rk-pl-block-t">{b.title}</span>
                    {height >= 34 && <span className="rk-pl-block-time rk-num">{fmtTime(b.start)}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
