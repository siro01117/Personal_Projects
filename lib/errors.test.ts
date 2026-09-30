import { describe, expect, it } from "vitest";
import { DbError, loginErrorKorean, toKorean } from "./errors";

describe("toKorean (웹·MCP 공통)", () => {
  it("[EZ_*] 는 DB 가 쓴 한국어를 그대로", () => {
    expect(toKorean(new DbError("[EZ_VERSION] 그 사이 다른 곳에서 고쳤습니다. 새로 불러오세요 (지금 버전 3)", "P0001"))).toEqual({
      code: "EZ_VERSION",
      message: "그 사이 다른 곳에서 고쳤습니다. 새로 불러오세요 (지금 버전 3)",
    });
    expect(toKorean({ code: "P0001", message: "[EZ_DEPTH] 폴더는 8단까지만 넣을 수 있습니다 (옮기면 9단)" }).code).toBe("EZ_DEPTH");
  });

  it("이름 겹침 → NAME_TAKEN", () => {
    expect(toKorean({ code: "23505", message: "duplicate key" }).code).toBe("NAME_TAKEN");
  });

  it("키·세션 거절 문구는 쓰는 곳이 정한다", () => {
    expect(toKorean({ code: "PGRST303", message: "JWT expired" }, { authMessage: "다시 로그인하세요" })).toEqual({
      code: "AUTH",
      message: "다시 로그인하세요",
    });
    expect(toKorean({ code: "42501", message: "permission denied for table ez_items" }).code).toBe("AUTH");
    expect(toKorean({ code: "", message: "Invalid API key" }).message).toBe("Supabase 가 키를 거절했습니다");
  });

  it("브라우저 fetch 실패도 네트워크로", () => {
    expect(toKorean(new TypeError("Failed to fetch")).code).toBe("NETWORK");
    expect(toKorean({ code: "", message: "TypeError: Load failed" }).code).toBe("NETWORK");
  });
});

describe("loginErrorKorean", () => {
  it("틀린 비밀번호 · 인증 안 된 메일 · 너무 많은 시도", () => {
    expect(loginErrorKorean({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe("이메일 또는 비밀번호가 맞지 않습니다");
    expect(loginErrorKorean({ message: "Invalid login credentials" })).toBe("이메일 또는 비밀번호가 맞지 않습니다");
    expect(loginErrorKorean({ code: "email_not_confirmed", message: "Email not confirmed" })).toBe("이메일 인증을 마치지 않은 계정입니다");
    expect(loginErrorKorean({ code: "over_request_rate_limit", message: "Request rate limit reached" })).toContain("잠시 뒤");
  });

  it("네트워크 · 그 밖", () => {
    expect(loginErrorKorean(new TypeError("Failed to fetch"))).toContain("연결하지 못했습니다");
    expect(loginErrorKorean({ message: "boom" })).toBe("로그인하지 못했습니다: boom");
  });
});
