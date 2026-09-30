import { describe, expect, it } from "vitest";
import { formatPath, parsePath, PathError } from "./paths";

describe("parsePath · formatPath", () => {
  it("정상", () => {
    expect(parsePath("/")).toEqual([]);
    expect(parsePath("/a/b")).toEqual(["a", "b"]);
    expect(parsePath("/a/b/")).toEqual(["a", "b"]);
    expect(parsePath("/EZ.WORK 준비/APPTIVE")).toEqual(["EZ.WORK 준비", "APPTIVE"]);
    expect(parsePath("/ a /b")).toEqual(["a", "b"]);
    expect(parsePath("/.hidden/a.b")).toEqual([".hidden", "a.b"]);
  });
  it("거절", () => {
    const bad: [string, string][] = [
      ["", "경로는 / 로 시작해야 합니다 (예: /폴더/보고서)"],
      ["a/b", "경로는 / 로 시작해야 합니다 (예: /폴더/보고서)"],
      ["//", "경로 1번째 조각이 비어 있습니다 (// 는 쓸 수 없습니다)"],
      ["/a//b", "경로 2번째 조각이 비어 있습니다 (// 는 쓸 수 없습니다)"],
      ["/a/ /b", "경로 2번째 조각이 비어 있습니다 (// 는 쓸 수 없습니다)"],
      ["/a/b//", "경로 3번째 조각이 비어 있습니다 (// 는 쓸 수 없습니다)"],
      ["/./a", "경로에 . 는 쓸 수 없습니다"],
      ["/a/..", "경로에 .. 는 쓸 수 없습니다"],
      ["/a\nb", "경로 1번째 조각: 이름에 줄바꿈이나 제어 문자는 쓸 수 없습니다"],
      [`/${"가".repeat(101)}`, "경로 1번째 조각: 이름은 100자까지 쓸 수 있습니다 (지금 101자)"],
    ];
    for (const [input, message] of bad) {
      expect(() => parsePath(input), JSON.stringify(input)).toThrow(new PathError(message));
    }
  });
  it("PathError", () => {
    expect(() => parsePath("x")).toThrow(PathError);
  });
  it("formatPath", () => {
    expect(formatPath([])).toBe("/");
    expect(formatPath(["a", "b"])).toBe("/a/b");
    expect(parsePath(formatPath(["EZ.WORK 준비", "APPTIVE"]))).toEqual(["EZ.WORK 준비", "APPTIVE"]);
  });
});
