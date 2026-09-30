// 실제 Store: supabase-js + service_role 키. service_role 은 RLS 를 우회하므로
// 모든 쿼리에 owner = EZ_OWNER_ID 를 직접 걸고, insert 때 owner 를 명시한다. 다른 테이블은 건드리지 않는다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DbError } from "./errors";
import { ITEM_COLS, type FolderNode, type Item, type ItemPatch, type NewItem, type Report, type SearchHit, type Store } from "./store";

const TABLE = "ez_items";
const PAGE = 1000; // PostgREST 기본 최대 행 수

type Res<T> = { data: T | null; error: { message: string; code?: string; details?: string | null } | null };

function unwrap<T>(res: Res<T>): T {
  if (res.error) throw new DbError(res.error.message, res.error.code ?? "", res.error.details ?? undefined);
  return res.data as T;
}

/** fetch 자체가 실패하면(네트워크) supabase-js 는 error 로 돌려주거나 던진다 — 어느 쪽이든 DbError/원래 오류로 */
async function run<T>(p: PromiseLike<Res<T>>): Promise<T> {
  return unwrap(await p);
}

export class SupabaseStore implements Store {
  private readonly sb: SupabaseClient;

  constructor(
    url: string,
    serviceRoleKey: string,
    readonly owner: string,
  ) {
    this.sb = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  private items() {
    return this.sb.from(TABLE);
  }

  async folders(): Promise<FolderNode[]> {
    const out: FolderNode[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await run<FolderNode[]>(
        this.items()
          .select("id, parent_id, name")
          .eq("owner", this.owner)
          .is("deleted_at", null)
          .eq("kind", "folder")
          .order("id")
          .range(from, from + PAGE - 1),
      );
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  async children(parentId: string | null): Promise<Item[]> {
    const out: Item[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = this.items().select(ITEM_COLS).eq("owner", this.owner).is("deleted_at", null);
      q = parentId === null ? q.is("parent_id", null) : q.eq("parent_id", parentId);
      const rows = await run<Item[]>(q.order("id").range(from, from + PAGE - 1));
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  async get(id: string): Promise<Item | null> {
    return run<Item | null>(
      this.items().select(ITEM_COLS).eq("owner", this.owner).is("deleted_at", null).eq("id", id).maybeSingle(),
    );
  }

  async getReport(id: string): Promise<Report | null> {
    return run<Report | null>(
      this.items()
        .select(`${ITEM_COLS}, blocks`)
        .eq("owner", this.owner)
        .is("deleted_at", null)
        .eq("kind", "report")
        .eq("id", id)
        .maybeSingle(),
    );
  }

  async insert(item: NewItem): Promise<Item> {
    return run<Item>(this.items().insert({ ...item, owner: this.owner }).select(ITEM_COLS).single());
  }

  async update(id: string, patch: ItemPatch, baseVersion?: number): Promise<Item | null> {
    let q = this.items().update(patch).eq("owner", this.owner).eq("id", id).is("deleted_at", null);
    if (baseVersion !== undefined) q = q.eq("version", baseVersion);
    const rows = await run<Item[]>(q.select(ITEM_COLS));
    return rows[0] ?? null;
  }

  async remove(id: string): Promise<string> {
    return run<string>(this.sb.rpc("ez_delete", { p_id: id, p_as: this.owner }));
  }

  async search(q: string, under: string | null, limit: number): Promise<SearchHit[]> {
    return run<SearchHit[]>(
      this.sb.rpc("ez_search", { p_query: q, p_as: this.owner, p_under: under, p_limit: limit }),
    );
  }
}
