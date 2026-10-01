"use client";

// 플래너 화면 (docs/플래너.md 3장 · 7장). 맨 위 한 줄 입력 → 목록 넷(지남 · 할 일 · 시간 정함 · 끝냄).
// 줄 누르기는 보기만(넓은 데스크톱 오른쪽 패널 · 좁은 데스크톱 떠 있는 패널 · 폰 보기 시트), 고치기는 '수정' 을 한 번 더.
// 끝냄 체크와 체크 항목만 바로 된다. 할 일 목록은 데스크톱 마우스로 끌어 순서를 바꾼다(sort 는 앞뒤 가운데 값).
// 지남은 자동으로 넘기지 않는다 — 다시 정하기 · 시간 없음으로 · 마감 바꾸기 · 마감 지우기를 사람이 고른다.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  addDays,
  DEFAULT_SETTINGS,
  TASK_TITLE_MAX,
  TITLE_MAX,
  validateEvent,
  validateTask,
  type EventRow,
  type Repeat,
  type TaskRow,
  type TaskRule,
} from "../../../lib/schedule";
import type { EventDeps, RuleInput, TaskInput, TaskLink } from "../../_data/types";
import {
  DEFAULT_LEN,
  dueOptions,
  lateOf,
  mergeChecklist,
  moved,
  moveSort,
  parseChecks,
  parseDueAfter,
  parseMinutes,
  ruleLabel,
  splitTasks,
  taskDraft,
  toggleCheck,
  type TaskDraft,
  type TaskScope,
} from "../../_logic/planner";
import { draftInput, newDraft, nowIn, type Draft } from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { Menu } from "../Menu";
import { EventForm } from "../schedule/EventForm";
import { HomeButton } from "../Shell";
import { ThemeToggle } from "../ThemeToggle";
import { useToast } from "../Toast";
import { DueForm } from "./DueForm";
import { PlanForm, planDraftFor, type PlanDraft } from "./PlanForm";
import { TaskDetail } from "./TaskDetail";
import { TaskForm } from "./TaskForm";
import { TaskLine } from "./TaskLine";
import { usePlannerData, type PlannerState } from "./usePlannerData";

const PHONE_MAX = 760;
const PANEL_MIN = 1180;
const CLOCK_MS = 60_000;

type Edit = { id: string; base: number; draft: TaskDraft; baseDraft: TaskDraft; stale: boolean };
type Plan = { id: string; draft: PlanDraft };
type DueEdit = { id: string; due: string };
/** 일정으로 보내기 — 일정 입력 칸 */
type Send = { id: string; draft: Draft };
type Drag = { id: string; to: number };

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

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

const tempId = () => `tmp-${globalThis.crypto.randomUUID()}`;
const isTemp = (id: string) => id.startsWith("tmp-");

const mapTask = (s: PlannerState, id: string, f: (t: TaskRow) => TaskRow): PlannerState => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? f(t) : t)) });

/** 그 할 일이 나온 살아 있는 규칙 */
const ruleOf = (s: PlannerState | null, t: TaskRow | null): TaskRule | null => (t?.rule_id ? (s?.rules.find((r) => r.id === t.rule_id) ?? null) : null);

export function PlannerView() {
  const { href } = useApp();
  const toast = useToast();
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
  const now = nowIn(DEFAULT_SETTINGS.tz, new Date(clock));
  const today = now.date;
  const nowMin = now.min;

  const D = usePlannerData();
  const state = D.state;
  const [text, setText] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [dueEdit, setDueEdit] = useState<DueEdit | null>(null);
  const [send, setSend] = useState<Send | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [linkedEv, setLinkedEv] = useState<EventRow | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLUListElement>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const justDragged = useRef(false);

  const lists = useMemo(
    () => splitTasks(state?.tasks ?? [], state?.links ?? [], new Date(clock), { date: today, min: nowMin }),
    [state, clock, today, nowMin],
  );
  const openShown = drag ? moved(lists.open, drag.id, drag.to) : lists.open;
  const linkOf = useMemo(() => new Map((state?.links ?? []).map((l) => [l.task_id, l])), [state]);
  const placeOf = useMemo(() => new Map(D.places.map((p) => [p.id, p])), [D.places]);
  const liveRules = useMemo(() => new Set((state?.rules ?? []).map((r) => r.id)), [state]);
  const selTask = sel ? (state?.tasks.find((t) => t.id === sel) ?? null) : null;
  const selLink: TaskLink | null = selTask ? (linkOf.get(selTask.id) ?? null) : null;

  // 고른 할 일이 사라지면(지움 · 다른 곳에서 지움) 닫는다
  useEffect(() => {
    if (sel && state && !state.tasks.some((t) => t.id === sel)) {
      setSel(null);
      setEdit(null);
      setPlan(null);
      setDueEdit(null);
      setSend(null);
      setMenu(null);
    }
  }, [sel, state]);

  // 이어진 일정의 끝 시각 · 반복
  const evId = selLink?.event_id ?? null;
  const evDate = selLink?.date ?? null;
  const S = D.S;
  useEffect(() => {
    setLinkedEv(null);
    if (!evId || !evDate || isTemp(evId)) return;
    let alive = true;
    S.events(evDate, evDate).then(
      (r) => alive && setLinkedEv(r.events.find((e) => e.id === evId) ?? null),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [evId, evDate, S]);

  // 저장이 버전 충돌로 실패한 수정 칸은 새로 불러온 값으로 다시 연다
  useEffect(() => {
    if (!edit?.stale || !state) return;
    const t = state.tasks.find((x) => x.id === edit.id);
    if (t && t.version !== edit.base) {
      const d = taskDraft(t, ruleOf(state, t), state.titles);
      setEdit({ id: t.id, base: t.version, draft: d, baseDraft: d, stale: false });
    }
  }, [edit, state]);

  const closeForms = useCallback(() => {
    setEdit(null);
    setPlan(null);
    setDueEdit(null);
    setSend(null);
    setMenu(null);
  }, []);

  const closeAll = useCallback(() => {
    setSel(null);
    closeForms();
  }, [closeForms]);

  // ------------------------------------------------------------ 넣기 · 끝냄 · 체크 항목 · 순서

  function add() {
    const title = text.trim();
    if (title === "" || !state) return;
    const issue = validateTask({ title })[0];
    if (issue) {
      toast(issue.reason);
      return;
    }
    setText("");
    const at = new Date().toISOString();
    const sort = Math.min(0, ...state.tasks.map((t) => t.sort)) - 1;
    const temp: TaskRow = {
      id: tempId(),
      title,
      note: null,
      due: null,
      est_min: null,
      sort,
      done_at: null,
      origin_kind: null,
      origin_id: null,
      place_id: null,
      due_event_id: null,
      checklist: [],
      rule_id: null,
      rule_date: null,
      version: 1,
      created_at: at,
      updated_at: at,
    };
    void D.run((s) => ({ ...s, tasks: [temp, ...s.tasks] }), () => D.T.createTask({ title }));
  }

  async function toggle(t: TaskRow) {
    if (isTemp(t.id)) return;
    const done = t.done_at === null;
    const at = new Date().toISOString();
    const row = await D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, done_at: done ? at : null })),
      (srv) => D.T.setDone(t.id, D.versionOf(srv, t.id, t.version), done),
    );
    if (row && done) {
      toast("끝냈습니다", {
        label: "되돌리기",
        run: () =>
          void D.run(
            (s) => mapTask(s, t.id, (x) => ({ ...x, done_at: null })),
            (srv) => D.T.setDone(t.id, D.versionOf(srv, t.id, row.version), false),
          ),
      });
    }
  }

  /** 체크 항목 체크는 바로. 버전과 지금 목록은 부를 때의 서버 값에서 읽는다(빠르게 여러 개 눌러도 안 엇갈리게) */
  function check(t: TaskRow, i: number, done: boolean) {
    void D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, checklist: toggleCheck(x.checklist, i, done) })),
      (srv) => {
        const cur = srv.tasks.find((x) => x.id === t.id) ?? t;
        return D.T.updateTask(t.id, cur.version, { checklist: toggleCheck(cur.checklist, i, done) });
      },
    );
  }

  function grab(e: ReactPointerEvent<HTMLLIElement>, t: TaskRow) {
    if (e.pointerType !== "mouse" || e.button !== 0 || isTemp(t.id)) return;
    const sy = e.clientY;
    const from = lists.open.findIndex((x) => x.id === t.id);
    const list = lists.open;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientY - sy) < 4) return;
      if (!started) {
        started = true;
        document.body.classList.add("pl-grabbing");
        setDrag({ id: t.id, to: from });
      }
      const rows = [...(openRef.current?.querySelectorAll<HTMLElement>("li[data-id]") ?? [])].filter((el) => el.dataset.id !== t.id);
      let to = 0;
      for (const el of rows) {
        const r = el.getBoundingClientRect();
        if (ev.clientY > r.top + r.height / 2) to++;
      }
      setDrag((d) => (d && d.to !== to ? { ...d, to } : d));
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (!started) return;
      document.body.classList.remove("pl-grabbing");
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      const to = dragRef.current?.to ?? from;
      setDrag(null);
      const sort = moveSort(list, t.id, to);
      if (sort === null) return;
      void D.run(
        (s) => mapTask(s, t.id, (x) => ({ ...x, sort })),
        () => D.T.reorder(t.id, sort),
      );
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  // ------------------------------------------------------------ 보기 · 수정

  function pick(t: TaskRow) {
    if (justDragged.current || isTemp(t.id)) return;
    closeForms();
    setSel((s) => (s === t.id && !phone ? null : t.id));
  }

  function startEdit() {
    if (!selTask || !state) return;
    closeForms();
    const d = taskDraft(selTask, ruleOf(state, selTask), state.titles);
    setEdit({ id: selTask.id, base: selTask.version, draft: d, baseDraft: d, stale: false });
  }

  async function saveEdit(scope: TaskScope | null) {
    if (!edit || !state) return;
    const t = state.tasks.find((x) => x.id === edit.id);
    if (!t) {
      setEdit(null);
      return;
    }
    const d = edit.draft;
    const title = d.title.trim();
    const est = parseMinutes(d.est);
    const note = d.note.trim() === "" ? null : d.note;
    const due = d.due === "" ? null : d.due;
    const dueEvent = due === null ? null : (d.dueEvent?.id ?? null);
    const issue = validateTask({ title, est_min: est, note, due })[0];
    if (issue) {
      toast(issue.path === "title" && title === "" ? "제목을 써 주세요" : issue.reason);
      return;
    }
    const checks = parseChecks(d.checks);
    if (checks.issue) {
      toast(checks.issue);
      return;
    }
    const dueAfter = d.repeat === "none" ? null : parseDueAfter(d.dueAfter);
    if (Number.isNaN(dueAfter)) {
      toast("마감까지는 0~60일입니다");
      return;
    }
    if (d.repeat === "weekly" && d.days.length === 0) {
      toast("요일을 하나 이상 고르세요");
      return;
    }

    const patch: Partial<TaskInput> = {};
    if (title !== t.title) patch.title = title;
    if (est !== t.est_min) patch.est_min = est;
    if (note !== t.note) patch.note = note;
    if (d.place_id !== t.place_id) patch.place_id = d.place_id;
    const checklist = mergeChecklist(t.checklist, checks.texts);
    if (JSON.stringify(checklist) !== JSON.stringify(t.checklist)) patch.checklist = checklist;
    // 마감을 바꾸거나 지울 때는 일정 연결도 같이 보낸다 (건 채로 날짜만 바꾸면 DB 가 거절한다)
    if (due !== t.due || dueEvent !== t.due_event_id) {
      patch.due = due;
      patch.due_event_id = dueEvent;
    }

    // 반복: 새로 켜면 규칙을 만들고 이 할 일이 첫 회차, 끄면 규칙을 멈춘다, '앞으로도' 면 규칙도 고친다
    const rule = ruleOf(state, t);
    const repeat: Repeat = d.repeat === "daily" ? { freq: "daily" } : d.repeat === "weekly" ? { freq: "weekly", days: d.days } : null;
    const shape = { title, note, est_min: est, place_id: d.place_id, checklist: checks.texts };
    let create: RuleInput | null = null;
    let stop: string | null = null;
    let update: { id: string; patch: Partial<RuleInput> } | null = null;
    if (!rule && repeat) {
      create = { kind: "cycle", ...shape, repeat, start: today, event_id: null, due_after: dueAfter, last_made: today };
      if (due === null && dueAfter !== null) {
        patch.due = addDays(today, dueAfter);
        patch.due_event_id = null;
      }
    } else if (rule && d.repeat === "none") stop = rule.id;
    else if (rule && scope === "future") {
      update = { id: rule.id, patch: { ...shape, due_after: dueAfter, ...(rule.kind === "cycle" && repeat ? { repeat } : {}) } };
    }

    const current = edit;
    setEdit(null);
    if (Object.keys(patch).length === 0 && !create && !stop && !update) return;
    const ok = await D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, ...patch })),
      async () => {
        let p = patch;
        let made: string | null = null;
        if (create) {
          made = (await D.T.createRule(create)).id;
          p = { ...p, rule_id: made, rule_date: today };
        } else if (stop) await D.T.stopRule(stop);
        else if (update) await D.T.updateRule(update.id, update.patch);
        if (Object.keys(p).length === 0) return true;
        try {
          await D.T.updateTask(t.id, current.base, p);
        } catch (e) {
          // 할 일을 못 고쳤으면 방금 만든 규칙을 남기지 않는다
          if (made) await D.T.stopRule(made).catch(() => {});
          throw e;
        }
        return true;
      },
    );
    if (!ok) {
      setSel(current.id);
      setEdit({ ...current, stale: true });
    }
  }

  // ------------------------------------------------------------ 시간 정하기 · 다시 정하기 · 시간 없음으로

  function startPlan() {
    if (!selTask) return;
    closeForms();
    const draft = planDraftFor(selTask, today);
    // 아직 안 지난 일정을 다시 정할 때는 지금 정해 둔 날짜·시각에서 시작한다
    const keep = selLink && selLink.date >= today && selLink.start_min !== null && selLink.end_min !== null;
    setPlan({
      id: selTask.id,
      draft: keep ? { ...draft, date: selLink.date, start: selLink.start_min, len: String(selLink.end_min! - selLink.start_min!) } : draft,
    });
  }

  async function savePlan() {
    if (!plan) return;
    const t = state?.tasks.find((x) => x.id === plan.id);
    const { date, start, len: lenText } = plan.draft;
    if (!t || start === null) return;
    const len = Number(lenText);
    if (!Number.isInteger(len) || len < 5) {
      toast("길이는 5분 이상입니다");
      return;
    }
    const input = {
      title: [...t.title].slice(0, TITLE_MAX).join("").trim(),
      date,
      start_min: start,
      end_min: start + len,
      place_id: t.place_id,
      where_text: null,
      travel_min: null,
      note: null,
      repeat: null,
      task_id: t.id,
    };
    const issue = validateEvent(input)[0];
    if (issue) {
      toast(issue.reason);
      return;
    }
    const current = plan;
    setPlan(null);
    const old = linkOf.get(t.id);
    const when = { date, start_min: start, end_min: start + len };
    const row = old
      ? // 다시 정하기: 이어진 일정을 옮긴다
        await D.run(
          (s) => ({ ...s, links: s.links.map((l) => (l.task_id === t.id ? { ...l, ...when } : l)) }),
          async () => {
            const ev = (await D.S.events(old.date, old.date)).events.find((e) => e.id === old.event_id);
            if (!ev) throw new Error("[EZ_NOT_FOUND] 이어진 일정이 없습니다. 새로 불러오세요");
            return D.S.updateEvent(ev.id, ev.version, when);
          },
        )
      : await D.run((s) => ({ ...s, links: [...s.links, { task_id: t.id, event_id: tempId(), ...when, repeating: false }] }), () => D.S.createEvent(input));
    if (!row) {
      setSel(current.id);
      setPlan(current);
    }
  }

  /** 시간 없음으로: 이어진 일정을 지우고 할 일 목록으로 */
  async function unplan() {
    if (!selTask || !selLink || isTemp(selLink.event_id)) return;
    const t = selTask;
    const link = selLink;
    const deps = await D.run<EventDeps>(
      (s) => ({ ...s, links: s.links.filter((l) => l.task_id !== t.id) }),
      async () => {
        const ev = (await D.S.events(link.date, link.date)).events.find((e) => e.id === link.event_id);
        if (!ev) throw new Error("[EZ_NOT_FOUND] 이어진 일정이 없습니다. 새로 불러오세요");
        const d = await D.S.dependents(ev.id);
        await D.S.deleteEvent(ev.id, ev.version);
        return d;
      },
    );
    if (deps) toast("시간을 비웠습니다", { label: "되돌리기", run: () => void D.run(null, () => D.S.restoreEvent(link.event_id, deps)) });
  }

  // ------------------------------------------------------------ 마감 바꾸기 · 마감 지우기

  function startDue() {
    if (!selTask) return;
    closeForms();
    setDueEdit({ id: selTask.id, due: today });
  }

  async function saveDue() {
    if (!dueEdit || dueEdit.due === "") return;
    const t = state?.tasks.find((x) => x.id === dueEdit.id);
    if (!t) return;
    const patch = { due: dueEdit.due, due_event_id: null };
    setDueEdit(null);
    await D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, ...patch })),
      (srv) => D.T.updateTask(t.id, D.versionOf(srv, t.id, t.version), patch),
    );
  }

  async function clearDue() {
    if (!selTask) return;
    const t = selTask;
    const none = { due: null, due_event_id: null };
    const row = await D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, ...none })),
      (srv) => D.T.updateTask(t.id, D.versionOf(srv, t.id, t.version), none),
    );
    if (!row) return;
    const back = { due: t.due, due_event_id: t.due_event_id };
    toast("마감을 지웠습니다", {
      label: "되돌리기",
      run: () =>
        void D.run(
          (s) => mapTask(s, t.id, (x) => ({ ...x, ...back })),
          (srv) => D.T.updateTask(t.id, D.versionOf(srv, t.id, row.version), back),
        ),
    });
  }

  // ------------------------------------------------------------ 일정으로 보내기 · 없애기

  function startSend() {
    if (!selTask) return;
    const t = selTask;
    closeForms();
    const start = Math.min(1410, Math.ceil((nowMin + 1) / 30) * 30);
    const d = newDraft(today, start, start + (t.est_min ?? DEFAULT_LEN));
    setSend({ id: t.id, draft: { ...d, title: [...t.title].slice(0, TITLE_MAX).join("").trim(), note: t.note ?? "", place_id: t.place_id } });
  }

  /** 일정을 만들고 할 일은 지운다. 되돌리기는 둘 다 */
  async function saveSend() {
    if (!send) return;
    const t = state?.tasks.find((x) => x.id === send.id);
    if (!t) {
      setSend(null);
      return;
    }
    const input = { ...draftInput(send.draft), task_id: null };
    const issue = validateEvent(input)[0];
    if (issue) {
      toast(issue.path === "title" && input.title === "" ? "제목을 써 주세요" : issue.reason);
      return;
    }
    const current = send;
    closeAll();
    const ev = await D.run(
      (s) => ({ ...s, tasks: s.tasks.filter((x) => x.id !== t.id) }),
      async (srv) => {
        const row = await D.S.createEvent(input);
        try {
          await D.T.deleteTask(t.id, D.versionOf(srv, t.id, t.version));
        } catch (e) {
          // 할 일을 못 지웠으면 방금 만든 일정을 남기지 않는다
          await D.S.deleteEvent(row.id, row.version).catch(() => {});
          throw e;
        }
        return row;
      },
    );
    if (!ev) {
      setSel(current.id);
      setSend(current);
      return;
    }
    toast("일정으로 보냈습니다", {
      label: "되돌리기",
      run: () =>
        void D.run(null, async () => {
          await D.S.deleteEvent(ev.id, ev.version);
          await D.T.restoreTask(t.id);
        }),
    });
  }

  async function remove() {
    if (!selTask) return;
    const t = selTask;
    closeAll();
    const ok = await D.run(
      (s) => ({ ...s, tasks: s.tasks.filter((x) => x.id !== t.id) }),
      async (srv) => {
        await D.T.deleteTask(t.id, D.versionOf(srv, t.id, t.version));
        return true;
      },
    );
    if (ok) toast("할 일을 없앴습니다", { label: "되돌리기", run: () => void D.run(null, () => D.T.restoreTask(t.id)) });
  }

  // ------------------------------------------------------------ 키보드

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        if (menu) setMenu(null);
        else if (send) setSend(null);
        else if (dueEdit) setDueEdit(null);
        else if (plan) setPlan(null);
        else if (edit) setEdit(null);
        else if (sel) setSel(null);
        else if (document.activeElement === inputRef.current) inputRef.current?.blur();
        else return;
        e.preventDefault();
        return;
      }
      if (isTyping(e.target) || edit || plan || dueEdit || send) return;
      if (e.key === "n" || e.key === "N") {
        if (phone) setSel(null);
        inputRef.current?.focus();
        e.preventDefault();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------ 그리기

  if (width === null || !state) return <div className="planner" />;

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    add();
  };

  const line = (t: TaskRow, opts: { link?: TaskLink; late?: (typeof lists.late)[number]; movable?: boolean } = {}) => (
    <TaskLine
      key={t.id}
      task={t}
      link={opts.link}
      late={opts.late}
      place={t.place_id ? placeOf.get(t.place_id) : undefined}
      repeats={t.rule_id !== null && liveRules.has(t.rule_id)}
      today={today}
      selected={sel === t.id}
      dragging={drag?.id === t.id}
      onToggle={(x) => void toggle(x)}
      onPick={pick}
      onGrab={opts.movable && !phone ? grab : undefined}
    />
  );

  const taskById = (id: string | undefined) => (id ? (state.tasks.find((t) => t.id === id) ?? null) : null);
  const editTask = taskById(edit?.id);
  const planTask = taskById(plan?.id);
  const dueTask = taskById(dueEdit?.id);
  const sendTask = taskById(send?.id);
  let panel: ReactNode = null;
  let panelLabel = "";
  if (send && sendTask) {
    panelLabel = "일정으로";
    panel = (
      <EventForm
        key={`send:${send.id}`}
        draft={send.draft}
        onChange={(d) => setSend((x) => (x ? { ...x, draft: d } : x))}
        places={D.places}
        scopes={[]}
        isNew
        onSave={() => void saveSend()}
        onCancel={() => setSend(null)}
      />
    );
  } else if (dueEdit && dueTask) {
    panelLabel = "마감 바꾸기";
    panel = (
      <DueForm
        key={dueEdit.id}
        task={dueTask}
        due={dueEdit.due}
        onChange={(due) => setDueEdit((x) => (x ? { ...x, due } : x))}
        onSave={() => void saveDue()}
        onCancel={() => setDueEdit(null)}
      />
    );
  } else if (plan && planTask) {
    panelLabel = "시간 정하기";
    panel = (
      <PlanForm
        key={plan.id}
        task={planTask}
        draft={plan.draft}
        now={now}
        onChange={(d) => setPlan((p) => (p ? { ...p, draft: d } : p))}
        onSave={() => void savePlan()}
        onCancel={() => setPlan(null)}
      />
    );
  } else if (edit && editTask) {
    panelLabel = "할 일 수정";
    panel = (
      <TaskForm
        key={`${edit.id}:${edit.base}`}
        draft={edit.draft}
        base={edit.baseDraft}
        today={today}
        places={D.places}
        loadDueOptions={() => D.S.events(today, addDays(today, 60)).then((rows) => dueOptions(rows, today))}
        onChange={(d) => setEdit((x) => (x ? { ...x, draft: d } : x))}
        onSave={(scope) => void saveEdit(scope)}
        onCancel={() => setEdit(null)}
      />
    );
  } else if (selTask) {
    const rule = ruleOf(state, selTask);
    const canSend = !selLink && selTask.done_at === null;
    panelLabel = selTask.title;
    panel = (
      <TaskDetail
        task={selTask}
        link={selLink}
        event={linkedEv}
        late={lateOf(selTask, selLink, now)}
        place={selTask.place_id ? (placeOf.get(selTask.place_id) ?? null) : null}
        dueTitle={selTask.due_event_id ? (state.titles[selTask.due_event_id] ?? null) : null}
        repeat={rule ? ruleLabel(rule, rule.event_id ? state.titles[rule.event_id] : null) : null}
        today={today}
        scheduleHref={selLink && !isTemp(selLink.event_id) ? href(`/schedule?date=${selLink.date}&event=${selLink.event_id}`) : null}
        onToggle={(x) => void toggle(x)}
        onCheck={(i, done) => check(selTask, i, done)}
        onPlan={startPlan}
        onUnplan={() => void unplan()}
        onDue={startDue}
        onClearDue={() => void clearDue()}
        onEdit={startEdit}
        onDelete={() => void remove()}
        onMore={
          canSend
            ? (e: ReactMouseEvent<HTMLButtonElement>) => {
                const r = e.currentTarget.getBoundingClientRect();
                // 아래에 자리가 없으면(폰 시트 맨 아래) 버튼 위로 연다 — 버튼을 가리지 않게
                setMenu({ x: r.left, y: r.bottom + 56 > innerHeight ? r.top - 52 : r.bottom + 4 });
              }
            : null
        }
      />
    );
  }
  const viewing = panel !== null && !edit && !plan && !dueEdit && !send;

  const close = (
    <button type="button" className="iconbtn pl-x" aria-label="닫기" title="닫기" onClick={closeAll}>
      <Icon name="x" />
    </button>
  );

  return (
    <div className="planner">
      <div className="bar-top pl-top">
        <HomeButton />
        <label className="pl-add">
          <Icon name="plus" />
          <input
            ref={inputRef}
            value={text}
            maxLength={TASK_TITLE_MAX}
            aria-label="할 일 추가"
            enterKeyHint="done"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onInputKey}
          />
        </label>
        <ThemeToggle />
      </div>
      <div className="pl-stage">
        <div
          className="pl-list"
          onClick={(e) => {
            // 빈 곳을 누르면 보기를 닫는다 (고치는 중에는 그대로)
            if (viewing && !(e.target as HTMLElement).closest("li, button, a")) closeAll();
          }}
        >
          {/* 데스크톱은 두 열(왼쪽: 지금 할 것 · 오른쪽: 정해 둔 것과 끝낸 것), 좁으면 한 열로 쌓인다 */}
          <div className={lists.timed.length + lists.done.length > 0 ? "pl-cols two" : "pl-cols"}>
            <div className="pl-col">
              {lists.late.length > 0 && (
                <section className="pl-sec late" aria-label="지남">
                  <h2 className="pl-h">
                    지남<span className="num">{lists.late.length}</span>
                  </h2>
                  <ul className="pl-rows">{lists.late.map((l) => line(l.task, { link: l.link ?? undefined, late: l }))}</ul>
                </section>
              )}
              {openShown.length > 0 && (
                <section className="pl-sec open" aria-label="할 일">
                  <h2 className="pl-h">
                    할 일<span className="num">{openShown.length}</span>
                  </h2>
                  <ul className="pl-rows" ref={openRef}>
                    {openShown.map((t) => line(t, { movable: true }))}
                  </ul>
                </section>
              )}
            </div>
            {lists.timed.length + lists.done.length > 0 && (
              <div className="pl-col">
                {lists.timed.length > 0 && (
                  <section className="pl-sec" aria-label="시간 정함">
                    <h2 className="pl-h">
                      시간 정함<span className="num">{lists.timed.length}</span>
                    </h2>
                    <ul className="pl-rows">{lists.timed.map(({ task, link }) => line(task, { link }))}</ul>
                  </section>
                )}
                {lists.done.length > 0 && (
                  <section className="pl-sec" aria-label="끝냄">
                    <button type="button" className="pl-h pl-fold" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                      끝냄
                      <span className="num">{lists.done.length}</span>
                      <Icon name={showDone ? "up" : "down"} />
                    </button>
                    {showDone && <ul className="pl-rows">{lists.done.map((t) => line(t))}</ul>}
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
        {!phone && panel && (
          <aside className={wide ? "dp pl-dp" : "dp pl-dp float"} aria-label={panelLabel}>
            {viewing && close}
            {panel}
          </aside>
        )}
      </div>
      {phone && panel && (
        <>
          <div
            className={viewing ? "scrim light" : "scrim"}
            onClick={() => {
              if (viewing) closeAll();
              else closeForms();
            }}
          />
          <div className={viewing ? "sheet peek" : "sheet"} role="dialog" aria-label={panelLabel}>
            <span className="grab" />
            {panel}
          </div>
        </>
      )}
      {menu && viewing && (
        <Menu x={menu.x} y={menu.y} entries={[{ kind: "item", icon: "cal", label: "일정으로", run: startSend }]} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
