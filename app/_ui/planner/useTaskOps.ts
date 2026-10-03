"use client";

// 플래너 · 작업대 목록 · 집중 화면이 같이 쓰는 할 일 저장 (docs/플래너.md 7-13 · 7-15).
// 모두 usePlannerData().run 으로 — 화면 먼저 바꾸고 줄 세워 부른다. 버전 · 지금 목록은 부를 때의 서버 값에서 읽는다(빠르게 여러 번 해도 안 엇갈리게).

import { validateTask, type TaskRow } from "../../../lib/schedule";
import { addStep, detachStep, insertStep, toggleCheck } from "../../_logic/planner";
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

/** 화면 먼저: 그것에 앉는다(다른 앉음은 빈다, 안 올라가 있으면 올린다) */
export const sitOn = (s: PlannerState, id: string, at: string): PlannerState => {
  const n = nextBench(s);
  return {
    ...s,
    tasks: s.tasks.map((x) =>
      x.id === id ? { ...x, bench_order: x.bench_order ?? n, bench_at: x.bench_at ?? at } : x.bench_at !== null ? { ...x, bench_at: null } : x,
    ),
  };
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

  /** 끝내면 작업대에서도 내려온다(DB). 되돌리면 작업대에 있던 것은 다시 올린다(앉아 있었으면 다시 앉는다) */
  async function toggle(t: TaskRow): Promise<void> {
    if (isTemp(t.id)) return;
    const done = t.done_at === null;
    const benched = t.bench_order !== null;
    const sat = t.bench_at !== null;
    const at = new Date().toISOString();
    const row = await D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, done_at: done ? at : null, ...(done ? { bench_order: null, bench_at: null } : {}) })),
      (srv) => D.T.setDone(t.id, D.versionOf(srv, t.id, t.version), done),
    );
    if (row && done) {
      toast("끝냈습니다", {
        label: "되돌리기",
        run: () =>
          void D.run(
            (s) => {
              const back = mapTask(s, t.id, (x) => ({ ...x, done_at: null }));
              return sat ? sitOn(back, t.id, at) : benched ? benchOn(back, t.id) : back;
            },
            async (srv) => {
              const back = await D.T.setDone(t.id, D.versionOf(srv, t.id, row.version), false);
              return sat ? D.T.sit(t.id) : benched ? D.T.bench(t.id, true) : back;
            },
          ),
      });
    }
  }

  /** 체크 항목 체크는 바로 */
  function check(t: TaskRow, i: number, done: boolean) {
    void D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, checklist: toggleCheck(x.checklist, i, done) })),
      (srv) => {
        const cur = srv.tasks.find((x) => x.id === t.id) ?? t;
        return D.T.updateTask(t.id, cur.version, { checklist: toggleCheck(cur.checklist, i, done) });
      },
    );
  }

  /** 단계 목록 바꾸기 */
  function editSteps(t: TaskRow, f: (list: TaskRow["checklist"]) => TaskRow["checklist"]) {
    return D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, checklist: f(x.checklist) })),
      (srv) => {
        const cur = srv.tasks.find((x) => x.id === t.id) ?? t;
        return D.T.updateTask(t.id, cur.version, { checklist: f(cur.checklist) });
      },
    );
  }

  /** 단계 하나 더하기. 넣었으면 true */
  function addBenchStep(t: TaskRow, text: string): boolean {
    if (text.trim() === "") return false;
    const r = addStep(t.checklist, text);
    if (r.issue) {
      toast(r.issue);
      return false;
    }
    void editSteps(t, (list) => addStep(list, text).list);
    return true;
  }

  /** 떼어내기: 그 단계가 새 할 일로(역할 · 지점 · 마감 물려받음), 단계에서는 빠진다. 되돌리기는 둘 다 */
  async function detach(t: TaskRow, i: number) {
    const d = detachStep(t, i);
    if (!d || isTemp(t.id)) return;
    const item = t.checklist[i]!;
    const temp = tempTask({ sort: topSort(state), ...d.input });
    const made = await D.run(
      (s) => ({ ...s, tasks: [temp, ...s.tasks.map((x) => (x.id === t.id ? { ...x, checklist: d.rest } : x))] }),
      async (srv) => {
        const cur = srv.tasks.find((x) => x.id === t.id) ?? t;
        const k = cur.checklist.findIndex((c) => c.t === item.t);
        const row = await D.T.createTask(d.input);
        try {
          if (k >= 0) await D.T.updateTask(t.id, cur.version, { checklist: cur.checklist.filter((_, j) => j !== k) });
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
          (s) => ({ ...s, tasks: s.tasks.filter((x) => x.id !== made.id).map((x) => (x.id === t.id ? { ...x, checklist: insertStep(x.checklist, i, item) } : x)) }),
          async (srv) => {
            await D.T.deleteTask(made.id, D.versionOf(srv, made.id, made.version));
            const cur = srv.tasks.find((x) => x.id === t.id) ?? t;
            return D.T.updateTask(t.id, cur.version, { checklist: insertStep(cur.checklist, i, item) });
          },
        ),
    });
  }

  function saveNote(t: TaskRow, note: string | null) {
    void D.run(
      (s) => mapTask(s, t.id, (x) => ({ ...x, note })),
      (srv) => D.T.updateTask(t.id, D.versionOf(srv, t.id, t.version), { note }),
    );
  }

  /** 작업대에 올리기(맨 뒤) · 내리기(앉음도 빈다) */
  function bench(t: TaskRow, on: boolean) {
    if (isTemp(t.id) || (on && t.done_at !== null)) return Promise.resolve(undefined);
    return D.run(
      (s) => (on ? benchOn(s, t.id) : mapTask(s, t.id, (x) => ({ ...x, bench_order: null, bench_at: null }))),
      () => D.T.bench(t.id, on),
    );
  }

  /** 앉기 — 집중 화면을 열 때 */
  function sit(t: TaskRow) {
    if (isTemp(t.id) || t.done_at !== null || t.bench_at !== null) return;
    void D.run(
      (s) => sitOn(s, t.id, new Date().toISOString()),
      () => D.T.sit(t.id),
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

  return { addTask, toggle, check, editSteps, addBenchStep, detach, saveNote, bench, sit, reorderBench };
}
