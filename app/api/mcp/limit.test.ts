import { describe, expect, it } from "vitest";
import { Limiter, LIMIT_PER_MINUTE, WINDOW_MS } from "./limit";

describe("토큰당 한도", () => {
  it("1분에 120번까지, 넘으면 남은 시간을 알려 준다", () => {
    const l = new Limiter();
    const t0 = 1_000_000;
    for (let i = 0; i < LIMIT_PER_MINUTE; i++) expect(l.take("a", t0 + i * 10)).toEqual({ ok: true });
    expect(l.take("a", t0 + 30_000)).toEqual({ ok: false, retryAfterSec: 30 });
    expect(l.take("a", t0 + WINDOW_MS - 1)).toEqual({ ok: false, retryAfterSec: 1 });
    // 창이 지나면 새로 센다
    expect(l.take("a", t0 + WINDOW_MS)).toEqual({ ok: true });
  });

  it("열쇠마다 따로 센다", () => {
    const l = new Limiter(2);
    expect(l.take("a", 0).ok).toBe(true);
    expect(l.take("a", 1).ok).toBe(true);
    expect(l.take("a", 2).ok).toBe(false);
    expect(l.take("b", 2).ok).toBe(true);
  });

  it("기억하는 열쇠 수에 상한이 있다 — 끝난 창부터 버리고, 그래도 가득이면 오래된 것부터", () => {
    const l = new Limiter(5, 1_000, 10);
    for (let i = 0; i < 10; i++) l.take(`old${i}`, i);
    expect(l.size).toBe(10);
    // 창이 끝난 뒤 새 열쇠가 오면 옛 것을 버린다
    l.take("new", 2_000);
    expect(l.size).toBe(1);
    // 창이 안 끝났는데 가득이면 오래된 절반을 버린다
    for (let i = 0; i < 9; i++) l.take(`k${i}`, 2_001 + i);
    expect(l.size).toBe(10);
    l.take("one-more", 2_100);
    expect(l.size).toBeLessThanOrEqual(10);
    expect(l.size).toBeGreaterThan(1);
    // 버려진 열쇠는 새로 세기 시작한다 (막힌 채로 남지 않는다)
    expect(l.take("new", 2_101).ok).toBe(true);
  });
});
