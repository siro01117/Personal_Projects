// 마지막으로 읽은 데이터를 잠깐 들고 있다가 먼저 그리게 해 주는 작은 캐시 (stale-while-revalidate).
// 메모리(Map) + 기기 저장소(localStorage). 열쇠는 사람(scope)마다 나뉘고, 로그아웃하면 전부 지운다.
// 확인 모드(?demo=1)는 저장소 없이 메모리만 쓰고 scope 가 달라 진짜 데이터와 섞이지 않는다.
// 여기 담는 것은 서버에서 읽은 그대로만 — 낙관적으로 바꾼 화면 상태는 담지 않는다.

import type { DrawerData } from "./types";

/** 저장소에서 쓰는 것만 (시험에서는 가짜를 넣는다) */
export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export type Hit<T> = { v: T; at: number };

/** 저장소 열쇠 머리. 모양을 바꾸면 숫자를 올린다 (옛 것은 안 읽힌다) */
export const PREFIX = "ezc1:";
/** 이보다 오래된 것은 없는 것으로 친다 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 방금 읽은 것 — 이 안에는 다시 읽지 않는다 (같은 것을 연달아 묻는 화면들) */
export const FRESH_MS = 3_000;
/** 사람 하나에 담는 열쇠 수. 넘으면 오래된 것부터 버린다 */
export const MAX_KEYS = 60;
/** 값 하나의 글자 수 상한 — 넘으면 저장소에는 안 넣는다 (메모리에는 둔다) */
export const MAX_CHARS = 1_500_000;

const INDEX = "#index";

/** 값이 같은지 (서버에서 온 JSON 끼리) */
export function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** 만료 판단 */
export function expired(at: number, now: number, maxAge: number = MAX_AGE_MS): boolean {
  return !(now - at <= maxAge) || at > now + 60_000;
}

/** 넘치는 만큼 오래된 열쇠부터 */
export function evictions(index: Readonly<Record<string, number>>, max: number = MAX_KEYS): string[] {
  const keys = Object.keys(index);
  if (keys.length <= max) return [];
  return keys.sort((a, b) => index[a]! - index[b]!).slice(0, keys.length - max);
}

export function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export class DataCache {
  private mem = new Map<string, Hit<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();
  private subs = new Set<(key: string) => void>();
  /** 지울 때마다 오른다 — 그 전에 떠난 읽기의 답은 담지 않는다 */
  private gen = 0;
  private index: Record<string, number> = {};

  constructor(
    private readonly store: Store | null,
    private scope: string | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (scope !== null) this.index = this.readIndex();
  }

  /** 누구의 것인지 (로그인한 사람 id). 바뀌면 메모리를 비운다. null 이면 아무것도 담지 않는다 */
  setScope(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.mem.clear();
    this.inflight.clear();
    this.gen++;
    this.index = scope === null ? {} : this.readIndex();
  }

  private sk(key: string): string {
    return `${PREFIX}${this.scope}:${key}`;
  }

  private readIndex(): Record<string, number> {
    try {
      const raw = this.store?.getItem(this.sk(INDEX));
      const v: unknown = raw ? JSON.parse(raw) : {};
      return v && typeof v === "object" ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  private writeIndex(): void {
    try {
      this.store?.setItem(this.sk(INDEX), JSON.stringify(this.index));
    } catch {
      /* 못 써도 메모리는 맞다 */
    }
  }

  get<T>(key: string): Hit<T> | undefined {
    if (this.scope === null) return undefined;
    let hit = this.mem.get(key) as Hit<T> | undefined;
    if (!hit && this.store) {
      try {
        const raw = this.store.getItem(this.sk(key));
        const parsed = raw ? (JSON.parse(raw) as Hit<T>) : undefined;
        if (parsed && typeof parsed.at === "number" && "v" in parsed) {
          hit = parsed;
          this.mem.set(key, hit);
        }
      } catch {
        hit = undefined;
      }
    }
    if (!hit) return undefined;
    if (expired(hit.at, this.now())) {
      this.remove(key);
      return undefined;
    }
    return hit;
  }

  /** 값만 */
  peek<T>(key: string): T | undefined {
    return this.get<T>(key)?.v;
  }

  set<T>(key: string, v: T): void {
    if (this.scope === null) return;
    const hit: Hit<T> = { v, at: this.now() };
    this.mem.set(key, hit);
    this.index[key] = hit.at;
    for (const old of evictions(this.index)) this.remove(old);
    if (!this.store) return;
    let text: string;
    try {
      text = JSON.stringify(hit);
    } catch {
      return;
    }
    if (text.length > MAX_CHARS) {
      try {
        this.store.removeItem(this.sk(key));
      } catch {
        /* 그대로 둔다 */
      }
      return;
    }
    try {
      this.store.setItem(this.sk(key), text);
    } catch {
      // 자리가 없다 — 우리 것을 비우고 한 번 더
      this.wipeStore();
      this.index = { [key]: hit.at };
      try {
        this.store.setItem(this.sk(key), text);
      } catch {
        /* 메모리에만 둔다 */
      }
    }
    this.writeIndex();
  }

  private remove(key: string): void {
    this.mem.delete(key);
    delete this.index[key];
    try {
      this.store?.removeItem(this.sk(key));
    } catch {
      /* 그대로 둔다 */
    }
  }

  /** prefix 로 시작하는 열쇠를 버린다 (쓰기 앞뒤). 그 전에 떠난 읽기의 답도 담기지 않는다 */
  drop(prefix: string): void {
    this.gen++;
    for (const k of [...this.inflight.keys()]) if (k.startsWith(prefix)) this.inflight.delete(k);
    if (this.scope === null) return;
    const keys = new Set([...this.mem.keys(), ...Object.keys(this.index)]);
    let any = false;
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      this.remove(k);
      any = true;
    }
    if (any) this.writeIndex();
  }

  private wipeStore(): void {
    if (!this.store) return;
    try {
      const mine: string[] = [];
      for (let i = 0; i < this.store.length; i++) {
        const k = this.store.key(i);
        if (k?.startsWith(PREFIX)) mine.push(k);
      }
      for (const k of mine) this.store.removeItem(k);
    } catch {
      /* 그대로 둔다 */
    }
  }

  /** 로그아웃: 이 기기에 담아 둔 것 전부 (다른 사람 것 포함) */
  clear(): void {
    this.gen++;
    this.mem.clear();
    this.inflight.clear();
    this.index = {};
    this.wipeStore();
  }

  /** 뒤에서 새로 읽은 값이 앞서 돌려준 것과 다를 때 불린다 (열쇠) */
  subscribe(cb: (key: string) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  private emit(key: string): void {
    for (const cb of [...this.subs]) cb(key);
  }

  /**
   * 캐시 먼저. 담아 둔 것이 있으면(maxStale 안) 그것을 바로 돌려주고 뒤에서 새로 읽는다 —
   * 새 값이 다르면 subscribe 한 쪽에 알린다(화면이 다시 물으면 그때는 새 값이 온다). 방금(FRESH_MS) 읽은 것은 다시 읽지 않는다.
   * 뒤에서 읽다 실패하면 담아 둔 것을 버리고 알린다 — 다시 물을 때 오류가 평소 길로 드러난다.
   */
  read<T>(key: string, fetch: () => Promise<T>, maxStale: number = Infinity): Promise<T> {
    const hit = this.get<T>(key);
    const age = hit ? this.now() - hit.at : Infinity;
    if (hit && age <= FRESH_MS) return Promise.resolve(hit.v);
    const stale = hit && age <= maxStale ? hit : undefined;
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      const gen = this.gen;
      const mine: Promise<T> = fetch().then(
        (v) => {
          if (this.inflight.get(key) === mine) this.inflight.delete(key);
          if (gen === this.gen) {
            const changed = stale !== undefined && !same(stale.v, v);
            this.set(key, v);
            if (changed) this.emit(key);
          }
          return v;
        },
        (e: unknown) => {
          if (this.inflight.get(key) === mine) this.inflight.delete(key);
          if (gen === this.gen && stale !== undefined) {
            this.remove(key);
            this.writeIndex();
            this.emit(key);
          }
          throw e;
        },
      );
      this.inflight.set(key, mine);
      p = mine;
    }
    if (stale) {
      p.catch(() => {});
      return Promise.resolve(stale.v);
    }
    return p;
  }
}

// ---------------------------------------------------------------------------
// 열쇠
// ---------------------------------------------------------------------------

/** 서랍 열쇠 머리 — 서랍에 무엇이든 쓰면 이 머리 전부를 버린다 */
export const DRAWER = "d:";
/** 홈의 안 읽음 수는 화면이 다시 묻지 않으니 이보다 오래된 것은 기다렸다 새 값을 준다 */
export const UNREAD_MAX_STALE_MS = 60_000;

export const KEY = {
  list: (parentId: string | null) => `${DRAWER}list:${parentId ?? "root"}`,
  folders: `${DRAWER}folders`,
  unreadFolders: `${DRAWER}unreadFolders`,
  unreadCount: `${DRAWER}unreadCount`,
  // 일정 · 플래너 (두 화면이 같이 쓴다)
  places: "s:places",
  travel: "s:travel",
  settings: "s:settings",
  sources: "s:sources",
  week: (monday: string) => `s:week:${monday}`,
  weeks: "s:week:",
  tasks: "p:tasks",
  links: "p:links",
  rules: "p:rules",
  roles: "p:roles",
  titles: "p:titles",
  // 모임
  meets: "m:meets",
  circles: "m:circles",
} as const;

/** 열쇠들이 전부 담겨 있을 때만 값들을, 하나라도 없으면 null (반쪽 화면을 그리지 않는다) */
export function peekAll<T extends Record<string, unknown>>(cache: DataCache, keys: { [K in keyof T]: string }): T | null {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(keys)) {
    const hit = cache.get(keys[name as keyof T]);
    if (!hit) return null;
    out[name] = hit.v;
  }
  return out as T;
}

const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * 서랍 읽기에 캐시를 끼운다: 폴더 안 목록 · 폴더 목록 · 안 읽음(폴더/수)은 담아 둔 것을 먼저 돌려주고 뒤에서 새로 읽는다.
 * 쓰기는 앞뒤로 서랍 캐시를 버린다 — 쓰고 난 뒤의 읽기는 늘 서버로 간다(옛 값이 화면을 덮지 않는다).
 * 보고서 본문 · 찾기 · 휴지통 · 사진 주소는 그대로 지나간다.
 */
export function cachedDrawer<D extends DrawerData>(raw: D, cache: DataCache): DrawerData {
  const write =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      cache.drop(DRAWER);
      try {
        return await f(...a);
      } finally {
        cache.drop(DRAWER);
      }
    };
  return {
    list: (parentId) => cache.read(KEY.list(parentId), () => raw.list(parentId)).then(copy),
    folders: () => cache.read(KEY.folders, () => raw.folders()).then(copy),
    unreadFolders: () => cache.read(KEY.unreadFolders, () => raw.unreadFolders()).then(copy),
    unreadCount: () => cache.read(KEY.unreadCount, () => raw.unreadCount(), UNREAD_MAX_STALE_MS),
    report: (id) => raw.report(id),
    search: (q) => raw.search(q),
    trash: () => raw.trash(),
    shared: (token) => raw.shared(token),
    // 읽은 사람: 30초마다 새로 읽는 것이라 담지 않는다. 공개 페이지의 적기는 서랍 캐시와 무관하다
    views: (itemId) => raw.views(itemId),
    viewOpen: (token, device, ua) => raw.viewOpen(token, device, ua),
    viewPing: (token, device, seenSec, keepalive) => raw.viewPing(token, device, seenSec, keepalive),
    viewName: (token, device, name) => raw.viewName(token, device, name),
    imageUrls: (paths, shared) => raw.imageUrls(paths, shared),
    createFolder: write((parentId: string | null, name: string) => raw.createFolder(parentId, name)),
    rename: write((id: string, name: string) => raw.rename(id, name)),
    move: write((id: string, parentId: string | null) => raw.move(id, parentId)),
    remove: write((id: string) => raw.remove(id)),
    removeMany: write((ids: string[]) => raw.removeMany(ids)),
    copy: write((ids: string[], to: string | null) => raw.copy(ids, to)),
    restore: write((batch: string) => raw.restore(batch)),
    markRead: write((id: string) => raw.markRead(id)),
    editText: write((id: string, baseVersion: number, path: readonly (string | number)[], value: string) => raw.editText(id, baseVersion, path, value)),
    arrangeBlocks: write((id: string, baseVersion: number, order: readonly number[]) => raw.arrangeBlocks(id, baseVersion, order)),
    share: write((id: string) => raw.share(id)),
    unshare: write((id: string) => raw.unshare(id)),
  };
}
