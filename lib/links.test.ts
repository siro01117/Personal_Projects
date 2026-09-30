import { describe, expect, it } from "vitest";
import { drawerPath, looksLikeUrl, parseDrawerLink, webBase } from "./links";

const ID = "d0000000-0000-4000-8000-000000000011";

describe("웹 링크", () => {
  it("경로 모양", () => {
    expect(drawerPath("report", ID)).toBe(`/drawer/r/${ID}`);
    expect(drawerPath("folder", ID)).toBe(`/drawer/f/${ID}`);
    expect(drawerPath("folder", null)).toBe("/drawer");
  });

  it("웹 주소: 끝 슬래시 떼기, 없거나 이상하면 기본값", () => {
    expect(webBase("https://ez.work/")).toBe("https://ez.work");
    expect(webBase(undefined)).toBe("http://localhost:3200");
    expect(webBase("localhost:3200")).toBe("http://localhost:3200");
  });

  it("링크 → 가리키는 것. 호스트·?demo=1·끝 슬래시 무시, 대문자 id 는 소문자로", () => {
    expect(parseDrawerLink(`http://localhost:3200/drawer/r/${ID}`)).toEqual({ kind: "report", id: ID });
    expect(parseDrawerLink(`https://ez.work/drawer/f/${ID.toUpperCase()}/?demo=1`)).toEqual({ kind: "folder", id: ID });
    expect(parseDrawerLink("http://localhost:3200/drawer")).toEqual({ kind: "root" });
    expect(parseDrawerLink("http://localhost:3200/drawer/r/not-uuid")).toBeNull();
    expect(parseDrawerLink(`http://localhost:3200/s/${ID}`)).toBeNull();
    expect(parseDrawerLink(`javascript:/drawer/r/${ID}`)).toBeNull();
    expect(parseDrawerLink("/drawer")).toBeNull();
  });

  it("주소처럼 생겼는지", () => {
    expect(looksLikeUrl(" https://x ")).toBe(true);
    expect(looksLikeUrl("/폴더/보고서")).toBe(false);
  });
});
