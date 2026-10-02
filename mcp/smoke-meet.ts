// 모임 원격 스모크: .mcp.json 의 명령 그대로 MCP 서버를 띄우고(stdio) 실제 Supabase 에
// 묶음 만들기 → 모임 만들기(사람이 채워짐) → 시간 정하기(일정에 들어감) → 옮기기 → 참석 → 딸린 할 일(todo_save meet)
// → 다시 열기(일정이 지워짐) → 지우기 를 한 바퀴 돈다. 0011 이 원격 DB 에 적용된 뒤에만 돈다.
// 남의 데이터와 안 섞이게 이름에 '[smoke]' 를 붙이고, 날짜는 먼 미래(2099-03, 2099-03-02 가 월요일)만 쓴다.
// 끝나면 이번에 만든 것을 영구 삭제한다(모임 · 사람 줄(cascade) · 묶음 · 딸린 일정 · 할 일). 내 이름 설정 · 역할 · 지점은 건드리지 않는다.
// 실행: npm run smoke:meet

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
const { command, args } = config.mcpServers["ez-drawer"] as { command: string; args: string[] };

const loaded = loadEnv();
if ("error" in loaded) {
  console.error(loaded.error);
  process.exit(1);
}
const { env } = loaded;
const owner = env.EZ_OWNER_ID;
// 뒷정리용. 이 스모크가 만든 것만 건드린다
const admin = createClient(env.EZ_SUPABASE_URL, env.EZ_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const TAG = "[smoke]";

const transport = new StdioClientTransport({ command, args, cwd: ROOT, stderr: "pipe" });
transport.stderr?.on("data", (d) => process.stderr.write(`  [server] ${d}`));
const client = new Client({ name: "ez-smoke-meet", version: "0" });

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

/** '[smoke]' 붙은 모임 · 묶음 · 일정 · 할 일을 치운다 (이전 실행이 남긴 것 포함) */
async function wipe(): Promise<void> {
  for (const [table, col] of [
    ["ez_meets", "title"],
    ["ez_circles", "name"],
    ["ez_events", "title"],
    ["ez_tasks", "title"],
  ] as const) {
    // 일정 · 할 일은 모임에서 온 것만 — 다른 스모크가 남긴 바깥 일정(source = smoke)은 건드리지 않는다
    let q = admin.from(table).delete({ count: "exact" }).eq("owner", owner).like(col, `${TAG}%`);
    if (table === "ez_events" || table === "ez_tasks") q = q.eq("origin_kind", "meet");
    const { error, count } = await q;
    check(!error, `${table} ${count ?? 0}행 영구 삭제${error ? ` — ${error.message}` : ""}`);
  }
}

await client.connect(transport);
const { tools } = await client.listTools();
console.log(`도구 ${tools.length}개: ${tools.map((t) => t.name).join(", ")}`);

try {
  await wipe();

  // ---- 묶음
  const group = `${TAG} 스터디`;
  const g = await call("meet_save", { group: { name: group, members: ["서연", "준우"] } });
  check(g.data.circle?.members?.length === 2, `묶음의 사람 2명: ${JSON.stringify(g.data.circle?.members)}`);
  await call("meet_save", { group: { name: group, members: ["서연", "서 연"] } }, false); // 겹치는 이름

  // ---- 만들기: 묶음을 고르면 사람이 채워진다 (내 줄 + 2명)
  const made = await call("meet_save", { title: `${TAG} 3주차`, circle: group });
  const id = made.data.meet?.id as string;
  check(made.data.meet?.people?.length === 3 && made.data.meet.people[0].me === true, `사람 3명, 내 줄이 맨 앞: ${JSON.stringify(made.data.meet?.people)}`);
  check(made.data.meet?.status === "미정", `상태: ${made.data.meet?.status}`);
  await call("meet_save", { title: `${TAG} x`, circle: "[smoke] 스터듸" }, false); // 이름 제안

  // ---- 정하기 · 옮기기: 일정과 한 묶음
  await call("meet_save", { id, base_version: 99, title: "x" }, false); // 낡은 버전
  const decided = await call("meet_save", { id, base_version: 1, date: "2099-03-02", start: "19:00", end: "21:00" });
  check(decided.data.meet?.in_schedule === true, "정하자 일정에 들어감");
  const day = await call("schedule_get", { from: "2099-03-02", to: "2099-03-02" });
  check(day.data.days?.[0]?.events?.some((e: any) => e.id === decided.data.meet?.event_id && e.time === "19:00–21:00"), "schedule_get 에 그 약속이 보임");
  const moved = await call("meet_save", { id, base_version: decided.data.meet?.version, date: "2099-03-04", start: "10:00" });
  check(moved.data.meet?.time === "10:00–12:00" && moved.data.meet?.event_id === decided.data.meet?.event_id, `옮기면 같은 일정이 따라감: ${moved.data.meet?.time}`);
  await call("meet_save", { id, base_version: moved.data.meet?.version, date: "2099-03-04", start: "23:30", end: "00:30" }, false); // 자정 넘김

  // ---- 사람 · 참석
  const people = await call("meet_save", { id, base_version: moved.data.meet?.version, people: ["태윤"], remove_people: ["준우"], attend: { 서연: "yes", 태윤: "no" } });
  check(JSON.stringify(people.data.meet?.people?.map((p: any) => [p.name, p.attend ?? null]).slice(1)) === JSON.stringify([["서연", "온다"], ["태윤", "못 온다"]]), `참석: ${JSON.stringify(people.data.meet?.people)}`);
  await call("meet_save", { id, base_version: moved.data.meet?.version, remove_people: ["없는 사람"] }, false);

  // ---- 딸린 할 일
  const todo = await call("todo_save", { title: `${TAG} 문제 풀이 올리기`, meet: id });
  check(todo.data.task?.meet === id, "할 일이 모임에 딸림");
  const got = await call("meet_get", { id });
  check(got.data.meet?.todos?.length === 1, `meet_get 에 딸린 할 일 1개 (지금 ${got.data.meet?.todos?.length})`);
  const list = await call("meet_get", { circle: group });
  check(list.data.items?.length === 1 && list.data.items[0].id === id, "묶음으로 좁힌 목록에 1개");

  // ---- 다시 열기 · 지우기
  const open = await call("meet_save", { id, base_version: got.data.meet?.version, reopen: true });
  check(open.data.meet?.status === "미정", "다시 열면 미정");
  const after = await call("schedule_get", { from: "2099-03-04", to: "2099-03-04" });
  check(!after.data.days?.[0]?.events?.some((e: any) => e.title === `${TAG} 3주차`), "딸린 일정이 지워짐");
  await call("meet_save", { id, base_version: open.data.meet?.version, delete: true });
  await call("meet_get", { id }, false);
  await call("meet_save", { group: { name: group, delete: true } });
} finally {
  try {
    await wipe();
    const { count } = await admin.from("ez_meets").select("id", { count: "exact", head: true }).eq("owner", owner).like("title", `${TAG}%`);
    check((count ?? 0) === 0, "남은 [smoke] 모임 없음");
  } finally {
    await client.close();
  }
}

console.log(failed ? "스모크 실패" : "스모크 통과");
process.exit(failed ? 1 : 0);
