"use client";

// 플래너 화면 (docs/플래너.md 3장 · 7장). 위쪽 줄(홈 · 밝기) → 정렬 줄(7-12) + 역할 필터(7-14) → 카드 다섯(지남 · 할 일 · 시간 정함 · 끝냄 · 반복, 자리 고정).
// 할 일 추가 칸은 할 일 카드의 첫 줄(7-15). 작업대는 따로 페이지(/planner/bench) — 여기서는 할 일 보기의 "작업대" 단추로 올리기만 한다(7-16).
// 반복 규칙은 반복 카드에 따로 산다: 줄을 누르면 규칙 보기(수정 · 멈춤 · 지우기 · 작업대에 올리기). 할 일 보기에는 "반복으로 만들기" 하나.
// 줄 누르기는 보기만(넓은 데스크톱 오른쪽 패널 · 좁은 데스크톱 떠 있는 패널 · 폰 보기 시트), 고치기는 '수정' 을 한 번 더.
// 끝냄 체크와 체크 항목만 바로 된다. 할 일 목록은 '직접' 정렬일 때 데스크톱 마우스로 끌어 순서를 바꾼다(sort 는 앞뒤 가운데 값).
// 전환(docs/모션.md): 줄이 생기고 · 빠지고 · 자리를 바꾸면 FLIP 으로 미끄러진다(useFlip). 데이터는 먼저 바뀐다.
// 지남은 자동으로 넘기지 않는다 — 다시 정하기 · 시간 없음으로 · 마감 바꾸기 · 마감 지우기를 사람이 고른다.

import {
  Fragment,
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
  expand,
  mergeSteps,
  parseStepLines,
  ROLE_NAME_MAX,
  roleForPlace,
  sameSteps,
  TASK_TITLE_MAX,
  TITLE_MAX,
  validateEvent,
  validateTask,
  type EventRow,
  type Occurrence,
  type Role,
  type TaskRow,
  type TaskRule,
} from "../../../lib/schedule";
import type { EventDeps, RuleInput, TaskInput, TaskLink } from "../../_data/types";
import {
  DEFAULT_LEN,
  dueOptions,
  filterByRole,
  lateOf,
  moved,
  moveSort,
  parseMinutes,
  roleText,
  ruleDraft,
  ruleDraftFromTask,
  ruleDraftPatch,
  ruleLabel,
  ruleNext,
  SORT_KEYS,
  SORT_LABEL,
  sortGroups,
  sortRules,
  splitTasks,
  taskDraft,
  toggleRoleOff,
  type Late,
  type RuleDraft,
  type Sort,
  type SortGroup,
  type TaskDraft,
} from "../../_logic/planner";
import { ruleMenu, taskMenu } from "../../_logic/menus";
import { draftInput, newDraft, nowIn, type Draft } from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { Menu } from "../Menu";
import { Presence } from "../motion/Presence";
import { useFlip } from "../motion/useFlip";
import { EventForm } from "../schedule/EventForm";
import { HomeButton } from "../Shell";
import { useToast } from "../Toast";
import { toEntries, useContextMenu } from "../useContextMenu";
import { DueForm } from "./DueForm";
import { PlanForm, planDraftFor, type PlanDraft } from "./PlanForm";
import { PlannerBar, PlannerCards, type CardKey } from "./PlannerCards";
import { RoleEdit } from "./RoleEdit";
import { RoleFilter } from "./RoleFilter";
import { RuleDetail, RuleForm, RuleLine } from "./RulePanel";
import { TaskDetail } from "./TaskDetail";
import { TaskForm } from "./TaskForm";
import { TaskLine } from "./TaskLine";
import { usePlannerData, type PlannerState } from "./usePlannerData";
import { isTemp, mapTask, tempId, useTaskOps } from "./useTaskOps";
import { ROLE_OFF_KEY, readRoleOff } from "./roleOff";
import { readSort, SORT_KEY } from "./sortPref";

const PHONE_MAX = 760;
const PANEL_MIN = 1180;
const CLOCK_MS = 60_000;

/** 목록의 한 줄: 할 일 + 이어진 일정 + (지남 묶음이면) 무엇이 지났나 */
type Row = { task: TaskRow; link?: TaskLink | null; late?: Late };

type Edit = { id: string; base: number; draft: TaskDraft; stale: boolean };
/** 규칙 칸: id 가 있으면 그 규칙 고치기, task 가 있으면 그 할 일을 첫 회차로 새 규칙("반복으로 만들기") */
type RuleEdit = { id: string | null; task: string | null; draft: RuleDraft };
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
  const [showRules, setShowRules] = useState(false);
  const [ruleSel, setRuleSel] = useState<string | null>(null);
  const [ruleEdit, setRuleEdit] = useState<RuleEdit | null>(null);
  /** 일정에 딸린 규칙의 다음 회차를 알려고 펼친 회차 (오늘부터 60일) */
  const [occ, setOcc] = useState<Occurrence[]>([]);
  const [sort, setSort] = useState<Sort>(readSort);
  const [roleEdit, setRoleEdit] = useState(false);
  const [roleOff, setRoleOff] = useState<string[]>(readRoleOff);
  const [linkedEv, setLinkedEv] = useState<EventRow | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLUListElement>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const justDragged = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, ".pl-row[data-id], .pl-g[data-flip]", {
    // 끝내서 빠지는 줄은 체크가 그려진 채 잠깐 머물렀다 사라진다
    onGhost: (g, id) => {
      if (!state?.tasks.find((t) => t.id === id)?.done_at) return false;
      g.classList.add("checked");
      return true;
    },
  });

  const roles = useMemo<Role[]>(() => state?.roles ?? [], [state]);
  // 카드 넷 — 역할 필터를 거친다
  const lists = useMemo(() => {
    const all = splitTasks(state?.tasks ?? [], state?.links ?? [], new Date(clock), { date: today, min: nowMin });
    const keep = <T,>(xs: T[], task: (x: T) => TaskRow) => filterByRole(xs.map((x) => ({ x, task: task(x) })), roleOff, roles).map((r) => r.x);
    return {
      late: keep(all.late, (l) => l.task),
      open: keep(all.open, (t) => t),
      timed: keep(all.timed, (l) => l.task),
      done: keep(all.done, (t) => t),
    };
  }, [state, clock, today, nowMin, roleOff, roles]);
  // 끌어서 순서 바꾸기는 '직접' 정렬에서만
  const manual = sort.key === "manual";
  const openShown = drag ? moved(lists.open, drag.id, drag.to) : lists.open;
  const linkOf = useMemo(() => new Map((state?.links ?? []).map((l) => [l.task_id, l])), [state]);
  const placeOf = useMemo(() => new Map(D.places.map((p) => [p.id, p])), [D.places]);
  /** 그 할 일의 지점이 주는 역할 — 역할이 이것과 다르면 손으로 고른 것 */
  const autoRole = (t: TaskRow) => roleForPlace(t.place_id ? placeOf.get(t.place_id) : null, roles)?.id ?? null;
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

  // 고른 규칙이 사라지면(지움) 닫는다
  useEffect(() => {
    if (ruleSel && state && !state.rules.some((r) => r.id === ruleSel)) setRuleSel(null);
  }, [ruleSel, state]);

  // 일정에 딸린 규칙이 있으면 그 일정들의 다음 회차를 읽어 둔다 (반복 카드의 "다음 회차")
  const eventRuleIds = useMemo(() => [...new Set((state?.rules ?? []).flatMap((r) => (r.kind === "event" && r.event_id ? [r.event_id] : [])))].sort().join(","), [state]);

  // 주소에 ?task=id 가 있으면(집중 화면의 제목) 그 할 일의 보기를 연다 — 처음 한 번
  const openedFromUrl = useRef(false);
  useEffect(() => {
    if (!state || openedFromUrl.current) return;
    openedFromUrl.current = true;
    const id = new URLSearchParams(location.search).get("task");
    if (id && state.tasks.some((t) => t.id === id)) setSel(id);
  }, [state]);

  // 이어진 일정의 끝 시각 · 반복
  const evId = selLink?.event_id ?? null;
  const evDate = selLink?.date ?? null;
  const S = D.S;
  useEffect(() => {
    if (eventRuleIds === "") {
      setOcc([]);
      return;
    }
    let alive = true;
    S.events(today, addDays(today, 60)).then(
      (rows) => alive && setOcc(expand(rows.events, rows.exceptions, today, addDays(today, 60))),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [eventRuleIds, today, S]);
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
      const d = taskDraft(t, state.titles, roleForPlace(D.places.find((p) => p.id === t.place_id), state.roles)?.id ?? null);
      setEdit({ id: t.id, base: t.version, draft: d, stale: false });
    }
  }, [edit, state, D.places]);

  const closeForms = useCallback(() => {
    setEdit(null);
    setPlan(null);
    setDueEdit(null);
    setSend(null);
    setMenu(null);
    setRoleEdit(false);
    setRuleEdit(null);
  }, []);

  const closeAll = useCallback(() => {
    setSel(null);
    setRuleSel(null);
    closeForms();
  }, [closeForms]);

  // ------------------------------------------------------------ 넣기 · 끝냄 · 체크 항목 · 순서

  const ops = useTaskOps(D);
  const { addTask, toggle, check } = ops;
  const cm = useContextMenu();

  function add() {
    if (addTask(text)) setText("");
  }

  /** "작업대" — 올리기만 한다(이동 · 알림 없음, 줄 앞 키위 막대로 안다). 올라가 있으면 내리기 (7-16) */
  function toBench(t: TaskRow, on: boolean) {
    if (isTemp(t.id) || t.done_at !== null) return;
    void ops.bench(t, on);
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
      const ul = openRef.current;
      const rows = [...(ul?.querySelectorAll<HTMLElement>("li[data-id]") ?? [])].filter((el) => el.dataset.id !== t.id);
      // 놓인 자리(offsetTop)로 잰다 — 미끄러지는 중인 줄의 transform 에 흔들리지 않게
      const top = ul?.getBoundingClientRect().top ?? 0;
      let to = 0;
      for (const el of rows) {
        if (ev.clientY > top + el.offsetTop + el.offsetHeight / 2) to++;
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
    setRuleSel(null);
    setSel((s) => (s === t.id && !phone ? null : t.id));
  }

  function startEdit(t: TaskRow | null = selTask) {
    if (!t || !state) return;
    closeForms();
    const d = taskDraft(t, state.titles, autoRole(t));
    setEdit({ id: t.id, base: t.version, draft: d, stale: false });
  }

  async function saveEdit() {
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
    const checks = parseStepLines(d.checks);
    if (checks.issue) {
      toast(checks.issue);
      return;
    }

    const patch: Partial<TaskInput> = {};
    if (title !== t.title) patch.title = title;
    if (est !== t.est_min) patch.est_min = est;
    if (note !== t.note) patch.note = note;
    if (d.place_id !== t.place_id) patch.place_id = d.place_id;
    if (d.role_id !== t.role_id) patch.role_id = d.role_id;
    const checklist = mergeSteps(t.checklist, checks.lines);
    if (!sameSteps(checklist, t.checklist)) patch.checklist = checklist;
    // 마감을 바꾸거나 지울 때는 일정 연결도 같이 보낸다 (건 채로 날짜만 바꾸면 DB 가 거절한다)
    if (due !== t.due || dueEvent !== t.due_event_id) {
      patch.due = due;
      patch.due_event_id = dueEvent;
    }

    const current = edit;
    setEdit(null);
    if (Object.keys(patch).length === 0) return;
    const ok = await D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, ...patch })),
      async () => {
        await D.T.updateTask(t.id, current.base, patch);
        return true;
      },
    );
    if (!ok) {
      setSel(current.id);
      setEdit({ ...current, stale: true });
    }
  }

  // ------------------------------------------------------------ 반복 규칙 (반복 카드, 7-16)

  const mapRule = (id: string, p: Partial<TaskRule>) => (s: PlannerState): PlannerState => ({ ...s, rules: s.rules.map((r) => (r.id === id ? { ...r, ...p } : r)) });

  function pickRule(r: TaskRule) {
    closeForms();
    setSel(null);
    setRuleSel((s) => (s === r.id && !phone ? null : r.id));
  }

  function startRuleEdit(r: TaskRule) {
    closeForms();
    setSel(null);
    setRuleSel(r.id);
    const auto = roleForPlace(r.place_id ? placeOf.get(r.place_id) : null, roles)?.id ?? null;
    setRuleEdit({ id: r.id, task: null, draft: ruleDraft(r, auto) });
  }

  /** "반복으로 만들기": 규칙 칸을 그 할 일의 모양으로 연다. 저장하면 규칙이 생기고 이 할 일이 첫 회차 */
  function startRepeat(t: TaskRow | null = selTask) {
    if (!t || isTemp(t.id) || t.done_at !== null) return;
    closeForms();
    setRuleSel(null);
    setSel(t.id);
    setRuleEdit({ id: null, task: t.id, draft: ruleDraftFromTask(t, today, autoRole(t)) });
  }

  async function saveRule() {
    if (!ruleEdit || !state) return;
    const cur = ruleEdit;
    const rule = cur.id ? (state.rules.find((r) => r.id === cur.id) ?? null) : null;
    const task = cur.task ? (state.tasks.find((t) => t.id === cur.task) ?? null) : null;
    if (!rule && !task) {
      setRuleEdit(null);
      return;
    }
    const r = ruleDraftPatch(cur.draft, rule?.checklist ?? []);
    if ("issue" in r) {
      toast(r.issue);
      return;
    }
    setRuleEdit(null);
    if (rule) {
      const p: Partial<RuleInput> = { ...r.patch, ...(rule.kind === "cycle" && r.repeat ? { repeat: r.repeat } : {}) };
      const ok = await D.run(mapRule(rule.id, p), () => D.T.updateRule(rule.id, p));
      if (!ok) setRuleEdit(cur);
      return;
    }
    if (!task || !r.repeat) return;
    // 새 규칙: 오늘부터, 이 할 일이 첫 회차. 마감이 없고 "마감까지 며칠" 을 적었으면 이 회차의 마감도 채운다
    const input: RuleInput = { kind: "cycle", ...r.patch, repeat: r.repeat, start: today, event_id: null, last_made: today };
    const p: Partial<TaskInput> = { rule_date: today };
    if (task.due === null && r.patch.due_after !== null) {
      p.due = addDays(today, r.patch.due_after);
      p.due_event_id = null;
    }
    const made = await D.run(null, async (srv) => {
      const row = await D.T.createRule(input);
      try {
        await D.T.updateTask(task.id, D.versionOf(srv, task.id, task.version), { ...p, rule_id: row.id });
      } catch (e) {
        // 할 일에 못 걸었으면 방금 만든 규칙을 남기지 않는다
        await D.T.stopRule(row.id).catch(() => {});
        throw e;
      }
      return row;
    });
    if (!made) {
      setSel(task.id);
      setRuleEdit(cur);
      return;
    }
    setShowRules(true);
  }

  /** 멈춤 · 다시 시작 · 작업대에 올리기 — 바로 */
  function patchRule(r: TaskRule, p: Partial<Pick<TaskRule, "paused" | "bench">>) {
    void D.run(mapRule(r.id, p), () => D.T.updateRule(r.id, p));
  }

  /** 규칙 지우기. 이미 생긴 할 일은 남는다. 되돌리기는 규칙을 되살린다 */
  async function removeRule(r: TaskRule) {
    closeForms();
    setRuleSel(null);
    const ok = await D.run(
      (s) => ({ ...s, rules: s.rules.filter((x) => x.id !== r.id) }),
      async () => {
        await D.T.stopRule(r.id);
        return true;
      },
    );
    if (ok) toast("반복을 지웠습니다", { label: "되돌리기", run: () => void D.run(null, () => D.T.restoreRule(r.id)) });
  }

  // ------------------------------------------------------------ 시간 정하기 · 다시 정하기 · 시간 없음으로

  function startPlan(t: TaskRow | null = selTask) {
    if (!t) return;
    const link = linkOf.get(t.id) ?? null;
    closeForms();
    const draft = planDraftFor(t, today);
    // 아직 안 지난 일정을 다시 정할 때는 지금 정해 둔 날짜·시각에서 시작한다
    const keep = link && link.date >= today && link.start_min !== null && link.end_min !== null;
    setPlan({
      id: t.id,
      draft: keep ? { ...draft, date: link.date, start: link.start_min, len: String(link.end_min! - link.start_min!) } : draft,
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
  async function unplan(t: TaskRow | null = selTask) {
    const link = t ? (linkOf.get(t.id) ?? null) : null;
    if (!t || !link || isTemp(link.event_id)) return;
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

  // ------------------------------------------------------------ 일정으로 보내기 · 지우기

  function startSend(t: TaskRow | null = selTask) {
    if (!t) return;
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

  async function remove(t: TaskRow | null = selTask) {
    if (!t) return;
    closeAll();
    const ok = await D.run(
      (s) => ({ ...s, tasks: s.tasks.filter((x) => x.id !== t.id) }),
      async (srv) => {
        await D.T.deleteTask(t.id, D.versionOf(srv, t.id, t.version));
        return true;
      },
    );
    if (ok) toast("할 일을 지웠습니다", { label: "되돌리기", run: () => void D.run(null, () => D.T.restoreTask(t.id)) });
  }

  // ------------------------------------------------------------ 정렬 · 역할 편집

  function pickRole(key: string, on: boolean) {
    const next = toggleRoleOff(roleOff, key, on);
    setRoleOff(next);
    try {
      localStorage.setItem(ROLE_OFF_KEY, JSON.stringify(next));
    } catch {
      // 기억만 못 한다
    }
  }

  function pickSort(next: Sort) {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
    } catch {
      // 기억만 못 한다
    }
  }

  function openRoles() {
    if (roleEdit) {
      setRoleEdit(false);
      return;
    }
    closeAll();
    setRoleEdit(true);
  }

  const mapRole = (id: string, patch: Partial<Role>) => (s: PlannerState): PlannerState => ({ ...s, roles: s.roles.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  /** 잘못된 이름이면 알리고 false */
  function renameRole(r: Role, value: string): boolean {
    const name = value.trim();
    if (name === r.name) return true;
    if (name === "" || [...name].length > ROLE_NAME_MAX) {
      toast(`역할 이름은 1~${ROLE_NAME_MAX}자입니다`);
      return false;
    }
    void D.run(mapRole(r.id, { name }), () => D.T.updateRole(r.id, { name }));
    return true;
  }

  async function addRole(value: string): Promise<boolean> {
    const name = value.trim();
    if (name === "") return false;
    if ([...name].length > ROLE_NAME_MAX) {
      toast(`역할 이름은 1~${ROLE_NAME_MAX}자입니다`);
      return false;
    }
    const sort = Math.max(0, ...roles.map((r) => r.sort)) + 1;
    return (await D.run(null, () => D.T.createRole({ name, sort }))) !== undefined;
  }

  function moveRole(i: number, j: number) {
    const a = roles[i];
    const b = roles[j];
    if (!a || !b) return;
    // 같은 sort 가 섞여 있으면 순서대로 다시 매긴다
    const distinct = new Set(roles.map((r) => r.sort)).size === roles.length;
    const sorts = roles.map((r, k) => (distinct ? r.sort : k + 1));
    const sa = sorts[j]!;
    const sb = sorts[i]!;
    void D.run(
      (s) => ({ ...s, roles: s.roles.map((r) => (r.id === a.id ? { ...r, sort: sa } : r.id === b.id ? { ...r, sort: sb } : r)).sort((x, y) => x.sort - y.sort) }),
      async () => {
        if (!distinct) for (const [k, r] of roles.entries()) if (r.id !== a.id && r.id !== b.id) await D.T.updateRole(r.id, { sort: sorts[k]! });
        await D.T.updateRole(a.id, { sort: sa });
        await D.T.updateRole(b.id, { sort: sb });
        return true;
      },
    );
  }

  /** 지우면 그 역할의 할 일 · 규칙은 역할 없음이 된다. 되돌리면 다시 걸린다 */
  async function removeRole(r: Role) {
    const none = <T extends { role_id: string | null }>(x: T): T => (x.role_id === r.id ? { ...x, role_id: null } : x);
    const deps = await D.run(
      (s) => ({ ...s, roles: s.roles.filter((x) => x.id !== r.id), tasks: s.tasks.map(none), rules: s.rules.map(none) }),
      () => D.T.deleteRole(r.id),
    );
    if (deps) toast("역할을 지웠습니다", { label: "되돌리기", run: () => void D.run(null, () => D.T.restoreRole(r.id, deps)) });
  }

  // ------------------------------------------------------------ 키보드

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        if (menu) setMenu(null);
        else if (roleEdit) setRoleEdit(false);
        else if (send) setSend(null);
        else if (dueEdit) setDueEdit(null);
        else if (plan) setPlan(null);
        else if (edit) setEdit(null);
        else if (ruleEdit) setRuleEdit(null);
        else if (ruleSel) setRuleSel(null);
        else if (sel) setSel(null);
        else if (document.activeElement === inputRef.current) inputRef.current?.blur();
        else return;
        e.preventDefault();
        return;
      }
      if (isTyping(e.target) || edit || plan || dueEdit || send || ruleEdit) return;
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

  /** 줄의 우클릭 · 길게 누르기 메뉴 (docs/공통.md 2장) — 보기 패널의 단추와 같은 동작 */
  const rowMenu = (t: TaskRow) => {
    const link = linkOf.get(t.id) ?? null;
    const show = () => {
      closeForms();
      setRuleSel(null);
      setSel(t.id);
    };
    return toEntries(
      taskMenu({
        temp: isTemp(t.id),
        done: t.done_at !== null,
        benched: t.bench_order !== null,
        link,
        late: lateOf(t, link, now),
        repeats: t.rule_id !== null && liveRules.has(t.rule_id),
      }),
      (act) => {
        if (act === "view") show();
        else if (act === "done" || act === "undone") void toggle(t);
        else if (act === "bench" || act === "unbench") toBench(t, act === "bench");
        else if (act === "unplan") void unplan(t);
        else if (act === "delete") void remove(t);
        else if (act === "repeat") startRepeat(t);
        else {
          setRuleSel(null);
          setSel(t.id);
          if (act === "edit") startEdit(t);
          else if (act === "plan" || act === "replan") startPlan(t);
          else startSend(t);
        }
      },
    );
  };

  /** 반복 카드의 줄들: 규칙마다 주기 글자와 다음 회차 */
  const ruleRows = sortRules(
    state.rules.map((rule) => ({
      rule,
      label: ruleLabel(rule, rule.event_id ? state.titles[rule.event_id] : null),
      next: ruleNext(rule, today, occ),
    })),
  );
  const ruleList = () => (
    <ul className="pl-rows">
      {ruleRows.map(({ rule, label, next }) => (
        <RuleLine
          key={rule.id}
          rule={rule}
          label={label}
          next={next}
          selected={ruleSel === rule.id}
          onPick={pickRule}
          menu={cm.bind(`rule:${rule.id}`, () =>
            toEntries(ruleMenu({ paused: rule.paused }), (act) => {
              if (act === "view") {
                closeForms();
                setSel(null);
                setRuleSel(rule.id);
              } else if (act === "edit") startRuleEdit(rule);
              else if (act === "delete") void removeRule(rule);
              else patchRule(rule, { paused: act === "pause" });
            }),
          )}
        />
      ))}
    </ul>
  );

  const line = ({ task: t, link, late }: Row, movable = false) => (
    <TaskLine
      key={t.id}
      task={t}
      link={link ?? undefined}
      late={late}
      place={t.place_id ? placeOf.get(t.place_id) : undefined}
      role={sort.key === "role" ? null : roleText(t, roles)}
      repeats={t.rule_id !== null && liveRules.has(t.rule_id)}
      benched={t.bench_order !== null && t.done_at === null}
      today={today}
      selected={sel === t.id}
      dragging={drag?.id === t.id}
      onToggle={(x) => void toggle(x)}
      onPick={pick}
      onGrab={movable && manual && !phone ? grab : undefined}
      menu={cm.bind(`task:${t.id}`, () => rowMenu(t))}
    />
  );

  /** 한 카드의 줄들: 정렬에 따라 구분 묶음으로. 역할 · 장소 정렬이면 묶음마다 라벨 줄(소제목 + 가는 선) */
  const groupsOf = (list: readonly Row[]): SortGroup<Row>[] => sortGroups(list, sort, { roles, places: D.places });
  const rows = (sec: string, list: readonly Row[], movable = false) => (
    <div className="pl-groups">
      {groupsOf(list).map((g) => (
        <Fragment key={g.key}>
          {g.kind !== "all" && (
            <h3 className="pl-g" data-flip={`g:${sec}:${g.key}`}>
              <span className="t">{g.label}</span>
            </h3>
          )}
          <ul className="pl-rows" ref={movable && manual ? openRef : undefined}>
            {g.items.map((r) => line(r, movable))}
          </ul>
        </Fragment>
      ))}
    </div>
  );

  const body = (k: CardKey) =>
    k === "late"
      ? rows("late", lists.late.map((l) => ({ task: l.task, link: l.link, late: l })))
      : k === "open"
        ? rows(
            "open",
            openShown.map((task) => ({ task })),
            true,
          )
        : k === "timed"
          ? rows("timed", lists.timed)
          : rows("done", lists.done.map((task) => ({ task })));

  const taskById = (id: string | undefined) => (id ? (state.tasks.find((t) => t.id === id) ?? null) : null);
  const editTask = taskById(edit?.id);
  const planTask = taskById(plan?.id);
  const dueTask = taskById(dueEdit?.id);
  const sendTask = taskById(send?.id);
  const selRule = ruleSel ? (state.rules.find((r) => r.id === ruleSel) ?? null) : null;
  const selRuleRow = selRule ? (ruleRows.find((x) => x.rule.id === selRule.id) ?? null) : null;
  const editRule = ruleEdit?.id ? (state.rules.find((r) => r.id === ruleEdit.id) ?? null) : null;
  let panel: ReactNode = null;
  let panelLabel = "";
  /** 패널 내용이 바뀌면(다른 할 일 · 보기 → 수정) 새로 나타난다 */
  const panelKey = roleEdit
    ? "roles"
    : send
      ? `send:${send.id}`
      : dueEdit
        ? `due:${dueEdit.id}`
        : plan
          ? `plan:${plan.id}`
          : edit
            ? `edit:${edit.id}`
            : ruleEdit
              ? `rule-edit:${ruleEdit.id ?? ruleEdit.task}`
              : selRule
                ? `rule:${selRule.id}`
                : `view:${sel}`;
  if (roleEdit) {
    panelLabel = "역할 편집";
    panel = <RoleEdit roles={roles} onRename={renameRole} onAdd={addRole} onMove={moveRole} onDelete={(r) => void removeRole(r)} />;
  } else if (send && sendTask) {
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
        places={D.places}
        roles={roles}
        loadDueOptions={() => D.S.events(today, addDays(today, 60)).then((rows) => dueOptions(rows, today))}
        onChange={(d) => setEdit((x) => (x ? { ...x, draft: d } : x))}
        onSave={() => void saveEdit()}
        onCancel={() => setEdit(null)}
      />
    );
  } else if (ruleEdit && (editRule || ruleEdit.task)) {
    panelLabel = ruleEdit.id ? "반복 수정" : "반복으로 만들기";
    panel = (
      <RuleForm
        key={`rule:${ruleEdit.id ?? ruleEdit.task}`}
        draft={ruleEdit.draft}
        eventLabel={editRule?.kind === "event" ? ruleLabel(editRule, editRule.event_id ? state.titles[editRule.event_id] : null) : null}
        places={D.places}
        roles={roles}
        isNew={ruleEdit.id === null}
        onChange={(d) => setRuleEdit((x) => (x ? { ...x, draft: d } : x))}
        onSave={() => void saveRule()}
        onCancel={() => setRuleEdit(null)}
      />
    );
  } else if (selRule) {
    panelLabel = selRule.title;
    panel = (
      <RuleDetail
        rule={selRule}
        label={selRuleRow?.label ?? ""}
        next={selRuleRow?.next ?? null}
        place={selRule.place_id ? (placeOf.get(selRule.place_id) ?? null) : null}
        role={roles.find((r) => r.id === selRule.role_id)?.name ?? null}
        onBench={(on) => patchRule(selRule, { bench: on })}
        onEdit={() => startRuleEdit(selRule)}
        onPause={(paused) => patchRule(selRule, { paused })}
        onDelete={() => void removeRule(selRule)}
      />
    );
  } else if (selTask) {
    const rule = ruleOf(state, selTask);
    const canSend = !selLink && selTask.done_at === null;
    const canRepeat = !rule && selTask.done_at === null;
    panelLabel = selTask.title;
    panel = (
      <TaskDetail
        task={selTask}
        link={selLink}
        event={linkedEv}
        late={lateOf(selTask, selLink, now)}
        place={selTask.place_id ? (placeOf.get(selTask.place_id) ?? null) : null}
        role={roles.find((r) => r.id === selTask.role_id)?.name ?? null}
        dueTitle={selTask.due_event_id ? (state.titles[selTask.due_event_id] ?? null) : null}
        repeat={rule ? ruleLabel(rule, rule.event_id ? state.titles[rule.event_id] : null) : null}
        today={today}
        scheduleHref={selLink && !isTemp(selLink.event_id) ? href(`/schedule?date=${selLink.date}&event=${selLink.event_id}`) : null}
        onToggle={(x) => void toggle(x)}
        onCheck={(i, done) => check(selTask, i, done)}
        onPlan={() => startPlan()}
        onUnplan={() => void unplan()}
        onDue={startDue}
        onClearDue={() => void clearDue()}
        onEdit={() => startEdit()}
        onBench={selTask.done_at === null ? (on) => toBench(selTask, on) : null}
        onDelete={() => void remove()}
        onMore={
          canSend || canRepeat
            ? (e: ReactMouseEvent<HTMLButtonElement>) => {
                const r = e.currentTarget.getBoundingClientRect();
                // 아래에 자리가 없으면(폰 시트 맨 아래) 버튼 위로 연다 — 버튼을 가리지 않게
                const h = canSend && canRepeat ? 92 : 52;
                setMenu({ x: r.left, y: r.bottom + h + 4 > innerHeight ? r.top - h : r.bottom + 4 });
              }
            : null
        }
      />
    );
  }
  const viewing = panel !== null && !edit && !plan && !dueEdit && !send && !ruleEdit;

  const close = (
    <button type="button" className="iconbtn pl-x" aria-label="닫기" title="닫기" onClick={closeAll}>
      <Icon name="x" />
    </button>
  );

  return (
    <div className="planner">
      <PlannerBar home={<HomeButton />} />
      <div className="pl-ctl">
        <div className="pl-sort" role="group" aria-label="정렬">
          {SORT_KEYS.map((k) => (
            <button type="button" key={k} className="rf" aria-pressed={sort.key === k} onClick={() => pickSort({ ...sort, key: k })}>
              {SORT_LABEL[k]}
            </button>
          ))}
          {!manual && (
            <button
              type="button"
              className="iconbtn rf-dir"
              aria-label={sort.dir === "asc" ? "오름차순" : "내림차순"}
              title={sort.dir === "asc" ? "오름차순" : "내림차순"}
              onClick={() => pickSort({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
            >
              <Icon name={sort.dir === "asc" ? "asc" : "desc"} />
            </button>
          )}
        </div>
        <RoleFilter roles={roles} off={roleOff} onToggle={pickRole} editing={roleEdit} onEdit={openRoles} />
      </div>
      <div className="pl-stage">
        <div
          className="pl-list"
          ref={listRef}
          onClick={(e) => {
            // 빈 곳을 누르면 보기를 닫는다 (고치는 중에는 그대로)
            if (viewing && !(e.target as HTMLElement).closest("li, button, a")) closeAll();
          }}
        >
          <PlannerCards
            count={{ late: lists.late.length, open: openShown.length, timed: lists.timed.length, done: lists.done.length }}
            body={body}
            showDone={showDone}
            onFold={() => setShowDone((v) => !v)}
            addRow={
              <label className="pl-new">
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
            }
            rules={{ count: ruleRows.length, body: ruleList, open: showRules, onFold: () => setShowRules((v) => !v) }}
          />
        </div>
        {!phone && wide && panel && (
          <aside className="dp pl-dp" aria-label={panelLabel}>
            {viewing && close}
            <div className="dp-in" key={panelKey}>
              {panel}
            </div>
          </aside>
        )}
        <Presence>
          {!phone && !wide && panel && (
            <aside className="dp pl-dp float" aria-label={panelLabel}>
              {viewing && close}
              <div className="dp-in" key={panelKey}>
                {panel}
              </div>
            </aside>
          )}
        </Presence>
      </div>
      <Presence>
        {phone && panel && (
          <div
            className={viewing ? "scrim light" : "scrim"}
            onClick={() => {
              if (viewing) closeAll();
              else closeForms();
            }}
          />
        )}
      </Presence>
      <Presence>
        {phone && panel && (
          <div className={viewing ? "sheet peek" : "sheet"} role="dialog" aria-label={panelLabel}>
            <span className="grab" />
            <div className="sh-in" key={panelKey}>
              {panel}
            </div>
          </div>
        )}
      </Presence>
      {menu && viewing && selTask && (
        <Menu
          x={menu.x}
          y={menu.y}
          entries={[
            ...(!selLink && selTask.done_at === null ? [{ kind: "item" as const, icon: "cal" as const, label: "일정으로", run: () => startSend() }] : []),
            ...(!ruleOf(state, selTask) && selTask.done_at === null
              ? [{ kind: "item" as const, icon: "repeat" as const, label: "반복으로 만들기", run: () => startRepeat() }]
              : []),
          ]}
          onClose={() => setMenu(null)}
        />
      )}
      {cm.node}
    </div>
  );
}
