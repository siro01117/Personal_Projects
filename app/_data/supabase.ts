// 진짜 데이터: 브라우저 supabase-js + 로그인한 사람의 세션. RLS(owner = auth.uid())가 남의 것을 막는다.
// service role 키는 웹에 절대 두지 않는다 — 여기서 쓰는 건 공개(anon) 키뿐이다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { uniqueName } from "../../lib/names";
import { DbError } from "../../lib/errors";
import { browserStore, cachedDrawer, DataCache } from "./cache";
import { SupabaseLive } from "./liveSupabase";
import { SupabaseMeet, SupabaseMeetPublic } from "./meetSupabase";
import { SupabaseSchedule } from "./scheduleSupabase";
import type { Auth, Copied, DrawerData, Entry, Folder, NoteRow, Path, ReportDoc, Restored, SearchHit, SharedDoc, Source, TrashRow, Viewer, ViewRow, VisitRow } from "./types";

const TABLE = "ez_items";
const PAGE = 1000;
/** shared 는 계산 칸 ez_is_shared (0003) — 공유 열쇠 값은 목록에 싣지 않는다 */
const ENTRY_COLS = "id, parent_id, kind, name, report_kind, agent_updated_at, read_at, created_at, updated_at, shared:ez_is_shared";
/** 찾기 결과 수 (ez_search 상한) */
const SEARCH_LIMIT = 50;
const REPORT_COLS = `${ENTRY_COLS}, blocks, version, agent, share_token`;
/** 읽은 사람 (0013). item_id 는 물은 것이라 싣지 않는다 */
const VIEW_COLS = "id, device, guest_no, name, first_at, last_at, hits, seconds, ua";
/** 보고서당 기록 상한 (0013 과 같다) */
const VIEWS_MAX = 500;
/** 방문 · 글 (0014). 글의 쓴 사람은 ez_views 를 끼워 읽는다 (view_id 외래키) */
const VISIT_COLS = "id, version, started_at, last_at, seconds";
const NOTE_COLS = "id, by_owner, body, version, block, anchor, created_at, updated_at, view:ez_views!ez_notes_view_id_fkey(guest_no, name)";
const VISITS_MAX = 200;
const NOTES_MAX = 1000;

type NoteRaw = Omit<NoteRow, "guest_no" | "label"> & { view: { guest_no: number; name: string | null } | null };
const toNote = ({ view, ...n }: NoteRaw): NoteRow => ({ ...n, guest_no: view?.guest_no ?? null, label: view ? (view.name ?? `게스트 ${view.guest_no}`) : null });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Res<T> = { data: T | null; error: { message: string; code?: string; details?: string | null } | null };

export async function run<T>(p: PromiseLike<Res<T>>): Promise<T> {
  const res = await p;
  if (res.error) throw new DbError(res.error.message, res.error.code ?? "", res.error.details ?? undefined);
  return res.data as T;
}

export function env(): { url: string; key: string } {
  // NEXT_PUBLIC_* 는 빌드 때 글자 그대로 박힌다 — 이름을 문자열로 바꿔 쓰면 안 된다
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new DbError("NEXT_PUBLIC_SUPABASE_URL · NEXT_PUBLIC_SUPABASE_ANON_KEY 가 없습니다 (.env.local)", "CONFIG");
  return { url, key };
}

/** 개발 모드: 요청마다 번호를 찍는다 — 화면 하나를 여는 데 몇 번 부르는지 콘솔에서 센다 */
let requestNo = 0;
const countingFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const at = url.indexOf("/rest/v1/");
  if (at >= 0) console.debug(`[ez] 요청 ${++requestNo} ${init?.method ?? "GET"} ${url.slice(at + 9).split("?")[0]} @${Math.round(performance.now())}ms`);
  return fetch(input, init);
};

let client: SupabaseClient | null = null;
export function sb(): SupabaseClient {
  if (!client) {
    const { url, key } = env();
    client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      ...(process.env.NODE_ENV === "development" ? { global: { fetch: countingFetch } } : {}),
    });
  }
  return client;
}

/** 시험용: 가짜 클라이언트를 끼운다 (null 이면 되돌린다) */
export function setClient(c: SupabaseClient | null): void {
  client = c;
}

/** 공유 페이지용 — 세션 없이 anon 으로만 */
let anonClient: SupabaseClient | null = null;
export function anon(): SupabaseClient {
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

  async arrangeBlocks(id: string, baseVersion: number, order: readonly number[]): Promise<number> {
    return run<number>(sb().rpc("ez_blocks_arrange", { p_id: id, p_base_version: baseVersion, p_order: [...order] }));
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

  // ------------------------------------------------------------ 읽은 사람 (0013)
  // 적는 함수 셋은 세션 클라이언트(sb)로 부른다 — 로그인해 있으면 그 세션이 같이 가서 DB 가 주인 본인을 건너뛴다.
  // 세션이 없으면 anon 키만 가니 anon 으로 실행된다

  async views(itemId: string): Promise<ViewRow[]> {
    if (!UUID.test(itemId)) return [];
    return run<ViewRow[]>(
      sb().from("ez_views").select(VIEW_COLS).eq("item_id", itemId).order("last_at", { ascending: false }).order("guest_no").limit(VIEWS_MAX),
    );
  }

  async viewOpen(token: string, device: string, ua: string): Promise<Viewer | null> {
    const rows = await run<Viewer[]>(sb().rpc("ez_view_open", { p_token: token, p_device: device, p_ua: ua }));
    return rows[0] ?? null;
  }

  async viewPing(token: string, device: string, seenSec: number, keepalive = false): Promise<void> {
    const body = { p_token: token, p_device: device, p_seen_sec: Math.round(seenSec) };
    if (!keepalive) {
      await run(sb().rpc("ez_view_ping", body));
      return;
    }
    // 페이지를 떠나는 중 — supabase-js 를 기다릴 수 없어 REST 주소로 바로. sendBeacon 은 apikey 헤더를 못 붙여 keepalive fetch 로.
    // anon 키로만 간다(주인 본인 줄은 애초에 없으니 아무것도 안 바뀐다)
    const { url, key } = env();
    try {
      void fetch(`${url}/rest/v1/rpc/ez_view_ping`, {
        method: "POST",
        keepalive: true,
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch {
      /* 떠나는 길이라 알리지 않는다 */
    }
  }

  async viewName(token: string, device: string, name: string | null): Promise<void> {
    await run(sb().rpc("ez_view_name", { p_token: token, p_device: device, p_name: name }));
  }

  // ------------------------------------------------------------ 방명록 · 댓글 · 방문 (0014)
  // 주인은 RLS 아래 테이블을 직접 (지운 글은 deleted_at is null 로 걸러 읽는다). 공개 함수 셋은 읽은 사람과 같이 세션 클라이언트로

  async visits(viewId: string): Promise<VisitRow[]> {
    if (!UUID.test(viewId)) return [];
    return run<VisitRow[]>(sb().from("ez_visits").select(VISIT_COLS).eq("view_id", viewId).order("started_at", { ascending: false }).limit(VISITS_MAX));
  }

  async notes(itemId: string): Promise<NoteRow[]> {
    if (!UUID.test(itemId)) return [];
    // 끼워 읽은 view 는 외래키가 하나라 객체로 온다 (타입 추론은 배열이라 unknown 을 거친다)
    const rows = (await run<unknown>(
      sb().from("ez_notes").select(NOTE_COLS).eq("item_id", itemId).is("deleted_at", null).order("created_at").order("id").limit(NOTES_MAX),
    )) as NoteRaw[];
    return rows.map(toNote);
  }

  async noteReply(itemId: string, body: string, block: number | null = null, anchor: string | null = null): Promise<NoteRow> {
    const row = (await run<unknown>(
      sb()
        .from("ez_notes")
        .insert({ item_id: itemId, body: body.trim(), block, anchor: block === null ? null : anchor, by_owner: true })
        .select(NOTE_COLS)
        .single(),
    )) as NoteRaw;
    return toNote(row);
  }

  async noteDelete(id: string): Promise<void> {
    // returning 없이 — 지운 줄은 select 정책에 걸리지 않지만, 돌려받을 것도 없다
    await run(sb().from("ez_notes").update({ deleted_at: new Date().toISOString() }).eq("id", id));
  }

  async sharedNotes(token: string): Promise<NoteRow[]> {
    return run<NoteRow[]>(sb().rpc("ez_notes_list", { p_token: token }));
  }

  async noteWrite(token: string, device: string, body: string, block: number | null = null, anchor: string | null = null): Promise<NoteRow | null> {
    const rows = await run<NoteRow[]>(sb().rpc("ez_note_write", { p_token: token, p_device: device, p_body: body, p_block: block, p_anchor: anchor }));
    return rows[0] ?? null;
  }

  async noteEdit(token: string, device: string, id: string, body: string | null): Promise<void> {
    await run(sb().rpc("ez_note_edit", { p_token: token, p_device: device, p_id: id, p_body: body }));
  }

  async imageUrls(paths: readonly string[], shared = false): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const now = Date.now();
    const need: string[] = [];
    for (const p of new Set(paths)) {
      const hit = signed.get(`${shared ? "s" : "u"}:${p}`);
      if (hit && hit.until > now) out[p] = hit.url;
      else need.push(p);
    }
    if (need.length === 0) return out;
    const { data, error } = await (shared ? anon() : sb()).storage.from(IMAGE_BUCKET).createSignedUrls(need, SIGN_SECONDS);
    if (error) throw new DbError(error.message, "STORAGE");
    for (const r of data ?? []) {
      if (!r.path || !r.signedUrl || r.error) continue;
      out[r.path] = r.signedUrl;
      signed.set(`${shared ? "s" : "u"}:${r.path}`, { url: r.signedUrl, until: now + (SIGN_SECONDS - 300) * 1000 });
    }
    return out;
  }
}

/** 사진 버킷 (0004). 비공개 — 볼 때만 잠깐 유효한 주소를 받는다 */
const IMAGE_BUCKET = "ez-images";
const SIGN_SECONDS = 3600;
/** 이 페이지 안에서 받은 주소 (만료 5분 전까지 다시 쓴다) — 30초마다 다시 불러와도 사진이 깜빡이지 않게 */
const signed = new Map<string, { url: string; until: number }>();

/** 마지막으로 읽은 것 (먼저 그리기). 사람 id 로 나뉜다 — 로그인을 확인할 때 정해지고, 로그아웃하면 전부 지운다 */
const cache = new DataCache(browserStore());

const auth: Auth = {
  // getSession 은 기기에 저장된 세션을 읽는다 (네트워크를 타지 않는다. 토큰이 만료됐을 때만 갱신 요청 하나)
  async signedIn() {
    const { data } = await sb().auth.getSession();
    // 세션이 없으면(닫아 둔 사이 만료 등) 담아 둔 것도 지운다
    if (!data.session) cache.clear();
    cache.setScope(data.session?.user.id ?? null);
    return data.session !== null;
  },
  async signIn(email, password) {
    const { data, error } = await sb().auth.signInWithPassword({ email, password });
    if (error) throw error;
    cache.setScope(data.user?.id ?? null);
  },
  async signOut() {
    cache.clear();
    cache.setScope(null);
    await sb().auth.signOut();
  },
  onSignedOut(cb) {
    const { data } = sb().auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") return;
      cache.clear();
      cache.setScope(null);
      cb();
    });
    return () => data.subscription.unsubscribe();
  },
};

let source: Source | null = null;
/** 하나만 만든다 — 모듈을 오가도 같은 것을 쓴다 (로그인 확인 · 캐시를 이어 쓴다) */
export function supabaseSource(): Source {
  if (!source) {
    const schedule = new SupabaseSchedule();
    source = {
      data: cachedDrawer(new SupabaseDrawer(), cache),
      schedule,
      planner: schedule,
      meet: new SupabaseMeet(),
      meetPublic: new SupabaseMeetPublic(),
      live: new SupabaseLive(),
      auth,
      demo: false,
      cache,
    };
  }
  return source;
}
