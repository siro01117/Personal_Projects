// /api/mcp — 원격 MCP (docs/에이전트-연결.md 2장). Streamable HTTP · 상태 없음 · Authorization: Bearer ezt_… 몸통은 handlers.ts
import { mcpDeps } from "./client";
import { handleMcp } from "./handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (req: Request): Promise<Response> => handleMcp(req, mcpDeps());

// GET(스트림 열기) · DELETE(세션 끝내기)는 405 로 답한다 — 상태가 없다
export { handle as DELETE, handle as GET, handle as POST };
