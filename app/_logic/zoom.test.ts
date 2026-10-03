import { describe, expect, it } from "vitest";
import { BASE_WIDTH, ZOOM_MAX, ZOOM_SCRIPT, rectToCss, toCss, toScreen, zoom, zoomFor } from "./zoom";

describe("zoomFor", () => {
  it("1,920 이하는 그대로", () => {
    expect(zoomFor(1920)).toBe(1);
    expect(zoomFor(1440)).toBe(1);
    expect(zoomFor(390)).toBe(1);
    expect(zoomFor(0)).toBe(1);
    expect(zoomFor(Number.NaN)).toBe(1);
  });
  it("넓으면 폭에 비례", () => {
    expect(zoomFor(2560)).toBeCloseTo(1.3333, 4);
    expect(zoomFor(2880)).toBe(1.5);
    expect(zoomFor(1921)).toBeCloseTo(1921 / 1920, 10);
  });
  it("상한 2", () => {
    expect(zoomFor(3840)).toBe(2);
    expect(zoomFor(5120)).toBe(2);
    expect(ZOOM_MAX).toBe(2);
  });
  it("확대한 뒤의 배치 폭은 1,920", () => {
    for (const w of [1921, 2048, 2560, 3440, 3840]) expect(w / zoomFor(w)).toBeCloseTo(BASE_WIDTH, 6);
  });
});

describe("좌표 변환", () => {
  it("화면 px ↔ CSS px", () => {
    const z = 2560 / 1920;
    expect(toCss(133.3333, z)).toBeCloseTo(100, 3);
    expect(toScreen(100, z)).toBeCloseTo(133.3333, 3);
    expect(toCss(toScreen(417, z), z)).toBeCloseTo(417, 9);
  });
  it("배율 1 이면 그대로 (값이 조금도 바뀌지 않는다)", () => {
    expect(toCss(417.25, 1)).toBe(417.25);
    expect(toScreen(417.25, 1)).toBe(417.25);
  });
  it("rect 는 여섯 값 모두", () => {
    expect(rectToCss({ left: 400, top: 200, right: 800, bottom: 300, width: 400, height: 100 }, 2)).toEqual({ left: 200, top: 100, right: 400, bottom: 150, width: 200, height: 50 });
  });
  it("문서가 없으면(서버) 1", () => {
    expect(zoom()).toBe(1);
    expect(toCss(50)).toBe(50);
  });
});

describe("ZOOM_SCRIPT", () => {
  /** 스크립트를 가짜 창에서 돌린다 */
  function run(width: number) {
    const props = new Map<string, string>();
    const style = { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) };
    const listeners: (() => void)[] = [];
    const window = { innerWidth: width, addEventListener: (_: string, f: () => void) => void listeners.push(f) };
    new Function("document", "window", ZOOM_SCRIPT)({ documentElement: { style } }, window);
    return { props, resize: (w: number) => ((window.innerWidth = w), listeners.forEach((f) => f())) };
  }

  it("zoomFor 와 같은 값을 zoom · --zoom 에 넣는다", () => {
    for (const w of [1921, 2560, 3000, 3840, 5000]) {
      const { props } = run(w);
      expect(Number(props.get("zoom"))).toBe(zoomFor(w));
      expect(props.get("--zoom")).toBe(props.get("zoom"));
    }
  });
  it("1,920 이하는 아무것도 넣지 않는다", () => {
    for (const w of [390, 1440, 1920]) expect(run(w).props.size).toBe(0);
  });
  it("창 크기가 바뀌면 다시 넣고, 좁아지면 지운다", () => {
    const s = run(1920);
    s.resize(2560);
    expect(Number(s.props.get("--zoom"))).toBe(zoomFor(2560));
    s.resize(1600);
    expect(s.props.size).toBe(0);
  });
});
