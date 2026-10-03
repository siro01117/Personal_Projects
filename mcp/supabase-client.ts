// Supabase 스토어들이 쓰는 클라이언트. 로컬 MCP(stdio)는 service_role 하나, 원격 MCP(/api/mcp)는 요청마다 토큰 주인에 맞춰 만든다.
// (나) service_role: RLS 를 우회한다 — 스토어가 모든 쿼리에 owner 조건을 직접 건다.
// (가) 주인의 권한: 공개(anon) 키 + 그 사람의 JWT — RLS(owner = auth.uid())가 남의 것을 막는다. 스토어의 owner 조건은 그대로 둔다(겹쳐 막는다).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

export type StoreClient = {
  /** 이미 만든 클라이언트를 쓴다 (없으면 url · service_role 키로 만든다) */
  client?: SupabaseClient;
  /** client 가 주인의 권한(RLS)으로 도는 것이면 true — service_role 만 되는 길을 피한다 */
  asUser?: boolean;
};

export function serviceClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, { auth: AUTH });
}

/** 그 사람의 JWT 로 도는 클라이언트 (PostgREST 가 role = authenticated, auth.uid() = sub 로 실행한다) */
export function userClient(url: string, anonKey: string, jwt: string): SupabaseClient {
  return createClient(url, anonKey, { auth: AUTH, accessToken: async () => jwt });
}
