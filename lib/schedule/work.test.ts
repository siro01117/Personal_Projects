// 시간 기록 계산 — 날짜 나누기(Asia/Seoul) · 할 일별 합 · 한 주 · 24시간에서 자르기 · 흐르는 시계 (docs/플래너.md 7-16)

import { describe, expect, it } from "vitest";
import { clockText, liveWork, secToMin, seoulDay, seoulMidnight, spanEnd, spanRunning, splitByDay, workList, workSums, workWeek } from "./work";

const ms = (iso: string) => Date.parse(iso);

describe("날짜 (Asia/Seoul)", () => {
  it("그 순간의 한국 날짜 · 그 날짜 0시", () => {
    expect(seoulDay(ms("2026-10-04T14:59:59Z"))).toBe("2026-10-04");
    expect(seoulDay(ms("2026-10-04T15:00:00Z"))).toBe("2026-10-05");
    expect(seoulMidnight("2026-10-05")).toBe(ms("2026-10-04T15:00:00Z"));
  });
  it("자정을 넘는 구간은 날짜별로 나눈다", () => {
    expect(splitByDay(ms("2026-10-06T14:30:00Z"), ms("2026-10-06T15:30:00Z"))).toEqual([
      { day: "2026-10-06", seconds: 1800 },
      { day: "2026-10-07", seconds: 1800 },
    ]);
    expect(splitByDay(ms("2026-10-05T00:00:00Z"), ms("2026-10-05T00:45:00Z"))).toEqual([{ day: "2026-10-05", seconds: 2700 }]);
    expect(splitByDay(5, 5)).toEqual([]);
  });
});

describe("구간의 끝", () => {
  const start = "2026-10-05T00:00:00Z";
  it("닫혔으면 그 시각, 열려 있으면 지금", () => {
    expect(spanEnd(start, "2026-10-05T01:00:00Z", ms("2026-10-09T00:00:00Z"))).toBe(ms("2026-10-05T01:00:00Z"));
    expect(spanEnd(start, null, ms("2026-10-05T00:20:00Z"))).toBe(ms("2026-10-05T00:20:00Z"));
  });
  it("24시간 넘게 열린 것은 24시간으로 자르고, 돌지 않는 것으로 친다", () => {
    expect(spanEnd(start, null, ms("2026-10-07T00:00:00Z"))).toBe(ms("2026-10-06T00:00:00Z"));
    expect(spanRunning(start, null, ms("2026-10-05T23:59:00Z"))).toBe(true);
    expect(spanRunning(start, null, ms("2026-10-06T00:00:00Z"))).toBe(false);
    expect(spanRunning(start, "2026-10-05T01:00:00Z", ms("2026-10-05T00:30:00Z"))).toBe(false);
  });
});

describe("할 일별 합 · 한 주 · 기간", () => {
  const now = new Date("2026-10-07T03:00:00Z"); // 한국 10/7 12:00
  const spans = [
    { id: "1", task_id: "a", started_at: "2026-10-05T00:00:00Z", ended_at: "2026-10-05T00:45:00Z" },
    { id: "2", task_id: "a", started_at: "2026-10-06T14:30:00Z", ended_at: "2026-10-06T15:30:00Z" }, // 자정을 넘는다
    { id: "3", task_id: "b", started_at: "2026-10-07T02:40:00Z", ended_at: null }, // 돌고 있다 (20분째)
    { id: "4", task_id: "c", started_at: "2026-10-04T14:50:00Z", ended_at: "2026-10-04T15:10:00Z" }, // 앞 주 일요일 → 월요일
  ];

  it("오늘 · 누적 · 지금 돌고 있나", () => {
    const sums = workSums(spans, now);
    expect(sums.get("a")).toMatchObject({ today_sec: 1800, total_sec: 6300, running: false, started_at: null });
    expect(sums.get("b")).toMatchObject({ today_sec: 1200, total_sec: 1200, running: true, started_at: "2026-10-07T02:40:00Z" });
    expect(sums.get("c")).toMatchObject({ today_sec: 0, total_sec: 1200, running: false });
    expect(sums.has("없음")).toBe(false);
  });

  it("그 주(월요일부터 7일)의 할 일 × 날짜 초 — 주 밖은 자른다", () => {
    expect(workWeek(spans, "2026-10-05", now)).toEqual([
      { task_id: "a", day: "2026-10-05", seconds: 2700 },
      { task_id: "c", day: "2026-10-05", seconds: 600 },
      { task_id: "a", day: "2026-10-06", seconds: 1800 },
      { task_id: "a", day: "2026-10-07", seconds: 1800 },
      { task_id: "b", day: "2026-10-07", seconds: 1200 },
    ]);
    expect(workWeek(spans, "2026-09-28", now)).toEqual([{ task_id: "c", day: "2026-10-04", seconds: 600 }]);
    expect(workWeek(spans, "2026-10-12", now)).toEqual([]);
  });

  it("기간에 걸친 원 구간 — 열린 것은 지금까지", () => {
    const list = workList(spans, "2026-10-06", "2026-10-07", now);
    expect(list.map((s) => s.id)).toEqual(["2", "3"]);
    expect(list[1]).toEqual({ id: "3", task_id: "b", started_at: "2026-10-07T02:40:00Z", ended_at: "2026-10-07T03:00:00.000Z", running: true });
  });
});

describe("지금의 합 · 글자", () => {
  it("읽은 때 뒤로 흐른 만큼을 돌고 있는 것에 더한다", () => {
    const w = { today_sec: 600, total_sec: 4200, running: true, started_at: "2026-10-07T02:50:00Z", at: "2026-10-07T03:00:00Z" };
    expect(liveWork(w, ms("2026-10-07T03:00:30Z"))).toEqual({ today: 630, total: 4230, clock: 630 });
    expect(liveWork({ ...w, running: false, started_at: null }, ms("2026-10-07T04:00:00Z"))).toEqual({ today: 600, total: 4200, clock: null });
    expect(liveWork(undefined, 0)).toEqual({ today: 0, total: 0, clock: null });
    // 24시간이 넘으면 거기서 멈춘다
    expect(liveWork(w, ms("2026-10-09T00:00:00Z")).clock).toBe(86400);
  });
  it("초 → 분: 1분이 안 돼도 기록이 있으면 1", () => {
    expect([0, 20, 60, 89, 91, 2700].map(secToMin)).toEqual([0, 1, 1, 1, 2, 45]);
  });
  it('시계 "12:34" · 한 시간이 넘으면 "1:02:03"', () => {
    expect(clockText(0)).toBe("00:00");
    expect(clockText(754)).toBe("12:34");
    expect(clockText(3723)).toBe("1:02:03");
  });
});
