// 원격 MCP 라우트의 진짜 의존 (서버 전용). 키는 서버 환경변수에만 있다 — NEXT_PUBLIC_ 이 아니라 브라우저 번들에 박히지 않는다. 이 파일은 route.ts 만 가져온다.
//
// 남의 데이터 차단 (docs/에이전트-연결.md 2장):
//   (가) EZ_SUPABASE_JWT_SECRET 이 있으면 — 토큰 주인의 JWT 를 만들어 그 사람의 권한으로 DB 에 들어간다. RLS 가 막는다
//   (나) 없으면 — service_role + 스토어의 owner 조건 (로컬 MCP 와 같은 길)
// 어느 쪽이든 토큰 확인(ez_token_check)은 service_role 로 한다 — 그 함수는 service_role 에만 열려 있다.

import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseMeetStore } from "../../../mcp/meet-store-supabase";
import { SupabaseScheduleStore } from "../../../mcp/schedule-store-supabase";
import { SupabaseStore } from "../../../mcp/store-supabase";
import { serviceClient, userClient, type StoreClient } from "../../../mcp/supabase-client";
import { parseTokenInfo, type McpDeps } from "./handlers";
import { userJwt } from "./jwt";
import { Limiter } from "./limit";

let deps: McpDeps | null = null;

/** 환경변수가 없으면 null (라우트가 500 과 문구를 돌려준다) */
export function mcpDeps(): McpDeps | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.EZ_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (deps) return deps;
  const service: SupabaseClient = serviceClient(url, key);
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.EZ_SUPABASE_JWT_SECRET;
  deps = {
    async check(token) {
      const { data, error } = await service.rpc("ez_token_check", { p_token: token });
      if (error) throw new Error(error.message);
      return parseTokenInfo(data);
    },
    stores(owner) {
      const as: StoreClient = secret && anon ? { client: userClient(url, anon, userJwt(secret, owner)), asUser: true } : { client: service };
      // client 를 넘기므로 스토어는 url · 키로 따로 만들지 않는다
      return {
        drawer: new SupabaseStore(url, "", owner, as),
        schedule: new SupabaseScheduleStore(url, "", owner, as),
        meet: new SupabaseMeetStore(url, "", owner, as),
      };
    },
    limiter: new Limiter(),
    ...(process.env.EZ_WEB_URL ? { webUrl: process.env.EZ_WEB_URL } : {}),
    agent: process.env.EZ_AGENT_NAME || "Claude",
  };
  return deps;
}
