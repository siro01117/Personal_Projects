import { describe, expect, it } from "vitest";
import { DbError } from "../../lib/errors";
import { expand, type DayPlan, type EventRow, type Occurrence, type Place, type Segment } from "../../lib/schedule";
import {
  DRAFT_ID,
  draftChanges,
  draftOf,
  newDraft,
  savePlan,
  scopesFor,
  withDraft,
  blockFit,
  buildColumns,
  scheduleKorean,
  spansOf,
  dayLabel,
  departureFor,
  departureText,
  duration,
  hm,
  hourRange,
  layoutLanes,
  mondayOf,
  moveTo,
  newAt,
  nowIn,
  repeatLabel,
  resizeTo,
  shiftDays,
  shortWeekTitle,
  snap,
  splitAtMidnight,
  timeRange,
  weekDates,
  weekTitle,
  yToMin,
} from "./schedule";

describe("지금 · 주", () => {
  it("서울 시간으로 날짜와 분", () => {
    // 2026-09-30T15:20Z = 서울 10-01 00:20
    expect(nowIn("Asia/Seoul", new Date("2026-09-30T15:20:00Z"))).toEqual({ date: "2026-10-01", min: 20 });
    expect(nowIn("Asia/Seoul", new Date("2026-10-01T05:20:00Z"))).toEqual({ date: "2026-10-01", min: 860 });
  });
  it("월요일과 그 주 7일", () => {
    expect(mondayOf("2026-10-01")).toBe("2026-09-28");
    expect(mondayOf("2026-09-28")).toBe("2026-09-28");
    expect(mondayOf("2026-10-04")).toBe("2026-09-28");
    expect(weekDates("2026-09-28")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  });
});

describe("글자", () => {
  it("시각", () => {
    expect(hm(0)).toBe("00:00");
    expect(hm(810)).toBe("13:30");
    expect(hm(1500)).toBe("01:00");
    expect(hm(1440)).toBe("00:00");
  });
  it("시간 범위 · 자정 넘김은 다음 날", () => {
    expect(timeRange(1140, 1260)).toBe("19:00–21:00");
    expect(timeRange(1380, 1500)).toBe("23:00–다음 날 01:00");
    expect(timeRange(1380, 1440)).toBe("23:00–00:00");
  });
  it("날짜 · 주 제목", () => {
    expect(dayLabel("2026-10-01")).toBe("10월 1일 목");
    expect(dayLabel("2026-10-01", false)).toBe("10월 1일");
    expect(weekTitle("2026-09-28")).toBe("9월 28일 – 10월 4일");
    expect(weekTitle("2026-10-05")).toBe("10월 5일 – 11일");
    expect(shortWeekTitle("2026-09-28")).toBe("9.28 – 10.4");
  });
  it("반복", () => {
    expect(repeatLabel(null)).toBeNull();
    expect(repeatLabel({ freq: "daily" })).toBe("매일");
    expect(repeatLabel({ freq: "weekly", days: [2] })).toBe("매주 화");
    expect(repeatLabel({ freq: "weekly", days: [3, 1] })).toBe("매주 월·수");
    expect(repeatLabel({ freq: "weekly", days: [1, 2, 3, 4, 5] })).toBe("매주 평일");
    expect(repeatLabel({ freq: "weekly", days: [2], until: "2026-12-20" })).toBe("매주 화 · 12월 20일까지");
  });
  it("걸린 시간", () => {
    expect(duration(40)).toBe("40분");
    expect(duration(60)).toBe("1시간");
    expect(duration(90)).toBe("1시간 30분");
  });
});

describe("자정 넘김 나누기", () => {
  it("넘지 않으면 한 조각", () => {
    expect(splitAtMidnight("2026-10-02", 600, 700)).toEqual([{ date: "2026-10-02", start: 600, end: 700, cutTop: false, cutBottom: false }]);
  });
  it("넘으면 두 열", () => {
    expect(splitAtMidnight("2026-10-02", 1380, 1500)).toEqual([
      { date: "2026-10-02", start: 1380, end: 1440, cutTop: false, cutBottom: true },
      { date: "2026-10-03", start: 0, end: 60, cutTop: true, cutBottom: false },
    ]);
  });
  it("자정에 딱 끝나면 한 조각", () => {
    expect(splitAtMidnight("2026-10-02", 1380, 1440)).toHaveLength(1);
  });
  it("자정 뒤에 시작하는 띠는 통째로 다음 날", () => {
    expect(splitAtMidnight("2026-10-02", 1450, 1470)).toEqual([{ date: "2026-10-03", start: 10, end: 30, cutTop: false, cutBottom: false }]);
  });
});

describe("시간 범위", () => {
  it("±1시간을 시간 단위로", () => {
    expect(hourRange([{ start: 565, end: 1280 }])).toEqual({ from: 480, to: 1380 });
  });
  it("최소 8시간 — 위아래로 나눠 늘린다", () => {
    const r = hourRange([{ start: 600, end: 720 }]);
    expect(r.to - r.from).toBe(480);
    expect(r.from).toBeLessThanOrEqual(540);
    expect(r.to).toBeGreaterThanOrEqual(780);
  });
  it("0시·24시 끝에서는 한쪽으로", () => {
    expect(hourRange([{ start: 0, end: 60 }])).toEqual({ from: 0, to: 480 });
    expect(hourRange([{ start: 1380, end: 1440 }])).toEqual({ from: 960, to: 1440 });
  });
  it("아무것도 없으면 8~20시", () => {
    expect(hourRange([])).toEqual({ from: 480, to: 1200 });
  });
});

describe("겹침 칸 나누기", () => {
  const it2 = (start: number, end: number, id: string) => ({ start, end, id });
  it("안 겹치면 한 칸", () => {
    const r = layoutLanes([it2(0, 60, "a"), it2(60, 120, "b")]);
    expect(r.map((x) => [x.item.id, x.lane, x.lanes])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
    ]);
  });
  it("겹치면 칸을 나눈다", () => {
    const r = layoutLanes([it2(0, 60, "a"), it2(30, 90, "b")]);
    expect(r.map((x) => [x.item.id, x.lane, x.lanes])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
    ]);
  });
  it("무게를 주면 칸 폭을 나눠 가진다", () => {
    const r = layoutLanes([it2(0, 60, "band"), it2(30, 90, "ev")], (x) => (x.id === "band" ? 0.5 : 1));
    expect(r.map((x) => [x.item.id, x.left, x.width])).toEqual([
      ["band", 0, 1 / 3],
      ["ev", 1 / 3, 2 / 3],
    ]);
  });
  it("이어 겹치는 무리는 칸 수가 같고, 빈 칸을 다시 쓴다", () => {
    const r = layoutLanes([it2(0, 60, "a"), it2(30, 120, "b"), it2(60, 90, "c"), it2(200, 260, "d")]);
    const m = Object.fromEntries(r.map((x) => [x.item.id, [x.lane, x.lanes]]));
    expect(m).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  });
});

describe("블록 줄 수", () => {
  it("짧은 블록은 시간을 빼고 제목 한 줄", () => {
    expect(blockFit(24)).toEqual({ short: true, showTime: false, lines: 1 });
  });
  it("두 줄이 나오면 시간 한 줄 + 제목", () => {
    expect(blockFit(48)).toEqual({ short: false, showTime: true, lines: 1 });
  });
  it("긴 블록은 제목이 여러 줄", () => {
    expect(blockFit(240).lines).toBe(13);
  });
});

describe("끌기", () => {
  it("스냅 15분", () => {
    expect(snap(607)).toBe(600);
    expect(snap(608)).toBe(615);
  });
  it("좌표 → 분", () => {
    expect(yToMin(48, 480)).toBe(540);
  });
  it("옮기기는 길이를 지키고 0~1439 안", () => {
    expect(moveTo(600, 690, 1007)).toEqual({ start: 1005, end: 1095 });
    expect(moveTo(600, 690, -40)).toEqual({ start: 0, end: 90 });
    expect(moveTo(600, 690, 1500)).toEqual({ start: 1439, end: 1529 });
  });
  it("늘리기는 최소 15분, 최대 24시간", () => {
    expect(resizeTo(600, 601)).toBe(615);
    expect(resizeTo(600, 700)).toBe(705);
    expect(resizeTo(600, 3000)).toBe(2040);
  });
  it("두 번 누른 자리 → 30분 단위, 끝 +60", () => {
    expect(newAt(619)).toEqual({ start: 600, end: 660 });
    expect(newAt(1439)).toEqual({ start: 1410, end: 1470 });
  });
  it("요일 밀기", () => {
    expect(shiftDays([2], 1)).toEqual([3]);
    expect(shiftDays([7], 1)).toEqual([1]);
    expect(shiftDays([1, 3], -1)).toEqual([2, 7]);
  });
});

describe("나갈 시각", () => {
  const places: Place[] = [{ id: "s", name: "학교", role: "school", symbol: "school", color: "sky", sort: 0, deleted: false }];
  const segs: Segment[] = [
    { kind: "prep", date: "2026-09-29", start: 1040, end: 1050 },
    { kind: "travel", date: "2026-09-29", start: 1120, end: 1140, label: "이동", from: "s", to: "c", for_key: "e:2026-09-29", late: 10 },
  ];
  it("들어가는 이동에서 — 늦으면 앞 일정이 끝날 때 출발", () => {
    const d = departureFor("e:2026-09-29", segs);
    expect(d).toEqual({ at: 1130, from: "s", minutes: 20, late: 10 });
    expect(departureText(d!, places)).toBe("18:50 학교에서 출발 · 20분");
  });
  it("없으면 null", () => {
    expect(departureFor("x:2026-09-29", segs)).toBeNull();
  });
});

describe("열 만들기", () => {
  const occ = (key: string, date: string, start: number | null, end: number | null): Occurrence => ({
    key,
    event_id: key.split(":")[0]!,
    on_date: date,
    date,
    start_min: start,
    end_min: end,
    all_day: start === null,
    title: key,
    place_id: null,
    where_text: null,
    travel_min: null,
    note: null,
    source: null,
    task_id: null,
    repeating: false,
    changed: false,
    version: 1,
  });
  const dates = ["2026-10-02", "2026-10-03"];

  it("자정 넘김 일정은 두 열, 종일은 종일 줄", () => {
    const cols = buildColumns(dates, [occ("a:2026-10-02", "2026-10-02", 1380, 1500), occ("b:2026-10-03", "2026-10-03", null, null)], []);
    expect(cols[0]!.items.map((l) => [l.item.start, l.item.end])).toEqual([[1380, 1440]]);
    expect(cols[1]!.items.map((l) => [l.item.start, l.item.end])).toEqual([[0, 60]]);
    expect(cols[1]!.items[0]!.item.kind === "ev" && cols[1]!.items[0]!.item.cutTop).toBe(true);
    expect(cols[1]!.allDay.map((o) => o.key)).toEqual(["b:2026-10-03"]);
  });

  it("띠 · 식사 · 틈 없음, 늦은 이동은 앞 일정 끝에서 출발한 모양으로 다음 일정과 칸을 나눈다", () => {
    const day: DayPlan = {
      date: "2026-10-02",
      carry: null,
      segments: [
        { kind: "travel", date: "2026-10-02", start: 1120, end: 1140, label: "이동", from: "s", to: "c", for_key: "c:2026-10-02", late: 10 },
        { kind: "meal", date: "2026-10-02", meal: "lunch", start: 720, end: 760, short: false },
        { kind: "meal_missing", date: "2026-10-02", meal: "dinner" },
        { kind: "travel", date: "2026-10-02", start: 1430, end: 1450, label: "귀가", from: "c", to: "h", for_key: null, late: 0 },
      ],
    };
    const cols = buildColumns(dates, [occ("s:2026-10-02", "2026-10-02", 1080, 1130), occ("c:2026-10-02", "2026-10-02", 1140, 1260)], [day]);
    const c0 = cols[0]!;
    expect(c0.missing).toEqual(["dinner"]);
    const lanes = Object.fromEntries(c0.items.map((l) => [`${l.item.kind}${l.item.start}`, [l.lane, l.lanes]]));
    expect(lanes).toMatchObject({ meal720: [0, 1], ev1080: [0, 1], band1130: [0, 2], ev1140: [1, 2], band1430: [0, 1] });
    expect(cols[1]!.items.map((l) => [l.item.kind, l.item.start, l.item.end])).toEqual([["band", 0, 10]]);
    expect(spansOf(cols).length).toBe(6);
  });
});

describe("오류 문구", () => {
  it("일정 쪽 제약 이름", () => {
    expect(scheduleKorean(new DbError('duplicate key value violates unique constraint "ez_places_home_unique"', "23505")).code).toBe("HOME_TAKEN");
    expect(scheduleKorean(new DbError('duplicate key value violates unique constraint "ez_events_task_unique"', "23505")).message).toBe(
      "이 할 일은 이미 일정이 있습니다",
    );
  });
  it("버전 충돌", () => {
    expect(scheduleKorean(new DbError("[EZ_VERSION] 그 사이 다른 곳에서 이 일정을 고쳤습니다 (지금 버전 3)", "P0001"))).toEqual({
      code: "EZ_VERSION",
      message: "방금 다른 곳에서 이 일정을 고쳤습니다",
    });
  });
  it("나머지는 toKorean", () => {
    expect(scheduleKorean(new DbError("[EZ_EXTERNAL] 바깥 일정입니다", "P0001")).code).toBe("EZ_EXTERNAL");
  });
});

describe("고치기", () => {
  const ev = (over: Partial<EventRow> = {}): EventRow => ({
    id: "e",
    title: "APPTIVE 회의",
    date: "2026-09-22",
    start_min: 1140,
    end_min: 1260,
    place_id: "c",
    where_text: null,
    travel_min: null,
    note: null,
    repeat: { freq: "weekly", days: [2] },
    source: null,
    external_id: null,
    task_id: null,
    origin_kind: null,
    origin_id: null,
    version: 3,
    updated_at: "",
    ...over,
  });
  const occOf = (e: EventRow, on: string) => expand([e], [], on, on).find((o) => o.on_date === on)!;

  it("바뀐 칸만, 시작·끝은 같이", () => {
    const e = ev();
    const base = draftOf(occOf(e, "2026-09-29"), e);
    expect(draftChanges({ ...base, end: 1290 }, base)).toEqual({ start_min: 1140, end_min: 1290 });
    expect(draftChanges({ ...base, note: "  " }, base)).toEqual({});
    expect(draftChanges({ ...base, allDay: true }, base)).toEqual({ start_min: null, end_min: null });
  });

  it("범위: 반복 아님 → 없음, 규칙을 바꾸면 이후 모두만", () => {
    const e = ev();
    const base = draftOf(occOf(e, "2026-09-29"), e);
    expect(scopesFor(base, base, ev({ repeat: null }))).toEqual([]);
    expect(scopesFor({ ...base, title: "회의" }, base, e)).toEqual(["once", "following"]);
    expect(scopesFor({ ...base, repeat: { freq: "weekly", days: [2, 4] } }, base, e)).toEqual(["following"]);
  });

  it("이번만: 원래 patch 위에 바뀐 칸", () => {
    const e = ev();
    const base = draftOf(occOf(e, "2026-09-29"), e);
    expect(savePlan({ ...base, start: 1200, end: 1320 }, base, e, "once", { note: "x" })).toEqual({
      kind: "once",
      patch: { note: "x", start_min: 1200, end_min: 1320 },
    });
  });

  it("이후 모두로 날짜를 옮기면 요일도 민다", () => {
    const e = ev();
    const base = draftOf(occOf(e, "2026-09-29"), e);
    expect(savePlan({ ...base, date: "2026-09-30" }, base, e, "following")).toEqual({
      kind: "following",
      patch: { date: "2026-09-30", repeat: { freq: "weekly", days: [3] } },
    });
  });

  it("반복 아님은 고치기, 새 일정은 넣기, 안 바뀌면 없음", () => {
    const e = ev({ repeat: null, date: "2026-09-29" });
    const base = draftOf(occOf(e, "2026-09-29"), e);
    expect(savePlan(base, base, e, null)).toEqual({ kind: "none" });
    expect(savePlan({ ...base, title: "회의" }, base, e, null)).toEqual({ kind: "update", patch: { title: "회의" } });
    expect(savePlan(newDraft("2026-10-01", 600, 660), base, null, null).kind).toBe("create");
  });

  it("미리보기: 반복 회차는 예외로, 새 일정은 줄을 더한다", () => {
    const e = ev();
    const base = draftOf(occOf(e, "2026-09-29"), e);
    const rows = withDraft({ events: [e], exceptions: [] }, { event_id: "e", on_date: "2026-09-29" }, { ...base, start: 1200, end: 1320 });
    const o = expand(rows.events, rows.exceptions, "2026-09-29", "2026-10-06");
    expect(o.map((x) => [x.date, x.start_min])).toEqual([
      ["2026-09-29", 1200],
      ["2026-10-06", 1140],
    ]);
    const added = withDraft({ events: [e], exceptions: [] }, null, newDraft("2026-10-01", 600, 660));
    expect(added.events.map((x) => x.id)).toEqual(["e", DRAFT_ID]);
  });
});
