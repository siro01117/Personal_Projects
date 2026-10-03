// 토큰당 요청 한도 (docs/에이전트-연결.md 2장: 1분 120회, 넘으면 429).
// 세는 곳은 이 함수 인스턴스의 메모리다 — 인스턴스가 여럿이면 저마다 따로 세고, 새로 뜨면 0 부터 다시 센다.
// 그래서 정확한 상한이 아니라 "한 클라이언트가 폭주해도 DB 를 끝없이 두드리지 못하게" 하는 둑이다.

export const LIMIT_PER_MINUTE = 120;
export const WINDOW_MS = 60_000;
/** 기억하는 열쇠 수 상한 (틀린 토큰을 마구 보내 메모리를 채우지 못하게) */
export const MAX_KEYS = 5_000;

export type Taken = { ok: true } | { ok: false; retryAfterSec: number };

type Slot = { start: number; count: number };

/** 고정 창: 첫 요청부터 1분 동안 limit 번. 창이 지나면 새로 센다 */
export class Limiter {
  private slots = new Map<string, Slot>();

  constructor(
    readonly limit: number = LIMIT_PER_MINUTE,
    readonly windowMs: number = WINDOW_MS,
    readonly maxKeys: number = MAX_KEYS,
  ) {}

  take(key: string, now: number = Date.now()): Taken {
    let s = this.slots.get(key);
    if (!s || now - s.start >= this.windowMs) {
      if (!s && this.slots.size >= this.maxKeys) this.prune(now);
      s = { start: now, count: 0 };
      this.slots.set(key, s);
    }
    if (s.count >= this.limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((s.start + this.windowMs - now) / 1000)) };
    s.count++;
    return { ok: true };
  }

  /** 끝난 창을 버린다. 그래도 가득이면 오래된 것부터 절반을 버린다 */
  private prune(now: number): void {
    for (const [k, s] of this.slots) if (now - s.start >= this.windowMs) this.slots.delete(k);
    if (this.slots.size < this.maxKeys) return;
    const old = [...this.slots].sort((a, b) => a[1].start - b[1].start).slice(0, Math.ceil(this.slots.size / 2));
    for (const [k] of old) this.slots.delete(k);
  }

  get size(): number {
    return this.slots.size;
  }
}
