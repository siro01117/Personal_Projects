import { describe, expect, it } from "vitest";
import { expand } from "./expand";
import type { EventException, EventRow } from "./types";

function ev(id: string, date: string, start: number | null, end: number | null, more: Partial<EventRow> = {}): EventRow {
  return {
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
    updated_at: "2026-10-01T00:00:00Z",
    ...more,
  };
}

const dates = (os: { date: string }[]) => os.map((o) => o.date);

// 2026-09-28 은 월요일
const mw = ev("수업", "2026-09-28", 630, 720, { repeat: { freq: "weekly", days: [1, 3] } });

describe("expand", () => {
  it("반복 없음: 범위 안일 때만", () => {
    const e = ev("한번", "2026-09-30", 600, 660);
    expect(dates(expand([e], [], "2026-09-28", "2026-10-04"))).toEqual(["2026-09-30"]);
    expect(expand([e], [], "2026-10-01", "2026-10-04")).toEqual([]);
    const [o] = expand([e], [], "2026-09-30", "2026-09-30");
    expect(o).toMatchObject({ key: "한번:2026-09-30", on_date: "2026-09-30", repeating: false, changed: false, all_day: false });
  });

  it("매일 + until 포함, 시작일 전 없음", () => {
    const e = ev("매일", "2026-09-29", 540, 600, { repeat: { freq: "daily", until: "2026-10-01" } });
    expect(dates(expand([e], [], "2026-09-27", "2026-10-04"))).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
  });

  it("매주 요일, 시작일이 주 중간이면 그날부터", () => {
    expect(dates(expand([mw], [], "2026-09-28", "2026-10-11"))).toEqual(["2026-09-28", "2026-09-30", "2026-10-05", "2026-10-07"]);
    const mid = { ...mw, date: "2026-09-30" };
    expect(dates(expand([mid], [], "2026-09-28", "2026-10-04"))).toEqual(["2026-09-30"]);
  });

  it("매주인데 요일이 비면 회차 없음", () => {
    const e = ev("빈", "2026-09-28", 600, 660, { repeat: { freq: "weekly", days: [] } });
    expect(expand([e], [], "2026-09-28", "2026-10-11")).toEqual([]);
  });

  it("예외 skip · patch (어느 칸이든)", () => {
    const ex: EventException[] = [
      { event_id: "수업", on_date: "2026-09-28", skip: true, patch: null },
      { event_id: "수업", on_date: "2026-09-30", skip: false, patch: { title: "보강", start_min: 900, end_min: 960, place_id: "p1", travel_min: 15, note: "n", where_text: "w" } },
    ];
    const os = expand([mw], ex, "2026-09-28", "2026-10-04");
    expect(os).toHaveLength(1);
    expect(os[0]).toMatchObject({
      key: "수업:2026-09-30",
      date: "2026-09-30",
      title: "보강",
      start_min: 900,
      end_min: 960,
      place_id: "p1",
      travel_min: 15,
      note: "n",
      where_text: "w",
      changed: true,
      repeating: true,
    });
  });

  it("다른 날로 옮기기: 원래 날짜에서 빠지고 옮긴 날에", () => {
    const ex: EventException[] = [{ event_id: "수업", on_date: "2026-09-30", skip: false, patch: { date: "2026-10-02" } }];
    const os = expand([mw], ex, "2026-09-28", "2026-10-04");
    expect(os.map((o) => [o.date, o.on_date])).toEqual([
      ["2026-09-28", "2026-09-28"],
      ["2026-10-02", "2026-09-30"],
    ]);
    expect(os[1]!.key).toBe("수업:2026-09-30");
  });

  it("옮기기: 원래 날짜가 범위 밖이어도 옮긴 날이 안이면 나온다, 옮긴 날이 밖이면 안 나온다", () => {
    const into: EventException[] = [{ event_id: "수업", on_date: "2026-09-28", skip: false, patch: { date: "2026-10-10" } }];
    expect(expand([mw], into, "2026-10-08", "2026-10-11").map((o) => o.key)).toEqual(["수업:2026-09-28"]);
    const out: EventException[] = [{ event_id: "수업", on_date: "2026-09-30", skip: false, patch: { date: "2026-10-20" } }];
    expect(dates(expand([mw], out, "2026-09-28", "2026-10-04"))).toEqual(["2026-09-28"]);
  });

  it("반복일이 아닌 날의 예외, 반복 아닌 일정의 예외는 무시", () => {
    const ex: EventException[] = [
      { event_id: "수업", on_date: "2026-09-29", skip: false, patch: { date: "2026-10-01" } }, // 화요일: 회차 아님
      { event_id: "수업", on_date: "2026-10-01", skip: true, patch: null },
      { event_id: "한번", on_date: "2026-09-30", skip: true, patch: null },
    ];
    const once = ev("한번", "2026-09-30", 600, 660);
    expect(expand([mw, once], ex, "2026-09-28", "2026-10-04").map((o) => o.key)).toEqual([
      "수업:2026-09-28",
      "한번:2026-09-30",
      "수업:2026-09-30",
    ]);
  });

  it("from 전날 시작해 자정을 넘어오는 회차도 넣는다", () => {
    const night = ev("마감", "2026-09-27", 1380, 1500);
    const plain = ev("낮", "2026-09-27", 600, 700);
    const allDay = ev("연휴", "2026-09-27", null, null);
    const os = expand([night, plain, allDay], [], "2026-09-28", "2026-09-28");
    expect(os.map((o) => o.key)).toEqual(["마감:2026-09-27"]);
  });

  it("정렬: 날짜, 종일 먼저, 시작, 제목", () => {
    const a = ev("나", "2026-09-29", 600, 660);
    const b = ev("가", "2026-09-29", 600, 660);
    const c = ev("종일", "2026-09-29", null, null);
    const d = ev("이른", "2026-09-28", 1200, 1260);
    const os = expand([a, b, c, d], [], "2026-09-28", "2026-09-29");
    expect(os.map((o) => o.title)).toEqual(["이른", "종일", "가", "나"]);
    expect(os[1]!.all_day).toBe(true);
  });
});
