"use client";

// 플래너 · 작업대 목록 · 집중 화면이 같이 쓰는 할 일 저장 (docs/플래너.md 7-13 · 7-15 · 7-16).
// 모두 usePlannerData().run 으로 — 화면 먼저 바꾸고 줄 세워 부른다. 버전 · 지금 목록은 부를 때의 서버 값에서 읽는다(빠르게 여러 번 해도 안 엇갈리게).
// 단계는 줄 단위(평탄 번호 k)로 다룬다 — 규칙은 lib/schedule/steps.ts. 서버 값에서는 같은 글자 · 같은 깊이의 줄을 다시 찾는다(그사이 순서가 바뀌었을 수 있다).

import {
  findStep,
  flatSteps,
  indentStep,
  insertStep,
  liveWork,
  outdentStep,
  removeStep as withoutStep,
  restoreStep,
  setStepEst,
  toggleStep,
  validateTask,
  type CheckItem,
  type TaskRow,
  type TaskWork,
} from "../../../lib/schedule";
import { detachTaskStep } from "../../_logic/planner";
import { useToast } from "../Toast";
import type { PlannerDataHook, PlannerState } from "./usePlannerData";

export const tempId = () => `tmp-${globalThis.crypto.randomUUID()}`;
export const isTemp = (id: string) => id.startsWith("tmp-");

export const mapTask = (s: PlannerState, id: string, f: (t: TaskRow) => TaskRow): PlannerState => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? f(t) : t)) });

/** 화면에서 새로 만든 할 일 (서버가 돌려주기 전) */
function tempTask(over: Partial<TaskRow> & Pick<TaskRow, "title" | "sort">): TaskRow {
  const at = new Date().toISOString();
  return {
    id: tempId(),
    note: null,
    due: null,
    est_min: null,
    done_at: null,
    origin_kind: null,
    origin_id: null,
    place_id: null,
    due_event_id: null,
    checklist: [],
    rule_id: null,
    rule_date: null,
    role_id: null,
    bench_order: null,
    bench_at: null,
    version: 1,
    created_at: at,
    updated_at: at,
    ...over,
  };
}

const topSort = (s: PlannerState | null) => Math.min(0, ...(s?.tasks ?? []).map((t) => t.sort)) - 1;
const nextBench = (s: PlannerState) => Math.max(0, ...s.tasks.map((t) => t.bench_order ?? 0)) + 1;

/** 화면 먼저: 작업대에 올린다(맨 뒤). 이미 올라가 있으면 그대로 */
export const benchOn = (s: PlannerState, id: string): PlannerState => {
  const n = nextBench(s);
  return mapTask(s, id, (x) => (x.bench_order !== null ? x : { ...x, bench_order: n }));
};

/** 돌던 시간을 지금에서 멈춘 합 */
function frozen(w: TaskWork, nowMs: number): TaskWork {
  const live = liveWork(w, nowMs);
  return { today_sec: live.today, total_sec: live.total, running: false, started_at: null, at: new Date(nowMs).toISOString() };
}

/** 화면 먼저: 돌고 있는 시간을 전부 멈춘다 (only 를 주면 그 할 일 것만) */
export const workOff = (s: PlannerState, nowMs: number, only?: string): PlannerState => ({
  ...s,
  tasks: s.tasks.map((x) => (x.work?.running && (only === undefined || x.id === only) ? { ...x, work: frozen(x.work, nowMs) } : x)),
});

/** 화면 먼저: 그 할 일에서 시간이 가기 시작한다 — 다른 것은 멈춘다(한 번에 하나) */
export const workOn = (s: PlannerState, id: string, nowMs: number): PlannerState => {
  const at = new Date(nowMs).toISOString();
  return {
    ...s,
    tasks: s.tasks.map((x) => {
      if (x.id !== id) return x.work?.running ? { ...x, work: frozen(x.work, nowMs) } : x;
      if (x.work?.running) return x;
      const live = liveWork(x.work, nowMs);
      return { ...x, work: { today_sec: live.today, total_sec: live.total, running: true, started_at: at, at } };
    }),
  };
};

/** 화면에서 본 줄(글자 · 깊이 · 번호) — 서버 값에서 다시 찾을 때 쓴다 */
type StepRef = { k: number; t: string; depth: 0 | 1 };
const refOf = (list: readonly CheckItem[], k: number): StepRef | null => {
  const f = flatSteps(list)[k];
  return f ? { k, t: f.t, depth: f.depth } : null;
};

export function useTaskOps(D: PlannerDataHook) {
  const toast = useToast();
  const state = D.state;

  /** 맨 위에 보통 할 일 하나 (역할 · 지점 없이). 넣었으면 true */
  function addTask(raw: string): boolean {
    const title = raw.trim();
    if (title === "" || !state) return false;
    const issue = validateTask({ title })[0];
    if (issue) {
      toast(issue.reason);
      return false;
    }
    const temp = tempTask({ title, sort: topSort(state) });
    void D.run((s) => ({ ...s, tasks: [temp, ...s.tasks] }), () => D.T.createTask({ title }));
    return true;
  }

  /** 끝내면 작업대에서 내려오고 돌던 시간도 멈춘다(DB). 되돌리면 작업대에 있던 것은 다시 올린다 */
  async function toggle(t: TaskRow): Promise<void> {
    if (isTemp(t.id)) return;
    const done = t.done_at === null;
    const benched = t.bench_order !== null;
    const at = new Date().toISOString();
    const row = await D.run(
      (s) => {
        const next = mapTask(s, t.id, (x) => ({ ...x, done_at: done ? at : null, ...(done ? { bench_order: null, bench_at: null } : {}) }));
        return done ? workOff(next, Date.now(), t.id) : next;
      },
      (srv) => D.T.setDone(t.id, D.versionOf(srv, t.id, t.version), done),
    );
    if (row && done) {
      toast("끝냈습니다", {
        label: "되돌리기",
        run: () =>
          void D.run(
            (s) => {
              const back = mapTask(s, t.id, (x) => ({ ...x, done_at: null }));
              return benched ? benchOn(back, t.id) : back;
            },
            async (srv) => {
              const back = await D.T.setDone(t.id, D.versionOf(srv, t.id, row.version), false);
              return benched ? D.T.bench(t.id, true) : back;
            },
          ),
      });
    }
  }

  /** 단계 목록 바꾸기. f 는 화면 값에도 서버 값에도 쓰인다 */
  function editSteps(t: TaskRow, f: (list: TaskRow["checklist"]) => TaskRow["checklist"]) {
    return D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, checklist: f(x.checklist) })),
      (srv) => {
        const cur = srv.tasks.find((x) => x.id === t.id) ?? t;
        return D.T.updateTask(t.id, cur.version, { checklist: f(cur.checklist) });
      },
    );
  }

  /** k 번째 줄에 하는 일 — 서버 값에서는 같은 줄을 다시 찾아서 (없으면 그대로) */
  function onStep(t: TaskRow, k: number, f: (list: TaskRow["checklist"], k: number) => TaskRow["checklist"]) {
    const ref = refOf(t.checklist, k);
    if (!ref) return Promise.resolve(undefined);
    return editSteps(t, (list) => {
      const at = findStep(list, ref);
      return at < 0 ? list : f(list, at);
    });
  }

  /** 체크는 바로. 윗단을 체크하면 아랫단도 체크된다 */
  function check(t: TaskRow, k: number, done: boolean) {
    void onStep(t, k, (list, at) => toggleStep(list, at, done));
  }

  /** 줄 하나 넣기: after 줄 바로 아래(null 이면 맨 끝)에 depth 깊이로. 넣었으면 그 줄의 번호, 못 넣었으면 null */
  function addStep(t: TaskRow, after: number | null, depth: 0 | 1, text: string): number | null {
    const r = insertStep(t.checklist, after, depth, text);
    if (r.issue) toast(r.issue);
    if (r.k === null) return null;
    const ref = after === null ? null : refOf(t.checklist, after);
    void editSteps(t, (list) => {
      const at = ref ? findStep(list, ref) : null;
      return insertStep(list, at !== null && at < 0 ? null : at, depth, text).list;
    });
    return r.k;
  }

  /** 들이기(Tab) · 내기(Shift+Tab) */
  function indent(t: TaskRow, k: number, into: boolean) {
    void onStep(t, k, (list, at) => (into ? indentStep(list, at) : outdentStep(list, at)));
  }

  /** 단계의 걸릴 시간(분) — null 이면 지운다 */
  function setEst(t: TaskRow, k: number, est: number | null) {
    void onStep(t, k, (list, at) => setStepEst(list, at, est));
  }

  /** 떼어내기: 그 줄이 새 할 일로(역할 · 지점 · 마감 물려받음, 윗단이면 아랫단이 새 할 일의 단계). 되돌리기는 둘 다 */
  async function detach(t: TaskRow, k: number) {
    const d = detachTaskStep(t, k);
    const ref = refOf(t.checklist, k);
    if (!d || !ref || isTemp(t.id)) return;
    const temp = tempTask({ sort: topSort(state), ...d.input });
    const made = await D.run(
      (s) => ({ ...s, tasks: [temp, ...s.tasks.map((x) => (x.id === t.id ? { ...x, checklist: d.rest } : x))] }),
      async (srv) => {
        const cur = srv.tasks.find((x) => x.id === t.id) ?? t;
        const at = findStep(cur.checklist, ref);
        const row = await D.T.createTask(d.input);
        try {
          if (at >= 0) await D.T.updateTask(t.id, cur.version, { checklist: withoutStep(cur.checklist, at).list });
        } catch (e) {
          // 단계를 못 뺐으면 방금 만든 할 일을 남기지 않는다
          await D.T.deleteTask(row.id, row.version).catch(() => {});
          throw e;
        }
        return row;
      },
    );
    if (!made) return;
    toast("새 할 일로 떼어냈습니다", {
      label: "되돌리기",
      run: () =>
        void D.run(
          (s) => ({ ...s, tasks: s.tasks.filter((x) => x.id !== made.id).map((x) => (x.id === t.id ? { ...x, checklist: restoreStep(x.checklist, d.removed) } : x)) }),
          async (srv) => {
            await D.T.deleteTask(made.id, D.versionOf(srv, made.id, made.version));
            const cur = srv.tasks.find((x) => x.id === t.id) ?? t;
            return D.T.updateTask(t.id, cur.version, { checklist: restoreStep(cur.checklist, d.removed) });
          },
        ),
    });
  }

  /** 단계 지우기 (집중 화면의 우클릭 메뉴). 윗단이면 아랫단째. 되돌리기는 그 자리에 다시 */
  async function removeStep(t: TaskRow, k: number) {
    const r = withoutStep(t.checklist, k);
    if (!r.removed || isTemp(t.id)) return;
    const removed = r.removed;
    const row = await onStep(t, k, (list, at) => withoutStep(list, at).list);
    if (!row) return;
    toast("단계를 지웠습니다", { label: "되돌리기", run: () => void editSteps(t, (list) => restoreStep(list, removed)) });
  }

  function saveNote(t: TaskRow, note: string | null) {
    void D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, note })),
      (srv) => D.T.updateTask(t.id, D.versionOf(srv, t.id, t.version), { note }),
    );
  }

  /** 작업대에 올리기(맨 뒤) · 내리기. 내려도 돌던 시간은 그대로 간다(기록은 시간이지 화면이 아니다) */
  function bench(t: TaskRow, on: boolean) {
    if (isTemp(t.id) || (on && t.done_at !== null)) return Promise.resolve(undefined);
    return D.run(
      (s) => (on ? benchOn(s, t.id) : mapTask(s, t.id, (x) => ({ ...x, bench_order: null, bench_at: null }))),
      () => D.T.bench(t.id, on),
    );
  }

  /** 시작 — 그 할 일에서 시간을 잰다. 다른 할 일에서 돌던 것은 멈춘다 */
  function workStart(t: TaskRow) {
    if (isTemp(t.id) || t.done_at !== null || t.work?.running) return;
    void D.run(
      (s) => workOn(s, t.id, Date.now()),
      () => D.T.workStart(t.id),
    );
  }

  /** 중지 */
  function workStop() {
    void D.run(
      (s) => workOff(s, Date.now()),
      () => D.T.workStop(),
    );
  }

  /** 작업대 순서 — ids 순서대로 1, 2, … */
  function reorderBench(ids: readonly string[]) {
    const at = new Map(ids.map((id, i) => [id, i + 1]));
    void D.run(
      (s) => ({ ...s, tasks: s.tasks.map((x) => (at.has(x.id) && x.bench_order !== null ? { ...x, bench_order: at.get(x.id)! } : x)) }),
      () => D.T.reorderBench(ids),
    );
  }

  return { addTask, toggle, check, editSteps, addStep, indent, setEst, detach, removeStep, saveNote, bench, workStart, workStop, reorderBench };
}
