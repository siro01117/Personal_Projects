// 고치기 도구 줄 (설계서 3장): 단추 네 개 · 아이콘만 · 못 누를 때 disabled. 모양은 globals.css 를 같이 본다.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EditBar, type EditBarProps } from "./EditBar";

const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

const OFF: EditBarProps = { canUp: false, canDown: false, hasSelection: false, onAct: () => {} };

/** [이름, 못 누름] 을 위부터 */
function buttons(props: Partial<EditBarProps> = {}): [string, boolean][] {
  const html = renderToStaticMarkup(<EditBar {...OFF} {...props} />);
  return [...html.matchAll(/<button([^>]*)>/g)].map((m) => [/aria-label="([^"]*)"/.exec(m[1]!)![1]!, /\sdisabled(=|\s|$)/.test(m[1]!)]);
}

describe("고치기 도구 줄", () => {
  it("위부터 휴지통 · 위로 · 아래로 · 완료", () => {
    expect(buttons().map(([name]) => name)).toEqual(["고른 블록 지우기", "위로", "아래로", "완료"]);
  });

  it("못 누를 때만 disabled: 고른 게 없음 · 끝에 닿음. 완료는 늘 눌린다", () => {
    expect(buttons().map(([, off]) => off)).toEqual([true, true, true, false]);
    // 맨 위 블록을 골랐다: 위로는 못 가고 아래로만
    expect(buttons({ hasSelection: true, canDown: true }).map(([, off]) => off)).toEqual([false, true, false, false]);
    expect(buttons({ hasSelection: true, canUp: true, canDown: true }).every(([, off]) => !off)).toBe(true);
  });

  it("아이콘만: 글자 · 개수 표시가 없고, 이름은 title 과 aria-label 로", () => {
    const html = renderToStaticMarkup(<EditBar {...OFF} hasSelection />);
    expect(html.replace(/<[^>]*>/g, "").trim()).toBe("");
    for (const m of html.matchAll(/<button([^>]*)>/g)) {
      const label = /aria-label="([^"]*)"/.exec(m[1]!)![1];
      expect(/title="([^"]*)"/.exec(m[1]!)![1]).toBe(label);
    }
    expect(html.match(/<svg/g)).toHaveLength(4);
  });

  it("모양: 종이 왼쪽에 세로로 따라온다 · 종이색 바탕(검은 바탕 아님) · 단추 44px · 좁으면 오른쪽 아래", () => {
    const bar = /\.edit-bar\{([^}]*)\}/.exec(css)![1]!;
    expect(bar).toContain("position:sticky");
    expect(bar).toContain("flex-direction:column");
    expect(bar).toContain("background:var(--paper)");
    expect(/\.edit-bar button\{([^}]*)\}/.exec(css)![1]).toMatch(/width:44px;height:44px/);
    expect(css).toMatch(/@container doc \(max-width: 1099.98px\)\{\s*\.edit-bar\{position:fixed;[^}]*env\(safe-area-inset-bottom/);
    // 따로 띄우던 휴지통은 없다
    expect(css).not.toContain(".sel-trash");
  });
});
