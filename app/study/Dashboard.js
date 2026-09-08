'use client';

// 대시보드 — /study 의 기본 화면. 오늘 / 이번 주 / 할 일 / 충돌 / 과목 그리드.
import { useMemo } from 'react';
import { ArrowRight, CalendarDays, ClipboardList, Clock, Layers, TriangleAlert } from 'lucide-react';
import { dayName, fmtTime, sessionsOfDay, todayISO } from '../../lib/study';
import { Dot, Empty, Notice, Tag } from './parts';

const DAYS = [1, 2, 3, 4, 5];   // 월~금. 주말 수업이 있으면 아래에서 자동으로 붙는다.

// 마감일 → 사람이 읽는 문구. 지난 것은 며칠 지났는지 알려준다.
function dueText(due) {
  if (!due) return { text: '기한 없음', tone: null, days: 9e9 };
  const t = todayISO();
  const d = Math.round((new Date(`${due}T00:00:00`) - new Date(`${t}T00:00:00`)) / 864e5);
  if (Number.isNaN(d)) return { text: due, tone: null, days: 9e9 };
  if (d < 0) return { text: `${-d}일 지남`, tone: 'bad', days: d };
  if (d === 0) return { text: '오늘까지', tone: 'warn', days: d };
  if (d === 1) return { text: '내일까지', tone: 'warn', days: d };
  return { text: `${d}일 남음`, tone: null, days: d };
}

const isPast = (date) => !!date && date <= todayISO();

function SessionRow({ course, session, now, onOpen }) {
  const live = now != null && session.start != null && session.end != null
    && now >= session.start && now < session.end;
  return (
    <button
      type="button"
      className={'rk-ses' + (live ? ' is-live' : '')}
      style={{ '--c': `var(--s${((course.colorIndex || 0) % 7) + 1})` }}
      onClick={() => onOpen(course.id)}
    >
      <span className="rk-ses-time rk-num">
        {session.start != null ? fmtTime(session.start) : '--:--'}
      </span>
      <span className="rk-ses-body">
        <span className="rk-ses-name"><Dot course={course} />{course.name}</span>
        <span className="rk-ses-meta">
          {[session.room || course.room, course.professor].filter(Boolean).join(' · ') || '정보 없음'}
        </span>
      </span>
      {live && <span className="rk-ses-live">진행 중</span>}
      <ArrowRight size={16} strokeWidth={1.5} className="rk-ses-go" aria-hidden="true" />
    </button>
  );
}

export default function Dashboard({ data, week, onOpenCourse, onToggleTodo, todoLimit, onAllTodos }) {
  const now = useMemo(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }, []);
  const today = new Date().getDay();

  const todaySessions = useMemo(() => sessionsOfDay(data, today), [data, today]);

  // 실제로 수업이 있는 요일만 보여준다. 주말 수업이 있으면 그것도 나온다.
  const weekDays = useMemo(() => {
    const used = new Set();
    for (const c of data.courses) for (const s of c.meetings) if (s.day != null) used.add(s.day);
    const days = [...new Set([...DAYS.filter((d) => used.has(d)), ...used])].sort((a, b) => a - b);
    return days.length ? days : DAYS;
  }, [data]);

  const todos = useMemo(() => {
    const open = data.todos.filter((t) => !t.done)
      .sort((a, b) => dueText(a.due).days - dueText(b.due).days);
    const done = data.todos.filter((t) => t.done);
    return { open, done };
  }, [data.todos]);

  const courseName = (id) => data.courses.find((c) => c.id === id)?.name || '';
  // '미정리' = 이미 열렸는데 아직 정리(summary)가 없는 차시. 앞으로 있을 수업은 세지 않는다.
  const unorganized = (c) => (c.lessons || []).filter((l) => !l.summary && isPast(l.date)).length;
  const nextSession = (c) => {
    const list = [...(c.meetings || [])].filter((s) => s.day != null)
      .sort((a, b) => (a.day - b.day) || ((a.start ?? 0) - (b.start ?? 0)));
    if (!list.length) return null;
    const upcoming = list.find((s) => s.day > today || (s.day === today && (s.start ?? 0) >= now));
    return upcoming || list[0];
  };

  return (
    <>
      <section className="rk-block">
        <h2 className="rk-h2"><Clock size={16} strokeWidth={1.5} aria-hidden="true" />오늘 · {dayName(today)}요일</h2>
        {todaySessions.length === 0 ? (
          <Empty title="오늘은 수업이 없습니다" hint="이번 주 시간표에서 다른 요일을 확인해 보세요." />
        ) : (
          <div className="rk-ses-list">
            {todaySessions.map(({ course, session }) => (
              <SessionRow key={`${course.id}-${session.id}`} course={course} session={session}
                now={now} onOpen={onOpenCourse} />
            ))}
          </div>
        )}
      </section>

      <section className="rk-block">
        <h2 className="rk-h2">
          <CalendarDays size={16} strokeWidth={1.5} aria-hidden="true" />
          이번 주
          {week != null && <span className="rk-h2-note rk-num">{week}주차</span>}
        </h2>
        {data.courses.length === 0 ? (
          <Empty title="시간표가 비어 있습니다" hint="학습 데이터가 아직 등록되지 않았습니다." />
        ) : (
          <div className="rk-week">
            {weekDays.map((d) => {
              const list = sessionsOfDay(data, d);
              return (
                <div key={d} className={'rk-week-col' + (d === today ? ' is-today' : '')}>
                  <div className="rk-week-h">{dayName(d)}</div>
                  {list.length === 0 ? (
                    <p className="rk-week-none">—</p>
                  ) : list.map(({ course, session }) => (
                    <button
                      key={`${course.id}-${session.id}`} type="button" className="rk-week-item"
                      style={{ '--c': `var(--s${((course.colorIndex || 0) % 7) + 1})` }}
                      onClick={() => onOpenCourse(course.id)}
                    >
                      <span className="rk-num">{session.start != null ? fmtTime(session.start) : '--:--'}</span>
                      <span className="rk-week-nm">{course.name}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {data.conflicts.length > 0 && (
        <section className="rk-block">
          <h2 className="rk-h2"><TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />충돌 경고</h2>
          <ul className="rk-conflicts">
            {data.conflicts.map((c) => (
              <li key={c.id}>
                <span className="rk-conflict-h">
                  {c.week != null && <b className="rk-num">{c.week}주차</b>}
                  {c.date && <b className="rk-num">{c.date}</b>}
                  {c.title || '일정이 겹칩니다'}
                </span>
                {c.detail && <span className="rk-conflict-d">{c.detail}</span>}
                {c.courseIds.length > 0 && (
                  <span className="rk-conflict-c">{c.courseIds.map(courseName).filter(Boolean).join(' · ')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rk-block" id="todos">
        <h2 className="rk-h2">
          <ClipboardList size={16} strokeWidth={1.5} aria-hidden="true" />
          할 일
          {todos.open.length > 0 && <span className="rk-h2-note rk-num">{todos.open.length}</span>}
        </h2>
        {data.todos.length === 0 ? (
          <Empty title="할 일이 없습니다" hint="과제나 시험 일정이 등록되면 마감 순으로 여기에 모입니다." />
        ) : (
          <>
            <ul className="rk-todos">
              {(todoLimit ? todos.open.slice(0, todoLimit) : todos.open).map((t) => {
                const due = dueText(t.due);
                return (
                  <li key={t.id}>
                    <label className="rk-todo">
                      <input type="checkbox" checked={false} onChange={() => onToggleTodo(t.id)} />
                      <span className="rk-todo-body">
                        <span className="rk-todo-t">{t.title}</span>
                        <span className="rk-todo-m">
                          {t.courseId && courseName(t.courseId) && <span>{courseName(t.courseId)}</span>}
                          <Tag tone={due.tone}>{due.text}</Tag>
                          {t.priority === 'high' && <Tag tone="bad">중요</Tag>}
                        </span>
                        {t.detail && <span className="rk-todo-d">{t.detail}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {todoLimit && todos.open.length > todoLimit && (
              <button type="button" className="rk-more" onClick={onAllTodos}>
                남은 {todos.open.length - todoLimit}건 더 보기
              </button>
            )}
            {todos.done.length > 0 && (
              <details className="rk-done">
                <summary>완료 <b className="rk-num">{todos.done.length}</b></summary>
                <ul className="rk-todos is-done">
                  {todos.done.map((t) => (
                    <li key={t.id}>
                      <label className="rk-todo">
                        <input type="checkbox" checked readOnly onChange={() => onToggleTodo(t.id)} />
                        <span className="rk-todo-body"><span className="rk-todo-t">{t.title}</span></span>
                      </label>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      <section className="rk-block">
        <h2 className="rk-h2">
          <Layers size={16} strokeWidth={1.5} aria-hidden="true" />
          과목
          {data.courses.length > 0 && <span className="rk-h2-note rk-num">{data.courses.length}</span>}
        </h2>
        {data.courses.length === 0 ? (
          <Empty
            title="등록된 과목이 없습니다"
            hint="public/study-seed.json 이 준비되면 첫 접속 때 자동으로 불러옵니다."
          />
        ) : (
          <div className="rk-cgrid">
            {data.courses.map((c) => {
              const ns = nextSession(c);
              const left = unorganized(c);
              return (
                <button
                  key={c.id} type="button" className="rk-ccard"
                  style={{ '--c': `var(--s${((c.colorIndex || 0) % 7) + 1})` }}
                  onClick={() => onOpenCourse(c.id)}
                >
                  <span className="rk-ccard-h">
                    <Dot course={c} />
                    <span className="rk-ccard-n">{c.name}</span>
                    {!c.confirmed && <Tag tone="warn">확인 필요</Tag>}
                  </span>
                  <span className="rk-ccard-m">{c.professor || '교수 미정'}</span>
                  <span className="rk-ccard-f">
                    <span className="rk-num">
                      {ns ? `${dayName(ns.day)} ${ns.start != null ? fmtTime(ns.start) : ''}`.trim() : '시간 미정'}
                    </span>
                    {left > 0 && <span className="rk-ccard-left">미정리 <b className="rk-num">{left}</b></span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {data.courses.some((c) => !c.confirmed) && (
        <Notice>정보가 확정되지 않은 과목이 있습니다. 과목 카드의 &lsquo;확인 필요&rsquo; 표시를 눌러 내용을 채워 주세요.</Notice>
      )}
    </>
  );
}
