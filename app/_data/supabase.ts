// 진짜 데이터: 브라우저 supabase-js + 로그인한 사람의 세션. RLS(owner = auth.uid())가 남의 것을 막는다.
// service role 키는 웹에 절대 두지 않는다 — 여기서 쓰는 건 공개(anon) 키뿐이다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { uniqueName } from "../../lib/names";
import { DbError } from "../../lib/errors";
import type { Auth, Copied, DrawerData, Entry, Folder, Path, ReportDoc, Restored, SearchHit, SharedDoc, Source, TrashRow } from "./types";

const TABLE = "ez_items";
const PAGE = 1000;
/** shared 는 계산 칸 ez_is_shared (0003) — 공유 열쇠 값은 목록에 싣지 않는다 */
const ENTRY_COLS = "id, parent_id, kind, name, agent_updated_at, read_at, updated_at, shared:ez_is_shared";
/** 찾기 결과 수 (ez_search 상한) */
const SEARCH_LIMIT = 50;
const REPORT_COLS = `${ENTRY_COLS}, report_kind, blocks, version, agent, share_token`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Res<T> = { data: T | null; error: { message: string; code?: string; details?: string | null } | null };

async function run<T>(p: PromiseLike<Res<T>>): Promise<T> {
  const res = await p;
  if (res.error) throw new DbError(res.error.message, res.error.code ?? "", res.error.details ?? undefined);
  return res.data as T;
}

function env(): { url: string; key: string } {
  // NEXT_PUBLIC_* 는 빌드 때 글자 그대로 박힌다 — 이름을 문자열로 바꿔 쓰면 안 된다
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new DbError("NEXT_PUBLIC_SUPABASE_URL · NEXT_PUBLIC_SUPABASE_ANON_KEY 가 없습니다 (.env.local)", "CONFIG");
  return { url, key };
}

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!client) {
    const { url, key } = env();
    client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  }
  return client;
}

/** 공유 페이지용 — 세션 없이 anon 으로만 */
let anonClient: SupabaseClient | null = null;
function anon(): SupabaseClient {
  if (!anonClient) {
    const { url, key } = env();
    anonClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }
  return anonClient;
}

class SupabaseDrawer implements DrawerData {
  private items() {
    return sb().from(TABLE);
  }

  async list(parentId: string | null): Promise<Entry[]> {
    const out: Entry[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = this.items().select(ENTRY_COLS).is("deleted_at", null);
      q = parentId === null ? q.is("parent_id", null) : q.eq("parent_id", parentId);
      const rows = await run<Entry[]>(q.order("id").range(from, from + PAGE - 1));
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  async folders(): Promise<Folder[]> {
    const out: Folder[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await run<Folder[]>(
        this.items().select("id, parent_id, name").is("deleted_at", null).eq("kind", "folder").order("id").range(from, from + PAGE - 1),
      );
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  async report(id: string): Promise<ReportDoc | null> {
    if (!UUID.test(id)) return null;
    return run<ReportDoc | null>(
      this.items().select(REPORT_COLS).is("deleted_at", null).eq("kind", "report").eq("id", id).maybeSingle(),
    );
  }

  async unreadCount(): Promise<number> {
    let n = 0;
    for (let from = 0; ; from += PAGE) {
      const rows = await run<{ agent_updated_at: string; read_at: string | null }[]>(
        this.items()
          .select("agent_updated_at, read_at")
          .is("deleted_at", null)
          .eq("kind", "report")
          .not("agent_updated_at", "is", null)
          .order("id")
          .range(from, from + PAGE - 1),
      );
      for (const r of rows) if (r.read_at === null || Date.parse(r.agent_updated_at) > Date.parse(r.read_at)) n++;
      if (rows.length < PAGE) return n;
    }
  }

  async unreadFolders(): Promise<string[]> {
    // setof uuid 는 값 배열로 온다
    const rows = await run<(string | { ez_unread_folders: string })[]>(sb().rpc("ez_unread_folders"));
    return rows.map((r) => (typeof r === "string" ? r : r.ez_unread_folders));
  }

  async search(query: string): Promise<SearchHit[]> {
    return run<SearchHit[]>(sb().rpc("ez_search", { p_query: query, p_limit: SEARCH_LIMIT }));
  }

  async trash(): Promise<TrashRow[]> {
    return run<TrashRow[]>(sb().rpc("ez_trash"));
  }

  async createFolder(parentId: string | null, name: string): Promise<Entry> {
    return run<Entry>(this.items().insert({ kind: "folder", parent_id: parentId, name }).select(ENTRY_COLS).single());
  }

  async rename(id: string, name: string): Promise<void> {
    const rows = await run<{ id: string }[]>(this.items().update({ name }).eq("id", id).is("deleted_at", null).select("id"));
    if (rows.length === 0) throw new DbError("[EZ_NOT_FOUND] 항목이 없습니다", "P0001");
  }

  async move(id: string, parentId: string | null): Promise<{ name: string; renamed: boolean }> {
    const self = await run<{ name: string } | null>(this.items().select("name").eq("id", id).is("deleted_at", null).maybeSingle());
    if (!self) throw new DbError("[EZ_NOT_FOUND] 옮길 항목이 없습니다", "P0001");
    // 겹침 판단은 DB 가 최종 — 그 사이 같은 이름이 생기면(23505) 한 번 더 이름을 골라 본다
    for (let attempt = 0; ; attempt++) {
      const siblings = (await this.list(parentId)).filter((s) => s.id !== id).map((s) => s.name);
      const name = uniqueName(self.name, siblings);
      try {
        const patch = name === self.name ? { parent_id: parentId } : { parent_id: parentId, name };
        const rows = await run<{ id: string }[]>(this.items().update(patch).eq("id", id).is("deleted_at", null).select("id"));
        if (rows.length === 0) throw new DbError("[EZ_NOT_FOUND] 옮길 항목이 없습니다", "P0001");
        return { name, renamed: name !== self.name };
      } catch (e) {
        if ((e as { code?: string }).code !== "23505" || attempt >= 1) throw e;
      }
    }
  }

  async remove(id: string): Promise<string> {
    return run<string>(sb().rpc("ez_delete", { p_id: id }));
  }

  async removeMany(ids: string[]): Promise<string> {
    return run<string>(sb().rpc("ez_delete_many", { p_ids: ids }));
  }

  async copy(ids: string[], to: string | null): Promise<Copied[]> {
    return run<Copied[]>(sb().rpc("ez_copy", { p_ids: ids, p_to: to }));
  }

  async restore(batch: string): Promise<Restored[]> {
    return run<Restored[]>(sb().rpc("ez_restore", { p_batch: batch }));
  }

  async markRead(id: string): Promise<void> {
    await run(sb().rpc("ez_mark_read", { p_id: id }));
  }

  async editText(id: string, baseVersion: number, path: Path, value: string): Promise<number> {
    return run<number>(
      sb().rpc("ez_edit_text", { p_id: id, p_base_version: baseVersion, p_path: path.map(String), p_value: value }),
    );
  }

  async share(id: string): Promise<string> {
    return run<string>(sb().rpc("ez_share", { p_id: id }));
  }

  async unshare(id: string): Promise<void> {
    await run(sb().rpc("ez_unshare", { p_id: id }));
  }

  async shared(token: string): Promise<SharedDoc | null> {
    const rows = await run<SharedDoc[]>(anon().rpc("ez_shared", { p_token: token }));
    return rows[0] ?? null;
  }
}

const auth: Auth = {
  async signedIn() {
    const { data } = await sb().auth.getSession();
    return data.session !== null;
  },
  async signIn(email, password) {
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) throw error;
  },
  async signOut() {
    await sb().auth.signOut();
  },
  onSignedOut(cb) {
    const { data } = sb().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") cb();
    });
    return () => data.subscription.unsubscribe();
  },
};

export function supabaseSource(): Source {
  return { data: new SupabaseDrawer(), auth, demo: false };
}
