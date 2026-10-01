// 일정·플래너 원격 스모크: .mcp.json 의 명령 그대로 MCP 서버를 띄우고(stdio) 실제 Supabase 에
// 지점 2개 + 이동시간 → 일정 넣기 → 반복 회차 고치기(once · following) → get → sync → 할 일 넣고 잇기 → 지우기 를 한 바퀴 돈다.
// 남의 데이터와 안 섞이게 이름에 '[smoke]' 를 붙이고, 날짜는 먼 미래(2099-03, 2099-03-02 가 월요일)만 쓴다.
// 끝나면 이번에 만든 것을 영구 삭제한다(일정·예외·할 일·지점·이동시간·출처 줄).
// 단, 바깥 일정(source=smoke) 행은 DB 트리거가 sync 밖의 삭제를 막으므로 빈 sync 로 soft delete 까지만 한다.
//   남은 행을 완전히 지우려면 SQL 편집기에서: delete from ez_events where source = 'smoke' and deleted_at is not null;
//   (이 문장은 트리거 때문에 실패하면 begin; set local ez.schedule_sync = 'on'; delete …; commit; 으로)
// 실행: npm run smoke:schedule

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env";
import { SupabaseScheduleStore } from "./schedule-store-supabase";

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
// 준비(지점·이동시간 — 화면 설정 몫이라 도구가 없다)와 뒷정리용. 이 스모크가 만든 것만 건드린다
const store = new SupabaseScheduleStore(env.EZ_SUPABASE_URL, env.EZ_SUPABASE_SERVICE_ROLE_KEY, owner);
const admin = createClient(env.EZ_SUPABASE_URL, env.EZ_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const TAG = "[smoke]";
const SOURCE = "smoke";
const FROM = "2099-03-01";
const TO = "2099-03-31";

const transport = new StdioClientTransport({ command, args, cwd: ROOT, stderr: "pipe" });
transport.stderr?.on("data", (d) => process.stderr.write(`  [server] ${d}`));
const client = new Client({ name: "ez-smoke-schedule", version: "0" });

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

/** '[smoke]' 붙은 것 + 이 기간의 smoke 바깥 일정을 치운다 (이전 실행이 남긴 것 포함) */
async function wipe(): Promise<void> {
  // 바깥 일정: sync 로만 지울 수 있다 → 빈 목록으로 맞춰 soft delete
  const { error: syncErr } = await admin.rpc("ez_schedule_sync", { source: SOURCE, p_from: FROM, p_to: TO, events: [], p_label: null, p_as: owner });
  check(!syncErr, `바깥 일정(${SOURCE}) 비우기${syncErr ? ` — ${syncErr.message}` : ""}`);

  // 내 일정 (예외는 cascade). 스모크 일정은 제목이 전부 '[smoke]' 로 시작한다 (나눈 일정도 제목을 물려받는다)
  const { data: evs, error: e1 } = await admin.from("ez_events").select("id").eq("owner", owner).is("source", null).like("title", `${TAG}%`);
  if (e1) check(false, `일정 찾기 — ${e1.message}`);
  const evIds = (evs ?? []).map((r) => r.id as string);
  if (evIds.length > 0) {
    const { error } = await admin.from("ez_events").delete().eq("owner", owner).in("id", evIds);
    check(!error, `일정 ${evIds.length}행 영구 삭제${error ? ` — ${error.message}` : ""}`);
  }

  const { error: e2, count: nTasks } = await admin.from("ez_tasks").delete({ count: "exact" }).eq("owner", owner).like("title", `${TAG}%`);
  check(!e2, `할 일 ${nTasks ?? 0}행 영구 삭제${e2 ? ` — ${e2.message}` : ""}`);

  // 지점 (이동시간은 cascade). 바깥 일정이 이 지점을 가리키지 않게 sync 에는 지점을 쓰지 않았다
  const { error: e3, count: nPlaces } = await admin.from("ez_places").delete({ count: "exact" }).eq("owner", owner).like("name", `${TAG}%`);
  check(!e3, `지점 ${nPlaces ?? 0}행 영구 삭제${e3 ? ` — ${e3.message}` : ""}`);

  const { error: e4 } = await admin.from("ez_sources").delete().eq("owner", owner).eq("source", SOURCE);
  check(!e4, `출처 줄(${SOURCE}) 삭제${e4 ? ` — ${e4.message}` : ""}`);
}

await client.connect(transport);
const { tools } = await client.listTools();
console.log(`도구 ${tools.length}개: ${tools.map((t) => t.name).join(", ")}`);

try {
  await wipe();

  // ---- 준비: 지점 2개 + 이동시간 (집은 사용자 것이 있을 수 있어 만들지 않는다)
  const school = await store.insertPlace({ name: `${TAG} 학교`, role: "school" });
  const cafe = await store.insertPlace({ name: `${TAG} 카페` });
  await store.setTravel(school.id, cafe.id, 20);
  check(true, `지점 2개 · 이동시간 20분 (${school.name} ↔ ${cafe.name})`);

  // ---- 일정 넣기
  await call("schedule_save", { title: `${TAG} 과외`, date: "2099-03-02", start: "10:00", end: "11:00", place: `${TAG} 카페` });
  await call("schedule_save", { title: `${TAG} 과외`, date: "2099-03-02", start: "10:00", end: "11:00", place: "[smoke] 카폐" }, false); // 이름 제안
  const cls = await call("schedule_save", {
    title: `${TAG} 수업`,
    date: "2099-03-02",
    start: "11:10",
    end: "12:30",
    place: `${TAG.toUpperCase()} 학교 `,
    repeat: { freq: "weekly", days: ["월", "수"] },
  });
  const clsId = cls.data.event?.id as string;
  const night = await call("schedule_save", { title: `${TAG} 야간`, date: "2099-03-03", start: "22:00", end: "02:00" });
  check(night.data.event?.time === "22:00–02:00+1", `자정 넘김 표기: ${night.data.event?.time}`);

  // ---- 고치기: 낡은 버전 · scope 없음 · once · following
  await call("schedule_save", { id: clsId, base_version: 99, title: "x" }, false);
  await call("schedule_save", { id: clsId, base_version: 1, title: "x" }, false);
  await call("schedule_save", { id: clsId, base_version: 1, on_date: "2099-03-04", scope: "once", title: `${TAG} 보강`, start: "14:00" });
  const fol = await call("schedule_save", { id: clsId, base_version: 1, on_date: "2099-03-09", scope: "following", start: "13:00", end: "14:00" });
  check(fol.data.split === true && fol.data.event?.date === "2099-03-09", "following 이 새 일정을 만들었다");

  // ---- 보기
  const week = await call("schedule_get", { from: "2099-03-02", to: "2099-03-08", free_min: 60 });
  const mon = (week.data.days ?? []).find((d: any) => d.date === "2099-03-02");
  const wed = (week.data.days ?? []).find((d: any) => d.date === "2099-03-04");
  check(mon?.events?.length === 2, `3/2 일정 2개 (지금 ${mon?.events?.length})`);
  check(mon?.bands?.some((b: any) => b.kind === "등교" && b.late_min === 10), `3/2 등교 띠 10분 늦음: ${JSON.stringify(mon?.bands)}`);
  check(wed?.events?.some((e: any) => e.title === `${TAG} 보강` && e.time === "14:00–15:20" && e.changed), "3/4 회차만 바뀜");
  await call("schedule_get", { from: "2099-01-01", to: "2099-03-31" }, false); // 62일 상한

  // ---- 바깥 일정 sync (지점 없이 — 뒷정리 때 지점을 지울 수 있게)
  const ev = (id: string, date: string, end = "18:00") => ({ external_id: id, title: `${TAG} 근무`, date, start: "13:00", end });
  const s1 = await call("schedule_sync", { source: SOURCE, from: FROM, to: TO, label: "스모크", events: [ev("w1", "2099-03-05"), ev("w2", "2099-03-06")] });
  check(s1.data.inserted === 2, `sync 넣음 2: ${JSON.stringify(s1.data)}`);
  const s2 = await call("schedule_sync", { source: SOURCE, from: FROM, to: TO, events: [ev("w1", "2099-03-05", "19:00"), ev("w3", "2099-03-07")] });
  check(s2.data.inserted === 1 && s2.data.updated === 1 && s2.data.deleted === 1, `sync 넣음 1 · 고침 1 · 지움 1: ${JSON.stringify(s2.data)}`);
  await call("schedule_sync", { source: SOURCE, from: FROM, to: TO, events: [{ external_id: "bad", title: "x", date: "2099-03-05", start: "9시" }] }, false);
  const thu = await call("schedule_get", { from: "2099-03-05", to: "2099-03-05" });
  const extId = thu.data.days?.[0]?.events?.find((e: any) => e.source === SOURCE)?.id;
  await call("schedule_save", { id: extId, base_version: 1, title: "x" }, false); // 바깥 일정 거절

  // ---- 할 일 넣고 잇기
  const todo = await call("todo_save", { title: `${TAG} 보고서 쓰기`, est_min: 90, due: "2099-03-10" });
  const taskId = todo.data.task?.id as string;
  const linked = await call("schedule_save", { title: `${TAG} 보고서 쓰기`, date: "2099-03-06", start: "09:00", task_id: taskId });
  check(linked.data.event?.time === "09:00–10:30", `길이 기본값 est_min: ${linked.data.event?.time}`);
  const list = await call("todo_list", { query: "[SMOKE] 보고서" });
  check(list.data.items?.[0]?.event?.time === "09:00", `todo_list 에 이어진 일정: ${JSON.stringify(list.data.items?.[0]?.event)}`);
  const done = await call("todo_save", { id: taskId, base_version: 1, done: true });
  await call("todo_save", { id: taskId, base_version: 1, title: "x" }, false); // 낡은 버전
  await call("todo_list", { status: "done", query: TAG });

  // ---- 지우기: once · following · 이어진 일정 · 할 일
  await call("schedule_delete", { id: clsId, on_date: "2099-03-02", scope: "once" });
  await call("schedule_delete", { id: fol.data.event?.id, on_date: "2099-03-16", scope: "following" });
  await call("schedule_delete", { id: linked.data.event?.id });
  const after = await call("todo_list", { status: "all", query: TAG });
  check(after.data.items?.[0]?.event === undefined, "일정을 지우자 할 일이 다시 시간 없음");
  await call("todo_save", { id: taskId, base_version: done.data.task?.version, delete: true });
} finally {
  try {
    await wipe();
    const { count } = await admin.from("ez_events").select("id", { count: "exact", head: true }).eq("owner", owner).like("title", `${TAG}%`).is("deleted_at", null);
    check((count ?? 0) === 0, "살아 있는 [smoke] 일정 없음");
  } finally {
    await client.close();
  }
}

console.log(failed ? "스모크 실패" : "스모크 통과");
process.exit(failed ? 1 : 0);
