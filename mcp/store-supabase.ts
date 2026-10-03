// 실제 Store: supabase-js + service_role 키. service_role 은 RLS 를 우회하므로
// 모든 쿼리에 owner = EZ_OWNER_ID 를 직접 걸고, insert 때 owner 를 명시한다. 다른 테이블은 건드리지 않는다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DbError } from "./errors";
import {
  IMAGE_BUCKET,
  ITEM_COLS,
  type FolderNode,
  type Item,
  type ItemPatch,
  type NewItem,
  type Report,
  type SearchHit,
  type Store,
  type StoredImage,
  type StoredNote,
} from "./store";

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

  /** service_role 은 RLS 를 우회하므로 보고서가 주인 것인지 먼저 본다. 쓴 사람은 ez_views 를 끼워 읽는다 */
  async notes(itemId: string): Promise<StoredNote[]> {
    const rep = await this.get(itemId);
    if (!rep) return [];
    type Raw = Omit<StoredNote, "label"> & { view: { guest_no: number; name: string | null } | null };
    const rows = (await run<unknown>(
      this.sb
        .from("ez_notes")
        .select("id, by_owner, body, version, block, anchor, created_at, view:ez_views!ez_notes_view_id_fkey(guest_no, name)")
        .eq("item_id", itemId)
        .is("deleted_at", null)
        .order("created_at")
        .order("id")
        .limit(PAGE),
    )) as Raw[];
    return rows.map(({ view, ...n }) => ({ ...n, label: view ? (view.name ?? `게스트 ${view.guest_no}`) : null }));
  }

  // ---------------------------------------------------------------- 사진 (Storage API — SQL 로 지우지 않는다)

  private bucket() {
    return this.sb.storage.from(IMAGE_BUCKET);
  }

  private mine(path: string): void {
    if (!path.startsWith(`${this.owner}/`)) throw new DbError("[EZ_IMAGE] 주인 폴더 밖의 사진은 다루지 않습니다", "P0001");
  }

  async imageExists(path: string): Promise<boolean> {
    this.mine(path);
    const { data, error } = await this.bucket().exists(path);
    // 없는 파일은 error(400/404)와 함께 false 로 온다
    if (error && data !== false) throw storageError("사진을 확인하지 못했습니다", error);
    return data === true;
  }

  async uploadImage(path: string, bytes: Uint8Array): Promise<void> {
    this.mine(path);
    const { error } = await this.bucket().upload(path, bytes, {
      contentType: "image/webp",
      upsert: false,
      cacheControl: "31536000",
    });
    if (!error) return;
    // 같은 경로 = 같은 내용. 그 사이 다른 곳에서 올렸으면 그대로 쓴다
    if (/already exists|duplicate/i.test(error.message) || String((error as { statusCode?: unknown }).statusCode) === "409") return;
    throw storageError("사진을 올리지 못했습니다", error);
  }

  async listImages(): Promise<StoredImage[]> {
    const out: StoredImage[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await this.bucket().list(this.owner, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw storageError("사진 목록을 읽지 못했습니다", error);
      for (const f of data ?? []) {
        if (f.id && f.created_at && /^[0-9a-f]{64}\.webp$/.test(f.name)) out.push({ path: `${this.owner}/${f.name}`, created_at: f.created_at });
      }
      if ((data ?? []).length < PAGE) return out;
    }
  }

  async deleteImages(paths: string[]): Promise<void> {
    for (const p of paths) this.mine(p);
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await this.bucket().remove(paths.slice(i, i + 100));
      if (error) throw storageError("사진을 지우지 못했습니다", error);
    }
  }

  async imageSrcs(): Promise<Set<string>> {
    const rows = await run<(string | { ez_image_srcs: string })[]>(this.sb.rpc("ez_image_srcs", { p_as: this.owner }));
    return new Set(rows.map((r) => (typeof r === "string" ? r : r.ez_image_srcs)));
  }
}

function storageError(what: string, e: { message: string }): DbError {
  return new DbError(`[EZ_IMAGE] ${what}: ${e.message}`, "P0001");
}
