// 개발 확인용 메모리 저장소 (`?demo=1`, NODE_ENV=development 에서만 쓰인다).
//
// !! 진짜 규칙의 출처는 DB 다 (db/migrations/0001_ez_items.sql: 트리거·CHECK·유일 인덱스·ez_* 함수).
// 여기 있는 순환·깊이·삭제 묶음·복원·버전 검사는 화면을 로그인 없이 확인하려고 흉내 낸 것일 뿐이다.
// 이름 규칙·(2) 붙이기·고칠 수 있는 칸은 lib 을 그대로 쓰고, 오류는 DB 와 같은 모양(SQLSTATE · '[EZ_*] 설명')으로 던진다.

import { editRule } from "../../lib/blocks";
import { DbError } from "../../lib/errors";
import { charCount, sameName, uniqueName, validateName } from "../../lib/names";
import { isUnread } from "../_logic/drawer";
import type { DrawerData, Entry, Folder, Kind, Path, ReportDoc, Restored, SharedDoc } from "./types";

const MAX_DEPTH = 8;
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
};

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

  constructor(seed: Seed[] = [], opts: MemoryOptions = {}) {
    this.latency = opts.latency ?? 0;
    this.now = opts.now ?? (() => new Date());
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
    const { id, parent_id, kind, name, agent_updated_at, read_at, updated_at } = r;
    return { id, parent_id, kind, name, agent_updated_at, read_at, updated_at };
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
    return r ? clone({ name: r.name, report_kind: r.report_kind, blocks: r.blocks ?? [], updated_at: r.updated_at }) : null;
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
