'use client';

/* ---------------------------------------------------------------------------
   /study — 학습 모듈.

   라우팅은 쿼리스트링이다. output:'export' 에서는 /study/[id] 같은 동적 세그먼트가
   generateStaticParams 없이는 굽히지 않고, 과목은 앞으로 늘어난다. 그래서
   ?c=<courseId>&t=<tab> 으로 간다. next/navigation 의 useSearchParams 는 정적 추출에서
   Suspense 경계를 요구하므로, location.search 를 직접 읽고 pushState/popstate 로 움직인다.

   저장은 낙관적이다. 화면을 먼저 바꾸고 뒤에서 kv 로 보낸다. 실패하면 되돌리는 대신
   localStorage 에 적어 두고(§3 "오프라인이거나 저장 실패면 임시 보관") 실패 상태를
   계속 보여준다 — 타이핑하던 메모를 되돌려 지우는 쪽이 더 나쁘다. 다음 접속 때
   flushPending() 이 조용히 다시 보낸다.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays, ClipboardList, Layers, LoaderCircle, Settings, TriangleAlert,
} from 'lucide-react';
import AuthGate from '../_ui/AuthGate';
import Shell from '../_ui/Shell';
import {
  DEFAULT_SEMESTER, currentWeek, dayName, flushPending, fmtTime, listSemesters,
  loadSemester, saveSemester, writePending } from '../../lib/study';
import Dashboard from './Dashboard';
import CourseView from './CourseView';
import { Dot, Empty, Notice, SaveState, Tag } from './parts';

const VIEWS = [
  { key: 'dash', label: '대시보드', icon: CalendarDays },
  { key: 'courses', label: '과목', icon: Layers },
  { key: 'todos', label: '할 일', icon: ClipboardList },
  { key: 'settings', label: '설정', icon: Settings },
];
const SAVE_DELAY = 650;

function readRoute() {
  if (typeof window === 'undefined') return { v: 'dash', c: null, t: 'overview', s: DEFAULT_SEMESTER };
  const q = new URLSearchParams(window.location.search);
  return {
    v: q.get('v') || 'dash',
    c: q.get('c') || null,
    t: q.get('t') || 'overview',
    s: q.get('s') || DEFAULT_SEMESTER,
  };
}

function routeToUrl(r) {
  const q = new URLSearchParams();
  if (r.s && r.s !== DEFAULT_SEMESTER) q.set('s', r.s);
  if (r.c) {
    q.set('c', r.c);
    if (r.t && r.t !== 'overview') q.set('t', r.t);
  } else if (r.v && r.v !== 'dash') {
    q.set('v', r.v);
  }
  const qs = q.toString();
  return `/study${qs ? `?${qs}` : ''}`;
}

const SSR_ROUTE = { v: 'dash', c: null, t: 'overview', s: DEFAULT_SEMESTER };

function StudyApp({ session }) {
  // 첫 렌더는 반드시 서버가 구워둔 것과 같아야 한다. 여기서 location.search 를 읽으면
  // 하이드레이션이 어긋나고, React 는 텍스트만 고치고 className 은 서버 값을 그대로 둬서
  // 본문은 과목인데 상단 탭은 '대시보드'가 켜진 채로 남는다. 그래서 주소는 mount 후에 읽는다.
  const [route, setRoute] = useState(SSR_ROUTE);
  const [data, setData] = useState(null);
  const [source, setSource] = useState('');
  const [loadErr, setLoadErr] = useState(null);
  const [saveStatus, setSaveStatus] = useState('idle');   // idle | saving | saved | error
  const [semesters, setSemesters] = useState([DEFAULT_SEMESTER]);

  const timerRef = useRef(0);
  const pendingRef = useRef(null);
  const okRef = useRef(0);

  // 주소창이 진실이다. mount 직후 한 번 읽고, 뒤로가기로도 화면이 따라간다.
  useEffect(() => {
    const sync = () => setRoute((prev) => {
      const next = readRoute();
      // 같은 주소면 객체를 바꾸지 않는다 — 바꾸면 데이터를 괜히 다시 불러온다.
      return routeToUrl(next) === routeToUrl(prev) ? prev : next;
    });
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const go = useCallback((patch) => {
    setRoute((prev) => {
      const next = { ...prev, ...patch };
      window.history.pushState(null, '', routeToUrl(next));
      return next;
    });
  }, []);

  useEffect(() => { listSemesters().then(setSemesters).catch(() => {}); }, []);

  // 학기가 바뀌면 다시 불러온다. 못 보낸 저장이 있으면 먼저 흘려보낸다.
  useEffect(() => {
    let alive = true;
    setData(null);
    setLoadErr(null);
    (async () => {
      await flushPending(route.s);
      const res = await loadSemester(route.s);
      if (!alive) return;
      setData(res.data);
      setSource(res.source);
      setLoadErr(res.error || null);
    })();
    return () => { alive = false; };
  }, [route.s]);

  /* ------------------------------------------------------------ 저장 */

  const flush = useCallback(async () => {
    const next = pendingRef.current;
    if (!next) return;
    pendingRef.current = null;
    setSaveStatus('saving');
    const res = await saveSemester(route.s, next);
    if (res.ok) {
      setSaveStatus('saved');
      const token = ++okRef.current;
      // '저장됨'은 잠깐만. 계속 떠 있으면 방금 저장한 건지 아까 것인지 알 수 없다.
      setTimeout(() => { if (okRef.current === token) setSaveStatus('idle'); }, 2200);
    } else {
      setSaveStatus('error');
    }
  }, [route.s]);

  const commit = useCallback((updater) => {
    setData((prev) => {
      if (!prev) return prev;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      pendingRef.current = next;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DELAY);
      return next;
    });
  }, [flush]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // 강의 중 타이핑 도중 노트북을 덮거나 탭을 닫으면 디바운스(650ms) 안에 있던 입력이
  // 그대로 사라진다. 화면이 숨겨지는 순간 대기 중인 내용을 localStorage 에 동기로 적어둔다.
  // 다음 접속 때 flushPending 이 서버로 올린다.
  useEffect(() => {
    const stash = () => {
      const next = pendingRef.current;
      if (next) writePending(route.s, next);
    };
    const onHide = () => { if (document.visibilityState === 'hidden') stash(); };
    window.addEventListener('pagehide', stash);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', stash);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [route.s]);

  const patchCourse = useCallback((courseId, patch) => {
    commit((prev) => ({
      ...prev,
      courses: prev.courses.map((c) => (c.id === courseId ? { ...c, ...patch } : c)),
    }));
  }, [commit]);

  const toggleTodo = useCallback((id) => {
    commit((prev) => ({
      ...prev,
      todos: prev.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    }));
  }, [commit]);

  /* ------------------------------------------------------------ 렌더 */

  const week = useMemo(() => (data ? currentWeek(data) : null), [data]);
  const course = useMemo(
    () => (data && route.c ? data.courses.find((c) => c.id === route.c) : null),
    [data, route.c],
  );

  const openCourse = useCallback((id) => go({ c: id, t: 'overview' }), [go]);
  const backToDash = useCallback(() => go({ c: null, v: 'dash' }), [go]);
  const activeView = route.c ? 'courses' : route.v;

  const nav = (
    <nav className="rk-topnav" aria-label="학습 메뉴">
      {VIEWS.map((v) => (
        <button
          key={v.key} type="button"
          className={'rk-topnav-i' + (activeView === v.key ? ' is-on' : '')}
          onClick={() => go(v.key === 'dash' ? { v: 'dash', c: null } : { v: v.key, c: null })}
        >
          {v.label}
        </button>
      ))}
    </nav>
  );

  if (!data) {
    return (
      <Shell session={session} wide nav={nav}>
        <div className="rk-boot" role="status" aria-live="polite">
          <LoaderCircle size={20} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />
          <span>학습 데이터를 불러오는 중</span>
        </div>
      </Shell>
    );
  }

  const courseList = (
    <div className="rk-side-courses">
      {data.courses.length === 0 ? (
        <p className="rk-side-none">과목 없음</p>
      ) : data.courses.map((c) => (
        <button
          key={c.id} type="button"
          className={'rk-side-c' + (route.c === c.id ? ' is-on' : '')}
          onClick={() => openCourse(c.id)}
        >
          <Dot course={c} />
          <span className="rk-side-cn">{c.name}</span>
          {!c.confirmed && <span className="rk-side-warn" aria-label="확인 필요">
            <TriangleAlert size={13} strokeWidth={1.5} aria-hidden="true" />
          </span>}
        </button>
      ))}
    </div>
  );

  let body;
  if (route.c && !course) {
    body = (
      <Empty title="그 과목을 찾을 수 없습니다" hint="목록에서 다시 선택해 주세요.">
        <button type="button" className="rk-btn" onClick={backToDash}>대시보드로</button>
      </Empty>
    );
  } else if (course) {
    body = (
      <CourseView
        course={course} week={week} tab={route.t}
        onTab={(t) => go({ t })} onBack={backToDash}
      />
    );
  } else if (route.v === 'courses') {
    body = (
      <section className="rk-block">
        <h2 className="rk-h2"><Layers size={16} strokeWidth={1.5} aria-hidden="true" />과목</h2>
        {data.courses.length === 0 ? (
          <Empty title="등록된 과목이 없습니다" hint="학습 데이터가 준비되면 자동으로 채워집니다." />
        ) : (
          <div className="rk-cgrid">
            {data.courses.map((c) => (
              <button key={c.id} type="button" className="rk-ccard"
                style={{ '--c': `var(--s${((c.colorIndex || 0) % 7) + 1})` }}
                onClick={() => openCourse(c.id)}>
                <span className="rk-ccard-h">
                  <Dot course={c} /><span className="rk-ccard-n">{c.name}</span>
                  {!c.confirmed && <Tag tone="warn">확인 필요</Tag>}
                </span>
                <span className="rk-ccard-m">{c.professor || '교수 미정'}</span>
                <span className="rk-ccard-f">
                  <span className="rk-num">
                    {c.meetings[0]?.day != null
                      ? `${dayName(c.meetings[0].day)} ${fmtTime(c.meetings[0].start)}`.trim()
                      : '시간 미정'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    );
  } else if (route.v === 'todos') {
    body = (
      <Dashboard data={{ ...data, courses: [], conflicts: [] }} week={week}
        onOpenCourse={openCourse} onToggleTodo={toggleTodo} />
    );
  } else if (route.v === 'settings') {
    body = (
      <section className="rk-block">
        <h2 className="rk-h2"><Settings size={16} strokeWidth={1.5} aria-hidden="true" />설정</h2>
        <dl className="rk-fields">
          <div className="rk-field"><dt>학기</dt><dd>
            <select className="rk-input rk-select" value={route.s}
              onChange={(e) => go({ s: e.target.value, c: null, v: 'dash' })}>
              {semesters.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </dd></div>
          <div className="rk-field"><dt>데이터 출처</dt><dd className="rk-num">{source || '-'}</dd></div>
          <div className="rk-field"><dt>과목 수</dt><dd className="rk-num">{data.courses.length}</dd></div>
          <div className="rk-field"><dt>현재 주차</dt><dd className="rk-num">{week ?? '알 수 없음'}</dd></div>
          <div className="rk-field"><dt>계정</dt><dd>{session?.user?.email || '-'}</dd></div>
        </dl>
        <p className="rk-note">
          내용은 Supabase <code>kv</code> 의 <code>study.{route.s}</code> 에 저장됩니다.
          재배포 없이 즉시 반영됩니다.
        </p>
      </section>
    );
  } else {
    // 대시보드의 할 일은 급한 것 몇 건만. 24건을 다 쏟으면 나머지 섹션이 안 보인다.
    body = (
      <Dashboard
        data={data} week={week} onOpenCourse={openCourse} onToggleTodo={toggleTodo}
        todoLimit={6} onAllTodos={() => go({ v: 'todos', c: null })}
      />
    );
  }

  return (
    <Shell
      session={session} wide nav={nav}
      title={route.c ? null : data.label || '학습'}
      sub={route.c ? null : [route.s, week != null ? `${week}주차` : null].filter(Boolean).join(' · ')}
    >
      {/* is-dash 일 때만 본문을 2단으로 펼친다 — 과목 상세는 한 줄로 읽는 게 낫다. */}
      <div className={'rk-study' + (!route.c && route.v === 'dash' ? ' is-dash' : '')}>
        <aside className="rk-side">
          <label className="rk-side-lab" htmlFor="rk-sem">학기</label>
          <select id="rk-sem" className="rk-input rk-select" value={route.s}
            onChange={(e) => go({ s: e.target.value, c: null, v: 'dash' })}>
            {semesters.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="rk-side-lab">과목</div>
          {courseList}
        </aside>

        <div className="rk-content">
          <div className="rk-statusbar">
            <SaveState state={saveStatus} onRetry={flush} />
          </div>
          {source === 'empty' && (
            <Notice>
              학습 데이터가 아직 없습니다. <code>public/study-seed.json</code> 이 준비되면 첫 접속 때 자동으로 적재됩니다.
            </Notice>
          )}
          {loadErr && (
            <Notice>
              {source === 'cache'
                ? '서버에서 불러오지 못해 이 기기에 저장된 내용을 보여주고 있습니다.'
                : '서버에 연결하지 못해 초기 데이터로 표시하고 있습니다. 편집한 내용은 연결되면 저장됩니다.'}
            </Notice>
          )}
          {body}
        </div>
      </div>

      <nav className="rk-tabbar" aria-label="학습 메뉴">
        {VIEWS.map((v) => (
          <button
            key={v.key} type="button"
            className={'rk-tabbar-i' + (activeView === v.key ? ' is-on' : '')}
            aria-current={activeView === v.key ? 'page' : undefined}
            onClick={() => go(v.key === 'dash' ? { v: 'dash', c: null } : { v: v.key, c: null })}
          >
            <v.icon size={19} strokeWidth={1.5} aria-hidden="true" />
            <span>{v.label}</span>
          </button>
        ))}
      </nav>
    </Shell>
  );
}

export default function StudyClient() {
  return <AuthGate>{(session) => <StudyApp session={session} />}</AuthGate>;
}
