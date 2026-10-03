// 0015 (회원 · 추가 모듈: ez_admins · ez_members · ez_modules, ez_is_admin · ez_me · ez_set_picked)를 PGlite 에서 돌려 본다.
// Supabase 흉내는 db/testing.ts (auth.users 는 id · email · last_sign_in_at 만).

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { migrations, SUPABASE_STUB } from "./testing";

let db: PGlite;

/** 마이그레이션이 넣는 관리자 (EZ_OWNER_ID) */
const ADMIN = "00263c79-cc44-4b7a-a846-ab9d43f4e718";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const m of migrations()) await db.exec(m);
}, 60_000);

type Row = Record<string, any>;

/** 사용자 id · "anon" · "service"(service_role, 서버 라우트) · "admin"(postgres) 으로 한 문장 */
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

let n = 0;
/** 서버 라우트가 하는 것처럼: Auth 사용자 + 회원 줄 (service_role) */
async function member(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const login = (extra.login_id as string | undefined) ?? `user${++n}`;
  await sql("admin", "insert into auth.users (id, email) values ($1, $2)", [id, `${login}@members.ra-kan.cloud`]);
  await sql(
    "service",
    "insert into ez_members (user_id, login_id, name, allowed, picked, active) values ($1, $2, $3, $4, $5, $6)",
    [id, login, extra.name ?? "회원", extra.allowed ?? [], extra.picked ?? [], extra.active ?? true],
  );
  return id;
}

const memberRow = (id: string) => one("admin", "select * from ez_members where user_id = $1", [id]);
const me = async (who: string) => (await one(who, "select ez_me() as v")).v as Record<string, any>;
const addModule = (who: string, key: string, name: string, href: string, extra: Record<string, unknown> = {}) =>
  sql(who, "insert into ez_modules (key, name, href, kind, sort) values ($1, $2, $3, $4, $5) returning key", [
    key,
    name,
    href,
    extra.kind ?? "link",
    extra.sort ?? 0,
  ]);

// ---------------------------------------------------------------------------

describe("관리자 · ez_is_admin", () => {
  it("마이그레이션이 관리자 한 줄을 넣는다. 관리자만 참", async () => {
    expect((await one("admin", "select count(*)::int as c from ez_admins")).c).toBe(1);
    expect((await one(ADMIN, "select ez_is_admin() as v")).v).toBe(true);
    expect((await one(randomUUID(), "select ez_is_admin() as v")).v).toBe(false);
  });

  it("ez_admins 는 authenticated · anon 이 직접 못 읽고 못 쓴다", async () => {
    await fails(sql(ADMIN, "select * from ez_admins"), "42501");
    await fails(sql(randomUUID(), "insert into ez_admins (user_id) values ($1)", [randomUUID()]), "42501");
    await fails(sql("anon", "select * from ez_admins"), "42501");
    await fails(sql("anon", "select ez_is_admin()"), "42501");
    await fails(sql("anon", "select ez_me()"), "42501");
    expect(await sql("service", "select user_id from ez_admins")).toHaveLength(1);
  });
});

describe("회원 줄 · RLS · 열 권한", () => {
  it("회원은 자기 줄만 보인다. 관리자는 전부", async () => {
    const a = await member();
    const b = await member();
    expect((await sql(a, "select user_id from ez_members")).map((r) => r.user_id)).toEqual([a]);
    expect((await sql(b, "select user_id from ez_members")).map((r) => r.user_id)).toEqual([b]);
    const all = (await sql(ADMIN, "select user_id from ez_members")).map((r) => r.user_id);
    expect(all).toEqual(expect.arrayContaining([a, b]));
    expect(await sql(randomUUID(), "select user_id from ez_members")).toHaveLength(0);
    await fails(sql("anon", "select user_id from ez_members"), "42501");
  });

  it("회원은 picked 만 고친다. allowed · 이름 · 켬은 못 고치고 남의 줄은 안 닿는다", async () => {
    await addModule(ADMIN, "lab", "실험실", "https://lab.example.com");
    const a = await member({ allowed: ["lab"] });
    const b = await member();
    expect(await sql(a, "update ez_members set picked = '{lab}' where user_id = $1 returning picked", [a])).toEqual([{ picked: ["lab"] }]);
    await fails(sql(a, "update ez_members set allowed = '{lab,other}' where user_id = $1", [a]), "EZ_FORBIDDEN");
    await fails(sql(a, "update ez_members set name = '바꿈' where user_id = $1", [a]), "EZ_FORBIDDEN");
    await fails(sql(a, "update ez_members set active = false where user_id = $1", [a]), "EZ_FORBIDDEN");
    await fails(sql(a, "update ez_members set login_id = 'hacker' where user_id = $1", [a]), "42501");
    expect(await sql(a, "update ez_members set picked = '{lab}' where user_id = $1 returning user_id", [b])).toHaveLength(0);
    const row = await memberRow(a);
    expect(row.allowed).toEqual(["lab"]);
    expect(row.name).toBe("회원");
    expect(row.active).toBe(true);
    expect((await memberRow(b)).picked).toEqual([]);
  });

  it("관리자는 이름 · 켬 · 허용을 고친다. 남의 켠 것 · 아이디는 못 고친다", async () => {
    const a = await member();
    const r = await one(ADMIN, "update ez_members set name = '민서', active = false, allowed = '{lab}' where user_id = $1 returning name, active, allowed", [a]);
    expect(r).toEqual({ name: "민서", active: false, allowed: ["lab"] });
    await fails(sql(ADMIN, "update ez_members set picked = '{lab}' where user_id = $1", [a]), "EZ_FORBIDDEN");
    await fails(sql(ADMIN, "update ez_members set login_id = 'other' where user_id = $1", [a]), "42501");
  });

  it("insert · delete 는 service_role 만 (관리자도 직접은 못 한다)", async () => {
    const id = randomUUID();
    await sql("admin", "insert into auth.users (id) values ($1)", [id]);
    await fails(sql(ADMIN, "insert into ez_members (user_id, login_id, name) values ($1, 'direct', '직접')", [id]), "42501");
    await fails(sql(id, "insert into ez_members (user_id, login_id, name) values ($1, 'selfmade', '스스로')", [id]), "42501");
    const a = await member();
    await fails(sql(ADMIN, "delete from ez_members where user_id = $1", [a]), "42501");
    await fails(sql(a, "delete from ez_members where user_id = $1", [a]), "42501");
  });

  it("Auth 사용자를 지우면 회원 줄도 같이 지워진다 (on delete cascade)", async () => {
    const a = await member();
    await sql("admin", "delete from auth.users where id = $1", [a]);
    expect(await sql("admin", "select 1 from ez_members where user_id = $1", [a])).toHaveLength(0);
  });

  it("Auth 사용자 없이는 회원 줄을 못 넣는다 (외래키)", async () => {
    await fails(sql("service", "insert into ez_members (user_id, login_id, name) values ($1, 'ghost', '없음')", [randomUUID()]), "23503");
  });
});

describe("규칙: 아이디 · 이름 · 키 목록", () => {
  it("아이디는 영문 소문자 · 숫자 · ._- 3~20자, 겹치면 안 된다", async () => {
    await member({ login_id: "kim.min-seo_1" });
    for (const bad of ["ab", "Kim", "a".repeat(21), "한글아이디", "kim seo", "kim@x"]) {
      await fails(member({ login_id: bad }), "23514");
    }
    await fails(member({ login_id: "kim.min-seo_1" }), "23505");
  });

  it("이름은 앞뒤 공백 없는 1~20자", async () => {
    await member({ name: "가".repeat(20) });
    await fails(member({ name: "" }), "23514");
    await fails(member({ name: " 공백" }), "23514");
    await fails(member({ name: "가".repeat(21) }), "23514");
  });

  it("허용 · 켠 것은 키 모양 · 겹침 없음 · 1차원", async () => {
    const a = await member();
    await fails(sql(ADMIN, "update ez_members set allowed = '{Lab}' where user_id = $1", [a]), "23514");
    await fails(sql(ADMIN, "update ez_members set allowed = '{lab,lab}' where user_id = $1", [a]), "23514");
    await fails(sql(ADMIN, "update ez_members set allowed = '{{ab,cd}}' where user_id = $1", [a]), "23514");
    await fails(sql(a, "update ez_members set picked = '{x}' where user_id = $1", [a]), "23514");
  });
});

describe("추가 모듈 ez_modules", () => {
  it("읽기는 로그인한 누구나, 쓰기는 관리자만", async () => {
    const a = await member();
    await addModule(ADMIN, "docs", "문서", "https://docs.example.com/a?b=1");
    expect((await sql(a, "select key from ez_modules where key = 'docs'")).length).toBe(1);
    await fails(addModule(a, "mine", "내 것", "https://x.example.com"), "42501");
    expect(await sql(a, "update ez_modules set name = '뺏음' where key = 'docs' returning key")).toHaveLength(0);
    expect(await sql(a, "delete from ez_modules where key = 'docs' returning key")).toHaveLength(0);
    await fails(sql("anon", "select key from ez_modules"), "42501");
    expect(await sql(ADMIN, "update ez_modules set name = '문서함' where key = 'docs' returning name")).toEqual([{ name: "문서함" }]);
    await fails(sql(ADMIN, "update ez_modules set key = 'docs2' where key = 'docs'"), "42501");
  });

  it("키 · 이름 · 종류 · 주소 규칙", async () => {
    for (const key of ["a", "Ab", "a_b", "가나", "a".repeat(31)]) await fails(addModule(ADMIN, key, "이름", "https://x.example.com"), "23514");
    await fails(addModule(ADMIN, "ok-name", "", "https://x.example.com"), "23514");
    await fails(addModule(ADMIN, "ok-name", "가".repeat(21), "https://x.example.com"), "23514");
    for (const href of ["http://x.example.com", "javascript:alert(1)", "https://", "https://a b.com", "//x.example.com", "https://user@x.com"]) {
      await fails(addModule(ADMIN, "ok-name", "이름", href), "23514");
    }
    await fails(addModule(ADMIN, "ok-name", "이름", "/project", { kind: "app" }), "23514");
    await fails(addModule(ADMIN, "ok-name", "이름", "//evil.com", { kind: "builtin" }), "23514");
    await fails(addModule(ADMIN, "ok-name", "이름", "https://x.example.com", { kind: "builtin" }), "23514");
    expect(await addModule(ADMIN, "ok-builtin", "프로젝트", "/project", { kind: "builtin" })).toEqual([{ key: "ok-builtin" }]);
    await fails(addModule(ADMIN, "ok-builtin", "겹침", "https://x.example.com"), "23505");
  });

  it("모듈을 지우면 회원 · 관리자의 허용 · 켠 것에서 빠진다", async () => {
    await addModule(ADMIN, "gone", "곧 지움", "https://gone.example.com");
    await addModule(ADMIN, "stay", "남음", "https://stay.example.com");
    const a = await member({ allowed: ["gone", "stay"], picked: ["gone", "stay"] });
    await sql(ADMIN, "select ez_set_picked('{gone,stay}')");
    await sql(ADMIN, "delete from ez_modules where key = 'gone'");
    const row = await memberRow(a);
    expect(row.allowed).toEqual(["stay"]);
    expect(row.picked).toEqual(["stay"]);
    expect((await me(ADMIN)).picked).toEqual(["stay"]);
    await sql(ADMIN, "select ez_set_picked('{}')");
  });
});

describe("ez_me · ez_set_picked", () => {
  it("관리자: 모든 모듈이 허용, 켠 것은 ez_admins 에", async () => {
    await addModule(ADMIN, "me-b", "나중", "https://b.example.com", { sort: 20 });
    await addModule(ADMIN, "me-a", "먼저", "https://a.example.com", { sort: 10 });
    expect(await one(ADMIN, "select ez_set_picked('{me-a}') as v")).toEqual({ v: ["me-a"] });
    const m = await me(ADMIN);
    expect(m.role).toBe("admin");
    expect(m.active).toBe(true);
    expect(m.name).toBeNull();
    expect(m.picked).toEqual(["me-a"]);
    const all = (await sql("admin", "select key from ez_modules order by sort, key")).map((r) => r.key);
    expect(m.allowed).toEqual(all);
    expect(m.modules.map((x: any) => x.key)).toEqual(all);
    const a = m.modules.findIndex((x: any) => x.key === "me-a");
    expect(m.modules.findIndex((x: any) => x.key === "me-b")).toBeGreaterThan(a);
    expect(m.modules[a]).toEqual({ key: "me-a", name: "먼저", kind: "link", href: "https://a.example.com", sort: 10 });
  });

  it("회원: 허용된 모듈만, 켠 것 그대로 (허용 밖의 키도 돌려준다 — 화면이 무시한다)", async () => {
    await addModule(ADMIN, "mm-1", "하나", "https://1.example.com", { sort: 2 });
    await addModule(ADMIN, "mm-2", "둘", "https://2.example.com", { sort: 1 });
    const a = await member({ name: "지우", allowed: ["mm-1", "mm-2"], picked: ["mm-1", "other"] });
    const m = await me(a);
    expect(m).toMatchObject({ role: "member", name: "지우", active: true, allowed: ["mm-1", "mm-2"], picked: ["mm-1", "other"] });
    expect(m.modules.map((x: any) => x.key)).toEqual(["mm-2", "mm-1"]);
    expect(await one(a, "select ez_set_picked('{mm-2}') as v")).toEqual({ v: ["mm-2"] });
    expect((await me(a)).picked).toEqual(["mm-2"]);
    await fails(sql(a, "select ez_set_picked('{Bad}')"), "EZ_VALUE");
  });

  it("꺼진 회원: role 은 member, active false, 모듈은 빈 목록", async () => {
    const a = await member({ active: false, allowed: ["mm-1"] });
    expect(await me(a)).toMatchObject({ role: "member", active: false, modules: [] });
  });

  it("관리자도 회원도 아니면 none. 켜기 저장은 거절", async () => {
    const x = randomUUID();
    expect(await me(x)).toEqual({ role: "none", name: null, active: false, allowed: [], picked: [], modules: [] });
    await fails(sql(x, "select ez_set_picked('{}')"), "EZ_NOT_FOUND");
  });
});
