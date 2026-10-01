import { describe, expect, it } from "vitest";
import { freeSlots, gaps } from "./free";
import { planDay } from "./plan";
import { DEFAULT_SETTINGS, type Occurrence, type Place, type Travel } from "./types";

const D = "2026-09-28";
const PLACES: Place[] = [
  { id: "home", name: "집", role: "home", symbol: "home", color: "sky", sort: 0, deleted: false },
  { id: "school", name: "학교", role: "school", symbol: "school", color: "violet", sort: 1, deleted: false },
  { id: "scube", name: "스터디큐브", role: "work", symbol: "work", color: "peach", sort: 2, deleted: false },
];
const TRAVEL: Travel[] = [
  { a: "home", b: "school", minutes: 30 },
  { a: "home", b: "scube", minutes: 20 },
];

function occ(key: string, date: string, start: number, end: number, place_id: string | null): Occurrence {
  return {
    key,
    event_id: key,
    on_date: date,
    date,
    start_min: start,
    end_min: end,
    all_day: false,
    title: key,
    place_id,
    where_text: null,
    travel_min: null,
    note: null,
    source: null,
    task_id: null,
    repeating: false,
    changed: false,
    version: 1,
  };
}

describe("gaps", () => {
  it("겹치고 붙은 구간을 합쳐 뺀다", () => {
    expect(gaps(0, 100, [{ start: 10, end: 20 }, { start: 15, end: 30 }, { start: 30, end: 40 }, { start: 90, end: 120 }])).toEqual([
      { start: 0, end: 10 },
      { start: 40, end: 90 },
    ]);
    expect(gaps(0, 100, [])).toEqual([{ start: 0, end: 100 }]);
    expect(gaps(0, 100, [{ start: -10, end: 200 }])).toEqual([]);
  });
});

describe("freeSlots", () => {
  const occs = [occ("수업", D, 630, 720, "school"), occ("근무", D, 1020, 1320, "scube")];
  const day = planDay(D, occs, PLACES, TRAVEL, DEFAULT_SETTINGS, null);

  it("일정·준비·이동을 빼고, 식사 추천은 빼지 않는다", () => {
    expect(day.segments.some((s) => s.kind === "meal")).toBe(true);
    expect(freeSlots(day, occs, 60)).toEqual([
      { start: 0, end: 565 },
      { start: 750, end: 990 },
      { start: 1340, end: 1440 },
    ]);
    expect(freeSlots(day, occs, 120)).toEqual([
      { start: 0, end: 565 },
      { start: 750, end: 990 },
    ]);
  });

  it("dayFrom~dayTo 안에서만", () => {
    expect(freeSlots(day, occs, 60, 480, 1380)).toEqual([
      { start: 480, end: 565 },
      { start: 750, end: 990 },
    ]);
  });

  it("전날 자정을 넘긴 회차의 넘어온 부분도 뺀다", () => {
    const prev = occ("밤샘", "2026-09-27", 1380, 1500, null);
    const sun = planDay(D, [], PLACES, TRAVEL, DEFAULT_SETTINGS, null);
    expect(freeSlots(sun, [prev], 30)).toEqual([{ start: 60, end: 1440 }]);
  });
});
