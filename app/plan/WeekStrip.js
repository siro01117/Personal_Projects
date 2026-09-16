'use client';

// 개요 화면의 7일 요약 — 시간 그리드 대신 요일별 목록 띠. 모바일은 가로 스크롤(스냅),
// PC(>=640)는 7등분. 시간 그리드(WeekGrid)는 "시간표로 보기" 링크 뒤에 따로 둔다.
import { Star } from 'lucide-react';
import { dowOf, fmtTime } from '../../lib/plan-core';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

// 주 띠는 훑어보는 용도라 수업·근무·약속 같은 일정만 둔다. 출근·귀가·준비·식사는
// 오늘 타임라인과 '이번 주' 시간표에서 본다.

export default function WeekStrip({ occurrences, days, today, now, onOccClick, onAddSlot }) {
  const byDay = new Map(days.map((d) => [d, []]));
  for (const o of occurrences) {
    if (o.allDay || o.start == null) continue;
    if (byDay.has(o.date)) byDay.get(o.date).push(o);
  }
  for (const list of byDay.values()) list.sort((a, b) => a.start - b.start);

  return (
    <div className="rk-pl-ws-wrap">
      <div className="rk-pl-ws">
        {days.map((d) => {
          const isToday = d === today;
          const list = byDay.get(d) || [];
          return (
            <div key={d} className={'rk-pl-ws-col' + (isToday ? ' is-today' : '')}>
              <div className="rk-pl-ws-head">
                <div className="rk-pl-ws-dow">{DOW[dowOf(d)]}</div>
                <div className="rk-pl-ws-num rk-num">{Number(d.slice(8, 10))}</div>
              </div>
              {list.length === 0 ? (
                <button type="button" className="rk-pl-ws-empty" onClick={() => onAddSlot?.(d)}>—</button>
              ) : (
                <div className="rk-pl-ws-list">
                  {list.map((o) => {
                    const isPast = isToday ? o.end <= now : d < today;
                    return (
                      <button
                        key={o.key} type="button"
                        className={'rk-pl-ws-item' + (isPast ? ' is-past' : '')}
                        onClick={(e) => onOccClick(o, e.currentTarget.getBoundingClientRect())}
                      >
                        <span className="rk-pl-ws-dot" style={{ '--c': `var(--s${(o.color % 7) + 1})` }} aria-hidden="true" />
                        <span className="rk-pl-ws-body">
                          <span className="rk-pl-ws-time rk-num">{fmtTime(o.start)}</span>
                          <span className="rk-pl-ws-title">
                            {o.important && <Star size={11} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />}
                            {o.title}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  <button type="button" className="rk-pl-ws-fill" aria-label="일정 추가" onClick={() => onAddSlot?.(d)} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
