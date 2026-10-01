// 캐시 먼저 그리기(stale-while-revalidate)의 규칙: 열쇠 나눔 · 만료 · 버리기 · 새 값 알림 · 쓰기 앞뒤 무효화.

import { describe, expect, it, vi } from "vitest";
import { cachedDrawer, DataCache, DRAWER, evictions, expired, FRESH_MS, KEY, MAX_AGE_MS, MAX_KEYS, peekAll, PREFIX, same, UNREAD_MAX_STALE_MS, type Store } from "./cache";
import { MemoryDrawer } from "./memory";

function fakeStore(): Store & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, add: (ms: number) => (t += ms) };
}

const tickAll = () => new Promise((r) => setTimeout(r, 0));

describe("순수 판단", () => {
  it("만료: 7일이 넘었거나 시계가 거꾸로 간 것", () => {
    expect(expired(0, MAX_AGE_MS)).toBe(false);
    expect(expired(0, MAX_AGE_MS + 1)).toBe(true);
    expect(expired(10 * 60_000, 0)).toBe(true);
    expect(expired(Number.NaN, 0)).toBe(true);
  });

  it("넘치면 오래된 열쇠부터 버린다", () => {
    expect(evictions({ a: 3, b: 1, c: 2 }, 3)).toEqual([]);
    expect(evictions({ a: 3, b: 1, c: 2 }, 1)).toEqual(["b", "c"]);
  });

  it("같은 값 판단은 내용으로", () => {
    expect(same([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(same([{ a: 1 }], [{ a: 2 }])).toBe(false);
  });

  it("주마다 · 폴더마다 열쇠가 다르다", () => {
    expect(KEY.week("2026-09-28")).not.toBe(KEY.week("2026-10-05"));
    expect(KEY.week("2026-09-28").startsWith(KEY.weeks)).toBe(true);
    expect(KEY.list(null)).not.toBe(KEY.list("a"));
    expect(KEY.list("a").startsWith(DRAWER)).toBe(true);
    expect(KEY.tasks.startsWith(DRAWER)).toBe(false);
  });
});

describe("DataCache", () => {
  it("사람(scope)이 정해지기 전에는 담지도 읽지도 않는다", () => {
    const store = fakeStore();
    const c = new DataCache(store);
    c.set("k", 1);
    expect(c.get("k")).toBeUndefined();
    expect(store.map.size).toBe(0);
  });

  it("사람마다 따로 담는다 — 다른 계정과 섞이지 않는다", () => {
    const store = fakeStore();
    const c = new DataCache(store);
    c.setScope("u1");
    c.set("k", "하나");
    c.setScope("u2");
    expect(c.get("k")).toBeUndefined();
    c.set("k", "둘");
    c.setScope("u1");
    expect(c.peek("k")).toBe("하나");
    expect([...store.map.keys()].every((k) => k.startsWith(PREFIX))).toBe(true);
  });

  it("저장소에 남아 새 캐시(새로 고침)에서도 읽힌다. 7일이 지나면 없는 것", () => {
    const store = fakeStore();
    const t = clock();
    new DataCache(store, "u1", t.now).set("k", [1, 2]);
    expect(new DataCache(store, "u1", t.now).peek("k")).toEqual([1, 2]);
    t.add(MAX_AGE_MS + 1);
    expect(new DataCache(store, "u1", t.now).peek("k")).toBeUndefined();
  });

  it("저장소가 없으면(확인 모드) 메모리만", () => {
    const c = new DataCache(null, "demo");
    c.set("k", 1);
    expect(c.peek("k")).toBe(1);
  });

  it("clear(로그아웃)는 이 기기에 담아 둔 것 전부를 지운다. 남의 열쇠는 그대로", () => {
    const store = fakeStore();
    store.setItem("ezwork.theme", "dark");
    const a = new DataCache(store, "u1");
    a.set("k", 1);
    new DataCache(store, "u2").set("k", 2);
    a.clear();
    expect([...store.map.keys()]).toEqual(["ezwork.theme"]);
    expect(a.get("k")).toBeUndefined();
  });

  it("drop 은 머리가 같은 열쇠만 버린다", () => {
    const store = fakeStore();
    const c = new DataCache(store, "u1");
    c.set(KEY.week("2026-09-28"), 1);
    c.set(KEY.week("2026-10-05"), 2);
    c.set(KEY.places, 3);
    c.drop(KEY.weeks);
    expect(c.get(KEY.week("2026-09-28"))).toBeUndefined();
    expect(c.peek(KEY.places)).toBe(3);
    expect(new DataCache(store, "u1").get(KEY.week("2026-10-05"))).toBeUndefined();
  });

  it("열쇠가 상한을 넘으면 오래된 것부터 버린다", () => {
    const t = clock();
    const c = new DataCache(fakeStore(), "u1", t.now);
    for (let i = 0; i <= MAX_KEYS; i++) {
      c.set(`k${i}`, i);
      t.add(1);
    }
    expect(c.get("k0")).toBeUndefined();
    expect(c.peek(`k${MAX_KEYS}`)).toBe(MAX_KEYS);
  });

  it("저장소가 꽉 차도 던지지 않고 메모리에는 둔다", () => {
    const store = fakeStore();
    store.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const c = new DataCache(store, "u1");
    expect(() => c.set("k", 1)).not.toThrow();
    expect(c.peek("k")).toBe(1);
  });

  it("peekAll 은 하나라도 없으면 null (반쪽 화면을 그리지 않는다)", () => {
    const c = new DataCache(null, "u1");
    c.set(KEY.tasks, []);
    expect(peekAll(c, { tasks: KEY.tasks, links: KEY.links })).toBeNull();
    c.set(KEY.links, [1]);
    expect(peekAll(c, { tasks: KEY.tasks, links: KEY.links })).toEqual({ tasks: [], links: [1] });
  });
});

describe("read — 캐시 먼저, 뒤에서 새로", () => {
  it("없으면 읽어서 담는다. 같이 온 물음은 한 번만 읽는다", async () => {
    const c = new DataCache(null, "u1");
    const fetch = vi.fn(async () => [1]);
    const [a, b] = await Promise.all([c.read("k", fetch), c.read("k", fetch)]);
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("방금 읽은 것은 다시 읽지 않는다", async () => {
    const t = clock();
    const c = new DataCache(null, "u1", t.now);
    const fetch = vi.fn(async () => 1);
    await c.read("k", fetch);
    t.add(FRESH_MS);
    await c.read("k", fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("담아 둔 것을 바로 주고 뒤에서 읽는다. 다르면 알리고, 다시 물으면 새 값", async () => {
    const t = clock();
    const c = new DataCache(null, "u1", t.now);
    const seen: string[] = [];
    c.subscribe((k) => seen.push(k));
    let server = "옛";
    const fetch = vi.fn(async () => server);
    await c.read("k", fetch);
    t.add(FRESH_MS + 1);
    server = "새";
    expect(await c.read("k", fetch)).toBe("옛");
    await tickAll();
    expect(seen).toEqual(["k"]);
    expect(await c.read("k", fetch)).toBe("새");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("새로 읽은 값이 같으면 알리지 않는다", async () => {
    const t = clock();
    const c = new DataCache(null, "u1", t.now);
    const cb = vi.fn();
    c.subscribe(cb);
    const fetch = async () => [{ id: 1 }];
    await c.read("k", fetch);
    t.add(FRESH_MS + 1);
    await c.read("k", fetch);
    await tickAll();
    expect(cb).not.toHaveBeenCalled();
  });

  it("maxStale 보다 오래됐으면 기다렸다 새 값을 준다", async () => {
    const t = clock();
    const c = new DataCache(null, "u1", t.now);
    let n = 1;
    const fetch = async () => n;
    await c.read("k", fetch, 1000);
    t.add(5000);
    n = 2;
    expect(await c.read("k", fetch, 1000)).toBe(2);
  });

  it("읽는 사이 버렸으면(쓰기) 그 답은 담지 않는다", async () => {
    const c = new DataCache(null, "u1");
    let release!: (v: string) => void;
    const p = c.read("d:k", () => new Promise<string>((r) => (release = r)));
    c.drop("d:");
    release("쓰기 전 모습");
    expect(await p).toBe("쓰기 전 모습");
    expect(c.get("d:k")).toBeUndefined();
  });

  it("뒤에서 읽다 실패하면 담아 둔 것을 버리고 알린다 — 다시 물을 때 오류가 드러난다", async () => {
    const t = clock();
    const c = new DataCache(null, "u1", t.now);
    const cb = vi.fn();
    c.subscribe(cb);
    await c.read("k", async () => 1);
    t.add(FRESH_MS + 1);
    const boom = async () => {
      throw new Error("로그인 풀림");
    };
    expect(await c.read("k", boom)).toBe(1);
    await tickAll();
    expect(cb).toHaveBeenCalledTimes(1);
    await expect(c.read("k", boom)).rejects.toThrow("로그인 풀림");
  });
});

describe("cachedDrawer", () => {
  const seed = [
    { id: "f1", kind: "folder" as const, name: "폴더" },
    { id: "r1", kind: "report" as const, name: "보고서", parent_id: "f1", agent_updated_at: new Date().toISOString() },
  ];

  function setup() {
    const t = clock(Date.now());
    const raw = new MemoryDrawer(seed);
    const cache = new DataCache(null, "u1", t.now);
    const list = vi.spyOn(raw, "list");
    return { t, raw, cache, list, data: cachedDrawer(raw, cache) };
  }

  it("폴더에 다시 들어가면 담아 둔 목록이 바로 온다 (뒤에서 한 번 더 읽는다)", async () => {
    const { t, data, list } = setup();
    const first = await data.list(null);
    t.add(FRESH_MS + 1);
    const again = await data.list(null);
    expect(again).toEqual(first);
    expect(again).not.toBe(first);
    await tickAll();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("쓰고 난 뒤의 읽기는 서버로 간다 — 옛 목록이 화면을 덮지 않는다", async () => {
    const { data, cache } = setup();
    await data.list(null);
    await data.folders();
    await data.rename("f1", "새 이름");
    expect(cache.get(KEY.list(null))).toBeUndefined();
    expect(cache.get(KEY.folders)).toBeUndefined();
    expect((await data.list(null)).map((e) => e.name)).toEqual(["새 이름"]);
  });

  it("쓰기가 실패해도 캐시는 버린다", async () => {
    const { data, cache } = setup();
    await data.list(null);
    await expect(data.rename("없는-id", "x")).rejects.toBeTruthy();
    expect(cache.get(KEY.list(null))).toBeUndefined();
  });

  it("다른 곳(에이전트)이 바꾼 것은 뒤에서 읽어 알린다. 안 읽음 수는 1분이 넘으면 기다렸다 새 값", async () => {
    const { t, raw, data, cache } = setup();
    const seen: string[] = [];
    cache.subscribe((k) => seen.push(k));
    expect(await data.unreadCount()).toBe(1);
    await raw.markRead("r1");
    t.add(FRESH_MS + 1);
    expect(await data.unreadCount()).toBe(1);
    await tickAll();
    expect(seen).toEqual([KEY.unreadCount]);
    expect(await data.unreadCount()).toBe(0);

    const count = vi.spyOn(raw, "unreadCount").mockResolvedValue(7);
    t.add(UNREAD_MAX_STALE_MS + 1);
    expect(await data.unreadCount()).toBe(7);
    expect(count).toHaveBeenCalledTimes(1);
  });
});
