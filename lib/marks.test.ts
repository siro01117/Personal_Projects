import { describe, expect, it } from "vitest";
import { marksToMarkdown, splitMarks, stripMarks } from "./marks";

const m = (text: string) => ({ text, mark: true });
const t = (text: string) => ({ text, mark: false });

describe("splitMarks", () => {
  it("강조 없음 → 글 한 조각", () => {
    expect(splitMarks("그냥 글")).toEqual([t("그냥 글")]);
    expect(splitMarks("")).toEqual([]);
  });

  it("강조 여러 개 · 앞뒤 글", () => {
    expect(splitMarks("앞 ==하나== 가운데 ==둘== 끝")).toEqual([t("앞 "), m("하나"), t(" 가운데 "), m("둘"), t(" 끝")]);
    expect(splitMarks("==전부==")).toEqual([m("전부")]);
  });

  it("짝 없는 == 는 글자 그대로", () => {
    expect(splitMarks("a == b")).toEqual([t("a == b")]);
    expect(splitMarks("==a== 그리고 ==b")).toEqual([m("a"), t(" 그리고 ==b")]);
  });

  it("빈 강조는 강조하지 않고 글자 그대로", () => {
    expect(splitMarks("a ==== b")).toEqual([t("a ==== b")]);
    expect(splitMarks("a ==  == b ==c==")).toEqual([t("a ==  == b "), m("c")]);
  });

  it("줄을 넘는 짝은 없다", () => {
    expect(splitMarks("==a\nb== c")).toEqual([t("==a\nb== c")]);
    expect(splitMarks("==a\nb==c==")).toEqual([t("==a\nb"), m("c")]);
  });

  it("중첩 없음 — 가장 가까운 == 가 짝", () => {
    expect(splitMarks("==a ==b== c==")).toEqual([m("a "), t("b"), m(" c")]);
  });

  it("HTML 은 글자 그대로 (해석 안 함)", () => {
    expect(splitMarks("==<b>x</b>==")).toEqual([m("<b>x</b>")]);
  });

  it("조각을 이으면 강조 표시만 빠진 원문", () => {
    for (const s of ["앞 ==하나== 끝", "a == b", "a ==== b", "==a\nb==c=="]) {
      expect(stripMarks(s)).toBe(splitMarks(s).map((p) => p.text).join(""));
    }
    expect(stripMarks("앞 ==하나== 끝")).toBe("앞 하나 끝");
    expect(stripMarks("a == b")).toBe("a == b");
  });
});

describe("marksToMarkdown", () => {
  it("==…== → **…**, 짝 없는 것은 그대로", () => {
    expect(marksToMarkdown("앞 ==하나== 끝 ==b")).toBe("앞 **하나** 끝 ==b");
  });
  it("앞뒤 공백은 ** 바깥으로", () => {
    expect(marksToMarkdown("a== b ==c")).toBe("a **b** c");
  });
});
