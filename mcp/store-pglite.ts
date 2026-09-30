// 시험용 Store: PGlite(진짜 Postgres, WASM)에 마이그레이션을 그대로 돌리고 service_role 로 SQL 을 실행한다.
// MCP 로직을 실제 DB 규칙(트리거·CHECK·인덱스) 위에서 시험하기 위한 것. db/ez_items.test.ts 와 같은 Supabase 흉내.

import { PGlite } from "@electric-sql/pglite";
import { DbError } from "./errors";
import { migrations, SUPABASE_STUB } from "../db/testing";
import { ITEM_COLS, type FolderNode, type Item, type ItemPatch, type NewItem, type Report, type SearchHit, type Store, type StoredImage } from "./store";

/** 마이그레이션까지 돈 빈 DB */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const m of migrations()) await db.exec(m);
  return db;
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

function toItem(r: Row): Item {
  return {
    id: r.id as string,
    parent_id: (r.parent_id as string | null) ?? null,
    kind: r.kind as Item["kind"],
    name: r.name as string,
    report_kind: (r.report_kind as Item["report_kind"]) ?? null,
    version: r.version as number,
    agent_updated_at: iso(r.agent_updated_at),
    read_at: iso(r.read_at),
    updated_at: iso(r.updated_at)!,
  };
}
const toReport = (r: Row): Report => ({ ...toItem(r), blocks: r.blocks as unknown[] });

/** 사진 저장소 흉내: 메모리. 버킷 규칙(WebP 만 · 512,000바이트까지)은 진짜처럼 거절한다 */
export type MemoryImage = { bytes: Uint8Array; created_at: string };

const IMAGE_LIMIT = 512_000;
const isWebp = (b: Uint8Array) =>
  b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP";

export class PgliteStore implements Store {
  /** 올린 사진 (경로 → 내용·올린 때). 시험이 직접 들여다보고 올린 때를 바꾼다 */
  readonly images = new Map<string, MemoryImage>();
  uploads = 0;

  constructor(
    readonly db: PGlite,
    readonly owner: string,
    readonly now: () => Date = () => new Date(),
  ) {}

  /** service_role 로 한 문장 */
  private async q(text: string, params: unknown[] = []): Promise<Row[]> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.exec("set local role service_role");
        return (await tx.query<Row>(text, params)).rows;
      });
    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string; constraint?: string };
      throw new DbError(
        `${err.message ?? String(e)}${err.constraint ? ` (constraint "${err.constraint}")` : ""}`,
        err.code ?? "",
        err.detail,
      );
    }
  }

  async folders(): Promise<FolderNode[]> {
    const rows = await this.q(
      "select id, parent_id, name from ez_items where owner = $1 and deleted_at is null and kind = 'folder'",
      [this.owner],
    );
    return rows.map((r) => ({ id: r.id as string, parent_id: (r.parent_id as string | null) ?? null, name: r.name as string }));
  }

  async children(parentId: string | null): Promise<Item[]> {
    const rows = await this.q(
      `select ${ITEM_COLS} from ez_items where owner = $1 and deleted_at is null and parent_id is not distinct from $2`,
      [this.owner, parentId],
    );
    return rows.map(toItem);
  }

  async get(id: string): Promise<Item | null> {
    const rows = await this.q(`select ${ITEM_COLS} from ez_items where owner = $1 and deleted_at is null and id = $2`, [this.owner, id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async getReport(id: string): Promise<Report | null> {
    const rows = await this.q(
      `select ${ITEM_COLS}, blocks from ez_items where owner = $1 and deleted_at is null and kind = 'report' and id = $2`,
      [this.owner, id],
    );
    return rows[0] ? toReport(rows[0]) : null;
  }

  async insert(item: NewItem): Promise<Item> {
    const r = item.kind === "report" ? item : null;
    const rows = await this.q(
      `insert into ez_items (owner, kind, parent_id, name, report_kind, blocks, schema_version, agent, agent_updated_at)
       values ($1, $2, $3, $4, $5, $6, coalesce($7, 1), $8, $9) returning ${ITEM_COLS}`,
      [
        this.owner,
        item.kind,
        item.parent_id,
        item.name,
        r?.report_kind ?? null,
        r ? JSON.stringify(r.blocks) : null,
        r?.schema_version ?? null,
        r?.agent ?? null,
        r?.agent_updated_at ?? null,
      ],
    );
    return toItem(rows[0]!);
  }

  async update(id: string, patch: ItemPatch, baseVersion?: number): Promise<Item | null> {
    const sets: string[] = [];
    const params: unknown[] = [this.owner, id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      params.push(k === "blocks" ? JSON.stringify(v) : v);
      sets.push(`${k} = $${params.length}`);
    }
    if (sets.length === 0) return this.get(id);
    let where = "owner = $1 and id = $2 and deleted_at is null";
    if (baseVersion !== undefined) {
      params.push(baseVersion);
      where += ` and version = $${params.length}`;
    }
    const rows = await this.q(`update ez_items set ${sets.join(", ")} where ${where} returning ${ITEM_COLS}`, params);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async remove(id: string): Promise<string> {
    const rows = await this.q("select ez_delete($1, $2) as batch", [id, this.owner]);
    return rows[0]!.batch as string;
  }

  async search(q: string, under: string | null, limit: number): Promise<SearchHit[]> {
    const rows = await this.q("select * from ez_search($1, $2, $3, $4)", [q, this.owner, under, limit]);
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as SearchHit["kind"],
      name: r.name as string,
      parent_id: (r.parent_id as string | null) ?? null,
      report_kind: (r.report_kind as SearchHit["report_kind"]) ?? null,
      match: r.match as SearchHit["match"],
      snippet: (r.snippet as string | null) ?? null,
      updated_at: iso(r.updated_at)!,
    }));
  }

  // ---------------------------------------------------------------- 사진 (메모리)

  private mine(path: string): boolean {
    return path.startsWith(`${this.owner}/`);
  }

  async imageExists(path: string): Promise<boolean> {
    return this.mine(path) && this.images.has(path);
  }

  async uploadImage(path: string, bytes: Uint8Array): Promise<void> {
    if (!this.mine(path)) throw new DbError("[EZ_IMAGE] 주인 폴더 밖에는 올릴 수 없습니다", "P0001");
    if (!isWebp(bytes)) throw new DbError("[EZ_IMAGE] 저장소가 거절했습니다: WebP 만 올릴 수 있습니다", "P0001");
    if (bytes.length > IMAGE_LIMIT) throw new DbError("[EZ_IMAGE] 저장소가 거절했습니다: 500KB 를 넘습니다", "P0001");
    if (this.images.has(path)) return;
    this.uploads++;
    this.images.set(path, { bytes: bytes.slice(), created_at: this.now().toISOString() });
  }

  async listImages(): Promise<StoredImage[]> {
    return [...this.images].filter(([p]) => this.mine(p)).map(([path, v]) => ({ path, created_at: v.created_at }));
  }

  async deleteImages(paths: string[]): Promise<void> {
    for (const p of paths) if (this.mine(p)) this.images.delete(p);
  }

  async imageSrcs(): Promise<Set<string>> {
    const rows = await this.q("select s from ez_image_srcs($1) as s", [this.owner]);
    return new Set(rows.map((r) => r.s as string));
  }
}
