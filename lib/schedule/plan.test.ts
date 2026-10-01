import { describe, expect, it } from "vitest";
import { planDay, planRange } from "./plan";
import { DEFAULT_SETTINGS, type DayPlan, type EventRow, type Occurrence, type Place, type Segment, type Settings, type Travel } from "./types";

const D = "2026-09-28"; // 월

function place(id: string, role: Place["role"], deleted = false): Place {
  return { id, name: id, role, symbol: "pin", color: "sky", sort: 0, deleted };
}

// 목업(docs/mockup/schedule-v1.html)과 같은 지점·이동시간
const PLACES = [place("home", "home"), place("school", "school"), place("scube", "work"), place("cafe", null)];
const TRAVEL: Travel[] = [
  { a: "home", b: "school", minutes: 30 },
  { a: "home", b: "scube", minutes: 20 },
  { a: "school", b: "scube", minutes: 25 },
  { a: "cafe", b: "home", minutes: 15 },
  { a: "cafe", b: "school", minutes: 20 },
];
const S = DEFAULT_SETTINGS;
const NO_MEAL: Settings = { ...S, meal_min: 0 };

function occ(title: string, start: number, end: number, place_id: string | null = null, more: Partial<Occurrence> = {}): Occurrence {
  const date = more.date ?? D;
  return {
    key: `${title}:${date}`,
    event_id: title,
    on_date: date,
    date,
    start_min: start,
    end_min: end,
    all_day: false,
    title,
    place_id,
    where_text: null,
    travel_min: null,
    note: null,
    source: null,
    task_id: null,
    repeating: false,
    changed: false,
    version: 1,
    ...more,
  };
}

const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

/** 띠를 읽기 쉬운 글로: "준비 9:25–10:00", "등교 10:00–10:30 늦음10", "점심 12:30–13:10 짧게", "저녁 없음" */
function show(s: Segment): string {
  const meal = (m: "lunch" | "dinner") => (m === "lunch" ? "점심" : "저녁");
  switch (s.kind) {
    case "prep":
      return `준비 ${hm(s.start)}–${hm(s.end)}`;
    case "travel":
      return `${s.label} ${hm(s.start)}–${hm(s.end)}${s.late ? ` 늦음${s.late}` : ""}`;
    case "meal":
      return `${meal(s.meal)} ${hm(s.start)}–${hm(s.end)}${s.short ? " 짧게" : ""}`;
    case "meal_missing":
      return `${meal(s.meal)} 없음`;
  }
}
const bands = (p: DayPlan) => p.segments.map(show);
const plan = (occs: Occurrence[], settings: Settings = NO_MEAL, places: Place[] = PLACES, carry: DayPlan["carry"] = null) =>
  planDay(D, occs, places, TRAVEL, settings, carry);

describe("planDay 동선", () => {
  it("집 들르기: 50분이면 들르고 49분이면 안 들른다", () => {
    // 학교 끝 12:00, 다음 스큐. 귀가 30 + 준비 10 + 다시 20 = 60. 13:50 시작이면 남는 집 시간 50
    const stay = plan([occ("수업", 600, 720, "school"), occ("근무", 830, 900, "scube")]);
    expect(bands(stay)).toEqual(["준비 8:55–9:30", "등교 9:30–10:00", "귀가 12:00–12:30", "준비 13:20–13:30", "출근 13:30–13:50", "귀가 15:00–15:20"]);
    const pass = plan([occ("수업", 600, 720, "school"), occ("근무", 829, 900, "scube")]);
    expect(bands(pass)).toEqual(["준비 8:55–9:30", "등교 9:30–10:00", "출근 13:24–13:49", "귀가 15:00–15:20"]);
  });

  it("집 들르기는 귀가·다시 이동 둘 다 표에 있어야 한다", () => {
    const gym = place("gym", null);
    const p = planDay(D, [occ("수업", 600, 720, "school"), occ("운동", 1000, 1060, "gym")], [...PLACES, gym], TRAVEL, NO_MEAL, null);
    // 집→체육관 표 없음: 들르지 않고, 학교→체육관도 표 없어 이동 띠 없음
    expect(bands(p)).toEqual(["준비 8:55–9:30", "등교 9:30–10:00"]);
  });

  it("준비: 첫 외출 35, 다시 나갈 때 10", () => {
    const p = plan([occ("수업", 600, 720, "school"), occ("근무", 1020, 1320, "scube")]);
    expect(bands(p)).toEqual(["준비 8:55–9:30", "등교 9:30–10:00", "귀가 12:00–12:30", "준비 16:30–16:40", "출근 16:40–17:00", "귀가 22:00–22:20"]);
  });

  it("prep_first 0 이면 준비가 없다", () => {
    const p = plan([occ("수업", 600, 720, "school"), occ("근무", 1020, 1320, "scube")], { ...NO_MEAL, prep_first: 0 });
    expect(bands(p)).toEqual(["등교 9:30–10:00", "귀가 12:00–12:30", "출근 16:40–17:00", "귀가 22:00–22:20"]);
  });

  it("표에 없는 쌍은 0분: 이동 띠 없이 준비만, 귀가 없음", () => {
    const gym = place("gym", null);
    const p = planDay(D, [occ("운동", 600, 660, "gym")], [...PLACES, gym], TRAVEL, NO_MEAL, null);
    expect(bands(p)).toEqual(["준비 9:25–10:00"]);
    expect(p.carry).toEqual({ home_from: 0 });
  });

  it("travel_min 만 있는 일정: 들어가는 이동만, 위치는 집 그대로라 귀가 없음", () => {
    const p = plan([occ("병원", 840, 900, null, { travel_min: 25 })]);
    expect(p.segments).toEqual([
      { kind: "prep", date: D, start: 780, end: 815 },
      { kind: "travel", date: D, start: 815, end: 840, label: "이동", from: "home", to: null, for_key: "병원:2026-09-28", late: 0 },
    ]);
  });

  it("일정의 travel_min 이 표보다 먼저", () => {
    const p = plan([occ("수업", 600, 720, "school", { travel_min: 45 })]);
    expect(bands(p)).toEqual(["준비 8:40–9:15", "등교 9:15–10:00", "귀가 12:00–12:30"]);
  });

  it("떠 있는 일정은 동선을 만들지 않는다", () => {
    const p = plan([occ("통화", 420, 480), occ("수업", 600, 720, "school")]);
    expect(bands(p)).toEqual(["준비 8:55–9:30", "등교 9:30–10:00", "귀가 12:00–12:30"]);
  });

  it("비키기: 들어가는 이동이 떠 있는 일정과 겹치면 일찍 나간다", () => {
    const p = plan([occ("통화", 740, 760), occ("수업", 780, 870, "school")]);
    expect(bands(p)).toEqual(["준비 11:15–11:50", "등교 11:50–12:20", "귀가 14:30–15:00"]);
  });

  it("비키기: 당기면 앞 일정 끝보다 일러지면 원래 자리 (겹친 채로)", () => {
    // 카페 10:00–11:30 → 떠 있는 11:45–12:20 → 학교 12:30 (카페→학교 20)
    const p = plan([occ("회의", 600, 690, "cafe"), occ("통화", 705, 740), occ("수업", 750, 840, "school")]);
    expect(bands(p)).toEqual(["준비 9:10–9:45", "이동 9:45–10:00", "등교 12:10–12:30", "귀가 14:00–14:30"]);
  });

  it("비키기: 나오는 이동은 떠 있는 일정 끝으로 미룬다", () => {
    const p = plan([occ("수업", 600, 720, "school"), occ("정리", 720, 750)]);
    expect(bands(p)).toEqual(["준비 8:55–9:30", "등교 9:30–10:00", "귀가 12:30–13:00"]);
  });

  it("비키기: 집 들르기 귀가는 상한(다음시작−다시−준비)을 넘으면 원래 자리", () => {
    // 스큐 14:10. 상한 = 850 − 20 − 10 = 820
    const ok = plan([occ("수업", 600, 720, "school"), occ("정리", 720, 780), occ("근무", 850, 900, "scube")]);
    expect(bands(ok)).toContain("귀가 13:00–13:30");
    const no = plan([occ("수업", 600, 720, "school"), occ("정리", 720, 800), occ("근무", 850, 900, "scube")]);
    expect(bands(no)).toContain("귀가 12:00–12:30");
  });

  it("늦음: 이동 출발이 앞 일정 끝보다 이르면 그 차이", () => {
    const p = plan([occ("수업", 600, 720, "school"), occ("회의", 730, 800, "cafe")]);
    expect(bands(p)).toEqual(["준비 8:55–9:30", "등교 9:30–10:00", "이동 11:50–12:10 늦음10", "귀가 13:20–13:35"]);
  });

  it("늦음: 전날 귀가(carry)보다 준비가 이르면", () => {
    const p = plan([occ("수업", 50, 120, "school")], NO_MEAL, PLACES, { home_from: 30 });
    const t = p.segments.find((s) => s.kind === "travel" && s.for_key);
    expect(t).toMatchObject({ start: 20, end: 50, late: 45 });
  });

  it("집이 없으면 지점 사이 이동만 (준비·첫 출발·귀가 없음)", () => {
    const places = PLACES.filter((p) => p.role !== "home");
    const p = plan([occ("수업", 600, 720, "school"), occ("회의", 780, 840, "cafe")], NO_MEAL, places);
    expect(bands(p)).toEqual(["이동 12:40–13:00"]);
  });

  it("지운 집은 집이 없는 것과 같고, 지운 지점의 일정은 떠 있는 일정", () => {
    const places = [place("home", "home", true), place("school", "school"), place("cafe", null, true)];
    const p = plan([occ("수업", 600, 720, "school"), occ("회의", 780, 840, "cafe")], NO_MEAL, places);
    expect(bands(p)).toEqual([]);
  });

  it("종일 회차는 동선·식사에서 빠진다", () => {
    const p = plan([occ("연휴", 0, 0, "school", { all_day: true, start_min: null, end_min: null })], S);
    expect(p.segments).toEqual([]);
  });
});

describe("planDay 식사", () => {
  it("선호 시각에 가깝게, 5분 단위", () => {
    const p = plan([occ("작업", 600, 763)], S);
    expect(bands(p)).toEqual(["점심 12:45–13:25", "저녁 18:00–18:40"]);
  });

  it("20분 미만 조각은 버리고, 못 채우면 짧게", () => {
    const tight = plan([occ("A", 660, 720), occ("B", 739, 840)], S);
    expect(bands(tight)).toContain("점심 없음");
    const short = plan([occ("A", 660, 720), occ("B", 740, 840)], S);
    expect(bands(short)).toContain("점심 12:00–12:20 짧게");
  });

  it("짧은 자리보다 온전한 자리가 멀어도 먼저", () => {
    const p = plan([occ("A", 690, 720), occ("B", 750, 790)], S);
    // 11:00–11:30(30분, 짧음) · 12:00–12:30(짧음) · 13:10–14:00(온전)
    expect(bands(p)).toContain("점심 13:10–13:50");
  });

  it("키워드 일정이 창에 걸치면 그 끼니는 아무것도 내지 않는다", () => {
    const p = plan([occ("점심 약속", 830, 900), occ("팀 회식", 1200, 1300)], S);
    expect(bands(p)).toEqual([]);
    const outside = plan([occ("점심 준비", 540, 600)], S);
    expect(bands(outside)).toEqual(["점심 12:00–12:40", "저녁 18:00–18:40"]);
  });

  it("점심 자리를 막은 뒤 저녁을 정한다", () => {
    const st: Settings = { ...S, dinner: { from: 700, to: 900, prefer: 720 } };
    const p = plan([occ("A", 540, 600)], st);
    expect(bands(p)).toEqual(["점심 12:00–12:40", "저녁 12:40–13:20"]);
  });

  it("시각 있는 회차가 없거나 meal_min 0 이면 추천 없음", () => {
    expect(plan([], S).segments).toEqual([]);
    expect(plan([occ("A", 540, 600)], { ...S, meal_min: 0 }).segments).toEqual([]);
  });

  it("준비·이동도 바쁜 구간이다", () => {
    const p = plan([occ("근무", 1020, 1320, "scube")], S);
    expect(bands(p)).toEqual(["점심 12:00–12:40", "준비 16:05–16:40", "출근 16:40–17:00", "귀가 22:00–22:20", "저녁 없음"]);
  });
});

describe("자정 넘김", () => {
  it("귀가가 자정을 넘으면 그대로 두고 carry 로 넘긴다", () => {
    const p = plan([occ("근무", 1080, 1500, "scube")]);
    expect(bands(p)).toEqual(["준비 17:05–17:40", "출근 17:40–18:00", "귀가 25:00–25:20"]);
    expect(p.carry).toEqual({ home_from: 80 });
  });

  it("planRange: 다음 날은 다시 prep_first, 전날 귀가보다 이르면 늦음, 넘어온 부분은 바쁜 구간", () => {
    const events: EventRow[] = [
      row("근무", "2026-10-02", 1080, 1500, "scube"),
      row("새벽 수업", "2026-10-03", 90, 180, "school"),
      row("마감 작업", "2026-10-03", 1380, 1500, null),
    ];
    const r = planRange("2026-10-03", "2026-10-04", events, [], PLACES, TRAVEL, S);
    expect(r.occurrences.map((o) => o.key)).toEqual(["근무:2026-10-02", "새벽 수업:2026-10-03", "마감 작업:2026-10-03"]);
    const [sat, sun] = r.days;
    expect(bands(sat!)).toEqual(["준비 0:25–1:00", "등교 1:00–1:30 늦음55", "귀가 3:00–3:30", "점심 12:00–12:40", "저녁 18:00–18:40"]);
    // 일요일: 전날 마감 작업이 넘어왔지만 그날 회차가 없어 식사 추천 없음
    expect(sun!.segments).toEqual([]);
    expect(sun!.carry).toEqual({ home_from: 0 });
  });

  it("넘어온 부분은 다음 날 식사에서 바쁜 구간", () => {
    const st: Settings = { ...S, lunch: { from: 0, to: 120, prefer: 0 } };
    const prev = occ("밤샘", 1380, 1500, null, { date: "2026-09-27" });
    const p = planDay(D, [prev, occ("A", 600, 660)], PLACES, TRAVEL, st, null);
    expect(bands(p)).toContain("점심 1:00–1:40");
  });
});

function row(id: string, date: string, start: number, end: number, place_id: string | null, more: Partial<EventRow> = {}): EventRow {
  return {
    id,
    title: id,
    date,
    start_min: start,
    end_min: end,
    place_id,
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
    updated_at: "2026-10-01T00:00:00Z",
    ...more,
  };
}

describe("목업의 한 주 (2026-09-28 ~ 10-04)", () => {
  const weekly = (days: number[]) => ({ repeat: { freq: "weekly" as const, days } });
  const events: EventRow[] = [
    row("자료구조", "2026-09-28", 630, 720, "school", { ...weekly([1, 3]), source: "univ", external_id: "ds" }),
    row("운영체제", "2026-09-29", 780, 870, "school", { ...weekly([2, 4]), source: "univ", external_id: "os" }),
    row("스큐 근무 월", "2026-09-28", 1020, 1320, "scube", { source: "studycube", external_id: "w1" }),
    row("스큐 근무 수", "2026-09-30", 1020, 1320, "scube", { source: "studycube", external_id: "w3" }),
    row("스큐 근무 금", "2026-10-02", 1020, 1320, "scube", { source: "studycube", external_id: "w5" }),
    row("스터디", "2026-09-29", 1080, 1130, "school"),
    row("APPTIVE 회의", "2026-09-29", 1140, 1260, "cafe", weekly([2])),
    row("팀플 정리", "2026-10-01", 930, 990, null),
    row("마감 작업", "2026-10-02", 1380, 1500, null),
    row("추석 연휴", "2026-10-03", 0, 0, null, { start_min: null, end_min: null }),
  ];
  const r = planRange("2026-09-28", "2026-10-04", events, [], PLACES, TRAVEL, S);
  const day = (d: string) => bands(r.days.find((x) => x.date === d)!);

  it("월: 등교 → 집 들러 점심 → 출근 → 귀가, 저녁 틈 없음", () => {
    expect(day("2026-09-28")).toEqual([
      "준비 9:25–10:00",
      "등교 10:00–10:30",
      "귀가 12:00–12:30",
      "점심 12:30–13:10",
      "준비 16:30–16:40",
      "출근 16:40–17:00",
      "귀가 22:00–22:20",
      "저녁 없음",
    ]);
  });

  it("수는 월과 같다", () => {
    expect(day("2026-09-30")).toEqual(day("2026-09-28"));
  });

  it("화: 학교에서 카페로 10분 늦음", () => {
    expect(day("2026-09-29")).toEqual([
      "점심 11:15–11:55",
      "준비 11:55–12:30",
      "등교 12:30–13:00",
      "귀가 14:30–15:00",
      "저녁 17:00–17:20 짧게",
      "준비 17:20–17:30",
      "등교 17:30–18:00",
      "이동 18:40–19:00 늦음10",
      "귀가 21:00–21:15",
    ]);
  });

  it("목: 떠 있는 팀플 정리는 동선 없음", () => {
    expect(day("2026-10-01")).toEqual(["점심 11:15–11:55", "준비 11:55–12:30", "등교 12:30–13:00", "귀가 14:30–15:00", "저녁 18:00–18:40"]);
  });

  it("금 밤 마감 작업은 토요일 열에도 회차로 나오고, 토요일엔 시각 있는 회차가 없어 식사 없음", () => {
    expect(r.occurrences.filter((o) => o.title === "마감 작업").map((o) => o.date)).toEqual(["2026-10-02"]);
    expect(day("2026-10-03")).toEqual([]);
    expect(r.days).toHaveLength(7);
  });
});
