import { describe, expect, it } from "vitest";
import { validateEvent, validateTask } from "./validate";

const ok = { title: "수업", date: "2026-09-28", start_min: 630, end_min: 720 };
const paths = (input: unknown) => validateEvent(input).map((i) => i.path);

describe("validateEvent", () => {
  it("정상: 시각 있음 · 종일 · 다음 날 끝 · 반복", () => {
    expect(validateEvent(ok)).toEqual([]);
    expect(validateEvent({ ...ok, start_min: null, end_min: null })).toEqual([]);
    expect(validateEvent({ ...ok, start_min: 1439, end_min: 1439 + 1440 })).toEqual([]);
    expect(validateEvent({ ...ok, repeat: { freq: "weekly", days: [1, 3], until: "2026-09-28" } })).toEqual([]);
    expect(validateEvent({ ...ok, repeat: { freq: "daily" }, travel_min: 0, note: "가".repeat(2000), where_text: "가".repeat(100) })).toEqual([]);
  });

  it("제목: 앞뒤 공백 지우고 1~100자", () => {
    expect(validateEvent({ ...ok, title: "  " })).toEqual([{ path: "title", reason: "제목이 비어 있습니다" }]);
    expect(validateEvent({ ...ok, title: ` ${"가".repeat(100)} ` })).toEqual([]);
    expect(validateEvent({ ...ok, title: "가".repeat(101) })[0]!.reason).toBe("제목은 100자까지 쓸 수 있습니다 (지금 101자)");
    expect(paths({ ...ok, title: undefined })).toEqual(["title"]);
  });

  it("날짜", () => {
    expect(paths({ ...ok, date: "2026-02-30" })).toEqual(["date"]);
  });

  it("시각 범위", () => {
    expect(paths({ ...ok, start_min: 1440, end_min: 1500 })).toEqual(["start_min"]);
    expect(paths({ ...ok, start_min: -1 })).toEqual(["start_min"]);
    expect(paths({ ...ok, start_min: 600, end_min: 600 })).toEqual(["end_min"]);
    expect(paths({ ...ok, start_min: 600, end_min: 2041 })).toEqual(["end_min"]);
    expect(paths({ ...ok, start_min: 600.5 })).toEqual(["start_min"]);
    expect(paths({ ...ok, start_min: null })).toEqual(["start_min"]);
    expect(paths({ ...ok, end_min: null })).toEqual(["end_min"]);
  });

  it("반복 모양 · until ≥ date", () => {
    expect(paths({ ...ok, repeat: { freq: "monthly" } })).toEqual(["repeat"]);
    expect(paths({ ...ok, repeat: { freq: "weekly", days: [] } })).toEqual(["repeat.days"]);
    expect(paths({ ...ok, repeat: { freq: "weekly", days: [0] } })).toEqual(["repeat.days"]);
    expect(paths({ ...ok, repeat: { freq: "weekly", days: [1, 1] } })).toEqual(["repeat.days"]);
    expect(validateEvent({ ...ok, repeat: { freq: "daily", until: "2026-09-27" } })).toEqual([
      { path: "repeat.until", reason: "끝나는 날이 시작 날짜보다 이릅니다" },
    ]);
    expect(paths({ ...ok, repeat: { freq: "daily", until: "언젠가" } })).toEqual(["repeat.until"]);
  });

  it("이동시간 · 메모 · 상세 장소", () => {
    expect(paths({ ...ok, travel_min: 601 })).toEqual(["travel_min"]);
    expect(paths({ ...ok, travel_min: -1 })).toEqual(["travel_min"]);
    expect(validateEvent({ ...ok, note: "가".repeat(2001) })).toEqual([{ path: "note", reason: "메모는 2000자까지 쓸 수 있습니다 (지금 2001자)" }]);
    expect(paths({ ...ok, where_text: "가".repeat(101) })).toEqual(["where_text"]);
  });

  it("여러 문제를 한 번에, 객체가 아니면 하나", () => {
    expect(paths({ title: "", date: "x", start_min: 2000, end_min: 1 })).toEqual(["title", "date", "start_min"]);
    expect(paths(null)).toEqual([""]);
  });
});

describe("validateTask", () => {
  it("정상", () => {
    expect(validateTask({ title: "보고서 쓰기" })).toEqual([]);
    expect(validateTask({ title: "a", est_min: 5, due: "2026-10-05", note: null })).toEqual([]);
    expect(validateTask({ title: "가".repeat(200), est_min: 600 })).toEqual([]);
  });
  it("제목 1~200, est_min 5~600, due 날짜", () => {
    expect(validateTask({ title: "가".repeat(201) })[0]!.reason).toBe("제목은 200자까지 쓸 수 있습니다 (지금 201자)");
    expect(validateTask({ title: " " }).map((i) => i.path)).toEqual(["title"]);
    expect(validateTask({ title: "a", est_min: 4 }).map((i) => i.path)).toEqual(["est_min"]);
    expect(validateTask({ title: "a", est_min: 601 }).map((i) => i.path)).toEqual(["est_min"]);
    expect(validateTask({ title: "a", due: "10/5" }).map((i) => i.path)).toEqual(["due"]);
  });
});
