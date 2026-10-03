// 진짜 스토어(supabase-js)가 보내는 쿼리를 하나하나 적어 놓고 본다 — service_role 은 RLS 를 우회하므로 (docs/에이전트-연결.md 2장 (나))
// "모든 쿼리에 owner 조건" 이 깨지면 남의 것이 보인다. PGlite 시험(cross.test.ts)은 시험용 스토어의 SQL 을 보는 것이라, 진짜 스토어는 여기서 본다.
// 규칙:
//   · owner 칸이 있는 표: 읽기 · 고치기 · 지우기에는 eq(owner, 나), 넣기에는 owner: 나
//   · owner 칸이 없는 딸린 표(예외 · 사람 · 글): 같은 메서드 안에서 먼저 부모 표를 eq(owner, 나)로 확인
//   · DB 함수: p_as: 나
//   · 사진: 내 폴더(<나>/…) 밖의 경로는 저장소에 닿기 전에 거절
// 메서드 목록은 인터페이스에서 온다 — 새 메서드를 더하면 아래 표에 인자를 적어야 타입 검사가 통과한다.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { SupabaseMeetStore } from "./meet-store-supabase";
import type { MeetStore } from "./meet-store";
import { SupabaseScheduleStore } from "./schedule-store-supabase";
import type { ScheduleStore } from "./schedule-store";
import { SupabaseStore } from "./store-supabase";
import type { Store } from "./store";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

type Filter = [string, ...unknown[]];
type Op =
  | { kind: "table"; table: string; verb: "select" | "insert" | "update" | "upsert" | "delete"; payload?: unknown; filters: Filter[] }
  | { kind: "rpc"; fn: string; args: Record<string, unknown> }
  | { kind: "storage"; verb: string; paths: string[] };

/** 어느 표든 통하는 한 줄 (스토어의 변환 함수들이 읽는 칸) */
const ROW = { id: ID, version: 1, name: "x", title: "x", kind: "report", circle_id: ID2, role_id: ID2, token: null, people: [], members: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };

/** supabase-js 흉내: 무엇을 보냈는지 적고, 그럴듯한 한 줄을 돌려준다 */
function recorder() {
  const ops: Op[] = [];
  const builder = (op: Op, list: boolean) => {
    let one = false;
    const b: Record<string, unknown> = {};
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        if (op.kind === "table") {
          if (name === "select" || name === "insert" || name === "update" || name === "upsert" || name === "delete") {
            // insert(...).select() 의 select 는 돌려받을 칸일 뿐
            if (name !== "select" || op.filters.length === 0) {
              if (name !== "select" || op.verb === "select") op.verb = name;
            }
            if (name !== "select" && name !== "delete") op.payload = args[0];
          } else if (name === "single" || name === "maybeSingle") one = true;
          else op.filters.push([name, ...args]);
        } else if (name === "single" || name === "maybeSingle") one = true;
        return b;
      };
    for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "is", "in", "lte", "gte", "or", "not", "order", "range", "limit", "single", "maybeSingle"]) b[m] = chain(m);
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: one ? ROW : list ? [ROW] : [], error: null }).then(resolve, reject);
    return b;
  };
  const client = {
    from(table: string) {
      const op: Op = { kind: "table", table, verb: "select", filters: [] };
      ops.push(op);
      return builder(op, true);
    },
    rpc(fn: string, args: Record<string, unknown> = {}) {
      const op: Op = { kind: "rpc", fn, args };
      ops.push(op);
      return builder(op, false);
    },
    storage: {
      from: () => ({
        exists: async (path: string) => (ops.push({ kind: "storage", verb: "exists", paths: [path] }), { data: true, error: null }),
        upload: async (path: string) => (ops.push({ kind: "storage", verb: "upload", paths: [path] }), { data: {}, error: null }),
        list: async (folder: string) => (ops.push({ kind: "storage", verb: "list", paths: [`${folder}/`] }), { data: [], error: null }),
        remove: async (paths: string[]) => (ops.push({ kind: "storage", verb: "remove", paths }), { data: [], error: null }),
      }),
    },
  };
  return { ops, client: client as unknown as SupabaseClient };
}

/** owner 칸이 있는 표 */
const OWNED = new Set(["ez_items", "ez_events", "ez_tasks", "ez_task_rules", "ez_places", "ez_travel", "ez_schedule_settings", "ez_roles", "ez_meets", "ez_circles"]);
/** owner 칸이 없는 딸린 표 → 부모 */
const CHILD: Record<string, string> = { ez_event_exceptions: "ez_events", ez_meet_people: "ez_meets", ez_notes: "ez_items" };
/** 부르는 DB 함수 — 전부 p_as 를 받는다 (ez_meet_link 는 주인의 권한일 때만: auth.uid() 로 본다) */
const RPCS = new Set([
  "ez_delete",
  "ez_search",
  "ez_image_srcs",
  "ez_event_split",
  "ez_event_cut",
  "ez_schedule_sync",
  "ez_task_bench",
  "ez_work_sum",
  "ez_work_start",
  "ez_work_stop",
  "ez_work_list",
  "ez_tasks_roll",
  "ez_roles_seed",
  "ez_meet_decide",
  "ez_meet_reopen",
]);

const hasOwner = (op: Extract<Op, { kind: "table" }>) => op.filters.some((f) => f[0] === "eq" && f[1] === "owner" && f[2] === ME);

/** 한 메서드가 보낸 것들을 규칙에 맞춰 본다. 틀린 것의 설명 목록 */
function problems(method: string, ops: Op[], { asUser = false } = {}): string[] {
  const bad: string[] = [];
  ops.forEach((op, i) => {
    const where = `${method} #${i + 1}`;
    if (op.kind === "rpc") {
      if (asUser && op.fn === "ez_meet_link") {
        const checked = ops.slice(0, i).some((p) => p.kind === "table" && p.table === "ez_meets" && hasOwner(p));
        if (!checked) bad.push(`${where}: ez_meet_link 앞에 내 모임인지 확인이 없습니다`);
        return;
      }
      if (!RPCS.has(op.fn)) bad.push(`${where}: 모르는 함수 ${op.fn}`);
      else if (op.args.p_as !== ME) bad.push(`${where}: ${op.fn} 에 p_as 가 없습니다`);
      return;
    }
    if (op.kind === "storage") {
      for (const p of op.paths) if (!p.startsWith(`${ME}/`)) bad.push(`${where}: 내 폴더 밖의 사진 ${p}`);
      return;
    }
    if (OWNED.has(op.table)) {
      if (op.verb === "insert" || op.verb === "upsert") {
        const rows = Array.isArray(op.payload) ? op.payload : [op.payload];
        if (!rows.every((r) => (r as { owner?: unknown } | null)?.owner === ME)) bad.push(`${where}: ${op.table} 에 owner 없이 넣습니다`);
      } else if (!hasOwner(op)) bad.push(`${where}: ${op.table} ${op.verb} 에 owner 조건이 없습니다`);
      return;
    }
    const parent = CHILD[op.table];
    if (!parent) {
      bad.push(`${where}: 모르는 표 ${op.table}`);
      return;
    }
    const checked = ops.slice(0, i).some((p) => p.kind === "table" && p.table === parent && p.verb === "select" && hasOwner(p));
    if (!checked) bad.push(`${where}: ${op.table} ${op.verb} 앞에 부모(${parent})가 내 것인지 확인이 없습니다`);
  });
  return bad;
}

type Args<T> = { [K in Exclude<keyof T, "owner">]: T[K] extends (...a: infer A) => unknown ? A : never };

const STORE_ARGS: Args<Store> = {
  folders: [],
  children: [ID],
  get: [ID],
  getReport: [ID],
  insert: [{ kind: "folder", parent_id: ID, name: "x" }],
  update: [ID, { name: "x" }, 1],
  remove: [ID],
  search: ["x", ID, 20],
  notes: [ID],
  imageExists: [`${ME}/${"a".repeat(64)}.webp`],
  uploadImage: [`${ME}/${"a".repeat(64)}.webp`, new Uint8Array([1])],
  listImages: [],
  deleteImages: [[`${ME}/${"a".repeat(64)}.webp`]],
  imageSrcs: [],
};

const EVENT = { title: "x", date: "2026-10-06", start_min: 600, end_min: 660, place_id: ID2, where_text: null, travel_min: null, note: null, repeat: null, task_id: ID2 };
const TASK = { title: "x", note: null, due: null, est_min: null, sort: 1, done_at: null };
const RULE = { kind: "cycle" as const, title: "x", note: null, est_min: null, place_id: null, checklist: [], repeat: { freq: "daily" as const }, start: "2026-10-01", event_id: null, due_after: null, last_made: null, role_id: null };

const SCHEDULE_ARGS: Args<ScheduleStore> = {
  places: [],
  travel: [],
  settings: [],
  eventsBetween: ["2026-10-05", "2026-10-11"],
  getEvent: [ID],
  eventsByIds: [[ID, ID2]],
  eventsForTasks: [[ID]],
  exceptions: [[ID]],
  insertEvent: [EVENT],
  updateEvent: [ID, { title: "y" }, 1],
  deleteEvent: [ID, 1],
  putException: [{ event_id: ID, on_date: "2026-10-13", skip: true, patch: null }],
  dropException: [ID, "2026-10-13"],
  splitEvent: [ID, 1, "2026-10-13", { title: "y" }],
  cutEvent: [ID, 1, "2026-10-13"],
  sync: ["studycube", "2026-10-05", "2026-10-11", [], null],
  tasks: [],
  getTask: [ID],
  insertTask: [TASK],
  updateTask: [ID, { title: "y" }, 1],
  deleteTask: [ID, 1],
  benchTask: [ID, true],
  workSums: [],
  workStart: [ID],
  workStop: [],
  workList: ["2026-10-01", "2026-10-07"],
  meetRef: [ID],
  rules: [],
  getRule: [ID],
  insertRule: [RULE],
  updateRule: [ID, { title: "y" }, 1],
  stopRule: [ID],
  moveRules: [ID, ID2],
  roll: ["2026-10-01", 720],
  roles: [],
  seedRoles: [],
  insertPlace: [{ name: "집", role: "home" }],
  setTravel: [ID, ID2, 30],
};

const MEET_ARGS: Args<MeetStore> = {
  circles: [],
  insertCircle: [{ name: "x", members: ["a"] }],
  updateCircle: [ID, { name: "y" }, 1],
  deleteCircle: [ID],
  meets: [],
  getMeet: [ID],
  insertMeet: [{ title: "x" }],
  updateMeet: [ID, { title: "y" }, 1],
  deleteMeet: [ID, 1],
  decide: [ID, 1, "2026-10-08", 600, 660],
  reopen: [ID, 1],
  addPeople: [ID, ["a", "b"]],
  removePeople: [ID, [ID2]],
  setAttend: [ID, ID2, "yes"],
  setMyCells: [ID, {}],
  setLink: [ID, false, 1],
};

/** 메서드마다 따로 적어 가며 부른다 */
async function audit<T extends object>(make: (c: SupabaseClient) => T, table: Record<string, unknown[]>, opts: { asUser?: boolean } = {}) {
  const out: { method: string; ops: Op[]; bad: string[] }[] = [];
  for (const [method, args] of Object.entries(table)) {
    const { ops, client } = recorder();
    await (make(client) as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
    out.push({ method, ops, bad: problems(method, ops, opts) });
  }
  return out;
}

describe("진짜 스토어의 쿼리 — 전부 내 것만", () => {
  const cases = [
    ["서랍", (c: SupabaseClient) => new SupabaseStore("", "", ME, { client: c }), STORE_ARGS],
    ["일정 · 플래너", (c: SupabaseClient) => new SupabaseScheduleStore("", "", ME, { client: c }), SCHEDULE_ARGS],
    ["모임", (c: SupabaseClient) => new SupabaseMeetStore("", "", ME, { client: c }), MEET_ARGS],
  ] as const;

  it.each(cases)("%s: 메서드마다 owner 조건 · p_as · 부모 확인이 있다", async (_name, make, table) => {
    const res = await audit(make as (c: SupabaseClient) => object, table as Record<string, unknown[]>);
    expect(res.flatMap((r) => r.bad)).toEqual([]);
    // 메서드마다 실제로 무언가 보냈다 (아무것도 안 보내서 통과한 것이 아니다)
    expect(res.filter((r) => r.ops.length === 0).map((r) => r.method)).toEqual([]);
  });

  it("모임: 링크 켜기 · 주인의 권한(가)일 때도", async () => {
    const on = await audit((c) => new SupabaseMeetStore("", "", ME, { client: c }), { setLink: [ID, true, 1] });
    expect(on.flatMap((r) => r.bad)).toEqual([]);
    const user = await audit((c) => new SupabaseMeetStore("", "", ME, { client: c, asUser: true }), MEET_ARGS, { asUser: true });
    expect(user.flatMap((r) => r.bad)).toEqual([]);
    const link = user.find((r) => r.method === "setLink")!;
    expect(link.ops.some((o) => o.kind === "rpc" && o.fn === "ez_meet_link")).toBe(true);
    // 주인의 권한으로는 열쇠 칸을 직접 고치지 않는다
    expect(link.ops.some((o) => o.kind === "table" && o.verb === "update")).toBe(false);
  });

  it("사진: 내 폴더 밖의 경로는 저장소에 닿기 전에 거절한다", async () => {
    const other = `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/${"a".repeat(64)}.webp`;
    for (const [method, args] of [
      ["imageExists", [other]],
      ["uploadImage", [other, new Uint8Array([1])]],
      ["deleteImages", [[`${ME}/${"a".repeat(64)}.webp`, other]]],
    ] as const) {
      const { ops, client } = recorder();
      const store = new SupabaseStore("", "", ME, { client }) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      await expect(store[method]!(...args)).rejects.toThrow(/주인 폴더 밖/);
      expect(ops, method).toEqual([]);
    }
  });

  it("이 시험이 실제로 잡는다: owner 조건이 빠진 쿼리 · p_as 없는 함수 · 확인 없는 딸린 표", () => {
    const t = (table: string, verb: "select" | "update" | "insert", filters: Filter[] = [], payload?: unknown): Op => ({ kind: "table", table, verb, filters, payload });
    expect(problems("x", [t("ez_items", "select", [["eq", "id", ID]])])).toHaveLength(1);
    expect(problems("x", [t("ez_items", "select", [["eq", "owner", ID2]])])).toHaveLength(1);
    expect(problems("x", [t("ez_items", "update", [["eq", "id", ID]], { name: "y" })])).toHaveLength(1);
    expect(problems("x", [t("ez_events", "insert", [], { title: "y" })])).toHaveLength(1);
    expect(problems("x", [t("ez_meet_people", "update", [["eq", "meet_id", ID]], { attend: "yes" })])).toHaveLength(1);
    expect(problems("x", [{ kind: "rpc", fn: "ez_delete", args: { p_id: ID } }])).toHaveLength(1);
    expect(problems("x", [{ kind: "rpc", fn: "ez_me", args: {} }])).toHaveLength(1);
    expect(problems("x", [t("kv", "select", [["eq", "owner", ME]])])).toHaveLength(1);
    expect(problems("x", [t("ez_meets", "select", [["eq", "owner", ME]]), t("ez_meet_people", "update", [["eq", "meet_id", ID]], { attend: "yes" })])).toEqual([]);
  });
});
