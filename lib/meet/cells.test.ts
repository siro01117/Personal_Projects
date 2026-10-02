// 시간 맞추기 계산: 설정 · 칸 검사, 내 되는 시간 자동 채우기, 겹침, 추천 시간, 칠하기. 날짜: 2026-09-28 · 2026-10-05 가 월요일.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type EventRow, type Place, type Travel } from "../schedule";
import {
  autoCells,
  cellKey,
  cleanCells,
  clipCells,
  hasCell,
  myFreeCells,
  overlap,
  overlapLevel,
  paintMode,
  paintRect,
  pollRange,
  pollSlots,
  sameCells,
  samePoll,
  suggestTimes,
  validateCells,
  validateMeet,
  validatePoll,
  type Painter,
  type Poll,
} from "./index";

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

function ev(id: string, date: string, start: number | null, end: number | null, place_id: string | null = null): EventRow {
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
    updated_at: "2026-09-01T00:00:00Z",
  };
}

const poll = (over: Partial<Poll> = {}): Poll => ({ dates: [D], day_from: 480, day_to: 1440, duration_min: 60, ...over });
const who = (name: string, cells: Painter["cells"], is_owner = false): Painter => ({ name, cells, is_owner });

describe("맞추기 설정 · 칸 검사", () => {
  it("설정: 후보 날짜 1~31개(오름차순 · 겹침 없음), 범위와 길이는 30분 단위", () => {
    expect(validatePoll(poll())).toEqual([]);
    expect(validatePoll(poll({ day_from: 0, day_to: 1440, duration_min: 480 }))).toEqual([]);
    expect(validatePoll(null)[0]!.path).toBe("poll");
    expect(validatePoll(poll({ dates: [] }))[0]!.path).toBe("poll.dates");
    expect(validatePoll(poll({ dates: ["2026-10-06", "2026-10-05"] }))[0]!.path).toBe("poll.dates");
    expect(validatePoll(poll({ dates: [D, D] }))[0]!.path).toBe("poll.dates");
    expect(validatePoll(poll({ dates: ["2026-02-30"] }))[0]!.path).toBe("poll.dates");
    expect(validatePoll(poll({ dates: Array.from({ length: 32 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`) }))[0]!.path).toBe("poll.dates");
    expect(validatePoll(poll({ day_from: 545 }))[0]!.path).toBe("poll.day_from");
    expect(validatePoll(poll({ day_from: 600, day_to: 600 }))[0]!.path).toBe("poll.day_from");
    expect(validatePoll(poll({ day_to: 1470 }))[0]!.path).toBe("poll.day_from");
    expect(validatePoll(poll({ duration_min: 45 }))[0]!.path).toBe("poll.duration_min");
    expect(validatePoll(poll({ duration_min: 510 }))[0]!.path).toBe("poll.duration_min");
    expect(validatePoll(poll({ day_from: 600, day_to: 660, duration_min: 90 }))[0]!.reason).toContain("하루 범위보다");
  });

  it("같은 설정인지는 칸 순서와 상관없다", () => {
    const a = poll();
    expect(samePoll(a, { duration_min: 60, day_to: 1440, dates: [D], day_from: 480 })).toBe(true);
    expect(samePoll(a, { ...a, dates: [D, "2026-09-29"] })).toBe(false);
    expect(samePoll(a, { ...a, duration_min: 90 })).toBe(false);
    expect(samePoll(a, null)).toBe(false);
    expect(samePoll(null, null)).toBe(true);
  });

  it("모임 검사가 설정도 본다", () => {
    expect(validateMeet({ title: "회의", poll: poll() })).toEqual([]);
    expect(validateMeet({ title: "회의", poll: null })).toEqual([]);
    expect(validateMeet({ title: "회의", poll: poll({ dates: [] }) })[0]!.path).toBe("poll.dates");
  });

  it("칸: 후보 날짜 · 30분 단위 · 범위 안 · 겹침 없음", () => {
    const p = poll({ day_from: 540, day_to: 720 });
    expect(pollSlots(p)).toEqual([540, 570, 600, 630, 660, 690]);
    expect(validateCells({ [D]: [540, 690] }, p)).toEqual([]);
    expect(validateCells({}, p)).toEqual([]);
    expect(validateCells([], p)).toHaveLength(1);
    expect(validateCells({ "2026-09-29": [540] }, p)[0]!.reason).toContain("후보 날짜");
    expect(validateCells({ [D]: [550] }, p)[0]!.reason).toContain("30분");
    expect(validateCells({ [D]: [510] }, p)[0]!.reason).toContain("범위");
    expect(validateCells({ [D]: [720] }, p)[0]!.reason).toContain("범위");
    expect(validateCells({ [D]: [540, 540] }, p)[0]!.reason).toContain("두 번");
    expect(validateCells({ [D]: "540" }, p)).toHaveLength(1);
  });

  it("정리 · 설정 안으로 자르기 · 같은지", () => {
    expect(cleanCells({ b: [600, 540, 600], a: [], c: [30] })).toEqual({ b: [540, 600], c: [30] });
    const p = poll({ dates: [D], day_from: 540, day_to: 660 });
    // 줄인 날짜 · 범위 밖의 칸은 계산에서만 빠진다
    expect(clipCells({ [D]: [510, 540, 630, 660], "2026-09-29": [540] }, p)).toEqual({ [D]: [540, 630] });
    expect(clipCells(null, p)).toEqual({});
    expect(sameCells({ [D]: [540, 570] }, { [D]: [570, 540], x: [] })).toBe(true);
    expect(sameCells(null, {})).toBe(false);
    expect(sameCells(null, null)).toBe(true);
    expect(hasCell({ [D]: [540] }, D, 540)).toBe(true);
    expect(hasCell(null, D, 540)).toBe(false);
  });
});

describe("내 되는 시간 자동 채우기", () => {
  const events = [ev("수업", D, 630, 720, "school"), ev("근무", D, 1020, 1320, "scube")];

  it("일정 · 준비 · 이동을 빼고, 통째로 비는 30분 칸만", () => {
    // 빈 시간은 ~09:25(준비 35 + 등교 30 앞), 12:30(귀가 뒤)~16:30(준비 10 + 출근 20 앞), 22:20(귀가 뒤)~
    const cells = myFreeCells(poll(), events, [], PLACES, TRAVEL, DEFAULT_SETTINGS);
    expect(cells).toEqual({ [D]: [480, 510, 750, 780, 810, 840, 870, 900, 930, 960, 1350, 1380, 1410] });
    // 09:00 칸은 09:25 까지만 비어 반쪽 — 뺀다. 22:00 칸도 22:20 부터라 뺀다
    expect(cells[D]).not.toContain(540);
    expect(cells[D]).not.toContain(1320);
  });

  it("식사 추천은 바쁜 시간이 아니다. 종일 일정도", () => {
    const cells = myFreeCells(poll({ day_from: 720, day_to: 900 }), [...events, ev("휴강일", D, null, null)], [], PLACES, TRAVEL, DEFAULT_SETTINGS);
    expect(cells).toEqual({ [D]: [750, 780, 810, 840, 870] });
  });

  it("일정이 없는 날은 범위 전부. 후보 날짜마다 따로", () => {
    const p = poll({ dates: [D, "2026-09-30"], day_from: 600, day_to: 720 });
    expect(myFreeCells(p, events, [], PLACES, TRAVEL, DEFAULT_SETTINGS)).toEqual({ "2026-09-30": [600, 630, 660, 690] });
    expect(pollRange(p)).toEqual({ from: "2026-09-27", to: "2026-09-30" });
  });

  it("전날 자정을 넘긴 일정 · 전날 귀가가 넘어온 부분도 뺀다", () => {
    const p = poll({ day_from: 0, day_to: 180 });
    expect(myFreeCells(p, [ev("밤샘", "2026-09-27", 1380, 1500)], [], PLACES, TRAVEL, DEFAULT_SETTINGS)).toEqual({ [D]: [60, 90, 120, 150] });
    // 전날 23:50 에 학교에서 끝남 → 귀가 23:50~00:20
    expect(myFreeCells(p, [ev("야간", "2026-09-27", 1320, 1430, "school")], [], PLACES, TRAVEL, DEFAULT_SETTINGS)).toEqual({ [D]: [30, 60, 90, 120, 150] });
  });

  it("계산된 날이 없으면 범위 전부", () => {
    expect(autoCells(poll({ day_from: 600, day_to: 660 }), { occurrences: [], days: [] })).toEqual({ [D]: [600, 630] });
  });
});

describe("겹침", () => {
  const p = poll({ dates: [D, "2026-09-29"], day_from: 540, day_to: 660 });

  it("칸마다 되는 사람. 분모는 칠한 사람 수, 설정 밖 칸은 뺀다", () => {
    const o = overlap([who("나", { [D]: [540, 570] }, true), who("민서", { [D]: [570, 900], "2026-09-30": [540] }), who("도윤", null), who("하린", {})], p);
    expect(o.painted).toBe(3);
    expect(o.at.get(cellKey(D, 540))).toEqual(["나"]);
    expect(o.at.get(cellKey(D, 570))).toEqual(["나", "민서"]);
    expect(o.at.has(cellKey(D, 900))).toBe(false);
    expect(o.at.size).toBe(2);
  });

  it("진하기 4단", () => {
    expect([0, 1, 2, 3, 4].map((n) => overlapLevel(n, 4))).toEqual([0, 1, 2, 3, 4]);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => overlapLevel(n, 8))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(overlapLevel(1, 1)).toBe(4);
    expect(overlapLevel(1, 0)).toBe(0);
  });
});

describe("추천 시간", () => {
  const p = poll({ dates: ["2026-10-05", "2026-10-06"], day_from: 540, day_to: 780, duration_min: 60 });
  const AT = { date: "2026-10-01", min: 720 };
  const line = (s: { date: string; start: number; count: number }) => `${s.date.slice(8)} ${s.start} ${s.count}`;

  it("끝까지 다 되는 사람 수가 많은 순. 겹치는 묶음은 가장 이른 것 하나만", () => {
    const people = [
      who("나", { "2026-10-05": [540, 570, 600, 630, 660], "2026-10-06": [600, 630] }, true),
      who("민서", { "2026-10-05": [600, 630, 660, 690], "2026-10-06": [600, 630] }),
      who("도윤", { "2026-10-06": [600, 630, 660, 690] }),
    ];
    const s = suggestTimes(people, p, AT);
    // 10/6 10:00 은 셋 다. 10/5 는 10:00~11:30 이 둘(10:00 · 10:30 묶음이 줄줄이 나오지 않는다), 그 뒤 한 명짜리
    expect(s.map(line)).toEqual(["06 600 3", "05 600 2", "05 540 1", "05 660 1", "06 660 1"]);
    expect(s[0]).toMatchObject({ end: 660, names: ["나", "민서", "도윤"], mine: true });
    expect(s[4]).toMatchObject({ names: ["도윤"], mine: false });
  });

  it("같은 수면 내가 되는 것 먼저, 그다음 이른 날짜 · 이른 시각", () => {
    const people = [who("나", { "2026-10-06": [660, 690] }, true), who("민서", { "2026-10-05": [540, 570] }), who("도윤", { "2026-10-05": [660, 690] })];
    expect(suggestTimes(people, p, AT).map(line)).toEqual(["06 660 1", "05 540 1", "05 660 1"]);
  });

  it("길이만큼 이어지지 않으면 없다. 0명짜리는 없다", () => {
    expect(suggestTimes([who("나", { "2026-10-05": [540, 600, 660] }, true)], p, AT)).toEqual([]);
    expect(suggestTimes([who("나", null, true), who("민서", {})], p, AT)).toEqual([]);
    expect(suggestTimes([who("나", { "2026-10-05": [540] }, true)], { ...p, duration_min: 30 }, AT).map(line)).toEqual(["05 540 1"]);
  });

  it("지난 날짜 · 오늘의 지난 시각은 뺀다. 5개까지", () => {
    const all = { "2026-10-05": [540, 570, 600, 630, 660, 690, 720, 750], "2026-10-06": [540, 570, 600, 630, 660, 690, 720, 750] };
    const people = [who("나", all, true)];
    expect(suggestTimes(people, p, AT).map(line)).toEqual(["05 540 1", "05 600 1", "05 660 1", "05 720 1", "06 540 1"]);
    expect(suggestTimes(people, p, { date: "2026-10-05", min: 600 }).map(line)).toEqual(["05 630 1", "05 690 1", "06 540 1", "06 600 1", "06 660 1"]);
    expect(suggestTimes(people, p, { date: "2026-10-06", min: 700 }).map(line)).toEqual(["06 720 1"]);
    expect(suggestTimes(people, p, { date: "2026-10-07", min: 0 })).toEqual([]);
    expect(suggestTimes(people, p, AT, 2)).toHaveLength(2);
  });

  it("끝이 하루 범위를 넘는 묶음은 없다", () => {
    expect(suggestTimes([who("나", { "2026-10-05": [750] }, true)], p, AT)).toEqual([]);
  });
});

describe("칠하기", () => {
  const p = poll({ dates: ["2026-10-05", "2026-10-06", "2026-10-08"], day_from: 540, day_to: 720 });

  it("시작 칸 ~ 지금 칸의 사각 범위를 칠한다 (거꾸로 끌어도 같다)", () => {
    const a = paintRect(null, p, { date: "2026-10-05", min: 570 }, { date: "2026-10-08", min: 630 }, true);
    expect(a).toEqual({ "2026-10-05": [570, 600, 630], "2026-10-06": [570, 600, 630], "2026-10-08": [570, 600, 630] });
    expect(paintRect(null, p, { date: "2026-10-08", min: 630 }, { date: "2026-10-05", min: 570 }, true)).toEqual(a);
    expect(paintRect(null, p, { date: "2026-10-06", min: 540 }, { date: "2026-10-06", min: 540 }, true)).toEqual({ "2026-10-06": [540] });
  });

  it("지우기: 범위 안만 지우고 빈 날짜는 사라진다. 이미 칠한 칸에 칠해도 그대로", () => {
    const base = { "2026-10-05": [540, 570, 600], "2026-10-06": [570] };
    expect(paintRect(base, p, { date: "2026-10-05", min: 570 }, { date: "2026-10-06", min: 600 }, false)).toEqual({ "2026-10-05": [540] });
    expect(paintRect(base, p, { date: "2026-10-05", min: 540 }, { date: "2026-10-05", min: 570 }, true)).toEqual(base);
    expect(base).toEqual({ "2026-10-05": [540, 570, 600], "2026-10-06": [570] });
  });

  it("설정 밖의 칸은 그대로 둔다. 범위가 벗어나면 안쪽만", () => {
    const base = { "2026-10-07": [540], "2026-10-05": [480] };
    expect(paintRect(base, p, { date: "2026-10-05", min: 660 }, { date: "2026-10-05", min: 900 }, true)).toEqual({ "2026-10-05": [480, 660, 690], "2026-10-07": [540] });
    expect(paintRect(base, p, { date: "2026-10-07", min: 540 }, { date: "2026-10-05", min: 540 }, false)).toEqual(base);
  });

  it("누른 칸이 칠해져 있으면 지우기, 아니면 칠하기", () => {
    expect(paintMode({ "2026-10-05": [540] }, { date: "2026-10-05", min: 540 })).toBe(false);
    expect(paintMode({ "2026-10-05": [540] }, { date: "2026-10-05", min: 570 })).toBe(true);
    expect(paintMode(null, { date: "2026-10-05", min: 540 })).toBe(true);
  });
});
