// 화면 하나를 여는 데 Supabase 를 몇 번, 몇 차례로 부르는지 고정한다 (가짜 클라이언트 — 로그인 없이).
// 요청 하나가 0.3초쯤이라 "첫 그림까지 차례 수"가 체감 속도다. 여기 숫자가 늘면 화면이 느려진 것이다.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";
import { SupabaseMeet } from "./meetSupabase";
import { openPlanner, readMeetLists, readMeta, readPlannerLists, readTaskLists, readWeek, rollWith, titleIds, keepTitles, needsPrefetch, neighbors, PREFETCH_MAX_AGE_MS } from "./loaders";
import { SupabaseSchedule } from "./scheduleSupabase";
import { setClient } from "./supabase";

type Pending = { label: string; done: () => void };

/** 부른 것을 적어 두고, flush 할 때 한꺼번에 답한다 (같이 떠난 요청 = 한 차례) */
function fake(answers: Record<string, unknown> = {}) {
  const pending: Pending[] = [];
  const log: string[] = [];
  const builder = (label: string, empty: unknown) => {
    let single = false;
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
            log.push(label);
            return new Promise((r) => pending.push({ label, done: () => r({ data: label in answers ? answers[label] : single ? null : empty, error: null }) })).then(ok, bad);
          };
        }
        return () => {
          if (prop === "maybeSingle" || prop === "single") single = true;
          return p;
        };
      },
    });
    return p;
  };
  const client = { from: (name: string) => builder(name, []), rpc: (name: string) => builder(`rpc:${name}`, 0) };
  setClient(client as unknown as SupabaseClient);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    log,
    /** 다 끝날 때까지(또는 until 이 참이 될 때까지) 차례를 돌린다. 돈 차례 수 */
    async rounds(until?: () => boolean): Promise<number> {
      for (let n = 0; ; n++) {
        await settle();
        if (until?.() || pending.length === 0) return n;
        for (const p of pending.splice(0)) p.done();
      }
    },
  };
}

const AT = { date: "2026-10-01", min: 600 };
const ROLE = [{ id: "ro1", name: "나", from_place: null, sort: 1, version: 1 }];

afterEach(() => setClient(null));

describe("플래너 열기", () => {
  it("첫 그림까지 한 차례 — 굴리기 · 목록 넷 · 시간 기록 합 · 지점을 같이 보낸다 (예전: seed → roll → 목록 → 제목 네 차례)", async () => {
    const f = fake({ ez_roles: ROLE });
    const T = new SupabaseSchedule();
    let painted = false;
    const load = () =>
      readPlannerLists(T).then((l) => {
        painted = true;
        return l;
      });
    void openPlanner(T, AT, load, () => T.seedRoles());
    void T.places();
    expect(await f.rounds(() => painted)).toBe(1);
    // 시간 기록 합(ez_work_sum, 7-16)도 같은 차례에 — 차례 수는 그대로다
    expect([...f.log].sort()).toEqual(["ez_events", "ez_places", "ez_roles", "ez_task_rules", "ez_tasks", "rpc:ez_tasks_roll", "rpc:ez_work_sum"]);
    // 역할이 있고 굴린 게 없으면 더 부르지 않는다
    expect(await f.rounds()).toBe(0);
    expect(f.log).toHaveLength(7);
  });

  it("역할이 하나도 없을 때만 기본 역할을 넣고, 넣었을 때만 다시 읽는다", async () => {
    const f = fake({ "rpc:ez_roles_seed": 4 });
    const T = new SupabaseSchedule();
    let loads = 0;
    void openPlanner(T, AT, () => (loads++, readPlannerLists(T)), () => T.seedRoles());
    expect(await f.rounds()).toBe(3);
    expect(f.log.filter((l) => l === "rpc:ez_roles_seed")).toHaveLength(1);
    expect(loads).toBe(2);
  });

  it("굴려서 할 일이 생겼을 때만 다시 읽는다", async () => {
    const f = fake({ ez_roles: ROLE, "rpc:ez_tasks_roll": 2 });
    const T = new SupabaseSchedule();
    let loads = 0;
    void openPlanner(T, AT, () => (loads++, readPlannerLists(T)), () => T.seedRoles());
    expect(await f.rounds()).toBe(2);
    expect(loads).toBe(2);
    expect(f.log).not.toContain("rpc:ez_roles_seed");
  });

  it("굴리기가 실패해도 목록은 그린다", async () => {
    const T = {
      roll: () => Promise.reject(new Error("x")),
      tasks: async () => [],
      links: async () => [],
      rules: async () => [],
      roles: async () => ROLE,
      workSums: async () => ({}),
    } as unknown as SupabaseSchedule;
    let loads = 0;
    await openPlanner(T, AT, () => (loads++, readPlannerLists(T)), async () => 0);
    expect(loads).toBe(1);
  });
});

describe("시간 기록 합을 할 일에 얹기", () => {
  it("기록이 있는 할 일에만 work. 합을 못 읽어도 목록은 그린다", async () => {
    const work = { today_sec: 60, total_sec: 120, running: true, started_at: "2026-10-01T00:00:00Z", at: "2026-10-01T00:01:00Z" };
    const base = { roll: async () => 0, links: async () => [], rules: async () => [], roles: async () => ROLE };
    const tasks = async () => [{ id: "a" }, { id: "b", work: { ...work, total_sec: 1 } }];
    const ok = await readPlannerLists({ ...base, tasks, workSums: async () => ({ a: work }) } as unknown as SupabaseSchedule);
    expect(ok.tasks).toEqual([{ id: "a", work }, { id: "b" }]); // 낡은 합은 지운다
    const bad = await readPlannerLists({ ...base, tasks, workSums: () => Promise.reject(new Error("x")) } as unknown as SupabaseSchedule);
    expect(bad.tasks).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("ez_work_sum 의 줄을 할 일 id → 합으로", async () => {
    const f = fake({ "rpc:ez_work_sum": [{ task_id: "a", today_sec: 5, total_sec: 9, running: false, started_at: null }] });
    const p = new SupabaseSchedule().workSums();
    await f.rounds();
    expect(await p).toMatchObject({ a: { today_sec: 5, total_sec: 9, running: false, started_at: null } });
  });
});

describe("일정 열기", () => {
  it("첫 그림까지 한 차례 — 메타 넷 · 그 주(예외 포함) · 굴리기 · 할 일 셋 (예전: 일정 → 예외, 굴리기 → 할 일 두 차례씩)", async () => {
    const f = fake();
    const S = new SupabaseSchedule();
    let done = 0;
    void readMeta(S).then(() => done++);
    void readWeek(S, "2026-09-28").then(() => done++);
    void rollWith(S, AT, () => readTaskLists(S)).then(() => done++);
    expect(await f.rounds(() => done === 3)).toBe(1);
    expect([...f.log].sort()).toEqual(
      ["ez_events", "ez_events", "ez_places", "ez_schedule_settings", "ez_sources", "ez_task_rules", "ez_tasks", "ez_travel", "rpc:ez_tasks_roll"].sort(),
    );
  });

  it("한 주는 요청 하나 — 예외는 일정에 끼워 온다. 반복을 푼 일정에 남은 예외는 싣지 않는다", async () => {
    const ex = (id: string) => ({ event_id: id, on_date: "2026-10-01", skip: true, patch: null });
    const f = fake({
      ez_events: [
        { id: "a", repeat: { every: "week" }, exceptions: [ex("a")] },
        { id: "b", repeat: null, exceptions: [ex("b")] },
        { id: "c", repeat: null, exceptions: [] },
      ],
    });
    const p = readWeek(new SupabaseSchedule(), "2026-09-28");
    expect(await f.rounds()).toBe(1);
    const rows = await p;
    expect(f.log).toEqual(["ez_events"]);
    expect(rows.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(rows.events.every((e) => !("exceptions" in e))).toBe(true);
    expect(rows.exceptions).toEqual([ex("a")]);
  });
});

describe("모임 열기", () => {
  it("첫 그림까지 한 차례 — 모임(사람들까지) · 묶음 · 역할 · 지점 · 설정을 같이 보낸다", async () => {
    const person = { id: "p1", meet_id: "m1", name: "나", is_owner: true, cells: null, auto: false, attend: null, created_at: "1" };
    const late = { ...person, id: "p2", name: "민서", is_owner: false, created_at: "0" };
    const f = fake({ ez_meets: [{ id: "m1", title: "회의", people: [late, person] }], ez_roles: ROLE });
    const S = new SupabaseSchedule();
    const p = readMeetLists(new SupabaseMeet(), S, S);
    expect(await f.rounds()).toBe(1);
    expect([...f.log].sort()).toEqual(["ez_circles", "ez_meets", "ez_places", "ez_roles", "ez_schedule_settings"]);
    const lists = await p;
    // 내 줄이 맨 앞
    expect(lists.meets[0]!.people.map((x) => x.name)).toEqual(["나", "민서"]);
    expect(lists.settings.my_name).toBeNull();
  });
});

describe("순수 판단", () => {
  it("제목을 읽을 일정 id: 딸린 마감 · 딸린 규칙, 겹치지 않게", () => {
    const tasks = [{ due_event_id: "e2" }, { due_event_id: null }, { due_event_id: "e1" }] as never[];
    const rules = [{ event_id: "e1" }, { event_id: null }] as never[];
    expect(titleIds(tasks, rules)).toEqual(["e1", "e2"]);
  });

  it("새 제목이 오기 전에는 아는 제목 중 지금 필요한 것만", () => {
    expect(keepTitles({ e1: "수업", e9: "지난 것" }, ["e1", "e2"])).toEqual({ e1: "수업" });
  });

  it("이웃 주는 앞 · 뒤 한 칸", () => {
    expect(neighbors("2026-09-28")).toEqual(["2026-09-21", "2026-10-05"]);
  });

  it("미리 읽기는 없거나 5분이 넘었을 때만", () => {
    expect(needsPrefetch(undefined, 0)).toBe(true);
    expect(needsPrefetch(0, PREFETCH_MAX_AGE_MS)).toBe(false);
    expect(needsPrefetch(0, PREFETCH_MAX_AGE_MS + 1)).toBe(true);
  });
});
