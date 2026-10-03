import { describe, expect, it } from "vitest";
import {
  linkError,
  loginEmail,
  loginIdOf,
  moduleKeyFrom,
  newMemberError,
  pickable,
  shownModules,
  togglePicked,
  usable,
  type Me,
  type ModuleRow,
} from "./members";

const mod = (key: string, sort: number): ModuleRow => ({ key, name: key, kind: "link", href: `https://${key}.example.com`, sort });
const me = (extra: Partial<Me> = {}): Me => ({
  role: "member",
  name: "회원",
  active: true,
  allowed: ["a", "b"],
  picked: ["b"],
  modules: [mod("a", 1), mod("b", 2)],
  ...extra,
});

describe("로그인 칸", () => {
  it("@ 가 없으면 아이디 → <아이디>@members.ra-kan.cloud (소문자, 앞뒤 공백 무시)", () => {
    expect(loginEmail("minseo")).toBe("minseo@members.ra-kan.cloud");
    expect(loginEmail("  MinSeo ")).toBe("minseo@members.ra-kan.cloud");
    expect(loginEmail("kim.min-seo_1")).toBe("kim.min-seo_1@members.ra-kan.cloud");
  });

  it("@ 가 있으면 이메일 그대로", () => {
    expect(loginEmail(" owner@example.com ")).toBe("owner@example.com");
  });

  it("회원 이메일에서 아이디", () => {
    expect(loginIdOf("minseo@members.ra-kan.cloud")).toBe("minseo");
    expect(loginIdOf("owner@example.com")).toBeNull();
    expect(loginIdOf(null)).toBeNull();
  });
});

describe("보이는 추가 모듈", () => {
  it("사이드바 · 홈: 켠 것 ∩ 허용된 것, sort 순", () => {
    expect(shownModules(me({ picked: ["b", "a", "x"] })).map((m) => m.key)).toEqual(["a", "b"]);
    expect(shownModules(me({ allowed: ["a"], picked: ["a", "b"] })).map((m) => m.key)).toEqual(["a"]);
    expect(shownModules(me({ picked: [] }))).toEqual([]);
    expect(shownModules(null)).toEqual([]);
  });

  it("꺼진 회원 · none 은 아무것도 없다", () => {
    expect(shownModules(me({ active: false }))).toEqual([]);
    expect(pickable(me({ role: "none" }))).toEqual([]);
    expect(usable(me({ active: false }))).toBe(false);
    expect(usable(me({ role: "admin", active: true }))).toBe(true);
  });

  it("선택창: 허용된 모듈 전부", () => {
    expect(pickable(me({ allowed: ["b"] })).map((m) => m.key)).toEqual(["b"]);
  });

  it("켜기 · 끄기: 허용 밖의 옛 키는 뺀다", () => {
    expect(togglePicked(me({ picked: ["b", "gone"] }), "a", true)).toEqual(["b", "a"]);
    expect(togglePicked(me({ picked: ["b", "a"] }), "b", false)).toEqual(["a"]);
  });
});

describe("규칙", () => {
  it("회원 추가 칸", () => {
    const ok = { login_id: "minseo", password: "12345678", name: "김민서", allowed: ["study"] };
    expect(newMemberError(ok)).toBeNull();
    expect(newMemberError({ ...ok, login_id: "Min" })).toMatch(/아이디/);
    expect(newMemberError({ ...ok, password: "1234567" })).toMatch(/8자/);
    expect(newMemberError({ ...ok, password: "가".repeat(30) })).toMatch(/72바이트/);
    expect(newMemberError({ ...ok, name: " 김" })).toMatch(/이름/);
    expect(newMemberError({ ...ok, name: "가".repeat(21) })).toMatch(/이름/);
    expect(newMemberError({ ...ok, allowed: ["ab", "ab"] })).toMatch(/모듈/);
  });

  it("링크 주소는 https 만", () => {
    expect(linkError("https://example.com/a?b=1")).toBeNull();
    for (const bad of ["http://example.com", "javascript:alert(1)", "https://", "https://a b.com", "https://u@x.com", `https://x.com/${"a".repeat(500)}`]) {
      expect(linkError(bad), bad).not.toBeNull();
    }
  });

  it("모듈 키: 영문 · 숫자 이름은 줄여서, 아니면 m- + 6자, 겹치면 -2", () => {
    expect(moduleKeyFrom("Team Wiki")).toBe("team-wiki");
    expect(moduleKeyFrom("Study 2026")).toBe("study-2026");
    expect(moduleKeyFrom("학습 페이지", [], () => "abc123")).toBe("m-abc123");
    expect(moduleKeyFrom("A", [], () => "zzzzzz")).toBe("m-zzzzzz");
    expect(moduleKeyFrom("wiki", ["wiki", "wiki-2"])).toBe("wiki-3");
    expect(moduleKeyFrom("x".repeat(40))).toMatch(/^[a-z0-9-]{2,30}$/);
    expect(moduleKeyFrom("학습")).toMatch(/^m-[a-z0-9]{6}$/);
  });
});
