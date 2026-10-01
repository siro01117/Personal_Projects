import { describe, expect, it } from "vitest";
import { DbError } from "../../lib/errors";
import { DEFAULT_SETTINGS, type EventRow, type Place, type TaskRow } from "../../lib/schedule";
import type { TaskLink } from "../_data/types";
import {
  dueLabel,
  firstFreeStart,
  moved,
  moveSort,
  overdue,
  parseMinutes,
  plannerKorean,
  sortBetween,
  splitTasks,
  whenLabel,
} from "./planner";

const task = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id,
  title: id,
  note: null,
  due: null,
  est_min: null,
  sort: 0,
  done_at: null,
  origin_kind: null,
  origin_id: null,
  version: 1,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...over,
});
const link = (task_id: string, date: string, start_min: number | null): TaskLink => ({ task_id, event_id: `e-${task_id}`, date, start_min, repeating: false });

describe("목록 셋으로 나누기", () => {
  const now = new Date("2026-10-01T03:00:00Z");

  it("시간 없음 · 시간 정함 · 끝냄", () => {
    const tasks = [task("a", { sort: 2 }), task("b", { sort: 1 }), task("c", { sort: 3 }), task("d", { done_at: "2026-09-30T10:00:00Z" })];
    const l = splitTasks(tasks, [link("c", "2026-10-03", 840)], now);
    expect(l.open.map((t) => t.id)).toEqual(["b", "a"]);
    expect(l.timed.map((t) => t.task.id)).toEqual(["c"]);
    expect(l.done.map((t) => t.id)).toEqual(["d"]);
  });

  it("시간 정함은 날짜 · 시각 순, 종일이 그날 맨 앞", () => {
    const tasks = [task("a"), task("b"), task("c"), task("d")];
    const links = [link("a", "2026-10-03", 840), link("b", "2026-10-02", 900), link("c", "2026-10-03", null), link("d", "2026-10-03", 600)];
    expect(splitTasks(tasks, links, now).timed.map((t) => t.task.id)).toEqual(["b", "c", "d", "a"]);
  });

  it("끝냄은 최근 14일만, 최근 것부터. 일정이 있어도 끝냄으로", () => {
    const tasks = [
      task("old", { done_at: "2026-09-16T02:00:00Z" }),
      task("edge", { done_at: "2026-09-17T03:00:00Z" }),
      task("new", { done_at: "2026-09-30T00:00:00Z" }),
      task("linked", { done_at: "2026-09-29T00:00:00Z" }),
    ];
    const l = splitTasks(tasks, [link("linked", "2026-09-29", 600)], now);
    expect(l.done.map((t) => t.id)).toEqual(["new", "linked", "edge"]);
    expect(l.timed).toEqual([]);
  });

  it("지운 할 일의 연결은 무시한다", () => {
    expect(splitTasks([task("a")], [link("gone", "2026-10-02", 600)], now).open.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("순서 (사이 sort 값)", () => {
  it("사이 · 맨 앞 · 맨 뒤 · 빈 목록", () => {
    expect(sortBetween(1, 2)).toBe(1.5);
    expect(sortBetween(undefined, -3)).toBe(-4);
    expect(sortBetween(5, undefined)).toBe(6);
    expect(sortBetween(undefined, undefined)).toBe(0);
  });

  const list = [
    { id: "a", sort: 1 },
    { id: "b", sort: 2 },
    { id: "c", sort: 3 },
    { id: "d", sort: 4 },
  ];

  it("옮길 자리의 앞뒤 가운데 값", () => {
    expect(moveSort(list, "d", 1)).toBe(1.5); // a d b c
    expect(moveSort(list, "a", 3)).toBe(5); // b c d a
    expect(moveSort(list, "c", 0)).toBe(0); // c a b d
    expect(moveSort(list, "a", 2)).toBe(3.5); // b c a d
  });

  it("자리가 그대로면 null", () => {
    expect(moveSort(list, "b", 1)).toBeNull();
    expect(moveSort(list, "x", 0)).toBeNull();
  });

  it("끄는 중 순서", () => {
    expect(moved(list, "d", 1).map((x) => x.id)).toEqual(["a", "d", "b", "c"]);
    expect(moved(list, "a", 99).map((x) => x.id)).toEqual(["b", "c", "d", "a"]);
  });
});

describe("글자", () => {
  it("마감", () => {
    expect(dueLabel("2026-10-05")).toBe("10/5 까지");
    expect(dueLabel("2026-12-25")).toBe("12/25 까지");
  });
  it("마감이 지났나 — 오늘은 아직", () => {
    expect(overdue("2026-09-30", "2026-10-01")).toBe(true);
    expect(overdue("2026-10-01", "2026-10-01")).toBe(false);
    expect(overdue(null, "2026-10-01")).toBe(false);
  });
  it("이어진 일정 시각", () => {
    expect(whenLabel("2026-10-03", 840)).toBe("10/3 토 14:00");
    expect(whenLabel("2026-10-02", null)).toBe("10/2 금");
  });
  it("걸릴 시간 칸", () => {
    expect(parseMinutes("")).toBeNull();
    expect(parseMinutes(" 45 ")).toBe(45);
    expect(parseMinutes("1시간")).toBeNaN();
  });
  it("버전 충돌은 할 일 문구로", () => {
    const e = new DbError("[EZ_VERSION] 그 사이 다른 곳에서 이 할 일을 고쳤습니다", "P0001");
    expect(plannerKorean(e)).toEqual({ code: "EZ_VERSION", message: "방금 다른 곳에서 이 할 일을 고쳤습니다" });
  });
});

describe("시간 정하기 — 기본 시작 시각", () => {
  const meta = { places: [] as Place[], travel: [], settings: { ...DEFAULT_SETTINGS, meal_min: 0 } };
  const ev = (id: string, date: string, start: number, end: number): EventRow => ({
    id,
    title: id,
    date,
    start_min: start,
    end_min: end,
    place_id: null,
    where_text: null,
    travel_min: null,
    note: null,
    repeat: null,
    source: null,
    external_id: null,
    task_id: null,
    origin_kind: null,
    origin_id: null,
    version: 1,
    updated_at: "2026-09-01T00:00:00Z",
  });
  const rows = (...events: EventRow[]) => ({ events, exceptions: [] });
  const now = { date: "2026-10-01", min: 607 }; // 10:07

  it("빈 날은 9시", () => {
    expect(firstFreeStart("2026-10-02", 60, rows(), meta, now)).toBe(540);
  });

  it("오늘은 지금 이후 15분 단위", () => {
    expect(firstFreeStart("2026-10-01", 60, rows(), meta, now)).toBe(615);
  });

  it("일정을 피하고, 길이가 들어가는 첫 자리", () => {
    const r = rows(ev("a", "2026-10-02", 540, 600), ev("b", "2026-10-02", 630, 720));
    expect(firstFreeStart("2026-10-02", 30, r, meta, now)).toBe(600);
    expect(firstFreeStart("2026-10-02", 60, r, meta, now)).toBe(720);
  });

  it("일정 끝이 15분 단위가 아니면 다음 단위로", () => {
    const r = rows(ev("a", "2026-10-02", 540, 610));
    expect(firstFreeStart("2026-10-02", 60, r, meta, now)).toBe(615);
  });

  it("전날 자정을 넘긴 일정도 피한다", () => {
    const r = rows(ev("late", "2026-10-01", 1380, 1440 + 600));
    expect(firstFreeStart("2026-10-02", 60, r, meta, now)).toBe(600);
  });

  it("자리가 없으면 찾기 시작한 시각, 늦은 밤이면 23:45", () => {
    const r = rows(ev("all", "2026-10-02", 0, 1440));
    expect(firstFreeStart("2026-10-02", 60, r, meta, now)).toBe(540);
    expect(firstFreeStart("2026-10-01", 60, rows(), meta, { date: "2026-10-01", min: 1435 })).toBe(1425);
  });

  it("지점이 있으면 이동·준비 띠도 피한다", () => {
    const home: Place = { id: "h", name: "집", role: "home", symbol: "home", color: "sand", sort: 1, deleted: false };
    const school: Place = { id: "s", name: "학교", role: "school", symbol: "school", color: "sky", sort: 2, deleted: false };
    const m = { ...meta, places: [home, school], travel: [{ a: "h", b: "s", minutes: 30 }] };
    const r = rows({ ...ev("class", "2026-10-02", 660, 720), place_id: "s" });
    // 9:00 부터 준비 35 + 등교 30 = 9:55 출발 준비 → 9:00~9:55 만 비어 60분은 안 들어간다. 수업 뒤 귀가 30분 → 12:30
    expect(firstFreeStart("2026-10-02", 60, r, m, now)).toBe(750);
    expect(firstFreeStart("2026-10-02", 30, r, m, now)).toBe(540);
  });
});
