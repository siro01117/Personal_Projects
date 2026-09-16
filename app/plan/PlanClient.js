'use client';

/* ---------------------------------------------------------------------------
   /plan — 일정 모듈. app/study/StudyClient.js 와 같은 뼈대를 따른다:
   AuthGate + Shell, 쿼리스트링 라우팅(location.search + pushState, SSR_ROUTE 로
   첫 렌더 고정), 낙관적 저장(commit → 디바운스 flush, pagehide 시 stash), SaveState.

   개발용 픽스처(?fixture=1, NODE_ENV==='development'): Supabase 를 건너뛰고 화면만 확인한다.
   이 분기는 아래에서 항상 `if (process.env.NODE_ENV === 'development')` 로 감싸 프로덕션
   번들에서 완전히 빠지게 한다(동적 import 이므로 코드 스플리팅으로도 빠진다).
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CalendarClock, CalendarDays, CheckCheck, CircleDot, ClipboardList, LoaderCircle, Pencil, Plus,
  RotateCcw, Settings, Trash2, Undo2,
} from 'lucide-react';
import AuthGate from '../_ui/AuthGate';
import Shell from '../_ui/Shell';
import {
  addDaysISO, addEvent, addTask, dowOf, editEventFollowing, editEventOnce, expand, fmtTime, nowMinutes,
  mergePlan, moveFollowing, moveOnce, normalize, removeFollowing, removeOnce, replaceEvent, replaceTask,
  todayISO, uid, weekDays, weekLabel,
} from '../../lib/plan-core';
import {
  flushPendingPlan, loadClassesForSemester, loadPlan, loadWork, savePlan, writePending,
} from '../../lib/plan';
import { listSemesters } from '../../lib/study';
import { Empty, Notice, SaveState, Tag } from '../study/parts';
import Overview from './Overview';
import WeekGrid from './WeekGrid';
import EditSheet from './EditSheet';
import MoveSheet from './MoveSheet';
import PlacesSettings from './PlacesSettings';
import WeekNav from './WeekNav';
import TodayStage from './TodayStage';
import PlaceTray, { DRAG_TYPE } from './PlaceTray';
import { PlaceTag, useSomeday } from './todayShared';
import { checkSlot, suggest } from '../../lib/plan-suggest';

const VIEWS = [
  { key: 'dash', label: '개요', icon: CalendarDays },
  { key: 'today', label: '오늘', icon: CircleDot },
  { key: 'week', label: '이번 주', icon: CalendarClock },
  { key: 'later', label: '할 일', icon: ClipboardList },
  { key: 'settings', label: '설정', icon: Settings },
];
const SAVE_DELAY = 650;
const EMPTY = [];
// 하루 시작·끝 선택지(분). 끝은 자정(24:00)까지 — 시간 입력칸은 24:00 을 못 받아 정오와 헷갈렸다
const HOURS_START = [300, 360, 420, 480, 540, 600, 660, 720];
const HOURS_END = [1080, 1140, 1200, 1260, 1320, 1380, 1440];
const hourLabel = (m) => {
  if (m === 1440) return '자정 (24:00)';
  if (m === 720) return '정오 (12:00)';
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h < 12 ? '오전' : '오후'} ${h > 12 ? h - 12 : h}시${mm ? ` ${mm}분` : ''}`;
};
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function readRoute() {
  if (typeof window === 'undefined') return { v: 'dash' };
  const q = new URLSearchParams(window.location.search);
  return { v: q.get('v') || 'dash' };
}
function routeToUrl(r) {
  const q = new URLSearchParams();
  if (r.v && r.v !== 'dash') q.set('v', r.v);
  const qs = q.toString();
  return `/plan${qs ? `?${qs}` : ''}`;
}
const SSR_ROUTE = { v: 'dash' };

/* -------------------------------------------------------------- 액션 메뉴 */
// 클릭한 항목 옆에 뜨는 작은 팝오버. 포털로 body 에 그려 overflow 컨테이너(카드·그리드)에
// 잘리지 않게 하고, 첫 렌더 뒤 실제 크기를 재서 화면 밖으로 안 나가게 보정한다.
const DOW_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

// 블록을 누르면 뜨는 팝업의 상세 줄들 — 날짜·시간, 종류, 장소, 마감, 메모
function occDetail(occ, data) {
  const rows = [];
  const d = occ.date;
  const dateText = `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}(${DOW_NAMES[dowOf(d)]})`;
  if (occ.allDay) rows.push(['언제', `${dateText} 종일`]);
  else if (occ.start != null) {
    const mins = occ.end - occ.start;
    const len = mins >= 60 ? `${Math.floor(mins / 60)}시간${mins % 60 ? ` ${mins % 60}분` : ''}` : `${mins}분`;
    rows.push(['언제', `${dateText} ${fmtTime(occ.start)}–${fmtTime(occ.end)} · ${len}`]);
  }

  const ev = occ.source === 'event' ? data.events.find((e) => e.id === occ.id) : null;
  const task = occ.source === 'task' ? data.tasks.find((t) => t.id === occ.id) : null;
  let kind = '';
  if (occ.source === 'class') kind = '대학 수업';
  else if (occ.source === 'work') kind = '스큐 근무';
  else if (task) kind = task.priority === 'high' ? '할 일 · 중요' : '할 일';
  else if (ev) {
    const r = ev.repeat;
    const rep = !r ? '' : r.freq === 'daily' ? '매일' : `매주 ${(r.days || []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((x) => DOW_NAMES[x]).join('·')}`;
    kind = [rep ? `반복 · ${rep}${r.until ? ` (~${Number(r.until.slice(5, 7))}/${Number(r.until.slice(8, 10))})` : ''}` : '', ev.important ? '특별한 약속' : ''].filter(Boolean).join(' · ') || '일정';
  }
  if (kind) rows.push(['종류', kind]);

  const pl = occ.placeId ? (data.settings.places || []).find((x) => x.id === occ.placeId) : null;
  const place = [pl?.name, occ.place].filter(Boolean).join(' · ');
  if (place) rows.push(['장소', place]);
  const own = ev?.travelMin ?? task?.travelMin;
  if (own) rows.push(['이동', `편도 ${own}분(직접 적음)`]);

  if (task?.due) rows.push(['마감', `${Number(task.due.slice(5, 7))}/${Number(task.due.slice(8, 10))}(${DOW_NAMES[dowOf(task.due)]})`]);
  const note = (ev?.note || task?.note || '').trim();
  if (note) rows.push(['메모', note]);
  return rows;
}

function ActionMenu({ occ, anchorRect, data, onEdit, onMove, onRemove, onToggleDone, onUnslot, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(() => (
    anchorRect ? { top: anchorRect.bottom + 6, left: anchorRect.left } : { top: 80, left: 80 }
  ));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let { top, left } = pos;
    if (left + r.width > vw - 8) left = Math.max(8, vw - r.width - 8);
    if (top + r.height > vh - 8) top = anchorRect ? Math.max(8, anchorRect.top - r.height - 6) : Math.max(8, vh - r.height - 8);
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (top !== pos.top || left !== pos.left) setPos({ top, left });
    el.querySelector('button')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  // 근무는 원본이 스큐에 있다 — 옮기기·수정·없애기를 아예 그리지 않고 왜 못 고치는지만 한 줄 보여준다.
  const readOnly = occ.source === 'work';
  const rows = occDetail(occ, data);

  return createPortal(
    <div className="rk-pl-popover" ref={ref} role="dialog" aria-label={`${occ.title} 상세`} style={{ top: pos.top, left: pos.left }}>
      <div className="rk-pl-popover-h">
        <p className="rk-pl-popover-t">{occ.title}</p>
        <dl className="rk-pl-popover-dl">
          {rows.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd className={k === '언제' ? 'rk-num' : undefined}>{v}</dd></div>
          ))}
        </dl>
      </div>
      {readOnly && (
        <p className="rk-pl-hint" style={{ margin: '2px 10px 8px' }}>
          스큐에서 가져온 근무라 여기서는 못 바꿉니다.
        </p>
      )}
      {!readOnly && occ.source === 'task' && (
        <>
          <button type="button" className="rk-menu-item" onClick={onToggleDone} role="menuitem">
            <CheckCheck size={16} strokeWidth={1.5} aria-hidden="true" />완료
          </button>
          <button type="button" className="rk-menu-item" onClick={onUnslot} role="menuitem">
            <RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />다시 언젠가로
          </button>
        </>
      )}
      {!readOnly && occ.source !== 'class' && (
        <button type="button" className="rk-menu-item" onClick={onEdit} role="menuitem">
          <Pencil size={16} strokeWidth={1.5} aria-hidden="true" />수정
        </button>
      )}
      {!readOnly && (
        <>
          <button type="button" className="rk-menu-item" onClick={onMove} role="menuitem">
            <CalendarClock size={16} strokeWidth={1.5} aria-hidden="true" />옮기기
          </button>
          <button type="button" className="rk-menu-item" onClick={onRemove} role="menuitem">
            <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />없애기
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

// 요일·시각 포함 사람이 읽는 짧은 문구 — 옮기기/없애기 되돌리기 토스트에 쓴다.
function whenLabel(dateISO, start) {
  const d = `${Number(dateISO.slice(5, 7))}/${Number(dateISO.slice(8, 10))}(${DOW[dowOf(dateISO)]})`;
  return start == null ? d : `${d} ${fmtTime(start)}`;
}

function PlanApp({ session, fixtureMode }) {
  const [route, setRoute] = useState(SSR_ROUTE);
  // 개요의 주 띠와 시간표 페이지가 같은 주를 본다 — 넘겨두고 탭을 바꿔도 이어지게
  const [weekOffset, setWeekOffset] = useState(0);
  // 이번 주 시간표에 끌어넣을 할 일 id (배치 모드)
  const [placingId, setPlacingId] = useState(null);
  const [data, setData] = useState(null);
  const someday = useSomeday(data?.tasks || EMPTY);
  const [classes, setClasses] = useState([]);
  const [work, setWork] = useState({ shifts: [] }); // 스큐 근무(읽기 전용) — kv 'work'
  const [source, setSource] = useState('');
  const [loadErr, setLoadErr] = useState(null);
  const [saveStatus, setSaveStatus] = useState('idle');
  const [semesters, setSemesters] = useState([]);
  const [sheet, setSheet] = useState(null);   // { kind:'event'|'task', initial, occ, defaultDate, defaultStart }
  const [moving, setMoving] = useState(null); // occurrence
  const [menu, setMenu] = useState(null);     // occurrence (액션 메뉴)
  const [undo, setUndo] = useState(null);     // { snapshot }
  const [fabOpen, setFabOpen] = useState(false); // 모바일 떠있는 추가 버튼

  const timerRef = useRef(0);
  const pendingRef = useRef(null);
  // 이 탭이 마지막으로 서버와 맞춘 문서 — 저장할 때 '이 탭이 바꾼 것'을 가려내는 기준(mergePlan).
  // 불변식: baseRef 는 언제나 지금 화면 데이터(와 pendingRef)의 조상이어야 한다. 그래서 둘은
  // 반드시 같은 setData 업데이트 안에서 함께 바꾼다. 기준본만 먼저 최신으로 바꿔 두면, 그 사이
  // 옛 화면 위에서 만든 수정이 '밖에서 넣은 일정을 이 탭이 지웠다'로 읽혀 실제로 지워진다(겪음).
  const baseRef = useRef(null);
  const savingRef = useRef(false); // 저장은 한 번에 하나만 — 동시에 두 번 돌면 기준본이 엇갈린다
  const okRef = useRef(0);
  const undoTimerRef = useRef(0);

  useEffect(() => {
    const sync = () => setRoute((prev) => {
      const next = readRoute();
      return routeToUrl(next) === routeToUrl(prev) ? prev : next;
    });
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  // pushState 는 updater 밖에서 — updater 는 렌더 중에 돌 수 있고, Next 가 history 를
  // 감싸 두어서 그 안에서 부르면 Router 를 렌더 중에 갱신한다는 경고가 난다.
  const routeRef = useRef(route);
  routeRef.current = route;
  const go = useCallback((patch) => {
    const next = { ...routeRef.current, ...patch };
    routeRef.current = next;
    window.history.pushState(null, '', routeToUrl(next));
    setRoute(next);
  }, []);

  // 초기 적재
  useEffect(() => {
    let alive = true;
    (async () => {
      if (fixtureMode) {
        const { buildFixture } = await import('./fixture');
        const fx = buildFixture();
        if (!alive) return;
        // 실제 경로(loadPlan)와 똑같이 normalize 를 태운다. 안 그러면 새 설정의
        // 기본값이 픽스처에만 빠져서 화면이 실제 동작과 갈라진다.
        setData(normalize(fx.doc));
        setClasses(fx.classes);
        setWork(fx.work);
        setSource('fixture');
        return;
      }
      await flushPendingPlan();
      const res = await loadPlan();
      if (!alive) return;
      setData(() => {
        baseRef.current = res.source === 'kv' || res.source === 'empty' ? res.data : null;
        return res.data;
      });
      setSource(res.source);
      setLoadErr(res.error || null);
      listSemesters().then(setSemesters).catch(() => {});
      // 근무는 곁다리 — loadWork 는 throw 하지 않지만 그래도 화면을 막지 않게 따로 띄운다.
      // 열 때마다 스큐에서 새로 받는다(loadWork 기본값). 돌아올 때 다시 받는 건 아래 effect.
      loadWork().then((w) => { if (alive) setWork(w); }).catch(() => {});
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtureMode]);

  // 수업 연동 — 학기가 바뀌면(또는 showClasses 토글) 다시 읽는다.
  useEffect(() => {
    if (!data) return;
    if (fixtureMode) return; // 픽스처는 자체 classes 를 이미 갖고 있다
    if (!data.settings.showClasses) { setClasses([]); return; }
    let alive = true;
    loadClassesForSemester(data.settings.semester).then((cls) => { if (alive) setClasses(cls); });
    return () => { alive = false; };
  }, [data?.settings.semester, data?.settings.showClasses, fixtureMode]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------ 저장 */

  const flush = useCallback(async () => {
    if (fixtureMode || savingRef.current) return; // 진행 중인 저장이 끝나면 아래에서 다시 부른다
    const next = pendingRef.current;
    if (!next) return;
    savingRef.current = true;
    pendingRef.current = null;
    setSaveStatus('saving');
    const res = await savePlan(next, baseRef.current);
    savingRef.current = false;
    if (res.ok) {
      const merged = res.data;
      // 서버에서 합쳐진 것(다른 곳에서 넣은 일정 등)을 화면에도 반영한다. 저장하는 사이에 또 고친 게
      // 있으면 그 수정(= next 위에서 만든 것)을 합쳐진 문서 위에 다시 얹는다.
      // 기준본은 여기서, 데이터와 **같은 업데이트 안에서** 바꾼다(위 불변식).
      setData(() => {
        const again = pendingRef.current;
        baseRef.current = merged;
        if (!again) return merged;
        const rebased = mergePlan(next, again, merged);
        pendingRef.current = rebased;
        return rebased;
      });
      setSaveStatus('saved');
      const token = ++okRef.current;
      setTimeout(() => { if (okRef.current === token) setSaveStatus('idle'); }, 2200);
    } else {
      // 실패한 수정은 버리지 않는다 — 그 뒤에 또 고친 게 없으면 다시 대기열로
      if (!pendingRef.current) pendingRef.current = next;
      setSaveStatus('error');
    }
    // 저장하는 동안 들어온 수정이 있으면 이어서 올린다
    if (pendingRef.current && res.ok) {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flushRef.current?.(), SAVE_DELAY);
    }
  }, [fixtureMode]);
  const flushRef = useRef(null);
  flushRef.current = flush;

  const commit = useCallback((updater) => {
    setData((prev) => {
      if (!prev) return prev;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (!fixtureMode) {
        pendingRef.current = next;
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, SAVE_DELAY);
      }
      return next;
    });
  }, [flush, fixtureMode]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // 스큐에서 근무를 고치고 이 탭으로 돌아오면 그 자리에서 다시 받는다(볼 때 받는다).
  // 너무 잦은 전환에 매번 부르지 않게 20초 안에는 건너뛴다.
  useEffect(() => {
    if (fixtureMode) return undefined;
    let last = Date.now();
    const onShow = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 20000) return;
      last = Date.now();
      loadWork().then(setWork).catch(() => {});
      // 일정 문서도 다른 곳에서 바뀌었을 수 있다. 저장 대기 중인 수정이 없을 때만 갈아끼운다
      if (!pendingRef.current && !savingRef.current) {
        loadPlan().then((res) => {
          if (res.source !== 'kv') return;
          setData((cur) => {
            if (pendingRef.current || savingRef.current) return cur;
            baseRef.current = res.data;
            return res.data;
          });
        }).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [fixtureMode]);

  useEffect(() => {
    if (fixtureMode) return undefined;
    const stash = () => { const next = pendingRef.current; if (next) writePending(next, baseRef.current); };
    const onHide = () => { if (document.visibilityState === 'hidden') stash(); };
    window.addEventListener('pagehide', stash);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', stash);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [fixtureMode]);

  /* --------------------------------------------------------- 되돌리기 */

  // 되돌리기는 스냅샷을 통째로 되살리지 않는다 — 그 사이 합쳐진 일정까지 지워지기 때문.
  // 그 동작 직후 문서(after) 대비 동작 직전(snapshot)으로 바뀐 부분만 지금 문서에 얹는다.
  const pushUndo = useCallback((snapshot, message, after) => {
    clearTimeout(undoTimerRef.current);
    setUndo({ snapshot, after, message });
    undoTimerRef.current = setTimeout(() => setUndo(null), 5000);
  }, []);
  const doUndo = useCallback(() => {
    if (!undo) return;
    clearTimeout(undoTimerRef.current);
    commit((cur) => (undo.after ? mergePlan(undo.after, undo.snapshot, cur) : undo.snapshot));
    setUndo(null);
  }, [undo, commit]);

  /* -------------------------------------------------------- 변경 동작 */

  const openEditForOcc = useCallback((occ) => {
    if (occ.source === 'task') {
      const t = data.tasks.find((x) => x.id === occ.id);
      setSheet({ kind: 'task', initial: t });
    } else if (occ.source === 'event') {
      const ev = data.events.find((x) => x.id === occ.id);
      setSheet({ kind: 'event', initial: ev, occ });
    }
    setMenu(null);
  }, [data]);

  const saveEvent = useCallback((payload) => {
    commit((prev) => {
      if (payload.mode === 'new') return addEvent(prev, payload.event);
      if (payload.mode === 'series') return replaceEvent(prev, payload.id, payload.patch);
      return payload.scope === 'following'
        ? editEventFollowing(prev, payload.occ, payload.patch)
        : editEventOnce(prev, payload.occ, payload.patch);
    });
    setSheet(null);
  }, [commit]);

  const saveTask = useCallback((payload) => {
    commit((prev) => (payload.mode === 'new' ? addTask(prev, payload.task) : replaceTask(prev, payload.id, payload.patch)));
    setSheet(null);
  }, [commit]);

  const toggleTask = useCallback((id) => {
    commit((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === id ? { ...t, done: !t.done, doneAt: !t.done ? todayISO() : null, slot: !t.done ? null : t.slot } : t)),
    }));
  }, [commit]);

  const quickPlaceTask = useCallback((id, slot) => {
    commit((prev) => replaceTask(prev, id, { slot }));
  }, [commit]);

  const placeFromGrid = useCallback((date, start) => {
    const t = data?.tasks.find((x) => x.id === placingId);
    if (!t) return;
    commit((prev) => {
      const after = replaceTask(prev, t.id, { slot: { date, start } });
      pushUndo(prev, `‘${t.title}’을(를) ${whenLabel(date, start)}에 넣었어요`, after);
      return after;
    });
    setPlacingId(null);
  }, [data, placingId, commit, pushUndo]);

  useEffect(() => {
    if (!placingId) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPlacingId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placingId]);

  const quickAddTask = useCallback((title, duration) => {
    commit((prev) => addTask(prev, {
      id: uid('tk'), title, note: '', duration, priority: 'normal', due: null, slot: null, done: false, doneAt: null,
    }));
  }, [commit]);

  const unslotTask = useCallback((id) => {
    commit((prev) => replaceTask(prev, id, { slot: null }));
    setMenu(null);
  }, [commit]);

  const doMove = useCallback(({ scope, to }) => {
    if (!moving) return;
    const message = `${moving.title}을(를) ${whenLabel(to.date, to.start)}으로 옮겼어요`;
    commit((prev) => {
      const after = scope === 'following' ? moveFollowing(prev, moving, to) : moveOnce(prev, moving, to);
      pushUndo(prev, message, after);
      return after;
    });
    setMoving(null);
  }, [moving, commit, pushUndo]);

  const doRemove = useCallback(({ scope }) => {
    if (!moving) return;
    const message = moving.source === 'task' ? `${moving.title}을(를) 다시 언젠가로 돌렸어요` : `${moving.title}을(를) 없앴어요`;
    commit((prev) => {
      const after = scope === 'following' ? removeFollowing(prev, moving) : removeOnce(prev, moving);
      pushUndo(prev, message, after);
      return after;
    });
    setMoving(null);
  }, [moving, commit, pushUndo]);

  /* ------------------------------------------------------------ 렌더 */

  const nav = (
    <nav className="rk-topnav" aria-label="일정 메뉴">
      {VIEWS.map((v) => (
        <button key={v.key} type="button" className={'rk-topnav-i' + (route.v === v.key ? ' is-on' : '')}
          onClick={() => go({ v: v.key })}>{v.label}</button>
      ))}
    </nav>
  );

  if (!data) {
    return (
      <Shell session={session} wide nav={nav}>
        <div className="rk-boot" role="status" aria-live="polite">
          <LoaderCircle size={20} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />
          <span>일정 데이터를 불러오는 중</span>
        </div>
      </Shell>
    );
  }

  const today = todayISO();
  const shifts = work?.shifts || [];
  const unslotted = someday;
  const rangeOcc = expand(data, classes, today, addDaysISO(today, 14), shifts);

  let body;
  if (route.v === 'week') {
    const days = weekDays(addDaysISO(today, 7 * weekOffset));
    const weekOcc = expand(data, classes, days[0], days[6], shifts);
    const placingTask = placingId ? unslotted.find((t) => t.id === placingId) : null;
    const nowMin = nowMinutes();
    let placing = null;
    if (placingTask) {
      const target = {
        due: placingTask.due, priority: placingTask.priority,
        placeId: placingTask.placeId, travelMin: placingTask.travelMin,
      };
      const from = days[0] < today ? today : days[0];
      const span = days[6] < from ? 0 : Math.round((new Date(days[6]) - new Date(from)) / 86400000) + 1;
      placing = {
        title: placingTask.title,
        duration: placingTask.duration,
        candidates: span > 0 ? suggest({
          occurrences: weekOcc, duration: placingTask.duration, fromISO: from, days: span,
          settings: data.settings, nowISO: today, nowMin, target, limit: 3,
        }) : [],
        check: (date, start) => checkSlot({
          occurrences: weekOcc, date, start, duration: placingTask.duration,
          settings: data.settings, target, todayISO: today, nowMin,
        }),
      };
    }
    body = (
      <section className="rk-block rk-pl-week-page">
        <h2 className="rk-h2">
          <CalendarClock size={16} strokeWidth={1.5} aria-hidden="true" />{weekLabel(weekOffset)}
          <WeekNav offset={weekOffset} onChange={setWeekOffset} days={days} />
        </h2>
        <PlaceTray
          tasks={unslotted} placingId={placingTask ? placingId : null} onPick={setPlacingId}
          candidates={placing?.candidates} today={today}
        />
        <WeekGrid occurrences={weekOcc} days={days} settings={data.settings} rowH={44}
          placing={placing} onPlace={placeFromGrid} dragType={DRAG_TYPE}
          onSlotClick={(date, start) => setSheet({ kind: 'event', defaultDate: date, defaultStart: start })}
          onOccClick={(occ, rect) => setMenu({ occ, rect })} />
      </section>
    );
  } else if (route.v === 'later') {
    const open = data.tasks.filter((t) => !t.done);
    const done = data.tasks.filter((t) => t.done);
    body = (
      <section className="rk-block">
        <h2 className="rk-h2"><ClipboardList size={16} strokeWidth={1.5} aria-hidden="true" />할 일{open.length > 0 && <span className="rk-h2-note rk-num">{open.length}</span>}</h2>
        {data.tasks.length === 0 ? (
          <Empty title="할 일이 없습니다" hint="[+ 할 일] 로 마감 없는 일도 등록해 보세요." />
        ) : (
          <>
            <ul className="rk-todos">
              {open.map((t) => (
                <li key={t.id}>
                  {/* 완료는 체크박스만. 줄 전체가 완료 버튼이면 수정하려다 끝내 버린다 */}
                  <div className="rk-todo rk-pl-todo">
                    <label className="rk-pl-todo-check">
                      <input type="checkbox" checked={false} onChange={() => toggleTask(t.id)} aria-label={`${t.title} 완료`} />
                    </label>
                    <button type="button" className="rk-todo-body rk-pl-todo-body" onClick={() => setSheet({ kind: 'task', initial: t })}>
                      <span className="rk-todo-t">{t.title}</span>
                      <span className="rk-todo-m">
                        <span className="rk-num">{t.duration}분</span>
                        <PlaceTag settings={data.settings} item={t} />
                        {t.due && <Tag tone="warn">{t.due.slice(5).replace('-', '/')} 마감</Tag>}
                        {t.priority === 'high' && <Tag tone="bad">중요</Tag>}
                        {t.slot && <Tag>{t.slot.date.slice(5).replace('-', '/')} {fmtTime(t.slot.start)} 배치</Tag>}
                      </span>
                    </button>
                    <Pencil size={15} strokeWidth={1.5} className="rk-pl-todo-edit" aria-hidden="true" />
                  </div>
                </li>
              ))}
            </ul>
            {done.length > 0 && (
              <details className="rk-done">
                <summary>완료 <b className="rk-num">{done.length}</b></summary>
                <ul className="rk-todos is-done">
                  {done.map((t) => (
                    <li key={t.id}>
                      <div className="rk-todo rk-pl-todo">
                        <label className="rk-pl-todo-check">
                          <input type="checkbox" checked onChange={() => toggleTask(t.id)} aria-label={`${t.title} 완료 취소`} />
                        </label>
                        <span className="rk-todo-body"><span className="rk-todo-t">{t.title}</span></span>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
    );
  } else if (route.v === 'today') {
    body = (
      <TodayStage
        data={data} classes={classes} shifts={shifts}
        onOccClick={(occ, rect) => setMenu({ occ, rect })}
        onQuickPlaceTask={quickPlaceTask}
        onToggleTask={toggleTask}
        onEditTask={(t) => setSheet({ kind: 'task', initial: t })}
        onAddEvent={(prefill) => setSheet({ kind: 'event', defaultDate: prefill?.date, defaultStart: prefill?.start })}
      />
    );
  } else if (route.v === 'settings') {
    body = (
      <section className="rk-block">
        <h2 className="rk-h2"><Settings size={16} strokeWidth={1.5} aria-hidden="true" />설정</h2>
        <dl className="rk-fields">
          <div className="rk-field"><dt>하루 시작</dt><dd>
            <select className="rk-input rk-select" value={data.settings.dayStart}
              onChange={(e) => commit((p) => ({ ...p, settings: { ...p.settings, dayStart: Number(e.target.value) } }))}>
              {HOURS_START.map((m) => <option key={m} value={m}>{hourLabel(m)}</option>)}
            </select>
          </dd></div>
          <div className="rk-field"><dt>하루 끝</dt><dd>
            <select className="rk-input rk-select" value={data.settings.dayEnd}
              onChange={(e) => commit((p) => ({ ...p, settings: { ...p.settings, dayEnd: Number(e.target.value) } }))}>
              {HOURS_END.filter((m) => m > data.settings.dayStart).map((m) => <option key={m} value={m}>{hourLabel(m)}</option>)}
              {!HOURS_END.includes(data.settings.dayEnd) && (
                <option value={data.settings.dayEnd}>{hourLabel(data.settings.dayEnd)} (지금 값)</option>
              )}
            </select>
            <p className="rk-pl-hint">빈 시간을 찾고 제안할 때만 씁니다. 이 밖에 있는 일정도 화면에는 그대로 보입니다.</p>
          </dd></div>
          <div className="rk-field"><dt>여유(버퍼)</dt><dd>
            <select className="rk-input rk-select" value={data.settings.buffer}
              onChange={(e) => commit((p) => ({ ...p, settings: { ...p.settings, buffer: Number(e.target.value) } }))}>
              {[0, 10, 15, 20, 30].map((v) => <option key={v} value={v}>{v}분</option>)}
            </select>
          </dd></div>
          <div className="rk-field"><dt>하루 한도</dt><dd>
            <select className="rk-input rk-select" value={data.settings.dailyLimit}
              onChange={(e) => commit((p) => ({ ...p, settings: { ...p.settings, dailyLimit: Number(e.target.value) } }))}>
              <option value={0}>쓰지 않음</option>
              {[300, 360, 420, 480, 540, 600, 660].map((v) => <option key={v} value={v}>{v / 60}시간</option>)}
            </select>
            <p className="rk-pl-hint">
              일정·이동·할 일을 합쳐 하루에 이만큼까지만 채우려 합니다. 넘기는 날은 제안에서 뒤로 밀릴 뿐, 넣지 못하는 건 아닙니다.
            </p>
          </dd></div>
          <div className="rk-field"><dt>일정 사이 휴식</dt><dd>
            <select className="rk-input rk-select" value={data.settings.minRest}
              onChange={(e) => commit((p) => ({ ...p, settings: { ...p.settings, minRest: Number(e.target.value) } }))}>
              <option value={0}>쓰지 않음</option>
              {[15, 30, 45, 60].map((v) => <option key={v} value={v}>{v}분</option>)}
            </select>
            <p className="rk-pl-hint">
              앞뒤 일정과 이만큼은 띄우고 싶다는 뜻입니다. 위의 여유(버퍼)가 &lsquo;아예 못 넣는 거리&rsquo;라면 이쪽은 &lsquo;넣을 수는 있지만 빡빡한 거리&rsquo;입니다.
            </p>
          </dd></div>
          <div className="rk-field"><dt>식사 시간</dt><dd>
            <select className="rk-input rk-select" value={data.settings.mealMin}
              onChange={(e) => commit((p) => ({ ...p, settings: { ...p.settings, mealMin: Number(e.target.value) } }))}>
              <option value={0}>추천 안 함</option>
              {[20, 30, 40, 50, 60].map((v) => <option key={v} value={v}>{v}분</option>)}
            </select>
            <p className="rk-pl-hint">
              점심(11–14시)·저녁(17–20시 반) 안에서 비는 자리에 이만큼을 추천합니다. 고정 일정이 아니라 일정이 바뀌면 따라 옮겨가고, 할 일을 제안할 때 식사 자리를 없애는 시간은 뒤로 미룹니다.
            </p>
          </dd></div>
          <PlacesSettings
            settings={data.settings}
            onChange={(fn) => commit((p) => ({ ...p, settings: fn(p.settings) }))}
          />
          <div className="rk-field"><dt>수업 표시</dt><dd>
            <label className="rk-check">
              <input type="checkbox" checked={data.settings.showClasses}
                onChange={(e) => commit((p) => ({ ...p, settings: { ...p.settings, showClasses: e.target.checked } }))} />
              이번 주 일정·오늘 타임라인에 수업 시간표를 함께 보여줍니다
            </label>
          </dd></div>
          <div className="rk-field"><dt>스큐 근무 표시</dt><dd>
            <label className="rk-check">
              <input type="checkbox" checked={data.settings.showWork}
                onChange={(e) => commit((p) => ({ ...p, settings: { ...p.settings, showWork: e.target.checked } }))} />
              스터디큐브 근무를 함께 보여줍니다. 이 화면을 열거나 다시 돌아올 때마다 새로 받아옵니다 (여기서는 고칠 수 없습니다)
            </label>
            <p className="rk-pl-hint">
              {work?.syncedAt
                ? `${work.live ? '열 때 스큐에서 받음' : '스큐 응답이 없어 마지막으로 받은 근무'} · ${syncedAtLabel(work.syncedAt)} · ${shifts.length}건`
                : '아직 받아온 근무가 없습니다.'}
            </p>
          </dd></div>
          {!fixtureMode && (
            <div className="rk-field"><dt>학기</dt><dd>
              <select className="rk-input rk-select" value={data.settings.semester}
                onChange={(e) => commit((p) => ({ ...p, settings: { ...p.settings, semester: e.target.value } }))}>
                {(semesters.length ? semesters : [data.settings.semester]).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </dd></div>
          )}
          <div className="rk-field"><dt>데이터 출처</dt><dd className="rk-num">{source || '-'}</dd></div>
        </dl>
      </section>
    );
  } else {
    body = (
      <Overview
        data={data} classes={classes} shifts={shifts}
        weekOffset={weekOffset} onWeekOffset={setWeekOffset}
        onOccClick={(occ, rect) => setMenu({ occ, rect })}
        onAddEvent={(prefill) => setSheet({
          kind: 'event', defaultDate: prefill?.date, defaultStart: prefill?.start,
          defaultRepeat: prefill?.repeat, defaultImportant: prefill?.important,
        })}
        onAddTask={() => setSheet({ kind: 'task' })}
        onToggleTask={toggleTask}
        onQuickPlaceTask={quickPlaceTask}
        onQuickAddTask={quickAddTask}
        onGoLater={() => go({ v: 'later' })}
        onGoWeek={() => go({ v: 'week' })}
        onGoToday={() => go({ v: 'today' })}
        onEditTask={(t) => setSheet({ kind: 'task', initial: t })}
      />
    );
  }

  return (
    <Shell session={session} wide nav={nav} title={null} sub={null}>
      <div className="rk-pl-root">
        {(undo || saveStatus !== 'idle') && (
          <div className="rk-statusbar">
            {undo && (
              <span className="rk-pl-undo">
                {undo.message || '변경했습니다'}
                <button type="button" onClick={doUndo}><Undo2 size={13} strokeWidth={1.5} aria-hidden="true" />되돌리기</button>
              </span>
            )}
            <SaveState state={saveStatus} onRetry={flush} />
          </div>
        )}
        {fixtureMode && <Notice>개발용 픽스처 화면입니다 — 저장은 이 브라우저 메모리에만 남습니다.</Notice>}
        {source === 'empty' && !fixtureMode && route.v !== 'dash' && (
          <Notice>일정 데이터가 아직 없습니다. 개요 화면에서 바로 시작할 수 있습니다.</Notice>
        )}
        {loadErr && (
          <Notice>{source === 'cache' ? '서버에서 불러오지 못해 이 기기에 저장된 내용을 보여주고 있습니다.' : '서버에 연결하지 못했습니다. 편집한 내용은 연결되면 저장됩니다.'}</Notice>
        )}
        {body}

        {fabOpen && (
          <div className="rk-pl-fab-menu">
            <button type="button" className="rk-pl-fab-item" onClick={() => { setSheet({ kind: 'event' }); setFabOpen(false); }}>
              <CalendarClock size={16} strokeWidth={1.5} aria-hidden="true" />일정 추가
            </button>
            <button type="button" className="rk-pl-fab-item" onClick={() => { setSheet({ kind: 'task' }); setFabOpen(false); }}>
              <ClipboardList size={16} strokeWidth={1.5} aria-hidden="true" />할 일 추가
            </button>
          </div>
        )}
        <button type="button" className="rk-pl-fab" onClick={() => setFabOpen((v) => !v)} aria-label="추가">
          <Plus size={22} strokeWidth={1.5} aria-hidden="true" />
        </button>

        <nav className="rk-tabbar" aria-label="일정 메뉴">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" className={'rk-tabbar-i' + (route.v === v.key ? ' is-on' : '')}
              aria-current={route.v === v.key ? 'page' : undefined} onClick={() => go({ v: v.key })}>
              <v.icon size={19} strokeWidth={1.5} aria-hidden="true" />
              <span>{v.label}</span>
            </button>
          ))}
        </nav>

        {sheet && (
          <EditSheet
            kind={sheet.kind} initial={sheet.initial} occ={sheet.occ}
            defaultDate={sheet.defaultDate} defaultStart={sheet.defaultStart}
            defaultRepeat={sheet.defaultRepeat} defaultImportant={sheet.defaultImportant}
            settings={data.settings} onSaveEvent={saveEvent} onSaveTask={saveTask} onClose={() => setSheet(null)}
          />
        )}
        {moving && (
          <MoveSheet
            occ={moving} occurrences={rangeOcc} events={data.events} settings={data.settings}
            onMove={doMove} onRemove={doRemove} onClose={() => setMoving(null)}
          />
        )}
        {menu && (
          <ActionMenu
            occ={menu.occ} anchorRect={menu.rect} data={data}
            onEdit={() => openEditForOcc(menu.occ)}
            onMove={() => { setMoving(menu.occ); setMenu(null); }}
            onRemove={() => { setMoving(menu.occ); setMenu(null); }}
            onToggleDone={() => { toggleTask(menu.occ.id); setMenu(null); }}
            onUnslot={() => unslotTask(menu.occ.id)}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
    </Shell>
  );
}

// 동기화 시각을 "9월 16일(수) 14:13" 로. syncedAt 은 타임존이 붙은 완전한 시각이라
// new Date() 로 파싱해도 하루가 밀지 않는다 — 'YYYY-MM-DD' 날짜 문자열 금지 규칙은 그쪽 얘기다.
function syncedAtLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '알 수 없음';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${DOW[d.getDay()]}) ${hh}:${mm}`;
}

export default function PlanClient() {
  const [fixtureMode, setFixtureMode] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      const q = new URLSearchParams(window.location.search);
      if (q.get('fixture') === '1') setFixtureMode(true);
    }
  }, []);

  if (fixtureMode) return <PlanApp session={null} fixtureMode />;
  return <AuthGate>{(session) => <PlanApp session={session} fixtureMode={false} />}</AuthGate>;
}
