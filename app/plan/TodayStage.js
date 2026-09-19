'use client';

/* ---------------------------------------------------------------------------
   /plan?v=today — 오늘 스테이지.

   목표는 하나: **지금 뭘 해야 하는지 바로 안다.**
   맨 위 한 문장이 지금 할 일이다. 수업 중이면 언제 끝나는지, 준비할 때면 언제 나가야 하는지,
   비어 있으면 이 틈에 할 만한 것. 그 아래가 오늘 전체 흐름이다('다음' 목록은 흐름과 겹쳐 뺐다). 개요의 '오늘' 칸은 요약만 두고 자세한 건 여기서 본다.
--------------------------------------------------------------------------- */

import { useMemo } from 'react';
import { ArrowRight, CircleDot, NotebookPen, Plus } from 'lucide-react';
import { addDaysISO, diffDaysISO, dowOf, expand, fmtTime, todayISO } from '../../lib/plan-core';
import { mealSlots, travelBlocks } from '../../lib/plan-suggest';
import { Empty, Tag } from '../study/parts';
import {
  PlaceTag, TodayTimeline, buildTimeline, dur, pickGapSuggestion, useNow, useSomeday, useSomedaySuggestions,
} from './todayShared';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];


// 오늘 하루를 한 줄로 펼친 조각들 — 일정 · 이동 · 준비 · 식사. 지금이 어느 조각 안인지 찾는 데 쓴다.
function segmentsOf(todayOcc, today, settings) {
  const segs = [
    ...todayOcc.filter((o) => !o.allDay && o.start != null && o.end != null)
      .map((o) => ({ kind: 'occ', start: o.start, end: o.end, title: o.title, place: o.place, occ: o })),
    ...travelBlocks(todayOcc, today, settings).map(([start, end, label]) => ({
      kind: label === '외출 준비' ? 'prep' : 'move', start, end, title: label,
    })),
    ...mealSlots(todayOcc, today, settings).filter((m) => !m.covered && !m.missing)
      .map((m) => ({ kind: 'meal', start: m.start, end: m.end, title: m.label })),
  ];
  const rank = { occ: 0, prep: 1, move: 1, meal: 2 };
  return segs.sort((a, b) => a.start - b.start || rank[a.kind] - rank[b.kind]);
}

// 조각 이름 — 일정은 제목, 나머지는 행위
const segName = (s) => (s.kind === 'meal' ? `${s.title} 먹기` : s.title);

export default function TodayStage({
  data, classes, shifts, onOccClick, onQuickPlaceTask, onToggleTask, onEditTask, onAddEvent,
}) {
  const today = todayISO();
  const now = useNow();
  // 오늘 수업이 있는 과목. 일정이 이미 아는 것이라 따로 고를 일이 없다.
  const todayClasses = useMemo(
    () => (classes || []).filter((c) => (c.meetings || []).some((m) => m.day === dowOf(today))),
    [classes, today],
  );
  const settings = data.settings;

  const todayOcc = useMemo(
    () => expand(data, classes, today, today, shifts).sort((a, b) => (a.start ?? -1) - (b.start ?? -1)),
    [data, classes, shifts, today],
  );
  const tomorrow = addDaysISO(today, 1);
  const tomorrowFirst = useMemo(
    () => expand(data, classes, tomorrow, tomorrow, shifts)
      .filter((o) => !o.allDay && o.start != null).sort((a, b) => a.start - b.start)[0] || null,
    [data, classes, shifts, tomorrow],
  );

  const someday = useSomeday(data.tasks);
  const suggestions = useSomedaySuggestions({ data, classes, shifts, today, now, someday });
  const gapSuggestion = (from, to) => pickGapSuggestion({ someday, suggestions, today, from, to });

  const segs = useMemo(() => segmentsOf(todayOcc, today, settings), [todayOcc, today, settings]);
  const current = segs.find((s) => now >= s.start && now < s.end) || null;
  const upcoming = segs.filter((s) => s.start >= (current ? current.end : now) && s !== current).slice(0, 4);
  const nextOcc = segs.find((s) => s.kind === 'occ' && s.start >= now);

  const timeline = useMemo(
    () => buildTimeline({ todayOcc, settings, now, today, gapSuggestion }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [todayOcc, settings, now, today, suggestions],
  );

  // 오늘 챙길 할 일 — 오늘 넣어둔 것 + 마감이 오늘이거나 지난 것
  const todayTasks = data.tasks.filter((t) => !t.done
    && ((t.slot && t.slot.date === today) || (!t.slot && t.due && t.due <= today)));

  /* --------------------------------------------------------- 지금 한 문장 */
  let stage;
  if (current) {
    const left = current.end - now;
    if (current.kind === 'occ') {
      stage = {
        tone: 'live',
        title: current.title,
        sub: `${current.place ? `${current.place} · ` : ''}${fmtTime(current.end)}까지 · ${dur(left)} 남음`,
      };
    } else if (current.kind === 'prep') {
      const go = segs.find((s) => s.kind === 'move' && s.start >= current.end - 1);
      const target = segs.find((s) => s.kind === 'occ' && s.start >= current.end);
      stage = {
        tone: 'prep',
        title: '나갈 준비',
        sub: `${fmtTime(current.end)}에 출발${go ? ` · ${go.title} ${dur(go.end - go.start)}` : ''}${target ? ` → ${target.title} ${fmtTime(target.start)}` : ''}`,
      };
    } else if (current.kind === 'move') {
      stage = {
        tone: 'move',
        title: `${current.title} 중`,
        sub: `${fmtTime(current.end)} 도착${nextOcc ? ` · ${nextOcc.title} ${fmtTime(nextOcc.start)}` : ''}`,
      };
    } else {
      stage = {
        tone: 'meal',
        title: `${current.title} 먹을 시간`,
        sub: `${fmtTime(current.end)}까지${upcoming[0] ? ` · 다음 ${segName(upcoming[0])} ${fmtTime(upcoming[0].start)}` : ''}`,
      };
    }
  } else if (upcoming[0] && now < settings.dayStart) {
    // 하루 시작 전(새벽) — '비어 있다'가 아니라 오늘 첫 흐름을 알려준다
    const first = upcoming[0];
    const firstOcc = segs.find((x) => x.kind === 'occ');
    stage = {
      tone: 'free',
      title: '아직 하루 전',
      sub: `${fmtTime(first.start)} ${segName(first)}${firstOcc && firstOcc !== first ? ` → ${fmtTime(firstOcc.start)} ${firstOcc.title}` : ''}`,
    };
  } else if (upcoming[0]) {
    const next = upcoming[0];
    stage = {
      tone: 'free',
      title: '비어 있는 시간',
      sub: `${fmtTime(next.start)} ${segName(next)}까지 ${dur(next.start - now)}`,
      sug: gapSuggestion(now, next.start),
    };
  } else {
    stage = {
      tone: 'done',
      title: '오늘 일정은 끝났습니다',
      sub: tomorrowFirst
        ? `내일(${DOW[dowOf(tomorrow)]}) 첫 일정 ${fmtTime(tomorrowFirst.start)} ${tomorrowFirst.title}`
        : '내일은 잡힌 일정이 없습니다',
      sug: gapSuggestion(now, settings.dayEnd),
    };
  }

  return (
    <div className="rk-pl-today">
      <section className={`rk-pl-stage is-${stage.tone}`} aria-live="polite">
        <p className="rk-pl-stage-now rk-num">
          <CircleDot size={14} strokeWidth={1.75} aria-hidden="true" />
          {Number(today.slice(5, 7))}월 {Number(today.slice(8, 10))}일 {DOW[dowOf(today)]} · 지금 {fmtTime(now)}
        </p>
        <h1 className="rk-pl-stage-t">{stage.title}</h1>
        <p className="rk-pl-stage-s rk-num">{stage.sub}</p>
        {stage.sug && (
          <button
            type="button" className="rk-btn rk-pl-stage-act"
            onClick={() => onQuickPlaceTask(stage.sug.task.id, { date: stage.sug.cand.date, start: stage.sug.cand.start })}
          >
            <Plus size={15} strokeWidth={1.5} aria-hidden="true" />
            {fmtTime(stage.sug.cand.start)}에 &lsquo;{stage.sug.task.title}&rsquo; ({dur(stage.sug.task.duration)}) 하기
          </button>
        )}
      </section>

      <div className="rk-pl-today-cols">
        <div className="rk-pl-today-main">
          <section className="rk-block">
            <h2 className="rk-h2">오늘 흐름</h2>
            {todayOcc.length === 0 ? (
              <Empty title="오늘은 일정이 없습니다">
                <button type="button" className="rk-btn" onClick={() => onAddEvent()}>
                  <Plus size={15} strokeWidth={1.5} aria-hidden="true" />일정 추가
                </button>
              </Empty>
            ) : (
              <TodayTimeline
                timeline={timeline} now={now} today={today}
                onOccClick={onOccClick} onQuickPlaceTask={onQuickPlaceTask}
              />
            )}
          </section>
        </div>

        <aside className="rk-pl-today-side">
          {todayClasses.length > 0 && (
            <section className="rk-block">
              <h2 className="rk-h2">오늘 수업 정리</h2>
              <ul className="rk-pl-study">
                {todayClasses.map((c) => (
                  <li key={c.id}>
                    <a className="rk-pl-study-l" href={`/study?c=${encodeURIComponent(c.id)}&t=notes`}>
                      <NotebookPen size={15} strokeWidth={1.5} aria-hidden="true" />
                      <span>{c.name}</span>
                      <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
              <p className="rk-pl-study-h">수업이 끝난 날 채우는 게 제일 잘 남는다.</p>
            </section>
          )}

          <section className="rk-block">
            <h2 className="rk-h2">오늘 챙길 할 일{todayTasks.length > 0 && <span className="rk-h2-note rk-num">{todayTasks.length}</span>}</h2>
            {todayTasks.length === 0 ? (
              <Empty title="오늘 챙길 할 일이 없습니다" hint="오늘 넣어둔 할 일과 마감이 오늘까지인 할 일이 여기 모입니다." />
            ) : (
              <ul className="rk-pl-today-tasks">
                {todayTasks.map((t) => {
                  const d = t.due ? diffDaysISO(today, t.due) : null;
                  return (
                    <li key={t.id}>
                      <input type="checkbox" checked={false} onChange={() => onToggleTask(t.id)} aria-label={`${t.title} 완료`} />
                      <button type="button" onClick={() => onEditTask(t)}>
                        <span className="rk-pl-today-task-t">{t.title}</span>
                        <span className="rk-pl-today-task-m rk-num">
                          {t.slot ? `${fmtTime(t.slot.start)} · ` : ''}{dur(t.duration)}
                          <PlaceTag settings={settings} item={t} />
                          {d != null && d < 0 && <Tag tone="bad">{-d}일 지남</Tag>}
                          {d === 0 && <Tag tone="warn">오늘까지</Tag>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
