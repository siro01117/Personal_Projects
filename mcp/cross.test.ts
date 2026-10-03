// 두 사용자 교차 시험 (docs/에이전트-연결.md 2 · 5장): 을의 도구 15개를 전부 갑의 id · 경로 · 이름을 대상으로 부른다.
// 통과 조건: ① 갑의 것을 가리킨 호출은 전부 실패한다 ② 어떤 결과에도 갑의 내용("갑비밀")이 없다 ③ 갑의 줄은 한 글자도 안 바뀐다.
// 두 가지 길로 돌린다 — service: service_role + 스토어의 owner 조건 (나), user: 주인의 권한 + RLS (가).
// 원격 연결과 같은 조건(사진 안 받음)으로 도구를 만든다. 날짜: 2026-10-05 가 월요일, 시계는 2026-10-01 12:00(한국).

import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sampleBlocks } from "../lib/fixtures";
import { createDrawer, type ToolResult } from "./drawer";
import { createMeet } from "./meet";
import { PgliteMeetStore } from "./meet-store-pglite";
import { createSchedule } from "./schedule";
import { PgliteScheduleStore } from "./schedule-store-pglite";
import { PgliteStore, createTestDb, type StoreRole } from "./store-pglite";
import { TOOL_NAMES } from "./tools";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

type Row = Record<string, any>;
const NOW = new Date("2026-10-01T03:00:00Z");
/** 갑의 내용에만 있는 글자 — 을은 이 글자를 한 번도 보내지 않는다 */
const SECRET = "갑비밀";

function tools(owner: string, as: StoreRole) {
  const store = new PgliteStore(db, owner, () => NOW, as);
  const schedule = new PgliteScheduleStore(db, owner, as);
  const meet = new PgliteMeetStore(db, owner, as);
  const now = () => NOW;
  return {
    owner,
    schedule,
    d: createDrawer({ store, agent: "Claude", now, webUrl: "https://ez.test", images: false }),
    s: createSchedule({ store: schedule, now }),
    m: createMeet({ store: meet, schedule, now, webUrl: "https://ez.test" }),
  };
}

function good(r: ToolResult): Row {
  expect(r.ok, `${r.summary}\n${JSON.stringify(r.data)}`).toBe(true);
  return r.data as Row;
}

/** 그 사람의 모든 줄 (postgres 로 읽는다 — 역할 · RLS 와 무관하게 있는 그대로) */
async function snapshot(owner: string): Promise<Record<string, unknown>> {
  const tables = (
    await db.query<{ t: string }>(
      "select table_name as t from information_schema.columns where table_schema = 'public' and table_name like 'ez\\_%' and column_name = 'owner' order by 1",
    )
  ).rows.map((r) => r.t);
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    out[t] = (await db.query<{ j: unknown }>(`select coalesce(jsonb_agg(to_jsonb(x) order by x::text), '[]'::jsonb) as j from public.${t} x where x.owner = $1`, [owner])).rows[0]!.j;
  }
  // owner 칸이 없는 딸린 표는 부모로
  const child = async (name: string, sql: string) => {
    out[name] = (await db.query<{ j: unknown }>(sql, [owner])).rows[0]!.j;
  };
  await child(
    "ez_event_exceptions",
    "select coalesce(jsonb_agg(to_jsonb(x) order by x::text), '[]'::jsonb) as j from ez_event_exceptions x join ez_events e on e.id = x.event_id where e.owner = $1",
  );
  await child(
    "ez_meet_people",
    "select coalesce(jsonb_agg(to_jsonb(x) order by x::text), '[]'::jsonb) as j from ez_meet_people x join ez_meets m on m.id = x.meet_id where m.owner = $1",
  );
  await child("ez_notes", "select coalesce(jsonb_agg(to_jsonb(x) order by x::text), '[]'::jsonb) as j from ez_notes x join ez_items i on i.id = x.item_id where i.owner = $1");
  return out;
}

/** 갑의 데이터: 도구가 다루는 것을 종류마다 하나씩. 이름(을이 겨냥하는 것)에는 SECRET 을 넣지 않고, 내용에만 넣는다 */
async function seedA(as: StoreRole) {
  const a = tools(randomUUID(), as);
  const work = await a.schedule.insertPlace({ name: "갑회사", role: "work" });
  await a.schedule.seedRoles();

  good(await a.d.drawer_mkdir({ path: "/갑폴더" }));
  const blocks = [...sampleBlocks(), { type: "text", body: `${SECRET} 무지개 본문` }];
  const report = good(await a.d.report_create({ title: `${SECRET}보고서`, kind: "data", folder: "/갑폴더", blocks }));
  const folders = good(await a.d.drawer_list({ path: "/" }));
  const folderId = (folders.items as Row[]).find((i) => i.name === "갑폴더")!.id as string;
  // 주인의 답글 한 줄 (report_get 의 notes 에 실린다)
  await db.query("insert into ez_notes (item_id, by_owner, body) values ($1, true, $2)", [report.id, `${SECRET} 답글`]);

  const event = good(await a.s.schedule_save({ title: `${SECRET}일정`, date: "2026-10-06", start: "10:00", end: "11:00", place: "갑회사", note: `${SECRET} 메모 무지개` })).event;
  const repeat = good(await a.s.schedule_save({ title: `${SECRET}반복`, date: "2026-10-06", start: "14:00", end: "15:00", repeat: { freq: "weekly", days: ["화"] } })).event;
  good(await a.s.schedule_save({ id: repeat.id, base_version: repeat.version, on_date: "2026-10-13", scope: "once", title: `${SECRET}반복 이번만` }));
  good(await a.s.schedule_sync({ source: "studycube", from: "2026-10-05", to: "2026-10-11", events: [{ external_id: "x1", title: `${SECRET}수업`, date: "2026-10-07", start: "18:00", end: "20:00" }] }));
  const task = good(await a.s.todo_save({ title: `${SECRET}할일`, note: "무지개", est_min: 30, due: "2026-10-08", checklist: ["하나", "둘"] })).task;
  const ruled = good(await a.s.todo_save({ title: `${SECRET}반복할일`, repeat: { freq: "daily" } }));
  const ruleId = (good(await a.s.todo_list({ status: "rules" })).rules as Row[])[0]!.id as string;
  good(await a.s.todo_save({ id: task.id, base_version: task.version, work: "start" }));
  good(await a.s.todo_save({ id: task.id, base_version: task.version, work: "stop" }));

  good(await a.m.meet_save({ group: { name: "갑묶음", members: ["갑친구"] } }));
  const poll = good(await a.m.meet_save({ title: `${SECRET}모임`, circle: "갑묶음", poll: { dates: ["2026-10-08", "2026-10-09"] }, link: true })).meet;
  const fixed = good(await a.m.meet_save({ title: `${SECRET}정한모임`, date: "2026-10-09", start: "19:00", end: "20:00", people: ["갑친구"] })).meet;

  const rev = async (table: string, id: string) => (await db.query<{ version: number }>(`select version from ${table} where id = $1`, [id])).rows[0]!.version;
  return {
    a,
    folderId,
    reportId: report.id as string,
    reportUrl: report.url as string,
    reportV: await rev("ez_items", report.id),
    eventId: event.id as string,
    eventV: await rev("ez_events", event.id),
    repeatId: repeat.id as string,
    repeatV: await rev("ez_events", repeat.id),
    taskId: task.id as string,
    taskV: await rev("ez_tasks", task.id),
    ruledTaskId: ruled.task.id as string,
    ruleId,
    ruleV: await rev("ez_task_rules", ruleId),
    placeId: work.id,
    pollId: poll.id as string,
    pollV: await rev("ez_meets", poll.id),
    fixedId: fixed.id as string,
    fixedV: await rev("ez_meets", fixed.id),
  };
}

describe.each(["service", "user"] as const)("두 사용자 교차 — %s", (as) => {
  it("을의 도구 15개가 갑의 것을 못 읽고 못 고친다", async () => {
    const A = await seedA(as);
    const before = await snapshot(A.a.owner);
    // 갑의 줄이 종류마다 실제로 있다 (빈 것끼리 비교하지 않게)
    for (const t of ["ez_items", "ez_events", "ez_tasks", "ez_task_rules", "ez_places", "ez_roles", "ez_circles", "ez_meets", "ez_work_log", "ez_sources", "ez_event_exceptions", "ez_meet_people", "ez_notes"]) {
      expect((before[t] as unknown[]).length, t).toBeGreaterThan(0);
    }
    expect(JSON.stringify(before)).toContain(SECRET);

    const b = tools(randomUUID(), as);
    /** [도구 이름, 무엇을, 결과, 실패해야 하는가] */
    const calls: [string, string, ToolResult, boolean][] = [];
    const hit = async (tool: (typeof TOOL_NAMES)[number], what: string, p: Promise<ToolResult>, mustFail = true) => calls.push([tool, what, await p, mustFail]);
    const WEEK = { from: "2026-10-05", to: "2026-10-18" };

    // ---- 서랍
    await hit("drawer_list", "맨 위", b.d.drawer_list({}), false);
    await hit("drawer_list", "갑의 폴더 경로", b.d.drawer_list({ path: "/갑폴더" }));
    await hit("drawer_list", "갑의 본문 글자로 찾기", b.d.drawer_list({ query: "무지개" }), false);
    await hit("drawer_update", "갑의 폴더 id 이름 바꾸기", b.d.drawer_update({ target: A.folderId, rename: "침입" }));
    await hit("drawer_update", "갑의 보고서 id 지우기", b.d.drawer_update({ target: A.reportId, delete: true }));
    await hit("drawer_update", "갑의 보고서 링크 옮기기", b.d.drawer_update({ target: A.reportUrl, move_to: "/" }));
    await hit("drawer_update", "갑의 폴더 경로 지우기", b.d.drawer_update({ target: "/갑폴더", delete: true }));
    await hit("report_create", "갑의 폴더 경로에 넣기", b.d.report_create({ title: "침입", kind: "data", folder: "/갑폴더", blocks: sampleBlocks() }));
    const mine = good(await b.d.report_create({ title: "을의 보고서", kind: "data", folder: "/", blocks: sampleBlocks() }));
    await hit("drawer_update", "내 보고서를 갑의 폴더로 옮기기", b.d.drawer_update({ target: mine.id, move_to: "/갑폴더" }));
    await hit("report_get", "갑의 보고서 id", b.d.report_get({ id: A.reportId }));
    await hit("report_get", "갑의 보고서 링크", b.d.report_get({ id: A.reportUrl }));
    await hit("report_get", "갑의 보고서 블록 범위", b.d.report_get({ id: A.reportId, from: 0, to: 0 }));
    await hit("report_edit", "갑의 보고서 블록 빼기", b.d.report_edit({ id: A.reportId, base_version: A.reportV, ops: [{ op: "remove", at: 0 }] }));
    await hit("report_edit", "갑의 보고서 블록 바꾸기", b.d.report_edit({ id: A.reportId, base_version: A.reportV, ops: [{ op: "replace", at: 0, block: { type: "text", body: "침입" } }] }));
    await hit("drawer_mkdir", "갑의 폴더 이름 아래에 만들기 (내 서랍에 생긴다)", b.d.drawer_mkdir({ path: "/갑폴더/침입" }), false);

    // ---- 일정
    await hit("schedule_get", "갑의 일정이 있는 주", b.s.schedule_get({ ...WEEK, free_min: 30 }), false);
    await hit("schedule_save", "갑의 일정 고치기", b.s.schedule_save({ id: A.eventId, base_version: A.eventV, title: "침입" }));
    for (const scope of ["once", "following", "all"] as const) {
      await hit("schedule_save", `갑의 반복 일정 고치기 (${scope})`, b.s.schedule_save({ id: A.repeatId, base_version: A.repeatV, on_date: "2026-10-13", scope, title: "침입" }));
      await hit("schedule_delete", `갑의 반복 일정 지우기 (${scope})`, b.s.schedule_delete({ id: A.repeatId, on_date: "2026-10-13", scope }));
    }
    await hit("schedule_save", "갑의 할 일과 잇기", b.s.schedule_save({ title: "침입", date: "2026-10-06", start: "09:00", end: "10:00", task_id: A.taskId }));
    await hit("schedule_save", "갑의 지점 이름으로", b.s.schedule_save({ title: "침입", date: "2026-10-06", start: "09:00", end: "10:00", place: "갑회사" }));
    await hit("schedule_delete", "갑의 일정 지우기", b.s.schedule_delete({ id: A.eventId }));
    await hit("schedule_sync", "갑과 같은 출처 · 같은 기간 비우기 (내 것만 갈아끼운다)", b.s.schedule_sync({ source: "studycube", ...WEEK, events: [] }), false);
    await hit(
      "schedule_sync",
      "갑과 같은 external_id 넣기 (내 것으로 들어간다)",
      b.s.schedule_sync({ source: "studycube", ...WEEK, events: [{ external_id: "x1", title: "을의 수업", date: "2026-10-07", start: "18:00", end: "20:00" }] }),
      false,
    );

    // ---- 플래너 · 시간 기록
    for (const status of ["open", "done", "all", "rules"] as const) await hit("todo_list", `목록 (${status})`, b.s.todo_list({ status }), false);
    await hit("todo_list", "갑의 메모 글자로 찾기", b.s.todo_list({ status: "all", query: "무지개" }), false);
    await hit("todo_save", "갑의 할 일 고치기", b.s.todo_save({ id: A.taskId, base_version: A.taskV, title: "침입" }));
    await hit("todo_save", "갑의 할 일 끝내기", b.s.todo_save({ id: A.taskId, base_version: A.taskV, done: true }));
    await hit("todo_save", "갑의 할 일 지우기", b.s.todo_save({ id: A.taskId, base_version: A.taskV, delete: true }));
    await hit("todo_save", "갑의 할 일 작업대에", b.s.todo_save({ id: A.taskId, base_version: A.taskV, bench: true }));
    await hit("todo_save", "갑의 할 일 시간 재기", b.s.todo_save({ id: A.taskId, base_version: A.taskV, work: "start" }));
    await hit("todo_save", "갑의 할 일에 단계 덧붙이기", b.s.todo_save({ id: A.taskId, base_version: A.taskV, checklist: ["침입"] }));
    await hit("todo_save", "갑의 반복 회차 — 규칙도", b.s.todo_save({ id: A.ruledTaskId, base_version: 1, title: "침입", scope: "rule" }));
    await hit("todo_save", "갑의 규칙 고치기", b.s.todo_save({ rule_id: A.ruleId, base_version: A.ruleV, title: "침입" }));
    await hit("todo_save", "갑의 규칙 멈추기", b.s.todo_save({ rule_id: A.ruleId, stop: true }));
    await hit("todo_save", "갑의 일정을 마감으로", b.s.todo_save({ title: "침입", due_event: { id: A.eventId } }));
    await hit("todo_save", "갑의 반복 일정에 딸린 규칙", b.s.todo_save({ title: "침입", repeat: { after_event: A.repeatId } }));
    await hit("todo_save", "갑의 모임에서 나온 할 일", b.s.todo_save({ title: "침입", meet: A.fixedId }));
    await hit("todo_save", "갑의 지점 이름으로", b.s.todo_save({ title: "침입", place: "갑회사" }));
    await hit("work_log", "갑이 시간을 잰 기간", b.s.work_log({ from: "2026-09-01", to: "2026-10-31" }), false);

    // ---- 모임
    await hit("meet_get", "목록", b.m.meet_get({}), false);
    await hit("meet_get", "갑의 모임 id (맞추는 중)", b.m.meet_get({ id: A.pollId }));
    await hit("meet_get", "갑의 모임 id (정해짐)", b.m.meet_get({ id: A.fixedId }));
    await hit("meet_get", "갑의 묶음 이름", b.m.meet_get({ circle: "갑묶음" }));
    const poke: [string, Row][] = [
      ["제목", { title: "침입" }],
      ["사람 넣기", { people: ["침입자"] }],
      ["사람 빼기", { remove_people: ["갑친구"] }],
      ["참석", { attend: { 갑친구: "yes" } }],
      ["링크 끄기", { link: false }],
      ["링크 켜기", { link: true }],
      ["맞추기 끄기", { poll: null }],
      ["시간 정하기", { date: "2026-10-08", start: "10:00", end: "11:00" }],
      ["시간 비우기", { reopen: true }],
      ["지우기", { delete: true }],
    ];
    for (const [what, patch] of poke) {
      await hit("meet_save", `갑의 모임(맞추는 중) ${what}`, b.m.meet_save({ id: A.pollId, base_version: A.pollV, ...patch }));
      await hit("meet_save", `갑의 모임(정해짐) ${what}`, b.m.meet_save({ id: A.fixedId, base_version: A.fixedV, ...patch }));
    }
    await hit("meet_save", "갑의 묶음 이름으로 새 모임", b.m.meet_save({ title: "침입", circle: "갑묶음" }));
    await hit("meet_save", "갑의 지점 이름으로 새 모임", b.m.meet_save({ title: "침입", place: "갑회사" }));
    await hit("meet_save", "갑과 같은 이름의 묶음 (내 것이 생긴다)", b.m.meet_save({ group: { name: "갑묶음", members: ["을친구"] } }), false);
    await hit("meet_save", "그 이름의 묶음 지우기 (내 것만 지워진다)", b.m.meet_save({ group: { name: "갑묶음", delete: true } }), false);

    // ① 도구 15개를 다 불렀다
    expect(new Set(calls.map((c) => c[0]))).toEqual(new Set(TOOL_NAMES));
    // ② 갑의 것을 가리킨 호출은 전부 실패 · 어떤 결과에도 갑의 내용이 없다
    for (const [tool, what, r, mustFail] of calls) {
      const text = `${r.summary}\n${JSON.stringify(r.data)}`;
      if (mustFail) expect(r.ok, `${tool} — ${what}: 실패해야 합니다\n${text}`).toBe(false);
      else expect(r.ok, `${tool} — ${what}\n${text}`).toBe(true);
      expect(text, `${tool} — ${what}: 갑의 내용이 샜습니다`).not.toContain(SECRET);
      for (const id of [A.folderId, A.placeId, A.ruleId, A.ruledTaskId]) expect(text.includes(id) && r.ok, `${tool} — ${what}: 갑의 id`).toBe(false);
    }
    // ③ 갑의 줄은 그대로
    expect(await snapshot(A.a.owner)).toEqual(before);

    // 갑은 여전히 자기 것을 본다 (막은 것이 갑까지 막지 않았다)
    expect(good(await A.a.d.report_get({ id: A.reportId })).version).toBe(A.reportV);
    expect(JSON.stringify(good(await A.a.s.schedule_get(WEEK)))).toContain(SECRET);
    expect(JSON.stringify(good(await A.a.m.meet_get({ id: A.pollId })))).toContain(SECRET);
  });

  it("스토어에 남의 부모를 직접 줘도 DB 가 막는다 (도구가 걸러 주지 않는 길)", async () => {
    const A = await seedA(as);
    const before = await snapshot(A.a.owner);
    const b = tools(randomUUID(), as);
    const store = new PgliteStore(db, b.owner, () => NOW, as);
    const sched = new PgliteScheduleStore(db, b.owner, as);
    const meet = new PgliteMeetStore(db, b.owner, as);
    const no = async (what: string, p: Promise<unknown>) => {
      const out = await p.then(
        (v) => ({ v }),
        () => null,
      );
      // 거절(던짐)이거나, 아무것도 못 한 값(null · false · 빈 목록 · 0)
      if (out !== null) expect(out.v === null || out.v === false || out.v === 0 || out.v === undefined || (Array.isArray(out.v) && out.v.length === 0), `${what}: ${JSON.stringify(out.v)}`).toBe(true);
    };
    await no("갑의 폴더 안에 넣기", store.insert({ kind: "folder", parent_id: A.folderId, name: "침입" }));
    await no("갑의 폴더 안 목록", store.children(A.folderId));
    await no("갑의 보고서", store.getReport(A.reportId));
    await no("갑의 보고서 고치기", store.update(A.reportId, { name: "침입" }));
    await no("갑의 보고서 지우기", store.remove(A.reportId));
    await no("갑의 보고서 글", store.notes(A.reportId));
    await no("갑의 폴더 아래 찾기", store.search("무지개", A.folderId, 20));
    await no("갑의 일정", sched.getEvent(A.eventId));
    await no("갑의 일정들", sched.eventsByIds([A.eventId, A.repeatId]));
    await no("갑의 할 일의 일정", sched.eventsForTasks([A.taskId]));
    await no("갑의 일정 예외", sched.exceptions([A.repeatId]));
    await no("갑의 일정 고치기", sched.updateEvent(A.eventId, { title: "침입" }, A.eventV));
    await no("갑의 일정 지우기", sched.deleteEvent(A.eventId, A.eventV));
    await no("갑의 일정에 예외 넣기", sched.putException({ event_id: A.repeatId, on_date: "2026-10-20", skip: true, patch: null }));
    await no("갑의 일정 예외 빼기", sched.dropException(A.repeatId, "2026-10-13"));
    await no("갑의 일정 나누기", sched.splitEvent(A.repeatId, A.repeatV, "2026-10-13", { title: "침입" }));
    await no("갑의 일정 자르기", sched.cutEvent(A.repeatId, A.repeatV, "2026-10-13"));
    await no("갑의 할 일", sched.getTask(A.taskId));
    await no("갑의 할 일 고치기", sched.updateTask(A.taskId, { title: "침입" }, A.taskV));
    await no("갑의 할 일 지우기", sched.deleteTask(A.taskId, A.taskV));
    await no("갑의 할 일 작업대", sched.benchTask(A.taskId, true));
    await no("갑의 할 일 시간 재기", sched.workStart(A.taskId));
    await no("갑의 모임 참조", sched.meetRef(A.fixedId));
    await no("갑의 규칙", sched.getRule(A.ruleId));
    await no("갑의 규칙 고치기", sched.updateRule(A.ruleId, { title: "침입" }, A.ruleV));
    await no("갑의 규칙 멈추기", sched.stopRule(A.ruleId));
    await no("갑의 일정에 딸린 규칙 옮기기", sched.moveRules(A.repeatId, A.eventId));
    await no("갑의 지점으로 일정 넣기", sched.insertEvent({ title: "침입", date: "2026-10-06", start_min: 540, end_min: 600, place_id: A.placeId, where_text: null, travel_min: null, note: null, repeat: null, task_id: null }));
    await no("갑의 할 일과 이은 일정 넣기", sched.insertEvent({ title: "침입", date: "2026-10-06", start_min: 540, end_min: 600, place_id: null, where_text: null, travel_min: null, note: null, repeat: null, task_id: A.taskId }));
    await no("갑의 모임", meet.getMeet(A.pollId));
    await no("갑의 모임 고치기", meet.updateMeet(A.pollId, { title: "침입" }, A.pollV));
    await no("갑의 모임 지우기", meet.deleteMeet(A.pollId, A.pollV));
    await no("갑의 모임 시간 정하기", meet.decide(A.pollId, A.pollV, "2026-10-08", 600, 660));
    await no("갑의 모임 시간 비우기", meet.reopen(A.fixedId, A.fixedV));
    await no("갑의 모임에 사람 넣기", meet.addPeople(A.pollId, ["침입자"]));
    await no("갑의 모임 내 칸", meet.setMyCells(A.pollId, {}));
    await no("갑의 모임 링크 끄기", meet.setLink(A.pollId, false, A.pollV));
    const people = (await db.query<{ id: string }>("select id from ez_meet_people where meet_id = $1", [A.pollId])).rows.map((r) => r.id);
    await no("갑의 모임 사람 빼기", meet.removePeople(A.pollId, people));
    await no("갑의 모임 참석", meet.setAttend(A.fixedId, people[0]!, "yes"));
    expect(await snapshot(A.a.owner)).toEqual(before);
  });
});
