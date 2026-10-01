import { describe, expect, it } from "vitest";
import { DbError } from "../../lib/errors";
import { DEFAULT_SETTINGS, type EventRow, type Place, type TaskRow, type TaskRule } from "../../lib/schedule";
import type { TaskLink } from "../_data/types";
import {
  checkLabel,
  dueLabel,
  dueOptions,
  eventEnded,
  firstFreeStart,
  lateLabel,
  lateOf,
  mergeChecklist,
  moved,
  moveSort,
  overdue,
  parseChecks,
  parseDueAfter,
  parseMinutes,
  plannerKorean,
  ruleLabel,
  sortBetween,
  splitTasks,
  taskDraft,
  taskScopes,
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
  place_id: null,
  due_event_id: null,
  checklist: [],
  rule_id: null,
  rule_date: null,
  version: 1,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...over,
});
const link = (task_id: string, date: string, start_min: number | null, over: Partial<TaskLink> = {}): TaskLink => ({
  task_id,
  event_id: `e-${task_id}`,
  date,
  start_min,
  end_min: start_min === null ? null : start_min + 60,
  repeating: false,
  ...over,
});
const rule = (over: Partial<TaskRule> = {}): TaskRule => ({
  id: "r",
  kind: "cycle",
  title: "주간 정리",
  note: null,
  est_min: null,
  place_id: null,
  checklist: [],
  repeat: { freq: "weekly", days: [1] },
  start: "2026-09-01",
  event_id: null,
  due_after: null,
  last_made: null,
  version: 1,
  ...over,
});

describe("지남 판정", () => {
  // 2026-10-01 목 12:00
  const at = { date: "2026-10-01", min: 720 };

  it("이어진 일정: 날짜가 지났으면 지남, 오늘이면 끝 시각이 돼야", () => {
    expect(eventEnded(link("a", "2026-09-30", 1380), at)).toBe(true);
    expect(eventEnded(link("a", "2026-10-01", 600, { end_min: 719 }), at)).toBe(true);
    expect(eventEnded(link("a", "2026-10-01", 600, { end_min: 720 }), at)).toBe(true);
    expect(eventEnded(link("a", "2026-10-01", 600, { end_min: 721 }), at)).toBe(false);
    expect(eventEnded(link("a", "2026-10-02", 0), at)).toBe(false);
  });

  it("자정을 넘기는 일정은 다음 날 그 시각, 종일은 그날이 다 가야", () => {
    // 어제 23:00 ~ 오늘 13:00 (end 1440 + 780)
    expect(eventEnded(link("a", "2026-09-30", 1380, { end_min: 2220 }), at)).toBe(false);
    expect(eventEnded(link("a", "2026-09-30", 1380, { end_min: 2160 }), at)).toBe(true);
    expect(eventEnded(link("a", "2026-10-01", null), at)).toBe(false);
    expect(eventEnded(link("a", "2026-10-01", null), { date: "2026-10-01", min: 1439 })).toBe(false);
    expect(eventEnded(link("a", "2026-10-01", null), { date: "2026-10-02", min: 0 })).toBe(true);
  });

  it("반복 일정에 이어진 할 일은 지남으로 치지 않는다", () => {
    expect(eventEnded(link("a", "2026-09-01", 600, { repeating: true }), at)).toBe(false);
  });

  it("무엇이 지났나: 일정이 먼저, 그다음 마감. 오늘 마감은 아직. 끝낸 것은 아님", () => {
    const past = link("a", "2026-09-30", 600);
    expect(lateOf(task("a", { due: "2026-09-27" }), past, at)).toBe("event");
    expect(lateOf(task("a", { due: "2026-09-30" }), null, at)).toBe("due");
    expect(lateOf(task("a", { due: "2026-09-27" }), link("a", "2026-10-03", 600), at)).toBe("due");
    expect(lateOf(task("a", { due: "2026-10-01" }), null, at)).toBeNull();
    expect(lateOf(task("a"), link("a", "2026-10-03", 600), at)).toBeNull();
    expect(lateOf(task("a", { due: "2026-09-27", done_at: "2026-09-30T00:00:00Z" }), past, at)).toBeNull();
  });

  it("줄 오른쪽 글자", () => {
    const t = task("a", { due: "2026-09-27" });
    expect(lateLabel({ task: t, link: link("a", "2026-10-01", 930), why: "event" })).toBe("10/1 목 15:30 지남");
    expect(lateLabel({ task: t, link: link("a", "2026-09-30", null), why: "event" })).toBe("9/30 수 지남");
    expect(lateLabel({ task: t, link: null, why: "due" })).toBe("9/27 까지");
  });
});

describe("목록 넷으로 나누기", () => {
  const now = new Date("2026-10-01T03:00:00Z");

  it("지남 · 할 일 · 시간 정함 · 끝냄. 지남은 오래된 것부터, 끝낸 것은 지났어도 끝냄", () => {
    const tasks = [
      task("open", { sort: 2 }),
      task("due", { due: "2026-09-29" }),
      task("ended"),
      task("both", { due: "2026-09-20" }),
      task("today", { due: "2026-10-01", sort: 1 }),
      task("soon"),
      task("fin", { due: "2026-09-01", done_at: "2026-09-30T10:00:00Z" }),
    ];
    const links = [link("ended", "2026-09-30", 930), link("both", "2026-09-28", 600), link("soon", "2026-10-01", 840)];
    // 지금 2026-10-01 12:00 (Asia/Seoul)
    const l = splitTasks(tasks, links, now);
    expect(l.late.map((x) => [x.task.id, x.why])).toEqual([
      ["both", "event"],
      ["due", "due"],
      ["ended", "event"],
    ]);
    expect(l.open.map((t) => t.id)).toEqual(["today", "open"]);
    expect(l.timed.map((t) => t.task.id)).toEqual(["soon"]);
    expect(l.done.map((t) => t.id)).toEqual(["fin"]);
  });

  it("지금 시각을 넣으면 그 시각으로 판정한다. 비면 지남은 빈 목록", () => {
    const tasks = [task("a")];
    const links = [link("a", "2026-10-01", 840)]; // 14:00–15:00
    expect(splitTasks(tasks, links, now, { date: "2026-10-01", min: 899 }).late).toEqual([]);
    expect(splitTasks(tasks, links, now, { date: "2026-10-01", min: 900 }).late.map((x) => x.task.id)).toEqual(["a"]);
    expect(splitTasks(tasks, links, now, { date: "2026-10-01", min: 900 }).timed).toEqual([]);
  });

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
  it("체크 수 — 다 했으면 all, 없으면 null", () => {
    expect(checkLabel([])).toBeNull();
    expect(checkLabel([{ t: "a", done: true }, { t: "b", done: false }])).toEqual({ text: "1/2", all: false });
    expect(checkLabel([{ t: "a", done: true }, { t: "b", done: true }])).toEqual({ text: "2/2", all: true });
    expect(checkLabel([{ t: "a", done: false }])).toEqual({ text: "0/1", all: false });
  });
  it("반복 요약", () => {
    expect(ruleLabel(rule())).toBe("매주 월");
    expect(ruleLabel(rule({ repeat: { freq: "weekly", days: [3, 1] } }))).toBe("매주 월·수");
    expect(ruleLabel(rule({ repeat: { freq: "weekly", days: [1, 2, 3, 4, 5] } }))).toBe("매주 평일");
    expect(ruleLabel(rule({ repeat: { freq: "daily" } }))).toBe("매일");
    const ev = rule({ kind: "event", repeat: null, start: null, event_id: "e" });
    expect(ruleLabel(ev, "상법")).toBe("상법 끝나면");
    expect(ruleLabel(ev)).toBe("일정 끝나면");
  });
  it("버전 충돌은 할 일 문구로", () => {
    const e = new DbError("[EZ_VERSION] 그 사이 다른 곳에서 이 할 일을 고쳤습니다", "P0001");
    expect(plannerKorean(e)).toEqual({ code: "EZ_VERSION", message: "방금 다른 곳에서 이 할 일을 고쳤습니다" });
  });
});

describe("체크 항목", () => {
  it("한 줄에 하나, 빈 줄은 버리고 앞뒤 공백을 뗀다", () => {
    expect(parseChecks(" 자료 조사 \n\n슬라이드\r\n  \n")).toEqual({ texts: ["자료 조사", "슬라이드"], issue: null });
    expect(parseChecks("")).toEqual({ texts: [], issue: null });
  });
  it("20개 · 100자를 넘기면 알린다", () => {
    expect(parseChecks(Array.from({ length: 20 }, (_, i) => `항목 ${i}`).join("\n")).issue).toBeNull();
    expect(parseChecks(Array.from({ length: 21 }, (_, i) => `항목 ${i}`).join("\n")).issue).toMatch(/20개/);
    expect(parseChecks("가".repeat(100)).issue).toBeNull();
    expect(parseChecks("가".repeat(101)).issue).toMatch(/100자/);
  });
  it("글자가 같은 항목은 체크를 지킨다 (순서가 바뀌어도, 같은 글자는 앞에서부터)", () => {
    const prev = [
      { t: "a", done: true },
      { t: "b", done: false },
      { t: "a", done: false },
    ];
    expect(mergeChecklist(prev, ["b", "a", "새것", "a", "a"])).toEqual([
      { t: "b", done: false },
      { t: "a", done: true },
      { t: "새것", done: false },
      { t: "a", done: false },
      { t: "a", done: false },
    ]);
    expect(mergeChecklist(prev, ["a 고침"])).toEqual([{ t: "a 고침", done: false }]);
  });
});

describe("수정 칸", () => {
  const t = task("a", { title: "주간 정리", est_min: 40, checklist: [{ t: "편지함", done: true }], rule_id: "r", rule_date: "2026-09-28" });

  it("규칙에서 반복 칸을 읽는다", () => {
    expect(taskDraft(task("x"), null)).toMatchObject({ repeat: "none", days: [], dueAfter: "", checks: "", dueEvent: null });
    expect(taskDraft(t, rule({ due_after: 6 }))).toMatchObject({ repeat: "weekly", days: [1], dueAfter: "6", checks: "편지함" });
    expect(taskDraft(t, rule({ repeat: { freq: "daily" } })).repeat).toBe("daily");
    expect(taskDraft(t, rule({ kind: "event", repeat: null, start: null, event_id: "e" })).repeat).toBe("event");
    expect(taskDraft(task("y", { due: "2026-10-11", due_event_id: "e" }), null, { e: "결혼식" }).dueEvent).toEqual({ id: "e", title: "결혼식" });
  });

  it("반복에서 온 할 일: 모양을 바꾸면 이번만 / 앞으로도, 반복 설정을 바꾸면 앞으로도만", () => {
    const base = taskDraft(t, rule({ due_after: 6 }));
    expect(taskScopes(base, base)).toEqual([]);
    expect(taskScopes({ ...base, due: "2026-10-09" }, base)).toEqual([]);
    expect(taskScopes({ ...base, title: "주간 회고" }, base)).toEqual(["once", "future"]);
    expect(taskScopes({ ...base, checks: "편지함\n일정 확인" }, base)).toEqual(["once", "future"]);
    expect(taskScopes({ ...base, place_id: "p" }, base)).toEqual(["once", "future"]);
    expect(taskScopes({ ...base, days: [1, 4] }, base)).toEqual(["future"]);
    expect(taskScopes({ ...base, dueAfter: "3", title: "x" }, base)).toEqual(["future"]);
    expect(taskScopes({ ...base, repeat: "daily" }, base)).toEqual(["future"]);
  });

  it("반복을 끄거나 새로 켜면 범위를 묻지 않는다", () => {
    const base = taskDraft(t, rule());
    expect(taskScopes({ ...base, repeat: "none", title: "x" }, base)).toEqual([]);
    const plain = taskDraft(task("x"), null);
    expect(taskScopes({ ...plain, repeat: "weekly", days: [2], title: "y" }, plain)).toEqual([]);
  });

  it("마감까지 며칠: 빈칸은 없음, 0~60", () => {
    expect(parseDueAfter("")).toBeNull();
    expect(parseDueAfter("0")).toBe(0);
    expect(parseDueAfter(" 60 ")).toBe(60);
    expect(parseDueAfter("61")).toBeNaN();
    expect(parseDueAfter("일주일")).toBeNaN();
  });
});

describe("마감으로 고를 일정", () => {
  const ev = (id: string, date: string, over: Partial<EventRow> = {}): EventRow => ({
    id,
    title: id,
    date,
    start_min: 600,
    end_min: 660,
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
    ...over,
  });

  it("오늘부터 60일 안의 회차 (종일 포함), 지난 것과 그 뒤는 뺀다", () => {
    const rows = {
      events: [
        ev("어제", "2026-09-30", { start_min: 1380, end_min: 1500 }),
        ev("결혼식", "2026-10-11", { start_min: null, end_min: null }),
        ev("먼 일", "2026-12-01"),
        ev("수업", "2026-09-01", { repeat: { freq: "weekly", days: [1], until: "2026-10-12" } }),
      ],
      exceptions: [],
    };
    expect(dueOptions(rows, "2026-10-01").map((o) => [o.title, o.due])).toEqual([
      ["수업", "2026-10-05"],
      ["결혼식", "2026-10-11"],
      ["수업", "2026-10-12"],
    ]);
  });

  it("다른 날로 옮긴 회차는 옮긴 날로 보이고, 마감은 규칙상 회차 날짜", () => {
    const rows = {
      events: [ev("수업", "2026-09-28", { repeat: { freq: "weekly", days: [1], until: "2026-10-05" } })],
      exceptions: [{ event_id: "수업", on_date: "2026-10-05", skip: false, patch: { date: "2026-10-07" } }],
    };
    expect(dueOptions(rows, "2026-10-01")).toMatchObject([{ event_id: "수업", due: "2026-10-05", date: "2026-10-07" }]);
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
