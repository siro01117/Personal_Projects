// 에이전트 연결 — 개인 토큰 (docs/에이전트-연결.md 1 · 3장) — 진짜 구현. 로그인한 사람의 세션 + RLS (0019).
// 만들기는 DB 함수 ez_token_new (원문은 그 답에만 있다), 폐기는 revoked_at 을 적는다. 해시 칸은 읽을 권한이 없다.
// 관리자는 RLS 가 모든 줄을 보여 주므로 내 목록에는 owner 조건을 직접 건다.

import { DbError } from "../../lib/errors";
import type { MadeToken, TokenRow, TokenScope } from "../../lib/tokens";
import { run, sb } from "./supabase";
import type { TokenData } from "./types";

const COLS = "id, name, tail, scope, last_used_at, created_at";

async function myId(): Promise<string> {
  const { data } = await sb().auth.getSession();
  const id = data.session?.user.id;
  if (!id) throw new DbError("로그인이 풀렸습니다", "PGRST301");
  return id;
}

export class SupabaseTokens implements TokenData {
  private table() {
    return sb().from("ez_tokens");
  }

  async list(): Promise<TokenRow[]> {
    return run<TokenRow[]>(this.table().select(COLS).eq("owner", await myId()).is("revoked_at", null).order("created_at").order("id"));
  }

  async create(name: string, scope: TokenScope): Promise<MadeToken> {
    const made = await run<Omit<MadeToken, "last_used_at">>(sb().rpc("ez_token_new", { p_name: name, p_scope: scope }));
    return { ...made, last_used_at: null };
  }

  async revoke(id: string): Promise<void> {
    const rows = await run<{ id: string }[]>(
      this.table().update({ revoked_at: new Date().toISOString() }).eq("owner", await myId()).eq("id", id).is("revoked_at", null).select("id"),
    );
    if (rows.length === 0) throw new DbError("[EZ_NOT_FOUND] 이미 폐기했거나 없는 토큰입니다", "P0001");
  }

  async countOf(userId: string): Promise<number> {
    const rows = await run<{ id: string }[]>(this.table().select("id").eq("owner", userId).is("revoked_at", null));
    return rows.length;
  }

  async revokeAllOf(userId: string): Promise<number> {
    const rows = await run<{ id: string }[]>(
      this.table().update({ revoked_at: new Date().toISOString() }).eq("owner", userId).is("revoked_at", null).select("id"),
    );
    return rows.length;
  }
}
