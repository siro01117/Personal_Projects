// 확인 모드 메모리 저장소가 화면이 의지하는 DB 규칙을 흉내 내는지 (진짜 규칙은 db/ez_schedule.test.ts).

import { describe, expect, it } from "vitest";
import { expand } from "../../lib/schedule";
import { scheduleSeed } from "./scheduleDemo";
import { MemorySchedule } from "./scheduleMemory";
import type { EventInput } from "./types";

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
