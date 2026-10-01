// MCP 일정 4개 · 플래너 2개 도구를 진짜 DB 규칙(PGlite + 마이그레이션 전부, service_role) 위에서 시험한다.
// 준비 방식은 drawer.test.ts 와 같다. 날짜: 2026-10-05 가 월요일.

import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDrawer, type ToolResult } from "./drawer";
import { closestName, createSchedule, hm, parseHM } from "./schedule";
import { PgliteScheduleStore } from "./schedule-store-pglite";
import { PgliteStore, createTestDb } from "./store-pglite";
import { SCHEDULE_TOOLS, TOOL_NAMES, registerTools } from "./tools";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

type Row = Record<string, any>;

function setup(owner = randomUUID()) {
  const store = new PgliteScheduleStore(db, owner);
  let clock = new Date("2026-10-01T03:00:00Z");
  const s = createSchedule({ store, now: () => clock });
  const tick = (ms = 60_000) => (clock = new Date(clock.getTime() + ms));
  return { owner, store, s, tick };
}

/** 집 · 회사(work) · 학교(school), 이동 집↔회사 40 · 집↔학교 30 · 회사↔학교 20 */
async function withPlaces(owner = randomUUID()) {
  const ctx = setup(owner);
  const home = await ctx.store.insertPlace({ name: "집", role: "home" });
  const work = await ctx.store.insertPlace({ name: "회사", role: "work" });
  const school = await ctx.store.insertPlace({ name: "학교", role: "school" });
  await ctx.store.setTravel(home.id, work.id, 40);
  await ctx.store.setTravel(home.id, school.id, 30);
  await ctx.store.setTravel(work.id, school.id, 20);
  return { ...ctx, home, work, school };
}

function good(r: ToolResult): Row {
  expect(r.ok, `${r.summary}\n${JSON.stringify(r.data)}`).toBe(true);
  return r.data as Row;
}
function bad(r: ToolResult, code?: string): Row {
  expect(r.ok, `실패해야 합니다: ${r.summary}`).toBe(false);
  const d = r.data as Row;
  expect(d.error.message).toBe(r.summary);
  if (code) expect(d.error.code, r.summary).toBe(code);
  return d;
}

async function raw(id: string): Promise<Row> {
  return (await db.query<Row>("select *, date::text as date from ez_events where id = $1", [id])).rows[0]!;
}
async function exs(id: string): Promise<Row[]> {
  return (await db.query<Row>("select on_date::text as on_date, skip, patch from ez_event_exceptions where event_id = $1 order by on_date", [id])).rows;
}
async function liveEvents(owner: string): Promise<Row[]> {
  return (await db.query<Row>("select id, title, date::text as date, start_min, end_min, place_id, source, external_id, task_id from ez_events where owner = $1 and deleted_at is null order by 3, 4", [owner])).rows;
}

/** 하루 결과 */
const dayOf = (d: Row, date: string) => (d.days as Row[]).find((x) => x.date === date)!;

// ---------------------------------------------------------------------------

describe("표기", () => {
  it("HH:MM 읽기·쓰기, 다음 날 +1", () => {
    expect(parseHM("09:30")).toBe(570);
    expect(parseHM("9:05")).toBe(545);
    expect(parseHM("24:00")).toBe(1440);
    for (const x of ["24:01", "12:60", "9시", "0930", "", 930]) expect(parseHM(x)).toBeNull();
    expect(hm(0)).toBe("00:00");
    expect(hm(1440)).toBe("24:00");
    expect(hm(1500)).toBe("01:00+1");
    expect(hm(-30)).toBe("23:30-1");
  });

  it("가까운 이름: 품는 것 먼저, 그다음 편집 거리", () => {
    expect(closestName("회샤", ["집", "회사", "학교"])).toBe("회사");
    expect(closestName("학교", ["집", "학교 앞", "회사"])).toBe("학교 앞");
    expect(closestName("x", [])).toBeNull();
  });
});

describe("schedule_get", () => {
  it("기간은 62일까지, 넘으면 나눠 부르라는 오류", async () => {
    const { s } = setup();
    good(await s.schedule_get({ from: "2026-10-01", to: "2026-12-01" })); // 62일
    const d = bad(await s.schedule_get({ from: "2026-10-01", to: "2026-12-02" }), "RANGE");
    expect(d.error.message).toContain("63일");
    expect(d.error.message).toContain("나눠");
    bad(await s.schedule_get({ from: "2026-10-05", to: "2026-10-04" }), "BAD_INPUT");
    bad(await s.schedule_get({ from: "2026-02-30", to: "2026-03-01" }), "BAD_INPUT");
    bad(await s.schedule_get({ from: "2026-10-05", to: "2026-10-05", free_min: 0 }), "BAD_INPUT");
  });

  it("회차 + 준비·출근·귀가 띠 + 식사, 지점 목록", async () => {
    const { s } = await withPlaces();
    const saved = good(await s.schedule_save({ title: "근무", date: "2026-10-05", start: "09:00", end: "18:00", place: "회사" }));
    const r = await s.schedule_get({ from: "2026-10-05", to: "2026-10-06" });
    const d = good(r);
    const mon = dayOf(d, "2026-10-05");
    expect(mon.wd).toBe("월");
    expect(mon.events).toEqual([
      { id: saved.event.id, on_date: "2026-10-05", title: "근무", time: "09:00–18:00", all_day: false, place: "회사", version: 1 },
    ]);
    expect(mon.bands).toEqual([
      { kind: "준비", time: "07:45–08:20" },
      { kind: "출근", time: "08:20–09:00", from: "집", to: "회사" },
      { kind: "귀가", time: "18:00–18:40", from: "회사", to: "집" },
    ]);
    expect(mon.meals).toEqual([
      { meal: "점심", missing: true },
      { meal: "저녁", time: "18:40–19:20" },
    ]);
    expect(dayOf(d, "2026-10-06")).toEqual({ date: "2026-10-06", wd: "화", events: [], bands: [] });
    expect(d.places).toEqual([
      { name: "집", role: "home" },
      { name: "회사", role: "work" },
      { name: "학교", role: "school" },
    ]);
    expect(r.summary).toBe("10/5(월)~10/6(화) · 일정 1개 · 식사 틈 없음 1번");
  });

  it("앞 일정 끝보다 일찍 나가야 하면 늦음 N분", async () => {
    const { s } = await withPlaces();
    good(await s.schedule_save({ title: "오전 근무", date: "2026-10-05", start: "09:00", end: "12:00", place: "회사" }));
    good(await s.schedule_save({ title: "수업", date: "2026-10-05", start: "12:10", end: "13:00", place: "학교" }));
    const r = await s.schedule_get({ from: "2026-10-05", to: "2026-10-05" });
    const bands = dayOf(good(r), "2026-10-05").bands as Row[];
    expect(bands).toContainEqual({ kind: "등교", time: "11:50–12:10", from: "회사", to: "학교", late_min: 10 });
    expect(r.summary).toContain("늦음 1곳");
  });

  it("free_min: 동선·준비를 뺀 07~24시 빈 시간", async () => {
    const { s } = await withPlaces();
    good(await s.schedule_save({ title: "근무", date: "2026-10-05", start: "09:00", end: "18:00", place: "회사" }));
    const a = dayOf(good(await s.schedule_get({ from: "2026-10-05", to: "2026-10-05", free_min: 30 })), "2026-10-05");
    expect(a.free).toEqual(["07:00–07:45", "18:40–24:00"]);
    const b = dayOf(good(await s.schedule_get({ from: "2026-10-05", to: "2026-10-05", free_min: 60 })), "2026-10-05");
    expect(b.free).toEqual(["18:40–24:00"]);
    // 일정이 없는 날은 통째로
    const c = dayOf(good(await s.schedule_get({ from: "2026-10-06", to: "2026-10-06", free_min: 60 })), "2026-10-06");
    expect(c.free).toEqual(["07:00–24:00"]);
  });

  it("자정을 넘는 일정: +1 표기, 다음 날만 보면 첫날에 넘어온 회차로", async () => {
    const { s } = setup();
    const e = good(await s.schedule_save({ title: "야간", date: "2026-10-05", start: "22:00", end: "02:00" })).event;
    expect(e.time).toBe("22:00–02:00+1");
    const d = good(await s.schedule_get({ from: "2026-10-06", to: "2026-10-06", free_min: 60 }));
    const tue = dayOf(d, "2026-10-06");
    expect(tue.events).toEqual([expect.objectContaining({ id: e.id, on_date: "2026-10-05", date: "2026-10-05", time: "22:00–02:00+1" })]);
    expect(tue.free).toEqual(["07:00–24:00"]); // 02:00 에 끝나므로 07시 뒤는 비어 있다
  });
});

describe("schedule_save — 넣기", () => {
  it("지점 이름은 대소문자·앞뒤 공백 무시, 분으로 저장", async () => {
    const { s, work } = await withPlaces();
    await s.schedule_save({ title: "x", date: "2026-10-05", start: "09:00", end: "10:00", place: "회사" });
    const r = await s.schedule_save({ title: "  회의  ", date: "2026-10-06", start: "09:30", end: "10:15", place: "  회사 ", where: " 3층 ", note: "" });
    const d = good(r);
    expect(r.summary).toBe("넣었습니다: 회의 · 10/6(화) 09:30–10:15 · 회사");
    const row = await raw(d.event.id);
    expect(row).toMatchObject({ title: "회의", date: "2026-10-06", start_min: 570, end_min: 615, place_id: work.id, where_text: "3층", note: null, version: 1 });
  });

  it("end 가 start 보다 이르거나 같으면 다음 날 (최대 24시간)", async () => {
    const { s } = setup();
    const a = good(await s.schedule_save({ title: "밤샘", date: "2026-10-05", start: "23:00", end: "01:00" }));
    expect((await raw(a.event.id)).end_min).toBe(1500);
    const b = good(await s.schedule_save({ title: "하루 꼬박", date: "2026-10-05", start: "09:00", end: "09:00" }));
    expect((await raw(b.event.id)).end_min).toBe(540 + 1440);
    expect(b.event.time).toBe("09:00–09:00+1");
  });

  it("종일 · 시각 빠짐 · 형식 오류", async () => {
    const { s } = setup();
    const a = good(await s.schedule_save({ title: "휴가", date: "2026-10-05", all_day: true }));
    expect(a.event).toMatchObject({ time: null, all_day: true });
    expect(bad(await s.schedule_save({ title: "x", date: "2026-10-05" }), "BAD_INPUT").errors).toEqual([
      { path: "start", reason: "start·end(HH:MM) 또는 all_day: true 를 주세요" },
    ]);
    expect(bad(await s.schedule_save({ title: "x", date: "2026-10-05", start: "09:00" }), "BAD_INPUT").errors[0].path).toBe("end");
    expect(bad(await s.schedule_save({ title: "x", date: "2026-10-05", start: "9시", end: "10:00" }), "BAD_INPUT").errors[0].path).toBe("start");
    expect(bad(await s.schedule_save({ title: "x", date: "2026-10-05", all_day: true, start: "09:00" }), "BAD_INPUT").errors[0].path).toBe("all_day");
    const d = bad(await s.schedule_save({ date: "2026-13-01", start: "09:00", end: "10:00" }), "BAD_INPUT");
    expect(d.errors.map((e: Row) => e.path)).toEqual(["title", "date"]);
    expect(d.error.message).toContain("title: 제목이 없습니다");
  });

  it("없는 지점 이름이면 가장 가까운 이름 제안, place null 은 지점 없음", async () => {
    const { s } = await withPlaces();
    const d = bad(await s.schedule_save({ title: "x", date: "2026-10-05", start: "09:00", end: "10:00", place: "회샤" }), "PLACE_NOT_FOUND");
    expect(d.suggest).toBe("회사");
    expect(d.places).toEqual(["집", "회사", "학교"]);
    expect(d.error.message).toContain('가장 가까운 이름은 "회사"');
    const ok = good(await s.schedule_save({ title: "x", date: "2026-10-05", start: "09:00", end: "10:00", place: null }));
    expect(ok.event.place).toBeNull();
    // 지점이 하나도 없으면
    const none = bad(await setup().s.schedule_save({ title: "x", date: "2026-10-05", all_day: true, place: "집" }), "PLACE_NOT_FOUND");
    expect(none.error.message).toContain("지점이 하나도 없습니다");
  });

  it("반복: 요일은 월..일, 결과도 요일 이름", async () => {
    const { s } = setup();
    const d = good(
      await s.schedule_save({ title: "수업", date: "2026-10-05", start: "09:00", end: "10:30", repeat: { freq: "weekly", days: ["수", "월요일"], until: "2026-12-31" } }),
    );
    expect(d.event.repeat).toEqual({ freq: "weekly", days: ["월", "수"], until: "2026-12-31" });
    expect((await raw(d.event.id)).repeat).toEqual({ freq: "weekly", days: [1, 3], until: "2026-12-31" });
    bad(await s.schedule_save({ title: "x", date: "2026-10-05", all_day: true, repeat: { freq: "weekly", days: ["X"] } }), "BAD_INPUT");
    const noDays = bad(await s.schedule_save({ title: "x", date: "2026-10-05", all_day: true, repeat: { freq: "weekly" } }), "BAD_INPUT");
    expect(noDays.errors[0].path).toBe("repeat.days");
    // DB 만 아는 규칙: until 까지 반복되는 날이 없음 → [EZ_VALUE] 를 위치·이유로
    const db = bad(await s.schedule_save({ title: "x", date: "2026-10-05", all_day: true, repeat: { freq: "weekly", days: ["수"], until: "2026-10-06" } }), "EZ_VALUE");
    expect(db.errors).toEqual([{ path: "repeat.until", reason: "끝나는 날(until)까지 반복되는 날이 없습니다" }]);
  });
});

describe("schedule_save — 고치기", () => {
  it("base_version 필수, 낡으면 충돌 + 현재 값", async () => {
    const { s } = setup();
    const e = good(await s.schedule_save({ title: "회의", date: "2026-10-05", start: "09:00", end: "10:00" })).event;
    bad(await s.schedule_save({ id: e.id, title: "x" }), "BAD_INPUT");
    const r = good(await s.schedule_save({ id: e.id, base_version: 1, title: "팀 회의" }));
    expect(r.event).toMatchObject({ title: "팀 회의", version: 2 });
    const c = bad(await s.schedule_save({ id: e.id, base_version: 1, title: "또" }), "EZ_VERSION");
    expect(c).toMatchObject({ conflict: true, current: { title: "팀 회의", version: 2 } });
    bad(await s.schedule_save({ id: randomUUID(), base_version: 1, title: "x" }), "NOT_FOUND");
    bad(await s.schedule_save({ id: "abc", base_version: 1 }), "BAD_INPUT");
  });

  it("start 만 주면 길이 유지, 바뀐 게 없으면 그대로", async () => {
    const { s } = setup();
    const e = good(await s.schedule_save({ title: "회의", date: "2026-10-05", start: "09:00", end: "10:00" })).event;
    const r = good(await s.schedule_save({ id: e.id, base_version: 1, start: "11:00" }));
    expect(r.event.time).toBe("11:00–12:00");
    const same = await s.schedule_save({ id: e.id, base_version: 2, title: "회의", start: "11:00" });
    expect(good(same).changed).toBe(false);
    expect(same.summary).toContain("바뀐 것이 없습니다");
  });

  it("반복 일정은 on_date + scope 를 물어본다", async () => {
    const { s } = setup();
    const e = good(await s.schedule_save({ title: "수업", date: "2026-10-05", start: "09:00", end: "10:00", repeat: { freq: "weekly", days: ["월", "수"] } })).event;
    const d = bad(await s.schedule_save({ id: e.id, base_version: 1, title: "x" }), "NEED_SCOPE");
    expect(d.error.message).toContain("on_date");
    expect(d.repeat).toEqual({ freq: "weekly", days: ["월", "수"] });
    bad(await s.schedule_save({ id: e.id, base_version: 1, scope: "once", title: "x" }), "NEED_SCOPE");
    bad(await s.schedule_save({ id: e.id, base_version: 1, scope: "once", on_date: "2026-10-06", title: "x" }), "EZ_DATE"); // 화요일
    bad(await s.schedule_save({ id: e.id, base_version: 1, scope: "once", on_date: "2026-10-07", repeat: null }), "BAD_INPUT");
  });

  it("once: 예외 한 줄 (바뀐 칸만), 겹쳐 고치면 합치고, 원래대로면 예외를 지운다", async () => {
    const { s, school } = await withPlaces();
    const e = good(await s.schedule_save({ title: "수업", date: "2026-10-05", start: "09:00", end: "10:00", repeat: { freq: "weekly", days: ["월", "수"] } })).event;
    const r = await s.schedule_save({ id: e.id, base_version: 1, on_date: "2026-10-07", scope: "once", title: "보강", start: "14:00" });
    expect(r.summary).toBe("10/7(수) 회차만 고쳤습니다: 보강 · 10/7(수) 14:00–15:00");
    expect(await exs(e.id)).toEqual([{ on_date: "2026-10-07", skip: false, patch: { title: "보강", start_min: 840, end_min: 900 } }]);
    expect((await raw(e.id)).version).toBe(1); // 일정 행은 그대로

    good(await s.schedule_save({ id: e.id, base_version: 1, on_date: "2026-10-07", scope: "once", place: "학교" }));
    expect((await exs(e.id))[0]!.patch).toEqual({ title: "보강", start_min: 840, end_min: 900, place_id: school.id });

    const d = good(await s.schedule_get({ from: "2026-10-05", to: "2026-10-11" }));
    expect(dayOf(d, "2026-10-05").events[0]).toMatchObject({ title: "수업", time: "09:00–10:00" });
    expect(dayOf(d, "2026-10-07").events[0]).toMatchObject({ title: "보강", time: "14:00–15:00", place: "학교", changed: true, repeat: { freq: "weekly" } });

    // 원래 값으로 돌려놓으면 예외가 사라진다
    const back = await s.schedule_save({ id: e.id, base_version: 1, on_date: "2026-10-07", scope: "once", title: "수업", start: "09:00", place: null });
    expect(back.summary).toContain("원래대로 되돌렸습니다");
    expect(await exs(e.id)).toEqual([]);
  });

  it("following: 그날부터 새 일정으로 나누고, 이후 예외는 새 일정으로 옮긴다", async () => {
    const { s } = setup();
    const e = good(await s.schedule_save({ title: "수업", date: "2026-10-05", start: "09:00", end: "10:00", repeat: { freq: "weekly", days: ["월", "수"] } })).event;
    good(await s.schedule_save({ id: e.id, base_version: 1, on_date: "2026-10-14", scope: "once", title: "특강" }));
    const r = await s.schedule_save({ id: e.id, base_version: 1, on_date: "2026-10-12", scope: "following", start: "10:00", end: "11:00" });
    const d = good(r);
    expect(d).toMatchObject({ split: true, original_id: e.id, event: { date: "2026-10-12", time: "10:00–11:00", repeat: { freq: "weekly", days: ["월", "수"] } } });
    expect(r.summary).toContain("10/12(월) 부터 새 일정으로");
    expect((await raw(e.id)).repeat).toEqual({ freq: "weekly", days: [1, 3], until: "2026-10-11" });
    expect(await exs(d.event.id)).toEqual([{ on_date: "2026-10-14", skip: false, patch: { title: "특강" } }]);
    expect(await exs(e.id)).toEqual([]);

    // 첫 회차에서 following 이면 전체를 고친다
    const f = good(await s.schedule_save({ id: e.id, base_version: 2, on_date: "2026-10-05", scope: "following", title: "전공" }));
    expect(f).toMatchObject({ split: false, event: { id: e.id, title: "전공", version: 3 } });
  });

  it("all: 반복 행 자체를 고친다 (version +1)", async () => {
    const { s } = setup();
    const e = good(await s.schedule_save({ title: "운동", date: "2026-10-05", start: "07:00", end: "08:00", repeat: { freq: "daily" } })).event;
    const r = await s.schedule_save({ id: e.id, base_version: 1, scope: "all", title: "아침 운동", repeat: { freq: "daily", until: "2026-10-09" } });
    expect(good(r).event).toMatchObject({ title: "아침 운동", version: 2, repeat: { freq: "daily", until: "2026-10-09" } });
    expect(r.summary).toContain("반복 전체를 고쳤습니다");
    const d = good(await s.schedule_get({ from: "2026-10-05", to: "2026-10-11" }));
    expect((d.days as Row[]).map((x) => x.events.length)).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });
});

describe("schedule_delete", () => {
  it("반복 아님: soft delete", async () => {
    const { s, owner } = setup();
    const e = good(await s.schedule_save({ title: "치과", date: "2026-10-05", start: "15:00", end: "16:00" })).event;
    const r = await s.schedule_delete({ id: e.id });
    expect(r.summary).toBe("지웠습니다: 치과 · 10/5(월) 15:00–16:00");
    expect((await raw(e.id)).deleted_at).not.toBeNull();
    expect(await liveEvents(owner)).toEqual([]);
    bad(await s.schedule_delete({ id: e.id }), "NOT_FOUND");
  });

  it("반복: once 는 예외 skip, following 은 끊기, all 은 전체", async () => {
    const { s } = setup();
    const mk = async () =>
      good(await s.schedule_save({ title: "수업", date: "2026-10-05", start: "09:00", end: "10:00", repeat: { freq: "weekly", days: ["월", "수"] } })).event;
    const a = await mk();
    bad(await s.schedule_delete({ id: a.id }), "NEED_SCOPE");
    const once = await s.schedule_delete({ id: a.id, on_date: "2026-10-07", scope: "once" });
    expect(once.summary).toBe("10/7(수) 회차만 지웠습니다: 수업");
    expect(await exs(a.id)).toEqual([{ on_date: "2026-10-07", skip: true, patch: null }]);
    const d = good(await s.schedule_get({ from: "2026-10-05", to: "2026-10-11" }));
    expect(dayOf(d, "2026-10-07").events).toEqual([]);

    const fol = await s.schedule_delete({ id: a.id, on_date: "2026-10-12", scope: "following" });
    expect(fol.summary).toBe("10/12(월) 부터 지웠습니다 (10/11(일) 까지 남음): 수업");
    expect((await raw(a.id)).repeat.until).toBe("2026-10-11");

    const b = await mk();
    const first = await s.schedule_delete({ id: b.id, on_date: "2026-10-05", scope: "following" });
    expect(first.summary).toContain("첫 회차라 반복 전체를 지웠습니다");
    expect((await raw(b.id)).deleted_at).not.toBeNull();

    const c = await mk();
    good(await s.schedule_delete({ id: c.id, scope: "all" }));
    expect((await raw(c.id)).deleted_at).not.toBeNull();
  });
});

describe("바깥 일정 · schedule_sync", () => {
  it("넣기·고치기·지우기 수, 지점 이름 → id, 출처 표시", async () => {
    const { s, owner, work } = await withPlaces();
    const ev = (id: string, date: string, extra: Row = {}) => ({ external_id: id, title: "근무", date, start: "13:00", end: "18:00", ...extra });
    const r1 = await s.schedule_sync({
      source: "studycube",
      from: "2026-10-01",
      to: "2026-10-31",
      label: "스터디큐브",
      events: [ev("w1", "2026-10-05", { place: "회사" }), ev("w2", "2026-10-06"), { external_id: "w3", title: "휴무", date: "2026-10-07", all_day: true }],
    });
    expect(good(r1)).toEqual({ inserted: 3, updated: 0, deleted: 0 });
    expect(r1.summary).toBe("스터디큐브(studycube) 10/1(목)~10/31(토) 맞춤: 넣음 3 · 고침 0 · 지움 0");
    const rows = await liveEvents(owner);
    expect(rows[0]).toMatchObject({ source: "studycube", external_id: "w1", place_id: work.id, start_min: 780 });

    const r2 = good(
      await s.schedule_sync({ source: "studycube", from: "2026-10-01", to: "2026-10-31", events: [ev("w1", "2026-10-05", { place: "회사", end: "19:00" }), ev("w2", "2026-10-06"), ev("w4", "2026-10-08")] }),
    );
    expect(r2).toEqual({ inserted: 1, updated: 1, deleted: 1 });

    const d = good(await s.schedule_get({ from: "2026-10-05", to: "2026-10-05" }));
    expect(dayOf(d, "2026-10-05").events[0]).toMatchObject({ title: "근무", time: "13:00–19:00", place: "회사", source: "studycube" });
  });

  it("틀린 건이 있으면 위치·이유 목록, 아무것도 안 바꿈", async () => {
    const { s, owner } = await withPlaces();
    const r = await s.schedule_sync({
      source: "univ",
      from: "2026-10-01",
      to: "2026-10-31",
      events: [
        { external_id: "a", title: "좋음", date: "2026-10-05", start: "09:00", end: "10:00" },
        { external_id: "b", title: "지점", date: "2026-10-05", start: "09:00", end: "10:00", place: "학꾜" },
        { external_id: "c", title: "시각", date: "2026-10-05", start: "9am", end: "10:00" },
        { title: "id 없음", date: "2026-10-05", all_day: true },
        { external_id: "e", title: "밖", date: "2026-11-05", all_day: true },
      ],
    });
    const d = bad(r, "EZ_SYNC");
    expect(d.errors.map((e: Row) => [e.index, e.path])).toEqual([
      [1, "place"],
      [2, "start"],
      [3, "external_id"],
      [4, "date"],
    ]);
    expect(d.errors[0].reason).toContain('"학교"');
    expect(r.summary).toContain("events 4곳이 틀려 아무것도 바꾸지 않았습니다");
    expect(await liveEvents(owner)).toEqual([]);
    // DB 쪽 거절도 같은 모양 (출처 이름 규칙)
    const src = bad(await s.schedule_sync({ source: "Univ Time", from: "2026-10-01", to: "2026-10-31", events: [] }), "EZ_VALUE");
    expect(src.error.message).toContain("출처(source)");
  });

  it("바깥 일정은 schedule_save · schedule_delete 로 못 바꾼다", async () => {
    const { s } = setup();
    good(await s.schedule_sync({ source: "apptive", from: "2026-10-01", to: "2026-10-31", events: [{ external_id: "m1", title: "정기 모임", date: "2026-10-08", start: "19:00", end: "21:00" }] }));
    const id = (good(await s.schedule_get({ from: "2026-10-08", to: "2026-10-08" })).days[0].events[0] as Row).id;
    const a = bad(await s.schedule_save({ id, base_version: 1, title: "x" }), "EZ_EXTERNAL");
    expect(a.error.message).toBe("바깥 일정(apptive)이라 여기서 못 고칩니다. schedule_sync 로 바꾸세요");
    expect(bad(await s.schedule_delete({ id }), "EZ_EXTERNAL").error.message).toContain("못 지웁니다");
  });
});

describe("플래너 · todo_list · todo_save", () => {
  it("새 할 일은 맨 위, query 는 제목·메모 부분 일치(대소문자 무시)", async () => {
    const { s } = setup();
    good(await s.todo_save({ title: "장보기", note: "우유, Coffee" }));
    good(await s.todo_save({ title: "보고서 쓰기", due: "2026-10-10", est_min: 90 }));
    const r = await s.todo_list({});
    expect((good(r).items as Row[]).map((t) => t.title)).toEqual(["보고서 쓰기", "장보기"]);
    expect(good(r).items[0]).toMatchObject({ due: "2026-10-10", est_min: 90, version: 1 });
    expect(r.summary).toBe("할 일 2개 (안 끝남)");
    expect((good(await s.todo_list({ query: "coffee" })).items as Row[]).map((t) => t.title)).toEqual(["장보기"]);
    bad(await s.todo_list({ status: "later" }), "BAD_INPUT");
  });

  it("검사: 제목 · 걸릴 시간 · 마감, 고칠 땐 base_version", async () => {
    const { s } = setup();
    expect(bad(await s.todo_save({ title: "  " }), "BAD_INPUT").errors).toEqual([{ path: "title", reason: "제목이 비어 있습니다" }]);
    expect(bad(await s.todo_save({ title: "x", est_min: 3, due: "10/5" }), "BAD_INPUT").errors.map((e: Row) => e.path)).toEqual(["due", "est_min"]);
    const t = good(await s.todo_save({ title: "x" })).task;
    bad(await s.todo_save({ id: t.id, title: "y" }), "BAD_INPUT");
    bad(await s.todo_save({ delete: true }), "BAD_INPUT");
  });

  it("끝냄 · 되돌림 · 낡은 버전 · done 정렬", async () => {
    const { s, tick } = setup();
    const a = good(await s.todo_save({ title: "A" })).task;
    const b = good(await s.todo_save({ title: "B" })).task;
    const done = await s.todo_save({ id: a.id, base_version: 1, done: true });
    expect(done.summary).toBe("끝냈습니다: A");
    expect(good(done).task.done_at).toBe("2026-10-01T03:00:00.000Z");
    tick();
    good(await s.todo_save({ id: b.id, base_version: 1, done: true }));
    expect((good(await s.todo_list({ status: "done" })).items as Row[]).map((t) => t.title)).toEqual(["B", "A"]);
    expect(good(await s.todo_list({})).items).toEqual([]);

    const c = bad(await s.todo_save({ id: a.id, base_version: 1, done: false }), "EZ_VERSION");
    expect(c.current).toMatchObject({ title: "A", version: 2 });
    const re = await s.todo_save({ id: a.id, base_version: 2, done: false });
    expect(re.summary).toBe("다시 열었습니다: A");
    expect(good(re).task.done_at).toBeUndefined();
    expect((good(await s.todo_list({ status: "all" })).items as Row[]).map((t) => t.title)).toEqual(["A", "B"]);
  });

  it("schedule_save(task_id) 로 잇기: 길이 기본=est_min, todo_list 에 이어진 일정, 한 할 일에 일정 하나", async () => {
    const { s } = setup();
    const t = good(await s.todo_save({ title: "보고서 쓰기", est_min: 90 })).task;
    const r = await s.schedule_save({ title: "보고서 쓰기", date: "2026-10-06", start: "14:00", task_id: t.id });
    const e = good(r).event;
    expect(e).toMatchObject({ time: "14:00–15:30", task_id: t.id });
    expect(r.summary).toContain('할 일 "보고서 쓰기" 과 이음');
    expect(good(await s.todo_list({})).items[0].event).toEqual({ id: e.id, date: "2026-10-06", time: "14:00" });

    const taken = bad(await s.schedule_save({ title: "또", date: "2026-10-07", start: "10:00", task_id: t.id }), "TASK_TAKEN");
    expect(taken.event.id).toBe(e.id);
    // est_min 이 없으면 60분
    const u = good(await s.todo_save({ title: "전화" })).task;
    expect(good(await s.schedule_save({ title: "전화", date: "2026-10-06", start: "16:00", task_id: u.id })).event.time).toBe("16:00–17:00");
    bad(await s.schedule_save({ title: "x", date: "2026-10-06", start: "16:00", task_id: randomUUID() }), "NOT_FOUND");

    // 있던 일정에 잇기 (all) → 끊기
    const w = good(await s.todo_save({ title: "운동" })).task;
    const plain = good(await s.schedule_save({ title: "운동", date: "2026-10-08", start: "07:00", end: "08:00" })).event;
    expect(good(await s.schedule_save({ id: plain.id, base_version: 1, task_id: w.id })).event.task_id).toBe(w.id);
    const cut = await s.schedule_save({ id: plain.id, base_version: 2, task_id: null });
    expect(cut.summary).toContain("할 일과 연결을 끊음");
    expect(good(cut).event.task_id).toBeUndefined();

    // 일정을 지우면 할 일은 다시 시간 없음
    const del = await s.schedule_delete({ id: e.id });
    expect(del.summary).toContain("이어진 할 일은 다시 '시간 없음' 으로");
    expect(good(await s.todo_list({ query: "보고서" })).items[0].event).toBeUndefined();
  });

  it("할 일 지우기: soft delete, 이어진 일정은 남고 연결만 끊긴다", async () => {
    const { s, owner } = setup();
    const t = good(await s.todo_save({ title: "책 읽기" })).task;
    const e = good(await s.schedule_save({ title: "책 읽기", date: "2026-10-06", start: "20:00", end: "21:00", task_id: t.id })).event;
    bad(await s.todo_save({ id: t.id, base_version: 1, delete: true, title: "x" }), "BAD_INPUT");
    const r = await s.todo_save({ id: t.id, base_version: 1, delete: true });
    expect(r.summary).toContain("지웠습니다: 책 읽기 (이어진 일정 책 읽기 · 10/6(화) 20:00–21:00 은 남기고 연결만 끊었습니다)");
    expect(good(await s.todo_list({ status: "all" })).items).toEqual([]);
    const ev = await raw(e.id);
    expect(ev).toMatchObject({ deleted_at: null, task_id: null });
    expect((await liveEvents(owner)).length).toBe(1);
    bad(await s.todo_save({ id: t.id, base_version: 1, title: "x" }), "NOT_FOUND");
  });
});

describe("다른 사람 것", () => {
  it("다른 owner 의 일정·할 일은 안 보이고 못 건드린다", async () => {
    const A = setup();
    const B = setup();
    const e = good(await A.s.schedule_save({ title: "A 일정", date: "2026-10-05", start: "09:00", end: "10:00" })).event;
    const t = good(await A.s.todo_save({ title: "A 할 일" })).task;
    expect(dayOf(good(await B.s.schedule_get({ from: "2026-10-05", to: "2026-10-05" })), "2026-10-05").events).toEqual([]);
    bad(await B.s.schedule_save({ id: e.id, base_version: 1, title: "뺏기" }), "NOT_FOUND");
    bad(await B.s.schedule_delete({ id: e.id }), "NOT_FOUND");
    expect(good(await B.s.todo_list({ status: "all" })).items).toEqual([]);
    bad(await B.s.todo_save({ id: t.id, base_version: 1, done: true }), "NOT_FOUND");
    bad(await B.s.schedule_save({ title: "x", date: "2026-10-05", start: "09:00", task_id: t.id }), "NOT_FOUND");
    expect(await raw(e.id)).toMatchObject({ title: "A 일정", version: 1, deleted_at: null });
  });
});

describe("MCP 프로토콜", () => {
  async function connect() {
    const owner = randomUUID();
    const server = new McpServer({ name: "ez-drawer", version: "test" });
    registerTools(server, createDrawer({ store: new PgliteStore(db, owner), agent: "test" }), createSchedule({ store: new PgliteScheduleStore(db, owner) }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  it("도구 12개, 일정·플래너 설명은 짧게", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(TOOL_NAMES).toHaveLength(12);
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const mine = tools.filter((t) => (SCHEDULE_TOOLS as readonly string[]).includes(t.name));
    const total = mine.reduce((n, t) => n + (t.description?.length ?? 0), 0);
    expect(total).toBeLessThan(1000);
    expect(tools.find((t) => t.name === "schedule_get")!.inputSchema.required).toEqual(["from", "to"]);
  });

  it("결과: 요약 + JSON, 실패는 isError", async () => {
    const client = await connect();
    const okRes = (await client.callTool({
      name: "schedule_save",
      arguments: { title: "회의", date: "2026-10-05", start: "09:00", end: "10:00", repeat: { freq: "weekly", days: ["월"] } },
    })) as any;
    expect(okRes.isError).toBeFalsy();
    expect(okRes.content[0].text).toBe("넣었습니다: 회의 · 10/5(월) 09:00–10:00");
    expect(JSON.parse(okRes.content[1].text).event.repeat).toEqual({ freq: "weekly", days: ["월"] });
    const badRes = (await client.callTool({ name: "schedule_get", arguments: { from: "2026-01-01", to: "2026-12-31" } })) as any;
    expect(badRes.isError).toBe(true);
    expect(JSON.parse(badRes.content[1].text).error.code).toBe("RANGE");
  });
});
