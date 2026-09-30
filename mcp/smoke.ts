// 실제 원격 스모크: .mcp.json 의 명령 그대로 MCP 서버를 띄우고(stdio) 실제 Supabase 에
// /_smoke 폴더 만들기 → 보고서 넣기 → 읽기 → 고치기 → 사진 넣기(작은 시험 사진 → 버킷에 올라갔는지) → 폴더째 삭제(ez_delete) 를 한 바퀴 돈다.
// 끝나면 흔적을 남기지 않는다: 이번에 만든 행은 휴지통에 두지 않고 영구 삭제, 올린 시험 사진도 Storage API 로 삭제.
// 전제: 0004(사진 버킷 ez-images) 적용 후. 실행: npm run smoke

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { sampleBlocks } from "../lib/fixtures";
import { loadEnv } from "./env";
import { IMAGE_BUCKET } from "./store";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const { command, args } = config.mcpServers["ez-drawer"] as { command: string; args: string[] };

const loaded = loadEnv();
if ("error" in loaded) {
  console.error(loaded.error);
  process.exit(1);
}
const { env } = loaded;
// 뒷정리(영구 삭제·사진 삭제)와 버킷 확인용 — 이 스모크가 만든 것만 건드린다
const admin = createClient(env.EZ_SUPABASE_URL, env.EZ_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const owner = env.EZ_OWNER_ID;

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

function check(ok: boolean, what: string) {
  if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "FAIL"} ${what}`);
}

/** 살아 있는 /_smoke 아래 전부 (id, 깊이) — 휴지통에 보내기 전에 모은다 */
async function collect(path: string, depth = 0, out: { id: string; depth: number }[] = []) {
  const r = (await client.callTool({ name: "drawer_list", arguments: { path } })) as { isError?: boolean; content: { text: string }[] };
  if (r.isError) return out;
  const data = JSON.parse(r.content[1]?.text ?? "{}");
  for (const it of data.items ?? []) {
    out.push({ id: it.id, depth: depth + 1 });
    if (it.kind === "folder") await collect(it.path, depth + 1, out);
  }
  return out;
}

/** /_smoke 를 휴지통으로 보낸 뒤(ez_delete 시험) 그 행들을 깊은 것부터 영구 삭제 */
async function wipeSmoke(): Promise<void> {
  const top = await call("drawer_list", { path: "/" });
  const smoke = (top.data.items ?? []).find((i: any) => i.name.toLowerCase() === "_smoke");
  if (!smoke) return;
  const rows = [{ id: smoke.id as string, depth: 0 }, ...(await collect(smoke.path))];
  await call("drawer_update", { target: smoke.id, delete: true });
  for (const d of [...new Set(rows.map((r) => r.depth))].sort((a, b) => b - a)) {
    const ids = rows.filter((r) => r.depth === d).map((r) => r.id);
    const { error } = await admin.from("ez_items").delete().eq("owner", owner).in("id", ids);
    check(!error, `영구 삭제 ${ids.length}행 (깊이 ${d})${error ? ` — ${error.message}` : ""}`);
  }
}

await client.connect(transport);
const { tools } = await client.listTools();
console.log(`도구 ${tools.length}개: ${tools.map((t) => t.name).join(", ")}`);

const tmp = mkdtempSync(join(tmpdir(), "ez-smoke-"));
const uploadedSrcs = new Set<string>();
let created = false;
try {
  const before = await call("drawer_list", { path: "/" });
  if (before.data.items.some((i: any) => i.name.toLowerCase() === "_smoke")) {
    console.log("이전 실행이 남긴 /_smoke 를 먼저 지웁니다");
    await wipeSmoke();
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

  // ---- 사진: 이번 실행에만 있는 작은 시험 사진(잡음이라 해시가 매번 다르다) → file 로 넣기 → 버킷에 있는지
  const pic = join(tmp, "스모크 사진.png");
  const raw = Buffer.alloc(96 * 64 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (Math.random() * 256) | 0;
  await sharp(raw, { raw: { width: 96, height: 64, channels: 3 } }).png().toFile(pic);
  const imageBlock = { type: "image", file: pic, alt: "스모크 시험 사진", place: "right", size: "1/3", credit: "스모크" };
  const withPic = await call("report_create", {
    title: "스모크 사진",
    kind: "data",
    folder: "/_smoke",
    blocks: [{ type: "text", body: "사진 옆으로 흐르는 글" }, imageBlock],
  });
  check(withPic.data.images?.uploaded === 1, "사진 1장을 올렸다");
  const got = await call("report_get", { id: withPic.data.id, from: 1, to: 1 });
  const img = got.data.blocks?.[0] ?? {};
  const src = String(img.src ?? "");
  uploadedSrcs.add(src);
  check(src.startsWith(`${owner}/`) && src.endsWith(".webp") && img.w === 96 && img.h === 64, `블록에 src·w·h: ${src} ${img.w}×${img.h}`);
  check(typeof img.local_path === "string" && img.local_path.endsWith("스모크 사진.png"), `local_path: ${img.local_path}`);
  const { data: exists } = await admin.storage.from(IMAGE_BUCKET).exists(src);
  check(exists === true, "원격 버킷에 올라갔다");
  const again = await call("report_create", { title: "스모크 사진 다시", kind: "data", folder: "/_smoke", blocks: [imageBlock] });
  check(again.data.images?.uploaded === 0, "같은 사진은 다시 올리지 않는다");
  await call("report_create", { title: "사진 없음", kind: "data", folder: "/_smoke", blocks: [{ ...imageBlock, file: join(tmp, "없음.png") }] }, false);

  await call("drawer_list", { path: "/_smoke", query: "스모크로 고친" });
  await call("drawer_update", { target: id, move_to: "/_smoke", rename: "옮긴 보고서" });
  await call("drawer_list", { path: "/_Smoke/없는곳" }, false);
} finally {
  try {
    if (created) await wipeSmoke();
    const end = await call("drawer_list", { path: "/" });
    const left = end.data.items.filter((i: any) => i.name.toLowerCase() === "_smoke");
    check(left.length === 0, "살아 있는 /_smoke 없음");

    // 올린 시험 사진: 보고서 행을 영구 삭제했으니 쓰는 곳이 없다 → Storage API 로 삭제
    const srcs = [...uploadedSrcs].filter((s) => s.startsWith(`${owner}/`));
    if (srcs.length > 0) {
      const { error } = await admin.storage.from(IMAGE_BUCKET).remove(srcs);
      const { data: still } = await admin.storage.from(IMAGE_BUCKET).exists(srcs[0]!);
      check(!error && still === false, `시험 사진 ${srcs.length}장 삭제${error ? ` — ${error.message}` : ""}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await client.close();
  }
}

console.log(failed ? "스모크 실패" : "스모크 통과");
process.exit(failed ? 1 : 0);
