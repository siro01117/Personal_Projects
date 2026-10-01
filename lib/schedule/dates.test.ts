import { describe, expect, it } from "vitest";
import { addDays, compareDates, dateRange, daysBetween, isDateStr, weekday } from "./dates";

describe("dates", () => {
  it("isDateStr: 모양과 달력", () => {
    expect(isDateStr("2026-10-01")).toBe(true);
    expect(isDateStr("2028-02-29")).toBe(true);
    expect(isDateStr("2026-02-29")).toBe(false);
    expect(isDateStr("2026-13-01")).toBe(false);
    expect(isDateStr("2026-9-1")).toBe(false);
    expect(isDateStr("2026-10-01T00:00")).toBe(false);
    expect(isDateStr(20261001)).toBe(false);
  });
  it("addDays: 달·해 넘김", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-01", 0)).toBe("2026-10-01");
  });
  it("weekday: 1=월 … 7=일", () => {
    expect(weekday("2026-09-28")).toBe(1);
    expect(weekday("2026-10-01")).toBe(4);
    expect(weekday("2026-10-04")).toBe(7);
  });
  it("dateRange · daysBetween · compareDates", () => {
    expect(dateRange("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(dateRange("2026-10-02", "2026-10-01")).toEqual([]);
    expect(daysBetween("2026-09-28", "2026-10-04")).toBe(6);
    expect(daysBetween("2026-10-04", "2026-09-28")).toBe(-6);
    expect(compareDates("2026-09-30", "2026-10-01")).toBe(-1);
    expect(compareDates("2026-10-01", "2026-10-01")).toBe(0);
  });
  it("잘못된 날짜는 던진다", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow("날짜 형식");
    expect(() => weekday("어제")).toThrow("날짜 형식");
  });
});
