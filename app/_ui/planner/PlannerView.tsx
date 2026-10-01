"use client";

// 플래너 화면 (docs/플래너.md 3장). 맨 위 한 줄 입력 → 목록 셋(할 일 · 시간 정함 · 끝냄).
// 줄 누르기는 보기만(넓은 데스크톱 오른쪽 패널 · 좁은 데스크톱 떠 있는 패널 · 폰 보기 시트), 고치기는 '수정' 을 한 번 더.
// 끝냄 체크만 바로 된다. 할 일 목록은 데스크톱 마우스로 끌어 순서를 바꾼다(sort 는 앞뒤 가운데 값).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { DEFAULT_SETTINGS, TASK_TITLE_MAX, TITLE_MAX, validateEvent, validateTask, type EventRow, type TaskRow } from "../../../lib/schedule";
import type { TaskInput, TaskLink } from "../../_data/types";
import { moved, moveSort, parseMinutes, splitTasks } from "../../_logic/planner";
import { nowIn } from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { HomeButton } from "../Shell";
import { ThemeToggle } from "../ThemeToggle";
import { useToast } from "../Toast";
import { PlanForm, planDraftFor, type PlanDraft } from "./PlanForm";
import { TaskDetail } from "./TaskDetail";
import { TaskForm, type TaskDraft } from "./TaskForm";
import { TaskLine } from "./TaskLine";
import { usePlannerData, type PlannerState } from "./usePlannerData";

const PHONE_MAX = 760;
const PANEL_MIN = 1180;
const CLOCK_MS = 60_000;

type Edit = { id: string; base: number; draft: TaskDraft; stale: boolean };
type Plan = { id: string; draft: PlanDraft };
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

function draftOf(t: TaskRow): TaskDraft {
  return { title: t.title, due: t.due ?? "", est: t.est_min === null ? "" : String(t.est_min), note: t.note ?? "" };
}

const mapTask = (s: PlannerState, id: string, f: (t: TaskRow) => TaskRow): PlannerState => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? f(t) : t)) });

export function PlannerView() {
  const { href } = useApp();
  const toast = useToast();
  const width = useViewportWidth();
  const phone = (width ?? 1440) <= PHONE_MAX;
  const wide = (width ?? 1440) >= PANEL_MIN;

  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  const now = nowIn(DEFAULT_SETTINGS.tz, new Date(clock));
  const today = now.date;

  const D = usePlannerData();
  const state = D.state;
  const [text, setText] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [linkedEv, setLinkedEv] = useState<EventRow | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLUListElement>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const justDragged = useRef(false);

  const lists = useMemo(() => splitTasks(state?.tasks ?? [], state?.links ?? [], new Date(clock)), [state, clock]);
  const openShown = drag ? moved(lists.open, drag.id, drag.to) : lists.open;
  const linkOf = useMemo(() => new Map((state?.links ?? []).map((l) => [l.task_id, l])), [state]);
  const selTask = sel ? (state?.tasks.find((t) => t.id === sel) ?? null) : null;
  const selLink: TaskLink | null = selTask ? (linkOf.get(selTask.id) ?? null) : null;

  // 고른 할 일이 사라지면(지움 · 다른 곳에서 지움) 닫는다
  useEffect(() => {
    if (sel && state && !state.tasks.some((t) => t.id === sel)) {
      setSel(null);
      setEdit(null);
      setPlan(null);
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
    if (t && t.version !== edit.base) setEdit({ id: t.id, base: t.version, draft: draftOf(t), stale: false });
  }, [edit, state]);

  const closeAll = useCallback(() => {
    setSel(null);
    setEdit(null);
    setPlan(null);
  }, []);

  // ------------------------------------------------------------ 넣기 · 끝냄 · 순서

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

  // ------------------------------------------------------------ 보기 · 수정 · 시간 정하기 · 없애기

  function pick(t: TaskRow) {
    if (justDragged.current || isTemp(t.id)) return;
    setEdit(null);
    setPlan(null);
    setSel((s) => (s === t.id && !phone ? null : t.id));
  }

  function startEdit() {
    if (!selTask) return;
    setPlan(null);
    setEdit({ id: selTask.id, base: selTask.version, draft: draftOf(selTask), stale: false });
  }

  async function saveEdit() {
    if (!edit) return;
    const t = state?.tasks.find((x) => x.id === edit.id);
    if (!t) {
      setEdit(null);
      return;
    }
    const d = edit.draft;
    const patch: Partial<TaskInput> = {
      title: d.title.trim(),
      due: d.due === "" ? null : d.due,
      est_min: parseMinutes(d.est),
      note: d.note.trim() === "" ? null : d.note,
    };
    const issue = validateTask({ ...patch })[0];
    if (issue) {
      toast(issue.path === "title" && patch.title === "" ? "제목을 써 주세요" : issue.reason);
      return;
    }
    const same = patch.title === t.title && patch.due === t.due && patch.est_min === t.est_min && patch.note === t.note;
    const current = edit;
    setEdit(null);
    if (same) return;
    const row = await D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, ...patch })),
      () => D.T.updateTask(t.id, current.base, patch),
    );
    if (!row) {
      setSel(current.id);
      setEdit({ ...current, stale: true });
    }
  }

  function startPlan() {
    if (!selTask) return;
    setEdit(null);
    setPlan({ id: selTask.id, draft: planDraftFor(selTask, today) });
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
      place_id: null,
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
    const link: TaskLink = { task_id: t.id, event_id: tempId(), date, start_min: start, repeating: false };
    const row = await D.run((s) => ({ ...s, links: [...s.links, link] }), () => D.S.createEvent(input));
    if (!row) {
      setSel(current.id);
      setPlan(current);
    }
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
        if (plan) setPlan(null);
        else if (edit) setEdit(null);
        else if (sel) setSel(null);
        else if (document.activeElement === inputRef.current) inputRef.current?.blur();
        else return;
        e.preventDefault();
        return;
      }
      if (isTyping(e.target) || edit || plan) return;
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

  const line = (t: TaskRow, link?: TaskLink, movable = false) => (
    <TaskLine
      key={t.id}
      task={t}
      link={link}
      today={today}
      selected={sel === t.id}
      dragging={drag?.id === t.id}
      onToggle={(x) => void toggle(x)}
      onPick={pick}
      onGrab={movable && !phone ? grab : undefined}
    />
  );

  const editTask = edit ? (state.tasks.find((t) => t.id === edit.id) ?? null) : null;
  const planTask = plan ? (state.tasks.find((t) => t.id === plan.id) ?? null) : null;
  let panel: ReactNode = null;
  let panelLabel = "";
  if (plan && planTask) {
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
        onChange={(d) => setEdit((x) => (x ? { ...x, draft: d } : x))}
        onSave={() => void saveEdit()}
        onCancel={() => setEdit(null)}
      />
    );
  } else if (selTask) {
    panelLabel = selTask.title;
    panel = (
      <TaskDetail
        task={selTask}
        link={selLink}
        event={linkedEv}
        today={today}
        scheduleHref={selLink && !isTemp(selLink.event_id) ? href(`/schedule?date=${selLink.date}&event=${selLink.event_id}`) : null}
        onToggle={(x) => void toggle(x)}
        onPlan={startPlan}
        onEdit={startEdit}
        onDelete={() => void remove()}
      />
    );
  }
  const viewing = panel !== null && !edit && !plan;

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
          {openShown.length > 0 && (
            <ul className="pl-rows" ref={openRef} aria-label="할 일">
              {openShown.map((t) => line(t, undefined, true))}
            </ul>
          )}
          {lists.timed.length > 0 && (
            <section className="pl-sec" aria-label="시간 정함">
              <h2 className="pl-h">시간 정함</h2>
              <ul className="pl-rows">{lists.timed.map(({ task, link }) => line(task, link))}</ul>
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
        {!phone && panel && (
          <aside className={wide ? "dp pl-dp" : "dp pl-dp float"} aria-label={panelLabel}>
            {viewing && close}
            {panel}
          </aside>
        )}
      </div>
      {phone && panel && (
        <>
          <div className={viewing ? "scrim light" : "scrim"} onClick={() => {
              if (viewing) closeAll();
              else {
                setEdit(null);
                setPlan(null);
              }
            }}
          />
          <div className={viewing ? "sheet peek" : "sheet"} role="dialog" aria-label={panelLabel}>
            <span className="grab" />
            {panel}
          </div>
        </>
      )}
    </div>
  );
}
