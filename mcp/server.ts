// 보고서 서랍 로컬 MCP 서버 (stdio). Claude Code 가 .mcp.json 으로 실행한다: npx tsx mcp/server.ts
// stdout 은 MCP 통신 전용 — 로그는 stderr 로만. 키 값은 어디에도 쓰지 않는다.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDrawer } from "./drawer";
import { loadEnv } from "./env";
import { SupabaseStore } from "./store-supabase";
import { registerTools } from "./tools";

const loaded = loadEnv();
if ("error" in loaded) {
  process.stderr.write(loaded.error + "\n");
  process.exit(1);
}
const { env } = loaded;

const store = new SupabaseStore(env.EZ_SUPABASE_URL, env.EZ_SUPABASE_SERVICE_ROLE_KEY, env.EZ_OWNER_ID);
const server = new McpServer({ name: "ez-drawer", version: "0.1.0" });
registerTools(server, createDrawer({ store, agent: env.EZ_AGENT_NAME }));

try {
  await server.connect(new StdioServerTransport());
  process.stderr.write("보고서 서랍 MCP 준비됨\n");
} catch (e) {
  process.stderr.write(`보고서 서랍 MCP 시작 실패: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
