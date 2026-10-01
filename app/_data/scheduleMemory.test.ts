// 확인 모드 메모리 저장소가 화면이 의지하는 DB 규칙을 흉내 내는지 (진짜 규칙은 db/ez_schedule.test.ts).

import { describe, expect, it } from "vitest";
import { expand } from "../../lib/schedule";
import { scheduleSeed } from "./scheduleDemo";
import { MemorySchedule } from "./scheduleMemory";
import type { EventInput, RuleInput } from "./types";

const input = (over: Partial<EventInput> = {}): EventInput => ({
  title: "회의",
  date: "2026-10-01",
  start_min: 600,
  end_min: 660,
  place_id: null,
  where_text: null,
  travel_min: null,
  note: null,
  repeat: null,
  task_id: null,
  ...over,
});

describe("MemorySchedule", () => {
  it("버전이 다르면 [EZ_VERSION], 고치면 +1", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(input());
    const u = await m.updateEvent(e.id, 1, { title: "회의 2" });
    expect(u.version).toBe(2);
    await expect(m.updateEvent(e.id, 1, { title: "x" })).rejects.toThrow(/EZ_VERSION/);
  });

  it("바깥 일정은 고치기·지우기·회차 모두 [EZ_EXTERNAL]", async () => {
    const m = new MemorySchedule(scheduleSeed(new Date("2026-10-01T05:00:00Z")));
    const { events } = await m.events("2026-09-28", "2026-10-04");
    const ext = events.find((e) => e.source === "univ")!;
    await expect(m.updateEvent(ext.id, ext.version, { title: "x" })).rejects.toThrow(/EZ_EXTERNAL/);
    await expect(m.deleteEvent(ext.id, ext.version)).rejects.toThrow(/EZ_EXTERNAL/);
    await expect(m.setException(ext.id, "2026-09-28", null)).rejects.toThrow(/EZ_EXTERNAL/);
  });

  it("집은 하나, 이름은 겹치면 안 된다", async () => {
    const m = new MemorySchedule();
    await m.createPlace({ name: "집", role: "home" });
    await expect(m.createPlace({ name: "본가", role: "home" })).rejects.toThrow(/ez_places_home_unique/);
    await expect(m.createPlace({ name: "집", role: null })).rejects.toThrow(/ez_places_name_unique/);
  });

  it("할 일 하나에 살아 있는 일정은 하나", async () => {
    const m = new MemorySchedule();
    const t = await m.createTask({ title: "보고서" });
    await m.createEvent(input({ task_id: t.id }));
    await expect(m.createEvent(input({ task_id: t.id }))).rejects.toThrow(/ez_events_task_unique/);
    expect((await m.links()).map((l) => l.task_id)).toEqual([t.id]);
  });

  it("이후 모두: 나누고 그날 이후 예외를 새 일정으로 옮긴다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(input({ date: "2026-09-22", repeat: { freq: "weekly", days: [2] } }));
    await m.setException(e.id, "2026-10-06", { title: "특별" });
    const n = await m.split(e.id, 1, "2026-09-29", { start_min: 700, end_min: 760 });
    const { events, exceptions } = await m.events("2026-09-21", "2026-10-11");
    const occ = expand(events, exceptions, "2026-09-21", "2026-10-11").map((o) => [o.date, o.start_min, o.title]);
    expect(occ).toEqual([
      ["2026-09-22", 600, "회의"],
      ["2026-09-29", 700, "회의"],
      ["2026-10-06", 700, "특별"],
    ]);
    expect(exceptions.map((x) => x.event_id)).toEqual([n.id]);
  });

  it("이후 모두 지우기: 첫 회차면 일정을 지운다, 아니면 전날까지", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(input({ date: "2026-09-22", repeat: { freq: "weekly", days: [2] } }));
    const cut = await m.cut(e.id, 1, "2026-10-06");
    expect(cut.repeat).toEqual({ freq: "weekly", days: [2], until: "2026-10-05" });
    await m.cut(e.id, cut.version, "2026-09-22");
    expect((await m.events("2026-09-21", "2026-10-11")).events).toEqual([]);
  });

  it("지점은 12개까지", async () => {
    const m = new MemorySchedule();
    for (let i = 0; i < 12; i++) await m.createPlace({ name: `곳${i}`, role: null });
    await expect(m.createPlace({ name: "열셋", role: null })).rejects.toThrow(/EZ_LIMIT/);
  });
});

// ---------------------------------------------------------------------------
// 플래너 v2 (docs/플래너.md 7장, 진짜 규칙은 db/ez_planner.test.ts)
// ---------------------------------------------------------------------------

const cycle = (over: Partial<RuleInput> = {}): RuleInput => ({
  kind: "cycle",
  title: "주간 정리",
  note: null,
  est_min: 40,
  place_id: null,
  checklist: ["편지함", "일정 확인"],
  repeat: { freq: "weekly", days: [1] }, // 매주 월
  start: "2026-09-07",
  event_id: null,
  due_after: 6,
  last_made: null,
  ...over,
});
const after = (event_id: string, over: Partial<RuleInput> = {}): RuleInput => ({
  kind: "event",
  title: "내용 정리",
  note: null,
  est_min: null,
  place_id: null,
  checklist: [],
  repeat: null,
  start: null,
  event_id,
  due_after: null,
  last_made: null,
  ...over,
});
/** 매주 월·수 10:00–11:00 수업 (2026-09-07 월부터) */
const lesson = (over: Partial<EventInput> = {}) => input({ title: "수업", date: "2026-09-07", repeat: { freq: "weekly", days: [1, 3] }, ...over });
const live = async (m: MemorySchedule) => (await m.tasks()).map((t) => [t.title, t.rule_date, t.due]);

describe("MemorySchedule — 반복 규칙 굴리기 (roll)", () => {
  it("회차가 되면 하나 만든다: 맨 위, 체크 항목은 안 한 채로, 마감은 회차 + 며칠. 같은 날 두 번 불러도 하나", async () => {
    const m = new MemorySchedule();
    const old = await m.createTask({ title: "있던 것" });
    const r = await m.createRule(cycle());
    expect(await m.roll("2026-09-06", 600)).toBe(0); // 시작 전
    expect(await m.roll("2026-09-07", 0)).toBe(1);
    expect(await m.roll("2026-09-07", 900)).toBe(0);
    const [t, rest] = await m.tasks();
    expect(t).toMatchObject({ title: "주간 정리", est_min: 40, rule_id: r.id, rule_date: "2026-09-07", due: "2026-09-13" });
    expect(t!.checklist).toEqual([
      { t: "편지함", done: false },
      { t: "일정 확인", done: false },
    ]);
    expect(rest!.id).toBe(old.id);
    expect((await m.rules())[0]!.last_made).toBe("2026-09-07");
  });

  it("3주 밀려도 가장 최근 회차 하나만. 안 끝낸 지난 회차는 지우고 끝낸 것은 남긴다", async () => {
    const m = new MemorySchedule();
    await m.createRule(cycle());
    await m.roll("2026-09-07", 600);
    const first = (await m.tasks())[0]!;
    await m.setDone(first.id, first.version, true);
    await m.roll("2026-09-14", 600);
    expect(await m.roll("2026-10-01", 600)).toBe(1); // 9/21 · 9/28 중 9/28 만
    expect((await live(m)).sort()).toEqual([
      ["주간 정리", "2026-09-07", "2026-09-13"],
      ["주간 정리", "2026-09-28", "2026-10-04"],
    ]);
  });

  it("같은 회차는 한 번만 — 지운 회차도 다시 만들지 않는다", async () => {
    const m = new MemorySchedule();
    await m.createRule(cycle({ repeat: { freq: "daily" }, due_after: null, checklist: [] }));
    await m.roll("2026-09-07", 600);
    const t = (await m.tasks())[0]!;
    expect(t).toMatchObject({ due: null, checklist: [] });
    await m.deleteTask(t.id, t.version);
    expect(await m.roll("2026-09-07", 900)).toBe(0);
    expect(await m.tasks()).toEqual([]);
    expect(await m.roll("2026-09-08", 0)).toBe(1);
  });

  it("있던 할 일을 첫 회차로 삼으면(last_made = 오늘) 다음 회차부터 만든다", async () => {
    const m = new MemorySchedule();
    const t = await m.createTask({ title: "주간 정리" });
    const r = await m.createRule(cycle({ start: "2026-10-01", last_made: "2026-10-01" })); // 목요일에 켬
    await m.updateTask(t.id, t.version, { rule_id: r.id, rule_date: "2026-10-01" });
    expect(await m.roll("2026-10-01", 900)).toBe(0);
    expect(await m.roll("2026-10-04", 900)).toBe(0);
    expect(await m.roll("2026-10-05", 0)).toBe(1); // 다음 월요일. 안 끝낸 첫 회차는 지워진다
    expect(await live(m)).toEqual([["주간 정리", "2026-10-05", "2026-10-11"]]);
  });

  it("60일 넘게 안 열었어도 최근 60일 안의 가장 늦은 회차 하나만", async () => {
    const m = new MemorySchedule();
    await m.createRule(cycle({ start: "2026-01-05" }));
    expect(await m.roll("2026-10-01", 600)).toBe(1);
    expect((await m.tasks())[0]!.rule_date).toBe("2026-09-28");
  });

  it("멈춘 규칙은 안 만든다. 이미 생긴 할 일은 남는다", async () => {
    const m = new MemorySchedule();
    const r = await m.createRule(cycle());
    await m.roll("2026-09-07", 600);
    await m.stopRule(r.id);
    expect(await m.rules()).toEqual([]);
    expect(await m.roll("2026-09-14", 600)).toBe(0);
    expect((await m.tasks()).length).toBe(1);
  });

  it("일정에 딸린 규칙: 끝 시각 전에는 안 만들고 지나면 만든다. 아직 안 끝난 오늘 회차 대신 그 전 회차", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(lesson());
    await m.createRule(after(e.id, { due_after: 2 }));
    expect(await m.roll("2026-09-07", 659)).toBe(0); // 10:59
    expect(await m.roll("2026-09-07", 660)).toBe(1); // 11:00
    expect(await live(m)).toEqual([["내용 정리", "2026-09-07", "2026-09-09"]]);
    // 수요일 수업 중: 새로 안 만든다
    expect(await m.roll("2026-09-09", 630)).toBe(0);
    expect(await m.roll("2026-09-09", 700)).toBe(1);
    expect(await live(m)).toEqual([["내용 정리", "2026-09-09", "2026-09-11"]]);
  });

  it("건너뛴(skip) 회차는 안 만들고, 이번만 시각을 바꾼 회차는 바꾼 끝 시각으로 본다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(lesson());
    await m.createRule(after(e.id, { last_made: "2026-09-07" }));
    await m.setException(e.id, "2026-09-09", null);
    expect(await m.roll("2026-09-10", 600)).toBe(0);
    await m.setException(e.id, "2026-09-14", { start_min: 900, end_min: 960 }); // 15:00–16:00 로 옮김
    expect(await m.roll("2026-09-14", 700)).toBe(0);
    expect(await m.roll("2026-09-14", 960)).toBe(1);
  });

  it("종일 회차는 다음 날부터, 자정을 넘기는 회차는 다음 날 끝 시각이 지나야", async () => {
    const m = new MemorySchedule();
    const all = await m.createEvent(lesson({ start_min: null, end_min: null }));
    await m.createRule(after(all.id, { title: "종일 뒤" }));
    expect(await m.roll("2026-09-07", 1439)).toBe(0);
    expect(await m.roll("2026-09-08", 0)).toBe(1);

    const m2 = new MemorySchedule();
    const night = await m2.createEvent(lesson({ start_min: 1380, end_min: 1500 })); // 23:00–다음 날 01:00
    await m2.createRule(after(night.id));
    expect(await m2.roll("2026-09-08", 59)).toBe(0);
    expect(await m2.roll("2026-09-08", 60)).toBe(1);
  });

  it("일정을 지우거나 반복이 아니게 되면 딸린 규칙이 멈춘다. 반복이 끝난(until) 뒤에도 안 만든다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(lesson());
    await m.createRule(after(e.id));
    await m.deleteEvent(e.id, e.version);
    expect(await m.rules()).toEqual([]);
    expect(await m.roll("2026-09-10", 600)).toBe(0);

    const e2 = await m.createEvent(lesson());
    await m.createRule(after(e2.id));
    await m.updateEvent(e2.id, e2.version, { repeat: null });
    expect(await m.rules()).toEqual([]);

    const e3 = await m.createEvent(lesson({ repeat: { freq: "weekly", days: [1, 3], until: "2026-09-08" } }));
    await m.createRule(after(e3.id, { last_made: "2026-09-07" }));
    expect(await m.roll("2026-09-20", 600)).toBe(0);
  });

  it("규칙 칸 검사: 반복 아닌 일정 · 지운 일정에는 못 걸고, cycle 은 until 을 못 쓴다", async () => {
    const m = new MemorySchedule();
    const once = await m.createEvent(input());
    await expect(m.createRule(after(once.id))).rejects.toThrow(/EZ_REPEAT/);
    const e = await m.createEvent(lesson());
    await m.deleteEvent(e.id, e.version);
    await expect(m.createRule(after(e.id))).rejects.toThrow(/EZ_NOT_FOUND/);
    await expect(m.createRule(cycle({ repeat: { freq: "daily", until: "2026-12-01" } }))).rejects.toThrow(/EZ_VALUE/);
    await expect(m.createRule(cycle({ due_after: 61 }))).rejects.toThrow(/ez_task_rules_due_after_check/);
    await expect(m.createRule(cycle({ repeat: { freq: "weekly", days: [] } }))).rejects.toThrow(/EZ_VALUE/);
  });

  it("'이후 모두' 로 나누면 딸린 규칙이 새 일정으로 옮겨 간다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(lesson());
    const r = await m.createRule(after(e.id, { last_made: "2026-09-09" }));
    const n = await m.split(e.id, e.version, "2026-09-14", { start_min: 840, end_min: 900 });
    expect(n.id).not.toBe(e.id);
    expect((await m.rules()).map((x) => [x.id, x.event_id])).toEqual([[r.id, n.id]]);
    expect(await m.roll("2026-09-14", 899)).toBe(0);
    expect(await m.roll("2026-09-14", 900)).toBe(1);
  });
});

describe("MemorySchedule — 일정에 딸린 마감", () => {
  it("반복 아닌 일정: 걸면 마감이 일정 날짜가 되고, 일정 날짜가 바뀌면 따라간다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(input({ title: "결혼식", date: "2026-10-11" }));
    const t = await m.createTask({ title: "봉투", due: "2026-10-01", due_event_id: e.id });
    expect(t.due).toBe("2026-10-11");
    await m.updateEvent(e.id, e.version, { date: "2026-10-18" });
    const moved = (await m.tasks())[0]!;
    expect(moved).toMatchObject({ due: "2026-10-18", due_event_id: e.id });
    expect(moved.version).toBe(t.version + 1);
    expect(await m.eventTitles([e.id, "none"])).toEqual({ [e.id]: "결혼식" });
  });

  it("건 채로 날짜만 바꾸면 거절, 연결을 비우면서 바꾸면 된다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(input({ date: "2026-10-11" }));
    const t = await m.createTask({ title: "봉투", due_event_id: e.id });
    await expect(m.updateTask(t.id, t.version, { due: "2026-10-09" })).rejects.toThrow(/EZ_VALUE/);
    await expect(m.updateTask(t.id, t.version, { due: null })).rejects.toThrow(/EZ_VALUE/);
    const u = await m.updateTask(t.id, t.version, { due: "2026-10-09", due_event_id: null });
    expect(u).toMatchObject({ due: "2026-10-09", due_event_id: null });
    // 딸린 마감과 상관없는 칸은 건 채로 고칠 수 있다
    const again = await m.updateTask(u.id, u.version, { due_event_id: e.id });
    expect((await m.updateTask(again.id, again.version, { title: "축의금" })).due).toBe("2026-10-11");
  });

  it("반복 일정: 회차 날짜를 같이 써야 하고 그 일정의 회차여야 한다. 일정 날짜가 바뀌어도 안 따라간다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(lesson());
    await expect(m.createTask({ title: "과제", due_event_id: e.id })).rejects.toThrow(/EZ_VALUE/);
    await expect(m.createTask({ title: "과제", due: "2026-09-08", due_event_id: e.id })).rejects.toThrow(/EZ_DATE/);
    const t = await m.createTask({ title: "과제", due: "2026-09-14", due_event_id: e.id });
    const u = await m.updateTask(t.id, t.version, { due: "2026-09-16" });
    expect(u.due).toBe("2026-09-16");
  });

  it("일정을 지우면 연결만 끊기고 날짜는 남는다. 지운 일정에는 못 건다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(input({ date: "2026-10-11" }));
    const t = await m.createTask({ title: "봉투", due_event_id: e.id });
    await m.deleteEvent(e.id, e.version);
    expect((await m.tasks())[0]).toMatchObject({ due: "2026-10-11", due_event_id: null });
    await expect(m.updateTask(t.id, t.version + 1, { due_event_id: e.id })).rejects.toThrow(/EZ_EVENT/);
  });

  it("지우기를 되돌리면 끊긴 마감 연결과 멈춘 규칙이 되살아난다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(lesson());
    const t = await m.createTask({ title: "과제", due: "2026-09-14", due_event_id: e.id });
    const other = await m.createTask({ title: "남", due: "2026-09-16", due_event_id: e.id });
    const r = await m.createRule(after(e.id, { last_made: "2026-09-07" }));
    const deps = await m.dependents(e.id);
    expect(deps).toEqual({ tasks: [t.id, other.id], rules: [r.id] });
    await m.deleteEvent(e.id, e.version);
    expect(await m.rules()).toEqual([]);
    expect((await m.tasks()).map((x) => x.due_event_id)).toEqual([null, null]);
    // 그 사이 지운 할 일은 건너뛴다
    const gone = (await m.tasks()).find((x) => x.id === other.id)!;
    await m.deleteTask(gone.id, gone.version);

    await m.restoreEvent(e.id, deps);
    expect((await m.tasks()).map((x) => [x.id, x.due, x.due_event_id])).toEqual([[t.id, "2026-09-14", e.id]]);
    expect((await m.rules()).map((x) => [x.id, x.last_made])).toEqual([[r.id, "2026-09-07"]]);
    expect(await m.roll("2026-09-09", 700)).toBe(1);
  });

  it("deps 없이 되돌리면 일정만 돌아온다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(input({ date: "2026-10-11" }));
    await m.createTask({ title: "봉투", due_event_id: e.id });
    await m.deleteEvent(e.id, e.version);
    await m.restoreEvent(e.id);
    expect((await m.tasks())[0]).toMatchObject({ due: "2026-10-11", due_event_id: null });
  });

  it("'이후 모두 지우기' 로 일정이 통째로 지워져도(첫 회차) 되돌리면 되살아난다", async () => {
    const m = new MemorySchedule();
    const e = await m.createEvent(lesson());
    const r = await m.createRule(after(e.id));
    const deps = await m.dependents(e.id);
    await m.cut(e.id, e.version, "2026-09-07");
    expect(await m.rules()).toEqual([]);
    await m.restoreEvent(e.id, deps);
    expect((await m.rules()).map((x) => x.id)).toEqual([r.id]);
  });
});

describe("MemorySchedule — 할 일의 새 칸", () => {
  it("지점 · 체크 항목을 읽고 쓴다. 체크 항목은 20개 · 1~100자", async () => {
    const m = new MemorySchedule();
    const p = await m.createPlace({ name: "학교", role: "school" });
    const t = await m.createTask({ title: "과제", place_id: p.id, checklist: [{ t: "1번", done: false }] });
    expect(t).toMatchObject({ place_id: p.id, checklist: [{ t: "1번", done: false }], rule_id: null, rule_date: null, due_event_id: null });
    const u = await m.updateTask(t.id, t.version, { checklist: [{ t: "1번", done: true }], place_id: null });
    expect(u).toMatchObject({ place_id: null, checklist: [{ t: "1번", done: true }] });
    const many = Array.from({ length: 21 }, (_, i) => ({ t: `항목 ${i}`, done: false }));
    await expect(m.updateTask(u.id, u.version, { checklist: many })).rejects.toThrow(/ez_tasks_checklist_check/);
    await expect(m.updateTask(u.id, u.version, { checklist: [{ t: " 공백 ", done: false }] })).rejects.toThrow(/ez_tasks_checklist_check/);
    await expect(m.updateTask(u.id, u.version, { place_id: "없는 지점" })).rejects.toThrow(/ez_tasks_place_fk/);
  });

  it("이어진 일정의 끝 시각이 같이 온다 (지남 판정)", async () => {
    const m = new MemorySchedule();
    const t = await m.createTask({ title: "보고서" });
    await m.createEvent(input({ task_id: t.id, start_min: 600, end_min: 690 }));
    expect(await m.links()).toMatchObject([{ task_id: t.id, date: "2026-10-01", start_min: 600, end_min: 690, repeating: false }]);
  });

  it("확인 모드 데이터: 열면 수업에 딸린 규칙이 가장 최근에 끝난 수업의 할 일을 만든다", async () => {
    // 2026-10-01 목 14:00 (Asia/Seoul). 자료구조는 월·수 10:30–12:00
    const m = new MemorySchedule(scheduleSeed(new Date("2026-10-01T05:00:00Z")));
    expect(await m.roll("2026-10-01", 840)).toBe(1);
    const made = (await m.tasks())[0]!;
    expect(made).toMatchObject({ title: "자료구조 내용 정리", rule_date: "2026-09-30", due: "2026-10-06" });
    expect((await m.tasks()).filter((t) => t.title === "주간 정리").map((t) => t.rule_date)).toEqual(["2026-09-28"]);
    expect(await m.roll("2026-10-01", 900)).toBe(0);
  });
});
