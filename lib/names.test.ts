import { describe, expect, it } from "vitest";
import { copyName, normalizeName, sameName, uniqueName, validateName } from "./names";

describe("validateName", () => {
  it("정상", () => {
    expect(validateName("EZ.WORK 준비")).toBeNull();
    expect(validateName("  앞뒤 공백은 지우고 본다  ")).toBeNull();
    expect(validateName("a")).toBeNull();
    expect(validateName("가".repeat(100))).toBeNull();
    expect(validateName("😀".repeat(100))).toBeNull(); // 코드 포인트로 센다
  });
  it("빈 이름", () => {
    expect(validateName("")).toBe("이름이 비어 있습니다");
    expect(validateName(" \t\u3000")).toBe("이름이 비어 있습니다");
  });
  it("100자 초과", () => {
    expect(validateName("가".repeat(101))).toBe("이름은 100자까지 쓸 수 있습니다 (지금 101자)");
  });
  it(". 과 .. 금지 (앞뒤 공백 지운 뒤), 다른 점 이름은 된다", () => {
    expect(validateName(".")).toBe("이름으로 . 이나 .. 는 쓸 수 없습니다");
    expect(validateName(" .. ")).toBe("이름으로 . 이나 .. 는 쓸 수 없습니다");
    expect(validateName("...")).toBeNull();
    expect(validateName(".hidden")).toBeNull();
  });
  it("/ 금지", () => {
    expect(validateName("a/b")).toBe("이름에 / 는 쓸 수 없습니다");
  });
  it("줄바꿈·제어 문자 금지", () => {
    for (const s of ["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u001fb", "a\u007fb", "a\u0085b", "a\u2028b"]) {
      expect(validateName(s), JSON.stringify(s)).toBe("이름에 줄바꿈이나 제어 문자는 쓸 수 없습니다");
    }
  });
});

describe("normalizeName · sameName", () => {
  it("앞뒤 공백 제거", () => {
    expect(normalizeName("  a b  ")).toBe("a b");
    expect(normalizeName("\u3000가\u00a0")).toBe("가");
  });
  it("대소문자·앞뒤 공백 무시", () => {
    expect(sameName("Report", " report ")).toBe(true);
    expect(sameName("보고서", "보고서 ")).toBe(true);
    expect(sameName("a b", "ab")).toBe(false);
  });
});

describe("copyName", () => {
  it("안 겹치면 그대로 (다른 폴더에 붙여 넣을 때)", () => {
    expect(copyName("보고서", ["다른 것"])).toBe("보고서");
    expect(copyName(" 보고서 ", [])).toBe("보고서");
  });
  it("겹치면 - 복사본, 그것도 겹치면 - 복사본 (2), (3) …", () => {
    expect(copyName("보고서", ["보고서"])).toBe("보고서 - 복사본");
    expect(copyName("보고서", ["보고서", "보고서 - 복사본"])).toBe("보고서 - 복사본 (2)");
    expect(copyName("보고서", ["보고서", "보고서 - 복사본", "보고서 - 복사본 (2)"])).toBe("보고서 - 복사본 (3)");
    expect(copyName("보고서", ["보고서", "보고서 - 복사본 (2)"])).toBe("보고서 - 복사본");
  });
  it("대소문자 무시, 복사본의 복사본", () => {
    expect(copyName("Report", ["report", "REPORT - 복사본"])).toBe("Report - 복사본 (2)");
    expect(copyName("보고서 - 복사본", ["보고서 - 복사본"])).toBe("보고서 - 복사본 - 복사본");
  });
  it("100자를 넘지 않게 앞부분을 자른다", () => {
    const long = "가".repeat(100);
    expect(copyName(long, [long])).toBe("가".repeat(94) + " - 복사본");
    const two = copyName(long, [long, "가".repeat(94) + " - 복사본"]);
    expect(two).toBe("가".repeat(90) + " - 복사본 (2)");
    expect(validateName(two)).toBeNull();
  });
});

describe("uniqueName", () => {
  it("안 겹치면 그대로(공백만 정리)", () => {
    expect(uniqueName(" 새 폴더 ", ["다른 폴더"])).toBe("새 폴더");
    expect(uniqueName("새 폴더", [])).toBe("새 폴더");
  });
  it("겹치면 (2), (3) …", () => {
    expect(uniqueName("새 폴더", ["새 폴더"])).toBe("새 폴더 (2)");
    expect(uniqueName("새 폴더", ["새 폴더", "새 폴더 (2)"])).toBe("새 폴더 (3)");
    expect(uniqueName("새 폴더", ["새 폴더", "새 폴더 (3)"])).toBe("새 폴더 (2)");
  });
  it("대소문자·앞뒤 공백 무시하고 비교", () => {
    expect(uniqueName("Report", [" report "])).toBe("Report (2)");
    expect(uniqueName("Report", ["report", "REPORT (2)"])).toBe("Report (3)");
  });
  it("이미 (2) 꼴이면 이어간다", () => {
    expect(uniqueName("이름 (2)", ["이름 (2)"])).toBe("이름 (3)");
    expect(uniqueName("이름 (2)", ["이름 (2)", "이름 (3)"])).toBe("이름 (4)");
    expect(uniqueName("이름 (9)", ["이름 (9)"])).toBe("이름 (10)");
    expect(uniqueName("이름 (1)", ["이름 (1)"])).toBe("이름 (2)");
    expect(uniqueName("이름 (2)", [])).toBe("이름 (2)");
  });
  it("괄호가 접미사 꼴이 아니면 통째로 이름으로 본다", () => {
    expect(uniqueName("이름(2)", ["이름(2)"])).toBe("이름(2) (2)");
    expect(uniqueName("이름 (a)", ["이름 (a)"])).toBe("이름 (a) (2)");
  });
  it("100자를 넘지 않게 앞부분을 자른다", () => {
    const long = "가".repeat(100);
    const got = uniqueName(long, [long]);
    expect(got).toBe("가".repeat(96) + " (2)");
    expect(validateName(got)).toBeNull();
  });
});
