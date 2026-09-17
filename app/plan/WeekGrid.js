'use client';

// 7일 시간 그리드 — app/m/schedule/ScheduleDemo.tsx 의 주간 타임테이블(시각 축 + 열별 absolute
// 배치 + layoutDay 겹침 분할 + now 라인)을 rk 스타일로 새로 짠 것. 인라인 style 은 좌표 계산에만
// 쓰고 나머지는 globals.css 의 rk-pl-* 클래스를 쓴다.
//
// 표시 범위는 고정된 dayStart~dayEnd 가 아니라 그 주 occurrence 의 실제 범위(-1h~+1h, 최소 8시간,
// dayStart/dayEnd 를 넘지 않게)로 잘라 불필요하게 긴 그리드를 없앤다 — 중첩 스크롤의 원인이었다.
import { useMemo, useState } from 'react';
import { dowOf, fmtTime, nowMinutes, todayISO } from '../../lib/plan-core';
import { mealSlots, travelBlocks } from '../../lib/plan-suggest';

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

// 그 주 occurrence 들이 실제로 걸쳐 있는 [start,end] — 없으면 설정의 하루 범위(기본 09~18).
// 하루 시작·끝(settings)은 제안에 쓰는 선호일 뿐이라 여기서 경계로 쓰지 않는다 — 그 밖에 있는
// 일정을 잘라내면 화면에서 사라진다(하루 끝을 12:00 으로 잘못 넣었을 때 오후 일정이 전부 안 보였다).
// 경계는 하루 그 자체(0~24시)뿐이고, 시각 눈금이 딱 떨어지게 정시로 맞춘다.
export function visibleRange(occurrences, dayStart, dayEnd) {
  let lo = Infinity, hi = -Infinity;
  for (const o of occurrences) {
    if (o.allDay || o.start == null || o.end == null) continue;
    if (o.start < lo) lo = o.start;
    if (o.end > hi) hi = o.end;
  }
  if (lo === Infinity) {
    const a = Math.max(0, dayStart ?? 540), b = Math.min(1440, dayEnd ?? 1080);
    return b - a >= 60 ? [a, b] : [540, 1080];
  }
  lo = Math.max(0, Math.floor((lo - 60) / 60) * 60);
  hi = Math.min(1440, Math.ceil((hi + 60) / 60) * 60);
  if (hi - lo < MIN_SPAN) {
    const mid = (lo + hi) / 2;
    lo = Math.max(0, Math.floor((mid - MIN_SPAN / 2) / 60) * 60);
    hi = Math.min(1440, lo + MIN_SPAN);
    lo = Math.max(0, hi - MIN_SPAN);
  }
  return [lo, hi];
}

const PLACE_SNAP = 15; // 끌어넣을 땐 30분 칸보다 촘촘하게

// placing: { title, duration, candidates:[{date,start,end,reasons}], check(date,start) → {ok,why?,reasons?} }
// 배치 모드에서는 기존 블록을 누를 수 없고(겹치는 자리도 판정을 보여줘야 하므로), 칸을 누르거나
// 할 일을 끌어다 놓으면 onPlace(date, start) 가 불린다.
export default function WeekGrid({
  occurrences, days, settings, onSlotClick, onOccClick, rowH = 40, placing, onPlace, dragType,
}) {
  // 출근·귀가·외출 준비 — 일정 칸 뒤에 옅게 깐다(칸 나누기에는 끼지 않는다)
  const moves = useMemo(
    () => new Map(days.map((d) => [d, travelBlocks(occurrences, d, settings)])),
    [occurrences, days, settings],
  );
  // 식사 추천 — 점선 테두리만. 고정이 아니라 일정에 맞춰 옮겨 다닌다
  const meals = useMemo(
    () => new Map(days.map((d) => [d, mealSlots(occurrences, d, settings).filter((m) => !m.missing && !m.covered)])),
    [occurrences, days, settings],
  );
  const { dayStart: fullStart, dayEnd: fullEnd, step } = settings;
  const today = todayISO();
  const [dayStart, dayEnd] = useMemo(
    () => visibleRange([
      ...occurrences.filter((o) => days.includes(o.date)),
      // 출근·외출 준비가 첫 일정보다 한참 앞설 수 있다 — 범위에 같이 넣어 잘리지 않게
      ...[...moves.values()].flat().map(([start, end]) => ({ start, end })),
    ], fullStart, fullEnd),
    [occurrences, days, fullStart, fullEnd, moves],
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
  const [ghost, setGhost] = useState(null); // 배치 모드: { day, start, result }

  function slotFromEvent(e, currentTarget, snap = step) {
    const rect = currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const raw = dayStart + ratio * (dayEnd - dayStart);
    const snapped = Math.round(raw / snap) * snap;
    return Math.min(dayEnd - snap, Math.max(dayStart, snapped));
  }

  // 배치 모드 — 커서 자리를 블록 윗변으로 보고 판정한다
  function trackGhost(e, d) {
    const start = slotFromEvent(e, e.currentTarget, PLACE_SNAP);
    if (ghost && ghost.day === d && ghost.start === start) return;
    setGhost({ day: d, start, result: placing.check(d, start) });
  }
  function dropAt(d, start) {
    const result = placing.check(d, start);
    if (result.ok) onPlace?.(d, start);
    else setGhost({ day: d, start, result });
  }

  // 판정 한 줄 — 넣을 수 있으면 이유표, 없으면 막힌 이유
  const verdict = (r) => (r.ok ? (r.reasons.filter((x) => x !== '가까운 날짜').join(' · ') || '넣을 수 있음') : r.why);

  const showNow = days.includes(today) && nowMin >= dayStart && nowMin <= dayEnd;

  return (
    <div className={'rk-pl-week-wrap' + (placing ? ' is-placing' : '')}>
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
            // 지금 시각 라벨과 12분 안으로 붙는 정시 라벨은 가린다(겹쳐서 둘 다 안 읽힘)
            <span key={m} style={{ top: yPx(m) }} className={showNow && Math.abs(m - nowMin) < 12 ? 'is-hidden' : undefined}>
              {fmtTime(m)}
            </span>
          ))}
          {showNow && (
            <span className="rk-pl-axis-now rk-num" style={{ top: yPx(nowMin) }}>{fmtTime(nowMin)}</span>
          )}
        </div>
        {days.map((d) => {
          const blocks = byDay.get(d) || [];
          const isToday = d === today;
          const isPastDay = d < today;
          const showHover = !placing && hover && hover.day === d;
          const g = placing && ghost && ghost.day === d ? ghost : null;
          const cands = placing ? placing.candidates.filter((c) => c.date === d) : [];
          return (
            <div
              key={d}
              className={'rk-pl-col' + (isToday ? ' is-today' : '')}
              style={{ height: totalH }}
              onMouseMove={(e) => {
                if (placing) { trackGhost(e, d); return; }
                if (e.target !== e.currentTarget) { setHover(null); return; }
                const start = slotFromEvent(e, e.currentTarget);
                setHover({ day: d, top: yPx(start), height: (step / 60) * rowH });
              }}
              onMouseLeave={() => { setHover(null); setGhost(null); }}
              onClick={(e) => {
                if (placing) { dropAt(d, slotFromEvent(e, e.currentTarget, PLACE_SNAP)); return; }
                if (e.target !== e.currentTarget) return;
                onSlotClick?.(d, slotFromEvent(e, e.currentTarget));
              }}
              onDragOver={(e) => {
                if (!placing || !dragType || !e.dataTransfer.types.includes(dragType)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                trackGhost(e, d);
              }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setGhost(null); }}
              onDrop={(e) => {
                if (!placing) return;
                e.preventDefault();
                dropAt(d, slotFromEvent(e, e.currentTarget, PLACE_SNAP));
              }}
            >
              {showHover && <div className="rk-pl-slot-hover" style={{ top: hover.top, height: hover.height }} aria-hidden="true" />}
              {cands.map((c, i) => (
                <button
                  key={`cand-${c.start}`} type="button" className="rk-pl-cand-slot"
                  style={{ top: yPx(c.start), height: Math.max(14, yPx(c.end) - yPx(c.start)) }}
                  title={`추천 ${fmtTime(c.start)}–${fmtTime(c.end)} ${c.reasons.join(' · ')}`}
                  onClick={(e) => { e.stopPropagation(); onPlace?.(d, c.start); }}
                >
                  <span>추천 {i + 1}</span>
                </button>
              ))}
              {g && (
                <div
                  className={'rk-pl-ghost' + (g.result.ok ? '' : ' is-bad')}
                  style={{ top: yPx(g.start), height: Math.max(16, yPx(g.start + placing.duration) - yPx(g.start)) }}
                  aria-hidden="true"
                >
                  <span className="rk-pl-ghost-t">{fmtTime(g.start)} {placing.title}</span>
                  <span className="rk-pl-ghost-v">{verdict(g.result)}</span>
                </div>
              )}
              {isToday && nowMin >= dayStart && nowMin <= dayEnd && (
                <div className="rk-pl-now" style={{ top: yPx(nowMin) }} />
              )}
              {(meals.get(d) || []).map((m) => {
                const top = yPx(m.start);
                const height = Math.max(10, yPx(m.end) - top);
                return (
                  <div
                    key={`ml-${m.key}`} className="rk-pl-meal" style={{ top, height }}
                    title={`${m.label} 추천 ${fmtTime(m.start)}–${fmtTime(m.end)} (고정 아님)`} aria-hidden="true"
                  >
                    {height >= 16 && <span>{m.label}</span>}
                  </div>
                );
              })}
              {(moves.get(d) || []).map(([a, e, label]) => {
                const top = yPx(a);
                const height = Math.max(4, yPx(e) - top);
                return (
                  <div
                    key={`mv-${a}-${label}`}
                    className={'rk-pl-move' + (label === '외출 준비' ? ' is-prep' : '')}
                    style={{ top, height }}
                    title={`${label} ${fmtTime(a)}–${fmtTime(e)}`}
                    aria-hidden="true"
                  >
                    {height >= 16 && <span>{label}</span>}
                  </div>
                );
              })}
              {blocks.map((b) => {
                const top = yPx(b.start);
                const height = Math.max(16, yPx(b.end) - top - 2);
                const w = 100 / b.cols;
                const isPast = isPastDay || (isToday && b.end <= nowMin);
                // 높이별로 보여줄 양을 나눈다 — 작으면 제목 한 줄만, 크면 2~3줄. 올리면 펼쳐서 전부 보인다
                const tier = height < 26 ? ' is-s' : height < 44 ? ' is-m' : height < 66 ? ' is-l' : ' is-xl';
                return (
                  <button
                    key={b.key}
                    type="button"
                    className={'rk-pl-block' + tier + (b.important ? ' is-important' : '') + (isPast ? ' is-past' : '')}
                    style={{
                      '--c': `var(--s${(b.color % 7) + 1})`,
                      '--h': `${height}px`,
                      top, height,
                      left: `calc(${b.col * w}% + 1px)`,
                      width: `calc(${w}% - 2px)`,
                    }}
                    tabIndex={placing ? -1 : undefined}
                    onClick={(e) => { e.stopPropagation(); if (!placing) onOccClick?.(b, e.currentTarget.getBoundingClientRect()); }}
                    title={`${b.title} ${fmtTime(b.start)}–${fmtTime(b.end)}`}
                  >
                    <span className="rk-pl-block-t">{b.title}</span>
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
