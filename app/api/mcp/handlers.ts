// 원격 MCP 라우트의 몸통 (docs/에이전트-연결.md 2장). route.ts 가 진짜 의존(Supabase)을 넣고, 시험은 PGlite 스토어를 넣는다.
// Streamable HTTP, 상태 없음: 요청마다 서버 · 전송을 새로 만들고 JSON 한 번으로 답한다 (세션 · SSE 없음).
// 순서: POST 인지 → Authorization: Bearer ezt_… 모양 → 크기 → 한도 → 토큰 확인(ez_token_check) → 그 주인의 스토어로 도구 등록 → 처리.
// 실패는 HTTP 상태 + JSON-RPC 오류 본문. 토큰 원문은 어디에도 적지 않는다 (한도 열쇠도 해시).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHash } from "node:crypto";
import { createDrawer } from "../../../mcp/drawer";
import { createMeet } from "../../../mcp/meet";
import type { MeetStore } from "../../../mcp/meet-store";
import { readOnlyMeet, readOnlySchedule, readOnlyStore } from "../../../mcp/readonly";
import { createSchedule } from "../../../mcp/schedule";
import type { ScheduleStore } from "../../../mcp/schedule-store";
import type { Store } from "../../../mcp/store";
import { registerTools } from "../../../mcp/tools";
import type { Limiter } from "./limit";

export const TOKEN_SHAPE = /^ezt_[0-9A-Za-z]{40}$/;
/** 요청 본문 상한 (1MB) */
export const MAX_BODY_BYTES = 1_000_000;
export const SERVER_INFO = { name: "ezwork", version: "0.1.0" } as const;

/** JSON-RPC 오류 코드 (구현이 정하는 -32000 ~ -32099 안, 서버 오류는 -32603) */
export const RPC = { BAD: -32000, AUTH: -32001, RATE: -32002, SERVER: -32603 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TokenInfo = { id: string; owner: string; scope: "rw" | "ro" };
export type Stores = { drawer: Store; schedule: ScheduleStore; meet: MeetStore };

export type McpDeps = {
  /** ez_token_check — 통과하면 주인 · 범위, 아니면 null. DB 에 못 닿으면 던진다 */
  check: (token: string) => Promise<TokenInfo | null>;
  /** 그 주인의 것만 보고 고치는 스토어 셋 */
  stores: (owner: string) => Stores;
  limiter: Limiter;
  /** 결과에 싣는 웹 링크 앞부분. 없으면 요청이 온 주소 */
  webUrl?: string;
  /** 보고서에 적히는 에이전트 이름 */
  agent?: string;
  now?: () => Date;
};

function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const unauthorized = () =>
  rpcError(401, RPC.AUTH, "토큰이 없거나 맞지 않습니다 — EZ.WORK 설정의 에이전트 연결에서 토큰을 만들어 Authorization: Bearer 로 보내세요", {
    "www-authenticate": 'Bearer realm="ezwork", error="invalid_token"',
  });

/** Authorization: Bearer ezt_… 에서 토큰. 모양이 다르면 null (DB 에 묻지 않는다) */
export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m && TOKEN_SHAPE.test(m[1]!) ? m[1]! : null;
}

/** ez_token_check 가 준 것 → TokenInfo. 모양이 다르면 null (통과시키지 않는다) */
export function parseTokenInfo(v: unknown): TokenInfo | null {
  if (typeof v !== "object" || v === null) return null;
  const { id, owner, scope } = v as Record<string, unknown>;
  if (typeof id !== "string" || typeof owner !== "string" || !UUID.test(id) || !UUID.test(owner)) return null;
  // 모르는 범위는 읽기만으로 (넓게 열지 않는다)
  return { id, owner, scope: scope === "rw" ? "rw" : "ro" };
}

/** 그 토큰의 주인 · 범위에 맞춰 도구를 단 서버. 읽기만 되는 토큰은 쓰는 도구가 없고 스토어도 읽기만 된다 */
export function buildServer(info: TokenInfo, deps: McpDeps, webUrl: string): McpServer {
  const ro = info.scope !== "rw";
  const s = deps.stores(info.owner);
  const drawer = ro ? readOnlyStore(s.drawer) : s.drawer;
  const schedule = ro ? readOnlySchedule(s.schedule) : s.schedule;
  const meet = ro ? readOnlyMeet(s.meet) : s.meet;
  const now = deps.now ? { now: deps.now } : {};
  const server = new McpServer(SERVER_INFO);
  registerTools(
    server,
    // images: false — 서버는 그 PC 의 파일을 읽을 수 없고, 서버의 파일을 읽어서도 안 된다
    createDrawer({ store: drawer, agent: deps.agent ?? "Claude", webUrl, images: false, ...now }),
    createSchedule({ store: schedule, ...now }),
    createMeet({ store: meet, schedule, webUrl, ...now }),
    { readOnly: ro, remote: true },
  );
  return server;
}

export async function handleMcp(req: Request, deps: McpDeps | null): Promise<Response> {
  if (req.method !== "POST") return rpcError(405, RPC.BAD, "POST 만 받습니다 (상태 없는 Streamable HTTP — 스트림 · 세션 없음)", { allow: "POST" });
  const token = bearer(req);
  if (!token) return unauthorized();
  if (!deps) return rpcError(500, RPC.SERVER, "서버 설정이 없습니다 (EZ_SUPABASE_SERVICE_ROLE_KEY · NEXT_PUBLIC_SUPABASE_URL)");
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return rpcError(413, RPC.BAD, "요청이 너무 큽니다 (1MB 까지)");

  const now = deps.now ? deps.now() : new Date();
  const taken = deps.limiter.take(createHash("sha256").update(token).digest("hex"), now.getTime());
  if (!taken.ok) {
    return rpcError(429, RPC.RATE, `요청이 너무 많습니다 (토큰당 1분 ${deps.limiter.limit}회) — ${taken.retryAfterSec}초 뒤에 다시 하세요`, {
      "retry-after": String(taken.retryAfterSec),
    });
  }

  let info: TokenInfo | null;
  try {
    info = await deps.check(token);
  } catch {
    return rpcError(503, RPC.SERVER, "토큰을 확인하지 못했습니다. 잠시 뒤 다시 하세요");
  }
  if (!info) return unauthorized();

  let server: McpServer | null = null;
  try {
    server = buildServer(info, deps, deps.webUrl ?? new URL(req.url).origin);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    res.headers.set("cache-control", "no-store");
    return res;
  } catch {
    return rpcError(500, RPC.SERVER, "요청을 처리하지 못했습니다. 잠시 뒤 다시 하세요");
  } finally {
    // 요청 하나로 끝 — 남기는 것 없이 닫는다 (JSON 응답은 이미 다 만들어졌다)
    void server?.close().catch(() => {});
  }
}
