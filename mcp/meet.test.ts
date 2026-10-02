// MCP 모임 도구 2개(+ todo_save 의 meet)를 진짜 DB 규칙(PGlite + 마이그레이션 전부, service_role) 위에서 시험한다.
// 준비 방식은 schedule.test.ts 와 같다. 날짜: 2026-10-05 가 월요일. 시계는 2026-10-01 12:00(한국).

import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDrawer, type ToolResult } from "./drawer";
import { createMeet } from "./meet";
import { PgliteMeetStore } from "./meet-store-pglite";
import { createSchedule } from "./schedule";
import { PgliteScheduleStore } from "./schedule-store-pglite";
import { PgliteStore, createTestDb } from "./store-pglite";
import { MEET_TOOLS, registerTools } from "./tools";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

type Row = Record<string, any>;

function setup(owner = randomUUID()) {
  const store = new PgliteMeetStore(db, owner);
  const schedule = new PgliteScheduleStore(db, owner);
  let clock = new Date("2026-10-01T03:00:00Z");
  const m = createMeet({ store, schedule, now: () => clock });
  const s = createSchedule({ store: schedule, now: () => clock });
  /** 시계 맞추기 (예: "2026-10-05T09:00:00+09:00") */
  const at = (iso: string) => (clock = new Date(iso));
  return { owner, store, schedule, m, s, at };
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

/** 그 모임에서 온 살아 있는 일정 */
async function events(meetId: string): Promise<Row[]> {
  return (await db.query<Row>("select id, title, date::text as date, start_min, end_min, place_id, where_text from ez_events where origin_id = $1 and deleted_at is null", [meetId])).rows;
}
const names = (meet: Row) => (meet.people as Row[]).map((p) => p.name);

// ---------------------------------------------------------------------------

describe("묶음 (group)", () => {
  it("없는 이름이면 만들고, 있으면 고친다 (이름 · 사람들 · 역할). 지우면 모임은 남는다", async () => {
    const { m, schedule } = setup();
    await schedule.seedRoles();
    const made = good(await m.meet_save({ group: { name: " APPTIVE 1팀 ", members: ["민서", " 도윤 "], role: "대학" } }));
    expect(made).toMatchObject({ created: true, circle: { name: "APPTIVE 1팀", members: ["민서", "도윤"], role: "대학", version: 1 } });
    const fixed = good(await m.meet_save({ group: { name: "apptive 1팀", rename: "APPTIVE", members: ["민서", "도윤", "하린"], role: null } }));
    expect(fixed).toMatchObject({ changed: true, circle: { name: "APPTIVE", members: ["민서", "도윤", "하린"] } });
    expect(fixed.circle.role).toBeUndefined();
    expect(good(await m.meet_save({ group: { name: "APPTIVE" } })).changed).toBe(false);

    const meet = good(await m.meet_save({ title: "회의", circle: "APPTIVE" })).meet;
    good(await m.meet_save({ group: { name: "APPTIVE", delete: true } }));
    const list = good(await m.meet_get());
    expect(list.circles).toEqual([]);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].circle).toBeUndefined();
    expect(good(await m.meet_get({ id: meet.id })).meet.title).toBe("회의");
  });

  it("틀린 입력: 이름 없음 · 겹치는 사람 · 없는 역할 · 없는 묶음 · 다른 칸과 같이", async () => {
    const { m } = setup();
    bad(await m.meet_save({ group: {} as never }), "BAD_INPUT");
    expect(bad(await m.meet_save({ group: { name: "x", members: ["민서", "민 서"] } }), "BAD_INPUT").errors[0].path).toBe("group.members");
    bad(await m.meet_save({ group: { name: "x", role: "없는 역할" } }), "ROLE_NOT_FOUND");
    good(await m.meet_save({ group: { name: "스터디" } }));
    expect(bad(await m.meet_save({ group: { name: "스터듸", rename: "y" } }), "CIRCLE_NOT_FOUND").suggest).toBe("스터디");
    bad(await m.meet_save({ group: { name: "스터디" }, title: "회의" }), "BAD_INPUT");
    good(await m.meet_save({ group: { name: "다른 묶음" } }));
    bad(await m.meet_save({ group: { name: "다른 묶음", rename: "스터디" } }), "NAME_TAKEN");
  });
});

describe("meet_save — 만들기", () => {
  it("제목만 있으면 된다. 내 줄이 같이 생기고 상태는 미정", async () => {
    const { m } = setup();
    const d = good(await m.meet_save({ title: " 저녁 약속 " }));
    expect(d.created).toBe(true);
    expect(d.meet).toMatchObject({ title: "저녁 약속", status: "미정", people: [{ name: "나", me: true }], version: 1 });
    expect(d.meet.date).toBeUndefined();
    expect(await events(d.meet.id)).toHaveLength(0);
  });

  it("묶음을 주면 그 사람들이 채워진다. people 을 주면 그 사람들만", async () => {
    const { m } = setup();
    good(await m.meet_save({ group: { name: "스터디", members: ["서연", "준우"] } }));
    const a = good(await m.meet_save({ title: "3주차", circle: " 스터디" })).meet;
    expect(a.circle).toBe("스터디");
    expect(names(a)).toEqual(["나", "서연", "준우"]);
    const b = good(await m.meet_save({ title: "번개", circle: "스터디", people: ["서연", "태윤", "나"] })).meet;
    expect(names(b)).toEqual(["나", "서연", "태윤"]);
  });

  it("시간을 주면 일정에 들어간다 (지점 · 장소 글도). end 를 안 주면 1시간", async () => {
    const { m, schedule } = setup();
    const cafe = await schedule.insertPlace({ name: "카페" });
    const r = await m.meet_save({ title: "APPTIVE 회의", date: "2026-10-06", start: "19:00", end: "21:00", place: "카페", where: "2층 스터디룸", note: "안건" });
    const d = good(r);
    expect(r.summary).toBe("모임을 만들었습니다: APPTIVE 회의 10/6(화) 19:00–21:00 (일정에 넣음) · 1명");
    expect(d.meet).toMatchObject({ status: "다가옴", date: "2026-10-06", time: "19:00–21:00", place: "카페", where: "2층 스터디룸", note: "안건", in_schedule: true });
    expect(await events(d.meet.id)).toMatchObject([
      { id: d.meet.event_id, title: "APPTIVE 회의", date: "2026-10-06", start_min: 1140, end_min: 1260, place_id: cafe.id, where_text: "2층 스터디룸" },
    ]);
    expect(good(await m.meet_save({ title: "짧게", date: "2026-10-07", start: "10:00" })).meet.time).toBe("10:00–11:00");
  });

  it("틀린 입력: 제목 없음 · 시각 모양 · 자정 넘김 · 없는 묶음 · 없는 지점 · 사람 이름", async () => {
    const { m, schedule } = setup();
    await schedule.insertPlace({ name: "카페" });
    expect(bad(await m.meet_save({}), "BAD_INPUT").errors[0].path).toBe("title");
    expect(bad(await m.meet_save({ title: "x", date: "2026-10-06" }), "BAD_INPUT").errors[0].path).toBe("start");
    expect(bad(await m.meet_save({ title: "x", start: "19:00" }), "BAD_INPUT").errors[0].path).toBe("date");
    expect(bad(await m.meet_save({ title: "x", date: "2026-10-06", start: "7시" }), "BAD_INPUT").errors[0].path).toBe("start");
    expect(bad(await m.meet_save({ title: "x", date: "2026-10-06", start: "23:30", end: "00:30" }), "BAD_INPUT").errors[0].reason).toContain("자정");
    expect(bad(await m.meet_save({ title: "x", date: "2026-10-06", start: "23:30" }), "BAD_INPUT").errors[0].path).toBe("end");
    bad(await m.meet_save({ title: "x", circle: "없는 묶음" }), "CIRCLE_NOT_FOUND");
    expect(bad(await m.meet_save({ title: "x", place: "카폐" }), "PLACE_NOT_FOUND").suggest).toBe("카페");
    expect(bad(await m.meet_save({ title: "x", people: ["민서", "민서"] }), "BAD_INPUT").errors[0].path).toBe("people");
    expect(bad(await m.meet_save({ title: "x", people: "민서" as never }), "BAD_INPUT").errors[0].path).toBe("people");
    bad(await m.meet_save({ title: "x", attend: { 민서: "yes" } }), "BAD_INPUT");
    bad(await m.meet_save({ delete: true }), "BAD_INPUT");
    expect(good(await m.meet_get()).items).toHaveLength(0);
  });
});

describe("meet_save — 고치기", () => {
  it("준 칸만 바뀐다. 제목 · 장소를 바꾸면 딸린 일정도 따라간다", async () => {
    const { m } = setup();
    const a = good(await m.meet_save({ title: "회의", date: "2026-10-06", start: "19:00", end: "21:00" })).meet;
    const d = good(await m.meet_save({ id: a.id, base_version: a.version, title: "정기 회의", where: "카페 2층", note: "안건" }));
    expect(d).toMatchObject({ changed: true, meet: { title: "정기 회의", where: "카페 2층", note: "안건", time: "19:00–21:00", version: 2 } });
    expect(await events(a.id)).toMatchObject([{ title: "정기 회의", where_text: "카페 2층", start_min: 1140 }]);
    expect(good(await m.meet_save({ id: a.id, base_version: 2, title: "정기 회의" })).changed).toBe(false);
  });

  it("정하기 · 옮기기 · 다시 열기가 일정과 한 묶음이다", async () => {
    const { m } = setup();
    const a = good(await m.meet_save({ title: "회의" })).meet;
    const r1 = await m.meet_save({ id: a.id, base_version: 1, date: "2026-10-06", start: "19:00", end: "21:00" });
    expect(r1.summary).toBe("회의 10/6(화) 19:00–21:00: 시간을 정함(일정에 넣음)");
    const d1 = good(r1).meet;
    expect(d1).toMatchObject({ status: "다가옴", in_schedule: true, version: 2 });
    const e1 = await events(a.id);
    expect(e1).toMatchObject([{ date: "2026-10-06", start_min: 1140, end_min: 1260 }]);

    // start 만 주면 길이를 지킨다
    const r2 = await m.meet_save({ id: a.id, base_version: 2, date: "2026-10-08", start: "10:00" });
    expect(r2.summary).toContain("시간을 바꿈(일정도 옮김)");
    expect(good(r2).meet).toMatchObject({ date: "2026-10-08", time: "10:00–12:00" });
    expect(await events(a.id)).toMatchObject([{ id: e1[0]!.id, date: "2026-10-08", start_min: 600, end_min: 720 }]);

    const r3 = await m.meet_save({ id: a.id, base_version: good(r2).meet.version, reopen: true });
    expect(r3.summary).toContain("시간을 비움");
    expect(good(r3).meet).toMatchObject({ status: "미정" });
    expect(await events(a.id)).toHaveLength(0);
    bad(await m.meet_save({ id: a.id, base_version: good(r3).meet.version, reopen: true, date: "2026-10-09", start: "10:00" }), "BAD_INPUT");
  });

  it("일정 쪽에서 그 약속을 지우면 in_schedule 이 false — 같은 시간을 다시 주면 일정에 다시 넣는다", async () => {
    const { m, s } = setup();
    const a = good(await m.meet_save({ title: "회의", date: "2026-10-06", start: "19:00", end: "21:00" })).meet;
    good(await s.schedule_delete({ id: a.event_id }));
    const cur = good(await m.meet_get({ id: a.id })).meet;
    expect(cur).toMatchObject({ date: "2026-10-06", in_schedule: false });
    expect(cur.event_id).toBeUndefined();
    const r = await m.meet_save({ id: a.id, base_version: cur.version, date: "2026-10-06", start: "19:00", end: "21:00" });
    expect(r.summary).toContain("일정에 다시 넣음");
    expect(good(r).meet.in_schedule).toBe(true);
    expect(await events(a.id)).toHaveLength(1);
  });

  it("사람 넣고 빼기 · 참석", async () => {
    const { m } = setup();
    const a = good(await m.meet_save({ title: "회의", people: ["민서", "도윤"], date: "2026-10-06", start: "19:00" })).meet;
    const r = await m.meet_save({ id: a.id, base_version: 1, people: ["하린", "민서"], remove_people: ["도 윤"], attend: { 민서: "yes", 하린: "no", 나: "yes" } });
    const d = good(r).meet;
    expect(r.summary).toContain("1명 뺌 · 1명 넣음 · 참석 3명 적음");
    expect(d.people).toEqual([
      { name: "나", me: true, attend: "온다" },
      { name: "민서", attend: "온다" },
      { name: "하린", attend: "못 온다" },
    ]);
    // 사람 · 참석만 바꾸면 모임의 version 은 그대로
    expect(d.version).toBe(1);
    expect(good(await m.meet_save({ id: a.id, base_version: 1, attend: { 민서: null } })).meet.people[1]).toEqual({ name: "민서" });
    expect(bad(await m.meet_save({ id: a.id, base_version: 1, remove_people: ["없는 사람"] }), "PERSON_NOT_FOUND").people).toEqual(["나", "민서", "하린"]);
    bad(await m.meet_save({ id: a.id, base_version: 1, attend: { 없는사람: "yes" } }), "PERSON_NOT_FOUND");
    bad(await m.meet_save({ id: a.id, base_version: 1, remove_people: ["나"] }), "BAD_INPUT");
    bad(await m.meet_save({ id: a.id, base_version: 1, attend: { 민서: "maybe" } as never }), "BAD_INPUT");
  });

  it("버전이 다르면 충돌과 지금 값을 준다. 없는 모임 · id 모양 · base_version 없음", async () => {
    const { m } = setup();
    const a = good(await m.meet_save({ title: "회의" })).meet;
    good(await m.meet_save({ id: a.id, base_version: 1, note: "안건" }));
    const d = bad(await m.meet_save({ id: a.id, base_version: 1, title: "x" }), "EZ_VERSION");
    expect(d).toMatchObject({ conflict: true, current: { title: "회의", note: "안건", version: 2 } });
    bad(await m.meet_save({ id: randomUUID(), base_version: 1, title: "x" }), "NOT_FOUND");
    bad(await m.meet_save({ id: "abc", base_version: 1, title: "x" }), "BAD_INPUT");
    bad(await m.meet_save({ id: a.id, title: "x" }), "BAD_INPUT");
  });

  it("지우기: 모임만 지우고 딸린 일정은 남는다. 남의 모임은 없는 것", async () => {
    const { m } = setup();
    const a = good(await m.meet_save({ title: "회의", date: "2026-10-06", start: "19:00" })).meet;
    bad(await m.meet_save({ id: a.id, base_version: 1, delete: true, title: "x" }), "BAD_INPUT");
    bad(await setup().m.meet_save({ id: a.id, base_version: 1, delete: true }), "NOT_FOUND");
    const r = await m.meet_save({ id: a.id, base_version: 1, delete: true });
    expect(good(r)).toEqual({ id: a.id, deleted: true });
    expect(r.summary).toContain("딸린 일정은 남습니다");
    expect(await events(a.id)).toHaveLength(1);
    bad(await m.meet_get({ id: a.id }), "NOT_FOUND");
  });
});

describe("meet_get", () => {
  it("목록: 정할 것 → 다가오는 모임(이른 것부터) → 지난 모임(최근 것부터) + 묶음들. circle 로 좁힌다", async () => {
    const { m, at } = setup();
    good(await m.meet_save({ group: { name: "스터디", members: ["서연"] } }));
    good(await m.meet_save({ title: "지난 것", date: "2026-10-02", start: "10:00" }));
    good(await m.meet_save({ title: "더 지난 것", date: "2026-10-01", start: "13:00", circle: "스터디" }));
    good(await m.meet_save({ title: "나중", date: "2026-10-09", start: "10:00", circle: "스터디" }));
    good(await m.meet_save({ title: "곧", date: "2026-10-06", start: "10:00" }));
    good(await m.meet_save({ title: "미정" }));
    at("2026-10-05T09:00:00+09:00");
    const r = await m.meet_get();
    const d = good(r);
    expect(r.summary).toBe("모임 5개 (정할 것 1 · 다가옴 2 · 지남 2)");
    expect(d.items.map((x: Row) => [x.title, x.status])).toEqual([
      ["미정", "미정"],
      ["곧", "다가옴"],
      ["나중", "다가옴"],
      ["지난 것", "지남"],
      ["더 지난 것", "지남"],
    ]);
    expect(d.items[2]).toMatchObject({ date: "2026-10-09", time: "10:00–11:00", circle: "스터디", people: 2 });
    expect(d.circles).toMatchObject([{ name: "스터디", members: ["서연"] }]);
    const only = await m.meet_get({ circle: "스터디" });
    expect(only.summary).toBe("모임 2개 (정할 것 0 · 다가옴 1 · 지남 1) · 묶음 스터디");
    bad(await m.meet_get({ circle: "없는 묶음" }), "CIRCLE_NOT_FOUND");
    bad(await m.meet_get({ id: "abc" }), "BAD_INPUT");
  });

  it("맞추는 중인 모임은 후보 날짜를 준다 (맞추기 설정은 다음 덩어리 — 여기서는 DB 에 직접)", async () => {
    const { m, owner } = setup();
    const a = good(await m.meet_save({ title: "기획 회의" })).meet;
    await db.query("update ez_meets set poll = $2::jsonb where id = $1 and owner = $3", [
      a.id,
      JSON.stringify({ dates: ["2026-10-10", "2026-10-12"], day_from: 540, day_to: 1320, duration_min: 60 }),
      owner,
    ]);
    expect(good(await m.meet_get({ id: a.id })).meet).toMatchObject({ status: "맞추는 중", candidates: ["2026-10-10", "2026-10-12"] });
  });
});

describe("시간 맞추기 — poll · link · suggest", () => {
  const cells = async (meetId: string, name: string) =>
    (await db.query<Row>("select cells, auto, pin_hash from ez_meet_people where meet_id = $1 and name = $2", [meetId, name])).rows[0]!;
  const paint = (meetId: string, name: string, c: Row) => db.query("update ez_meet_people set cells = $3::jsonb where meet_id = $1 and name = $2", [meetId, name, JSON.stringify(c)]);

  it("poll 로 만들면 맞추는 중이 되고, 내 되는 시간이 일정에서 채워진다 (일정 · 이동을 뺀 통째로 비는 칸)", async () => {
    const { m, s } = setup();
    good(await s.schedule_save({ title: "수업", date: "2026-10-05", start: "10:00", end: "12:10" }));
    const made = good(await m.meet_save({ title: "기획 회의", people: ["민서"], poll: { dates: ["2026-10-06", "2026-10-05"], from: "09:00", to: "13:00" } }));
    expect(made.meet).toMatchObject({ status: "맞추는 중", candidates: ["2026-10-05", "2026-10-06"], poll: { dates: ["2026-10-05", "2026-10-06"], from: "09:00", to: "13:00", minutes: 60 } });
    expect(made.meet.link).toBeUndefined();
    expect(made.meet.people).toEqual([{ name: "나", me: true, painted: true }, { name: "민서" }]);
    // 12:00 칸은 12:10 까지 수업이라 반쪽 — 뺀다
    expect(await cells(made.meet.id, "나")).toMatchObject({ auto: true, cells: { "2026-10-05": [540, 570, 750], "2026-10-06": [540, 570, 600, 630, 660, 690, 720, 750] } });
    // 추천: 나만 칠했다. 10/5 09:00 이 가장 이르다
    expect(made.meet.suggest[0]).toEqual({ date: "2026-10-05", time: "09:00–10:00", count: 1, people: ["나"], me: true });
  });

  it("추천 시간: 되는 사람이 많은 순 → 내가 되는 것 먼저 → 이른 것. 겹치는 묶음은 하나만, 5개까지", async () => {
    const { m } = setup();
    const made = good(await m.meet_save({ title: "기획 회의", people: ["민서", "도윤"], poll: { dates: ["2026-10-05", "2026-10-06"], from: "09:00", to: "13:00", minutes: 90 } })).meet;
    await paint(made.id, "민서", { "2026-10-05": [600, 630, 660], "2026-10-06": [540, 570, 600] });
    await paint(made.id, "도윤", { "2026-10-05": [600, 630, 660, 690] });
    const got = good(await m.meet_get({ id: made.id })).meet;
    expect(got.people).toEqual([{ name: "나", me: true, painted: true }, { name: "민서", painted: true }, { name: "도윤", painted: true }]);
    expect(got.suggest.slice(0, 3)).toEqual([
      { date: "2026-10-05", time: "10:00–11:30", count: 3, people: ["나", "민서", "도윤"], me: true },
      { date: "2026-10-06", time: "09:00–10:30", count: 2, people: ["나", "민서"], me: true },
      { date: "2026-10-05", time: "11:30–13:00", count: 1, people: ["나"], me: true },
    ]);
    expect(got.suggest.length).toBeLessThanOrEqual(5);
    // 남의 칸 · 핀은 결과에 없다 (칠했는지만)
    expect(JSON.stringify(got)).not.toMatch(/cells|pin/);
  });

  it("내 줄이 자동 채움인 동안 meet_get 은 지금 일정으로 본다. 내가 손으로 고쳤으면(auto 꺼짐) 그대로", async () => {
    const { m, s } = setup();
    const made = good(await m.meet_save({ title: "기획 회의", poll: { dates: ["2026-10-05"], from: "09:00", to: "11:00" } })).meet;
    expect(made.suggest.map((x: Row) => x.time)).toEqual(["09:00–10:00", "10:00–11:00"]);
    good(await s.schedule_save({ title: "수업", date: "2026-10-05", start: "09:00", end: "10:00" }));
    expect(good(await m.meet_get({ id: made.id })).meet.suggest.map((x: Row) => x.time)).toEqual(["10:00–11:00"]);
    await db.query("update ez_meet_people set cells = $2::jsonb, auto = false where meet_id = $1 and is_owner", [made.id, JSON.stringify({ "2026-10-05": [540, 570] })]);
    expect(good(await m.meet_get({ id: made.id })).meet.suggest.map((x: Row) => x.time)).toEqual(["09:00–10:00"]);
  });

  it("poll 검사: 날짜 · 시각 · 길이. 시간과 같이 못 쓴다", async () => {
    const { m } = setup();
    bad(await m.meet_save({ title: "회의", poll: {} }), "BAD_INPUT");
    bad(await m.meet_save({ title: "회의", poll: { dates: [] } }), "BAD_INPUT");
    bad(await m.meet_save({ title: "회의", poll: { dates: ["10/5"] } }), "BAD_INPUT");
    bad(await m.meet_save({ title: "회의", poll: { dates: ["2026-10-05"], from: "9시" } }), "BAD_INPUT");
    bad(await m.meet_save({ title: "회의", poll: { dates: ["2026-10-05"], from: "09:15" } }), "BAD_INPUT");
    bad(await m.meet_save({ title: "회의", poll: { dates: ["2026-10-05"], from: "13:00", to: "09:00" } }), "BAD_INPUT");
    bad(await m.meet_save({ title: "회의", poll: { dates: ["2026-10-05"], minutes: 45 } }), "BAD_INPUT");
    bad(await m.meet_save({ title: "회의", poll: { dates: ["2026-10-05"], from: "09:00", to: "10:00", minutes: 90 } }), "BAD_INPUT");
    bad(await m.meet_save({ title: "회의", poll: null }), "BAD_INPUT");
    bad(await m.meet_save({ title: "회의", date: "2026-10-05", start: "10:00", poll: { dates: ["2026-10-05"] } }), "BAD_INPUT");
    expect(good(await m.meet_get()).items).toHaveLength(0);
    // 하루 끝은 24:00 까지
    expect(good(await m.meet_save({ title: "회의", poll: { dates: ["2026-10-05"], from: "20:00", to: "24:00" } })).meet.poll).toMatchObject({ from: "20:00", to: "24:00" });
  });

  it("고치기: 맞추기를 나중에 켜고 · 준 칸만 바꾸고 · 끈다. 바꾸면 내 칸을 다시 채운다", async () => {
    const { m } = setup();
    const a = good(await m.meet_save({ title: "회의" })).meet;
    expect(a.status).toBe("미정");
    const b = good(await m.meet_save({ id: a.id, base_version: a.version, poll: { dates: ["2026-10-05"], from: "09:00", to: "10:00" } }));
    expect(b.meet).toMatchObject({ status: "맞추는 중", poll: { dates: ["2026-10-05"], from: "09:00", to: "10:00", minutes: 60 } });
    expect(await cells(a.id, "나")).toMatchObject({ auto: true, cells: { "2026-10-05": [540, 570] } });
    const c = good(await m.meet_save({ id: a.id, base_version: b.meet.version, poll: { to: "11:00", minutes: 30 } })).meet;
    expect(c.poll).toEqual({ dates: ["2026-10-05"], from: "09:00", to: "11:00", minutes: 30 });
    expect((await cells(a.id, "나")).cells).toEqual({ "2026-10-05": [540, 570, 600, 630] });
    // 같은 설정을 다시 주면 바뀐 것이 없다
    expect(good(await m.meet_save({ id: a.id, base_version: c.version, poll: { minutes: 30 } })).changed).toBe(false);
    const d = good(await m.meet_save({ id: a.id, base_version: c.version, poll: null })).meet;
    expect(d.status).toBe("미정");
    expect(d.poll).toBeUndefined();
    expect(d.suggest).toBeUndefined();
  });

  it("link 로 공개 링크를 켜고 끈다. 껐다 켜면 새 링크다. 에이전트가 핀을 다루는 길은 없다", async () => {
    const { m } = setup();
    const a = good(await m.meet_save({ title: "기획 회의", poll: { dates: ["2026-10-05"] }, link: true })).meet;
    expect(a.link).toMatch(/^http:\/\/localhost:3200\/m\/[A-Za-z0-9_-]{22}$/);
    // 이미 켜져 있으면 그대로
    const same = good(await m.meet_save({ id: a.id, base_version: a.version, link: true }));
    expect(same.changed).toBe(false);
    expect(same.meet.link).toBe(a.link);
    const off = good(await m.meet_save({ id: a.id, base_version: a.version, link: false })).meet;
    expect(off.link).toBeUndefined();
    const on = good(await m.meet_save({ id: a.id, base_version: off.version, link: true })).meet;
    expect(on.link).not.toBe(a.link);
    expect(good(await m.meet_get({ id: a.id })).meet.link).toBe(on.link);
    // 그 열쇠로 남이 들어온다 (공개 함수) — 결과에는 칠했는지만 보인다
    const token = on.link.split("/m/")[1];
    await db.query("select ez_meet_enter($1, '민서', '4821')", [token]);
    await db.query("select ez_meet_answer($1, '민서', '4821', $2::jsonb)", [token, JSON.stringify({ "2026-10-05": [540, 570] })]);
    const got = good(await m.meet_get({ id: a.id })).meet;
    expect(got.people[1]).toEqual({ name: "민서", painted: true });
    expect(got.suggest[0]).toMatchObject({ time: "09:00–10:00", count: 2, people: ["나", "민서"] });
    expect(JSON.stringify(got)).not.toMatch(/4821|pin/);
    // 다른 도구 입력과 버전 충돌
    bad(await m.meet_save({ id: a.id, base_version: a.version, link: false }), "EZ_VERSION");
  });

  it("추천 시간으로 정하면 일정에 들어가고 추천은 사라진다. 다시 열면 이어서 맞춘다", async () => {
    const { m } = setup();
    const a = good(await m.meet_save({ title: "기획 회의", poll: { dates: ["2026-10-05"], from: "09:00", to: "11:00" } })).meet;
    const s0 = a.suggest[0];
    const [start, end] = s0.time.split("–");
    const b = good(await m.meet_save({ id: a.id, base_version: a.version, date: s0.date, start, end })).meet;
    expect(b).toMatchObject({ status: "다가옴", date: "2026-10-05", time: "09:00–10:00", in_schedule: true });
    expect(b.suggest).toBeUndefined();
    expect(b.poll).toMatchObject({ dates: ["2026-10-05"] });
    expect(await events(a.id)).toHaveLength(1);
    const c = good(await m.meet_save({ id: a.id, base_version: b.version, reopen: true })).meet;
    expect(c.status).toBe("맞추는 중");
    expect(c.suggest.map((x: Row) => x.time)).toEqual(["09:00–10:00", "10:00–11:00"]);
    expect(await events(a.id)).toHaveLength(0);
  });

  it("지난 후보 날짜는 추천에서 빠진다", async () => {
    const { m, at } = setup();
    const a = good(await m.meet_save({ title: "기획 회의", poll: { dates: ["2026-10-05", "2026-10-06"], from: "09:00", to: "10:00" } })).meet;
    expect(a.suggest).toHaveLength(2);
    at("2026-10-06T09:30:00+09:00");
    expect(good(await m.meet_get({ id: a.id })).meet.suggest).toEqual([]);
    at("2026-10-05T12:00:00+09:00");
    expect(good(await m.meet_get({ id: a.id })).meet.suggest.map((x: Row) => x.date)).toEqual(["2026-10-06"]);
  });
});

describe("todo_save 의 meet", () => {
  it("모임에서 나온 할 일: 모임의 지점과 묶음의 역할을 물려받고, meet_get 에 딸려 보인다", async () => {
    const { m, s, schedule } = setup();
    await schedule.seedRoles();
    await schedule.insertPlace({ name: "카페" });
    good(await m.meet_save({ group: { name: "스터디", role: "대학" } }));
    const a = good(await m.meet_save({ title: "3주차", circle: "스터디", place: "카페" })).meet;
    const r = await s.todo_save({ title: "문제 풀이 올리기", meet: a.id });
    const t = good(r).task;
    expect(r.summary).toBe("넣었습니다: 문제 풀이 올리기 (모임 3주차)");
    expect(t).toMatchObject({ title: "문제 풀이 올리기", place: "카페", role: "대학", meet: a.id });
    // 지점 · 역할을 주면 그것을 쓴다
    expect(good(await s.todo_save({ title: "따로", meet: a.id, place: null, role: "개인" })).task).toMatchObject({ role: "개인", meet: a.id });
    good(await s.todo_save({ id: t.id, base_version: t.version, done: true }));
    const got = good(await m.meet_get({ id: a.id })).meet;
    expect(got.role).toBe("대학");
    expect(got.todos.map((x: Row) => [x.title, x.done ?? false])).toEqual([
      ["문제 풀이 올리기", true],
      ["따로", false],
    ]);
    // 플래너 목록에서도 보통 할 일과 같이 보인다
    expect(good(await s.todo_list({ status: "all" })).items.map((x: Row) => x.meet)).toEqual([a.id, a.id]);
  });

  it("없는 모임 · id 모양 · 고칠 때는 못 쓴다", async () => {
    const { m, s } = setup();
    const a = good(await m.meet_save({ title: "회의" })).meet;
    bad(await s.todo_save({ title: "x", meet: randomUUID() }), "NOT_FOUND");
    bad(await s.todo_save({ title: "x", meet: "abc" }), "BAD_INPUT");
    const t = good(await s.todo_save({ title: "보통 할 일" })).task;
    expect(t.meet).toBeUndefined();
    bad(await s.todo_save({ id: t.id, base_version: 1, meet: a.id }), "BAD_INPUT");
    // 남의 모임에는 못 넣는다
    bad(await setup().s.todo_save({ title: "x", meet: a.id }), "NOT_FOUND");
  });
});

describe("등록", () => {
  it("모임 도구 2개가 MCP 로 불린다", async () => {
    const owner = randomUUID();
    const scheduleStore = new PgliteScheduleStore(db, owner);
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(
      server,
      createDrawer({ store: new PgliteStore(db, owner), agent: "test" }),
      createSchedule({ store: scheduleStore }),
      createMeet({ store: new PgliteMeetStore(db, owner), schedule: scheduleStore }),
    );
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    for (const name of MEET_TOOLS) expect(tools.map((t) => t.name)).toContain(name);
    const made = (await client.callTool({ name: "meet_save", arguments: { title: "회의", people: ["민서"], date: "2026-10-06", start: "19:00" } })) as Row;
    expect(made.isError).toBeFalsy();
    const meet = JSON.parse(made.content[1].text).meet;
    const got = (await client.callTool({ name: "meet_save", arguments: { id: meet.id, base_version: meet.version, attend: { 민서: "yes" } } })) as Row;
    expect(JSON.parse(got.content[1].text).meet.people[1]).toEqual({ name: "민서", attend: "온다" });
    const list = (await client.callTool({ name: "meet_get", arguments: {} })) as Row;
    expect(JSON.parse(list.content[1].text).items).toHaveLength(1);
    await client.close();
  });
});
