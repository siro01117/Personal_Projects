import { describe, expect, it } from "vitest";
import { loadEnv, parseEnvFile } from "./env";
import { DbError, toKorean } from "./errors";

describe("toKorean", () => {
  it("[EZ_*] 는 코드를 떼고 설명만, 코드는 따로", () => {
    expect(toKorean(new DbError("[EZ_CYCLE] 폴더를 자기 자신이나 자기 안의 폴더로 옮길 수 없습니다", "P0001"))).toEqual({
      code: "EZ_CYCLE",
      message: "폴더를 자기 자신이나 자기 안의 폴더로 옮길 수 없습니다",
    });
  });

  it("23505 · 23514(크기 · 이름 · 자기 부모 · 기타) · 23503", () => {
    expect(toKorean(new DbError("duplicate key value violates unique constraint", "23505")).message).toBe(
      "같은 폴더에 같은 이름이 이미 있습니다 (대소문자 무시)",
    );
    // PostgREST 는 제약 이름을 message 에 담는다
    const size = { code: "23514", message: 'new row for relation "ez_items" violates check constraint "ez_items_blocks_size_check"' };
    expect(toKorean(size)).toEqual({ code: "TOO_LARGE", message: "보고서가 너무 큽니다 — 블록을 나눠 두 보고서로 넣으세요" });
    expect(toKorean({ code: "23514", message: 'violates check constraint "ez_items_name_check"' }).code).toBe("BAD_NAME");
    expect(toKorean({ code: "23514", message: 'violates check constraint "ez_items_not_self_parent"' }).code).toBe("EZ_CYCLE");
    expect(toKorean({ code: "23514", message: 'violates check constraint "ez_items_fields_check"' }).message).toContain("ez_items_fields_check");
    expect(toKorean({ code: "23503", message: "fk" }).code).toBe("EZ_PARENT");
  });

  it("네트워크 실패", () => {
    const expected = "Supabase 에 연결하지 못했습니다 (네트워크). 잠시 뒤 다시 하세요";
    expect(toKorean(new TypeError("fetch failed")).message).toBe(expected);
    // supabase-js 가 error 로 돌려주는 모양
    expect(toKorean({ code: "", message: "TypeError: fetch failed", details: "" }).message).toBe(expected);
    const withCause = Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } });
    expect(toKorean(withCause).code).toBe("NETWORK");
  });

  it("키 거절 · 그 밖", () => {
    expect(toKorean({ code: "", message: "Invalid API key" }).code).toBe("AUTH");
    expect(toKorean({ code: "XX000", message: "boom" })).toEqual({ code: "XX000", message: "DB 오류: boom" });
  });
});

describe("env", () => {
  it("KEY=VALUE 만, 주석·빈 줄 무시, 따옴표 제거", () => {
    expect(parseEnvFile("# c\n\nA=1\r\nB = \"two\" \nexport C='3'\n잘못된 줄\n")).toEqual({ A: "1", B: "two", C: "3" });
  });

  it("빠진 변수를 한국어로 알린다 (값은 쓰지 않는다)", () => {
    const r = loadEnv({}, "EZ_SUPABASE_URL=https://x.supabase.co\nEZ_SUPABASE_SERVICE_ROLE_KEY=secret-value\n");
    expect("error" in r && r.error).toContain("EZ_OWNER_ID, EZ_AGENT_NAME");
    expect("error" in r && r.error).not.toContain("secret-value");
    const r2 = loadEnv({ EZ_OWNER_ID: "not-uuid", EZ_AGENT_NAME: "Claude Code" }, "EZ_SUPABASE_URL=https://x\nEZ_SUPABASE_SERVICE_ROLE_KEY=k");
    expect("error" in r2 && r2.error).toContain("uuid");
    const ok = loadEnv(
      { EZ_OWNER_ID: "00000000-0000-4000-8000-000000000000", EZ_AGENT_NAME: "Claude Code" },
      "EZ_SUPABASE_URL=https://x\nEZ_SUPABASE_SERVICE_ROLE_KEY=k",
    );
    expect("env" in ok && ok.env.EZ_AGENT_NAME).toBe("Claude Code");
    // EZ_WEB_URL 은 없어도 된다 — 기본값, 끝 슬래시는 뗀다
    expect("env" in ok && ok.env.EZ_WEB_URL).toBe("http://localhost:3200");
    const web = loadEnv(
      { EZ_OWNER_ID: "00000000-0000-4000-8000-000000000000", EZ_AGENT_NAME: "a", EZ_WEB_URL: "https://ez.work/" },
      "EZ_SUPABASE_URL=https://x\nEZ_SUPABASE_SERVICE_ROLE_KEY=k",
    );
    expect("env" in web && web.env.EZ_WEB_URL).toBe("https://ez.work");
  });
});
