// 0008 (역할: ez_roles, 할 일 · 규칙의 role_id, ez_roles_seed, ez_tasks_roll 이 역할을 옮김)을 PGlite 에서 돌려 본다.
// Supabase 흉내는 db/testing.ts. 날짜: 2026-10-05 가 월요일.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ROLES, ROLES_MAX, ROLE_NAME_MAX } from "../lib/schedule";
import { migrations, SUPABASE_STUB } from "./testing";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const m of migrations()) await db.exec(m);
}, 60_000);

type Row = Record<string, any>;

/** 사용자 id · "anon" · "service"(service_role, MCP) · "admin"(postgres) 으로 한 문장 */
async function sqlOn(d: PGlite, who: string, text: string, params: unknown[] = []): Promise<Row[]> {
  await d.exec("reset role");
  const sub = who === "anon" || who === "admin" || who === "service" ? "" : who;
  await d.query("select set_config('request.jwt.claim.sub', $1, false)", [sub]);
  if (who === "anon") await d.exec("set role anon");
  else if (who === "service") await d.exec("set role service_role");
  else if (who !== "admin") await d.exec("set role authenticated");
  try {
    return (await d.query<Row>(text, params)).rows;
  } finally {
    await d.exec("reset role");
  }
}
const sql = (who: string, text: string, params: unknown[] = []) => sqlOn(db, who, text, params);

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

const role = async (who: string, name: string, extra: Record<string, unknown> = {}) => (await ins(who, "ez_roles", { name, ...extra })).id as string;
const task = async (who: string, extra: Record<string, unknown> = {}) => (await ins(who, "ez_tasks", { title: "할 일", ...extra })).id as string;
const WEEKLY_MON = { freq: "weekly", days: [1] };
const cycle = async (who: string, extra: Record<string, unknown> = {}) =>
  (await ins(who, "ez_task_rules", { kind: "cycle", title: "주간 숙제", repeat: WEEKLY_MON, start: "2026-10-05", ...extra })).id as string;

const ro = (id: string) => one("admin", "select * from ez_roles where id = $1", [id]);
const tk = (id: string) => one("admin", "select * from ez_tasks where id = $1", [id]);
const rule = (id: string) => one("admin", "select * from ez_task_rules where id = $1", [id]);
/** 그 주인의 역할 전부 (지운 것도), sort 순 */
const rolesOf = (owner: string) => sql("admin", "select name, from_place, sort, deleted_at from ez_roles where owner = $1 order by sort, name", [owner]);
const softDelete = (who: string, table: string, id: string) => sql(who, `update ${table} set deleted_at = now() where id = $1`, [id]);
const seed = (who: string, as: string | null = null) => one(who, "select ez_roles_seed($1) n", [as]).then((r) => r.n as number);
const roll = (who: string, today: string, now: number) => one(who, "select ez_tasks_roll($1, $2) n", [today, now]).then((r) => r.n as number);
const made = (ruleId: string) => sql("admin", "select role_id, rule_date::text as rule_date from ez_tasks t where rule_id = $1 order by t.rule_date", [ruleId]);

// ---------------------------------------------------------------------------

describe("권한 · RLS", () => {
  it("anon 은 역할 표를 읽기 · 쓰기 못 하고 함수도 못 부른다", async () => {
    await fails(sql("anon", "select * from ez_roles"), "42501");
    await fails(sql("anon", "insert into ez_roles (owner, name) values ($1, 'x')", [user()]), "42501");
    await fails(sql("anon", "select ez_roles_seed()"), "42501");
    await fails(sql("anon", "select ez_roles_seed($1)", [user()]), "42501");
    await fails(sql("anon", "select * from ez_roles_defaults()"), "42501");
  });

  it("남의 역할은 안 보이고 못 고친다. 남의 주인으로 못 넣는다", async () => {
    const a = user();
    const b = user();
    const r = await role(a, "대학");
    expect(await sql(b, "select * from ez_roles")).toHaveLength(0);
    expect(await sql(a, "select * from ez_roles")).toHaveLength(1);
    expect(await sql(b, "update ez_roles set name = '뺏음' where id = $1 returning id", [r])).toHaveLength(0);
    await fails(sql(b, "insert into ez_roles (owner, name) values ($1, '침범')", [a]), "42501");
    expect((await ro(r)).name).toBe("대학");
  });

  it("authenticated 는 행을 지울 수 없다 (지우기 = deleted_at). service_role 은 owner 를 적어 쓴다", async () => {
    const a = user();
    const r = await role(a, "대학");
    await fails(sql(a, "delete from ez_roles where id = $1", [r]), "42501");
    await softDelete(a, "ez_roles", r);
    expect((await ro(r)).deleted_at).not.toBeNull();
    await fails(sql("service", "insert into ez_roles (name) values ('x')"), "23502");
    expect((await ins("service", "ez_roles", { owner: a, name: "대리" })).owner).toBe(a);
  });
});

describe("ez_roles 제약", () => {
  it("이름: 앞뒤 공백 없는 1~20자", async () => {
    const a = user();
    expect(ROLE_NAME_MAX).toBe(20);
    await role(a, "가".repeat(ROLE_NAME_MAX));
    await role(a, "가");
    for (const name of ["", " ", " 앞", "뒤 ", "가".repeat(ROLE_NAME_MAX + 1)]) await fails(role(a, name), "23514");
    await fails(sql(a, "insert into ez_roles (name) values (null)"), "23502");
    const r = await role(a, "고칠 것");
    await fails(sql(a, "update ez_roles set name = '끝 ' where id = $1", [r]), "23514");
  });

  it("살아 있는 것끼리 같은 주인 안에서 이름 겹침 금지 (대소문자 무시). 지운 이름 · 남의 이름은 된다", async () => {
    const a = user();
    const r = await role(a, "Tutor");
    await fails(role(a, "tutor"), "23505");
    await fails(role(a, "TUTOR"), "23505");
    await role(user(), "Tutor");
    const other = await role(a, "대학");
    await fails(sql(a, "update ez_roles set name = 'tuTor' where id = $1", [other]), "23505");
    await softDelete(a, "ez_roles", r);
    const again = await role(a, "tutor");
    // 지운 것을 되살리면 다시 겹친다
    await fails(sql(a, "update ez_roles set deleted_at = null where id = $1", [r]), "23505");
    await softDelete(a, "ez_roles", again);
    await sql(a, "update ez_roles set deleted_at = null where id = $1", [r]);
  });

  it("from_place: null · home · work · school 만. 살아 있는 것 중 같은 주인 · 같은 값은 하나", async () => {
    const a = user();
    const school = await role(a, "대학", { from_place: "school" });
    await role(a, "강사", { from_place: "work" });
    await role(a, "개인", { from_place: "home" });
    await role(a, "동아리");
    await role(a, "가족", { from_place: null }); // null 은 여럿
    for (const from_place of ["cafe", "", "School"]) await fails(role(a, `틀림 ${from_place}`, { from_place }), "23514");
    await fails(role(a, "대학원", { from_place: "school" }), "23505");
    await role(user(), "대학", { from_place: "school" }); // 남은 상관없다
    const extra = await role(a, "대학원");
    await fails(sql(a, "update ez_roles set from_place = 'school' where id = $1", [extra]), "23505");
    // 지우면 그 값을 다른 역할이 쓸 수 있다
    await softDelete(a, "ez_roles", school);
    await sql(a, "update ez_roles set from_place = 'school' where id = $1", [extra]);
    await fails(sql(a, "update ez_roles set deleted_at = null where id = $1", [school]), "23505");
  });

  it("sort 는 유한한 수, 기본 0", async () => {
    const a = user();
    expect((await ro(await role(a, "기본"))).sort).toBe(0);
    await role(a, "소수", { sort: -1.5 });
    await fails(role(a, "무한", { sort: "Infinity" }), "23514");
  });

  it("살아 있는 역할은 12개까지. 지우면 다시 넣을 수 있고, 되살릴 때도 센다", async () => {
    const a = user();
    expect(ROLES_MAX).toBe(12);
    const ids: string[] = [];
    for (let i = 0; i < ROLES_MAX; i++) ids.push(await role(a, `역할 ${i}`));
    const err = await fails(role(a, "열셋째"), "EZ_LIMIT");
    expect(err.message).toBe("[EZ_LIMIT] 역할은 12개까지 둘 수 있습니다. 안 쓰는 역할을 지우고 다시 하세요");
    await fails(ins("service", "ez_roles", { owner: a, name: "대리 열셋째" }), "EZ_LIMIT");
    await role(user(), "남은 상관없다");
    // 꽉 찬 채로 이름 · 순서는 고칠 수 있다
    await sql(a, "update ez_roles set name = '바꿈', sort = 9 where id = $1", [ids[0]]);
    await softDelete(a, "ez_roles", ids[0]!);
    await role(a, "열셋째");
    await fails(sql(a, "update ez_roles set deleted_at = null where id = $1", [ids[0]]), "EZ_LIMIT");
  });

  it("version: 넣을 때 1, 바뀌면 +1, 주인은 못 바꾼다", async () => {
    const a = user();
    const r = await ins(a, "ez_roles", { name: "v", version: 9 });
    expect(r.version).toBe(1);
    await sql(a, "update ez_roles set name = 'v2' where id = $1", [r.id]);
    await sql(a, "update ez_roles set name = 'v2' where id = $1", [r.id]);
    expect((await ro(r.id)).version).toBe(2);
    expect(await sql(a, "update ez_roles set name = '낡음' where id = $1 and version = 1 returning id", [r.id])).toHaveLength(0);
    await fails(sql("service", "update ez_roles set owner = $2 where id = $1", [r.id, user()]), "EZ_FIXED");
  });
});

describe("할 일 · 규칙의 role_id", () => {
  it("같은 주인의 역할만 건다 (남의 역할 · 없는 역할 거절)", async () => {
    const a = user();
    const b = user();
    const mine = await role(a, "대학");
    const theirs = await role(b, "대학");
    expect((await tk(await task(a, { role_id: mine }))).role_id).toBe(mine);
    expect((await rule(await cycle(a, { role_id: mine }))).role_id).toBe(mine);
    expect((await tk(await task(a))).role_id).toBeNull();
    await fails(task(a, { role_id: theirs }), "23503");
    await fails(task(a, { role_id: randomUUID() }), "23503");
    await fails(cycle(a, { role_id: theirs }), "23503");
    await fails(cycle(a, { role_id: randomUUID() }), "23503");
    const t = await task(a);
    const r = await cycle(a);
    await fails(sql(a, "update ez_tasks set role_id = $2 where id = $1", [t, theirs]), "23503");
    await fails(sql("service", "update ez_tasks set role_id = $2 where id = $1", [t, theirs]), "23503");
    await fails(sql(a, "update ez_task_rules set role_id = $2 where id = $1", [r, theirs]), "23503");
    // 역할을 걸면 버전이 오른다
    await sql(a, "update ez_tasks set role_id = $2 where id = $1", [t, mine]);
    expect([(await tk(t)).role_id, (await tk(t)).version]).toEqual([mine, 2]);
  });

  it("지운 역할은 새로 걸 수 없다 (넣을 때 · 바꿀 때)", async () => {
    const a = user();
    const dead = await role(a, "옛 역할");
    const live = await role(a, "대학");
    await softDelete(a, "ez_roles", dead);
    const err = await fails(task(a, { role_id: dead }), "EZ_ROLE");
    expect(err.message).toBe("[EZ_ROLE] 지운 역할입니다");
    await fails(cycle(a, { role_id: dead }), "EZ_ROLE");
    const t = await task(a, { role_id: live });
    const r = await cycle(a);
    await fails(sql(a, "update ez_tasks set role_id = $2 where id = $1", [t, dead]), "EZ_ROLE");
    await fails(sql(a, "update ez_task_rules set role_id = $2 where id = $1", [r, dead]), "EZ_ROLE");
    await fails(sql("service", "update ez_tasks set role_id = $2 where id = $1", [t, dead]), "EZ_ROLE");
    expect((await tk(t)).role_id).toBe(live);
    // 되살리면 다시 걸 수 있다
    await sql(a, "update ez_roles set deleted_at = null where id = $1", [dead]);
    await sql(a, "update ez_tasks set role_id = $2 where id = $1", [t, dead]);
  });

  it("역할을 지우면 그 역할의 살아 있는 할 일 · 규칙이 역할 없음이 된다. 되살려도 다시 걸리지 않는다", async () => {
    const a = user();
    const gone = await role(a, "강사");
    const keep = await role(a, "대학");
    const t1 = await task(a, { role_id: gone });
    const t2 = await task(a, { role_id: gone, done_at: "2026-10-01T00:00:00Z" }); // 끝낸 것도 살아 있는 할 일
    const other = await task(a, { role_id: keep });
    const r1 = await cycle(a, { role_id: gone });
    const r2 = await cycle(a, { role_id: keep });
    // 이름만 바꿀 때는 그대로
    await sql(a, "update ez_roles set name = '선생' where id = $1", [gone]);
    expect((await tk(t1)).role_id).toBe(gone);

    await softDelete(a, "ez_roles", gone);
    expect([(await tk(t1)).role_id, (await tk(t1)).version]).toEqual([null, 2]);
    expect((await tk(t2)).role_id).toBeNull();
    expect((await rule(r1)).role_id).toBeNull();
    expect([(await tk(other)).role_id, (await tk(other)).version]).toEqual([keep, 1]);
    expect((await rule(r2)).role_id).toBe(keep);

    await sql(a, "update ez_roles set deleted_at = null where id = $1", [gone]);
    expect((await tk(t1)).role_id).toBeNull();
    // service_role 이 지워도 같다
    await sql("service", "update ez_roles set deleted_at = now() where id = $1", [keep]);
    expect((await tk(other)).role_id).toBeNull();
    expect((await rule(r2)).role_id).toBeNull();
  });

  it("지워 둔 할 일 · 멈춘 규칙은 역할을 지워도 그대로고, 되살릴 때 역할 없음이 된다", async () => {
    const a = user();
    const gone = await role(a, "강사");
    const t = await task(a, { role_id: gone });
    const r = await cycle(a, { role_id: gone });
    await softDelete(a, "ez_tasks", t);
    await softDelete(a, "ez_task_rules", r);
    await softDelete(a, "ez_roles", gone);
    expect((await tk(t)).role_id).toBe(gone);
    expect((await rule(r)).role_id).toBe(gone);
    await sql(a, "update ez_tasks set deleted_at = null where id = $1", [t]);
    await sql(a, "update ez_task_rules set deleted_at = null where id = $1", [r]);
    expect([(await tk(t)).role_id, (await tk(t)).deleted_at]).toEqual([null, null]);
    expect([(await rule(r)).role_id, (await rule(r)).deleted_at]).toEqual([null, null]);
    // 역할이 살아 있으면 되살려도 그대로
    const live = await role(a, "대학");
    const t2 = await task(a, { role_id: live });
    await softDelete(a, "ez_tasks", t2);
    await sql(a, "update ez_tasks set deleted_at = null where id = $1", [t2]);
    expect((await tk(t2)).role_id).toBe(live);
  });

  it("역할 행이 정말 지워지면 role_id 만 비워진다", async () => {
    const a = user();
    const r = await role(a, "대학");
    const t = await task(a, { role_id: r, note: "남는다" });
    const c = await cycle(a, { role_id: r });
    await sql("service", "delete from ez_roles where id = $1", [r]);
    const now = await tk(t);
    expect([now.role_id, now.owner, now.note, now.deleted_at]).toEqual([null, a, "남는다", null]);
    expect([(await rule(c)).role_id, (await rule(c)).owner]).toEqual([null, a]);
  });
});

describe("ez_roles_seed", () => {
  it("처음에는 기본 셋 3개 (DEFAULT_ROLES 와 같다), 두 번째는 0", async () => {
    const a = user();
    expect(await seed(a)).toBe(3);
    const rows = await rolesOf(a);
    expect(rows.map((r) => ({ name: r.name, from_place: r.from_place }))).toEqual(DEFAULT_ROLES);
    expect(rows.map((r) => r.sort)).toEqual([0, 1, 2]);
    expect(rows.every((r) => r.deleted_at === null)).toBe(true);
    expect(await sql(a, "select id from ez_roles")).toHaveLength(3); // 내 눈에도 보인다
    expect(await seed(a)).toBe(0);
    expect(await rolesOf(a)).toHaveLength(3);
    // DB 안의 기본 셋도 같다
    const defaults = await sql("admin", "select name, from_place from ez_roles_defaults() order by sort");
    expect(defaults).toEqual(DEFAULT_ROLES);
  });

  it("역할 행이 하나라도 있으면(지운 것 포함) 안 넣는다. 다 지운 뒤에도 0", async () => {
    const a = user();
    await seed(a);
    await sql(a, "update ez_roles set deleted_at = now()");
    expect(await seed(a)).toBe(0);
    expect((await rolesOf(a)).filter((r) => r.deleted_at === null)).toHaveLength(0);
    // 손으로 하나 만든 사람에게도 안 넣는다
    const b = user();
    await role(b, "프리랜서");
    expect(await seed(b)).toBe(0);
    expect((await rolesOf(b)).map((r) => r.name)).toEqual(["프리랜서"]);
  });

  it("service_role 은 p_as 로 대리, 없으면 거절. authenticated 의 p_as 는 무시", async () => {
    const a = user();
    const b = user();
    await fails(seed("service"), "EZ_AUTH");
    expect(await seed("service", a)).toBe(3);
    expect((await rolesOf(a)).map((r) => r.name)).toEqual(DEFAULT_ROLES.map((r) => r.name));
    expect(await seed("service", a)).toBe(0);
    expect(await seed(b, a)).toBe(3); // b 자기 것
    expect(await rolesOf(b)).toHaveLength(3);
    expect(await rolesOf(a)).toHaveLength(3);
  });

  it("동시에 불러도 한 벌만", async () => {
    const a = user();
    const ns = await Promise.all([seed("service", a), seed("service", a), seed("service", a)]);
    expect(ns.reduce((x, y) => x + y, 0)).toBe(3);
    expect(await rolesOf(a)).toHaveLength(3);
  });
});

describe("마이그레이션 — 이미 쓰던 사람", () => {
  it("할 일이나 지점이 있는 주인에게 기본 셋을 넣는다. 있던 할 일 · 규칙의 역할은 비어 있다", async () => {
    const all = migrations("0008_ez_roles.sql");
    const before = migrations("0007_ez_planner.sql");
    expect(all.length).toBe(before.length + 1);
    const old = new PGlite();
    await old.exec(SUPABASE_STUB);
    for (const m of before) await old.exec(m);
    const withTask = user();
    const withPlace = user();
    const both = user();
    const [t] = await sqlOn(old, withTask, "insert into ez_tasks (title) values ('있던 할 일') returning id");
    await sqlOn(old, withPlace, "insert into ez_places (name, role) values ('집', 'home')");
    await sqlOn(old, both, "insert into ez_tasks (title) values ('a'), ('b')");
    await sqlOn(old, both, "insert into ez_places (name) values ('카페')");
    const [r] = await sqlOn(old, both, `insert into ez_task_rules (kind, title, repeat, start) values ('cycle', '있던 규칙', '{"freq":"daily"}', '2026-10-05') returning id`);

    await old.exec(all[all.length - 1]!);
    for (const owner of [withTask, withPlace, both]) {
      const rows = await sqlOn(old, "admin", "select name, from_place from ez_roles where owner = $1 order by sort", [owner]);
      expect(rows).toEqual(DEFAULT_ROLES);
    }
    expect(await sqlOn(old, "admin", "select count(*)::int n from ez_roles")).toEqual([{ n: 9 }]);
    expect((await sqlOn(old, "admin", "select role_id, version from ez_tasks where id = $1", [t!.id]))[0]).toEqual({ role_id: null, version: 1 });
    expect((await sqlOn(old, "admin", "select role_id, version from ez_task_rules where id = $1", [r!.id]))[0]).toEqual({ role_id: null, version: 1 });
    // 그 뒤 seed 는 0, 처음 온 사람은 3
    expect((await sqlOn(old, both, "select ez_roles_seed() n"))[0]!.n).toBe(0);
    expect((await sqlOn(old, user(), "select ez_roles_seed() n"))[0]!.n).toBe(3);
    await old.close();
  }, 60_000);
});

describe("ez_tasks_roll — 역할", () => {
  it("새 할 일에 규칙의 역할을 옮긴다. 역할 없는 규칙은 역할 없음", async () => {
    const a = user();
    const univ = await role(a, "대학");
    const withRole = await cycle(a, { role_id: univ });
    const none = await cycle(a, { title: "역할 없음" });
    expect(await roll(a, "2026-10-05", 0)).toBe(2);
    expect((await made(withRole)).map((t) => [t.rule_date, t.role_id])).toEqual([["2026-10-05", univ]]);
    expect((await made(none))[0]!.role_id).toBeNull();
    // 규칙의 역할을 바꾸면 다음 회차부터
    const tutor = await role(a, "강사");
    await sql(a, "update ez_task_rules set role_id = $2 where id = $1", [withRole, tutor]);
    expect(await roll(a, "2026-10-12", 0)).toBe(2);
    expect((await made(withRole)).map((t) => [t.rule_date, t.role_id])).toEqual([
      ["2026-10-05", univ],
      ["2026-10-12", tutor],
    ]);
  });

  it("일정에 딸린 규칙도 역할을 옮긴다", async () => {
    const a = user();
    const univ = await role(a, "대학");
    const e = await ins(a, "ez_events", { title: "상법", date: "2026-10-05", start_min: 540, end_min: 600, repeat: WEEKLY_MON });
    const r = (await ins(a, "ez_task_rules", { kind: "event", title: "내용 정리", event_id: e.id, role_id: univ })).id;
    expect(await roll(a, "2026-10-05", 599)).toBe(0);
    expect(await roll(a, "2026-10-05", 600)).toBe(1);
    expect((await made(r))[0]!.role_id).toBe(univ);
  });

  it("규칙의 역할이 지워졌으면 역할 없음으로 생긴다", async () => {
    const a = user();
    const gone = await role(a, "강사");
    const r = await cycle(a, { role_id: gone });
    expect(await roll(a, "2026-10-05", 0)).toBe(1);
    await softDelete(a, "ez_roles", gone);
    expect((await rule(r)).role_id).toBeNull();
    expect(await roll(a, "2026-10-12", 0)).toBe(1);
    expect((await made(r)).map((t) => t.role_id)).toEqual([null, null]);

    // 트리거를 거치지 않고 지운 역할이 규칙에 남아 있어도(옛 데이터) 역할 없음으로
    const b = user();
    const dead = await role(b, "옛 역할");
    const rb = await cycle(b, { role_id: dead });
    await sql("admin", "alter table ez_roles disable trigger ez_roles_after");
    await softDelete(b, "ez_roles", dead);
    await sql("admin", "alter table ez_roles enable trigger ez_roles_after");
    expect((await rule(rb)).role_id).toBe(dead);
    expect(await roll(b, "2026-10-05", 0)).toBe(1);
    expect((await made(rb))[0]!.role_id).toBeNull();
  });
});
