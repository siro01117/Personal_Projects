import { describe, expect, it } from "vitest";
import { connectCommand, mcpUrl, tailLabel, TOKEN_SHAPE, tokenNameError } from "./tokens";

const TOKEN = `ezt_${"aB3x".repeat(10)}`;

describe("토큰 규칙", () => {
  it("이름: 앞뒤 공백을 지운 뒤 1~30자, 줄바꿈 · 제어문자 없음", () => {
    expect(tokenNameError("집 노트북")).toBeNull();
    expect(tokenNameError("  집 노트북  ")).toBeNull();
    expect(tokenNameError("가".repeat(30))).toBeNull();
    expect(tokenNameError("")).toBe("이름은 1~30자입니다");
    expect(tokenNameError("   ")).not.toBeNull();
    expect(tokenNameError("가".repeat(31))).not.toBeNull();
    expect(tokenNameError("줄\n바꿈")).not.toBeNull();
    expect(tokenNameError(`줄${String.fromCharCode(0x2028)}바꿈`)).not.toBeNull();
  });

  it("붙여 넣을 명령 한 줄 (설계서 3장 그대로)", () => {
    expect(connectCommand("https://ra-kan.cloud", TOKEN)).toBe(`claude mcp add --transport http ezwork https://ra-kan.cloud/api/mcp --header "Authorization: Bearer ${TOKEN}"`);
    expect(connectCommand("http://localhost:3200/", TOKEN)).toContain(" http://localhost:3200/api/mcp ");
    expect(mcpUrl("https://ra-kan.cloud")).toBe("https://ra-kan.cloud/api/mcp");
  });

  it("토큰 모양 · 끝 4자", () => {
    expect(TOKEN).toMatch(TOKEN_SHAPE);
    expect("ezt_short").not.toMatch(TOKEN_SHAPE);
    expect(tailLabel("a1b2")).toBe("…a1b2");
  });
});
