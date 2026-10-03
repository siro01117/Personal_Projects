import { describe, expect, it } from "vitest";
import { DbError } from "../../lib/errors";
import { DEFAULT_SETTINGS, type EventRow, type Place, type Role, type TaskRow, type TaskRule } from "../../lib/schedule";
import type { TaskLink } from "../_data/types";
import {
  checkLabel,
  draftWithPlace,
  draftWithRole,
  dueLabel,
  dueOptions,
  eventEnded,
  firstFreeStart,
  lateLabel,
  lateOf,
  moved,
  moveSort,
  overdue,
  parseDueAfter,
  parseMinutes,
  parseSort,
  plannerKorean,
  roleText,
  ruleLabel,
  sortBetween,
  sortGroups,
  splitTasks,
  taskDraft,
  whenLabel,
  estOf,
  benchCandidates,
  benchLine,
  benchList,
  benchSides,
  currentStepText,
  detachTaskStep,
  firstLine,
  filterByRole,
  focusMeta,
  logDayLabel,
  NO_ROLE,
  parseRoleOff,
  progressOf,
  roleFilterOn,
  roleKey,
  ruleDraft,
  ruleDraftFromTask,
  ruleDraftPatch,
  ruleNext,
  runningTask,
  sortRules,
  splitLinks,
  todayLabel,
  toggleRoleOff,
  weekTable,
  type Sort,
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
  role_id: null,
  bench_order: null,
  bench_at: null,
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
  role_id: null,
  bench: false,
  paused: false,
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
    // 아랫단까지 센다
    expect(checkLabel([{ t: "a", done: true, sub: [{ t: "b", done: false }, { t: "c", done: true }] }])).toEqual({ text: "2/3", all: false });
  });
  it("반복 요약", () => {
    expect(ruleLabel(rule())).toBe("매주 월");
    expect(ruleLabel(rule({ repeat: { freq: "weekly", days: [3, 1] } }))).toBe("매주 월·수");
    expect(ruleLabel(rule({ repeat: { freq: "weekly", days: [1, 2, 3, 4, 5] } }))).toBe("매주 평일");
    expect(ruleLabel(rule({ repeat: { freq: "daily" } }))).toBe("매일");
    const ev = rule({ kind: "event", repeat: null, start: null, event_id: "e" });
    expect(ruleLabel(ev, "상법")).toBe("상법 끝날 때마다");
    expect(ruleLabel(ev)).toBe("일정이 끝날 때마다");
  });
  it("버전 충돌은 할 일 문구로", () => {
    const e = new DbError("[EZ_VERSION] 그 사이 다른 곳에서 이 할 일을 고쳤습니다", "P0001");
    expect(plannerKorean(e)).toEqual({ code: "EZ_VERSION", message: "방금 다른 곳에서 이 할 일을 고쳤습니다" });
  });
});

describe("수정 칸", () => {
  const t = task("a", { title: "주간 정리", est_min: 40, checklist: [{ t: "편지함", done: true }], rule_id: "r", rule_date: "2026-09-28" });

  it("할 일 → 칸: 반복 설정은 없다(반복 카드에서). 체크 항목은 한 줄에 하나, 아랫단은 들여서", () => {
    expect(taskDraft(task("x"))).toEqual({ title: "x", due: "", dueEvent: null, est: "", note: "", place_id: null, checks: "", role_id: null, roleManual: false });
    expect(taskDraft(t)).toMatchObject({ title: "주간 정리", est: "40", checks: "편지함" });
    const nested = task("n", { checklist: [{ t: "정리", done: false, sub: [{ t: "1장", done: true, est: 10 }] }, { t: "문제", done: false }] });
    expect(taskDraft(nested).checks).toBe("정리\n  1장\n문제");
    expect(taskDraft(task("y", { due: "2026-10-11", due_event_id: "e" }), { e: "결혼식" }).dueEvent).toEqual({ id: "e", title: "결혼식" });
  });

  it("규칙 → 칸: 주기 · 요일 · 마감까지 며칠 · 단계 틀 · 작업대에 올리기", () => {
    expect(ruleDraft(rule({ due_after: 6, est_min: 40, checklist: ["편지함", { t: "일정", sub: ["이번 주", { t: "다음 주", est: 5 }] }], bench: true }))).toMatchObject({
      title: "주간 정리",
      est: "40",
      kind: "weekly",
      days: [1],
      dueAfter: "6",
      checks: "편지함\n일정\n  이번 주\n  다음 주",
      bench: true,
    });
    expect(ruleDraft(rule({ repeat: { freq: "daily" } }))).toMatchObject({ kind: "daily", days: [], dueAfter: "" });
    expect(ruleDraft(rule({ kind: "event", repeat: null, start: null, event_id: "e" })).kind).toBe("event");
  });

  it("반복으로 만들기: 할 일의 모양을 옮기고 처음에는 매주 · 오늘 요일", () => {
    const d = ruleDraftFromTask(t, "2026-10-07"); // 수
    expect(d).toMatchObject({ title: "주간 정리", est: "40", checks: "편지함", kind: "weekly", days: [3], dueAfter: "", bench: false });
  });

  it("규칙 칸 → 저장할 칸: 단계 틀은 글자로 걸릴 시간을 이어받는다", () => {
    const prev = ["편지함", { t: "일정", sub: [{ t: "이번 주", est: 5 }] }];
    const base = ruleDraft(rule({ checklist: prev, due_after: 6 }));
    const r = ruleDraftPatch({ ...base, title: " 주간 회고 ", checks: "편지함\n일정\n  이번 주\n  다음 주", days: [5, 1], bench: true }, prev);
    expect(r).toEqual({
      patch: { title: "주간 회고", note: null, est_min: null, place_id: null, role_id: null, checklist: ["편지함", { t: "일정", sub: [{ t: "이번 주", est: 5 }, "다음 주"] }], due_after: 6, bench: true },
      repeat: { freq: "weekly", days: [1, 5] },
    });
    expect(ruleDraftPatch({ ...base, kind: "daily" }, prev)).toMatchObject({ repeat: { freq: "daily" } });
    expect(ruleDraftPatch({ ...base, kind: "event" }, prev)).toMatchObject({ repeat: null });
  });

  it("규칙 칸의 틀린 값", () => {
    const base = ruleDraft(rule());
    expect(ruleDraftPatch({ ...base, title: "  " }, [])).toEqual({ issue: "제목을 써 주세요" });
    expect(ruleDraftPatch({ ...base, days: [] }, [])).toEqual({ issue: "요일을 하나 이상 고르세요" });
    expect(ruleDraftPatch({ ...base, dueAfter: "61" }, [])).toEqual({ issue: "마감까지는 0~60일입니다" });
    expect(ruleDraftPatch({ ...base, est: "3" }, [])).toMatchObject({ issue: expect.stringContaining("5~600") });
    expect(ruleDraftPatch({ ...base, checks: "가".repeat(101) }, [])).toMatchObject({ issue: expect.stringContaining("100자") });
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

describe("역할 (7-11)", () => {
  const roles: Role[] = [
    { id: "univ", name: "대학", from_place: "school", sort: 1, version: 1 },
    { id: "teach", name: "강사", from_place: "work", sort: 2, version: 1 },
    { id: "me", name: "개인", from_place: "home", sort: 3, version: 1 },
    { id: "club", name: "동아리", from_place: null, sort: 4, version: 1 },
  ];
  it("줄에 보일 글자: 역할 이름. 역할이 없거나 지운 역할이면 없음", () => {
    expect(roleText(task("과제", { role_id: "univ" }), roles)).toBe("대학");
    expect(roleText(task("회고", { role_id: "club" }), roles)).toBe("동아리");
    expect(roleText(task("메일"), roles)).toBeNull();
    expect(roleText(task("x", { role_id: "지운 역할" }), roles)).toBeNull();
  });

  it("수정 칸: 지점을 고르면 그 지점의 역할이 들어가고, 역할 칩을 직접 누른 뒤에는 덮지 않는다", () => {
    const school = { id: "p-school", role: "school" as const };
    const work = { id: "p-work", role: "work" as const };
    const cafe = { id: "p-cafe", role: null };
    let d = taskDraft(task("x"));
    expect(d).toMatchObject({ role_id: null, roleManual: false });
    d = draftWithPlace(d, school, roles);
    expect(d).toMatchObject({ place_id: "p-school", role_id: "univ", roleManual: false });
    d = draftWithPlace(d, work, roles);
    expect(d.role_id).toBe("teach");
    // 역할이 딸리지 않은 지점 · 지점 없음은 역할을 그대로 둔다
    expect(draftWithPlace(d, cafe, roles)).toMatchObject({ place_id: "p-cafe", role_id: "teach" });
    expect(draftWithPlace(d, null, roles)).toMatchObject({ place_id: null, role_id: "teach" });
    d = draftWithRole(d, "club");
    expect(draftWithPlace(d, school, roles)).toMatchObject({ place_id: "p-school", role_id: "club", roleManual: true });
    expect(draftWithPlace(draftWithRole(d, null), school, roles).role_id).toBeNull();
  });

  it("수정 칸을 열 때: 역할이 지점이 주는 것과 다르면 손으로 고른 것으로 본다", () => {
    expect(taskDraft(task("x", { role_id: "univ" }), {}, "univ").roleManual).toBe(false);
    expect(taskDraft(task("x", { role_id: "club" }), {}, "univ").roleManual).toBe(true);
    expect(taskDraft(task("x", { role_id: "club" })).roleManual).toBe(true);
    expect(taskDraft(task("x"), {}, "univ").roleManual).toBe(false);
    // 규칙 칸도 같다 (지점 · 역할 고르기를 같이 쓴다)
    expect(ruleDraft(rule({ role_id: "club" }), "univ").roleManual).toBe(true);
    expect(draftWithRole(ruleDraft(rule()), "univ")).toMatchObject({ role_id: "univ", roleManual: true, kind: "weekly" });
  });

  it("역할 오류 문구", () => {
    expect(plannerKorean(new DbError('duplicate key value violates unique constraint "ez_roles_name_unique"', "23505")).message).toBe("같은 이름의 역할이 이미 있습니다");
    expect(plannerKorean(new DbError('new row for relation "ez_roles" violates check constraint "ez_roles_name_check"', "23514")).message).toBe(
      "역할 이름은 앞뒤 공백 없이 1~20자입니다",
    );
    expect(plannerKorean(new DbError("[EZ_LIMIT] 역할은 12개까지 둘 수 있습니다", "P0001"))).toEqual({ code: "EZ_LIMIT", message: "역할은 12개까지 둘 수 있습니다" });
  });
});

describe("정렬 (7-12)", () => {
  // 목록은 일부러 sort 순서가 아니게 준다
  const roles = [
    { id: "me", name: "개인", sort: 3 },
    { id: "univ", name: "대학", sort: 1 },
    { id: "teach", name: "강사", sort: 2 },
  ];
  const places = [
    { id: "p-work", name: "학원", sort: 2, deleted: false },
    { id: "p-school", name: "학교", sort: 1, deleted: false },
    { id: "p-old", name: "옛 자취방", sort: 0, deleted: true },
  ];
  const by = { roles, places };
  // 직접 순서 그대로 (a → f)
  const rows = [
    { task: task("a", { role_id: "me", place_id: "p-work", due: "2026-10-05" }) },
    { task: task("b", { role_id: "univ", place_id: "p-school" }) },
    { task: task("c", { due: "2026-10-03" }) },
    { task: task("d", { role_id: "univ", place_id: "p-old", due: "2026-10-03" }), link: link("d", "2026-10-04", 600) },
    { task: task("e", { role_id: "지운 역할", place_id: "p-work" }) },
    { task: task("f", { role_id: "me", place_id: "p-school", due: "2026-10-09" }), link: link("f", "2026-10-03", null) },
  ];
  type Row = { task: TaskRow; link?: TaskLink | null };
  const shape = (sort: Sort, list: readonly Row[] = rows) => sortGroups(list, sort, by).map((g) => [g.kind, g.label, g.items.map((r) => r.task.id).join("")]);
  const ids = (sort: Sort, list: readonly Row[] = rows) =>
    sortGroups(list, sort, by)
      .flatMap((g) => g.items.map((r) => r.task.id))
      .join(" ");

  it("직접: 묶음 하나, 받은 순서 그대로. 방향은 보지 않는다", () => {
    expect(shape({ key: "manual", dir: "asc" })).toEqual([["all", "", "abcdef"]]);
    expect(shape({ key: "manual", dir: "desc" })).toEqual([["all", "", "abcdef"]]);
    expect(sortGroups(rows, { key: "manual", dir: "asc" }, by)[0]!.key).toBe("all");
  });

  it("역할: 역할 목록(sort) 순서대로 묶고 묶음 안은 직접 순서. 없는 것과 지운 역할은 없음으로 맨 뒤", () => {
    expect(shape({ key: "role", dir: "asc" })).toEqual([
      ["role", "대학", "bd"],
      ["role", "개인", "af"],
      ["none", "없음", "ce"],
    ]);
    expect(sortGroups(rows, { key: "role", dir: "asc" }, by).map((g) => g.key)).toEqual(["univ", "me", "none"]);
  });

  it("역할 내림: 역할 순서만 뒤집는다. 없음은 그래도 맨 뒤, 묶음 안은 직접 순서", () => {
    expect(shape({ key: "role", dir: "desc" })).toEqual([
      ["role", "개인", "af"],
      ["role", "대학", "bd"],
      ["none", "없음", "ce"],
    ]);
  });

  it("장소: 지점 순서대로 묶는다. 지점 없는 것과 지운 지점은 없음으로 맨 뒤. 내림이면 지점 순서만 뒤집는다", () => {
    expect(shape({ key: "place", dir: "asc" })).toEqual([
      ["place", "학교", "bf"],
      ["place", "학원", "ae"],
      ["none", "없음", "cd"],
    ]);
    expect(shape({ key: "place", dir: "desc" })).toEqual([
      ["place", "학원", "ae"],
      ["place", "학교", "bf"],
      ["none", "없음", "cd"],
    ]);
    expect(sortGroups(rows, { key: "place", dir: "asc" }, by).map((g) => g.key)).toEqual(["p-school", "p-work", "none"]);
  });

  it("묶음이 하나뿐이어도 라벨이 있는 묶음 하나. 다 없음이면 없음 하나. 줄이 없으면 빈 배열", () => {
    expect(shape({ key: "role", dir: "asc" }, [rows[1]!, rows[3]!])).toEqual([["role", "대학", "bd"]]);
    expect(shape({ key: "role", dir: "desc" }, [rows[2]!])).toEqual([["none", "없음", "c"]]);
    expect(shape({ key: "place", dir: "asc" }, [rows[2]!, rows[3]!])).toEqual([["none", "없음", "cd"]]);
    for (const key of ["manual", "role", "place", "time"] as const) expect(sortGroups([], { key, dir: "asc" }, by)).toEqual([]);
  });

  it("소요시간: 묶음 하나(구분 없음). 오름은 짧은 것부터, 안 적은 것은 맨 뒤에 직접 순서로", () => {
    const list = [
      { task: task("긴", { est_min: 120 }) },
      { task: task("없음1") },
      { task: task("짧은", { est_min: 15 }) },
      { task: task("중간", { est_min: 60 }) },
      { task: task("없음2") },
    ];
    expect(estOf(list[0]!)).toBe(120);
    expect(estOf(list[1]!)).toBeNull();
    expect(shape({ key: "time", dir: "asc" }, list)).toEqual([["all", "", "짧은중간긴없음1없음2"]]);
    expect(shape({ key: "time", dir: "desc" }, list)).toEqual([["all", "", "긴중간짧은없음1없음2"]]);
  });

  it("소요시간: 같은 값이면 오름이든 내림이든 직접 순서", () => {
    const same = [{ task: task("x", { est_min: 30 }) }, { task: task("y", { est_min: 10 }) }, { task: task("z", { est_min: 30 }) }];
    expect(ids({ key: "time", dir: "asc" }, same)).toBe("y x z");
    expect(ids({ key: "time", dir: "desc" }, same)).toBe("x z y");
  });

  it("소요시간: 이어진 일정이나 마감은 보지 않는다", () => {
    const list = [
      { task: task("일찍", { est_min: 90, due: "2026-10-01" }), link: link("일찍", "2026-10-01", 600) },
      { task: task("늦게", { est_min: 20, due: "2026-10-30" }) },
    ];
    expect(ids({ key: "time", dir: "asc" }, list)).toBe("늦게 일찍");
  });

  it("목록 넷에 그대로 쓴다: 지남 · 시간 정함 줄은 이어진 일정을 가진 채 묶인다", () => {
    const now = new Date("2026-10-01T03:00:00Z");
    const tasks = [
      task("서류", { role_id: "univ", due: "2026-09-29", sort: 1 }),
      task("회의", { role_id: "me", sort: 2 }),
      task("발표", { role_id: "univ", sort: 3 }),
      task("상담", { sort: 4 }),
    ];
    const links = [link("회의", "2026-09-30", 600), link("발표", "2026-10-03", 600), link("상담", "2026-10-02", 600)];
    const l = splitTasks(tasks, links, now, { date: "2026-10-01", min: 720 });
    expect(ids({ key: "manual", dir: "asc" }, l.late)).toBe("서류 회의");
    expect(shape({ key: "role", dir: "asc" }, l.timed)).toEqual([
      ["role", "대학", "발표"],
      ["none", "없음", "상담"],
    ]);
  });

  it("기억해 둔 정렬: {key, dir} 만 읽는다. 값이 이상하면 직접 · 오름", () => {
    expect(parseSort('{"key":"role","dir":"desc"}')).toEqual({ key: "role", dir: "desc" });
    expect(parseSort('{"key":"time","dir":"asc","x":1}')).toEqual({ key: "time", dir: "asc" });
    for (const bad of [null, undefined, "", "role", "{", "null", "[]", '{"key":"name","dir":"asc"}', '{"key":"role","dir":"up"}', '{"key":"role"}']) {
      expect(parseSort(bad)).toEqual({ key: "manual", dir: "asc" });
    }
  });
});

describe("역할 필터 (7-14)", () => {
  const roles = [{ id: "r1" }, { id: "r2" }];
  const rows = [task("a", { role_id: "r1" }), task("b", { role_id: "r2" }), task("c"), task("d", { role_id: "지운 역할" })].map((t) => ({ task: t }));
  const ids = (xs: { task: TaskRow }[]) => xs.map((x) => x.task.id);

  it("역할이 없거나 지운 역할이면 '역할 없음' 열쇠", () => {
    expect(rows.map((r) => roleKey(r.task, roles))).toEqual(["r1", "r2", NO_ROLE, NO_ROLE]);
  });
  it("기본은 전부 켬, 끈 역할 · 역할 없음의 줄만 빠진다", () => {
    expect(ids(filterByRole(rows, [], roles))).toEqual(["a", "b", "c", "d"]);
    expect(ids(filterByRole(rows, ["r1"], roles))).toEqual(["b", "c", "d"]);
    expect(ids(filterByRole(rows, [NO_ROLE, "r2"], roles))).toEqual(["a"]);
  });
  it("켜고 끄기 · 하나라도 꺼졌나(지운 역할의 열쇠는 안 친다)", () => {
    const off = toggleRoleOff([], "r1", false);
    expect(off).toEqual(["r1"]);
    expect(toggleRoleOff(off, "r1", false)).toEqual(["r1"]);
    expect(toggleRoleOff(off, "r1", true)).toEqual([]);
    expect(roleFilterOn([], roles)).toBe(false);
    expect(roleFilterOn(["r1"], roles)).toBe(true);
    expect(roleFilterOn([NO_ROLE], roles)).toBe(true);
    expect(roleFilterOn(["지운 역할"], roles)).toBe(false);
  });
  it("기억해 둔 글자 읽기: 못 읽으면 전부 켬", () => {
    expect(parseRoleOff('["r1","none","r1",3,""]')).toEqual(["r1", "none"]);
    for (const bad of [null, undefined, "", "{", '{"r1":true}', "null"]) expect(parseRoleOff(bad)).toEqual([]);
  });
});

describe("작업대 여럿 (7-15)", () => {
  const now = new Date("2026-10-04T03:00:00Z");
  const at = { date: "2026-10-04", min: 720 };

  it("올라간 것만, 올린 순서 (끝낸 것은 뺀다)", () => {
    const list = benchList([
      task("a"),
      task("b", { bench_order: 3 }),
      task("c", { bench_order: 1, bench_at: "2026-10-04T01:00:00Z" }),
      task("d", { bench_order: 2, done_at: "2026-10-04T02:00:00Z" }),
    ]);
    expect(list.map((t) => t.id)).toEqual(["c", "b"]);
  });

  it("가져오기 후보: 안 올라간 열린 할 일, 지남 · 할 일 · 시간 정함 순, 끈 역할은 뺀다", () => {
    const tasks = [
      task("open2", { sort: 2 }),
      task("open1", { sort: 1, role_id: "r1" }),
      task("timed", { sort: 0 }),
      task("late", { due: "2026-10-01" }),
      task("on", { bench_order: 1 }),
      task("done", { done_at: "2026-10-03T00:00:00Z" }),
      task("hidden", { sort: 3, role_id: "r2" }),
    ];
    const links = [link("timed", "2026-10-05", 600)];
    const roles = [{ id: "r1" }, { id: "r2" }];
    expect(benchCandidates(tasks, links, now, at, [], roles).map((t) => t.id)).toEqual(["late", "open1", "open2", "hidden", "timed"]);
    expect(benchCandidates(tasks, links, now, at, ["r2"], roles).map((t) => t.id)).toEqual(["late", "open1", "open2", "timed"]);
    expect(benchCandidates(tasks, links, now, at, [NO_ROLE], roles).map((t) => t.id)).toEqual(["open1", "hidden"]);
  });

  it("순서: 끌어서 옮긴 자리 · 앞뒤", () => {
    const list = [task("a"), task("b"), task("c")];
    expect(moved(list, "c", 0).map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(benchSides(list, "b")).toEqual({ prev: "a", next: "c" });
    expect(benchSides(list, "a")).toEqual({ prev: null, next: "b" });
    expect(benchSides(list, "c")).toEqual({ prev: "b", next: null });
    expect(benchSides(list, "x")).toEqual({ prev: null, next: null });
  });

  it("메모 첫 줄", () => {
    expect(firstLine(null)).toBeNull();
    expect(firstLine("  \n\n")).toBeNull();
    expect(firstLine("\n  계획부터 \n둘째 줄")).toBe("계획부터");
  });
});

describe("작업대 — 지금 단계 · 진행 · 시간 기록 글자 (7-16)", () => {
  const steps = [
    { t: "읽기", done: true, est: 20 },
    { t: "정리", done: false, sub: [{ t: "1장", done: true }, { t: "2장", done: false, est: 15 }] },
    { t: "문제", done: false, est: 30 },
  ];
  const NOW = Date.parse("2026-10-07T03:00:00Z");
  const work = (over: Partial<NonNullable<TaskRow["work"]>> = {}) => ({ today_sec: 2400, total_sec: 4800, running: false, started_at: null, at: "2026-10-07T03:00:00Z", ...over });

  it("지금 단계 글자: 깊이 상관없이 첫 번째 안 끝난 줄", () => {
    expect(currentStepText(steps)).toBe("2장");
    expect(currentStepText([{ t: "a", done: true }])).toBeNull();
    expect(currentStepText([])).toBeNull();
  });

  it("카드의 한 줄: 지금 단계, 단계가 하나도 없으면 메모 첫 줄", () => {
    expect(benchLine({ checklist: steps, note: "메모" })).toBe("2장");
    expect(benchLine({ checklist: [], note: "\n계획부터\n둘째" })).toBe("계획부터");
    expect(benchLine({ checklist: [{ t: "a", done: true }], note: "메모" })).toBeNull(); // 다 끝냈으면 비운다
    expect(benchLine({ checklist: [], note: null })).toBeNull();
  });

  it("진행 막대: 끝낸 줄 / 전체 줄. 단계가 없으면 막대가 없다", () => {
    expect(progressOf(steps)).toBe(2 / 5);
    expect(progressOf([{ t: "a", done: true }])).toBe(1);
    expect(progressOf([])).toBeNull();
  });

  it('카드의 "오늘 40분" — 오늘 잰 것이 있을 때만. 돌고 있으면 읽은 뒤로 흐른 만큼 더한다', () => {
    expect(todayLabel({ work: work() }, NOW)).toBe("오늘 40분");
    expect(todayLabel({ work: work({ today_sec: 0 }) }, NOW)).toBeNull();
    expect(todayLabel({}, NOW)).toBeNull();
    expect(todayLabel({ work: work({ running: true, started_at: "2026-10-07T02:50:00Z" }) }, NOW + 20 * 60_000)).toBe("오늘 1시간");
  });

  it("집중 화면 머리 줄: 걸릴 시간 · 단계 합 · 오늘 · 누적 — 있는 것만", () => {
    expect(focusMeta({ est_min: 60, checklist: steps, work: work() }, NOW).map((b) => b.text)).toEqual(["걸릴 시간 1시간", "단계 합 1시간 5분", "오늘 40분", "누적 1시간 20분"]);
    expect(focusMeta({ est_min: null, checklist: [], work: undefined }, NOW)).toEqual([]);
    expect(focusMeta({ est_min: 30, checklist: [{ t: "a", done: false }], work: undefined }, NOW)).toEqual([{ key: "est", text: "걸릴 시간 30분" }]);
    // 누적이 오늘과 같으면 한 번만
    expect(focusMeta({ est_min: null, checklist: [], work: work({ total_sec: 2400 }) }, NOW).map((b) => b.key)).toEqual(["today"]);
  });

  it("단계 합이 걸릴 시간을 넘으면 걸릴 시간 토막에만 표시", () => {
    const over = focusMeta({ est_min: 60, checklist: steps, work: undefined }, NOW);
    expect(over).toEqual([
      { key: "est", text: "걸릴 시간 1시간", over: true },
      { key: "steps", text: "단계 합 1시간 5분" },
    ]);
    expect(focusMeta({ est_min: 90, checklist: steps, work: undefined }, NOW)[0]).toEqual({ key: "est", text: "걸릴 시간 1시간 30분" });
  });

  it("지금 시간이 가고 있는 할 일은 하나", () => {
    const tasks = [task("a", { work: work() }), task("b", { work: work({ running: true, started_at: "2026-10-07T02:50:00Z" }) })];
    expect(runningTask(tasks)?.id).toBe("b");
    expect(runningTask([tasks[0]!])).toBeNull();
  });

  it("떼어내기: 그 줄이 제목, 역할 · 지점 · 마감은 물려받는다. 윗단이면 아랫단이 새 할 일의 단계", () => {
    const t = task("상법", { checklist: steps, role_id: "r1", place_id: "p1", due: "2026-10-10", due_event_id: "e1", note: "메모", est_min: 90 });
    const sub = detachTaskStep(t, 3)!;
    expect(sub.input).toEqual({ title: "2장", role_id: "r1", place_id: "p1", due: "2026-10-10", due_event_id: "e1", checklist: [] });
    expect(sub.rest).toEqual([steps[0], { t: "정리", done: false, sub: [{ t: "1장", done: true }] }, steps[2]]);
    const top = detachTaskStep(t, 1)!;
    expect(top.input).toMatchObject({ title: "정리", checklist: [{ t: "1장", done: true }, { t: "2장", done: false, est: 15 }] });
    expect(top.rest).toEqual([steps[0], steps[2]]);
    expect(detachTaskStep(t, 9)).toBeNull();
  });

  it("메모 안 주소: http · https 만, 끝의 문장 부호는 뺀다", () => {
    expect(splitLinks("강의 https://example.com/os/ch7 보고, http://a.kr/x?y=1.")).toEqual([
      { text: "강의 " },
      { text: "https://example.com/os/ch7", url: "https://example.com/os/ch7" },
      { text: " 보고, " },
      { text: "http://a.kr/x?y=1", url: "http://a.kr/x?y=1" },
      { text: "." },
    ]);
    expect(splitLinks("주소 없음\n둘째 줄")).toEqual([{ text: "주소 없음\n둘째 줄" }]);
    expect(splitLinks("javascript:alert(1) ftp://x.y")).toEqual([{ text: "javascript:alert(1) ftp://x.y" }]);
    expect(splitLinks("")).toEqual([]);
  });
});

describe("반복 카드 — 다음 회차 · 줄 순서 (7-16)", () => {
  it("주기 규칙: 오늘 이후의 첫 날. 이미 만든 회차는 건너뛴다", () => {
    // 매주 월, 2026-10-05 가 월요일
    expect(ruleNext(rule(), "2026-10-07")).toBe("2026-10-12");
    expect(ruleNext(rule(), "2026-10-05")).toBe("2026-10-05");
    expect(ruleNext(rule({ last_made: "2026-10-05" }), "2026-10-05")).toBe("2026-10-12");
    expect(ruleNext(rule({ repeat: { freq: "daily" }, last_made: "2026-10-07" }), "2026-10-07")).toBe("2026-10-08");
    // 아직 시작 전
    expect(ruleNext(rule({ start: "2026-11-02" }), "2026-10-07")).toBe("2026-11-02");
  });

  it("일정에 딸린 규칙: 그 일정의 다음 회차 (이미 만든 회차 뒤)", () => {
    const ev = rule({ kind: "event", repeat: null, start: null, event_id: "e1", last_made: "2026-10-05" });
    const occ = [
      { event_id: "e1", on_date: "2026-10-05", date: "2026-10-05" },
      { event_id: "e2", on_date: "2026-10-06", date: "2026-10-06" },
      { event_id: "e1", on_date: "2026-10-07", date: "2026-10-07" },
      { event_id: "e1", on_date: "2026-10-12", date: "2026-10-12" },
    ];
    expect(ruleNext(ev, "2026-10-05", occ)).toBe("2026-10-07");
    expect(ruleNext({ ...ev, last_made: null }, "2026-10-05", occ)).toBe("2026-10-05");
    expect(ruleNext(ev, "2026-10-05")).toBeNull(); // 회차를 아직 못 읽었다
  });

  it("멈춘 규칙은 다음 회차가 없고 줄의 맨 뒤로 간다", () => {
    expect(ruleNext(rule({ paused: true }), "2026-10-07")).toBeNull();
    const rows = [
      { rule: rule({ id: "멈춤", paused: true, title: "가" }), next: null },
      { rule: rule({ id: "늦음", title: "나" }), next: "2026-10-12" },
      { rule: rule({ id: "모름", title: "다" }), next: null },
      { rule: rule({ id: "이름", title: "라" }), next: "2026-10-08" },
    ];
    expect(sortRules(rows).map((r) => r.rule.id)).toEqual(["이름", "늦음", "모름", "멈춤"]);
  });
});

describe("기록 표 — 한 주 (7-16)", () => {
  const tasks = [
    task("a", { title: "상법 정리", role_id: "univ", place_id: "school" }),
    task("b", { title: "수업 준비", role_id: "teach" }),
    task("c", { title: "빨래" }),
    task("d", { title: "과제", role_id: "univ" }),
  ];
  const by = {
    roles: [
      { id: "teach", name: "강사", sort: 2 },
      { id: "univ", name: "대학", sort: 1 },
    ],
    places: [{ id: "school", name: "학교" }],
  };
  const week = [
    { task_id: "a", day: "2026-10-05", seconds: 2700 },
    { task_id: "a", day: "2026-10-06", seconds: 1800 },
    { task_id: "a", day: "2026-10-07", seconds: 1800 },
    { task_id: "b", day: "2026-10-05", seconds: 1200 },
    { task_id: "c", day: "2026-10-11", seconds: 20 },
    { task_id: "d", day: "2026-10-05", seconds: 600 },
    { task_id: "지운 것", day: "2026-10-05", seconds: 999 },
    { task_id: "a", day: "2026-10-12", seconds: 999 }, // 주 밖
  ];

  it("행 = 할 일(역할 · 지점), 열 = 월~일, 칸 = 분. 주 합계가 큰 순, 맨 아래 합계 줄", () => {
    const t = weekTable(week, "2026-10-05", tasks, by);
    expect(t.days).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(t.rows).toEqual([
      { kind: "task", id: "a", title: "상법 정리", role: "대학", place: "학교", cells: [45, 30, 30, 0, 0, 0, 0], total: 105 },
      { kind: "task", id: "b", title: "수업 준비", role: "강사", place: null, cells: [20, 0, 0, 0, 0, 0, 0], total: 20 },
      { kind: "task", id: "d", title: "과제", role: "대학", place: null, cells: [10, 0, 0, 0, 0, 0, 0], total: 10 },
      { kind: "task", id: "c", title: "빨래", role: null, place: null, cells: [0, 0, 0, 0, 0, 0, 1], total: 1 }, // 1분이 안 돼도 1
    ]);
    expect(t.sum).toEqual({ cells: [75, 30, 30, 0, 0, 0, 1], total: 136 });
  });

  it("정렬이 역할이면 역할 순서로 묶고 묶음 끝에 소계 줄. 역할 없는 것은 맨 뒤", () => {
    const t = weekTable(week, "2026-10-05", tasks, by, true);
    expect(t.rows.map((r) => (r.kind === "task" ? r.title : `= ${r.label} ${r.total}`))).toEqual(["상법 정리", "과제", "= 대학 115", "수업 준비", "= 강사 20", "빨래", "= 없음 1"]);
    expect(t.rows[2]).toEqual({ kind: "role", id: "role:univ", label: "대학", cells: [55, 30, 30, 0, 0, 0, 0], total: 115 });
    expect(t.sum.total).toBe(136);
  });

  it("비면 줄이 없다", () => {
    expect(weekTable([], "2026-10-05", tasks, by)).toMatchObject({ rows: [], sum: { total: 0 } });
    expect(weekTable(week, "2026-10-19", tasks, by, true).rows).toEqual([]);
  });

  it('표 머리 "월 5"', () => {
    expect(logDayLabel("2026-10-05")).toBe("월 5");
    expect(logDayLabel("2026-10-11")).toBe("일 11");
  });
});
