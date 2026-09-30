// 실제 원격 스모크: .mcp.json 의 명령 그대로 MCP 서버를 띄우고(stdio) 실제 Supabase 에
// /_smoke 폴더 만들기 → 보고서 넣기 → 읽기 → 고치기 → 폴더째 삭제(ez_delete) 를 한 바퀴 돈다.
// 끝나면 살아 있는 /_smoke 가 없어야 한다 (지운 행은 휴지통 상태로 남는 게 정상). 실행: npm run smoke

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sampleBlocks } from "../lib/fixtures";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const { command, args } = config.mcpServers["ez-drawer"] as { command: string; args: string[] };

const transport = new StdioClientTransport({ command, args, cwd: ROOT, stderr: "pipe" });
transport.stderr?.on("data", (d) => process.stderr.write(`  [server] ${d}`));
const client = new Client({ name: "ez-smoke", version: "0" });

type Res = { ok: boolean; summary: string; data: any };
let step = 0;
let failed = false;

async function call(name: string, a: Record<string, unknown>, expectOk = true): Promise<Res> {
  const r = (await client.callTool({ name, arguments: a })) as { isError?: boolean; content: { text: string }[] };
  const res: Res = { ok: !r.isError, summary: r.content[0]?.text ?? "", data: JSON.parse(r.content[1]?.text ?? "{}") };
  const pass = res.ok === expectOk;
  if (!pass) failed = true;
  console.log(`${pass ? "OK  " : "FAIL"} ${++step}. ${name} — ${res.summary}`);
  return res;
}

await client.connect(transport);
const { tools } = await client.listTools();
console.log(`도구 ${tools.length}개: ${tools.map((t) => t.name).join(", ")}`);

let created = false;
try {
  const before = await call("drawer_list", { path: "/" });
  if (before.data.items.some((i: any) => i.name.toLowerCase() === "_smoke")) {
    console.log("이전 실행이 남긴 /_smoke 를 먼저 지웁니다");
    await call("drawer_update", { target: "/_smoke", delete: true });
  }

  const mk = await call("drawer_mkdir", { path: "/_smoke/하위" });
  created = mk.ok;
  await call("drawer_mkdir", { path: "/_SMOKE/하위" }); // 이미 있음 → created: false

  const rep = await call("report_create", { title: "스모크 보고서", kind: "reference", folder: "/_smoke/하위", blocks: sampleBlocks() });
  const id = rep.data.id as string;
  await call("report_create", { title: "틀린 보고서", kind: "data", folder: "/_smoke", blocks: [{ type: "text" }] }, false);
  await call("report_create", { title: "x", kind: "data", folder: "/_smoke/없음", blocks: sampleBlocks() }, false);

  const outline = await call("report_get", { id });
  await call("report_get", { id, from: 3, to: 4 });
  await call("report_get", { id, from: 0, to: 99 }, false);

  const v = outline.data.version as number;
  const edited = await call("report_edit", {
    id,
    base_version: v,
    ops: [
      { op: "replace", at: 2, block: { type: "text", body: "스모크로 고친 문단" } },
      { op: "insert", at: 3, block: { type: "list", h: "추가", items: ["하나", "둘"] } },
    ],
  });
  await call("report_edit", { id, base_version: v, ops: [{ op: "remove", at: 0 }] }, false); // 충돌
  const after = await call("report_get", { id, from: 2, to: 3 });
  if (after.data.version !== edited.data.version || after.data.blocks[0].body !== "스모크로 고친 문단") {
    failed = true;
    console.log("FAIL 고친 내용이 읽히지 않습니다");
  }

  await call("drawer_list", { path: "/_smoke", query: "스모크로 고친" });
  await call("drawer_update", { target: id, move_to: "/_smoke", rename: "옮긴 보고서" });
  await call("drawer_list", { path: "/_Smoke/없는곳" }, false);
} finally {
  if (created) await call("drawer_update", { target: "/_smoke", delete: true });
  const end = await call("drawer_list", { path: "/" });
  const left = end.data.items.filter((i: any) => i.name.toLowerCase() === "_smoke");
  if (left.length > 0) failed = true;
  console.log(left.length === 0 ? "살아 있는 /_smoke 없음" : "FAIL /_smoke 가 남았습니다");
  await client.close();
}

console.log(failed ? "스모크 실패" : "스모크 통과");
process.exit(failed ? 1 : 0);
