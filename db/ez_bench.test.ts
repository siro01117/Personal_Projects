// 0016 · 0017 (작업대: ez_tasks.bench_order · bench_at, ez_task_bench · ez_task_sit, 끝내거나 지우면 내려놓음, 체크 항목 상한 50)을 PGlite 에서 돌려 본다.
// 0017 부터 작업대는 여럿(bench_order = 올린 순서), 그중 앉은 것(bench_at)은 사람당 하나.
// Supabase 흉내는 db/testing.ts.

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

/** 실패해야 한다. code 가 EZ_ 로 시작하면 P0001 + '[EZ_…] ' 메시지, 아니면 SQLSTATE */
async function fails(p: Promise<unknown>, code: string): Promise<void> {
  const e: any = await p.then(
    () => null,
    (err) => err,
  );
  expect(e, `${code} 로 실패해야 합니다`).not.toBeNull();
  if (code.startsWith("EZ_")) {
    expect(e.code, e.message).toBe("P0001");
    expect(e.message).toMatch(new RegExp(`^\\[${code}\\] \\S`));
  } else expect(e.code, e.message).toBe(code);
}

const user = () => randomUUID();
const task = async (who: string, title = "할 일") => (await sql(who, "insert into ez_tasks (title) values ($1) returning id", [title]))[0]!.id as string;
const bench = (who: string, id: string, on: boolean, as: string | null = null) =>
  sql(who, "select id, bench_order, bench_at, version from ez_task_bench($1, $2, $3)", [id, on, as]).then((r) => r[0]!);
const sit = (who: string, id: string, as: string | null = null) =>
  sql(who, "select id, bench_order, bench_at, version from ez_task_sit($1, $2)", [id, as]).then((r) => r[0]!);
/** 그 주인의 작업대에 올라간 할 일 id 들 (올린 순서) */
const benched = (owner: string) =>
  sql("admin", "select id from ez_tasks where owner = $1 and bench_order is not null order by bench_order", [owner]).then((r) => r.map((x) => x.id));
/** 그 주인의 앉은 할 일 id 들 */
const sitting = (owner: string) => sql("admin", "select id from ez_tasks where owner = $1 and bench_at is not null", [owner]).then((r) => r.map((x) => x.id));
const tk = (id: string) => sql("admin", "select * from ez_tasks where id = $1", [id]).then((r) => r[0]!);

describe("ez_task_bench — 여럿 올리기 (0017)", () => {
  it("여럿 올라간다. 번호는 올린 순서, 앞의 것은 그대로", async () => {
    const a = user();
    const x = await task(a, "상법 정리");
    const y = await task(a, "과제");
    const z = await task(a, "보고서");
    await sql(a, "update ez_tasks set note = '계획', checklist = '[{\"t\":\"1장\",\"done\":true}]' where id = $1", [x]);
    expect((await bench(a, x, true)).bench_order).toBe(1);
    expect((await bench(a, y, true)).bench_order).toBe(2);
    expect((await bench(a, z, true)).bench_order).toBe(3);
    expect(await benched(a)).toEqual([x, y, z]);
    expect(await sitting(a)).toEqual([]);
    expect(await tk(x)).toMatchObject({ bench_order: 1, note: "계획", checklist: [{ t: "1장", done: true }] });
  });

  it("이미 올라가 있으면 그대로(번호 · 버전 안 바뀜), 내리면 비운다", async () => {
    const a = user();
    const x = await task(a);
    const first = await bench(a, x, true);
    const again = await bench(a, x, true);
    expect(again.bench_order).toBe(first.bench_order);
    expect(again.version).toBe(first.version);
    const off = await bench(a, x, false);
    expect(off.bench_order).toBeNull();
    expect((await bench(a, x, false)).version).toBe(off.version);
  });

  it("앉아 있던 것을 내리면 앉음도 비운다", async () => {
    const a = user();
    const x = await task(a);
    await bench(a, x, true);
    await sit(a, x);
    const off = await bench(a, x, false);
    expect(off).toMatchObject({ bench_order: null, bench_at: null });
    expect(await sitting(a)).toEqual([]);
  });

  it("내린 뒤 다시 올리면 맨 뒤로", async () => {
    const a = user();
    const x = await task(a);
    const y = await task(a);
    await bench(a, x, true);
    await bench(a, y, true);
    await bench(a, x, false);
    await bench(a, x, true);
    expect(await benched(a)).toEqual([y, x]);
  });

  it("순서는 bench_order 를 바로 고쳐 바꾼다 (자기 것만)", async () => {
    const a = user();
    const b = user();
    const x = await task(a);
    const y = await task(a);
    await bench(a, x, true);
    await bench(a, y, true);
    await sql(a, "update ez_tasks set bench_order = 1 where id = $1", [y]);
    await sql(a, "update ez_tasks set bench_order = 2 where id = $1", [x]);
    expect(await benched(a)).toEqual([y, x]);
    expect(await sql(b, "update ez_tasks set bench_order = 9 where id = $1 returning id", [x])).toEqual([]);
    await fails(sql(a, "update ez_tasks set bench_order = 0 where id = $1", [x]), "23514");
  });

  it("다른 사람의 작업대는 건드리지 않는다. 남의 할 일은 없는 것", async () => {
    const a = user();
    const b = user();
    const x = await task(a);
    const y = await task(b);
    await bench(a, x, true);
    await bench(b, y, true);
    expect(await benched(a)).toEqual([x]);
    expect(await benched(b)).toEqual([y]);
    await fails(bench(a, y, true), "EZ_NOT_FOUND");
    await fails(sit(a, y), "EZ_NOT_FOUND");
  });

  it("끝낸 · 지운 할 일은 못 올린다. 누구인지 모르면 거절", async () => {
    const a = user();
    const done = await task(a);
    await sql(a, "update ez_tasks set done_at = now() where id = $1", [done]);
    await fails(bench(a, done, true), "EZ_VALUE");
    await fails(sit(a, done), "EZ_VALUE");
    const gone = await task(a);
    await sql(a, "update ez_tasks set deleted_at = now() where id = $1", [gone]);
    await fails(bench(a, gone, true), "EZ_NOT_FOUND");
    await fails(bench("service", done, true), "EZ_AUTH");
    await fails(sit("service", done), "EZ_AUTH");
    await fails(bench("anon", done, true), "42501");
    await fails(sit("anon", done), "42501");
  });

  it("service_role 은 p_as 로 대리한다", async () => {
    const a = user();
    const x = await task(a);
    await bench("service", x, true, a);
    await sit("service", x, a);
    expect(await benched(a)).toEqual([x]);
    expect(await sitting(a)).toEqual([x]);
  });
});

describe("ez_task_sit — 앉는 것은 하나 (0017)", () => {
  it("앉으면 그것 하나만 — 다른 앉음은 비지만 작업대에는 남는다", async () => {
    const a = user();
    const x = await task(a);
    const y = await task(a);
    await bench(a, x, true);
    await bench(a, y, true);
    const s1 = await sit(a, x);
    expect(s1.bench_at).not.toBeNull();
    expect(await sitting(a)).toEqual([x]);
    await sit(a, y);
    expect(await sitting(a)).toEqual([y]);
    expect(await benched(a)).toEqual([x, y]);
  });

  it("이미 앉아 있으면 그대로(시각 · 버전 안 바뀜)", async () => {
    const a = user();
    const x = await task(a);
    const first = await sit(a, x);
    const again = await sit(a, x);
    expect(again.bench_at).toEqual(first.bench_at);
    expect(again.version).toBe(first.version);
  });

  it("안 올라가 있으면 먼저 맨 뒤로 올린다", async () => {
    const a = user();
    const x = await task(a);
    const y = await task(a);
    await bench(a, x, true);
    const s = await sit(a, y);
    expect(s.bench_order).toBe(2);
    expect(await benched(a)).toEqual([x, y]);
  });

  it("손으로 둘째를 앉히려 하면 DB 가 막는다 (사람당 하나)", async () => {
    const a = user();
    const x = await task(a);
    const y = await task(a);
    await sit(a, x);
    await bench(a, y, true);
    await fails(sql(a, "update ez_tasks set bench_at = now() where id = $1", [y]), "23505");
  });

  it("안 올라간 것에 앉음만 적으면 트리거가 비운다", async () => {
    const a = user();
    const x = await task(a);
    await sql(a, "update ez_tasks set bench_at = now() where id = $1", [x]);
    expect(await tk(x)).toMatchObject({ bench_at: null, bench_order: null });
  });

  it("순서를 손으로 비우면 앉음도 비운다", async () => {
    const a = user();
    const x = await task(a);
    await sit(a, x);
    await sql(a, "update ez_tasks set bench_order = null where id = $1", [x]);
    expect(await tk(x)).toMatchObject({ bench_at: null, bench_order: null });
  });
});

describe("끝내거나 지우면 내려온다 (순서 · 앉음 둘 다)", () => {
  it("끝내면 둘 다 비운다. 끝냄을 풀어도 다시 올라가지는 않는다", async () => {
    const a = user();
    const x = await task(a);
    await sit(a, x);
    await sql(a, "update ez_tasks set done_at = now() where id = $1", [x]);
    expect(await tk(x)).toMatchObject({ bench_at: null, bench_order: null });
    await sql(a, "update ez_tasks set done_at = null where id = $1", [x]);
    expect(await tk(x)).toMatchObject({ bench_at: null, bench_order: null });
  });

  it("지우면 둘 다 비운다. 그 뒤 다른 것에 앉을 수 있다", async () => {
    const a = user();
    const x = await task(a);
    const y = await task(a);
    await sit(a, x);
    await sql(a, "update ez_tasks set deleted_at = now() where id = $1", [x]);
    expect(await tk(x)).toMatchObject({ bench_at: null, bench_order: null });
    await sit(a, y);
    expect(await benched(a)).toEqual([y]);
    expect(await sitting(a)).toEqual([y]);
  });

  it("끝낸 채로 넣으면 순서 · 앉음은 남지 않는다", async () => {
    const a = user();
    const r = await sql(a, "insert into ez_tasks (title, done_at, bench_order, bench_at) values ('x', now(), 1, now()) returning bench_at, bench_order");
    expect(r[0]).toMatchObject({ bench_at: null, bench_order: null });
  });
});

describe("0016 에서 올라가 있던 것", () => {
  it("0017 을 넣으면 첫 번째로 올라가 있고 앉음도 그대로", async () => {
    const old = new PGlite();
    await old.exec(SUPABASE_STUB);
    for (const m of migrations("0016_ez_bench.sql")) await old.exec(m);
    const a = user();
    await old.query("select set_config('request.jwt.claim.sub', $1, false)", [a]);
    await old.exec("set role authenticated");
    const x = (await old.query<Row>("insert into ez_tasks (title) values ('x') returning id")).rows[0]!.id;
    await old.query("select ez_task_bench($1, true)", [x]);
    await old.exec("reset role");
    for (const m of migrations().slice(migrations("0016_ez_bench.sql").length)) await old.exec(m);
    const r = (await old.query<Row>("select bench_order, bench_at from ez_tasks where id = $1", [x])).rows[0]!;
    expect(r.bench_order).toBe(1);
    expect(r.bench_at).not.toBeNull();
    await old.close();
  }, 60_000);
});

describe("체크 항목 상한 50", () => {
  const item = (i: number) => ({ t: `단계 ${i}`, done: false });
  it("할 일: 50개까지, 51개는 거절", async () => {
    const a = user();
    const x = await task(a);
    await sql(a, "update ez_tasks set checklist = $2 where id = $1", [x, JSON.stringify(Array.from({ length: 50 }, (_, i) => item(i)))]);
    expect((await tk(x)).checklist).toHaveLength(50);
    await fails(sql(a, "update ez_tasks set checklist = $2 where id = $1", [x, JSON.stringify(Array.from({ length: 51 }, (_, i) => item(i)))]), "23514");
  });

  it("규칙: 글자 50개까지, 51개는 거절", async () => {
    const a = user();
    const rule = (n: number) =>
      sql(a, "insert into ez_task_rules (kind, title, repeat, start, checklist) values ('cycle', '주간', '{\"freq\":\"daily\"}', '2026-10-05', $1)", [
        JSON.stringify(Array.from({ length: n }, (_, i) => `단계 ${i}`)),
      ]);
    await rule(50);
    await fails(rule(51), "23514");
  });
});
