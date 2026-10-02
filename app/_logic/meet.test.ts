// 모임 화면 계산: 글자 · 폼 ↔ 저장할 칸 · 묶음을 고르면 사람이 채워짐 · 파생 · 오류 문구. 날짜: 2026-10-05 가 월요일.

import { describe, expect, it } from "vitest";
import { DbError } from "../../lib/errors";
import type { Circle, Meet, MeetRow } from "../../lib/meet";
import type { TaskRow } from "../../lib/schedule";
import {
  addNames,
  attendLabels,
  cellHeight,
  decidedText,
  defaultTime,
  draftInput,
  draftPatch,
  draftPeople,
  draftWithCircle,
  durationLabel,
  gridDay,
  halfHours,
  hmEnd,
  lineWhen,
  meetDraftOf,
  meetKorean,
  meetTaskInput,
  meetTasks,
  monthGrid,
  monthTitle,
  newMeetDraft,
  nextMeet,
  parseNames,
  pollLabel,
  publicKorean,
  publicPath,
  shiftMonth,
  slotLabel,
  timeMode,
  toggleDate,
  whenText,
  windowAt,
  withTimeMode,
} from "./meet";

const POLL = { dates: ["2026-10-10", "2026-10-12", "2026-10-14"], day_from: 540, day_to: 1320, duration_min: 60 };

function row(over: Partial<MeetRow> = {}): MeetRow {
  return {
    id: "m1",
    title: "회의",
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
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}
const AT = { meet_date: "2026-10-07", start_min: 1140, end_min: 1260 };
const APP: Circle = { id: "c-app", name: "APPTIVE 1팀", role_id: "r-club", members: ["민서", "도윤"], version: 1 };
const STUDY: Circle = { id: "c-study", name: "스터디", role_id: "r-gone", members: ["서연", "민서"], version: 1 };
const CIRCLES = [APP, STUDY];

describe("글자", () => {
  it("목록 줄: 정해졌으면 날짜 · 요일 · 시작, 맞추는 중이면 후보 날짜 범위, 미정이면 빈 글자", () => {
    expect(lineWhen(row(AT))).toBe("10/7 수 19:00");
    expect(lineWhen(row({ poll: POLL }))).toBe("10/10 – 10/14");
    expect(lineWhen(row())).toBe("");
    expect(pollLabel({ ...POLL, dates: ["2026-10-10"] })).toBe("10/10");
  });

  it("모임 화면의 언제 · 참석 단추 글자", () => {
    expect(whenText(row(AT))).toBe("10월 7일 수 · 19:00–21:00");
    expect(whenText(row())).toBeNull();
    expect(attendLabels("upcoming")).toEqual({ yes: "온다", no: "못 온다" });
    expect(attendLabels("past")).toEqual({ yes: "왔다", no: "안 왔다" });
  });
});

describe("사람 이름", () => {
  it("쉼표 · 줄바꿈으로 나누고 빈 것은 버린다", () => {
    expect(parseNames(" 민서, 도윤 ,,\n하린 ")).toEqual(["민서", "도윤", "하린"]);
    expect(parseNames("  ")).toEqual([]);
  });

  it("더할 때 겹치는 이름(대소문자 · 공백 무시)은 한 번만. 너무 길면 아무것도 안 더한다", () => {
    expect(addNames(["민서"], ["민 서", "도윤", "도윤"])).toEqual({ names: ["민서", "도윤"], issue: null });
    const long = addNames(["민서"], ["가".repeat(21)]);
    expect(long.names).toEqual(["민서"]);
    expect(long.issue).toContain("20자");
  });
});

describe("폼", () => {
  it("새 모임은 '아직 모른다' 로 열린다. 시간을 안다고 바꾸면 다음 정시부터 한 시간", () => {
    const d = newMeetDraft("2026-10-05", 615);
    expect(d).toMatchObject({ known: false, date: "2026-10-05", start: 660, end: 720, people: [] });
    expect(draftInput({ ...d, title: " 회의 " })).toEqual({ title: "회의", note: null, circle_id: null, place_id: null, place_text: null, meet_date: null, start_min: null, end_min: null, poll: null });
    expect(defaultTime(1439)).toEqual({ start: 1380, end: 1440 });
    expect(defaultTime(600)).toEqual({ start: 660, end: 720 });
  });

  it("시간을 알면 셋을 같이 넣는다. 장소 글은 앞뒤 공백을 뗀다", () => {
    const d = { ...newMeetDraft("2026-10-05", 600), title: "회의", known: true, date: "2026-10-07", start: 1140, end: 1260, place_text: " 2층 ", note: "안건" };
    expect(draftInput(d)).toMatchObject({ meet_date: "2026-10-07", start_min: 1140, end_min: 1260, place_text: "2층", note: "안건" });
  });

  it("모임 → 폼 → 바뀐 칸만. 시간은 셋을 같이, 그대로면 빈 patch", () => {
    const m = row({ ...AT, circle_id: "c-app", place_text: "2층", note: "안건" });
    const d = meetDraftOf(m, CIRCLES, "2026-10-05", 600);
    expect(d).toMatchObject({ known: true, date: "2026-10-07", start: 1140, end: 1260, circle_id: "c-app", place_text: "2층", note: "안건" });
    expect(draftPatch(d, m, CIRCLES)).toEqual({});
    expect(draftPatch({ ...d, start: 1200 }, m, CIRCLES)).toEqual({ meet_date: "2026-10-07", start_min: 1200, end_min: 1260 });
    expect(draftPatch({ ...d, known: false }, m, CIRCLES)).toEqual({ meet_date: null, start_min: null, end_min: null });
    expect(draftPatch({ ...d, title: "새 제목", note: "", circle_id: null }, m, CIRCLES)).toEqual({ title: "새 제목", note: null, circle_id: null });
  });

  it("지운 묶음을 가리키던 모임은 묶음 없음으로 열리고, 묶음을 안 건드리면 patch 에 안 실린다", () => {
    const m = row({ circle_id: "c-deleted" });
    const d = meetDraftOf(m, CIRCLES, "2026-10-05", 600);
    expect(d.circle_id).toBeNull();
    expect(draftPatch(d, m, CIRCLES)).toEqual({});
    expect(draftPatch({ ...d, circle_id: "c-app" }, m, CIRCLES)).toEqual({ circle_id: "c-app" });
  });

  it("묶음을 고르면 사람들이 채워진다. 묶음을 바꾸면 앞 묶음에서 온 사람은 빠지고 손으로 적은 사람은 남는다", () => {
    let d = { ...newMeetDraft("2026-10-05", 600), people: ["태윤"] };
    d = draftWithCircle(d, APP, CIRCLES, true);
    expect(d).toMatchObject({ circle_id: "c-app", people: ["태윤", "민서", "도윤"] });
    d = draftWithCircle(d, STUDY, CIRCLES, true);
    expect(d).toMatchObject({ circle_id: "c-study", people: ["태윤", "서연", "민서"] });
    d = draftWithCircle(d, null, CIRCLES, true);
    expect(d).toMatchObject({ circle_id: null, people: ["태윤"] });
    // 고칠 때는 사람을 건드리지 않는다
    expect(draftWithCircle({ ...d, people: [] }, APP, CIRCLES, false)).toMatchObject({ circle_id: "c-app", people: [] });
  });

  it("같이 넣을 사람들: 칩 + 적는 중인 글. 내 이름은 뺀다", () => {
    const d = { ...newMeetDraft("2026-10-05", 600), people: ["민서", "이지"], personText: "도윤, 민서" };
    expect(draftPeople(d, "이지")).toEqual({ names: ["민서", "도윤"], issue: null });
  });
});

describe("파생", () => {
  const meet: Meet = {
    ...row({ ...AT, circle_id: "c-app", place_id: "p-cafe", place_text: "2층", note: "뒷이야기", event_id: "e1" }),
    people: [
      { id: "me", meet_id: "m1", name: "나", is_owner: true, cells: null, auto: false, attend: "yes", has_pin: false, created_at: "1" },
      { id: "p1", meet_id: "m1", name: "민서", is_owner: false, cells: null, auto: false, attend: "no", has_pin: false, created_at: "2" },
    ],
  };

  it("다음 모임: 같은 묶음 · 사람 · 지점 · 제목, 시간 · 메모는 비어 있다", () => {
    expect(nextMeet(meet, CIRCLES)).toEqual({ input: { title: "회의", circle_id: "c-app", place_id: "p-cafe", place_text: "2층" }, people: ["민서"] });
    expect(nextMeet({ ...meet, circle_id: "c-deleted" }, CIRCLES).input.circle_id).toBeNull();
  });

  it("모임에서 나온 할 일: 묶음의 살아 있는 역할과 모임의 지점을 물려받는다", () => {
    const roles = [{ id: "r-club" }];
    expect(meetTaskInput("회의록 정리", meet, CIRCLES, roles)).toEqual({ title: "회의록 정리", origin_kind: "meet", origin_id: "m1", place_id: "p-cafe", role_id: "r-club" });
    // 지운 역할 · 묶음 없음이면 역할 없음
    expect(meetTaskInput("x", { ...meet, circle_id: "c-study" }, CIRCLES, roles).role_id).toBeNull();
    expect(meetTaskInput("x", { ...meet, circle_id: null }, CIRCLES, roles).role_id).toBeNull();
  });

  it("그 모임의 할 일만, 안 끝낸 것 먼저(만든 순)", () => {
    const t = (id: string, over: Partial<TaskRow>) => ({ id, title: id, done_at: null, origin_kind: "meet", origin_id: "m1", created_at: id, ...over }) as TaskRow;
    const tasks = [t("c", { done_at: "2026-10-01T00:00:00Z" }), t("b", {}), t("a", {}), t("x", { origin_id: "m2" }), t("y", { origin_kind: null, origin_id: null })];
    expect(meetTasks(tasks, "m1").map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("오류 문구", () => {
  it("모임 쪽 제약은 한국어로, 버전 충돌은 모임 문구로", () => {
    const dup = (name: string) => new DbError(`duplicate key value violates unique constraint "${name}"`, "23505");
    expect(meetKorean(dup("ez_circles_name_unique")).message).toBe("같은 이름의 묶음이 있습니다");
    expect(meetKorean(dup("ez_meet_people_name_unique")).message).toBe("같은 이름의 사람이 이미 있습니다");
    expect(meetKorean(new DbError("[EZ_VERSION] 그 사이 …", "P0001"))).toEqual({ code: "EZ_VERSION", message: "방금 다른 곳에서 이 모임을 고쳤습니다" });
    expect(meetKorean(new DbError("[EZ_LIMIT] 한 모임에 50명까지입니다. 더는 받을 수 없습니다", "P0001")).message).toContain("더는 받을 수 없습니다");
  });
});

describe("시간 맞추기 — 폼", () => {
  it("시간 고르기는 셋 중 하나: 안다 · 맞춰야 한다 · 아직 모른다", () => {
    const d = newMeetDraft("2026-10-05", 600);
    expect(timeMode(d)).toBe("none");
    expect(d).toMatchObject({ polling: false, dates: [], dayFrom: 540, dayTo: 1320, duration: 60, kept: null });
    const p = { ...withTimeMode(d, "poll"), title: "회의", dates: ["2026-10-12", "2026-10-10"] };
    expect(timeMode(p)).toBe("poll");
    expect(draftInput(p)).toMatchObject({ meet_date: null, start_min: null, end_min: null, poll: { dates: ["2026-10-10", "2026-10-12"], day_from: 540, day_to: 1320, duration_min: 60 } });
    const k = withTimeMode(p, "known");
    expect(timeMode(k)).toBe("known");
    expect(draftInput(k)).toMatchObject({ meet_date: "2026-10-05", poll: null });
    expect(draftInput(withTimeMode(k, "none"))).toMatchObject({ meet_date: null, poll: null });
  });

  it("맞추는 모임 → 폼 → 바뀐 것만. 설정이 그대로면 빈 patch", () => {
    const m = row({ poll: POLL });
    const d = meetDraftOf(m, CIRCLES, "2026-10-05", 600);
    expect(d).toMatchObject({ known: false, polling: true, dates: POLL.dates, dayFrom: 540, dayTo: 1320, duration: 60 });
    expect(draftPatch(d, m, CIRCLES)).toEqual({});
    // DB 가 돌려준 설정은 칸 순서가 다르다 (jsonb) — 그래도 그대로로 본다
    expect(draftPatch(d, row({ poll: { duration_min: 60, day_to: 1320, day_from: 540, dates: POLL.dates } }), CIRCLES)).toEqual({});
    expect(draftPatch({ ...d, duration: 90 }, m, CIRCLES)).toEqual({ poll: { ...POLL, duration_min: 90 } });
    expect(draftPatch(withTimeMode(d, "none"), m, CIRCLES)).toEqual({ poll: null });
    // 맞추다가 시간을 직접 적으면 설정은 남는다 (다시 열면 이어서 맞춘다)
    expect(draftPatch({ ...withTimeMode(d, "known"), date: "2026-10-10", start: 600, end: 660 }, m, CIRCLES)).toEqual({ meet_date: "2026-10-10", start_min: 600, end_min: 660 });
  });

  it("시간이 정해진 맞추기 모임을 고쳐도 설정은 그대로. '맞춰야 한다' 로 바꾸면 시간이 비워진다", () => {
    const m = row({ ...AT, poll: POLL });
    const d = meetDraftOf(m, CIRCLES, "2026-10-05", 600);
    expect(d).toMatchObject({ known: true, polling: false, kept: POLL });
    expect(draftPatch({ ...d, title: "새 제목" }, m, CIRCLES)).toEqual({ title: "새 제목" });
    expect(draftPatch(withTimeMode(d, "poll"), m, CIRCLES)).toEqual({ meet_date: null, start_min: null, end_min: null });
    expect(draftPatch(withTimeMode(d, "none"), m, CIRCLES)).toEqual({ meet_date: null, start_min: null, end_min: null, poll: null });
  });

  it("후보 날짜 켜고 끄기 (이른 날짜부터, 31개까지)", () => {
    expect(toggleDate(["2026-10-10"], "2026-10-08")).toEqual(["2026-10-08", "2026-10-10"]);
    expect(toggleDate(["2026-10-08", "2026-10-10"], "2026-10-08")).toEqual(["2026-10-10"]);
    const full = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    expect(toggleDate(full, "2026-11-01")).toEqual(full);
    expect(toggleDate(full, "2026-10-31")).toHaveLength(30);
  });

  it("달력 한 달: 월요일부터, 그 달이 아닌 칸은 비운다", () => {
    const g = monthGrid("2026-10-15");
    expect(g).toHaveLength(5);
    expect(g[0]).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(g[4]).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", null]);
    expect(monthGrid("2027-02-01").flat().filter(Boolean)).toHaveLength(28);
    expect(monthTitle("2026-10-15")).toBe("2026년 10월");
    expect(shiftMonth("2026-10-15", 1)).toBe("2026-11-01");
    expect(shiftMonth("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-01-05", -1)).toBe("2025-12-01");
  });
});

describe("시간 맞추기 — 글자 · 격자", () => {
  it("길이 · 시각 · 추천 시간 한 줄 · 정한 시간", () => {
    expect([30, 60, 90, 480].map(durationLabel)).toEqual(["30분", "1시간", "1시간 30분", "8시간"]);
    expect(hmEnd(1440)).toBe("24:00");
    expect(hmEnd(1320)).toBe("22:00");
    expect(halfHours(540, 630)).toEqual([540, 570, 600, 630]);
    expect(gridDay("2026-10-07")).toEqual({ md: "10/7", wd: "수" });
    expect(slotLabel({ date: "2026-10-07", start: 1140, end: 1230 })).toBe("10/7 수 19:00–20:30");
    expect(slotLabel({ date: "2026-10-07", start: 1380, end: 1440 })).toBe("10/7 수 23:00–24:00");
    expect(decidedText({ meet_date: "2026-10-07", start_min: 1140, end_min: 1230 })).toEqual({ day: "10월 7일 수", time: "19:00–20:30" });
    expect(decidedText({ meet_date: null, start_min: null, end_min: null })).toBeNull();
  });

  it("누른 칸에서 시작하는 묶음: 길이만큼, 하루 범위를 넘기면 끝에 맞춰 당긴다", () => {
    const p = { ...POLL, duration_min: 90 };
    expect(windowAt(p, { date: "2026-10-10", min: 600 })).toEqual({ date: "2026-10-10", start: 600, end: 690 });
    expect(windowAt(p, { date: "2026-10-10", min: 1290 })).toEqual({ date: "2026-10-10", start: 1230, end: 1320 });
  });

  it("칸 높이: 데스크톱은 22px, 폰은 격자가 화면의 55% 안에 들게(14~24px)", () => {
    expect(cellHeight(26, 900, false)).toBe(22);
    expect(cellHeight(26, 812, true)).toBe(17);
    expect(cellHeight(48, 812, true)).toBe(14);
    expect(cellHeight(6, 812, true)).toBe(24);
    expect(26 * cellHeight(26, 812, true)).toBeLessThan(812 * 0.6);
  });

  it("공개 페이지 주소 · 오류 문구", () => {
    expect(publicPath("abc", false)).toBe("/m/abc");
    expect(publicPath("abc", true)).toBe("/m/abc?demo=1");
    expect(publicKorean(new DbError("[EZ_PIN] 핀번호가 다릅니다. 잊었으면 주최자에게 지워 달라고 하세요", "P0001"))).toEqual({
      code: "EZ_PIN",
      message: "핀번호가 다릅니다. 잊었으면 주최자에게 지워 달라고 하세요",
    });
    expect(publicKorean(new DbError("[EZ_LOCKED] 핀번호를 5번 틀렸습니다. 10분 뒤에 다시 해 주세요", "P0001")).code).toBe("EZ_LOCKED");
    expect(publicKorean(new DbError('duplicate key value violates unique constraint "ez_meet_people_name_unique"', "23505")).message).toContain("같은 이름");
    expect(publicKorean(new TypeError("Failed to fetch")).code).toBe("NETWORK");
    expect(meetKorean(new DbError('new row violates check constraint "ez_meets_poll_check"', "23514")).code).toBe("BAD_POLL");
  });
});
