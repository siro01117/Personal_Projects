'use client';

// 개요와 오늘 탭이 함께 쓰는 것 — 현재 시각, 언젠가 할 일 정렬·제안, 오늘 흐름(타임라인).
// 두 화면이 따로 계산하면 같은 빈 시간에 서로 다른 할 일을 권하게 되므로 한곳에 둔다.
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, MapPin, Utensils } from 'lucide-react';
import { addDaysISO, expand, fmtTime, nowMinutes } from '../../lib/plan-core';
import { mealSlots, suggest, travelBlocks } from '../../lib/plan-suggest';
import { shortSlot } from './format';

/* ------------------------------------------------------------ 장소 태그 */

// 지점 이름을 앞에, 상세를 뒤에 — "스터디큐브 · 카운터". 둘 다 없으면 안 그린다.
export function PlaceTag({ settings, item }) {
  const pl = item?.placeId ? (settings?.places || []).find((p) => p.id === item.placeId) : null;
  const text = [pl?.name, item?.place].filter(Boolean).join(' · ');
  if (!text) return null;
  return (
    <span className="rk-tag rk-pl-place-tag">
      <MapPin size={11} strokeWidth={1.75} aria-hidden="true" />{text}
    </span>
  );
}

/* ------------------------------------------------------------ 현재 시각 */

// "1시간 20분" / "35분" — 몇 분 남음·뒤를 사람이 바로 읽게
export const dur = (mins) => {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
};

// 분 단위 현재 시각. 30초마다 다시 그려 '지금'이 늦게 넘어가지 않게 한다.
export function useNow() {
  const [now, setNow] = useState(() => nowMinutes());
  useEffect(() => {
    const id = setInterval(() => setNow(nowMinutes()), 30000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/* ------------------------------------------------------- 언젠가 할 일 */

export function useSomeday(tasks) {
  return useMemo(() => {
    const open = tasks.filter((t) => !t.done && !t.slot);
    return [...open].sort((a, b) => {
      const da = a.due || '9999-99-99', db = b.due || '9999-99-99';
      if (da !== db) return da < db ? -1 : 1;
      const rank = { high: 0, normal: 1, low: 2 };
      return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
    });
  }, [tasks]);
}

// 우선순위 순으로 순차 배정 — 앞 할 일의 제안 슬롯을 가상 일정으로 넣고 다음 계산에 반영한다.
export function useSomedaySuggestions({ data, classes, shifts, today, now, someday }) {
  return useMemo(() => {
    const settings = data.settings;
    const base = expand(data, classes, today, addDaysISO(today, 13), shifts);
    const virtual = [];
    const out = new Map();
    for (const t of someday) {
      const cands = suggest({
        occurrences: [...base, ...virtual], duration: t.duration, fromISO: today, days: 14,
        settings, nowISO: today, nowMin: now,
        target: { due: t.due, priority: t.priority, placeId: t.placeId, travelMin: t.travelMin }, limit: 3,
      });
      out.set(t.id, cands);
      // 다음 할 일이 이 자리의 동선까지 알도록 장소를 같이 싣는다
      if (cands[0]) {
        virtual.push({
          key: `virtual:${t.id}`, date: cands[0].date, start: cands[0].start, end: cands[0].end,
          allDay: false, placeId: t.placeId || '', travelMin: t.travelMin,
        });
      }
    }
    return out;
  }, [someday, data, classes, shifts, today, now]);
}

// [from,to) 빈 틈에 실제로 들어맞는 '언젠가 할 일' 후보 하나. 목록 제안과 같은 소스를 쓴다.
export function pickGapSuggestion({ someday, suggestions, today, from, to }) {
  for (const t of someday) {
    const hit = (suggestions.get(t.id) || []).find((c) => c.date === today && c.start >= from && c.start < to);
    if (hit) return { task: t, cand: hit };
  }
  return null;
}

/* --------------------------------------------------------- 오늘 흐름 */

// 오늘 하루를 한 줄씩 — 일정 · 출근/등교/귀가 · 외출 준비 · 식사 추천 · 빈 시간.
export function buildTimeline({ todayOcc, settings, now, today, gapSuggestion }) {
  const timed = todayOcc.filter((o) => !o.allDay && o.start != null);
  const allDay = todayOcc.filter((o) => o.allDay);
  const past = [];
  const remaining = [];

  const pushGap = (start, end) => {
    if (end <= start) return;
    const from = Math.max(start, now);
    if (end - from < 60) return;
    remaining.push({ type: 'gap', start: from, end, sug: gapSuggestion ? gapSuggestion(from, end) : null });
  };

  // 이동·식사도 줄 하나로 세운다. 빈 시간처럼 보이면 안 되고, 제안 엔진과 같은 계산을 써야 어긋나지 않는다.
  const rows = [
    ...timed.map((o) => ({ type: 'occ', occ: o, start: o.start, end: o.end })),
    ...travelBlocks(todayOcc, today, settings).map(([a, b, label]) => ({ type: 'travel', start: a, end: b, label })),
    ...mealSlots(todayOcc, today, settings).filter((m) => !m.covered).map((m) => ({ type: 'meal', ...m })),
  ].sort((a, b) => a.start - b.start || (a.type === 'travel' ? -1 : 1));

  let prevEnd = settings.dayStart;
  for (const row of rows) {
    if (row.end <= now && !(row.type === 'meal' && row.missing)) {
      if (row.type === 'occ') past.push(row); // 지난 이동·식사까지 접힌 목록에 넣으면 시끄럽다
      prevEnd = Math.max(prevEnd, row.end);
      continue;
    }
    pushGap(prevEnd, row.start);
    remaining.push(row);
    prevEnd = Math.max(prevEnd, row.end);
  }
  pushGap(prevEnd, settings.dayEnd);
  return { allDay, past, remaining };
}

export function OccRow({ occ: o, live, past, onOccClick, compact }) {
  return (
    <button
      type="button"
      className={'rk-ses' + (live ? ' is-live' : '') + (past ? ' is-past' : '') + (o.important ? ' is-important' : '') + (compact ? ' is-compact' : '')}
      style={{ '--c': `var(--s${(o.color % 7) + 1})` }}
      onClick={(e) => onOccClick(o, e.currentTarget.getBoundingClientRect())}
    >
      <span className="rk-ses-time rk-num">{o.allDay ? '종일' : fmtTime(o.start)}</span>
      <span className="rk-ses-body">
        <span className="rk-ses-name">
          <span className="rk-dot" style={{ '--c': `var(--s${(o.color % 7) + 1})` }} aria-hidden="true" />
          {o.title}
        </span>
        {!compact && <span className="rk-ses-meta">{o.place || (o.source === 'task' ? '할 일' : '')}</span>}
      </span>
      {live && <span className="rk-ses-live">진행 중</span>}
    </button>
  );
}

export function TodayTimeline({ timeline, now, today, onOccClick, onQuickPlaceTask }) {
  return (
    <div className="rk-pl-timeline">
      {timeline.allDay.map((o) => (
        <OccRow key={o.key} occ={o} live={false} past={false} onOccClick={onOccClick} />
      ))}

      {timeline.past.length > 0 && (
        <details className="rk-pl-past">
          <summary><ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />지난 일정 <b className="rk-num">{timeline.past.length}</b></summary>
          <div className="rk-pl-past-list">
            {timeline.past.map((row) => (
              <OccRow key={row.occ.key} occ={row.occ} live={false} past onOccClick={onOccClick} />
            ))}
          </div>
        </details>
      )}

      {timeline.past.length > 0 && (
        <div className="rk-pl-nowline"><span className="rk-num">지금 {fmtTime(now)}</span></div>
      )}

      {timeline.remaining.map((row, i) => {
        if (row.type === 'meal') {
          return (
            <div key={`ml-${row.key}`} className={'rk-pl-meal-row' + (row.missing ? ' is-missing' : '')}>
              <span className="rk-pl-travel-at rk-num">{row.missing ? '' : fmtTime(row.start)}</span>
              <Utensils size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>
                {row.missing
                  ? `${row.label} 먹을 틈이 없습니다`
                  : <>{row.label} 추천 <b className="rk-num">{row.end - row.start}</b>분{row.short ? ' · 짧게' : ''}</>}
              </span>
            </div>
          );
        }
        if (row.type === 'travel') {
          return (
            <div key={`tv-${i}`} className={'rk-pl-travel-row' + (row.label === '외출 준비' ? ' is-prep' : '')}>
              <span className="rk-pl-travel-at rk-num">{fmtTime(row.start)}</span>
              <ArrowRight size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>{row.label} <b className="rk-num">{row.end - row.start}</b>분</span>
            </div>
          );
        }
        if (row.type === 'gap') {
          const mins = row.end - row.start;
          const h = Math.floor(mins / 60), m = mins % 60;
          return (
            <div key={`gap-${i}`} className="rk-pl-gap">
              <span className="rk-pl-gap-line" />
              <span className="rk-pl-gap-t rk-num">빈 시간 {h > 0 ? `${h}시간 ` : ''}{m > 0 ? `${m}분` : ''}</span>
              {row.sug && onQuickPlaceTask && (
                <button
                  type="button" className="rk-pl-gap-sug"
                  onClick={() => onQuickPlaceTask(row.sug.task.id, { date: row.sug.cand.date, start: row.sug.cand.start })}
                >
                  {shortSlot(row.sug.cand.date, row.sug.cand.start, today)} &lsquo;{row.sug.task.title}&rsquo; 넣기
                </button>
              )}
              <span className="rk-pl-gap-line" />
            </div>
          );
        }
        const o = row.occ;
        const live = !o.allDay && o.start != null && now >= o.start && now < o.end;
        return <OccRow key={o.key} occ={o} live={live} past={false} onOccClick={onOccClick} />;
      })}
    </div>
  );
}
