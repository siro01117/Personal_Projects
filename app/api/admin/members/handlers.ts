// 회원 관리 서버 라우트의 몸통 (docs/회원.md 3장). route.ts 가 진짜 클라이언트를 넣고, 시험은 가짜를 넣는다.
// service_role 로 Supabase 를 만지는 곳은 여기뿐이다 — 이 파일은 서버에서만 불린다(브라우저 코드가 가져오지 않는다).
// 모든 요청은 Authorization: Bearer <세션 토큰> 으로 부른 사람을 확인하고 ez_admins 에 있어야 한다. 아니면 403.
// 실패는 { code, message } (code 는 EZ_…, message 는 한국어).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  keysError,
  MEMBER_DOMAIN,
  nameError,
  newMemberError,
  passwordError,
  type MemberPatch,
  type MemberRow,
  type NewMember,
} from "../../../../lib/members";

const COLS = "user_id, login_id, name, active, allowed, created_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PER_PAGE = 1000;

type Row = Omit<MemberRow, "last_sign_in_at">;

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? { "cache-control": "no-store" } : { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const err = (status: number, code: string, message: string) => json(status, { code, message });
const FORBIDDEN = () => err(403, "EZ_FORBIDDEN", "권한이 없습니다");
const NOT_FOUND = () => err(404, "EZ_NOT_FOUND", "없는 회원입니다");
/** what: "회원을 지우지" 처럼 "못했습니다" 앞까지 */
const SERVER = (what: string) => err(500, "EZ_SERVER", `${what} 못했습니다. 잠시 뒤 다시 하세요`);

/** 환경변수가 없으면 null — 라우트가 500 과 문구를 돌려준다 */
export type ClientOrNull = SupabaseClient | null;

export const NO_CONFIG = () => err(500, "EZ_CONFIG", "서버 설정이 없습니다 (EZ_SUPABASE_SERVICE_ROLE_KEY · NEXT_PUBLIC_SUPABASE_URL)");

/** 부른 사람이 관리자면 그 id, 아니면 돌려줄 응답 */
async function admin(req: Request, c: SupabaseClient): Promise<string | Response> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return FORBIDDEN();
  const { data, error } = await c.auth.getUser(m[1]);
  if (error || !data?.user) return FORBIDDEN();
  const { data: row, error: e2 } = await c.from("ez_admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (e2) return SERVER("관리자를 확인하지");
  return row ? data.user.id : FORBIDDEN();
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 허용 모듈 키가 다 있는 모듈인지 */
async function unknownKeys(c: SupabaseClient, keys: readonly string[]): Promise<boolean | Response> {
  if (keys.length === 0) return false;
  const { data, error } = await c.from("ez_modules").select("key");
  if (error) return SERVER("모듈을 확인하지");
  const have = new Set((data ?? []).map((r: { key: string }) => r.key));
  return keys.some((k) => !have.has(k));
}

async function lastSignIn(c: SupabaseClient, id: string): Promise<string | null> {
  const { data } = await c.auth.admin.getUserById(id);
  return data?.user?.last_sign_in_at ?? null;
}

async function target(c: SupabaseClient, id: string): Promise<Row | Response> {
  if (!UUID.test(id)) return NOT_FOUND();
  const { data, error } = await c.from("ez_members").select(COLS).eq("user_id", id).maybeSingle();
  if (error) return SERVER("회원을 확인하지");
  return data ? (data as Row) : NOT_FOUND();
}

// ---------------------------------------------------------------------------

/** 모든 Auth 사용자의 마지막 로그인 (id → 시각) */
async function signIns(c: SupabaseClient): Promise<Map<string, string | null> | Response> {
  const last = new Map<string, string | null>();
  for (let page = 1; ; page++) {
    const { data: users, error } = await c.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) return SERVER("로그인 기록을 읽지");
    for (const u of users.users) last.set(u.id, u.last_sign_in_at ?? null);
    if (users.users.length < PER_PAGE) break;
  }
  return last;
}

/**
 * GET /api/admin/members — 회원 목록 + 마지막 로그인.
 * 읽기 셋(관리자 확인 · 회원 줄 · 로그인 기록)을 한꺼번에 보낸다 — 차례로 하면 왕복이 넷. 결과는 관리자일 때만 돌려준다
 */
export async function listMembers(req: Request, c: ClientOrNull): Promise<Response> {
  if (!c) return NO_CONFIG();
  const [who, rows, last] = await Promise.all([admin(req, c), c.from("ez_members").select(COLS).order("created_at"), signIns(c)]);
  if (who instanceof Response) return who;
  if (rows.error) return SERVER("회원 목록을 읽지");
  if (last instanceof Response) return last;
  const members: MemberRow[] = ((rows.data ?? []) as Row[]).map((r) => ({ ...r, last_sign_in_at: last.get(r.user_id) ?? null }));
  return json(200, { members });
}

/** POST /api/admin/members {login_id, password, name, allowed} — Auth 사용자(메일 확인 끝난 것으로) + 회원 줄 */
export async function createMember(req: Request, c: ClientOrNull): Promise<Response> {
  if (!c) return NO_CONFIG();
  const who = await admin(req, c);
  if (who instanceof Response) return who;
  const b = await body(req);
  if (!b) return err(400, "EZ_VALUE", "보낸 내용이 맞지 않습니다");
  const input: NewMember = {
    login_id: typeof b.login_id === "string" ? b.login_id.trim().toLowerCase() : "",
    password: typeof b.password === "string" ? b.password : "",
    name: typeof b.name === "string" ? b.name.trim() : "",
    allowed: b.allowed === undefined ? [] : (b.allowed as string[]),
  };
  const bad = newMemberError(input);
  if (bad) return err(400, "EZ_VALUE", bad);
  const unknown = await unknownKeys(c, input.allowed);
  if (unknown instanceof Response) return unknown;
  if (unknown) return err(400, "EZ_VALUE", "없는 모듈입니다");

  const { data: dup, error: e1 } = await c.from("ez_members").select("user_id").eq("login_id", input.login_id).maybeSingle();
  if (e1) return SERVER("아이디를 확인하지");
  if (dup) return err(409, "EZ_TAKEN", "이미 있는 아이디입니다");

  const { data: made, error: e2 } = await c.auth.admin.createUser({
    email: `${input.login_id}@${MEMBER_DOMAIN}`,
    password: input.password,
    email_confirm: true,
    user_metadata: { name: input.name },
  });
  if (e2 || !made?.user) {
    const code = (e2 as { code?: string } | null)?.code ?? "";
    if (code === "email_exists" || code === "user_already_exists" || /already/i.test(e2?.message ?? "")) return err(409, "EZ_TAKEN", "이미 있는 아이디입니다");
    if (code === "weak_password") return err(400, "EZ_VALUE", "비밀번호가 너무 약합니다. 더 길게 하세요");
    return SERVER("계정을 만들지");
  }
  const id = made.user.id;
  const { data: row, error: e3 } = await c
    .from("ez_members")
    .insert({ user_id: id, login_id: input.login_id, name: input.name, allowed: input.allowed })
    .select(COLS)
    .single();
  if (e3 || !row) {
    // 회원 줄이 안 들어갔으면 방금 만든 Auth 사용자도 지운다 (반쪽 계정을 남기지 않는다)
    await c.auth.admin.deleteUser(id);
    if ((e3 as { code?: string } | null)?.code === "23505") return err(409, "EZ_TAKEN", "이미 있는 아이디입니다");
    return SERVER("회원을 넣지");
  }
  return json(201, { member: { ...(row as Row), last_sign_in_at: null } satisfies MemberRow });
}

/** PATCH /api/admin/members/[id] {password?, name?, active?, allowed?} */
export async function updateMember(req: Request, c: ClientOrNull, id: string): Promise<Response> {
  if (!c) return NO_CONFIG();
  const who = await admin(req, c);
  if (who instanceof Response) return who;
  const b = await body(req);
  if (!b) return err(400, "EZ_VALUE", "보낸 내용이 맞지 않습니다");
  const p: MemberPatch = {};
  if (b.password !== undefined) {
    if (typeof b.password !== "string") return err(400, "EZ_VALUE", "비밀번호가 맞지 않습니다");
    p.password = b.password;
  }
  if (b.name !== undefined) {
    if (typeof b.name !== "string") return err(400, "EZ_VALUE", "이름이 맞지 않습니다");
    p.name = b.name.trim();
  }
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") return err(400, "EZ_VALUE", "켬 · 끔이 맞지 않습니다");
    p.active = b.active;
  }
  if (b.allowed !== undefined) p.allowed = b.allowed as string[];
  const bad =
    (p.password !== undefined ? passwordError(p.password) : null) ??
    (p.name !== undefined ? nameError(p.name) : null) ??
    (p.allowed !== undefined ? keysError(p.allowed) : null);
  if (bad) return err(400, "EZ_VALUE", bad);
  // 읽기는 한꺼번에: 모듈 키 확인 · 고칠 회원 · 마지막 로그인
  const [unknown, t, last] = await Promise.all([
    p.allowed ? unknownKeys(c, p.allowed) : false,
    target(c, id),
    UUID.test(id) ? lastSignIn(c, id).catch(() => null) : null,
  ]);
  if (unknown instanceof Response) return unknown;
  if (unknown) return err(400, "EZ_VALUE", "없는 모듈입니다");
  if (t instanceof Response) return t;

  if (p.password !== undefined) {
    const { error } = await c.auth.admin.updateUserById(id, { password: p.password });
    if (error) {
      if ((error as { code?: string }).code === "weak_password") return err(400, "EZ_VALUE", "비밀번호가 너무 약합니다. 더 길게 하세요");
      return SERVER("비밀번호를 바꾸지");
    }
  }
  let row: Row = t;
  const cols: Partial<Pick<Row, "name" | "active" | "allowed">> = {};
  if (p.name !== undefined) cols.name = p.name;
  if (p.active !== undefined) cols.active = p.active;
  if (p.allowed !== undefined) cols.allowed = p.allowed;
  if (Object.keys(cols).length > 0) {
    const { data, error } = await c.from("ez_members").update(cols).eq("user_id", id).select(COLS).single();
    if (error || !data) return SERVER("회원을 고치지");
    row = data as Row;
  }
  return json(200, { member: { ...row, last_sign_in_at: last } satisfies MemberRow });
}

/** DELETE /api/admin/members/[id] — Auth 사용자째 (회원 줄은 cascade). 그 회원의 데이터는 남는다 */
export async function deleteMember(req: Request, c: ClientOrNull, id: string): Promise<Response> {
  if (!c) return NO_CONFIG();
  const who = await admin(req, c);
  if (who instanceof Response) return who;
  const t = await target(c, id);
  if (t instanceof Response) return t;
  const { error } = await c.auth.admin.deleteUser(id);
  if (error) return SERVER("회원을 지우지");
  return json(204, null);
}

