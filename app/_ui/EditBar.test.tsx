// 고치기 도구 줄 (설계서 3장): 단추 여섯 개 · 아이콘만 · 못 누를 때 disabled. 모양은 globals.css 를 같이 본다.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EditBar, type EditBarProps } from "./EditBar";

const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

const OFF: EditBarProps = { canUndo: false, allSelected: false, canUp: false, canDown: false, hasSelection: false, onAct: () => {} };

/** [이름, 못 누름] 을 왼쪽부터 */
function buttons(props: Partial<EditBarProps> = {}): [string, boolean][] {
  const html = renderToStaticMarkup(<EditBar {...OFF} {...props} />);
  return [...html.matchAll(/<button([^>]*)>/g)].map((m) => [/aria-label="([^"]*)"/.exec(m[1]!)![1]!, /\sdisabled(=|\s|$)/.test(m[1]!)]);
}

describe("고치기 도구 줄", () => {
  it("왼쪽부터 되돌리기 · 전부 고르기 · 위로 · 아래로 · 휴지통 · 완료", () => {
    expect(buttons().map(([name]) => name)).toEqual(["되돌리기", "전부 고르기", "위로", "아래로", "고른 블록 지우기", "완료"]);
  });

  it("못 누를 때만 disabled: 되돌릴 게 없음 · 고른 게 없음 · 끝에 닿음. 전부 고르기와 완료는 늘 눌린다", () => {
    expect(buttons().map(([, off]) => off)).toEqual([true, false, true, true, true, false]);
    expect(buttons({ canUndo: true }).map(([, off]) => off)).toEqual([false, false, true, true, true, false]);
    // 맨 위 블록을 골랐다: 위로는 못 가고 아래로만
    expect(buttons({ hasSelection: true, canDown: true }).map(([, off]) => off)).toEqual([true, false, true, false, false, false]);
    expect(buttons({ canUndo: true, hasSelection: true, canUp: true, canDown: true }).every(([, off]) => !off)).toBe(true);
  });

  it("전부 골라져 있으면 전부 고르기가 풀기로 바뀐다", () => {
    expect(buttons({ allSelected: true, hasSelection: true })[1]![0]).toBe("고르기 풀기");
  });

  it("아이콘만: 글자 · 개수 표시가 없고, 이름은 title 과 aria-label 로", () => {
    const html = renderToStaticMarkup(<EditBar {...OFF} allSelected hasSelection canUndo />);
    expect(html.replace(/<[^>]*>/g, "").trim()).toBe("");
    for (const m of html.matchAll(/<button([^>]*)>/g)) {
      const label = /aria-label="([^"]*)"/.exec(m[1]!)![1];
      expect(/title="([^"]*)"/.exec(m[1]!)![1]).toBe(label);
    }
    expect(html.match(/<svg/g)).toHaveLength(6);
  });

  it("모양: 종이색 바탕(검은 바탕 아님) · 안전 영역 위 · 단추 44px · 알림은 도구 줄 위", () => {
    const bar = /\.edit-bar\{([^}]*)\}/.exec(css)![1]!;
    expect(bar).toContain("position:fixed");
    expect(bar).toContain("background:var(--paper)");
    expect(bar).toContain("env(safe-area-inset-bottom");
    expect(/\.edit-bar button\{([^}]*)\}/.exec(css)![1]).toMatch(/width:44px;height:44px/);
    // 여섯 단추 + 틈 + 안쪽 여백이 폰 폭 390 에 한 줄로 들어간다
    expect(6 * 44 + 5 * 2 + 4 + 2 * 4 + 2).toBeLessThanOrEqual(390 - 16);
    expect(css).toMatch(/body:has\(\.edit-bar[^)]*\)[^{]*\.toast\{bottom:/);
    // 따로 띄우던 휴지통은 없다
    expect(css).not.toContain(".sel-trash");
  });
});
