import { describe, expect, it } from "vitest";
import { decide, intent, slideMs, velocity } from "./swipe";

describe("intent", () => {
  it("조금 움직여서는 정하지 않는다", () => {
    expect(intent(5, 3)).toBeNull();
    expect(intent(-7, 7)).toBeNull();
  });
  it("가로가 확실히 크면 가로", () => {
    expect(intent(12, 4)).toBe("x");
    expect(intent(-20, 10)).toBe("x");
  });
  it("세로이거나 대각선이면 세로 (스크롤이 이긴다)", () => {
    expect(intent(3, 12)).toBe("y");
    expect(intent(10, 10)).toBe("y");
    expect(intent(11, 10)).toBe("y");
  });
});

describe("velocity", () => {
  it("표본이 하나 이하면 0", () => {
    expect(velocity([])).toBe(0);
    expect(velocity([{ t: 0, x: 10 }])).toBe(0);
  });
  it("마지막 100ms 만 본다", () => {
    const v = velocity([
      { t: 0, x: 0 },
      { t: 300, x: 0 },
      { t: 350, x: -50 },
      { t: 400, x: -100 },
    ]);
    expect(v).toBeCloseTo(-1);
  });
  it("멈췄다 놓으면 0 에 가깝다", () => {
    const v = velocity([
      { t: 0, x: 0 },
      { t: 50, x: -120 },
      { t: 400, x: -120 },
      { t: 450, x: -120 },
    ]);
    expect(v).toBe(0);
  });
});

describe("decide", () => {
  const W = 360;
  it("폭의 25% 를 넘게 끌면 넘긴다", () => {
    expect(decide(-100, 0, W)).toBe(1);
    expect(decide(100, 0, W)).toBe(-1);
  });
  it("모자라면 제자리", () => {
    expect(decide(-60, 0, W)).toBe(0);
    expect(decide(60, 0.1, W)).toBe(0);
  });
  it("빠르게 튕기면 짧아도 넘긴다", () => {
    expect(decide(-30, -0.6, W)).toBe(1);
    expect(decide(30, 0.6, W)).toBe(-1);
  });
  it("끌린 쪽과 반대로 튕기면 취소", () => {
    expect(decide(-200, 0.6, W)).toBe(0);
    expect(decide(200, -0.6, W)).toBe(0);
  });
  it("폭을 모르면 넘기지 않는다", () => {
    expect(decide(-200, -1, 0)).toBe(0);
  });
});

describe("slideMs", () => {
  it("남은 거리에 비례, 140~240ms", () => {
    expect(slideMs(0, 360)).toBe(140);
    expect(slideMs(360, 360)).toBe(240);
    expect(slideMs(-180, 360)).toBe(190);
    expect(slideMs(900, 360)).toBe(240);
    expect(slideMs(100, 0)).toBe(140);
  });
});
