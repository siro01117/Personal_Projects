// 시험용 Store: PGlite(진짜 Postgres, WASM)에 마이그레이션을 그대로 돌리고 service_role 로 SQL 을 실행한다.
// MCP 로직을 실제 DB 규칙(트리거·CHECK·인덱스) 위에서 시험하기 위한 것. db/ez_items.test.ts 와 같은 Supabase 흉내.

import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { DbError } from "./errors";
import { escapeLike, ITEM_COLS, type FolderNode, type Item, type ItemPatch, type NewItem, type Report, type Store } from "./store";

const MIGRATION = readFileSync(new URL("../db/migrations/0001_ez_items.sql", import.meta.url), "utf8");

const SUPABASE_STUB = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`;

/** 마이그레이션까지 돈 빈 DB */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(MIGRATION);
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

export class PgliteStore implements Store {
  constructor(
    readonly db: PGlite,
    readonly owner: string,
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

  async searchNames(q: string, limit: number): Promise<Item[]> {
    const rows = await this.q(
      `select ${ITEM_COLS} from ez_items where owner = $1 and deleted_at is null and name ilike $2
       order by updated_at desc, id limit $3`,
      [this.owner, `%${escapeLike(q)}%`, limit],
    );
    return rows.map(toItem);
  }

  async scanReports(offset: number, limit: number): Promise<Report[]> {
    const rows = await this.q(
      `select ${ITEM_COLS}, blocks from ez_items where owner = $1 and deleted_at is null and kind = 'report'
       order by updated_at desc, id offset $2 limit $3`,
      [this.owner, offset, limit],
    );
    return rows.map(toReport);
  }
}
