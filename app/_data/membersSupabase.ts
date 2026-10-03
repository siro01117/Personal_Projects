// 회원 · 추가 모듈 (docs/회원.md) — 진짜 구현. 나(ez_me · ez_set_picked)와 모듈 표는 로그인한 사람의 세션 + RLS 로,
// 회원 만들기 · 고치기 · 지우기는 서버 라우트(/api/admin/members)로 간다 — service_role 은 서버에만 있다.
// 라우트에는 세션 토큰을 Authorization: Bearer 로 싣는다. 라우트가 그 토큰으로 부른 사람을 확인한다.

import { DbError } from "../../lib/errors";
import { moduleKeyFrom, type Me, type MemberPatch, type MemberRow, type ModuleRow, type NewMember, type NewModule } from "../../lib/members";
import { KEY, type DataCache } from "./cache";
import { run, sb } from "./supabase";
import type { AdminData, MeData } from "./types";

const MODULE_COLS = "key, name, kind, href, sort";
const API = "/api/admin/members";

export class SupabaseMe implements MeData {
  constructor(private readonly cache: DataCache) {}

  me(): Promise<Me> {
    return this.cache.read(KEY.me, () => run<Me>(sb().rpc("ez_me")));
  }

  async setPicked(keys: string[]): Promise<string[]> {
    const picked = await run<string[]>(sb().rpc("ez_set_picked", { p_picked: keys }));
    // 서버가 돌려준 값으로 담아 둔 나를 고친다 (다음 첫 그림이 맞게)
    const had = this.cache.peek<Me>(KEY.me);
    if (had) this.cache.set(KEY.me, { ...had, picked });
    return picked;
  }
}

/** 라우트의 실패 { code, message } → DbError('[EZ_…] 문구') — 화면은 toKorean 으로 문구만 꺼낸다 */
async function call<T>(path: string, init: { method: string; body?: unknown } = { method: "GET" }): Promise<T> {
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new DbError("로그인이 풀렸습니다", "PGRST301");
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch (e) {
    throw new DbError(`fetch failed: ${e instanceof Error ? e.message : String(e)}`, "NETWORK");
  }
  const out: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = (out ?? {}) as { code?: string; message?: string };
    const code = err.code?.startsWith("EZ_") ? err.code : "EZ_SERVER";
    throw new DbError(`[${code}] ${err.message ?? `서버가 거절했습니다 (${res.status})`}`, "P0001");
  }
  return out as T;
}

export class SupabaseAdmin implements AdminData {
  constructor(private readonly cache: DataCache) {}

  members(): Promise<MemberRow[]> {
    return call<{ members: MemberRow[] }>(API).then((r) => r.members);
  }

  createMember(input: NewMember): Promise<MemberRow> {
    return call<{ member: MemberRow }>(API, { method: "POST", body: input }).then((r) => r.member);
  }

  updateMember(id: string, patch: MemberPatch): Promise<MemberRow> {
    return call<{ member: MemberRow }>(`${API}/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }).then((r) => r.member);
  }

  async deleteMember(id: string): Promise<void> {
    await call<null>(`${API}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  modules(): Promise<ModuleRow[]> {
    return run<ModuleRow[]>(sb().from("ez_modules").select(MODULE_COLS).order("sort").order("key"));
  }

  async createModule(input: NewModule): Promise<ModuleRow> {
    const now = await this.modules();
    const key = moduleKeyFrom(input.name, now.map((m) => m.key));
    const sort = now.reduce((a, m) => Math.max(a, m.sort), 0) + 10;
    try {
      return await run<ModuleRow>(sb().from("ez_modules").insert({ key, name: input.name, kind: "link", href: input.href, sort }).select(MODULE_COLS).single());
    } finally {
      this.cache.drop(KEY.me);
    }
  }

  async deleteModule(key: string): Promise<void> {
    try {
      await run(sb().from("ez_modules").delete().eq("key", key));
    } finally {
      this.cache.drop(KEY.me);
    }
  }
}
