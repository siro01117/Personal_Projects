'use client';

// /plan 기본 화면 — 오늘 타임라인 + 이번 주(월~일)(좌) / 특별한 약속 + 언젠가 할 일(우, 보조 패널).
// PC(>1024) 2단, 모바일은 오늘 → 특별한 약속 → 7일 → 언젠가 할 일 순 단일 컬럼(globals.css 의
// .rk-pl-ov 가 그리드 순서를 맡고, 여기서는 DOM 순서만 모바일 기준으로 둔다 — order 로 PC 만 조정).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, CalendarDays, CalendarHeart, ChevronDown, ChevronRight, ClipboardList, Clock, Plus, Utensils,
} from 'lucide-react';
import {
  addDaysISO, diffDaysISO, dowOf, expand, fmtTime, nowMinutes, todayISO, weekDays, weekLabel,
} from '../../lib/plan-core';
import WeekNav from './WeekNav';
import { suggest } from '../../lib/plan-suggest';
import { shortDate, shortSlot } from './format';
import { Empty, Tag } from '../study/parts';
import WeekStrip from './WeekStrip';
import { mealSlots, travelBlocks } from '../../lib/plan-suggest';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function dueText(due) {
  if (!due) return { text: '기한 없음', tone: null, days: 9e9 };
  const t = todayISO();
  const d = diffDaysISO(t, due);
  if (d < 0) return { text: `${-d}일 지남`, tone: 'bad', days: d };
  if (d === 0) return { text: '오늘까지', tone: 'warn', days: d };
  if (d === 1) return { text: '내일까지', tone: 'warn', days: d };
  return { text: `${d}일 남음`, tone: null, days: d };
}
function dDay(dateISO) {
  const d = diffDaysISO(todayISO(), dateISO);
  if (d === 0) return '오늘';
  if (d === 1) return '내일';
  if (d < 0) return `${-d}일 전`;
  return `D-${d}`;
}

export default function Overview({
  data, classes, shifts, onOccClick, onAddEvent, onAddTask, onToggleTask, onQuickPlaceTask,
  onQuickAddTask, onGoLater, onGoWeek, onEditTask, weekOffset = 0, onWeekOffset,
}) {
  const today = todayISO();
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((v) => v + 1), 60000);
    return () => clearInterval(id);
  }, []);
  const now = nowMinutes();
  const settings = data.settings;

  // 주 띠는 월~일 고정. 오늘을 맨 앞에 두지 않고, ‹ › 로 다음 주·지난 주를 본다
  const week7 = useMemo(() => weekDays(addDaysISO(today, 7 * weekOffset)), [today, weekOffset]);
  const weekOcc = useMemo(() => expand(data, classes, week7[0], week7[6], shifts), [data, classes, shifts, week7]);
  // 오늘 타임라인은 보고 있는 주와 무관하게 늘 오늘 — 주를 넘겨도 비면 안 된다
  const todayOcc = useMemo(
    () => expand(data, classes, today, today, shifts).sort((a, b) => (a.start ?? -1) - (b.start ?? -1)),
    [data, classes, shifts, today],
  );
  const importantOcc = useMemo(
    () => expand(data, classes, today, addDaysISO(today, 180), shifts).filter((o) => o.important).slice(0, 8),
    [data, classes, shifts, today],
  );

  const openTasks = data.tasks.filter((t) => !t.done);
  const someday = useMemo(() => {
    const open = openTasks.filter((t) => !t.slot);
    return [...open].sort((a, b) => {
      const da = a.due || '9999-99-99', db = b.due || '9999-99-99';
      if (da !== db) return da < db ? -1 : 1;
      const rank = { high: 0, normal: 1, low: 2 };
      return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.tasks]);

  const isEmpty = data.events.length === 0 && data.tasks.length === 0;

  // 우선순위 순으로 순차 배정 — 앞 할 일의 제안 슬롯을 가상 occurrence 로 넣고 다음 계산에 반영.
  const somedaySuggestions = useMemo(() => {
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
  }, [someday, data, classes, shifts, today, settings, now]);

  // 오늘 타임라인의 빈 구간([gapStart,gapEnd))에 실제로 들어맞는 '언젠가 할 일' 후보 하나 —
  // somedaySuggestions(각 할 일의 suggest() 후보들)와 같은 소스를 써서, 칩의 제안과 목록의
  // 제안이 서로 다른 슬롯을 가리키지 않게 한다.
  const gapSuggestion = (gapStart, gapEnd) => {
    for (const t of someday) {
      const cands = somedaySuggestions.get(t.id) || [];
      const hit = cands.find((c) => c.date === today && c.start >= gapStart && c.start < gapEnd);
      if (hit) return { task: t, cand: hit };
    }
    return null;
  };

  const current = todayOcc.find((o) => !o.allDay && o.start != null && now >= o.start && now < o.end);
  const upcoming = todayOcc.find((o) => !o.allDay && o.start != null && o.start > now);
  const emptyTodaySug = !current && !upcoming ? gapSuggestion(now, settings.dayEnd) : null;

  const timeline = useMemo(() => {
    const timed = todayOcc.filter((o) => !o.allDay && o.start != null);
    const allDay = todayOcc.filter((o) => o.allDay);
    const past = [];
    const remaining = [];

    const pushGap = (start, end) => {
      if (end <= start) return;
      const from = Math.max(start, now);
      if (end - from < 60) return;
      remaining.push({ type: 'gap', start: from, end, sug: gapSuggestion(from, end) });
    };

    // 이동 구간도 줄 하나로 세운다. 빈 시간처럼 보이면 안 되고(실제로는 못 쓰는 시간),
    // 제안 엔진이 쓰는 계산(plan-suggest 의 travelBlocks)과 같은 걸 써야 화면과 제안이 어긋나지 않는다.
    const rows = [
      ...timed.map((o) => ({ type: 'occ', occ: o, start: o.start, end: o.end })),
      ...travelBlocks(todayOcc, today, settings).map(([a, b, label]) => ({ type: 'travel', start: a, end: b, label })),
      // 식사는 고정 일정이 아니지만 빈 시간을 나눠 보여준다(그 시간엔 먹는다)
      ...mealSlots(todayOcc, today, settings).filter((m) => !m.covered).map((m) => ({ type: 'meal', ...m })),
    ].sort((a, b) => a.start - b.start || (a.type === 'travel' ? -1 : 1));

    let prevEnd = settings.dayStart;
    for (const row of rows) {
      if (row.end <= now) {
        if (row.type === 'occ') past.push(row);   // 지난 이동까지 접힌 목록에 넣으면 시끄럽다
        prevEnd = Math.max(prevEnd, row.end);
        continue;
      }
      pushGap(prevEnd, row.start);
      remaining.push(row);
      prevEnd = Math.max(prevEnd, row.end);
    }
    pushGap(prevEnd, settings.dayEnd);
    return { allDay, past, remaining };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayOcc, settings, someday, somedaySuggestions, now, today]);

  const remainingCount = todayOcc.filter((o) => (o.allDay || o.end > now)).length;

  return (
    <div className="rk-pl-ov">
      <div className="rk-pl-toolbar">
        <div className="rk-pl-toolbar-date">
          <p className="rk-pl-toolbar-day">{Number(today.slice(5, 7))}월 {Number(today.slice(8, 10))}일 {DOW[dowOf(today)]}요일</p>
          <p className="rk-pl-toolbar-sum">남은 일정 <b className="rk-num">{remainingCount}</b> · 할 일 <b className="rk-num">{openTasks.length}</b></p>
        </div>
        <div className="rk-pl-toolbar-actions rk-pl-add-desktop">
          <button type="button" className="rk-btn rk-btn-fill" style={{ marginTop: 0 }} onClick={() => onAddEvent()}>
            <Plus size={16} strokeWidth={1.5} aria-hidden="true" />일정
          </button>
          <button type="button" className="rk-btn" onClick={() => onAddTask()}>
            <Plus size={16} strokeWidth={1.5} aria-hidden="true" />할 일
          </button>
        </div>
      </div>

      {isEmpty && (
        <section className="rk-block rk-pl-onboard">
          <p className="rk-pl-onboard-t">일정을 채우면 여기서 오늘 할 일과 빈 시간을 알려줍니다</p>
          {classes.length > 0 && data.settings.showClasses && (
            <p className="rk-pl-onboard-note">학습 모듈 시간표 {classes.length}개를 불러왔습니다</p>
          )}
          <div className="rk-pl-onboard-actions">
            <button type="button" className="rk-btn" onClick={() => onAddEvent({ repeat: true })}>반복 일정 추가</button>
            <button type="button" className="rk-btn" onClick={() => onAddEvent({ important: true })}>약속 추가</button>
            <button type="button" className="rk-btn rk-btn-fill" style={{ marginTop: 0 }} onClick={() => onAddTask()}>할 일 적기</button>
          </div>
        </section>
      )}

      <div className="rk-pl-ov-main">
        <section className="rk-block">
          <h2 className="rk-h2"><Clock size={16} strokeWidth={1.5} aria-hidden="true" />오늘</h2>

          <div className="rk-pl-nowcard">
            {current ? (
              <>
                <span className="rk-pl-nowcard-tag"><span className="rk-dot" style={{ '--c': 'var(--ok)' }} aria-hidden="true" />진행 중</span>
                <span className="rk-pl-nowcard-t">{current.title}</span>
                <span className="rk-pl-nowcard-m rk-num">{fmtTime(current.end)}까지 · {current.end - now}분 남음</span>
              </>
            ) : upcoming ? (
              <>
                <span className="rk-pl-nowcard-tag is-next"><span className="rk-dot" style={{ '--c': 'var(--mut)' }} aria-hidden="true" />다음</span>
                <span className="rk-pl-nowcard-t">{upcoming.title}</span>
                <span className="rk-pl-nowcard-m rk-num">{fmtTime(upcoming.start)} · {upcoming.start - now}분 후</span>
              </>
            ) : (
              <>
                <span className="rk-pl-nowcard-empty">오늘 남은 일정 없음</span>
                {emptyTodaySug && (
                  <button
                    type="button" className="rk-pl-gap-sug rk-pl-nowcard-sug"
                    onClick={() => onQuickPlaceTask(emptyTodaySug.task.id, { date: emptyTodaySug.cand.date, start: emptyTodaySug.cand.start })}
                  >
                    <b className="rk-num">{shortSlot(emptyTodaySug.cand.date, emptyTodaySug.cand.start, today)}</b> &lsquo;{emptyTodaySug.task.title}&rsquo; 넣기
                  </button>
                )}
              </>
            )}
          </div>

          {todayOcc.length === 0 ? (
            <Empty title="오늘은 일정이 없습니다" hint="아래 이번 주 일정이나 [+ 일정] 으로 추가해 보세요." />
          ) : (
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
                  const mins = row.end - row.start;
                  return (
                    <div key={`tv-${i}`} className={'rk-pl-travel-row' + (row.label === '외출 준비' ? ' is-prep' : '')}>
                      <span className="rk-pl-travel-at rk-num">{fmtTime(row.start)}</span>
                      <ArrowRight size={13} strokeWidth={1.5} aria-hidden="true" />
                      <span>{row.label} <b className="rk-num">{mins}</b>분</span>
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
                      {row.sug && (
                        <button
                          type="button" className="rk-pl-gap-sug"
                          onClick={() => onQuickPlaceTask(row.sug.task.id, { date: row.sug.cand.date, start: row.sug.cand.start })}
                        >
                          <b className="rk-num">{shortSlot(row.sug.cand.date, row.sug.cand.start, today)}</b> &lsquo;{row.sug.task.title}&rsquo; 넣기
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
          )}
        </section>

        <section className="rk-block">
          <h2 className="rk-h2">
            <CalendarDays size={16} strokeWidth={1.5} aria-hidden="true" />{weekLabel(weekOffset)} 일정
            <WeekNav offset={weekOffset} onChange={onWeekOffset} />
            <button type="button" className="rk-h2-link" onClick={onGoWeek}>
              시간표로 보기<ChevronRight size={13} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </h2>
          <WeekStrip
            occurrences={weekOcc} days={week7} today={today} now={now}
            onOccClick={onOccClick}
            onAddSlot={(date) => onAddEvent({ date })}
          />
        </section>
      </div>

      <div className="rk-pl-ov-side">
        <section className="rk-block">
          <h2 className="rk-h2"><CalendarHeart size={16} strokeWidth={1.5} aria-hidden="true" />특별한 약속</h2>
          {importantOcc.length === 0 ? (
            <Empty title="표시된 특별한 약속이 없습니다" hint="중요 표시한 약속은 멀어도 여기 모입니다 — 일정을 추가할 때 '특별한 약속'을 켜 보세요." />
          ) : (
            <ul className="rk-pl-imp">
              {importantOcc.map((o) => (
                <li key={o.key}>
                  <button type="button" onClick={(e) => onOccClick(o, e.currentTarget.getBoundingClientRect())} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left' }}>
                    <span className="rk-pl-imp-d rk-num">{dDay(o.date)}</span>
                    <span className="rk-pl-imp-body">
                      <span className="rk-pl-imp-t">{o.title}</span>
                      <span className="rk-pl-imp-m">
                        <span className="rk-num">{shortDate(o.date)}</span> · <span className="rk-num">{o.allDay ? '종일' : `${fmtTime(o.start)}–${fmtTime(o.end)}`}</span>
                        {o.place ? ` · ${o.place}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rk-block">
          <h2 className="rk-h2"><ClipboardList size={16} strokeWidth={1.5} aria-hidden="true" />언젠가 할 일{someday.length > 0 && <span className="rk-h2-note rk-num">{someday.length}</span>}</h2>
          {someday.length === 0 ? (
            <Empty title="날짜 없는 할 일이 없습니다" hint="마감이나 시간이 정해지지 않은 일은 여기서 제안받아 배치할 수 있습니다." />
          ) : (
            <ul className="rk-pl-someday">
              {someday.slice(0, 6).map((t) => (
                <SomedayRow
                  key={t.id} task={t} candidates={somedaySuggestions.get(t.id) || []}
                  onToggleTask={onToggleTask} onQuickPlaceTask={onQuickPlaceTask} onEditTask={onEditTask}
                />
              ))}
            </ul>
          )}
          {someday.length > 6 && (
            <button type="button" className="rk-more" onClick={onGoLater}>나머지 {someday.length - 6}개</button>
          )}
          <QuickAddTask onAdd={onQuickAddTask} />
        </section>
      </div>
    </div>
  );
}

function OccRow({ occ: o, live, past, onOccClick }) {
  return (
    <button
      type="button"
      className={'rk-ses' + (live ? ' is-live' : '') + (past ? ' is-past' : '') + (o.important ? ' is-important' : '')}
      style={{ '--c': `var(--s${(o.color % 7) + 1})` }}
      onClick={(e) => onOccClick(o, e.currentTarget.getBoundingClientRect())}
    >
      <span className="rk-ses-time rk-num">{o.allDay ? '종일' : fmtTime(o.start)}</span>
      <span className="rk-ses-body">
        <span className="rk-ses-name">
          <span className="rk-dot" style={{ '--c': `var(--s${(o.color % 7) + 1})` }} aria-hidden="true" />
          {o.title}
        </span>
        <span className="rk-ses-meta">{o.place || (o.source === 'task' ? '할 일' : '')}</span>
      </span>
      {live && <span className="rk-ses-live">진행 중</span>}
    </button>
  );
}

function SomedayRow({ task: t, candidates, onToggleTask, onQuickPlaceTask, onEditTask }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customDate, setCustomDate] = useState(todayISO());
  const [customTime, setCustomTime] = useState('09:00');
  const due = dueText(t.due);
  const top = candidates[0];

  function place(date, start) {
    onQuickPlaceTask(t.id, { date, start });
    setOpen(false);
  }
  function placeCustom() {
    const m = String(customTime || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return;
    place(customDate, Number(m[1]) * 60 + Number(m[2]));
  }

  return (
    <li>
      <div className="rk-pl-sd-row">
        <input type="checkbox" checked={false} onChange={() => onToggleTask(t.id)} aria-label="완료" />
        <button type="button" className="rk-pl-sd-body" onClick={() => onEditTask?.(t)}>
          <span className="rk-pl-sd-t">{t.title}</span>
          <span className="rk-pl-sd-m">
            <span className="rk-num">{t.duration}분</span>
            {t.due && <Tag tone={due.tone}>{due.text}</Tag>}
            {t.priority === 'high' && <Tag tone="bad">중요</Tag>}
          </span>
        </button>
        <div className="rk-pl-sd-actions">
          {top && (
            <button type="button" className="rk-pl-sd-sug-btn" onClick={() => place(top.date, top.start)}>
              {shortSlot(top.date, top.start, todayISO())}에 넣기
            </button>
          )}
          <button
            type="button" className={'rk-pl-sd-more' + (open ? ' is-on' : '')}
            aria-label="다른 시간" aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .16s' }} />
          </button>
        </div>
      </div>
      {open && (
        <div className="rk-pl-sd-expand">
          {candidates.length > 0 ? (
            <div className="rk-pl-cands">
              {candidates.map((c) => (
                <button key={`${c.date}-${c.start}`} type="button" className="rk-pl-cand" onClick={() => place(c.date, c.start)}>
                  <span className="rk-pl-cand-d rk-num">{shortSlot(c.date, c.start, todayISO())}</span>
                  {c.reasons?.length > 0 && <span className="rk-pl-cand-r">{c.reasons.slice(0, 2).join(' · ')}</span>}
                </button>
              ))}
            </div>
          ) : (
            <p className="rk-pl-hint">14일 안에서는 빈 시간을 찾지 못했습니다.</p>
          )}
          <button type="button" className="rk-pl-more-link" onClick={() => setCustom((v) => !v)}>
            {custom ? '직접 고르기 접기' : '직접 고르기'}
          </button>
          {custom && (
            <div className="rk-pl-picker" style={{ marginTop: 8 }}>
              <input className="rk-input" type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
              <input className="rk-input" type="time" value={customTime} onChange={(e) => setCustomTime(e.target.value)} />
              <button type="button" className="rk-btn" onClick={placeCustom}>넣기</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function QuickAddTask({ onAdd }) {
  const [title, setTitle] = useState('');
  // 소요시간은 입력 중엔 raw 문자열 그대로. 숫자 보정은 blur·저장 때만. 비우면 60분.
  const [dur, setDur] = useState('60');
  const ref = useRef(null);

  const parseDur = (v) => {
    const n = Math.round(Number(String(v).replace(/[^0-9]/g, '')));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : 60;
  };

  function submit() {
    const v = title.trim();
    if (!v) { ref.current?.focus(); return; }
    const d = parseDur(dur);
    onAdd(v, d);
    setDur(String(d));
    setTitle('');
    ref.current?.focus();
  }

  const onEnter = (e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(); };

  return (
    <div className="rk-pl-qa">
      <input
        ref={ref} type="text" className="rk-pl-qa-t" placeholder="할 일 적기" aria-label="할 일"
        value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={onEnter}
      />
      <label className="rk-pl-qa-d">
        <input
          type="text" inputMode="numeric" aria-label="걸리는 시간(분)" value={dur}
          onChange={(e) => setDur(e.target.value)}
          onBlur={() => setDur(String(parseDur(dur)))}
          onKeyDown={onEnter}
        />
        <span>분</span>
      </label>
      <button type="button" className="rk-pl-qa-go" onClick={submit} disabled={!title.trim()}>
        <Plus size={18} strokeWidth={1.5} aria-hidden="true" />추가
      </button>
    </div>
  );
}
