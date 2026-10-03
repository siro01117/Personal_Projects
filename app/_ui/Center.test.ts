// 내용은 가운데에 (docs/공통.md 1장): 모듈마다 내용 기둥에 최대 폭 + 가운데, 조작 줄은 기둥과 같은 폭 · 같은 왼쪽 선.
// 폰(작업면 760 미만)은 그대로. 모양은 globals.css 를 읽어 본다.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const meetList = readFileSync(new URL("./meet/MeetListView.tsx", import.meta.url), "utf8");

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 선택자 하나(정확히 그 글자)의 선언을 차례로 이어 붙인다 — 같은 선택자가 여러 번 나오면 뒤의 것이 뒤에 */
function decls(sel: string, src = css): string {
  const re = new RegExp(`(?:^|[}\\n])\\s*${esc(sel)}\\{([^}]*)\\}`, "g");
  return [...src.matchAll(re)].map((m) => m[1]).join(";");
}
/** 폰 폭 블록(@container app (max-width: 760px)) 안의 글만 */
const phone = [...css.matchAll(/@container app \(max-width: 760px\)\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");

/** 기둥: 최대 폭 + 좌우 auto */
function column(sel: string, max: number) {
  const d = decls(sel);
  expect(d, sel).toMatch(new RegExp(`max-width:${max}px`));
  expect(d, sel).toMatch(/margin:0 auto/);
}

describe("내용 기둥은 가운데 (공통 1장)", () => {
  it("플래너: 두 열 1,200 · 한 열 760", () => {
    column(".pl-cols", 1200);
    expect(css).not.toMatch(/max-width:1440px/);
    expect(decls(".pl-cols:not(.two)")).toMatch(/max-width:760px/);
  });

  it("작업대: 목록 760 · 집중 960 (이미 가운데)", () => {
    column(".bl-col", 760);
    column(".bf-col", 960);
  });

  it("모임 목록 · 모임 하나 1,040", () => {
    expect(decls(".meet .pl-cols.two,.meet .pl-ctl > .pl-sort")).toMatch(/max-width:1040px/);
    expect(decls(".mt-page .mt-cols")).toMatch(/max-width:1040px/);
  });

  it("일정 설정 720 · 관리 960", () => {
    column(".sset section", 720);
    column(".ad-body section", 960);
    // 세로 흐름(flex column)에서 auto 여백이면 늘어나지 않으므로 폭을 채운 뒤 최대 폭으로 자른다
    expect(decls(".sset section")).toMatch(/width:100%/);
    expect(decls(".ad-body section")).toMatch(/width:100%/);
  });

  it("서랍 탐색기 1,200 · 홈 1,100 — 빈 곳이 작업면 전체에 남도록 여백으로 가운데", () => {
    expect(decls(".explorer")).toMatch(/padding-inline:max\(clamp\(16px,3cqw,56px\),calc\(\(100% - 1200px\) \/ 2\)\)/);
    expect(decls(".explorer")).toMatch(/repeat\(auto-fill,minmax\(132px,1fr\)\)/);
    expect(decls(".home")).toMatch(/padding-inline:max\(clamp\(16px,3cqw,64px\),calc\(\(100% - 1100px\) \/ 2\)\)/);
  });

  it("스크롤 상자는 스크롤바 자리를 양쪽에 둬 좌우 여백이 같다", () => {
    for (const sel of [".pl-list", ".sset", ".ad-body"]) expect(decls(sel), sel).toMatch(/scrollbar-gutter:stable both-edges/);
  });
});

describe("조작 줄은 기둥과 같은 폭 · 같은 왼쪽 선", () => {
  it("플래너 두 단: 목록과 같은 여백 · 같은 스크롤바 자리, 단마다 기둥 폭 + 가운데", () => {
    const pad = "clamp(16px,2.4cqw,40px)";
    expect(decls(".pl-list")).toContain(`padding:20px ${pad} 96px`);
    const ctl = decls(".pl-ctl");
    expect(ctl).toContain(`padding:2px ${pad} 8px`);
    expect(ctl).toMatch(/overflow:hidden/);
    expect(ctl).toMatch(/scrollbar-gutter:stable both-edges/);
    const row = decls(".pl-ctl > .pl-sort");
    expect(row).toMatch(/width:100%/);
    column(".pl-ctl > .pl-sort", 1200);
    expect(decls(".planner:has(.pl-cols:not(.two)) .pl-ctl > .pl-sort")).toMatch(/max-width:760px/);
  });

  it("넓은 화면의 보기 패널이 열리면 그 폭만큼 오른쪽을 비운다", () => {
    const d = decls(".planner:has(> .pl-stage > .pl-dp:not(.float)) > .pl-ctl");
    expect(d).toContain("padding-right:calc(clamp(16px,2.4cqw,40px) + clamp(340px,28cqw,440px))");
    expect(decls(".pl-dp")).toContain("flex:0 0 clamp(340px,28cqw,440px)");
  });

  it("모임 목록의 정렬 줄도 .pl-ctl 안에", () => {
    expect(meetList).toMatch(/<div className="pl-ctl">\s*<div className="pl-sort" role="group" aria-label="정렬">/);
  });
});

describe("폰(작업면 760 미만)은 그대로", () => {
  it("가득 채움 · 원래 여백", () => {
    expect(decls(".pl-list", phone)).toBe("padding:8px 0 96px;scrollbar-gutter:auto");
    expect(decls(".pl-ctl", phone)).toBe("padding-inline:0;overflow:visible;scrollbar-gutter:auto");
    expect(decls(".pl-ctl > .pl-sort", phone)).toBe("padding:0 8px");
    expect(decls(".sset", phone)).toMatch(/padding:16px 16px 72px;scrollbar-gutter:auto/);
    expect(decls(".sset section", phone)).toBe("margin:0");
    expect(decls(".ad-body", phone)).toMatch(/scrollbar-gutter:auto/);
    expect(decls(".explorer", phone)).toMatch(/padding:16px 8px 48px/);
  });
});
