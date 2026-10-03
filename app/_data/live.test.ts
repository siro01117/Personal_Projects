// 라이브(presence): 남이 올린 상태를 읽는 검사(liveSupabase) 와 확인 모드 흉내(liveMemory).

import { describe, expect, it } from "vitest";
import { MemoryLive } from "./liveMemory";
import { flattenPresence, readPresence } from "./liveSupabase";
import type { Presence } from "./types";

const DEV = "device-000000000000001";

describe("남이 올린 상태 읽기", () => {
  it("모양이 맞는 것만: 기기 22자 · 라벨 글자 · 블록은 0 이상 정수 아니면 null", () => {
    expect(readPresence({ device: DEV, label: "민서", block: 3 })).toEqual({ device: DEV, label: "민서", block: 3 });
    expect(readPresence({ device: DEV, label: " 게스트 2 ", block: null })).toEqual({ device: DEV, label: "게스트 2", block: null });
    expect(readPresence({ device: DEV, label: "x", block: -1 })).toEqual({ device: DEV, label: "x", block: null });
    expect(readPresence({ device: DEV, label: "x", block: 1.5 })).toEqual({ device: DEV, label: "x", block: null });
    expect(readPresence({ device: DEV, label: "x", block: "2" })).toEqual({ device: DEV, label: "x", block: null });
    expect(readPresence({ device: DEV, label: "x", block: 99_999 })).toEqual({ device: DEV, label: "x", block: null });
    expect(readPresence({ device: "short", label: "x", block: 0 })).toBeNull();
    expect(readPresence({ device: DEV, label: "", block: 0 })).toBeNull();
    expect(readPresence({ device: DEV, label: 7, block: 0 })).toBeNull();
    expect(readPresence(null)).toBeNull();
    expect(readPresence("글자")).toBeNull();
  });

  it("긴 라벨은 24자로 자른다 (글자로만 그리니 그 밖의 검사는 없다)", () => {
    const long = "가".repeat(100);
    expect(readPresence({ device: DEV, label: long, block: 0 })!.label).toBe("가".repeat(24));
    expect(readPresence({ device: DEV, label: "<b>굵게</b>", block: 0 })!.label).toBe("<b>굵게</b>");
  });

  it("presenceState → 기기마다 하나 (같은 기기의 두 탭이면 마지막 것). 모양이 다른 것은 뺀다", () => {
    const state = {
      k1: [{ presence_ref: "a", device: DEV, label: "민서", block: 1 }, { presence_ref: "b", device: DEV, label: "민서", block: 4 }],
      k2: [{ presence_ref: "c", device: "device-000000000000002", label: "게스트 2", block: null }],
      k3: [{ presence_ref: "d", junk: true }],
    };
    expect(flattenPresence(state)).toEqual([
      { device: DEV, label: "민서", block: 4 },
      { device: "device-000000000000002", label: "게스트 2", block: null },
    ]);
    expect(flattenPresence({})).toEqual([]);
  });
});

describe("확인 모드 흉내", () => {
  const sample: Presence = { device: "device-000000000000009", label: "게스트 9", block: 2 };

  it("듣는 쪽은 바로 지금 사람들을 받고, 들어오고 · 옮기고 · 나가면 다시 받는다", () => {
    const live = new MemoryLive({ samples: { tok: [sample] } });
    const got: (Presence[] | null)[] = [];
    const off = live.watch("tok", (p) => got.push(p));
    expect(got).toEqual([[sample]]);
    const s = live.join("tok", { device: DEV, label: "민서", block: 0 });
    expect(got.at(-1)).toEqual([sample, { device: DEV, label: "민서", block: 0 }]);
    s.track({ device: DEV, label: "민서", block: 3 });
    expect(got.at(-1)).toEqual([sample, { device: DEV, label: "민서", block: 3 }]);
    s.leave();
    expect(got.at(-1)).toEqual([sample]);
    s.leave();
    s.track({ device: DEV, label: "민서", block: 5 });
    expect(got).toHaveLength(4);
    off();
    live.join("tok", { device: DEV, label: "민서", block: 0 });
    expect(got).toHaveLength(4);
    // 다른 열쇠는 따로
    expect(live.people("other")).toEqual([]);
  });

  it("받은 목록을 고쳐도 안이 바뀌지 않는다", () => {
    const live = new MemoryLive({ samples: { tok: [sample] } });
    const got = live.people("tok");
    got[0]!.label = "바꿈";
    expect(live.people("tok")[0]!.label).toBe("게스트 9");
  });
});
