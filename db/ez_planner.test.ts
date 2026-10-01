// 0007 (플래너 v2: 할 일의 지점 · 일정에 딸린 마감 · 체크 항목, 반복 규칙 ez_task_rules, ez_tasks_roll)을 PGlite 에서 돌려 본다.
// Supabase 흉내는 db/testing.ts. 날짜: 2026-10-05 가 월요일.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { migrations, SUPABASE_STUB } from "./testing";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const m of migrations()) await db.exec(m);
}, 60_000);

type Row = Record<string, any>;

/** 사용자 id · "anon" · "service"(service_role, MCP) · "admin"(postgres) 으로 한 문장 */
async function sql(who: string, text: string, params: unknown[] = []): Promise<Row[]> {
  await db.exec("reset role");
  const sub = who === "anon" || who === "admin" || who === "service" ? "" : who;
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub]);
  if (who === "anon") await db.exec("set role anon");
  else if (who === "service") await db.exec("set role service_role");
  else if (who !== "admin") await db.exec("set role authenticated");
  try {
    return (await db.query<Row>(text, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

async function one(who: string, text: string, params: unknown[] = []): Promise<Row> {
  const rows = await sql(who, text, params);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** 실패해야 한다. code 가 EZ_ 로 시작하면 P0001 + '[EZ_…] ' 메시지, 아니면 SQLSTATE */
async function fails(p: Promise<unknown>, code: string): Promise<any> {
  const e: any = await p.then(
    () => null,
    (err) => err,
  );
  expect(e, `${code} 로 실패해야 합니다`).not.toBeNull();
  if (code.startsWith("EZ_")) {
    expect(e.code, e.message).toBe("P0001");
    expect(e.message).toMatch(new RegExp(`^\\[${code}\\] \\S`));
  } else expect(e.code, e.message).toBe(code);
  return e;
}

const user = () => randomUUID();
const val = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

async function ins(who: string, table: string, obj: Record<string, unknown>): Promise<Row> {
  const keys = Object.keys(obj);
  return one(
    who,
    `insert into ${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    keys.map((k) => val(obj[k])),
  );
}

const TASK_COLS =
  "id, owner, title, note, due::text as due, est_min, sort, done_at, place_id, due_event_id, checklist, rule_id, rule_date::text as rule_date, version, deleted_at";
const RULE_COLS =
  "id, owner, kind, title, note, est_min, place_id, checklist, repeat, start::text as start, event_id, due_after, last_made::text as last_made, version, deleted_at";

async function place(who: string, name: string): Promise<string> {
  return (await ins(who, "ez_places", { name })).id;
}
async function event(who: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await ins(who, "ez_events", { title: "일정", date: "2026-10-05", start_min: 540, end_min: 600, ...extra })).id;
}
async function task(who: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await ins(who, "ez_tasks", { title: "할 일", ...extra })).id;
}
const WEEKLY_MON = { freq: "weekly", days: [1] };
/** 주기 규칙 (기본: 매주 월요일, 2026-10-05 부터) */
async function cycle(who: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await ins(who, "ez_task_rules", { kind: "cycle", title: "주간 숙제", repeat: WEEKLY_MON, start: "2026-10-05", ...extra })).id;
}
/** 일정에 딸린 규칙 */
async function after(who: string, event_id: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await ins(who, "ez_task_rules", { kind: "event", title: "내용 정리", event_id, ...extra })).id;
}

const tk = (id: string) => one("admin", `select ${TASK_COLS} from ez_tasks where id = $1`, [id]);
const rule = (id: string) => one("admin", `select ${RULE_COLS} from ez_task_rules where id = $1`, [id]);
/** 그 규칙에서 생긴 할 일, 회차 순 */
const made = (ruleId: string) => sql("admin", `select ${TASK_COLS} from ez_tasks where rule_id = $1 order by rule_date`, [ruleId]);
const alive = async (ruleId: string) => (await made(ruleId)).filter((t) => t.deleted_at === null).map((t) => t.rule_date);
const roll = (who: string, today: string | null, now: number | null, as: string | null = null) =>
  one(who, "select ez_tasks_roll($1, $2, $3) n", [today, now, as]).then((r) => r.n as number);
const addEx = (who: string, id: string, on: string, patch: unknown = null) =>
  sql(who, "insert into ez_event_exceptions (event_id, on_date, skip, patch) values ($1, $2, $3, $4)", [id, on, patch === null, val(patch)]);
const softDelete = (who: string, table: string, id: string) => sql(who, `update ${table} set deleted_at = now() where id = $1`, [id]);

// ---------------------------------------------------------------------------

describe("권한 · RLS", () => {
  it("anon 은 규칙 표를 읽기 · 쓰기 못 하고 함수도 못 부른다", async () => {
    await fails(sql("anon", "select * from ez_task_rules"), "42501");
    await fails(sql("anon", "insert into ez_task_rules (owner, kind, title, repeat, start) values ($1, 'cycle', 'x', '{\"freq\":\"daily\"}', '2026-10-05')", [user()]), "42501");
    await fails(sql("anon", "select ez_tasks_roll('2026-10-05', 0)"), "42501");
    await fails(sql("anon", "select ez_tasks_roll('2026-10-05', 0, $1)", [user()]), "42501");
    await fails(sql("anon", "select ez_checklist_ok('[]')"), "42501");
    await fails(sql("anon", "select ez_check_texts_ok('[]')"), "42501");
  });

  it("남의 규칙은 안 보이고 못 고친다. 남의 주인으로 못 넣는다", async () => {
    const a = user();
    const b = user();
    const r = await cycle(a);
    expect(await sql(b, "select * from ez_task_rules")).toHaveLength(0);
    expect(await sql(a, "select * from ez_task_rules")).toHaveLength(1);
    expect(await sql(b, "update ez_task_rules set title = '뺏음' where id = $1 returning id", [r])).toHaveLength(0);
    await fails(sql(b, "insert into ez_task_rules (owner, kind, title, repeat, start) values ($1, 'cycle', '침범', '{\"freq\":\"daily\"}', '2026-10-05')", [a]), "42501");
    expect((await rule(r)).title).toBe("주간 숙제");
  });

  it("규칙도 authenticated 는 행을 지울 수 없다 (멈추기 = deleted_at). service_role 은 owner 를 적어 쓴다", async () => {
    const a = user();
    const r = await cycle(a);
    await fails(sql(a, "delete from ez_task_rules where id = $1", [r]), "42501");
    await softDelete(a, "ez_task_rules", r);
    expect((await rule(r)).deleted_at).not.toBeNull();
    await fails(sql("service", "insert into ez_task_rules (kind, title, repeat, start) values ('cycle', 'x', '{\"freq\":\"daily\"}', '2026-10-05')"), "23502");
    const s = await ins("service", "ez_task_rules", { owner: a, kind: "cycle", title: "대리", repeat: { freq: "daily" }, start: "2026-10-05" });
    expect(s.owner).toBe(a);
  });
});

describe("ez_tasks 새 열", () => {
  it("체크 항목: [{t, done}] 0~20개, t 는 trim 된 1~100자, 다른 키 없음", async () => {
    const a = user();
    expect((await tk(await task(a))).checklist).toEqual([]);
    const item = (t: string, done = false) => ({ t, done });
    const ok = [[], [item("하나"), item("둘", true)], Array.from({ length: 20 }, (_, i) => item(`항목 ${i}`)), [item("가".repeat(100))]];
    for (const checklist of ok) expect((await tk(await task(a, { checklist }))).checklist).toEqual(checklist);
    const bad = [
      Array.from({ length: 21 }, (_, i) => item(`항목 ${i}`)),
      [item("가".repeat(101))],
      [item("")],
      [item(" 앞")],
      [item("뒤 ")],
      [{ t: "done 없음" }],
      [{ done: false }],
      [{ t: "x", done: "false" }],
      [{ t: "x", done: null }],
      [{ t: 1, done: false }],
      [{ t: "x", done: false, note: "덤" }],
      ["글자만"],
      [null],
      { t: "x", done: false },
      '"글자"',
      "3",
    ];
    for (const checklist of bad) await fails(task(a, { checklist }), "23514");
    await fails(sql(a, "insert into ez_tasks (title, checklist) values ('x', 'null'::jsonb)"), "23514");
    await fails(sql(a, "insert into ez_tasks (title, checklist) values ('x', null)"), "23502");
    // 고칠 때도 같다. 체크하면 버전이 오른다
    const id = await task(a, { checklist: [item("하나")] });
    await sql(a, "update ez_tasks set checklist = $2 where id = $1", [id, val([item("하나", true)])]);
    expect((await tk(id)).version).toBe(2);
    await fails(sql(a, "update ez_tasks set checklist = $2 where id = $1", [id, val([{ t: "" }])]), "23514");
  });

  it("rule_id · rule_date 는 둘 다 있거나 둘 다 없거나. 같은 (규칙, 회차)는 지운 것까지 쳐서 하나", async () => {
    const a = user();
    const r = await cycle(a);
    await fails(task(a, { rule_id: r }), "23514");
    await fails(task(a, { rule_date: "2026-10-05" }), "23514");
    const t = await task(a, { rule_id: r, rule_date: "2026-10-05" });
    await task(a, { rule_id: r, rule_date: "2026-10-06" }); // 회차가 아닌 날도 된다 (첫 회차는 만든 날일 수 있다)
    await fails(task(a, { rule_id: r, rule_date: "2026-10-05" }), "23505");
    await softDelete(a, "ez_tasks", t);
    await fails(task(a, { rule_id: r, rule_date: "2026-10-05" }), "23505");
    // 규칙 없는 할 일은 얼마든지
    await task(a);
    await task(a);
  });

  it("지점 · 일정 · 규칙은 같은 주인 것만", async () => {
    const a = user();
    const b = user();
    await fails(task(a, { place_id: await place(b, "남의 집") }), "23503");
    await fails(task(a, { place_id: randomUUID() }), "23503");
    await fails(task(a, { due_event_id: await event(b) }), "23503");
    await fails(task(a, { due_event_id: randomUUID(), due: "2026-10-05" }), "23503");
    await fails(task(a, { rule_id: await cycle(b), rule_date: "2026-10-05" }), "23503");
    await fails(task(a, { rule_id: randomUUID(), rule_date: "2026-10-05" }), "23503");
    const t = await task(a);
    await fails(sql(a, "update ez_tasks set place_id = $2 where id = $1", [t, await place(b, "남의 회사")]), "23503");
    await fails(sql("service", "update ez_tasks set due_event_id = $2 where id = $1", [t, await event(b)]), "23503");
    // 규칙도: 남의 지점 · 남의 일정
    await fails(cycle(a, { place_id: await place(b, "남의 학교") }), "23503");
    await fails(after(a, await event(b, { repeat: { freq: "daily" } })), "23503");
  });

  it("지운 지점도 가리킬 수 있고, 지점 행이 정말 지워지면 그 칸만 비워진다", async () => {
    const a = user();
    const p = await place(a, "도서관");
    await softDelete(a, "ez_places", p);
    const t = await task(a, { place_id: p });
    const r = await cycle(a, { place_id: p });
    expect((await tk(t)).place_id).toBe(p);
    await sql("service", "delete from ez_places where id = $1", [p]);
    expect((await tk(t)).place_id).toBeNull();
    expect((await rule(r)).place_id).toBeNull();
  });

  it("규칙 행이 정말 지워지면 할 일은 남고 rule_id · rule_date 가 같이 비워진다", async () => {
    const a = user();
    const r = await cycle(a);
    const t = await task(a, { rule_id: r, rule_date: "2026-10-05" });
    await sql("service", "delete from ez_task_rules where id = $1", [r]);
    const now = await tk(t);
    expect([now.rule_id, now.rule_date, now.deleted_at]).toEqual([null, null, null]);
  });
});

describe("일정에 딸린 마감", () => {
  it("반복 아닌 일정: 마감이 일정 날짜로 채워지고, 일정 날짜가 바뀌면 따라간다", async () => {
    const a = user();
    const e = await event(a, { title: "결혼식", date: "2026-10-11" });
    const t = await task(a, { due_event_id: e });
    expect((await tk(t)).due).toBe("2026-10-11");
    const t2 = await task(a, { due_event_id: e, due: "2026-10-01" }); // 다른 날을 적어도 일정 날짜
    expect((await tk(t2)).due).toBe("2026-10-11");
    const gone = await task(a, { due_event_id: e });
    await softDelete(a, "ez_tasks", gone);
    const other = await task(a, { due: "2026-10-11" });

    await sql(a, "update ez_events set date = '2026-10-18' where id = $1", [e]);
    expect([(await tk(t)).due, (await tk(t)).version]).toEqual(["2026-10-18", 2]);
    expect((await tk(t2)).due).toBe("2026-10-18");
    expect((await tk(gone)).due).toBe("2026-10-11"); // 지운 할 일은 그대로
    expect((await tk(other)).due).toBe("2026-10-11"); // 안 딸린 할 일은 그대로
    // 날짜 말고 다른 칸이 바뀌면 그대로
    await sql(a, "update ez_events set title = '송현이 누나 결혼식' where id = $1", [e]);
    expect((await tk(t)).version).toBe(2);
  });

  it("있던 할 일에 일정을 걸거나 다른 일정으로 바꾸면 그 일정 날짜가 된다. 건 채로 날짜만 바꿀 수는 없다", async () => {
    const a = user();
    const e1 = await event(a, { date: "2026-10-11" });
    const e2 = await event(a, { date: "2026-10-20" });
    const t = await task(a, { due: "2026-10-07" });
    await sql(a, "update ez_tasks set due_event_id = $2 where id = $1", [t, e1]);
    expect((await tk(t)).due).toBe("2026-10-11");
    await sql(a, "update ez_tasks set due_event_id = $2 where id = $1", [t, e2]);
    expect((await tk(t)).due).toBe("2026-10-20");
    const err = await fails(sql(a, "update ez_tasks set due = '2026-10-21' where id = $1", [t]), "EZ_VALUE");
    expect(err.message).toContain("due_event_id");
    await fails(sql(a, "update ez_tasks set due = null where id = $1", [t]), "EZ_VALUE");
    // 다른 칸은 그대로 고친다
    await sql(a, "update ez_tasks set title = '선물 사기', done_at = now() where id = $1", [t]);
    // 연결을 비우면 날짜는 마음대로
    await sql(a, "update ez_tasks set due_event_id = null, due = '2026-10-21' where id = $1", [t]);
    const now = await tk(t);
    expect([now.due_event_id, now.due]).toEqual([null, "2026-10-21"]);
  });

  it("일정을 지우면 연결만 끊기고 날짜는 남는다. 지운 일정에는 못 건다", async () => {
    const a = user();
    const e = await event(a, { date: "2026-10-11" });
    const t = await task(a, { due_event_id: e });
    const dead = await task(a, { due_event_id: e });
    await softDelete(a, "ez_tasks", dead);
    await softDelete(a, "ez_events", e);
    for (const id of [t, dead]) {
      const now = await tk(id);
      expect([now.due_event_id, now.due]).toEqual([null, "2026-10-11"]);
    }
    const err = await fails(task(a, { due_event_id: e }), "EZ_EVENT");
    expect(err.message).toBe("[EZ_EVENT] 지운 일정에는 마감을 걸 수 없습니다");
    await fails(sql(a, "update ez_tasks set due_event_id = $2 where id = $1", [t, e]), "EZ_EVENT");
    // 되살린 일정의 날짜를 바꿔도 끊긴 할 일은 안 따라간다
    await sql(a, "update ez_events set deleted_at = null where id = $1", [e]);
    await sql(a, "update ez_events set date = '2026-10-30' where id = $1", [e]);
    expect((await tk(t)).due).toBe("2026-10-11");
  });

  it("일정 행이 정말 지워지면 due_event_id 만 비워진다", async () => {
    const a = user();
    const e = await event(a, { date: "2026-10-11" });
    const t = await task(a, { due_event_id: e });
    await sql("service", "delete from ez_events where id = $1", [e]);
    const now = await tk(t);
    expect([now.due_event_id, now.due]).toEqual([null, "2026-10-11"]);
  });

  it("반복 일정: due 가 있어야 하고 그 일정의 회차여야 한다. 일정 날짜가 바뀌어도 안 따라간다", async () => {
    const a = user();
    const e = await event(a, { repeat: { freq: "weekly", days: [1, 3], until: "2026-10-28" } });
    const err = await fails(task(a, { due_event_id: e }), "EZ_VALUE");
    expect(err.message).toContain("due");
    expect((await fails(task(a, { due_event_id: e, due: "2026-10-06" }), "EZ_DATE")).message).toContain("2026-10-06");
    await fails(task(a, { due_event_id: e, due: "2026-11-02" }), "EZ_DATE"); // until 뒤
    const t = await task(a, { due_event_id: e, due: "2026-10-14" });
    expect((await tk(t)).due).toBe("2026-10-14");
    await sql(a, "update ez_tasks set due = '2026-10-19' where id = $1", [t]); // 다른 회차로
    await fails(sql(a, "update ez_tasks set due = '2026-10-20' where id = $1", [t]), "EZ_DATE");
    await fails(sql(a, "update ez_tasks set due = null where id = $1", [t]), "EZ_VALUE");
    await sql(a, "update ez_events set date = '2026-10-07' where id = $1", [e]);
    expect((await tk(t)).due).toBe("2026-10-19");
    // 있던 할 일에 걸 때: due 가 회차면 된다
    const t2 = await task(a, { due: "2026-10-21" });
    await sql(a, "update ez_tasks set due_event_id = $2 where id = $1", [t2, e]);
    const t3 = await task(a);
    await fails(sql(a, "update ez_tasks set due_event_id = $2 where id = $1", [t3, e]), "EZ_VALUE");
  });

  it("service_role 이 일정을 고쳐도, 바깥 일정이 sync 로 옮겨져도 따라간다", async () => {
    const a = user();
    const e = await event(a, { date: "2026-10-11" });
    const t = await task(a, { due_event_id: e });
    await sql("service", "update ez_events set date = '2026-10-12' where id = $1", [e]);
    expect((await tk(t)).due).toBe("2026-10-12");

    const sync = (events: unknown[]) =>
      sql(a, "select ez_schedule_sync('univ', '2026-10-01', '2026-10-31', $1)", [JSON.stringify(events)]);
    await sync([{ external_id: "exam", title: "시험", date: "2026-10-20" }]);
    const x = (await one(a, "select id from ez_events where source = 'univ'")).id;
    const u = await task(a, { title: "시험 공부", due_event_id: x });
    await sync([{ external_id: "exam", title: "시험", date: "2026-10-22" }]);
    expect((await tk(u)).due).toBe("2026-10-22");
    await sync([]); // 바깥 일정이 사라지면 연결만 끊긴다
    const now = await tk(u);
    expect([now.due_event_id, now.due]).toEqual([null, "2026-10-22"]);
  });
});

describe("ez_task_rules 제약", () => {
  it("칸 범위: 제목 1~200 trim, 메모 2000자, 걸릴 시간 5~600, 마감까지 0~60일, kind", async () => {
    const a = user();
    await cycle(a, { title: "가".repeat(200), note: "나".repeat(2000), est_min: 5, due_after: 0 });
    await cycle(a, { est_min: 600, due_after: 60 });
    for (const extra of [
      { title: "가".repeat(201) },
      { title: "" },
      { title: " 앞" },
      { note: "나".repeat(2001) },
      { est_min: 4 },
      { est_min: 601 },
      { due_after: -1 },
      { due_after: 61 },
      { kind: "weekly" },
    ])
      await fails(cycle(a, extra), "23514");
  });

  it("체크 항목은 글자 배열 0~20개, 각 trim 된 1~100자", async () => {
    const a = user();
    expect((await rule(await cycle(a))).checklist).toEqual([]);
    await cycle(a, { checklist: Array.from({ length: 20 }, (_, i) => `항목 ${i}`) });
    await cycle(a, { checklist: ["가".repeat(100)] });
    for (const checklist of [
      Array.from({ length: 21 }, (_, i) => `항목 ${i}`),
      ["가".repeat(101)],
      [""],
      [" 앞"],
      [{ t: "x", done: false }],
      [1],
      { 0: "x" },
      '"글자"',
    ])
      await fails(cycle(a, { checklist }), "23514");
  });

  it("cycle: 반복 · 시작 필수, 일정 없음. 반복 모양은 일정과 같고 until 은 못 쓴다", async () => {
    const a = user();
    const e = await event(a, { repeat: { freq: "daily" } });
    await cycle(a, { repeat: { freq: "daily" } });
    await cycle(a, { repeat: { freq: "weekly", days: [1, 3, 7] }, start: "2026-10-06" });
    await fails(cycle(a, { repeat: null }), "23514");
    await fails(cycle(a, { start: null }), "23514");
    await fails(cycle(a, { event_id: e }), "23514");
    const err = await fails(cycle(a, { repeat: { freq: "daily", until: "2026-12-31" } }), "EZ_VALUE");
    expect(err.message).toContain("until");
    await fails(cycle(a, { repeat: { freq: "weekly", days: [1], until: null } }), "EZ_VALUE");
    for (const repeat of [{ freq: "monthly" }, { freq: "weekly" }, { freq: "weekly", days: [] }, { freq: "weekly", days: [8] }, { freq: "weekly", days: [1, 1] }, [1], '"daily"'])
      await fails(cycle(a, { repeat }), "EZ_VALUE");
    // 고칠 때도
    const r = await cycle(a);
    await fails(sql(a, "update ez_task_rules set repeat = $2 where id = $1", [r, val({ freq: "daily", until: "2027-01-01" })]), "EZ_VALUE");
    await sql(a, "update ez_task_rules set repeat = $2 where id = $1", [r, val({ freq: "daily" })]);
    expect((await rule(r)).version).toBe(2);
  });

  it("event: 살아 있는 반복 일정 필수, 반복 · 시작 없음. 바깥 일정도 된다", async () => {
    const a = user();
    const e = await event(a, { repeat: { freq: "weekly", days: [1] } });
    const r = await after(a, e);
    expect([(await rule(r)).kind, (await rule(r)).event_id]).toEqual(["event", e]);
    await fails(ins(a, "ez_task_rules", { kind: "event", title: "일정 없음" }), "23514");
    await fails(after(a, e, { repeat: { freq: "daily" } }), "23514");
    await fails(after(a, e, { start: "2026-10-05" }), "23514");
    await fails(after(a, randomUUID()), "23503");

    const single = await event(a);
    expect((await fails(after(a, single), "EZ_REPEAT")).message).toContain("반복 일정");
    const dead = await event(a, { repeat: { freq: "daily" } });
    await softDelete(a, "ez_events", dead);
    await fails(after(a, dead), "EZ_NOT_FOUND");
    await fails(sql(a, "update ez_task_rules set event_id = $2 where id = $1", [r, single]), "EZ_REPEAT");
    await fails(sql(a, "update ez_task_rules set event_id = $2 where id = $1", [r, dead]), "EZ_NOT_FOUND");

    await sql(a, "select ez_schedule_sync('univ', '2026-09-01', '2026-12-31', $1)", [
      JSON.stringify([{ external_id: "law", title: "상법", date: "2026-09-01", start_min: 540, end_min: 630, repeat: { freq: "weekly", days: [2] } }]),
    ]);
    const ext = (await one(a, "select id from ez_events where source = 'univ'")).id;
    await after(a, ext, { title: "상법 내용 정리" });
  });

  it("version: 넣을 때 1, 바뀌면 +1, 주인은 못 바꾼다", async () => {
    const a = user();
    const r = await ins(a, "ez_task_rules", { kind: "cycle", title: "v", repeat: { freq: "daily" }, start: "2026-10-05", version: 9 });
    expect(r.version).toBe(1);
    await sql(a, "update ez_task_rules set title = 'v2' where id = $1", [r.id]);
    await sql(a, "update ez_task_rules set title = 'v2' where id = $1", [r.id]);
    expect((await rule(r.id)).version).toBe(2);
    expect(await sql(a, "update ez_task_rules set title = '낡음' where id = $1 and version = 1 returning id", [r.id])).toHaveLength(0);
    await fails(sql("service", "update ez_task_rules set owner = $2 where id = $1", [r.id, user()]), "EZ_FIXED");
  });

  it("일정을 지우거나 반복이 아니게 되면 딸린 규칙이 멈춘다. 되살리려면 일정이 살아 있는 반복이어야 한다", async () => {
    const a = user();
    const e1 = await event(a, { repeat: { freq: "daily" } });
    const e2 = await event(a, { repeat: { freq: "daily" } });
    const keep = await event(a, { repeat: { freq: "daily" } });
    const r1 = await after(a, e1);
    const r2 = await after(a, e2);
    const r3 = await after(a, keep);
    await softDelete(a, "ez_events", e1);
    await sql(a, "update ez_events set repeat = null where id = $1", [e2]);
    await sql(a, "update ez_events set title = '이름만', repeat = '{\"freq\":\"weekly\",\"days\":[2]}' where id = $1", [keep]);
    expect((await rule(r1)).deleted_at).not.toBeNull();
    expect((await rule(r2)).deleted_at).not.toBeNull();
    expect((await rule(r3)).deleted_at).toBeNull();
    await fails(sql(a, "update ez_task_rules set deleted_at = null where id = $1", [r1]), "EZ_NOT_FOUND");
    await fails(sql(a, "update ez_task_rules set deleted_at = null where id = $1", [r2]), "EZ_REPEAT");
    // 멈춘 규칙의 다른 칸은 고칠 수 있다
    await sql(a, "update ez_task_rules set title = '멈춘 채로' where id = $1", [r1]);
    // ez_event_cut 으로 첫 회차부터 지워도 멈춘다
    const r4 = await after(a, keep, { title: "또 하나" });
    await sql(a, "select ez_event_cut($1, 2, '2026-10-06')", [keep]);
    expect((await rule(r3)).deleted_at).not.toBeNull();
    expect((await rule(r4)).deleted_at).not.toBeNull();
  });

  it("일정 행이 정말 지워지면 규칙도 지워지고, 생겼던 할 일은 남는다", async () => {
    const a = user();
    const e = await event(a, { repeat: { freq: "daily" } });
    const r = await after(a, e);
    expect(await roll(a, "2026-10-06", 0)).toBe(1);
    const [t] = await made(r);
    await sql("service", "delete from ez_events where id = $1", [e]);
    expect(await sql("admin", "select id from ez_task_rules where id = $1", [r])).toHaveLength(0);
    const now = await tk(t!.id);
    expect([now.rule_id, now.rule_date, now.deleted_at]).toEqual([null, null, null]);
  });
});

describe("ez_tasks_roll — 주기 규칙", () => {
  it("회차가 되면 하나 만든다. 같은 날 두 번 불러도 하나", async () => {
    const a = user();
    const p = await place(a, "도서관");
    const r = await cycle(a, { note: "3장까지", est_min: 90, place_id: p, checklist: ["읽기", "문제 풀기"], due_after: 6 });
    expect(await roll(a, "2026-10-04", 720)).toBe(0); // 시작 전
    expect((await rule(r)).last_made).toBeNull();
    expect(await roll(a, "2026-10-05", 0)).toBe(1);
    expect(await roll(a, "2026-10-05", 0)).toBe(0);
    expect(await roll(a, "2026-10-05", 1439)).toBe(0);
    expect(await roll(a, "2026-10-11", 1439)).toBe(0); // 다음 월요일 전
    const rows = await made(r);
    expect(rows).toHaveLength(1);
    const t = rows[0]!;
    expect([t.owner, t.title, t.note, t.est_min, t.place_id, t.due, t.rule_date, t.version, t.done_at, t.deleted_at]).toEqual([
      a, "주간 숙제", "3장까지", 90, p, "2026-10-11", "2026-10-05", 1, null, null,
    ]);
    expect(t.checklist).toEqual([
      { t: "읽기", done: false },
      { t: "문제 풀기", done: false },
    ]);
    expect((await rule(r)).last_made).toBe("2026-10-05");
    expect(await sql(a, "select id from ez_tasks")).toHaveLength(1); // 내 눈에도 보인다
  });

  it("3주 밀려도 가장 최근 회차 하나만. 안 끝낸 지난 회차는 지워지고 끝낸 것은 남는다", async () => {
    const a = user();
    const r = await cycle(a);
    expect(await roll(a, "2026-10-05", 600)).toBe(1);
    expect(await roll(a, "2026-10-28", 600)).toBe(1); // 10/12 · 10/19 · 10/26 중 10/26 만
    expect((await made(r)).map((t) => [t.rule_date, t.deleted_at === null])).toEqual([
      ["2026-10-05", false],
      ["2026-10-26", true],
    ]);
    expect((await rule(r)).last_made).toBe("2026-10-26");

    // 이번 것을 끝내면 다음 회차가 생겨도 남는다
    await sql(a, "update ez_tasks set done_at = now() where rule_id = $1 and rule_date = '2026-10-26'", [r]);
    expect(await roll(a, "2026-11-02", 0)).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-26", "2026-11-02"]);
    // 안 끝낸 채 또 밀리면 한 건만 남는다
    expect(await roll(a, "2026-11-10", 0)).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-26", "2026-11-09"]);
    expect(await made(r)).toHaveLength(4);
  });

  it("마감까지 며칠이 없으면 마감 없음, 체크 항목이 없으면 빈 배열. 매일 규칙", async () => {
    const a = user();
    const r = await cycle(a, { title: "스트레칭", repeat: { freq: "daily" }, due_after: 0 });
    const r2 = await cycle(a, { title: "마감 없음", repeat: { freq: "daily" } });
    expect(await roll(a, "2026-10-07", 0)).toBe(2);
    const [t] = await made(r);
    expect([t!.rule_date, t!.due, t!.checklist, t!.note, t!.est_min, t!.place_id]).toEqual(["2026-10-07", "2026-10-07", [], null, null, null]);
    expect((await made(r2))[0]!.due).toBeNull();
    expect(await roll(a, "2026-10-08", 0)).toBe(2);
    expect(await alive(r)).toEqual(["2026-10-08"]);
  });

  it("새 할 일은 맨 위 (살아 있는 할 일의 가장 작은 sort - 1)", async () => {
    const a = user();
    await task(a, { sort: 3 });
    await task(a, { sort: -2.5, done_at: "2026-10-01T00:00:00Z" });
    await softDelete(a, "ez_tasks", await task(a, { sort: -100 }));
    await task(user(), { sort: -50 });
    const r1 = await cycle(a);
    const r2 = await cycle(a, { title: "둘째" });
    expect(await roll(a, "2026-10-05", 0)).toBe(2);
    // 규칙이 둘이면 차례로 맨 위에 쌓인다 (같은 순간에 만든 규칙끼리의 차례는 정해져 있지 않다)
    expect([(await made(r1))[0]!.sort, (await made(r2))[0]!.sort].sort((x, y) => x - y)).toEqual([-4.5, -3.5]);
    // 할 일이 하나도 없으면 0
    const b = user();
    const r3 = await cycle(b);
    await roll(b, "2026-10-05", 0);
    expect((await made(r3))[0]!.sort).toBe(0);
  });

  it("있던 할 일을 첫 회차로 삼기: rule_id · rule_date 를 붙이고 last_made 를 넣으면 다음 회차부터 만든다", async () => {
    const a = user();
    const t = await task(a, { title: "주간 숙제" });
    const r = await cycle(a, { last_made: "2026-10-03" }); // 토요일에 만듦 — 회차가 아닌 날
    await sql(a, "update ez_tasks set rule_id = $2, rule_date = '2026-10-03' where id = $1", [t, r]);
    expect(await roll(a, "2026-10-04", 0)).toBe(0);
    expect(await roll(a, "2026-10-05", 0)).toBe(1);
    expect((await tk(t)).deleted_at).not.toBeNull(); // 안 끝낸 첫 회차는 밀려서 지워진다
    expect(await alive(r)).toEqual(["2026-10-05"]);

    // last_made 를 안 넣었어도 같은 회차를 두 번 만들지는 않는다
    const b = user();
    const t2 = await task(b);
    const r2 = await cycle(b);
    await sql(b, "update ez_tasks set rule_id = $2, rule_date = '2026-10-05' where id = $1", [t2, r2]);
    expect(await roll(b, "2026-10-05", 0)).toBe(0);
    expect((await rule(r2)).last_made).toBe("2026-10-05");
    expect(await alive(r2)).toEqual(["2026-10-05"]);
    // 그 회차를 지웠어도 다시 만들지 않는다
    const c = user();
    const r3 = await cycle(c);
    await roll(c, "2026-10-05", 0);
    await sql(c, "update ez_tasks set deleted_at = now() where rule_id = $1", [r3]);
    await sql(c, "update ez_task_rules set last_made = null where id = $1", [r3]);
    expect(await roll(c, "2026-10-06", 0)).toBe(0);
    expect(await made(r3)).toHaveLength(1);
  });

  it("멈춘 규칙은 안 만든다. 이미 생긴 할 일은 남는다", async () => {
    const a = user();
    const r = await cycle(a);
    await roll(a, "2026-10-05", 0);
    await softDelete(a, "ez_task_rules", r);
    expect(await roll(a, "2026-10-12", 0)).toBe(0);
    expect(await alive(r)).toEqual(["2026-10-05"]);
    const stopped = await cycle(a, { deleted_at: "2026-10-01T00:00:00Z" });
    expect(await roll(a, "2026-10-19", 0)).toBe(0);
    expect(await made(stopped)).toHaveLength(0);
  });

  it("60일 넘게 안 열었어도 최근 60일 안의 가장 늦은 회차 하나만", async () => {
    const a = user();
    const daily = await cycle(a, { repeat: { freq: "daily" }, start: "2026-01-01" });
    const weekly = await cycle(a, { start: "2026-01-05", last_made: "2026-03-02" });
    const old = await task(a, { rule_id: weekly, rule_date: "2026-03-02" });
    expect(await roll(a, "2026-10-07", 0)).toBe(2);
    expect(await alive(daily)).toEqual(["2026-10-07"]);
    expect(await alive(weekly)).toEqual(["2026-10-05"]);
    expect((await tk(old)).deleted_at).not.toBeNull();
    expect(await sql("admin", "select id from ez_tasks where owner = $1", [a])).toHaveLength(3);
  });
});

describe("ez_tasks_roll — 일정에 딸린 규칙", () => {
  it("끝 시각 전에는 안 만들고 지나면 만든다", async () => {
    const a = user();
    const e = await event(a, { title: "상법", repeat: WEEKLY_MON }); // 월 09:00~10:00
    const r = await after(a, e, { due_after: 2, checklist: ["판례 정리"] });
    expect(await roll(a, "2026-10-04", 1439)).toBe(0);
    expect(await roll(a, "2026-10-05", 599)).toBe(0);
    expect((await rule(r)).last_made).toBeNull();
    expect(await roll(a, "2026-10-05", 600)).toBe(1);
    expect(await roll(a, "2026-10-05", 601)).toBe(0);
    const [t] = await made(r);
    expect([t!.title, t!.rule_date, t!.due, t!.checklist]).toEqual(["내용 정리", "2026-10-05", "2026-10-07", [{ t: "판례 정리", done: false }]]);
    // 다음 주: 수업 전에는 지난 것이 그대로, 끝나면 갈아끼운다
    expect(await roll(a, "2026-10-12", 300)).toBe(0);
    expect(await alive(r)).toEqual(["2026-10-05"]);
    expect(await roll(a, "2026-10-12", 1000)).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-12"]);
  });

  it("어제 회차는 시각과 상관없이 만든다. 아직 안 끝난 오늘 회차 대신 그 전 회차", async () => {
    const a = user();
    const e = await event(a, { repeat: WEEKLY_MON });
    const r = await after(a, e);
    expect(await roll(a, "2026-10-06", 0)).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-05"]);

    const b = user();
    const d = await event(b, { repeat: { freq: "daily" }, start_min: 1200, end_min: 1260 }); // 매일 20:00~21:00
    const rd = await after(b, d);
    expect(await roll(b, "2026-10-08", 600)).toBe(1); // 오늘(10/8) 것은 아직 → 10/7
    expect(await alive(rd)).toEqual(["2026-10-07"]);
    expect(await roll(b, "2026-10-08", 1260)).toBe(1);
    expect(await alive(rd)).toEqual(["2026-10-08"]);
  });

  it("자정을 넘겨 끝나는 일정은 다음 날 끝 시각이 지나야", async () => {
    const a = user();
    const e = await event(a, { repeat: WEEKLY_MON, start_min: 1380, end_min: 1500 }); // 월 23:00 ~ 화 01:00
    const r = await after(a, e);
    expect(await roll(a, "2026-10-05", 1439)).toBe(0);
    expect(await roll(a, "2026-10-06", 59)).toBe(0);
    expect(await roll(a, "2026-10-06", 60)).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-05"]);
  });

  it("건너뛴(skip) 회차는 안 만든다", async () => {
    const a = user();
    const e = await event(a, { repeat: WEEKLY_MON });
    const r = await after(a, e);
    await addEx(a, e, "2026-10-12");
    expect(await roll(a, "2026-10-05", 700)).toBe(1);
    expect(await roll(a, "2026-10-12", 1000)).toBe(0);
    expect(await roll(a, "2026-10-18", 1000)).toBe(0);
    expect(await alive(r)).toEqual(["2026-10-05"]); // 지난 것도 그대로
    expect(await roll(a, "2026-10-19", 700)).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-19"]);

    // 가장 최근 회차가 건너뜀이면 그 앞 회차
    const b = user();
    const e2 = await event(b, { repeat: WEEKLY_MON });
    const r2 = await after(b, e2);
    await addEx(b, e2, "2026-10-19");
    expect(await roll(b, "2026-10-20", 0)).toBe(1);
    expect(await alive(r2)).toEqual(["2026-10-12"]);
  });

  it("이번만 시각을 바꾼 회차는 바꾼 끝 시각으로 본다", async () => {
    const a = user();
    const e = await event(a, { repeat: WEEKLY_MON });
    const r = await after(a, e);
    await addEx(a, e, "2026-10-05", { start_min: 660, end_min: 720 });
    await addEx(a, e, "2026-10-12", { title: "제목만" });
    await addEx(a, e, "2026-10-19", { start_min: null, end_min: null }); // 이번만 종일
    expect(await roll(a, "2026-10-05", 650)).toBe(0);
    expect(await roll(a, "2026-10-05", 720)).toBe(1);
    expect(await roll(a, "2026-10-12", 599)).toBe(0);
    expect(await roll(a, "2026-10-12", 600)).toBe(1);
    expect(await roll(a, "2026-10-19", 1439)).toBe(0);
    expect(await roll(a, "2026-10-20", 0)).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-19"]);
  });

  it("종일 일정의 오늘 회차는 다음 날부터", async () => {
    const a = user();
    const e = await event(a, { repeat: { freq: "daily" }, start_min: null, end_min: null });
    const r = await after(a, e);
    expect(await roll(a, "2026-10-05", 1439)).toBe(0);
    expect(await roll(a, "2026-10-06", 0)).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-05"]);
    expect(await roll(a, "2026-10-06", 1439)).toBe(0);
    expect(await roll(a, "2026-10-09", 0)).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-08"]);
  });

  it("일정을 지우면 규칙이 멈춰 더는 안 만든다. 반복이 끝난(until) 뒤에도 안 만든다", async () => {
    const a = user();
    const e = await event(a, { repeat: WEEKLY_MON });
    const r = await after(a, e);
    expect(await roll(a, "2026-10-05", 700)).toBe(1);
    await softDelete(a, "ez_events", e);
    expect((await rule(r)).deleted_at).not.toBeNull();
    expect(await roll(a, "2026-10-12", 700)).toBe(0);
    expect(await alive(r)).toEqual(["2026-10-05"]);

    const b = user();
    const e2 = await event(b, { repeat: { freq: "weekly", days: [1], until: "2026-10-12" } });
    const r2 = await after(b, e2);
    expect(await roll(b, "2026-10-30", 0)).toBe(1);
    expect(await alive(r2)).toEqual(["2026-10-12"]);
    expect(await roll(b, "2026-11-30", 0)).toBe(0);
  });

  it("60일 넘게 안 열었을 때: 60일 안에 끝난 회차가 있으면 그 마지막 하나, 없으면 안 만든다", async () => {
    const a = user();
    const recent = await event(a, { date: "2026-06-01", repeat: { freq: "weekly", days: [1], until: "2026-09-07" } });
    const longAgo = await event(a, { date: "2026-06-01", repeat: { freq: "weekly", days: [1], until: "2026-07-27" } });
    const r1 = await after(a, recent);
    const r2 = await after(a, longAgo);
    expect(await roll(a, "2026-10-05", 0)).toBe(1); // 10/5 - 60일 = 8/6
    expect(await alive(r1)).toEqual(["2026-09-07"]);
    expect(await made(r2)).toHaveLength(0);
  });
});

describe("ez_tasks_roll — 입력 · 대리", () => {
  it("오늘 날짜 · 지금 시각 검사", async () => {
    const a = user();
    await cycle(a);
    await fails(roll(a, null, 0), "EZ_VALUE");
    await fails(roll(a, "2026-10-05", null), "EZ_VALUE");
    await fails(roll(a, "2026-10-05", -1), "EZ_VALUE");
    expect((await fails(roll(a, "2026-10-05", 1440), "EZ_VALUE")).message).toContain("0~1439");
    expect(await sql("admin", "select id from ez_tasks where owner = $1", [a])).toHaveLength(0);
  });

  it("service_role 은 p_as 로 대리, 없으면 거절. authenticated 의 p_as 는 무시. 남의 규칙은 안 굴린다", async () => {
    const a = user();
    const b = user();
    const ra = await cycle(a);
    const rb = await cycle(b);
    await fails(roll("service", "2026-10-05", 0), "EZ_AUTH");
    expect(await roll(b, "2026-10-05", 0, a)).toBe(1); // b 자기 것만
    expect(await made(ra)).toHaveLength(0);
    expect(await alive(rb)).toEqual(["2026-10-05"]);
    expect(await roll("service", "2026-10-05", 0, a)).toBe(1);
    const [t] = await made(ra);
    expect([t!.owner, t!.rule_date]).toEqual([a, "2026-10-05"]);
    expect(await roll("service", "2026-10-05", 0, a)).toBe(0);
    expect(await roll("service", "2026-10-05", 0, user())).toBe(0); // 규칙 없는 사람
  });
});
