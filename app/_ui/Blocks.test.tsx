// 사진 가장자리 테두리: 라이트 테마 + edge=light, 다크 테마 + edge=dark 일 때만 포인트색 2px.
// 블록은 figure 의 data-edge 로 싣고, 테마별 값은 globals.css 토큰(--img-edge-light/-dark)이 정한다 — 둘을 같이 본다.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sampleImage } from "../../lib/fixtures";
import { Blocks } from "./Blocks";

const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

/** 선택자 바로 뒤 { … } 안의 선언 */
function declarations(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector}{`);
  if (at < 0) throw new Error(`없음: ${selector}`);
  const body = css.slice(at + selector.length + 1, css.indexOf("}", at));
  return Object.fromEntries(
    body
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.startsWith("--"))
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  );
}

const THEMES = {
  light: declarations(":root"),
  "dark (시스템)": declarations('@media (prefers-color-scheme: dark){ :root:not([data-theme="light"])'),
  "dark (고름)": declarations(':root[data-theme="dark"]'),
};

/** data-edge 값 → 그 규칙이 쓰는 토큰 */
const RULES = Object.fromEntries([...css.matchAll(/\.b-image\[data-edge="(light|dark)"\] \.img\{border:var\((--[\w-]+)\)\}/g)].map((m) => [m[1]!, m[2]!]));

function border(theme: keyof typeof THEMES, edge: string | undefined): string {
  if (edge === undefined || !RULES[edge]) return "none";
  const v = THEMES[theme][RULES[edge]];
  return v === "0" ? "none" : v!;
}

function figure(edge?: "light" | "dark"): string {
  const html = renderToStaticMarkup(<Blocks blocks={[sampleImage({ ref: undefined, credit: "직접 캡처", ...(edge ? { edge } : {}) })]} />);
  return /<figure[^>]*>/.exec(html)![0];
}

describe("사진 가장자리 테두리", () => {
  it("블록의 edge 가 figure 의 data-edge 로 나간다 (없으면 속성 없음)", () => {
    expect(figure("light")).toContain('data-edge="light"');
    expect(figure("dark")).toContain('data-edge="dark"');
    expect(figure()).not.toContain("data-edge");
  });

  it("라이트/다크 × light/dark/없음", () => {
    const KIWI = "2px solid var(--point)";
    const table = (["light", "dark (시스템)", "dark (고름)"] as const).map((t) => [t, border(t, "light"), border(t, "dark"), border(t, undefined)]);
    expect(table).toEqual([
      ["light", KIWI, "none", "none"],
      ["dark (시스템)", "none", KIWI, "none"],
      ["dark (고름)", "none", KIWI, "none"],
    ]);
    // 포인트색은 테마마다 키위
    for (const t of Object.values(THEMES)) expect(t["--point"]).toMatch(/^#(9be15d|a8e063)$/);
  });

  it("테두리는 사진(.img)에만, 둥근 모서리는 그대로", () => {
    expect(Object.keys(RULES).sort()).toEqual(["dark", "light"]);
    expect(css).toMatch(/\.b-image \.img\{[^}]*border-radius:var\(--r-m\);overflow:hidden/);
  });
});
