// 확인 모드 모임 저장소가 DB(0011)와 같은 모양으로 구는지: 내 줄 · 이름 겹침 · 버전 · 시간 ↔ 일정 · 묶음.
// 진짜 규칙의 시험은 db/ez_meets.test.ts. 날짜: 2026-10-05 가 월요일.

import { describe, expect, it } from "vitest";
import { CIRCLES_MAX, DEFAULT_MY_NAME, PEOPLE_MAX, PIN_LOCK_MIN, PIN_TRIES, TOKEN_RE } from "../../lib/meet";
import { MemoryMeet } from "./meetMemory";
import { MemorySchedule } from "./scheduleMemory";

const AT = { meet_date: "2026-10-05", start_min: 1140, end_min: 1260 };

function setup() {
  const S = new MemorySchedule({ places: [{ id: "p-cafe", name: "카페", role: null, symbol: "cafe", color: "peach", sort: 1, deleted: false }] });
  const M = new MemoryMeet(S);
  /** 그 모임에서 온 살아 있는 일정 */
  const events = async (meetId: string) => (await S.events("2026-09-01", "2026-12-31")).events.filter((e) => e.origin_kind === "meet" && e.origin_id === meetId);
  return { S, M, events };
}

/** 실패해야 한다. code 가 EZ_ 로 시작하면 '[EZ_…]' 메시지, 아니면 SQLSTATE */
async function fails(p: Promise<unknown>, code: string): Promise<void> {
  const e = (await p.then(
    () => null,
    (err: unknown) => err,
  )) as { code?: string; message?: string } | null;
  expect(e, `${code} 로 실패해야 합니다`).not.toBeNull();
  if (code.startsWith("EZ_")) expect(e!.message).toContain(`[${code}]`);
  else expect(e!.code).toBe(code);
}

describe("모임 만들기 · 사람", () => {
  it("내 줄이 같이 생긴다 — 이름은 설정의 내 이름, 없으면 '나'. 같이 넣은 사람은 넣은 순서", async () => {
    const { S, M } = setup();
    const a = await M.createMeet({ title: "회의" }, ["민서", "도윤"]);
    expect(a.people.map((p) => [p.name, p.is_owner])).toEqual([
      [DEFAULT_MY_NAME, true],
      ["민서", false],
      ["도윤", false],
    ]);
    await S.saveSettings({ my_name: "이지" });
    expect((await M.createMeet({ title: "둘째" })).people[0]!.name).toBe("이지");
    expect((await M.meets()).map((m) => m.title).sort()).toEqual(["둘째", "회의"]);
  });

  it("이름 겹침(대소문자 · 공백 무시) · 빈 이름 · 50명", async () => {
    const { M } = setup();
    await fails(M.createMeet({ title: "회의" }, ["민서", "민 서"]), "23505");
    await fails(M.createMeet({ title: "회의" }, [DEFAULT_MY_NAME]), "23505");
    expect(await M.meets()).toHaveLength(0);
    const m = await M.createMeet({ title: "회의" }, ["Kim"]);
    await fails(M.addPerson(m.id, { name: "kim" }), "23505");
    await fails(M.addPerson(m.id, { name: " " }), "23514");
    for (let i = 2; i < PEOPLE_MAX; i++) await M.addPerson(m.id, { name: `사람${i}` });
    await fails(M.addPerson(m.id, { name: "하나 더" }), "EZ_LIMIT");
  });

  it("참석 표시 · 이름 바꾸기 · 빼기와 같은 값으로 되돌리기. 내 줄은 못 뺀다", async () => {
    const { M } = setup();
    const m = await M.createMeet({ title: "회의" }, ["민서"]);
    const [me, p] = m.people as [(typeof m.people)[number], (typeof m.people)[number]];
    expect((await M.updatePerson(p.id, { attend: "yes" })).attend).toBe("yes");
    expect((await M.updatePerson(p.id, { name: "김민서" })).name).toBe("김민서");
    await fails(M.updatePerson(p.id, { name: DEFAULT_MY_NAME }), "23505");
    await M.removePerson(p.id);
    expect((await M.meets())[0]!.people).toHaveLength(1);
    const back = await M.addPerson(m.id, { id: p.id, name: "김민서", attend: "yes" });
    expect(back).toMatchObject({ id: p.id, attend: "yes" });
    await fails(M.removePerson(me.id), "EZ_FIXED");
  });

  it("칸 검사: 제목 · 시간(셋 같이, 자정을 넘기지 않음)", async () => {
    const { M } = setup();
    await fails(M.createMeet({ title: "" }), "23514");
    await fails(M.createMeet({ title: "x", meet_date: "2026-10-05" }), "EZ_VALUE");
    await fails(M.createMeet({ title: "x", meet_date: "2026-10-05", start_min: 1380, end_min: 1470 }), "EZ_VALUE");
  });

  it("버전이 다르면 [EZ_VERSION], 지운 모임은 [EZ_NOT_FOUND]. 되돌리면 다시 보인다", async () => {
    const { M } = setup();
    const m = await M.createMeet({ title: "회의" });
    await fails(M.updateMeet(m.id, 9, { title: "x" }), "EZ_VERSION");
    const v2 = await M.updateMeet(m.id, 1, { note: "안건" });
    expect(v2.version).toBe(2);
    expect((await M.updateMeet(m.id, 2, { note: "안건" })).version).toBe(2);
    await M.deleteMeet(m.id, 2);
    expect(await M.meets()).toHaveLength(0);
    await fails(M.updateMeet(m.id, 3, { title: "x" }), "EZ_NOT_FOUND");
    expect((await M.restoreMeet(m.id)).title).toBe("회의");
    expect(await M.meets()).toHaveLength(1);
  });
});

describe("시간 ↔ 일정", () => {
  it("시간을 적어 만들면 일정이 생기고, 바꾸면 따라가고, 비우면 지워진다", async () => {
    const { M, events } = setup();
    const m = await M.createMeet({ title: "회의", place_id: "p-cafe", place_text: "2층", ...AT });
    expect(await events(m.id)).toMatchObject([{ id: m.event_id, title: "회의", date: "2026-10-05", start_min: 1140, end_min: 1260, place_id: "p-cafe", where_text: "2층" }]);
    const moved = await M.updateMeet(m.id, m.version, { meet_date: "2026-10-08", start_min: 600, end_min: 660, title: "바꾼 제목" });
    expect(moved.event_id).toBe(m.event_id);
    expect(await events(m.id)).toMatchObject([{ id: m.event_id, title: "바꾼 제목", date: "2026-10-08", start_min: 600 }]);
    const open = await M.updateMeet(m.id, moved.version, { meet_date: null, start_min: null, end_min: null });
    expect(open).toMatchObject({ meet_date: null, event_id: null });
    expect(await events(m.id)).toHaveLength(0);
  });

  it("시간 없이 만든 모임에 나중에 시간을 적으면 일정이 생긴다", async () => {
    const { M, events } = setup();
    const m = await M.createMeet({ title: "회의" });
    expect(m.event_id).toBeNull();
    const d = await M.updateMeet(m.id, 1, AT);
    expect(d.event_id).not.toBeNull();
    expect(await events(m.id)).toHaveLength(1);
  });

  it("일정에서 시각을 바꿔도 모임은 그대로. 모임의 다른 칸을 고쳐도 일정 시각을 덮지 않는다", async () => {
    const { S, M, events } = setup();
    const m = await M.createMeet({ title: "회의", ...AT });
    const ev = (await events(m.id))[0]!;
    await S.updateEvent(ev.id, ev.version, { start_min: 1200, end_min: 1320 });
    expect((await M.meets())[0]).toMatchObject({ start_min: 1140, end_min: 1260 });
    await M.updateMeet(m.id, m.version, { note: "안건" });
    expect((await events(m.id))[0]).toMatchObject({ start_min: 1200, end_min: 1320 });
  });

  it("일정에서 지우면 event_id 만 빈다 → '일정에 넣기'(decide)로 다시 넣는다. 일정을 되돌려도 다시 붙는다", async () => {
    const { S, M, events } = setup();
    const m = await M.createMeet({ title: "회의", ...AT });
    const ev = (await events(m.id))[0]!;
    await S.deleteEvent(ev.id, ev.version);
    const gone = (await M.meets())[0]!;
    expect(gone).toMatchObject({ meet_date: "2026-10-05", event_id: null });
    // 다른 칸을 고쳐도 다시 안 생긴다
    const edited = await M.updateMeet(m.id, gone.version, { title: "고침" });
    expect(await events(m.id)).toHaveLength(0);
    const again = await M.decide(m.id, edited.version, "2026-10-05", 1140, 1260);
    expect(again.event_id).not.toBeNull();
    expect(again.event_id).not.toBe(ev.id);
    expect(await events(m.id)).toMatchObject([{ id: again.event_id, title: "고침" }]);

    const ev2 = (await events(m.id))[0]!;
    await S.deleteEvent(ev2.id, ev2.version);
    await S.restoreEvent(ev2.id);
    expect((await M.meets())[0]!.event_id).toBe(ev2.id);
  });

  it("정하기 · 다시 열기: 이미 일정이 있으면 옮기고, 다시 열면 일정이 지워진다. 버전을 본다", async () => {
    const { M, events } = setup();
    const m = await M.createMeet({ title: "회의" });
    await fails(M.decide(m.id, 9, "2026-10-07", 840, 960), "EZ_VERSION");
    await fails(M.decide(m.id, 1, "2026-10-07", 840, 840), "EZ_VALUE");
    const d = await M.decide(m.id, 1, "2026-10-07", 840, 960);
    expect(d).toMatchObject({ meet_date: "2026-10-07", version: 2 });
    const d2 = await M.decide(m.id, 2, "2026-10-12", 600, 660);
    expect(d2.event_id).toBe(d.event_id);
    expect(await events(m.id)).toMatchObject([{ date: "2026-10-12", start_min: 600 }]);
    const r = await M.reopen(m.id, d2.version);
    expect(r).toMatchObject({ meet_date: null, event_id: null });
    expect(await events(m.id)).toHaveLength(0);
  });

  it("모임을 지워도 딸린 일정은 남는다", async () => {
    const { M, events } = setup();
    const m = await M.createMeet({ title: "회의", ...AT });
    await M.deleteMeet(m.id, m.version);
    expect(await events(m.id)).toHaveLength(1);
  });
});

describe("묶음", () => {
  it("이름 겹침 · 30개 · 지운 묶음은 새로 못 건다 · 되돌리기", async () => {
    const { M } = setup();
    const c = await M.createCircle({ name: "스터디", members: ["서연"] });
    await fails(M.createCircle({ name: "스터디" }), "23505");
    await fails(M.createCircle({ name: "x", members: ["서연", "서 연"] }), "23514");
    expect((await M.updateCircle(c.id, { members: ["서연", "준우"] })).members).toEqual(["서연", "준우"]);
    const m = await M.createMeet({ title: "회의", circle_id: c.id });
    await M.deleteCircle(c.id);
    expect(await M.circles()).toHaveLength(0);
    // 모임은 남고 묶음을 그대로 가리킨다 (화면이 없는 것으로 읽는다)
    expect((await M.meets())[0]!.circle_id).toBe(c.id);
    await fails(M.createMeet({ title: "새 모임", circle_id: c.id }), "EZ_CIRCLE");
    await M.updateMeet(m.id, m.version, { title: "고침" });
    expect((await M.restoreCircle(c.id)).name).toBe("스터디");
    for (let i = 1; i < CIRCLES_MAX; i++) await M.createCircle({ name: `묶음${i}` });
    await fails(M.createCircle({ name: "하나 더" }), "EZ_LIMIT");
  });
});

// ---------------------------------------------------------------------------
// 시간 맞추기 (0012 와 같은 모양으로 구는지 — 진짜 규칙의 시험은 db/ez_meet_public.test.ts)

const POLL = { dates: ["2026-10-05", "2026-10-06", "2026-10-08"], day_from: 540, day_to: 720, duration_min: 60 };

async function opened() {
  const S = new MemorySchedule({ places: [{ id: "p-cafe", name: "카페", role: null, symbol: "cafe", color: "peach", sort: 1, deleted: false }] });
  let clock = Date.parse("2026-10-01T03:00:00Z");
  const M = new MemoryMeet(S, {}, { now: () => clock });
  const m = await M.createMeet({ title: "기획 회의", note: "비밀 메모", place_id: "p-cafe", place_text: "2층", poll: POLL }, ["도윤"]);
  const token = (await M.link(m.id, true))!;
  return { S, M, m, token, tick: (min: number) => (clock += min * 60_000) };
}

describe("맞추기 설정 · 내 칸", () => {
  it("맞추기를 켠 모임은 내 줄이 자동 채움 상태다. 나중에 켜도, 이미 칠했으면 그대로", async () => {
    const { M, m } = await opened();
    expect(m.poll).toEqual(POLL);
    expect(m.people[0]).toMatchObject({ is_owner: true, auto: true, cells: null, has_pin: false });
    const b = await M.createMeet({ title: "둘째" });
    expect(b.people[0]!.auto).toBe(false);
    const b2 = await M.updateMeet(b.id, b.version, { poll: POLL });
    expect(b2.version).toBe(b.version + 1);
    expect(b2.people[0]!.auto).toBe(true);
    // 같은 설정을 다시 보내면 버전이 그대로다
    expect((await M.updateMeet(b.id, b2.version, { poll: { ...POLL } })).version).toBe(b2.version);
    await fails(M.createMeet({ title: "셋째", poll: { ...POLL, dates: [] } }), "23514");
    await fails(M.updateMeet(b.id, b2.version, { poll: { ...POLL, duration_min: 45 } }), "23514");
  });

  it("내 칸 저장: 손으로 칠하면 auto 가 꺼지고, 일정에 맞추면 다시 켜진다. 남의 줄은 auto 가 안 된다", async () => {
    const { M, m } = await opened();
    const me = m.people[0]!;
    const a = await M.updatePerson(me.id, { cells: { "2026-10-05": [540, 570] }, auto: false });
    expect(a).toMatchObject({ cells: { "2026-10-05": [540, 570] }, auto: false });
    expect((await M.updatePerson(me.id, { cells: {}, auto: true })).auto).toBe(true);
    await fails(M.updatePerson(me.id, { cells: { "2026-10-05": [545] } }), "23514");
    await fails(M.updatePerson(me.id, { cells: { "2026-10-05": [570, 540] } }), "23514");
    await fails(M.updatePerson(m.people[1]!.id, { auto: true }), "23514");
    // 모임 버전은 사람 줄을 고쳐도 그대로다
    expect((await M.meets()).find((x) => x.id === m.id)!.version).toBe(m.version + 1);
  });
});

describe("공개 링크 · 공개 페이지", () => {
  it("켜면 22자 열쇠, 다시 켜면 그대로, 끄면 죽고 다시 켜면 새 열쇠. 지운 모임의 링크도 죽는다", async () => {
    const { M, m, token } = await opened();
    expect(token).toMatch(TOKEN_RE);
    expect(await M.link(m.id, true)).toBe(token);
    const cur = (await M.meets()).find((x) => x.id === m.id)!;
    expect(cur).toMatchObject({ token, version: m.version + 1 });
    expect(await M.link(m.id, false)).toBeNull();
    expect(await M.open(token)).toBeNull();
    const again = (await M.link(m.id, true))!;
    expect(again).not.toBe(token);
    expect((await M.open(again))!.title).toBe("기획 회의");
    const last = (await M.meets()).find((x) => x.id === m.id)!;
    await M.deleteMeet(m.id, last.version);
    expect(await M.open(again)).toBeNull();
    await fails(M.enter(again, "민서", "1234"), "EZ_NOT_FOUND");
    for (const t of ["", "abc", "a".repeat(22)]) expect(await M.open(t)).toBeNull();
  });

  it("공개 모양에는 id · 메모 · 열쇠 · 핀이 없다", async () => {
    const { M, m, token } = await opened();
    await M.enter(token, "민서", "4821");
    const r = (await M.open(token))!;
    expect(Object.keys(r).sort()).toEqual(["end_min", "meet_date", "people", "place", "poll", "start_min", "title", "where"]);
    expect(r).toMatchObject({ title: "기획 회의", place: "카페", where: "2층", meet_date: null, poll: POLL });
    expect(r.people).toEqual([
      { name: DEFAULT_MY_NAME, is_owner: true, cells: null, attend: null, has_pin: false },
      { name: "도윤", is_owner: false, cells: null, attend: null, has_pin: false },
      { name: "민서", is_owner: false, cells: null, attend: null, has_pin: true },
    ]);
    const text = JSON.stringify(r);
    for (const secret of [m.id, token, "4821", "비밀 메모", ...m.people.map((p) => p.id)]) expect(text).not.toContain(secret);
  });

  it("들어오기: 새 이름 · 미리 넣어 둔 이름은 핀을 정하고, 다시 오면 확인한다. 주최자 이름으로는 못 들어온다", async () => {
    const { M, token } = await opened();
    expect((await M.enter(token, " 민서 ", "4821")).me).toBe("민서");
    expect((await M.enter(token, "민 서", "4821")).me).toBe("민서");
    await fails(M.enter(token, "민서", "0000"), "EZ_PIN");
    expect((await M.enter(token, "도윤", "123456")).meet.people[1]).toMatchObject({ name: "도윤", has_pin: true });
    await fails(M.enter(token, "도윤", "4821"), "EZ_PIN");
    await fails(M.enter(token, DEFAULT_MY_NAME, "4821"), "EZ_OWNER");
    await fails(M.enter(token, "", "4821"), "EZ_VALUE");
    await fails(M.enter(token, "하린", "12a4"), "EZ_VALUE");
    await fails(M.enter(token, "하린", "123"), "EZ_VALUE");
    expect((await M.open(token))!.people).toHaveLength(3);
  });

  it(`${PIN_TRIES}번 틀리면 ${PIN_LOCK_MIN}분 잠긴다. 주최자가 핀을 지우면 새 핀으로 들어온다 (칠한 것은 그대로)`, async () => {
    const { M, m, token, tick } = await opened();
    await M.enter(token, "민서", "4821");
    await M.answer(token, "민서", "4821", { "2026-10-05": [600] });
    for (let i = 1; i < PIN_TRIES; i++) await fails(M.enter(token, "민서", "0000"), "EZ_PIN");
    await fails(M.enter(token, "민서", "0000"), "EZ_LOCKED");
    await fails(M.enter(token, "민서", "4821"), "EZ_LOCKED");
    await fails(M.answer(token, "민서", "4821", {}), "EZ_LOCKED");
    tick(PIN_LOCK_MIN - 1);
    await fails(M.enter(token, "민서", "4821"), "EZ_LOCKED");
    tick(2);
    await fails(M.enter(token, "민서", "0000"), "EZ_PIN");
    expect((await M.enter(token, "민서", "4821")).me).toBe("민서");

    for (let i = 0; i < PIN_TRIES; i++) await M.enter(token, "민서", "0000").catch(() => {});
    const row = (await M.meets()).find((x) => x.id === m.id)!.people.find((p) => p.name === "민서")!;
    expect(row).toMatchObject({ has_pin: true, cells: { "2026-10-05": [600] } });
    await M.clearPin(row.id);
    const cleared = (await M.open(token))!.people.find((p) => p.name === "민서")!;
    expect(cleared).toMatchObject({ has_pin: false, cells: { "2026-10-05": [600] } });
    await fails(M.answer(token, "민서", "4821", {}), "EZ_PIN");
    expect((await M.enter(token, "민서", "777777")).me).toBe("민서");
    await fails(M.enter(token, "민서", "4821"), "EZ_PIN");
    await fails(M.clearPin("없는-id"), "EZ_NOT_FOUND");
  });

  it("칠하기: 검사 · 통째로 갈아끼움 · 설정 밖으로 나간 칸은 남는다 · 정해진 뒤에는 거절", async () => {
    const { M, m, token } = await opened();
    await M.enter(token, "민서", "4821");
    const mine = (r: { meet: { people: { name: string; cells: unknown }[] } }) => r.meet.people.find((p) => p.name === "민서")!.cells;
    expect(mine(await M.answer(token, "민서", "4821", { "2026-10-08": [600, 540, 600], "2026-10-05": [690], "2026-10-06": [] }))).toEqual({ "2026-10-05": [690], "2026-10-08": [540, 600] });
    for (const bad of [{ "2026-10-07": [540] }, { "2026-10-05": [550] }, { "2026-10-05": [720] }, { "2026-10-05": 540 }]) {
      await fails(M.answer(token, "민서", "4821", bad as never), "EZ_VALUE");
    }
    await fails(M.answer(token, "없는 사람", "4821", {}), "EZ_PIN");
    await fails(M.answer(token, "도윤", "4821", {}), "EZ_PIN");
    await fails(M.answer(token, DEFAULT_MY_NAME, "4821", {}), "EZ_OWNER");

    // 후보 날짜를 줄여도 밖으로 나간 칸은 남는다
    let cur = (await M.meets()).find((x) => x.id === m.id)!;
    cur = await M.updateMeet(m.id, cur.version, { poll: { ...POLL, dates: ["2026-10-05", "2026-10-06"] } });
    await fails(M.answer(token, "민서", "4821", { "2026-10-08": [540] }), "EZ_VALUE");
    expect(mine(await M.answer(token, "민서", "4821", { "2026-10-06": [600] }))).toEqual({ "2026-10-06": [600], "2026-10-08": [540, 600] });

    await fails(M.rsvp(token, "민서", "4821", "yes"), "EZ_OPEN");
    cur = await M.decide(m.id, cur.version, "2026-10-06", 600, 660);
    await fails(M.answer(token, "민서", "4821", {}), "EZ_CLOSED");
    const r = await M.rsvp(token, "민서", "4821", "yes");
    expect(r.meet).toMatchObject({ meet_date: "2026-10-06", start_min: 600, end_min: 660 });
    expect(r.meet.people.find((p) => p.name === "민서")!.attend).toBe("yes");
    await fails(M.rsvp(token, "민서", "4821", "maybe" as never), "EZ_VALUE");
    expect((await M.rsvp(token, "민서", "4821", null)).meet.people.find((p) => p.name === "민서")!.attend).toBeNull();

    // 다시 열면 칠한 것이 남아 있고 다시 칠해진다
    await M.reopen(m.id, cur.version);
    expect(mine(await M.answer(token, "민서", "4821", {}))).toEqual({ "2026-10-08": [540, 600] });
  });
});
