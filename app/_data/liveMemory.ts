// 라이브(presence) 흉내 — 확인 모드(`?demo=1`). 같은 탭 안에서만 통한다.
// 표본(samples)은 주인 화면에서 "지금 보는 중 + 블록 위치" 를 보여 주려는 것 — 첫 표본은 몇 초마다 다음 블록으로 옮겨 가 스크롤하는 것처럼 보인다.

import type { LiveData, LiveSession, Presence } from "./types";

export type LiveMemoryOptions = {
  /** 열쇠 → 처음부터 있는 사람들 */
  samples?: Record<string, Presence[]>;
  /** 첫 표본이 블록을 옮겨 가는 간격 (0 이면 안 움직인다) */
  wanderMs?: number;
  /** 첫 표본이 오가는 블록 수 */
  wanderBlocks?: number;
};

export class MemoryLive implements LiveData {
  private readonly joined = new Map<string, Map<string, Presence>>();
  private readonly samples: Record<string, Presence[]>;
  private readonly subs = new Map<string, Set<(people: Presence[] | null) => void>>();
  private readonly wanderMs: number;
  private readonly wanderBlocks: number;

  constructor(opts: LiveMemoryOptions = {}) {
    this.samples = structuredClone(opts.samples ?? {});
    this.wanderMs = opts.wanderMs ?? 0;
    this.wanderBlocks = opts.wanderBlocks ?? 8;
  }

  /** 지금 있는 사람들: 표본 + 들어온 것 (같은 기기면 들어온 것이 이긴다) */
  people(token: string): Presence[] {
    const out = new Map<string, Presence>();
    for (const p of this.samples[token] ?? []) out.set(p.device, p);
    for (const p of this.joined.get(token)?.values() ?? []) out.set(p.device, p);
    return [...out.values()].map((p) => ({ ...p }));
  }

  private emit(token: string): void {
    const list = this.people(token);
    for (const cb of this.subs.get(token) ?? []) cb(list.map((p) => ({ ...p })));
  }

  join(token: string, state: Presence): LiveSession {
    const room = this.joined.get(token) ?? new Map<string, Presence>();
    this.joined.set(token, room);
    room.set(state.device, { ...state });
    this.emit(token);
    return {
      track: (s) => {
        if (!room.has(state.device)) return;
        room.set(state.device, { ...s });
        this.emit(token);
      },
      leave: () => {
        if (!room.delete(state.device)) return;
        this.emit(token);
      },
    };
  }

  watch(token: string, onChange: (people: Presence[] | null) => void): () => void {
    const set = this.subs.get(token) ?? new Set();
    this.subs.set(token, set);
    set.add(onChange);
    onChange(this.people(token));
    const first = this.samples[token]?.[0];
    const timer =
      first && this.wanderMs > 0
        ? setInterval(() => {
            first.block = ((first.block ?? -1) + 1) % this.wanderBlocks;
            this.emit(token);
          }, this.wanderMs)
        : undefined;
    return () => {
      set.delete(onChange);
      if (timer !== undefined) clearInterval(timer);
    };
  }
}
