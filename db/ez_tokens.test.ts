// 0019 (에이전트 연결 — 개인 토큰: ez_tokens · ez_token_new · ez_token_check)를 PGlite 에서 돌려 본다. docs/에이전트-연결.md 1 · 5장.
// Supabase 흉내는 db/testing.ts.

import { PGlite } from "@electric-sql/pglite";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { migrations, SUPABASE_STUB } from "./testing";

let db: PGlite;

/** 마이그레이션(0015)이 넣는 관리자 (EZ_OWNER_ID) */
const ADMIN = "00263c79-cc44-4b7a-a846-ab9d43f4e718";
const TOKEN = /^ezt_[0-9A-Za-z]{40}$/;

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
/** 서버 라우트가 하는 것처럼: Auth 사용자 + 회원 줄 */
async function member(active = true): Promise<string> {
  const id = randomUUID();
  const login = `tok${++n}`;
  await sql("admin", "insert into auth.users (id, email) values ($1, $2)", [id, `${login}@members.ra-kan.cloud`]);
  await sql("service", "insert into ez_members (user_id, login_id, name, active) values ($1, $2, '회원', $3)", [id, login, active]);
  return id;
}

type Made = { id: string; token: string; name: string; tail: string; scope: string; created_at: string };
const make = async (who: string, name = "집 노트북", scope?: string): Promise<Made> =>
  (await sql(who, scope === undefined ? "select ez_token_new($1) as v" : "select ez_token_new($1, $2) as v", scope === undefined ? [name] : [name, scope]))[0]!.v;
const check = async (token: string | null): Promise<{ id: string; owner: string; scope: string } | null> =>
  (await sql("service", "select ez_token_check($1) as v", [token]))[0]!.v;
const row = async (id: string): Promise<Row> => (await sql("admin", "select * from ez_tokens where id = $1", [id]))[0]!;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** 주인이 볼 수 있는 칸 (해시 빼고) */
const COLS = "id, owner, name, tail, scope, last_used_at, revoked_at, created_at";

describe("만들기 (ez_token_new)", () => {
  it("원문은 돌려주기만 하고 저장은 해시 · 끝 4자", async () => {
    const a = await member();
    const t = await make(a);
    expect(t.token).toMatch(TOKEN);
    expect(t).toMatchObject({ name: "집 노트북", scope: "rw", tail: t.token.slice(-4) });
    const r = await row(t.id);
    expect(r).toMatchObject({ owner: a, name: "집 노트북", scope: "rw", tail: t.token.slice(-4), hash: sha(t.token), last_used_at: null, revoked_at: null });
    // 원문은 어느 칸에도 없다
    const all = await sql("admin", "select row_to_json(t)::text as j from ez_tokens t");
    for (const x of all) {
      expect(x.j).not.toContain(t.token);
      expect(x.j).not.toContain(t.token.slice(4));
    }
  });

  it("무작위: 겹치지 않고 base62 글자를 고루 쓴다", async () => {
    const out = (await sql("admin", "select public.ez_token_random(40) as s from generate_series(1, 200)")).map((r) => r.s as string);
    expect(new Set(out).size).toBe(200);
    for (const s of out) expect(s).toMatch(/^[0-9A-Za-z]{40}$/);
    // 8,000자에 62글자가 다 나온다 (한 글자가 한 번도 안 나올 확률은 0 에 가깝다)
    expect(new Set(out.join("")).size).toBe(62);
  });

  it("이름은 앞뒤 공백을 지우고 1~30자, 범위는 rw · ro", async () => {
    const a = await member();
    expect((await make(a, "  회사 PC  ")).name).toBe("회사 PC");
    expect((await make(a, "가".repeat(30))).name).toHaveLength(30);
    expect((await make(a, "읽기만", "ro")).scope).toBe("ro");
    await fails(make(a, "   "), "EZ_VALUE");
    await fails(make(a, "가".repeat(31)), "EZ_VALUE");
    await fails(make(a, "줄\n바꿈"), "EZ_VALUE");
    await fails(make(a, "노트북", "admin"), "EZ_VALUE");
    await fails(sql(a, "select ez_token_new(null)"), "EZ_VALUE");
  });

  it("관리자 · 켜진 회원만. 꺼진 회원 · 회원이 아닌 계정 · anon · service_role 은 못 만든다", async () => {
    expect((await make(ADMIN, "관리자 PC")).token).toMatch(TOKEN);
    await fails(make(await member(false)), "EZ_FORBIDDEN");
    await fails(make(randomUUID()), "EZ_FORBIDDEN");
    await fails(sql("anon", "select ez_token_new('x')"), "42501");
    await fails(sql("service", "select ez_token_new('x')"), "42501");
  });

  it("살아 있는 토큰은 10개까지 — 폐기하면 다시 만들 수 있다", async () => {
    const a = await member();
    const made: Made[] = [];
    for (let i = 0; i < 10; i++) made.push(await make(a, `PC ${i + 1}`));
    await fails(make(a, "열한 번째"), "EZ_LIMIT");
    await sql(a, "update ez_tokens set revoked_at = now() where id = $1", [made[0]!.id]);
    expect((await make(a, "열한 번째")).token).toMatch(TOKEN);
    await fails(make(a, "열두 번째"), "EZ_LIMIT");
    // 남의 것은 세지 않는다
    expect((await make(await member())).token).toMatch(TOKEN);
  });
});

describe("확인 (ez_token_check)", () => {
  it("service_role 만 부른다 — 통과하면 {id, owner, scope}", async () => {
    const a = await member();
    const t = await make(a, "읽기만", "ro");
    expect(await check(t.token)).toEqual({ id: t.id, owner: a, scope: "ro" });
    await fails(sql("anon", "select ez_token_check($1)", [t.token]), "42501");
    await fails(sql(a, "select ez_token_check($1)", [t.token]), "42501");
    await fails(sql(ADMIN, "select ez_token_check($1)", [t.token]), "42501");
  });

  it("모양이 다르거나 없는 토큰은 null", async () => {
    const t = await make(await member());
    expect(await check(null)).toBeNull();
    expect(await check("")).toBeNull();
    expect(await check(t.token.slice(4))).toBeNull();
    expect(await check(`${t.token} `)).toBeNull();
    expect(await check(`ezt_${"0".repeat(40)}`)).toBeNull();
    // 한 글자만 달라도
    const last = t.token.at(-1) === "a" ? "b" : "a";
    expect(await check(t.token.slice(0, -1) + last)).toBeNull();
    // 해시를 원문 자리에 넣어도
    expect(await check(sha(t.token))).toBeNull();
  });

  it("폐기하면 바로 null", async () => {
    const a = await member();
    const t = await make(a);
    expect(await check(t.token)).not.toBeNull();
    await sql(a, "update ez_tokens set revoked_at = now() where id = $1", [t.id]);
    expect(await check(t.token)).toBeNull();
  });

  it("꺼진 회원의 토큰은 null — 다시 켜면 통과 (폐기하지 않아도 막힌다)", async () => {
    const a = await member();
    const t = await make(a);
    await sql(ADMIN, "update ez_members set active = false where user_id = $1", [a]);
    expect(await check(t.token)).toBeNull();
    expect((await row(t.id)).revoked_at).toBeNull();
    await sql(ADMIN, "update ez_members set active = true where user_id = $1", [a]);
    expect(await check(t.token)).toMatchObject({ owner: a });
  });

  it("주인이 관리자도 회원도 아니게 되면 null (회원을 지운 뒤)", async () => {
    const a = await member();
    const t = await make(a);
    await sql("admin", "delete from auth.users where id = $1", [a]);
    expect(await check(t.token)).toBeNull();
  });

  it("관리자의 토큰도 통과", async () => {
    const t = await make(ADMIN, "관리자 노트북");
    expect(await check(t.token)).toEqual({ id: t.id, owner: ADMIN, scope: "rw" });
  });

  it("last_used_at 은 1분에 한 번만 적는다", async () => {
    const t = await make(await member());
    await check(t.token);
    const first = (await row(t.id)).last_used_at as Date;
    expect(first).toBeInstanceOf(Date);
    await check(t.token);
    expect(((await row(t.id)).last_used_at as Date).getTime()).toBe(first.getTime());
    await sql("admin", "update ez_tokens set last_used_at = now() - interval '2 minutes' where id = $1", [t.id]);
    const old = (await row(t.id)).last_used_at as Date;
    await check(t.token);
    expect(((await row(t.id)).last_used_at as Date).getTime()).toBeGreaterThan(old.getTime());
  });

  it("통과하지 못한 확인은 last_used_at 을 건드리지 않는다", async () => {
    const a = await member();
    const t = await make(a);
    await sql(a, "update ez_tokens set revoked_at = now() where id = $1", [t.id]);
    await check(t.token);
    expect((await row(t.id)).last_used_at).toBeNull();
  });
});

describe("RLS · 권한", () => {
  it("자기 줄만 보인다 — 해시 칸은 주인도 못 읽는다", async () => {
    const a = await member();
    const b = await member();
    const ta = await make(a, "A 것");
    await make(b, "B 것");
    const mine = await sql(a, `select ${COLS} from ez_tokens`);
    expect(mine.map((r) => r.id)).toEqual([ta.id]);
    expect(await sql(b, `select ${COLS} from ez_tokens where id = $1`, [ta.id])).toEqual([]);
    await fails(sql(a, "select hash from ez_tokens"), "42501");
    await fails(sql(a, "select * from ez_tokens"), "42501");
    await fails(sql("anon", `select ${COLS} from ez_tokens`), "42501");
    // 회원이 아닌 계정은 아무것도 안 보인다
    expect(await sql(randomUUID(), `select ${COLS} from ez_tokens`)).toEqual([]);
  });

  it("직접 넣지도 없애지도 못하고, 고칠 수 있는 것은 폐기뿐", async () => {
    const a = await member();
    const t = await make(a);
    await fails(sql(a, "insert into ez_tokens (name, hash, tail) values ('x', $1, 'abcd')", [sha("x")]), "42501");
    await fails(sql(a, "delete from ez_tokens where id = $1", [t.id]), "42501");
    await fails(sql(a, "update ez_tokens set name = '다른 이름' where id = $1", [t.id]), "42501");
    await fails(sql(a, "update ez_tokens set scope = 'rw' where id = $1", [t.id]), "42501");
    await fails(sql(a, "update ez_tokens set hash = $2 where id = $1", [t.id, sha("y")]), "42501");
    await fails(sql(a, "update ez_tokens set last_used_at = now() where id = $1", [t.id]), "42501");
    await fails(sql(a, "update ez_tokens set owner = $2 where id = $1", [t.id, randomUUID()]), "42501");
  });

  it("폐기: 시각은 DB 가 적고, 되살릴 수 없다", async () => {
    const a = await member();
    const t = await make(a);
    const out = await sql(a, "update ez_tokens set revoked_at = '2001-01-01T00:00:00Z' where id = $1 returning revoked_at", [t.id]);
    expect(out).toHaveLength(1);
    expect((out[0]!.revoked_at as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
    await fails(sql(a, "update ez_tokens set revoked_at = null where id = $1", [t.id]), "EZ_FIXED");
    await fails(sql(a, "update ez_tokens set revoked_at = now() + interval '1 day' where id = $1", [t.id]), "EZ_FIXED");
    expect(await check(t.token)).toBeNull();
  });

  it("남의 토큰은 폐기하지 못한다", async () => {
    const a = await member();
    const b = await member();
    const t = await make(a);
    expect(await sql(b, "update ez_tokens set revoked_at = now() where id = $1 returning id", [t.id])).toEqual([]);
    expect(await sql(b, "update ez_tokens set revoked_at = now() where owner = $1 returning id", [a])).toEqual([]);
    expect((await row(t.id)).revoked_at).toBeNull();
    expect(await check(t.token)).not.toBeNull();
  });

  it("관리자는 회원의 토큰을 세고 전부 폐기한다 (해시는 관리자도 못 읽는다)", async () => {
    const a = await member();
    const b = await member();
    const t1 = await make(a, "노트북");
    const t2 = await make(a, "데스크톱");
    const tb = await make(b);
    const live = await sql(ADMIN, "select id from ez_tokens where owner = $1 and revoked_at is null", [a]);
    expect(live.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());
    await fails(sql(ADMIN, "select hash from ez_tokens where owner = $1", [a]), "42501");
    const gone = await sql(ADMIN, "update ez_tokens set revoked_at = now() where owner = $1 and revoked_at is null returning id", [a]);
    expect(gone).toHaveLength(2);
    expect(await check(t1.token)).toBeNull();
    expect(await check(t2.token)).toBeNull();
    expect(await check(tb.token)).not.toBeNull();
  });

  it("service_role 은 테이블을 직접 만지지 못한다 (확인 함수 하나만)", async () => {
    await fails(sql("service", "select id from ez_tokens"), "42501");
    await fails(sql("service", "update ez_tokens set revoked_at = now()"), "42501");
    await fails(sql("service", "select public.ez_token_random(40)"), "42501");
    await fails(sql("service", "select public.ez_token_owner_ok($1)", [ADMIN]), "42501");
  });

  it("도우미는 로그인한 사람도 못 부른다", async () => {
    const a = await member();
    await fails(sql(a, "select public.ez_token_random(40)"), "42501");
    await fails(sql(a, "select public.ez_token_owner_ok($1)", [a]), "42501");
  });
});

describe("원격 적용 도구 제약", () => {
  it("0019 에는 줄 · 객체를 없애는 문장이 없다", () => {
    const text = readFileSync(new URL("./migrations/0019_ez_tokens.sql", import.meta.url), "utf8");
    expect(text).not.toMatch(/\b(delete|drop|truncate)\b/i);
  });
});
