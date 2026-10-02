// lib/meet: 상태 읽기 · 목록 정렬(경계 묶음) · 입력 검사. 날짜: 2026-10-05 가 월요일.

import { describe, expect, it } from "vitest";
import {
  byDate,
  circleOf,
  DEFAULT_MEET_SORT,
  firstDuplicate,
  meetStatus,
  nameKey,
  parseMeetSort,
  roleIdOf,
  sortMeets,
  sortPeople,
  splitMeets,
  validateCircle,
  validateMeet,
  validatePeople,
  type Circle,
  type MeetRow,
  type Poll,
} from "./index";

const POLL: Poll = { dates: ["2026-10-07", "2026-10-08"], day_from: 540, day_to: 1320, duration_min: 60 };

let n = 0;
function meet(over: Partial<MeetRow> = {}): MeetRow {
  n += 1;
  return {
    id: `m${n}`,
    title: `모임 ${n}`,
    note: null,
    circle_id: null,
    place_id: null,
    place_text: null,
    meet_date: null,
    start_min: null,
    end_min: null,
    event_id: null,
    poll: null,
    token: null,
    version: 1,
    created_at: `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`,
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}
const at = (date: string, start = 600, end = 660) => ({ meet_date: date, start_min: start, end_min: end });
const NOW = { date: "2026-10-05", min: 600 };

describe("상태 읽기", () => {
  it("시간 없음 + poll = 맞추는 중, 시간 없음 = 미정", () => {
    expect(meetStatus(meet({ poll: POLL }), NOW)).toBe("polling");
    expect(meetStatus(meet(), NOW)).toBe("open");
  });

  it("시간이 있으면 끝 시각으로 다가옴 / 지난 모임을 가른다 (끝 시각과 같으면 지난 것)", () => {
    expect(meetStatus(meet(at("2026-10-06")), NOW)).toBe("upcoming");
    expect(meetStatus(meet(at("2026-10-04")), NOW)).toBe("past");
    expect(meetStatus(meet(at("2026-10-05", 540, 601)), NOW)).toBe("upcoming"); // 진행 중
    expect(meetStatus(meet(at("2026-10-05", 540, 600)), NOW)).toBe("past");
    expect(meetStatus(meet(at("2026-10-05", 1380, 1440)), { date: "2026-10-06", min: 0 })).toBe("past");
  });

  it("시간이 정해지면 poll 이 남아 있어도 다가옴 / 지난 모임이다", () => {
    expect(meetStatus(meet({ ...at("2026-10-07"), poll: POLL }), NOW)).toBe("upcoming");
  });

  it("카드 셋으로 나눈다", () => {
    const a = meet({ poll: POLL });
    const b = meet();
    const c = meet(at("2026-10-09"));
    const d = meet(at("2026-09-30"));
    const lists = splitMeets([a, b, c, d], NOW);
    expect(lists.todo).toEqual([a, b]);
    expect(lists.upcoming).toEqual([c]);
    expect(lists.past).toEqual([d]);
  });
});

describe("정렬", () => {
  const circles: Circle[] = [
    { id: "c-study", name: "스터디", role_id: "r-univ", members: [], version: 1 },
    { id: "c-app", name: "APPTIVE 1팀", role_id: "r-club", members: [], version: 1 },
    { id: "c-gone-role", name: "옛 동아리", role_id: "r-deleted", members: [], version: 1 },
  ];
  const roles = [
    { id: "r-univ", name: "대학", sort: 1 },
    { id: "r-club", name: "동아리", sort: 2 },
  ];
  const by = { circles, roles };
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it("다가오는 모임은 이른 날짜부터, 지난 모임은 최근 것부터. 내림이면 반대", () => {
    const a = meet(at("2026-10-09", 600));
    const b = meet(at("2026-10-07", 900));
    const c = meet(at("2026-10-07", 600));
    expect(ids(byDate([a, b, c], "upcoming"))).toEqual(ids([c, b, a]));
    expect(ids(byDate([a, b, c], "past"))).toEqual(ids([a, b, c]));
    expect(ids(sortMeets([a, b, c], { key: "date", dir: "desc" }, "upcoming", by)[0]!.items)).toEqual(ids([a, b, c]));
    expect(ids(sortMeets([a, b, c], { key: "date", dir: "desc" }, "past", by)[0]!.items)).toEqual(ids([c, b, a]));
  });

  it("정할 것: 맞추는 중은 첫 후보 날짜 순, 미정은 늘 맨 뒤에 최근에 만든 것부터", () => {
    const open1 = meet();
    const late = meet({ poll: { ...POLL, dates: ["2026-10-20"] } });
    const soon = meet({ poll: POLL });
    const open2 = meet();
    expect(ids(byDate([open1, late, soon, open2], "todo"))).toEqual(ids([soon, late, open2, open1]));
    expect(ids(byDate([open1, late, soon, open2], "todo", false))).toEqual(ids([late, soon, open2, open1]));
  });

  it("날짜 정렬은 경계 없는 한 묶음", () => {
    const g = sortMeets([meet(at("2026-10-09"))], DEFAULT_MEET_SORT, "upcoming", by);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ key: "all", kind: "all", label: "" });
    expect(sortMeets([], DEFAULT_MEET_SORT, "upcoming", by)).toEqual([]);
  });

  it("묶음 정렬: 이름순(한글 먼저) 경계 묶음, 없는 것은 맨 뒤. 묶음 안은 가까운 것부터, 내림이면 묶음 순서만 뒤집는다", () => {
    const s1 = meet({ circle_id: "c-study", ...at("2026-10-09") });
    const a1 = meet({ circle_id: "c-app", ...at("2026-10-08") });
    const s2 = meet({ circle_id: "c-study", ...at("2026-10-06") });
    const none = meet(at("2026-10-07"));
    const gone = meet({ circle_id: "c-deleted", ...at("2026-10-10") });
    const rows = [s1, a1, s2, none, gone];
    const asc = sortMeets(rows, { key: "circle", dir: "asc" }, "upcoming", by);
    expect(asc.map((g) => [g.kind, g.label, ids(g.items)])).toEqual([
      ["circle", "스터디", ids([s2, s1])],
      ["circle", "APPTIVE 1팀", ids([a1])],
      ["none", "없음", ids([none, gone])],
    ]);
    const desc = sortMeets(rows, { key: "circle", dir: "desc" }, "upcoming", by);
    expect(desc.map((g) => g.label)).toEqual(["APPTIVE 1팀", "스터디", "없음"]);
    expect(ids(desc[1]!.items)).toEqual(ids([s2, s1]));
  });

  it("역할 정렬: 묶음의 역할로 묶는다 (역할 목록 순). 묶음이 없거나 지운 역할이면 없음", () => {
    const s = meet({ circle_id: "c-study", ...at("2026-10-09") });
    const a = meet({ circle_id: "c-app", ...at("2026-10-08") });
    const old = meet({ circle_id: "c-gone-role", ...at("2026-10-07") });
    const none = meet(at("2026-10-06"));
    const g = sortMeets([s, a, old, none], { key: "role", dir: "asc" }, "upcoming", by);
    expect(g.map((x) => [x.kind, x.key, ids(x.items)])).toEqual([
      ["role", "r-univ", ids([s])],
      ["role", "r-club", ids([a])],
      ["none", "none", ids([none, old])],
    ]);
    expect(roleIdOf(old, circles, roles)).toBeNull();
    expect(circleOf(meet({ circle_id: "c-deleted" }), circles)).toBeNull();
  });

  it("기억해 둔 정렬 읽기: 이상하면 날짜 · 오름", () => {
    expect(parseMeetSort('{"key":"circle","dir":"desc"}')).toEqual({ key: "circle", dir: "desc" });
    for (const raw of [null, "", "x", "[]", '{"key":"place","dir":"asc"}', '{"key":"role","dir":"up"}']) expect(parseMeetSort(raw)).toEqual(DEFAULT_MEET_SORT);
  });

  it("사람 줄: 내 줄이 맨 앞, 나머지는 넣은 순서", () => {
    const p = (id: string, is_owner: boolean, created_at: string) => ({ id, is_owner, created_at });
    expect(sortPeople([p("b", false, "2"), p("me", true, "3"), p("a", false, "1")]).map((x) => x.id)).toEqual(["me", "a", "b"]);
  });
});

describe("검사", () => {
  const ok = { title: "회의" };

  it("제목 1~60자, 메모 2000자, 장소 글 1~60자", () => {
    expect(validateMeet(ok)).toEqual([]);
    expect(validateMeet({ title: "가".repeat(60), note: "가".repeat(2000), place_text: "가".repeat(60) })).toEqual([]);
    expect(validateMeet({ title: " " })[0]!.path).toBe("title");
    expect(validateMeet({})[0]!.path).toBe("title");
    expect(validateMeet({ title: "가".repeat(61) })[0]!.path).toBe("title");
    expect(validateMeet({ ...ok, note: "가".repeat(2001) })[0]!.path).toBe("note");
    expect(validateMeet({ ...ok, place_text: " " })[0]!.path).toBe("place_text");
    expect(validateMeet({ ...ok, place_text: "가".repeat(61) })[0]!.path).toBe("place_text");
    expect(validateMeet(null)).toHaveLength(1);
  });

  it("시간: 셋 다 있거나 셋 다 없다. 자정을 넘기지 않는다", () => {
    expect(validateMeet({ ...ok, meet_date: null, start_min: null, end_min: null })).toEqual([]);
    expect(validateMeet({ ...ok, meet_date: "2026-10-05", start_min: 1380, end_min: 1440 })).toEqual([]);
    expect(validateMeet({ ...ok, meet_date: "2026-10-05" })[0]!.path).toBe("start_min");
    expect(validateMeet({ ...ok, start_min: 600, end_min: 660 })[0]!.path).toBe("meet_date");
    expect(validateMeet({ ...ok, meet_date: "2026-02-30", start_min: 600, end_min: 660 })[0]!.path).toBe("meet_date");
    expect(validateMeet({ ...ok, meet_date: "2026-10-05", start_min: 1440, end_min: 1441 })[0]!.path).toBe("start_min");
    expect(validateMeet({ ...ok, meet_date: "2026-10-05", start_min: 600, end_min: 600 })[0]!.path).toBe("end_min");
    expect(validateMeet({ ...ok, meet_date: "2026-10-05", start_min: 1380, end_min: 1470 })[0]!.reason).toContain("자정");
  });

  it("이름 겹침은 대소문자 · 공백을 무시한다", () => {
    expect(nameKey(" Kim  민서 ")).toBe("kim민서");
    expect(firstDuplicate(["민서", "도윤", "민 서"])).toBe("민 서");
    expect(firstDuplicate(["민서", "도윤"])).toBeNull();
  });

  it("넣을 사람들: 각 1~20자, 겹침 없음, 49명까지", () => {
    expect(validatePeople(["민서", "도윤"])).toEqual([]);
    expect(validatePeople(["민서", ""])[0]!.path).toBe("people[1]");
    expect(validatePeople(["가".repeat(21)])[0]!.path).toBe("people[0]");
    expect(validatePeople(["Kim", "kim"])[0]!.reason).toContain("두 번");
    expect(validatePeople(Array.from({ length: 50 }, (_, i) => `사람${i}`))[0]!.reason).toContain("49명");
    expect(validatePeople("민서")[0]!.path).toBe("people");
  });

  it("묶음: 이름 1~30자, 사람 50명까지", () => {
    expect(validateCircle({ name: "APPTIVE 1팀", members: ["민서"] })).toEqual([]);
    expect(validateCircle({ name: "" })[0]!.path).toBe("name");
    expect(validateCircle({ name: "가".repeat(31) })[0]!.path).toBe("name");
    expect(validateCircle({ name: "x", members: Array.from({ length: 51 }, (_, i) => `사람${i}`) })[0]!.path).toBe("members");
  });
});
