// 개발 확인용 메모리 저장소 (`?demo=1`, NODE_ENV=development 에서만 쓰인다).
//
// !! 진짜 규칙의 출처는 DB 다 (db/migrations/0001_ez_items.sql: 트리거·CHECK·유일 인덱스·ez_* 함수,
//    0002 ez_search, 0003 ez_copy·ez_delete_many·ez_unread_folders·ez_trash).
// 여기 있는 순환·깊이·삭제 묶음·복원·버전·복사·찾기는 화면을 로그인 없이 확인하려고 흉내 낸 것일 뿐이다.
// 이름 규칙·(2)·'- 복사본' 붙이기·고칠 수 있는 칸은 lib 을 그대로 쓰고, 오류는 DB 와 같은 모양(SQLSTATE · '[EZ_*] 설명')으로 던진다.

import { editRule, withoutLocalPaths } from "../../lib/blocks";
import { DbError } from "../../lib/errors";
import { charCount, copyName, sameName, uniqueName, validateName } from "../../lib/names";
import { isUnread } from "../_logic/drawer";
import type { Copied, DrawerData, Entry, Folder, Kind, Path, ReportDoc, Restored, SearchHit, SharedDoc, TrashRow } from "./types";

const MAX_DEPTH = 8;
/** 찾기에서 뺄 키 — 사용자 글자가 아닌 값 (ez_search 와 같다) */
const NOT_TEXT = ["type", "tag", "url", "src", "place", "size", "local_path"];
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
/** 줄바꿈 + 줄/문단 구분자(U+2028, U+2029) — ez_edit_text 와 같다 */
const LINE_BREAK = new RegExp(`[\\n\\r${String.fromCharCode(0x2028, 0x2029)}]`);

export type Row = {
  id: string;
  parent_id: string | null;
  kind: Kind;
  name: string;
  report_kind: ReportDoc["report_kind"];
  blocks: unknown[] | null;
  version: number;
  agent: string | null;
  agent_updated_at: string | null;
  read_at: string | null;
  share_token: string | null;
  deleted_at: string | null;
  deleted_batch: string | null;
  created_at: string;
  updated_at: string;
};

export type Seed = Partial<Row> & { id: string; kind: Kind; name: string };

export type MemoryOptions = {
  /** 응답을 늦춰 낙관적 갱신이 보이게 (ms) */
  latency?: number;
  now?: () => Date;
  /** 사진 경로 → 보여 줄 주소 (확인 모드는 public/ 의 샘플) */
  images?: Record<string, string>;
};

const usesImage = (blocks: unknown[] | null, src: string) =>
  (blocks ?? []).some((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "image" && (b as { src?: unknown }).src === src);

const ez = (code: string, message: string) => new DbError(`[${code}] ${message}`, "P0001");
const nameTaken = () => new DbError('duplicate key value violates unique constraint "ez_items_name_unique"', "23505");
const badName = () => new DbError('new row for relation "ez_items" violates check constraint "ez_items_name_check"', "23514");

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function randomToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const clone = <T>(x: T): T => structuredClone(x);

export class MemoryDrawer implements DrawerData {
  readonly rows = new Map<string, Row>();
  private readonly latency: number;
  private readonly now: () => Date;
  private readonly images: Record<string, string>;

  constructor(seed: Seed[] = [], opts: MemoryOptions = {}) {
    this.latency = opts.latency ?? 0;
    this.now = opts.now ?? (() => new Date());
    this.images = opts.images ?? {};
    const at = this.now().toISOString();
    for (const s of seed) {
      this.rows.set(s.id, {
        parent_id: null,
        report_kind: null,
        blocks: null,
        version: 1,
        agent: null,
        agent_updated_at: null,
        read_at: null,
        share_token: null,
        deleted_at: null,
        deleted_batch: null,
        created_at: at,
        updated_at: at,
        ...s,
      });
    }
  }

  private async wait(): Promise<void> {
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
  }

  private live(id: string): Row | undefined {
    const r = this.rows.get(id);
    return r && r.deleted_at === null ? r : undefined;
  }

  private kids(parentId: string | null): Row[] {
    return [...this.rows.values()].filter((r) => r.deleted_at === null && r.parent_id === parentId);
  }

  private entry(r: Row): Entry {
    const { id, parent_id, kind, name, report_kind, agent_updated_at, read_at, created_at, updated_at } = r;
    return { id, parent_id, kind, name, report_kind, agent_updated_at, read_at, created_at, updated_at, shared: r.share_token !== null };
  }

  /** id 의 조상(자기 제외) 중에 ids 가 있는지 (ez_is_under) */
  private isUnder(id: string, ids: ReadonlySet<string>): boolean {
    let cur = this.rows.get(id)?.parent_id ?? null;
    for (let guard = 0; cur !== null && guard < 64; guard++) {
      if (ids.has(cur)) return true;
      cur = this.rows.get(cur)?.parent_id ?? null;
    }
    return false;
  }

  /** 중복을 빼고, 다른 선택 항목의 자손은 뺀다 (ez_top_ids) */
  private topIds(ids: readonly string[]): string[] {
    const set = new Set(ids);
    return [...set].filter((id) => !this.isUnder(id, set));
  }

  /** 자기 아래 살아 있는 것 전부, 얕은 것부터 (같은 깊이는 이름순) */
  private descendants(id: string): Row[] {
    const out: Row[] = [];
    let level = [id];
    for (let d = 0; level.length > 0 && d < 64; d++) {
      const next = level.flatMap((p) => this.kids(p)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      out.push(...next);
      level = next.map((r) => r.id);
    }
    return out;
  }

  /** 이름 규칙(CHECK) + 같은 폴더 안 겹침(유일 인덱스) */
  private checkName(name: string, parentId: string | null, selfId: string | null): void {
    if (validateName(name) !== null || name !== name.trim()) throw badName();
    if (this.kids(parentId).some((k) => k.id !== selfId && sameName(k.name, name))) throw nameTaken();
  }

  /** 새 자리에 놓일 때: 살아 있는 폴더만 · 순환 · 깊이 (트리거 ez_items_guard 흉내) */
  private checkPlace(row: { id: string; kind: Kind }, parentId: string | null, isNew: boolean): void {
    let depth = 0;
    if (parentId !== null) {
      const p = this.rows.get(parentId);
      if (!p) throw ez("EZ_PARENT", "넣을 폴더가 없습니다");
      if (p.deleted_at !== null) throw ez("EZ_PARENT", "지워진 폴더에는 넣을 수 없습니다");
      if (p.kind !== "folder") throw ez("EZ_PARENT", "폴더가 아닌 곳에는 넣을 수 없습니다");
      for (let cur: Row | undefined = p, guard = 0; cur && guard < 64; guard++) {
        if (cur.id === row.id) throw ez("EZ_CYCLE", "폴더를 자기 자신이나 자기 안의 폴더로 옮길 수 없습니다");
        depth++;
        cur = cur.parent_id === null ? undefined : this.rows.get(cur.parent_id);
      }
    }
    if (row.kind !== "folder") return;
    const height = isNew ? 1 : this.height(row.id);
    if (depth + height > MAX_DEPTH) {
      throw ez("EZ_DEPTH", `폴더는 ${MAX_DEPTH}단까지만 넣을 수 있습니다 (옮기면 ${depth + height}단)`);
    }
  }

  /** 자기 포함, 아래로 살아 있는 폴더 높이 */
  private height(id: string): number {
    const sub = this.kids(id).filter((k) => k.kind === "folder");
    return 1 + Math.max(0, ...sub.map((k) => this.height(k.id)));
  }

  private touchContent(r: Row): void {
    r.version += 1;
    r.updated_at = this.now().toISOString();
  }

  // ---------------------------------------------------------------- 읽기

  async list(parentId: string | null): Promise<Entry[]> {
    await this.wait();
    return this.kids(parentId).map((r) => this.entry(r));
  }

  async folders(): Promise<Folder[]> {
    await this.wait();
    return [...this.rows.values()]
      .filter((r) => r.deleted_at === null && r.kind === "folder")
      .map(({ id, parent_id, name }) => ({ id, parent_id, name }));
  }

  async report(id: string): Promise<ReportDoc | null> {
    await this.wait();
    const r = this.live(id);
    if (!r || r.kind !== "report") return null;
    return clone({
      ...this.entry(r),
      kind: "report",
      report_kind: r.report_kind,
      blocks: r.blocks ?? [],
      version: r.version,
      agent: r.agent,
      share_token: r.share_token,
    });
  }

  async unreadCount(): Promise<number> {
    await this.wait();
    return [...this.rows.values()].filter((r) => r.deleted_at === null && r.kind === "report" && isUnread(r)).length;
  }

  async unreadFolders(): Promise<string[]> {
    await this.wait();
    const out = new Set<string>();
    for (const r of this.rows.values()) {
      if (r.deleted_at !== null || r.kind !== "report" || !isUnread(r)) continue;
      for (let cur = r.parent_id, guard = 0; cur !== null && guard < 64 && !out.has(cur); guard++) {
        const f = this.live(cur);
        if (!f) break;
        out.add(cur);
        cur = f.parent_id;
      }
    }
    return [...out];
  }

  async search(query: string): Promise<SearchHit[]> {
    await this.wait();
    const q = query.trim().toLowerCase();
    if (q === "") throw ez("EZ_EMPTY", "찾을 글자가 비어 있습니다");
    // 보고서 안 사용자 글자만 (type·tag·url 값은 빼고) — ez_search 흉내
    const texts = (v: unknown, key: string | null, out: string[]) => {
      if (typeof v === "string") {
        if (key === null || !NOT_TEXT.includes(key)) out.push(v);
      } else if (Array.isArray(v)) v.forEach((x) => texts(x, key, out));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) texts(x, k, out);
      return out;
    };
    const live = [...this.rows.values()].filter((r) => r.deleted_at === null);
    const hit = (r: Row, match: "name" | "body", snippet: string | null): SearchHit => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      parent_id: r.parent_id,
      match,
      snippet,
      updated_at: r.updated_at,
    });
    const recent = (a: SearchHit, b: SearchHit) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0);
    const byName = live.filter((r) => r.name.toLowerCase().includes(q)).map((r) => hit(r, "name", null));
    const byBody = live
      .filter((r) => r.kind === "report" && !r.name.toLowerCase().includes(q))
      .flatMap((r) => {
        const t = texts(r.blocks, null, []).find((s) => s.toLowerCase().includes(q));
        if (t === undefined) return [];
        const at = t.toLowerCase().indexOf(q);
        const st = Math.max(0, at - 40);
        const en = Math.min(t.length, at + q.length + 40);
        return [hit(r, "body", `${st > 0 ? "…" : ""}${t.slice(st, en).replace(/\s+/g, " ")}${en < t.length ? "…" : ""}`)];
      });
    return [...byName.sort(recent), ...byBody.sort(recent)].slice(0, 50);
  }

  async trash(): Promise<TrashRow[]> {
    await this.wait();
    const dead = [...this.rows.values()].filter((r) => r.deleted_at !== null && r.deleted_batch !== null);
    const count = new Map<string, number>();
    for (const r of dead) count.set(r.deleted_batch!, (count.get(r.deleted_batch!) ?? 0) + 1);
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return dead
      .filter((r) => !dead.some((p) => p.id === r.parent_id && p.deleted_batch === r.deleted_batch))
      .map((r) => ({ batch: r.deleted_batch!, deleted_at: r.deleted_at!, id: r.id, kind: r.kind, name: r.name, count: count.get(r.deleted_batch!)! }))
      .sort((a, b) => cmp(b.deleted_at, a.deleted_at) || cmp(a.batch, b.batch) || cmp(a.name, b.name));
  }

  // ---------------------------------------------------------------- 쓰기

  async createFolder(parentId: string | null, name: string): Promise<Entry> {
    await this.wait();
    const id = randomId();
    this.checkPlace({ id, kind: "folder" }, parentId, true);
    this.checkName(name, parentId, null);
    const at = this.now().toISOString();
    const row: Row = {
      id,
      parent_id: parentId,
      kind: "folder",
      name,
      report_kind: null,
      blocks: null,
      version: 1,
      agent: null,
      agent_updated_at: null,
      read_at: null,
      share_token: null,
      deleted_at: null,
      deleted_batch: null,
      created_at: at,
      updated_at: at,
    };
    this.rows.set(id, row);
    return this.entry(row);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.wait();
    const r = this.live(id);
    if (!r) throw ez("EZ_NOT_FOUND", "항목이 없습니다");
    if (r.name === name) return;
    this.checkName(name, r.parent_id, r.id);
    r.name = name;
    this.touchContent(r);
  }

  async move(id: string, parentId: string | null): Promise<{ name: string; renamed: boolean }> {
    await this.wait();
    const r = this.live(id);
    if (!r) throw ez("EZ_NOT_FOUND", "옮길 항목이 없습니다");
    if (parentId === r.id) throw ez("EZ_CYCLE", "폴더를 자기 자신이나 자기 안의 폴더로 옮길 수 없습니다");
    const name = uniqueName(r.name, this.kids(parentId).filter((k) => k.id !== id).map((k) => k.name));
    if (parentId !== r.parent_id) this.checkPlace(r, parentId, false);
    this.checkName(name, parentId, r.id);
    const renamed = name !== r.name;
    r.parent_id = parentId;
    if (renamed) {
      r.name = name;
      this.touchContent(r);
    }
    return { name, renamed };
  }

  async remove(id: string): Promise<string> {
    await this.wait();
    const r = this.live(id);
    if (!r) throw ez("EZ_NOT_FOUND", "지울 항목이 없습니다");
    const batch = randomId();
    const at = this.now().toISOString();
    const walk = (row: Row) => {
      for (const k of this.kids(row.id)) walk(k);
      row.deleted_at = at;
      row.deleted_batch = batch;
    };
    walk(r);
    return batch;
  }

  async removeMany(ids: string[]): Promise<string> {
    await this.wait();
    const tops = this.topIds(ids);
    if (tops.length === 0 || tops.some((id) => !this.live(id))) throw ez("EZ_NOT_FOUND", "지울 항목이 없습니다");
    const batch = randomId();
    const at = this.now().toISOString();
    for (const id of tops) {
      for (const r of [this.rows.get(id)!, ...this.descendants(id)]) {
        r.deleted_at = at;
        r.deleted_batch = batch;
      }
    }
    return batch;
  }

  async copy(ids: string[], to: string | null): Promise<Copied[]> {
    await this.wait();
    const tops = this.topIds(ids);
    if (tops.length === 0) throw ez("EZ_EMPTY", "복사할 항목이 없습니다");
    if (tops.some((id) => !this.live(id))) throw ez("EZ_NOT_FOUND", "복사할 항목이 없습니다");
    if (to !== null && (tops.includes(to) || this.isUnder(to, new Set(tops)))) {
      throw ez("EZ_CYCLE", "폴더를 자기 자신이나 자기 안의 폴더로 복사할 수 없습니다");
    }
    // 한 트랜잭션 흉내: 중간에 실패하면 통째로 되돌린다
    const backup = new Map([...this.rows].map(([k, v]) => [k, clone(v)]));
    const at = this.now().toISOString();
    const put = (src: Row, parentId: string | null, name: string): string => {
      const id = randomId();
      this.checkPlace({ id, kind: src.kind }, parentId, true);
      this.checkName(name, parentId, null);
      this.rows.set(id, {
        ...clone(src),
        id,
        parent_id: parentId,
        name,
        version: 1,
        agent_updated_at: null,
        read_at: at,
        share_token: null,
        deleted_at: null,
        deleted_batch: null,
        created_at: at,
        updated_at: at,
      });
      return id;
    };
    try {
      const out: Copied[] = [];
      for (const srcId of tops) {
        const src = this.rows.get(srcId)!;
        const subtree = this.descendants(srcId);
        const name = copyName(src.name, this.kids(to).map((k) => k.name));
        const map = new Map([[srcId, put(src, to, name)]]);
        for (const d of subtree) map.set(d.id, put(d, map.get(d.parent_id!)!, d.name));
        out.push({ src: srcId, id: map.get(srcId)!, name });
      }
      return out;
    } catch (e) {
      this.rows.clear();
      for (const [k, v] of backup) this.rows.set(k, v);
      throw e;
    }
  }

  async restore(batch: string): Promise<Restored[]> {
    await this.wait();
    const inBatch = [...this.rows.values()].filter((r) => r.deleted_batch === batch);
    if (inBatch.length === 0) throw ez("EZ_NOT_FOUND", "복원할 묶음이 없습니다");
    const ids = new Set(inBatch.map((r) => r.id));
    // 얕은 것부터 (묶음 안 부모가 먼저 살아나야 자식이 그 안으로 돌아간다)
    const depthIn = (r: Row): number => (r.parent_id !== null && ids.has(r.parent_id) ? 1 + depthIn(this.rows.get(r.parent_id)!) : 0);
    const ordered = inBatch
      .map((r) => ({ r, d: depthIn(r) }))
      .sort((a, b) => a.d - b.d || (a.r.name < b.r.name ? -1 : a.r.name > b.r.name ? 1 : 0))
      .map((x) => x.r);

    const out: Restored[] = [];
    for (const r of ordered) {
      let parent = r.parent_id;
      let toRoot = false;
      const p = parent === null ? undefined : this.rows.get(parent);
      if (parent !== null && (!p || p.deleted_at !== null || p.kind !== "folder")) {
        parent = null;
        toRoot = true;
      }
      const place = (to: string | null) => {
        const name = uniqueName(r.name, this.kids(to).filter((k) => k.id !== r.id).map((k) => k.name));
        this.checkPlace(r, to, false);
        return name;
      };
      let name: string;
      try {
        name = place(parent);
      } catch (e) {
        if (parent === null || !String((e as Error).message).startsWith("[EZ_DEPTH]")) throw e;
        parent = null;
        toRoot = true;
        name = place(null);
      }
      const renamed = name !== r.name;
      r.parent_id = parent;
      r.deleted_at = null;
      r.deleted_batch = null;
      if (renamed) {
        r.name = name;
        this.touchContent(r);
      }
      out.push({ id: r.id, name, to_root: toRoot, renamed });
    }
    return out;
  }

  async markRead(id: string): Promise<void> {
    await this.wait();
    const r = this.live(id);
    if (!r) throw ez("EZ_NOT_FOUND", "항목이 없습니다");
    r.read_at = this.now().toISOString();
  }

  async editText(id: string, baseVersion: number, path: Path, value: string): Promise<number> {
    await this.wait();
    const r = this.live(id);
    if (!r) throw ez("EZ_NOT_FOUND", "고칠 항목이 없습니다");
    if (baseVersion !== r.version) throw ez("EZ_VERSION", `그 사이 다른 곳에서 고쳤습니다. 새로 불러오세요 (지금 버전 ${r.version})`);
    const v = value.trim();

    if (path.length === 1 && path[0] === "title") {
      if (v === "") throw ez("EZ_EMPTY", "이름이 비어 있습니다");
      this.checkName(v, r.parent_id, r.id);
      if (v !== r.name) {
        r.name = v;
        this.touchContent(r);
      }
      return r.version;
    }

    const rule = r.kind === "report" ? editRule(r.blocks, path) : null;
    if (!rule) throw ez("EZ_PATH", "이 칸은 고칠 수 없습니다");
    if (v === "") throw ez("EZ_EMPTY", "빈 칸으로 둘 수 없습니다");
    const n = charCount(v);
    if (n > rule.maxLength) throw ez("EZ_VALUE", `${rule.maxLength}자까지 쓸 수 있습니다 (지금 ${n}자)`);
    if (rule.oneLine && LINE_BREAK.test(v)) throw ez("EZ_VALUE", "한 줄로 써야 합니다 (줄바꿈 없이)");

    const blocks = clone(r.blocks!);
    let here: unknown = blocks;
    for (const seg of path.slice(0, -1)) here = (here as Record<string | number, unknown>)[seg];
    const last = path[path.length - 1]!;
    if ((here as Record<string | number, unknown>)[last] !== v) {
      (here as Record<string | number, unknown>)[last] = v;
      r.blocks = blocks;
      this.touchContent(r);
    }
    return r.version;
  }

  async share(id: string): Promise<string> {
    await this.wait();
    const r = this.live(id);
    if (!r || r.kind !== "report") throw ez("EZ_NOT_FOUND", "공유할 보고서가 없습니다");
    r.share_token = randomToken();
    return r.share_token;
  }

  async unshare(id: string): Promise<void> {
    await this.wait();
    const r = this.live(id);
    if (!r || r.kind !== "report") throw ez("EZ_NOT_FOUND", "공유를 끌 보고서가 없습니다");
    r.share_token = null;
  }

  async shared(token: string): Promise<SharedDoc | null> {
    await this.wait();
    if (!TOKEN.test(token)) return null;
    const r = [...this.rows.values()].find((x) => x.share_token === token && x.kind === "report" && x.deleted_at === null);
    return r ? clone({ name: r.name, report_kind: r.report_kind, blocks: withoutLocalPaths(r.blocks ?? []), updated_at: r.updated_at }) : null;
  }

  /** 사진 주소 흉내: 생성할 때 준 images(경로 → 주소). shared 면 공유 켜진 살아 있는 보고서가 쓰는 것만 (0004 anon 정책) */
  async imageUrls(paths: readonly string[], shared = false): Promise<Record<string, string>> {
    await this.wait();
    const out: Record<string, string> = {};
    for (const p of paths) {
      const url = this.images[p];
      if (!url) continue;
      if (shared && ![...this.rows.values()].some((r) => r.kind === "report" && r.deleted_at === null && r.share_token !== null && usesImage(r.blocks, p))) continue;
      out[p] = url;
    }
    return out;
  }

  // ---------------------------------------------------------------- 에이전트 흉내 (확인용)

  /** 에이전트가 그 사이 보고서를 고친 것처럼: 버전 +1, 안 읽음 */
  agentTouch(id: string): void {
    const r = this.live(id);
    if (!r || r.kind !== "report") return;
    this.touchContent(r);
    r.agent_updated_at = this.now().toISOString();
  }

  /** 에이전트가 새 보고서를 넣은 것처럼 */
  agentInsert(parentId: string | null, name: string, blocks: unknown[]): string {
    const id = randomId();
    const at = this.now().toISOString();
    this.rows.set(id, {
      id,
      parent_id: parentId,
      kind: "report",
      name: uniqueName(name, this.kids(parentId).map((k) => k.name)),
      report_kind: "reference",
      blocks: clone(blocks),
      version: 1,
      agent: "Claude Code",
      agent_updated_at: at,
      read_at: null,
      share_token: null,
      deleted_at: null,
      deleted_batch: null,
      created_at: at,
      updated_at: at,
    });
    return id;
  }
}
