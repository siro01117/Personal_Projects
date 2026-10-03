"use client";

// 일정 화면 (docs/일정.md 6장, 목업 docs/mockup/schedule-v1.html).
// 데스크톱(앱 폭 760px 초과): 이번 주 7열 + 오른쪽 상세 패널(1180px 이상) / 블록 옆 작은 창(그 아래).
// 폰(760px 이하): 하루 타임라인 · 주 미니어처 + 보기 시트 · 수정 시트.
// 누르면 보기만, 고치기는 '수정' 을 한 번 더. 빈 칸 한 번 누르기는 아무것도 안 함, 두 번 누르기(데스크톱)는 새 일정.
// 고치는 중인 값은 줄에 얹어 미리 그린다(withDraft) — 동선·식사가 같이 따라 움직인다.
// 주소 ?date=YYYY-MM-DD&event=ID (플래너의 이어진 일정) 면 그 주·그날을 열고 그 일정을 고른다.
// 전환(docs/모션.md): 폰 하루는 좌우로 밀면 옆 날이 따라 들어온다(옆 칸을 미리 그려 둔다). 주 이동은 방향대로 미끄러진다. 상태는 먼저 바뀌고 화면이 뒤따른다.
// 반복 일정에는 '끝나면 할 일' 을 딸려 둘 수 있다(반복 규칙, docs/플래너.md 7-2). 일정을 지웠다 되돌리면 딸린 마감 · 규칙도 되살린다.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  addDays,
  daysBetween,
  DEFAULT_SETTINGS,
  isDateStr,
  planRange,
  roleForPlace,
  TITLE_MAX,
  validateEvent,
  type DateStr,
  type EventRow,
  type Occurrence,
  type Place,
  type TaskRow,
} from "../../../lib/schedule";
import type { EventDeps, EventRows } from "../../_data/types";
import { eventMenu } from "../../_logic/menus";
import { parseDueAfter } from "../../_logic/planner";
import {
  buildColumns,
  dayLabel,
  draftInput,
  draftOf,
  DRAFT_ID,
  duration,
  firstOccurrence,
  hourRange,
  mondayOf,
  moveTo,
  newAt,
  newDraft,
  nowIn,
  PX_PER_MIN,
  resizeTo,
  savePlan,
  scopesFor,
  shortWeekTitle,
  snap,
  spansOf,
  weekDates,
  weekTitle,
  WEEKDAYS,
  withDraft,
  type Draft,
  type Scope,
} from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { ghostOut, slideIn } from "../motion/motion";
import { Presence } from "../motion/Presence";
import { usePager } from "../motion/usePager";
import { HomeButton } from "../Shell";
import { ThemeToggle } from "../ThemeToggle";
import { useToast } from "../Toast";
import { toEntries, useContextMenu } from "../useContextMenu";
import { Detail } from "./Detail";
import { EventForm, NO_AFTER, type AfterDraft } from "./EventForm";
import { AllDayCell, Axis, ColumnItems, NowLine, type GridCtx } from "./Grid";
import { MiniWeek } from "./MiniWeek";
import { PlaceDot } from "./PlaceSymbol";
import { useScheduleData } from "./useScheduleData";

const PHONE_MAX = 760;
const PANEL_MIN = 1180;
/** 지금 선 갱신 간격 */
const CLOCK_MS = 30_000;

type Sel = { event_id: string; on_date: DateStr };
/** after = 끝나면 할 일 (반복 일정에 딸린 규칙), afterBase = 고치기 전 */
/** once = 우클릭 메뉴의 '이번만 바꾸기' 로 열었다 — 저장 범위는 이번만 (반복 규칙을 바꾸면 이후 모두) */
type Edit = { target: Sel | null; draft: Draft; base: Draft; taskId: string | null; after: AfterDraft; afterBase: AfterDraft; once?: boolean };
type Anchor = { left: number; right: number; top: number };
type Grab = { mode: "move" | "resize"; x: number; y: number; orig: Draft; offset: number; moved: boolean };

function useViewportWidth(): number | null {
  const [w, setW] = useState<number | null>(null);
  useEffect(() => {
    const f = () => setW(document.documentElement.clientWidth);
    f();
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return w;
}

/** 선택 → 지금 그리는 회차. 반복이 아닌 일정은 id 만으로 (날짜를 옮겨도 따라간다) */
/** 메뉴의 '이번만 바꾸기': 이번만을 고를 수 있으면 그것만 */
const onceOnly = (scopes: Scope[], once: boolean | undefined): Scope[] => (once && scopes.includes("once") ? ["once"] : scopes);

function findOcc(occs: readonly Occurrence[], rows: EventRows, sel: Sel | null): Occurrence | null {
  if (!sel) return null;
  const ev = rows.events.find((e) => e.id === sel.event_id);
  if (ev && ev.repeat === null) return occs.find((o) => o.event_id === sel.event_id) ?? null;
  return occs.find((o) => o.event_id === sel.event_id && o.on_date === sel.on_date) ?? null;
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

const tempId = () => `tmp-${globalThis.crypto.randomUUID()}`;

export function ScheduleView() {
  const { href } = useApp();
  const toast = useToast();
  const cm = useContextMenu();
  const width = useViewportWidth();
  const phone = (width ?? 1440) <= PHONE_MAX;
  const wide = (width ?? 1440) >= PANEL_MIN;

  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), CLOCK_MS);
    const vis = () => document.visibilityState === "visible" && setClock(Date.now());
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  const params = useSearchParams();
  const [start] = useState(() => {
    const d = params.get("date");
    const id = params.get("event");
    const date = isDateStr(d) ? d : nowIn(DEFAULT_SETTINGS.tz).date;
    return { date, sel: id && isDateStr(d) ? { event_id: id, on_date: d } : null };
  });
  const [week, setWeek] = useState<DateStr>(() => mondayOf(start.date));
  const [day, setDay] = useState<DateStr>(start.date);
  const [phoneMode, setPhoneMode] = useState<"day" | "week">("day");
  const [sel, setSel] = useState<Sel | null>(start.sel);
  /** 주소로 고른 일정 — 처음 스크롤을 그 일정에 맞추고, 좁은 데스크톱이면 작은 창을 그 블록 옆에 */
  const focus = useRef<Sel | null>(start.sel);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scopeAsk, setScopeAsk] = useState<{ x: number; y: number; orig: Draft } | null>(null);
  const [ghost, setGhost] = useState<{ task: TaskRow; x: number; y: number; draft: Draft | null } | null>(null);
  /** 폰 하루 넘김: 한 칸 넘게 건너뛸 때(주간 띠 · 오늘) 나가는 쪽 칸에 그려 둘 날 */
  const [from, setFrom] = useState<{ date: DateStr; dir: 1 | -1 } | null>(null);

  const D = useScheduleData(week);
  const { meta, rows, tasks, links, rules } = D;
  const tz = meta?.settings.tz ?? DEFAULT_SETTINGS.tz;
  const now = nowIn(tz, new Date(clock));
  const today = now.date;

  // ------------------------------------------------------------ 계산

  const view = useMemo(() => {
    if (edit) return withDraft(rows, edit.target, edit.draft, edit.taskId);
    if (ghost?.draft) return withDraft(rows, null, ghost.draft, ghost.task.id);
    return rows;
  }, [rows, edit, ghost]);

  const dates = useMemo(() => weekDates(week), [week]);
  const plan = useMemo(() => {
    if (!meta) return null;
    return planRange(week, addDays(week, 6), view.events, view.exceptions, meta.places, meta.travel, meta.settings);
  }, [meta, week, view]);
  const cols = useMemo(() => (plan ? buildColumns(dates, plan.occurrences, plan.days) : []), [plan, dates]);
  const liveRange = useMemo(() => hourRange(spansOf(cols)), [cols]);
  const frozen = useRef<{ from: number; to: number } | null>(null);
  const range = dragging || ghost ? (frozen.current ?? liveRange) : liveRange;
  if (!dragging && !ghost) frozen.current = liveRange;

  const places = useMemo(() => new Map((meta?.places ?? []).map((p) => [p.id, p])), [meta]);
  const placeList = useMemo<Place[]>(() => meta?.places ?? [], [meta]);
  const occs = plan?.occurrences ?? [];
  const selOcc = edit ? null : findOcc(occs, view, sel);
  const editOcc = edit ? (edit.target ? findOcc(occs, view, edit.target) : (occs.find((o) => o.event_id === DRAFT_ID) ?? null)) : null;
  const evOf = (id: string): EventRow | null => view.events.find((e) => e.id === id) ?? null;
  const segsOf = (d: DateStr) => plan?.days.find((p) => p.date === d)?.segments ?? [];
  const linked = useMemo(() => new Set(links.map((l) => l.task_id)), [links]);
  const openTasks = tasks.filter((t) => !t.done_at && !linked.has(t.id));
  const taskOf = (id: string | null) => (id ? (tasks.find((t) => t.id === id) ?? null) : null);
  /** 그 일정에 딸린 살아 있는 규칙 (끝나면 할 일) */
  const afterRule = (eventId: string) => rules.find((r) => r.kind === "event" && r.event_id === eventId) ?? null;

  const colsRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const phBodyRef = useRef<HTMLDivElement | null>(null);
  const wkRef = useRef<HTMLDivElement>(null);
  const grab = useRef<Grab | null>(null);
  const justDragged = useRef(false);
  const live = useRef({ week, range, edit, rows });
  live.current = { week, range, edit, rows };

  // 고른 회차가 사라지면(지움 · 다른 주) 보기를 닫는다
  useEffect(() => {
    if (sel && plan && D.loaded && !edit && !findOcc(plan.occurrences, view, sel)) {
      setSel(null);
      setAnchor(null);
    }
  }, [sel, plan, view, edit, D.loaded]);

  // ------------------------------------------------------------ 옮겨 다니기

  const closeAll = useCallback(() => {
    setSel(null);
    setEdit(null);
    setAnchor(null);
    setDeleting(false);
    setScopeAsk(null);
  }, []);

  const goWeek = useCallback(
    (w: DateStr) => {
      if (!edit) closeAll();
      setWeek(w);
    },
    [edit, closeAll],
  );
  const goDay = useCallback(
    (d: DateStr) => {
      if (d === day) return;
      const dir = d > day ? 1 : -1;
      setFrom(Math.abs(daysBetween(day, d)) > 1 ? { date: day, dir } : null);
      setDay(d);
      const w = mondayOf(d);
      if (w !== week) goWeek(w);
    },
    [day, week, goWeek],
  );
  const goToday = () => {
    if (phone) goDay(today);
    else goWeek(mondayOf(today));
  };
  const step = (n: number) => {
    if (phone && phoneMode === "day") goDay(addDays(day, n));
    else {
      const w = addDays(week, 7 * n);
      goWeek(w);
      setDay(addDays(day, 7 * n));
    }
  };

  // ------------------------------------------------------------ 넘기는 모션 (docs/모션.md)

  const dayPager = usePager(
    (n) => goDay(addDays(day, n)),
    () => setFrom(null),
  );
  const weekPager = usePager((n) => step(n));
  const setPhBody = useCallback(
    (el: HTMLDivElement | null) => {
      phBodyRef.current = el;
      dayPager.area(el);
    },
    [dayPager],
  );
  // 날 · 주는 이미 바뀌었다. 화면만 한 폭 옆에서(데스크톱 주간은 짧게) 미끄러져 들어온다
  const shown = useRef({ day, week });
  useLayoutEffect(() => {
    const p = shown.current;
    shown.current = { day, week };
    if (p.day !== day) dayPager.shift(day > p.day ? 1 : -1);
    if (p.week !== week) {
      const dir = week > p.week ? 1 : -1;
      weekPager.shift(dir);
      if (wkRef.current) slideIn(wkRef.current.querySelectorAll(".wk-head .dh, .wk-all .ad, .col-in"), dir);
    }
  }, [day, week, dayPager, weekPager]);
  useEffect(() => {
    if (!from) return;
    const id = setTimeout(() => setFrom(null), 320);
    return () => clearTimeout(id);
  }, [from]);
  // 폰 하루: 보이는 시간 범위가 바뀌어도(다른 주) 같은 시각이 그 자리에 있게
  const lastFrom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = phBodyRef.current;
    if (el?.dataset.placed && lastFrom.current !== null && lastFrom.current !== range.from) el.scrollTop += (lastFrom.current - range.from) * PX_PER_MIN;
    lastFrom.current = range.from;
  });

  // 방금 생긴 일정만 나타나는 애니메이션을 준다 (주를 옮겨 한꺼번에 들어온 것 · 임시 id 가 바뀐 것은 아니다)
  const seen = useRef<{ week: DateStr | null; ids: Set<string>; fresh: Map<string, number> }>({ week: null, ids: new Set(), fresh: new Map() });
  {
    const s = seen.current;
    const ids = new Set(occs.map((o) => o.event_id));
    if (!D.loaded) s.week = null;
    else if (s.week !== week) {
      s.week = week;
      s.ids = ids;
    } else {
      const added = [...ids].filter((id) => !s.ids.has(id));
      const lost = [...s.ids].some((id) => !ids.has(id));
      if (added.length > 0 && added.length <= 3 && !lost) for (const id of added) s.fresh.set(id, performance.now());
      s.ids = ids;
    }
  }
  const isFresh = (id: string) => {
    const at = seen.current.fresh.get(id);
    if (at === undefined) return false;
    if (performance.now() - at < 400) return true;
    seen.current.fresh.delete(id);
    return false;
  };

  // ------------------------------------------------------------ 보기 · 고치기 시작

  const pick = useCallback(
    (o: Occurrence, el: HTMLElement) => {
      if (o.event_id === DRAFT_ID || justDragged.current) return;
      if (edit) {
        if (editOcc?.key === o.key) return;
        setEdit(null);
      }
      setScopeAsk(null);
      setDeleting(false);
      setSel({ event_id: o.event_id, on_date: o.on_date });
      const r = el.getBoundingClientRect();
      setAnchor({ left: r.left, right: r.right, top: r.top });
    },
    [edit, editOcc],
  );

  function openNew(date: DateStr, start: number, end: number) {
    setSel(null);
    setAnchor(null);
    setDeleting(false);
    const d = newDraft(date, start, end);
    setEdit({ target: null, draft: d, base: d, taskId: null, after: NO_AFTER, afterBase: NO_AFTER });
  }

  function newHere() {
    const date = phone ? day : today >= week && today <= addDays(week, 6) ? today : week;
    const start = date === today ? Math.min(1410, Math.ceil((now.min + 1) / 30) * 30) : 540;
    openNew(date, start, start + 60);
  }

  function startEdit(o: Occurrence | null = selOcc, once = false) {
    if (!o) return;
    const ev = evOf(o.event_id);
    if (!ev || ev.source) return;
    const d = draftOf(o, ev);
    setDeleting(false);
    const rule = afterRule(ev.id);
    const after: AfterDraft = rule ? { title: rule.title, dueAfter: rule.due_after === null ? "" : String(rule.due_after) } : NO_AFTER;
    setEdit({ target: { event_id: o.event_id, on_date: o.on_date }, draft: d, base: d, taskId: ev.task_id, after, afterBase: after, once: once && ev.repeat !== null });
  }

  function cancelEdit() {
    const target = edit?.target ?? null;
    setEdit(null);
    setScopeAsk(null);
    setSel(target);
  }

  // ------------------------------------------------------------ 저장

  /** keep = 끌어 놓아 저장(고치기 상태 유지). revertTo = 실패하면 돌아갈 칸(끌기 전) */
  async function save(scope: Scope | null, keep = false, editState: Edit | null = edit, revertTo: Draft | null = null) {
    if (!editState) return;
    const { target, draft, base, taskId } = editState;
    const input = draftInput(draft);
    const issue = validateEvent(input)[0];
    if (issue) {
      toast(issue.path === "title" && input.title === "" ? "제목을 써 주세요" : issue.reason);
      return;
    }
    // 끝나면 할 일: 반복 일정에만. 제목을 비우면 없음(있던 규칙은 멈춘다)
    const afterTitle = draft.repeat === null ? "" : editState.after.title.trim();
    const afterDue = parseDueAfter(editState.after.dueAfter);
    if (afterTitle !== "" && Number.isNaN(afterDue)) {
      toast("마감까지는 0~60일입니다");
      return;
    }
    const afterChanged = afterTitle !== editState.afterBase.title.trim() || (afterTitle !== "" && editState.after.dueAfter.trim() !== editState.afterBase.dueAfter.trim());
    /** 일정을 저장한 뒤 규칙을 맞춘다. from = 고치기 전 일정(규칙이 딸려 있던 곳), to = 저장한 뒤의 일정 */
    const saveAfter = async (from: string | null, to: string) => {
      if (!afterChanged) return;
      const rule = from ? afterRule(from) : null;
      await D.runTask(async () => {
        if (!rule) {
          if (afterTitle === "") return;
          // 역할은 그 일정의 지점에서 (docs/플래너.md 7-11). 역할이 아직 없으면 기본 셋부터
          await D.T.seedRoles().catch(() => 0);
          const roles = await D.T.roles().catch(() => []);
          const role_id = roleForPlace(input.place_id ? places.get(input.place_id) : null, roles)?.id ?? null;
          // last_made = 오늘 — 지난 회차의 할 일이 바로 생기지 않게
          await D.T.createRule({
            kind: "event",
            title: afterTitle,
            note: null,
            est_min: null,
            place_id: null,
            checklist: [],
            repeat: null,
            start: null,
            event_id: to,
            due_after: afterDue,
            last_made: today,
            role_id,
          });
        } else if (afterTitle === "") await D.T.stopRule(rule.id);
        else await D.T.updateRule(rule.id, { title: afterTitle, due_after: afterDue });
      });
    };
    const ev = target ? (rows.events.find((e) => e.id === target.event_id) ?? null) : null;
    if (target && !ev) {
      toast("일정이 없습니다. 새로 불러오세요");
      setEdit(null);
      return;
    }
    const prev = target ? (rows.exceptions.find((x) => x.event_id === target.event_id && x.on_date === target.on_date)?.patch ?? null) : null;
    const how = savePlan(draft, base, ev, scope, prev);
    const ver = (srv: EventRows) => srv.events.find((e) => e.id === ev!.id)?.version ?? ev!.version;
    const after = (next: Sel | null) => {
      if (keep && next) setEdit({ ...editState, target: next, draft, base: draft });
      else setEdit(null);
      setSel(next);
    };
    const failed = () => {
      setEdit(revertTo ? { ...editState, draft: revertTo } : editState);
      setSel(null);
    };
    const preview = (r: EventRows) => withDraft(r, target, draft, taskId);

    if (how.kind === "none") {
      after(target);
      if (ev) await saveAfter(ev.id, ev.id);
      return;
    }
    if (how.kind === "create") {
      setEdit(null);
      const id = tempId();
      const row = await D.run(
        (r) => {
          const w = withDraft(r, null, draft, taskId);
          return { ...w, events: w.events.map((e) => (e.id === DRAFT_ID ? { ...e, id } : e)) };
        },
        () => D.S.createEvent({ ...how.input, task_id: taskId }),
      );
      if (row) {
        setSel({ event_id: row.id, on_date: row.date });
        await saveAfter(null, row.id);
      } else failed();
      return;
    }
    const onDate = target!.on_date;
    if (how.kind === "update") {
      after({ event_id: ev!.id, on_date: draft.date });
      const row = await D.run(preview, (srv) => D.S.updateEvent(ev!.id, ver(srv), how.patch));
      if (!row) failed();
      else await saveAfter(ev!.id, row.id);
      return;
    }
    if (how.kind === "once") {
      after(target);
      const ok = await D.run(preview, async () => {
        await D.S.setException(ev!.id, onDate, how.patch);
        return true;
      });
      if (!ok) failed();
      else await saveAfter(ev!.id, ev!.id);
      return;
    }
    // 이후 모두
    after(target);
    const row = await D.run(preview, (srv) => D.S.split(ev!.id, ver(srv), onDate, how.patch));
    if (!row) {
      failed();
      return;
    }
    const next = { event_id: row.id, on_date: how.patch.date ?? onDate };
    if (keep) setEdit((e) => (e ? { ...e, target: next } : e));
    setSel(next);
    // 나누면 규칙은 새 일정으로 옮겨져 있다 (데이터 층). 화면의 규칙 목록은 아직 옛 일정을 가리킨다
    await saveAfter(ev!.id, row.id);
  }

  const saveRef = useRef(save);
  saveRef.current = save;

  // ------------------------------------------------------------ 지우기

  async function remove(scope: Scope | null, occ: Occurrence | null = selOcc) {
    const selOcc = occ;
    if (!selOcc) return;
    const ev = evOf(selOcc.event_id);
    if (!ev || ev.source) return;
    if (ev.repeat !== null && scope === null) {
      setDeleting(true);
      return;
    }
    const on = selOcc.on_date;
    ghostOut(document.querySelector<HTMLElement>(`.ev[data-key="${CSS.escape(selOcc.key)}"]`));
    closeAll();
    const undoable = (label: string, undo: (srv: EventRows) => Promise<unknown>) =>
      toast(label, { label: "되돌리기", run: () => void D.run(null, undo) });
    /** 일정을 지우면 끊기는 것(딸린 마감 · 규칙)을 먼저 읽어 두고 지운다. 되돌릴 때 같이 되살린다 */
    const dropEvent = async (srv: EventRows, call: (version: number) => Promise<unknown>): Promise<EventDeps> => {
      const deps = await D.S.dependents(ev.id);
      await call(srv.events.find((e) => e.id === ev.id)?.version ?? ev.version);
      return deps;
    };

    if (ev.repeat === null) {
      const deps = await D.run(
        (r) => ({ ...r, events: r.events.filter((e) => e.id !== ev.id) }),
        (srv) => dropEvent(srv, (v) => D.S.deleteEvent(ev.id, v)),
      );
      if (deps) undoable("일정을 지웠습니다", () => D.S.restoreEvent(ev.id, deps));
      return;
    }
    if (scope === "once") {
      const prev = rows.exceptions.find((x) => x.event_id === ev.id && x.on_date === on) ?? null;
      const ok = await D.run(
        (r) => ({
          ...r,
          exceptions: [...r.exceptions.filter((x) => !(x.event_id === ev.id && x.on_date === on)), { event_id: ev.id, on_date: on, skip: true, patch: null }],
        }),
        async () => {
          await D.S.setException(ev.id, on, null);
          return true;
        },
      );
      if (ok) undoable("일정을 지웠습니다", () => (prev && !prev.skip ? D.S.setException(ev.id, on, prev.patch) : D.S.clearException(ev.id, on)));
      return;
    }
    // 이후 모두
    const first = firstOccurrence(ev) === on;
    const oldRepeat = ev.repeat;
    const removed = rows.exceptions.filter((x) => x.event_id === ev.id && x.on_date >= on);
    const deps = await D.run(
      (r) =>
        first
          ? { ...r, events: r.events.filter((e) => e.id !== ev.id) }
          : {
              events: r.events.map((e) => (e.id === ev.id && e.repeat ? { ...e, repeat: { ...e.repeat, until: addDays(on, -1) } } : e)),
              exceptions: r.exceptions.filter((x) => !(x.event_id === ev.id && x.on_date >= on)),
            },
      (srv) => dropEvent(srv, (v) => D.S.cut(ev.id, v, on)),
    );
    if (!deps) return;
    undoable("일정을 지웠습니다", async (srv) => {
      if (first) return D.S.restoreEvent(ev.id, deps);
      const v = srv.events.find((e) => e.id === ev.id)?.version ?? ev.version + 1;
      await D.S.updateEvent(ev.id, v, { repeat: oldRepeat });
      for (const x of removed) await D.S.setException(x.event_id, x.on_date, x.skip ? null : x.patch);
    });
  }

  async function toggleTask(t: TaskRow) {
    const done = !t.done_at;
    const row = await D.runTask(() => D.T.setDone(t.id, t.version, done));
    if (row && done) toast("끝냈습니다", { label: "되돌리기", run: () => void D.runTask(() => D.T.setDone(row.id, row.version, false)) });
  }

  // ------------------------------------------------------------ 끌기 (데스크톱 마우스, 고치는 블록만) · 할 일 놓기


  /** 격자 위 좌표 → 몇째 날 · 몇 분 (밖이면 null, clamp 면 가장자리로) */
  const hit = useCallback((x: number, y: number, clamp = false): { dayIndex: number; min: number } | null => {
    const el = colsRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    if (!inside && !clamp) return null;
    const cx = Math.min(r.right - 1, Math.max(r.left, x));
    const cy = Math.min(r.bottom, Math.max(r.top, y));
    const { range: rg } = live.current;
    return { dayIndex: Math.min(6, Math.max(0, Math.floor(((cx - r.left) / r.width) * 7))), min: rg.from + (cy - r.top) / PX_PER_MIN };
  }, []);

  const onGrab = useCallback(
    (e: ReactPointerEvent<HTMLElement>, _o: Occurrence, mode: "move" | "resize") => {
      const cur = live.current.edit;
      if (e.pointerType !== "mouse" || e.button !== 0 || !cur || cur.draft.allDay) return;
      const h = hit(e.clientX, e.clientY, true);
      if (!h) return;
      e.preventDefault();
      const occDay = daysBetween(live.current.week, cur.draft.date);
      grab.current = { mode, x: e.clientX, y: e.clientY, orig: cur.draft, offset: h.dayIndex * 1440 + h.min - (occDay * 1440 + cur.draft.start), moved: false };

      const move = (ev: PointerEvent) => {
        const g = grab.current;
        if (!g) return;
        if (!g.moved && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < 4) return;
        if (!g.moved) {
          g.moved = true;
          setDragging(true);
        }
        const p = hit(ev.clientX, ev.clientY, true)!;
        const w = live.current.week;
        let next: Pick<Draft, "date" | "start" | "end">;
        if (g.mode === "move") {
          const abs = p.dayIndex * 1440 + p.min - g.offset;
          const di = Math.min(6, Math.max(0, Math.floor(abs / 1440)));
          const m = moveTo(g.orig.start, g.orig.end, abs - di * 1440);
          next = { date: addDays(w, di), ...m };
        } else {
          const occDay2 = daysBetween(w, g.orig.date);
          next = { date: g.orig.date, start: g.orig.start, end: resizeTo(g.orig.start, (p.dayIndex - occDay2) * 1440 + p.min) };
        }
        setEdit((x) => (x ? { ...x, draft: { ...x.draft, ...next } } : x));
      };
      const up = (ev: PointerEvent) => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        const g = grab.current;
        grab.current = null;
        if (!g?.moved) return;
        justDragged.current = true;
        setTimeout(() => (justDragged.current = false), 0);
        setDragging(false);
        const st = live.current.edit;
        if (!st) return;
        const d = st.draft;
        if (d.date === g.orig.date && d.start === g.orig.start && d.end === g.orig.end) return;
        if (!st.target) return; // 새 일정은 칸만 바뀐다
        const ev0 = live.current.rows.events.find((x) => x.id === st.target!.event_id);
        if (ev0?.repeat) setScopeAsk({ x: ev.clientX, y: ev.clientY, orig: g.orig });
        else void saveRef.current(null, true, st, g.orig);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    },
    // 놓을 때는 live · saveRef 로 최신 상태를 읽는다
    [hit],
  );

  function dropScope(scope: Scope | null) {
    const ask = scopeAsk;
    setScopeAsk(null);
    if (!ask || !edit) return;
    if (scope === null) {
      setEdit({ ...edit, draft: { ...edit.draft, date: ask.orig.date, start: ask.orig.start, end: ask.orig.end } });
      return;
    }
    void save(scope, true, edit, ask.orig);
  }

  function grabTask(e: ReactPointerEvent<HTMLElement>, task: TaskRow) {
    if (e.button !== 0 || e.pointerType !== "mouse") return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    let last: Draft | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      const h = hit(ev.clientX, ev.clientY);
      const len = task.est_min ?? 60;
      if (h) {
        const start = Math.min(1440 - 15, Math.max(0, snap(h.min - 15)));
        last = { ...newDraft(addDays(live.current.week, h.dayIndex), start, start + len), title: [...task.title].slice(0, TITLE_MAX).join("").trim(), place_id: task.place_id };
      } else last = null;
      setGhost({ task, x: ev.clientX, y: ev.clientY, draft: last });
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      setGhost(null);
      if (moved && last) void placeTask(task, last);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  async function placeTask(task: TaskRow, d: Draft) {
    const id = tempId();
    D.setLinks((l) => [...l, { task_id: task.id, event_id: id, date: d.date, start_min: d.start, end_min: d.end, repeating: false }]);
    const row = await D.run(
      (r) => {
        const w = withDraft(r, null, d, task.id);
        return { ...w, events: w.events.map((e) => (e.id === DRAFT_ID ? { ...e, id } : e)) };
      },
      () => D.S.createEvent({ ...draftInput(d), task_id: task.id }),
    );
    if (row) setSel({ event_id: row.id, on_date: row.date });
  }

  // ------------------------------------------------------------ 키보드

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        if (scopeAsk) dropScope(null);
        else if (deleting) setDeleting(false);
        else if (edit) cancelEdit();
        else if (sel) {
          setSel(null);
          setAnchor(null);
        } else return;
        e.preventDefault();
        return;
      }
      if (isTyping(e.target) || edit) return;
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "t" || e.key === "T") goToday();
      else if (e.key === "n" || e.key === "N") newHere();
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------ 처음 열 때 스크롤

  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!plan || width === null || !D.loaded) return;
    const el = phone ? phBodyRef.current : bodyRef.current;
    if (!el) return;
    if (phone) {
      // 폰: 하루 보기를 열 때 한 번만. 날을 넘겨도 스크롤(시각)은 그대로 둔다
      if (el.dataset.placed) return;
      el.dataset.placed = "1";
    } else {
      if (scrolled.current === week) return;
      scrolled.current = week;
    }
    const shown = phone ? cols.filter((c) => c.date === day) : cols;
    const starts = shown.flatMap((c) => c.items.filter((l) => l.item.kind === "ev").map((l) => l.item.start));
    const nowShown = shown.some((c) => c.date === today) && now.min >= range.from && now.min <= range.to;
    const focused = focus.current ? findOcc(occs, view, focus.current) : null;
    const target = focused?.start_min != null ? focused.start_min - 30 : nowShown ? now.min - 90 : starts.length ? Math.min(...starts) - 30 : range.from;
    el.scrollTop = Math.max(0, (target - range.from) * PX_PER_MIN);
  });

  // 주소로 고른 일정: 좁은 데스크톱은 블록 옆 작은 창에 앵커가 필요하다
  useEffect(() => {
    if (!focus.current || !plan || !D.loaded) return;
    if (!findOcc(plan.occurrences, view, focus.current)) return;
    focus.current = null;
    if (phone || wide || anchor) return;
    const el = document.querySelector<HTMLElement>(".ev.sel");
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ left: r.left, right: r.right, top: r.top });
  });

  // ------------------------------------------------------------ 그리기

  if (width === null || !meta || !plan || !D.ready) return <div className="sched" />;

  const ctx: GridCtx = {
    places,
    sourceLabel: (s) => meta.sources.find((x) => x.source === s)?.label ?? s,
    taskDone: (id) => {
      if (!id) return null;
      const t = taskOf(id);
      return t ? t.done_at !== null : null;
    },
    selKey: selOcc?.key ?? null,
    editKey: editOcc?.key ?? null,
    dragging,
    fresh: isFresh,
    onPick: pick,
    onGrab: phone ? undefined : onGrab,
    menu: (o) => cm.bind(`ev:${o.key}`, (el) => blockMenu(o, el)),
  };
  /** 블록의 우클릭 · 길게 누르기 메뉴 (docs/공통.md 2장) — 보기 패널의 동작. 고치는 중인 블록은 끌기 · 손잡이 몫 */
  function blockMenu(o: Occurrence, el: HTMLElement) {
    if (editOcc?.key === o.key) return [];
    const ev = evOf(o.event_id);
    return toEntries(eventMenu({ draft: o.event_id === DRAFT_ID, external: !ev || !!ev.source, repeating: !!ev?.repeat }), (act) => {
      pick(o, el);
      if (act === "edit" || act === "once") startEdit(o, act === "once");
      else if (act === "delete") void remove(null, o);
      else if (act === "deleteOnce") void remove("once", o);
      else if (act === "deleteFollowing") void remove("following", o);
    });
  }
  const height = (range.to - range.from) * PX_PER_MIN;
  const ev = selOcc ? evOf(selOcc.event_id) : null;
  const detail = selOcc && (
    <Detail
      occ={selOcc}
      ev={ev}
      places={places}
      sources={meta.sources}
      segments={segsOf(selOcc.date)}
      task={taskOf(selOcc.task_id)}
      after={ev?.repeat ? (afterRule(ev.id)?.title ?? null) : null}
      tz={tz}
      deleting={deleting}
      onEdit={() => startEdit()}
      onDelete={(s) => void remove(s)}
      onCancelDelete={() => setDeleting(false)}
      onToggleTask={(t) => void toggleTask(t)}
    />
  );
  const editEv = edit?.target ? (rows.events.find((e) => e.id === edit.target!.event_id) ?? null) : null;
  const form = edit && (
    <EventForm
      key={edit.target ? `${edit.target.event_id}:${edit.target.on_date}` : "new"}
      draft={edit.draft}
      onChange={(d) => setEdit((x) => (x ? { ...x, draft: d } : x))}
      places={placeList}
      scopes={onceOnly(scopesFor(edit.draft, edit.base, editEv), edit.once)}
      isNew={edit.target === null}
      after={edit.after}
      onAfter={(a) => setEdit((x) => (x ? { ...x, after: a } : x))}
      onSave={(s) => void save(s)}
      onCancel={cancelEdit}
    />
  );

  if (phone) {
    const dayCol = cols.find((c) => c.date === day);
    // 가운데 = 보는 날, 양옆 = 이전 · 다음 날(미리 그려 둔다). 다른 주의 날은 그 주를 읽을 때까지 빈 틀
    const panes: [DateStr, "l" | "" | "r"][] = [
      [from?.dir === 1 ? from.date : addDays(day, -1), "l"],
      [day, ""],
      [from?.dir === -1 ? from.date : addDays(day, 1), "r"],
    ];
    return (
      <div className="sched phone">
        <div className="ph-top">
          <HomeButton />
          <button type="button" className="iconbtn" aria-label={phoneMode === "day" ? "전날" : "지난주"} onClick={() => step(-1)}>
            <Icon name="left" />
          </button>
          <h2>
            {phoneMode === "day" ? (
              <>
                {dayLabel(day, false)}
                <span className="wd"> {WEEKDAYS[daysBetween(week, day)]}</span>
              </>
            ) : (
              shortWeekTitle(week)
            )}
          </h2>
          <button type="button" className="iconbtn" aria-label={phoneMode === "day" ? "다음날" : "다음 주"} onClick={() => step(1)}>
            <Icon name="right" />
          </button>
          <span className="grow" />
          <div className="seg vseg" role="group" aria-label="보기">
            <button type="button" aria-pressed={phoneMode === "day"} onClick={() => setPhoneMode("day")}>
              하루
            </button>
            <button type="button" aria-pressed={phoneMode === "week"} onClick={() => setPhoneMode("week")}>
              주
            </button>
          </div>
          {phoneMode === "day" ? (
            <button type="button" className="ghost" onClick={goToday}>
              오늘
            </button>
          ) : (
            <Link className="iconbtn" href={href("/schedule/settings")} aria-label="설정" title="설정">
              <Icon name="gear" />
            </Link>
          )}
          <ThemeToggle />
        </div>
        {phoneMode === "day" ? (
          <div className="ph-view" key="day">
            <div className="strip">
              {cols.map((c, i) => (
                <button
                  type="button"
                  key={c.date}
                  className={`sd${c.date === today ? " today" : ""}${c.date === day ? " pick" : ""}`}
                  aria-pressed={c.date === day}
                  onClick={() => goDay(c.date)}
                >
                  <span className="w">{WEEKDAYS[i]}</span>
                  <span className="d num">{Number(c.date.slice(8))}</span>
                  <i className={c.allDay.length > 0 || c.items.some((l) => l.item.kind === "ev") ? "dot" : "dot no"} />
                </button>
              ))}
            </div>
            <div className="ph-all">{dayCol && <AllDayCell allDay={dayCol.allDay} missing={dayCol.missing} ctx={ctx} />}</div>
            <div className="ph-body" ref={setPhBody}>
              <div className="ph-grid" style={{ height }}>
                <Axis from={range.from} to={range.to} now={day === today ? now.min : null} />
                <div className="pg">
                  <div className="pg-track" ref={dayPager.track}>
                    {panes.map(([d, slot]) => {
                      const c = cols.find((x) => x.date === d);
                      return (
                        <div key={d} className={slot ? `ph-col pg-pane ${slot}` : "ph-col pg-pane"} inert={slot !== ""} aria-hidden={slot !== "" || undefined}>
                          {c && <ColumnItems items={c.items} from={range.from} ctx={ctx} />}
                          {d === today && <NowLine from={range.from} to={range.to} now={now.min} />}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="ph-view" key="week">
            <MiniWeek
              cols={cols}
              today={today}
              now={now.min}
              places={places}
              pager={weekPager}
              onPick={(d) => {
                setFrom(null);
                setDay(d);
                setPhoneMode("day");
              }}
            />
          </div>
        )}
        <button type="button" className="fab" aria-label="새 일정" onClick={newHere}>
          <Icon name="plus" />
        </button>
        <Presence>{(selOcc || edit) && <div className={edit ? "scrim" : "scrim light"} onClick={edit ? cancelEdit : () => setSel(null)} />}</Presence>
        <Presence>
          {(selOcc || edit) && (
            <div className={edit ? "sheet" : "sheet peek"} role="dialog" aria-label={edit ? (edit.target ? "일정 수정" : "새 일정") : selOcc!.title}>
              <span className="grab" />
              {/* 보기 → 수정: 같은 시트가 커지고 내용만 새로 나타난다 */}
              <div className="sh-in" key={edit ? "edit" : `view:${selOcc!.key}`}>
                {edit ? form : detail}
              </div>
            </div>
          )}
        </Presence>
        {cm.node}
      </div>
    );
  }

  const panel = form ?? detail ?? (
    <>
      <h2 className="tasks-h">할 일</h2>
      {openTasks.length > 0 ? (
        <ul className="tasks" aria-label="할 일 (시간 없음)">
          {openTasks.map((t) => {
            const place = t.place_id ? places.get(t.place_id) : undefined;
            return (
              <li key={t.id} onPointerDown={(e) => grabTask(e, t)} title="끌어서 시간표에 놓기">
                <span className="ring" aria-hidden="true" />
                <span className={place ? `nm pc-${place.color}` : "nm"}>
                  {place && <PlaceDot />}
                  {t.title}
                </span>
                {t.est_min !== null && <span className="est">{duration(t.est_min)}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="tasks-empty">할 일이 없습니다</p>
      )}
    </>
  );

  let popStyle: { left: number; top: number } | null = null;
  if (!wide && selOcc && anchor && !edit) {
    const w = 268;
    const left = anchor.right + 8 + w <= innerWidth ? anchor.right + 8 : Math.max(8, anchor.left - w - 8);
    popStyle = { left, top: Math.max(8, Math.min(anchor.top, innerHeight - 360)) };
  }

  return (
    <div className="sched">
      <div className="bar-top">
        <button type="button" className="ghost" onClick={goToday}>
          오늘
        </button>
        <button type="button" className="iconbtn" aria-label="지난주" title="지난주" onClick={() => step(-1)}>
          <Icon name="left" />
        </button>
        <button type="button" className="iconbtn" aria-label="다음 주" title="다음 주" onClick={() => step(1)}>
          <Icon name="right" />
        </button>
        <h1>{weekTitle(week)}</h1>
        <span className="grow" />
        <Link className="iconbtn" href={href("/schedule/settings")} aria-label="설정" title="설정">
          <Icon name="gear" />
        </Link>
        <button type="button" className="btn" onClick={newHere}>
          <Icon name="plus" />
          <span className="bt-label">새 일정</span>
        </button>
        <ThemeToggle />
      </div>
      <div className="stage">
        <div className="wk" ref={wkRef}>
          <div className="wk-row wk-head">
            <span />
            {dates.map((d, i) => (
              <div key={d} className={d === today ? "dh today" : "dh"}>
                <span className="w">{WEEKDAYS[i]}</span>
                <span className="d num">{Number(d.slice(8))}</span>
              </div>
            ))}
          </div>
          <div className="wk-row wk-all">
            <span />
            {cols.map((c) => (
              <div key={c.date} className="ad">
                <AllDayCell allDay={c.allDay} missing={c.missing} ctx={ctx} />
              </div>
            ))}
          </div>
          <div className="wk-body" ref={bodyRef}>
            <div className="wk-grid" style={{ height }}>
              <Axis from={range.from} to={range.to} now={today >= week && today <= addDays(week, 6) ? now.min : null} />
              <div
                className="cols"
                ref={colsRef}
                onClick={() => {
                  // 빈 칸 한 번 누르기는 아무것도 만들지 않는다. 좁은 화면의 작은 창만 닫는다
                  if (!wide && anchor && !edit) setSel(null);
                }}
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest(".ev")) return;
                  const h = hit(e.clientX, e.clientY);
                  if (!h) return;
                  const t = newAt(h.min);
                  openNew(addDays(week, h.dayIndex), t.start, t.end);
                }}
              >
                {cols.map((c) => (
                  <div key={c.date} className="col">
                    <div className="col-in">
                      <ColumnItems items={c.items} from={range.from} ctx={ctx} />
                    </div>
                    {c.date === today && <NowLine from={range.from} to={range.to} now={now.min} />}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        {wide && (
          <aside className="dp" aria-label={edit ? "일정 수정" : selOcc ? "고른 일정" : "할 일"}>
            <div className="dp-in" key={edit ? `e:${edit.target ? `${edit.target.event_id}:${edit.target.on_date}` : "new"}` : selOcc ? `v:${selOcc.key}` : "tasks"}>
              {panel}
            </div>
          </aside>
        )}
        <Presence>
          {!wide && edit && (
            <aside className="dp float" aria-label="일정 수정">
              {form}
            </aside>
          )}
        </Presence>
      </div>
      <Presence>
        {popStyle && (
          <div className="pop" style={popStyle} role="dialog" aria-label={selOcc!.title}>
            <button type="button" className="iconbtn x" aria-label="닫기" onClick={() => setSel(null)}>
              <Icon name="x" />
            </button>
            {detail}
          </div>
        )}
      </Presence>
      {scopeAsk && (
        <div className="pop scope-pop" style={{ left: Math.min(scopeAsk.x + 12, innerWidth - 220), top: Math.min(scopeAsk.y + 12, innerHeight - 64) }} role="dialog" aria-label="바꿀 범위">
          <div className="scope">
            <button type="button" onClick={() => dropScope("once")}>
              이번만
            </button>
            <button type="button" onClick={() => dropScope("following")}>
              이후 모두
            </button>
          </div>
        </div>
      )}
      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          {ghost.task.title}
        </div>
      )}
      {cm.node}
    </div>
  );
}
