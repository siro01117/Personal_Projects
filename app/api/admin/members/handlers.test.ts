// 회원 관리 라우트 (docs/회원.md 3 · 5장): Supabase 클라이언트를 가짜로 바꿔 몸통(handlers.ts)만 돌린다.
// 가짜는 이 라우트가 쓰는 모양만 흉내 낸다 — auth.getUser · auth.admin.* · from(표).select/eq/order/insert/update/maybeSingle/single.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { MEMBER_DOMAIN, type MemberRow } from "../../../../lib/members";
import { createMember, deleteMember, listMembers, updateMember } from "./handlers";

type User = { id: string; email: string; password: string; email_confirm: boolean; last_sign_in_at: string | null };
type Rows = Record<string, Record<string, unknown>[]>;

class FakeSupabase {
  users = new Map<string, User>();
  tokens = new Map<string, string>();
  tables: Rows = { ez_admins: [], ez_members: [], ez_modules: [] };
  /** 다음 ez_members insert 를 실패시킨다 (되돌리기 시험) */
  failInsert = false;
  private n = 0;

  /** 로그인한 사람 하나 (토큰을 돌려준다) */
  signIn(id: string): string {
    const t = `token-${id}`;
    this.tokens.set(t, id);
    return t;
  }

  newId(): string {
    return `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
  }

  auth = {
    getUser: async (token: string) => {
      const id = this.tokens.get(token);
      return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
    },
    admin: {
      createUser: async (a: { email: string; password: string; email_confirm: boolean }) => {
        if ([...this.users.values()].some((u) => u.email === a.email)) return { data: { user: null }, error: { code: "email_exists", message: "already registered" } };
        const u: User = { id: this.newId(), email: a.email, password: a.password, email_confirm: a.email_confirm, last_sign_in_at: null };
        this.users.set(u.id, u);
        return { data: { user: { id: u.id } }, error: null };
      },
      updateUserById: async (id: string, a: { password?: string }) => {
        const u = this.users.get(id);
        if (!u) return { data: { user: null }, error: { message: "not found" } };
        if (a.password !== undefined) u.password = a.password;
        return { data: { user: u }, error: null };
      },
      deleteUser: async (id: string) => {
        if (!this.users.delete(id)) return { data: null, error: { message: "not found" } };
        // on delete cascade
        this.tables.ez_members = this.tables.ez_members!.filter((r) => r.user_id !== id);
        return { data: null, error: null };
      },
      listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
        const all = [...this.users.values()];
        return { data: { users: all.slice((page - 1) * perPage, page * perPage) }, error: null };
      },
      getUserById: async (id: string) => ({ data: { user: this.users.get(id) ?? null }, error: null }),
    },
  };

  from(table: string) {
    return new Query(this, table);
  }
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: "select" | "insert" | "update" = "select";
  private filters: [string, unknown][] = [];
  private payload: Record<string, unknown> = {};
  private one: "many" | "single" | "maybe" = "many";

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select() {
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push([col, v]);
    return this;
  }
  order() {
    return this;
  }
  insert(row: Record<string, unknown>) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(patch: Record<string, unknown>) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  maybeSingle() {
    this.one = "maybe";
    return this;
  }
  single() {
    this.one = "single";
    return this;
  }

  private run(): { data: unknown; error: unknown } {
    const rows = this.db.tables[this.table]!;
    const hit = (r: Record<string, unknown>) => this.filters.every(([c, v]) => r[c] === v);
    let out: Record<string, unknown>[];
    if (this.op === "insert") {
      if (this.db.failInsert) {
        this.db.failInsert = false;
        return { data: null, error: { code: "XX000", message: "boom" } };
      }
      if (rows.some((r) => r.login_id === this.payload.login_id)) return { data: null, error: { code: "23505", message: "duplicate" } };
      const row = { active: true, created_at: new Date().toISOString(), ...this.payload };
      rows.push(row);
      out = [row];
    } else if (this.op === "update") {
      out = rows.filter(hit);
      for (const r of out) Object.assign(r, this.payload);
    } else out = rows.filter(hit);
    const copy = out.map((r) => ({ ...r }));
    if (this.one === "many") return { data: copy, error: null };
    if (this.one === "single" && copy.length !== 1) return { data: null, error: { code: "PGRST116", message: "not one" } };
    return { data: copy[0] ?? null, error: null };
  }

  then<A, B>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, no?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, no);
  }
}

const ADMIN = "00263c79-cc44-4b7a-a846-ab9d43f4e718";

function setup() {
  const f = new FakeSupabase();
  f.tables.ez_admins!.push({ user_id: ADMIN });
  f.tables.ez_modules!.push({ key: "study" }, { key: "wiki" });
  f.users.set(ADMIN, { id: ADMIN, email: "owner@example.com", password: "x", email_confirm: true, last_sign_in_at: "2026-10-03T00:00:00Z" });
  const c = f as unknown as SupabaseClient;
  return { f, c, adminToken: f.signIn(ADMIN) };
}

const URL_ = "http://localhost/api/admin/members";
const req = (method: string, token: string | null, body?: unknown) =>
  new Request(URL_, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const read = async (r: Response) => ({ status: r.status, body: r.status === 204 ? null : ((await r.json()) as any) });

describe("부른 사람 확인", () => {
  it("토큰 없음 · 틀린 토큰 · 관리자가 아닌 토큰은 403. 아무것도 안 바뀐다", async () => {
    const { f, c } = setup();
    const memberToken = f.signIn("11111111-1111-4111-8111-111111111111");
    for (const token of [null, "nope", memberToken]) {
      expect((await read(await listMembers(req("GET", token), c))).status).toBe(403);
      const made = await read(await createMember(req("POST", token, { login_id: "abc", password: "12345678", name: "가", allowed: [] }), c));
      expect(made).toEqual({ status: 403, body: { code: "EZ_FORBIDDEN", message: "권한이 없습니다" } });
      expect((await read(await updateMember(req("PATCH", token, { name: "나" }), c, ADMIN))).status).toBe(403);
      expect((await read(await deleteMember(req("DELETE", token), c, ADMIN))).status).toBe(403);
    }
    expect(f.users.size).toBe(1);
    expect(f.tables.ez_members).toEqual([]);
  });

  it("Bearer 가 아닌 머리는 403", async () => {
    const { c, adminToken } = setup();
    const r = new Request(URL_, { headers: { authorization: `Basic ${adminToken}` } });
    expect((await listMembers(r, c)).status).toBe(403);
  });

  it("환경변수가 없으면(클라이언트 없음) 500 + 한국어", async () => {
    const r = await read(await listMembers(req("GET", "x"), null));
    expect(r.status).toBe(500);
    expect(r.body.code).toBe("EZ_CONFIG");
    expect(r.body.message).toMatch(/EZ_SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("관리자: 만들기 → 목록 → 비밀번호 → 끄기 → 지우기", () => {
  it("한 바퀴", async () => {
    const { f, c, adminToken } = setup();

    // 만들기: 아이디는 소문자로, 이메일은 아이디@members.ra-kan.cloud, 메일 확인 끝난 것으로
    const made = await read(await createMember(req("POST", adminToken, { login_id: " MinSeo ", password: "pass1234", name: "김민서", allowed: ["study"] }), c));
    expect(made.status).toBe(201);
    const m = made.body.member as MemberRow;
    expect(m).toMatchObject({ login_id: "minseo", name: "김민서", active: true, allowed: ["study"], last_sign_in_at: null });
    const user = f.users.get(m.user_id)!;
    expect(user).toMatchObject({ email: `minseo@${MEMBER_DOMAIN}`, password: "pass1234", email_confirm: true });

    // 같은 아이디 → 409
    const dup = await read(await createMember(req("POST", adminToken, { login_id: "minseo", password: "pass1234", name: "또", allowed: [] }), c));
    expect(dup).toEqual({ status: 409, body: { code: "EZ_TAKEN", message: "이미 있는 아이디입니다" } });

    // 목록: 마지막 로그인은 auth.users 에서
    user.last_sign_in_at = "2026-10-04T01:02:03Z";
    const list = await read(await listMembers(req("GET", adminToken), c));
    expect(list.status).toBe(200);
    expect(list.body.members).toEqual([expect.objectContaining({ user_id: m.user_id, login_id: "minseo", last_sign_in_at: "2026-10-04T01:02:03Z" })]);

    // 비밀번호 다시 정하기
    const pw = await read(await updateMember(req("PATCH", adminToken, { password: "newpass99" }), c, m.user_id));
    expect(pw.status).toBe(200);
    expect(user.password).toBe("newpass99");

    // 끄기 · 이름 · 허용
    const off = await read(await updateMember(req("PATCH", adminToken, { active: false, name: "민서", allowed: ["study", "wiki"] }), c, m.user_id));
    expect(off.status).toBe(200);
    expect(off.body.member).toMatchObject({ active: false, name: "민서", allowed: ["study", "wiki"], last_sign_in_at: "2026-10-04T01:02:03Z" });

    // 지우기: Auth 사용자째, 회원 줄도
    const del = await read(await deleteMember(req("DELETE", adminToken), c, m.user_id));
    expect(del.status).toBe(204);
    expect(f.users.has(m.user_id)).toBe(false);
    expect(f.tables.ez_members).toEqual([]);
    expect((await read(await deleteMember(req("DELETE", adminToken), c, m.user_id))).status).toBe(404);
  });
});

describe("검사", () => {
  it("만들기: 아이디 · 비밀번호 · 이름 · 허용 모듈 규칙, 깨진 몸통", async () => {
    const { f, c, adminToken } = setup();
    const bad = async (b: unknown) => read(await createMember(req("POST", adminToken, b), c));
    expect((await bad({ login_id: "ab", password: "12345678", name: "가" })).body.message).toMatch(/아이디/);
    expect((await bad({ login_id: "abc", password: "1234567", name: "가" })).body.message).toMatch(/8자/);
    expect((await bad({ login_id: "abc", password: "12345678", name: "" })).body.message).toMatch(/이름/);
    expect((await bad({ login_id: "abc", password: "12345678", name: "가", allowed: ["Bad"] })).body.message).toMatch(/모듈/);
    expect((await bad({ login_id: "abc", password: "12345678", name: "가", allowed: ["nope"] })).body.message).toBe("없는 모듈입니다");
    expect((await bad("{깨짐")).status).toBe(400);
    expect((await bad([1, 2])).status).toBe(400);
    expect(f.users.size).toBe(1);
  });

  it("회원 줄이 안 들어가면 방금 만든 Auth 사용자를 지운다", async () => {
    const { f, c, adminToken } = setup();
    f.failInsert = true;
    const r = await read(await createMember(req("POST", adminToken, { login_id: "abc", password: "12345678", name: "가" }), c));
    expect(r.status).toBe(500);
    expect(f.users.size).toBe(1);
  });

  it("고치기 · 지우기: 없는 회원 · uuid 아님 · 관리자 자신은 404, 잘못된 값은 400", async () => {
    const { f, c, adminToken } = setup();
    for (const id of ["00000000-0000-4000-8000-000000000999", "not-a-uuid", ADMIN]) {
      expect((await read(await updateMember(req("PATCH", adminToken, { name: "가" }), c, id))).status).toBe(404);
      expect((await read(await deleteMember(req("DELETE", adminToken), c, id))).status).toBe(404);
    }
    expect(f.users.has(ADMIN)).toBe(true);
    const made = await read(await createMember(req("POST", adminToken, { login_id: "abc", password: "12345678", name: "가" }), c));
    const id = made.body.member.user_id as string;
    expect((await read(await updateMember(req("PATCH", adminToken, { password: "short" }), c, id))).status).toBe(400);
    expect((await read(await updateMember(req("PATCH", adminToken, { active: "no" }), c, id))).status).toBe(400);
    expect((await read(await updateMember(req("PATCH", adminToken, { allowed: ["ghost"] }), c, id))).body.message).toBe("없는 모듈입니다");
  });
});
