// 도움말 내용(lib/help.ts)의 모양과, 적힌 도구 이름이 진짜 도구(mcp/tools.ts)인지 (docs/에이전트-연결.md 4장).

import { describe, expect, it } from "vitest";
import { isWriteTool, TOOL_NAMES } from "../mcp/tools";
import { askText, HELP, helpKeyOf, opsFor, opText, type HelpKey } from "./help";

const KEYS = Object.keys(HELP) as HelpKey[];

describe("도움말 내용", () => {
  it("모듈 여덟: 서랍 · 보고서 · 일정 · 플래너 · 작업대 · 모임 · 회원 · 설정", () => {
    expect(KEYS).toEqual(["drawer", "report", "schedule", "planner", "bench", "meet", "members", "settings"]);
    expect(KEYS.map((k) => HELP[k].title)).toEqual(["보고서 서랍", "보고서", "일정", "플래너", "작업대", "모임", "회원", "에이전트 연결"]);
  });

  it.each(KEYS)("%s: 조작 4~6줄, 에이전트 예시는 3~5개(도구가 없는 모듈은 없음)", (k) => {
    const t = HELP[k];
    expect(t.ops.length).toBeGreaterThanOrEqual(4);
    expect(t.ops.length).toBeLessThanOrEqual(6);
    if (t.tools.length === 0) expect(t.asks).toEqual([]);
    else {
      expect(t.asks.length).toBeGreaterThanOrEqual(3);
      expect(t.asks.length).toBeLessThanOrEqual(5);
    }
    // 겹치는 줄 · 빈 줄 · 앞뒤 공백 없음
    for (const list of [t.ops.map(opText), t.asks, t.tools]) {
      expect(new Set(list).size).toBe(list.length);
      for (const s of list) expect(s).toBe(s.trim());
      expect(list.every((s) => s.length > 0)).toBe(true);
    }
  });

  it("도구 이름은 전부 실제 도구다", () => {
    const real = new Set<string>(TOOL_NAMES);
    for (const k of KEYS) for (const name of HELP[k].tools) expect(real.has(name), `${k}: ${name}`).toBe(true);
  });

  it("도구 15개가 어느 모듈엔가 다 나온다", () => {
    const shown = new Set(KEYS.flatMap((k) => HELP[k].tools));
    expect(TOOL_NAMES.filter((n) => !shown.has(n))).toEqual([]);
  });

  it("도구가 있는 모듈에는 읽는 도구가 하나는 있다 (읽기만 되는 토큰으로도 예시 하나는 된다)", () => {
    for (const k of KEYS) {
      const t = HELP[k];
      if (t.tools.length > 0) expect(t.tools.some((n) => !isWriteTool(n)) || k === "drawer", k).toBe(true);
    }
    expect(HELP.drawer.tools).toContain("drawer_list");
  });

  it("회원 화면에는 에이전트 도구가 없다", () => {
    expect(HELP.members.tools).toEqual([]);
  });
});

describe("폰에서 보일 조작 줄", () => {
  it("키보드 · 마우스로만 되는 줄은 빠진다 — 그래도 모듈마다 세 줄은 남는다", () => {
    for (const k of KEYS) {
      const t = HELP[k];
      const phone = opsFor(t, true);
      expect(opsFor(t, false)).toEqual(t.ops.map(opText));
      expect(phone.length, k).toBeGreaterThanOrEqual(3);
      for (const line of phone) expect(line, `${k}: ${line}`).not.toMatch(/Ctrl|Alt|F2|Space|Tab|Backspace|Delete|← →|↑↓|N = |끌어|끌면/);
    }
    // 폰에서도 다 되는 모듈은 그대로
    for (const k of ["meet", "members", "settings"] as const) expect(opsFor(HELP[k], true)).toEqual(HELP[k].ops);
  });
});

describe("주소 → 모듈", () => {
  it.each([
    ["/drawer", "drawer"],
    ["/drawer/f/abc", "drawer"],
    ["/drawer/trash", "drawer"],
    ["/drawer/r/abc", "report"],
    ["/schedule", "schedule"],
    ["/schedule/settings", "schedule"],
    ["/planner", "planner"],
    ["/planner/bench", "bench"],
    ["/planner/bench/abc", "bench"],
    ["/planner/log", "bench"],
    ["/meet", "meet"],
    ["/meet/abc", "meet"],
    ["/admin", "members"],
    ["/settings/agent", "settings"],
  ] as const)("%s → %s", (path, key) => {
    expect(helpKeyOf(path)).toBe(key);
  });

  it("모듈 화면이 아니면 없다 — 홈 · 로그인 · 공개 페이지", () => {
    for (const p of ["/", "/login", "/s/abcdefghijklmnopqrstuv", "/m/abcdefghijklmnopqrstuv", "/drawerx", "/plannerx"]) expect(helpKeyOf(p)).toBeNull();
  });
});

describe("복사할 글", () => {
  it("보고서는 지금 주소를 붙인다 (확인 모드 표시 · # 은 뺀다)", () => {
    const ask = HELP.report.asks[0]!;
    expect(askText(HELP.report, ask, "https://ra-kan.cloud/drawer/r/abc?demo=1#b3")).toBe(`${ask} — https://ra-kan.cloud/drawer/r/abc`);
    expect(askText(HELP.report, ask, null)).toBe(ask);
    expect(askText(HELP.report, ask, "주소 아님")).toBe(ask);
  });

  it("다른 모듈은 글 그대로", () => {
    const ask = HELP.planner.asks[0]!;
    expect(askText(HELP.planner, ask, "https://ra-kan.cloud/planner")).toBe(ask);
  });
});
