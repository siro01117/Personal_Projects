// MCP 도구 6개의 로직 (설계서 4장). Store 를 받아 돌고, 입력 검사는 lib 을 가져다 쓴다.
// 결과는 한 줄 한국어 요약 + 구조화 데이터. 실패는 ok: false (MCP isError).

import { reportKindSchema, SCHEMA_VERSION, validateBlocks, type BlockError } from "../lib/blocks";
import { normalizeName, sameName, uniqueName, validateName } from "../lib/names";
import { formatPath, parsePath, PathError } from "../lib/paths";
import { toKorean } from "./errors";
import type { FolderNode, Item, Kind, Store } from "./store";

export type ToolResult = { ok: boolean; summary: string; data: Record<string, unknown> };

export type DrawerOptions = { store: Store; agent: string; now?: () => Date };

export const SEARCH_LIMIT = 20;
const SCAN_PAGE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ok = (summary: string, data: Record<string, unknown> = {}): ToolResult => ({ ok: true, summary, data });
const fail = (summary: string, code: string, extra: Record<string, unknown> = {}): ToolResult => ({
  ok: false,
  summary,
  data: { error: { code, message: summary }, ...extra },
});

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** 실패 요약 끝에 덧붙이기 (error.message 도 같이) */
function addNote(r: ToolResult, note: string): ToolResult {
  const error = { ...(r.data.error as object), message: r.summary + note };
  return { ...r, summary: r.summary + note, data: { ...r.data, error } };
}

function fromError(e: unknown, extra: Record<string, unknown> = {}): ToolResult {
  if (e instanceof PathError) return fail(e.message, "BAD_PATH", extra);
  const k = toKorean(e);
  return fail(k.message, k.code, extra);
}

/** 서랍의 살아 있는 폴더 나무 — 경로 계산·해석용 */
class Tree {
  private byId = new Map<string, FolderNode>();
  private kids = new Map<string | null, FolderNode[]>();

  constructor(folders: FolderNode[]) {
    for (const f of folders) this.add(f);
  }

  static async load(store: Store): Promise<Tree> {
    return new Tree(await store.folders());
  }

  add(f: FolderNode): void {
    this.byId.set(f.id, f);
    const list = this.kids.get(f.parent_id) ?? [];
    list.push(f);
    this.kids.set(f.parent_id, list);
  }

  childFolder(parentId: string | null, name: string): FolderNode | undefined {
    return this.kids.get(parentId)?.find((f) => sameName(f.name, name));
  }

  parentOf(id: string): string | null {
    return this.byId.get(id)?.parent_id ?? null;
  }

  segments(folderId: string | null): string[] {
    const out: string[] = [];
    for (let id = folderId, guard = 0; id !== null && guard < 64; guard++) {
      const f = this.byId.get(id);
      if (!f) break;
      out.unshift(f.name);
      id = f.parent_id;
    }
    return out;
  }

  path(folderId: string | null): string {
    return formatPath(this.segments(folderId));
  }

  itemPath(item: { parent_id: string | null; name: string }): string {
    return formatPath([...this.segments(item.parent_id), item.name]);
  }

  /** folderId 가 root 아래(자기 포함)에 있는지 */
  within(folderId: string | null, root: string | null): boolean {
    if (root === null) return true;
    for (let id = folderId, guard = 0; id !== null && guard < 64; guard++) {
      if (id === root) return true;
      id = this.byId.get(id)?.parent_id ?? null;
    }
    return false;
  }
}

type Node = { id: string | null; kind: Kind; name: string; parent_id: string | null };
const ROOT: Node = { id: null, kind: "folder", name: "", parent_id: null };

type Resolved =
  | { found: true; node: Node; path: string; item?: Item }
  | { found: false; nearestId: string | null; nearestPath: string; reportPath?: string };

/** 경로 해석: 이름 대소문자 무시, 살아 있는 것만 */
async function resolve(store: Store, tree: Tree, segs: string[]): Promise<Resolved> {
  let cur: string | null = null;
  const actual: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const f = tree.childFolder(cur, seg);
    if (f) {
      cur = f.id;
      actual.push(f.name);
      continue;
    }
    const rep = (await store.children(cur)).find((k) => k.kind === "report" && sameName(k.name, seg));
    if (rep && i === segs.length - 1) {
      return { found: true, node: rep, item: rep, path: formatPath([...actual, rep.name]) };
    }
    return {
      found: false,
      nearestId: cur,
      nearestPath: formatPath(actual),
      reportPath: rep ? formatPath([...actual, rep.name]) : undefined,
    };
  }
  if (cur === null) return { found: true, node: ROOT, path: "/" };
  return {
    found: true,
    node: { id: cur, kind: "folder", name: actual[actual.length - 1]!, parent_id: tree.parentOf(cur) },
    path: formatPath(actual),
  };
}

function isUnread(i: Item): boolean {
  if (i.kind !== "report" || !i.agent_updated_at) return false;
  return !i.read_at || Date.parse(i.agent_updated_at) > Date.parse(i.read_at);
}

function entry(i: Item, path: string): Record<string, unknown> {
  const e: Record<string, unknown> = { id: i.id, kind: i.kind, name: i.name, path };
  if (i.kind === "report") {
    e.report_kind = i.report_kind;
    if (isUnread(i)) e.unread = true;
  }
  e.updated_at = i.updated_at;
  return e;
}

function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name, "ko"),
  );
}

function listing(tree: Tree, parentId: string | null, items: Item[]) {
  const base = tree.segments(parentId);
  return sortItems(items).map((i) => entry(i, formatPath([...base, i.name])));
}

function counts(items: Item[]): string {
  const f = items.filter((i) => i.kind === "folder").length;
  const r = items.length - f;
  return items.length === 0 ? "빈 폴더" : `폴더 ${f} · 보고서 ${r}`;
}

async function notFound(store: Store, tree: Tree, input: string, r: Extract<Resolved, { found: false }>, lead?: string): Promise<ToolResult> {
  if (r.reportPath) {
    return fail(`경로 중간의 ${r.reportPath} 는 보고서입니다 — 보고서 안에는 들어갈 수 없습니다`, "NOT_FOUND", {
      nearest: { path: r.nearestPath },
    });
  }
  const items = await store.children(r.nearestId);
  return fail(`${lead ?? "없는 경로입니다"}: ${input} — 가장 가까운 폴더는 ${r.nearestPath}`, "NOT_FOUND", {
    nearest: { path: r.nearestPath, items: listing(tree, r.nearestId, items) },
  });
}

/** 보고서 문자열 값 중 q 가 든 첫 자리 앞뒤 (type·tag 는 빼고) */
function findInBlocks(blocks: unknown, q: string): string | null {
  const needle = q.toLowerCase();
  let hit: string | null = null;
  const walk = (x: unknown, key?: string): void => {
    if (hit !== null) return;
    if (typeof x === "string") {
      if (key === "type" || key === "tag") return;
      const at = x.toLowerCase().indexOf(needle);
      if (at >= 0) {
        const s = Math.max(0, at - 30);
        const e = Math.min(x.length, at + needle.length + 30);
        hit = (s > 0 ? "…" : "") + x.slice(s, e).replace(/\s+/g, " ") + (e < x.length ? "…" : "");
      }
    } else if (Array.isArray(x)) x.forEach((v) => walk(v));
    else if (isObj(x)) for (const [k, v] of Object.entries(x)) walk(v, k);
  };
  walk(blocks);
  return hit;
}

// ---------------------------------------------------------------------------

export function createDrawer({ store, agent, now = () => new Date() }: DrawerOptions) {
  async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await fn();
    } catch (e) {
      return fromError(e);
    }
  }

  /** target: uuid 면 id, 아니면 경로 */
  async function findTarget(tree: Tree, target: string): Promise<{ node: Node & { id: string }; path: string } | ToolResult> {
    if (typeof target !== "string" || target.trim() === "") return fail("target 이 비어 있습니다 (id 또는 /경로)", "BAD_INPUT");
    const t = target.trim();
    if (UUID.test(t)) {
      const item = await store.get(t);
      if (!item) return fail(`항목이 없습니다: ${t}`, "NOT_FOUND");
      return { node: item, path: tree.itemPath(item) };
    }
    const segs = parsePath(t);
    if (segs.length === 0) return fail("맨 위(/)는 옮기거나 이름을 바꾸거나 지울 수 없습니다", "BAD_INPUT");
    const r = await resolve(store, tree, segs);
    if (!r.found) return notFound(store, tree, t, r);
    return { node: r.node as Node & { id: string }, path: r.path };
  }

  return {
    // ---------------------------------------------------------------- list
    drawer_list: (args: { path?: string; query?: string } = {}) =>
      guard(async () => {
        const tree = await Tree.load(store);
        const input = args.path?.trim() || "/";
        const r = await resolve(store, tree, parsePath(input));
        if (!r.found) return notFound(store, tree, input, r);
        if (r.node.kind === "report") {
          return fail(`${r.path} 는 보고서입니다 — report_get 으로 읽으세요 (id ${r.node.id})`, "NOT_FOLDER", {
            item: entry(r.item!, r.path),
          });
        }
        const root = r.node.id;
        const query = args.query?.trim();

        if (!query) {
          const items = await store.children(root);
          return ok(`${r.path} — ${counts(items)}`, { path: r.path, items: listing(tree, root, items) });
        }

        // 찾기: 이름 먼저, 모자라면 본문
        const results: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        for (const i of await store.searchNames(query, 200)) {
          if (results.length >= SEARCH_LIMIT) break;
          const home = i.kind === "folder" ? i.id : i.parent_id;
          if (root !== null && (i.id === root || !tree.within(home, root))) continue;
          seen.add(i.id);
          results.push({ ...entry(i, tree.itemPath(i)), match: "name" });
        }
        for (let offset = 0; results.length < SEARCH_LIMIT; offset += SCAN_PAGE) {
          const page = await store.scanReports(offset, SCAN_PAGE);
          for (const rep of page) {
            if (results.length >= SEARCH_LIMIT) break;
            if (seen.has(rep.id) || !tree.within(rep.parent_id, root)) continue;
            const snippet = findInBlocks(rep.blocks, query);
            if (snippet === null) continue;
            seen.add(rep.id);
            results.push({ ...entry(rep, tree.itemPath(rep)), match: "body", snippet });
          }
          if (page.length < SCAN_PAGE) break;
        }
        const where = root === null ? "서랍 전체" : r.path;
        const more = results.length >= SEARCH_LIMIT ? ` (최대 ${SEARCH_LIMIT}개까지 보여 줌)` : "";
        return ok(`${where}에서 "${query}" — ${results.length}개${more}`, { path: r.path, query, items: results });
      }),

    // ---------------------------------------------------------------- mkdir
    drawer_mkdir: (args: { path: string }) =>
      guard(async () => {
        const segs = parsePath(args.path);
        if (segs.length === 0) return ok("맨 위(/)는 이미 있습니다", { id: null, path: "/", created: false });
        const tree = await Tree.load(store);
        let cur: string | null = null;
        const actual: string[] = [];
        const created: string[] = [];
        let lastId: string | null = null;
        /** cur 안의 seg 폴더: 있으면 그것, 없으면 만든다. 같은 이름 보고서가 있으면 그 보고서 */
        const ensure = async (parent: string | null, seg: string): Promise<{ folder: FolderNode } | { report: Item }> => {
          const known = tree.childFolder(parent, seg);
          if (known) return { folder: known };
          const kids = await store.children(parent);
          const same = kids.find((k) => sameName(k.name, seg));
          if (same?.kind === "report") return { report: same };
          if (same) return { folder: same };
          try {
            const ins = await store.insert({ kind: "folder", parent_id: parent, name: seg });
            created.push(formatPath([...actual, ins.name]));
            return { folder: ins };
          } catch (e) {
            // 그 사이 같은 이름 폴더가 생겼으면 그것을 쓴다
            if ((e as { code?: string }).code !== "23505") throw e;
            const again = (await store.children(parent)).find((k) => sameName(k.name, seg));
            if (again?.kind !== "folder") throw e;
            return { folder: again };
          }
        };
        try {
          for (const seg of segs) {
            const got = await ensure(cur, seg);
            if ("report" in got) {
              const at = formatPath([...actual, got.report.name]);
              return fail(`${at} 는 보고서입니다 — 그 자리에 폴더를 만들 수 없습니다`, "NOT_FOLDER", { created });
            }
            const f: FolderNode = { id: got.folder.id, parent_id: cur, name: got.folder.name };
            if (!tree.childFolder(cur, f.name)) tree.add(f);
            cur = f.id;
            lastId = f.id;
            actual.push(f.name);
          }
        } catch (e) {
          const r = fromError(e, { created });
          return created.length > 0 ? addNote(r, ` (앞서 만든 폴더: ${created.join(", ")})`) : r;
        }
        const path = formatPath(actual);
        return created.length > 0
          ? ok(`폴더를 만들었습니다: ${path}`, { id: lastId, path, created: true, created_paths: created })
          : ok(`이미 있습니다: ${path}`, { id: lastId, path, created: false });
      }),

    // ---------------------------------------------------------------- update
    drawer_update: (args: { target: string; move_to?: string; rename?: string; delete?: boolean }) =>
      guard(async () => {
        const hasMove = args.move_to !== undefined;
        const hasRename = args.rename !== undefined;
        const del = args.delete === true;
        if (del && (hasMove || hasRename)) {
          return fail("delete 는 move_to · rename 과 같이 쓸 수 없습니다 — 따로 부르세요", "BAD_INPUT");
        }
        if (!del && !hasMove && !hasRename) return fail("move_to · rename · delete(true) 중 하나를 주세요", "BAD_INPUT");

        const tree = await Tree.load(store);
        const t = await findTarget(tree, args.target);
        if ("ok" in t) return t;
        const { node, path } = t;

        if (del) {
          const batch = await store.remove(node.id);
          const inside = node.kind === "folder" ? " (안에 든 것까지)" : "";
          return ok(`휴지통으로 보냈습니다: ${path}${inside}`, { id: node.id, path, deleted: true, batch });
        }

        let parentId = node.parent_id;
        if (hasMove) {
          const dest = args.move_to!.trim();
          const r = await resolve(store, tree, parsePath(dest));
          if (!r.found) return notFound(store, tree, dest, r, "옮길 폴더가 없습니다");
          if (r.node.kind !== "folder") return fail(`${r.path} 는 보고서입니다 — 폴더로만 옮길 수 있습니다`, "NOT_FOLDER");
          parentId = r.node.id;
        }

        let name = node.name;
        if (hasRename) {
          const err = validateName(args.rename!);
          if (err) return fail(err, "BAD_NAME");
          name = normalizeName(args.rename!);
        }

        const siblings = (await store.children(parentId)).filter((s) => s.id !== node.id);
        let autoRenamed = false;
        if (hasRename) {
          const clash = siblings.find((s) => sameName(s.name, name));
          if (clash) {
            return fail(`같은 이름이 이미 있습니다: ${tree.itemPath(clash)} — 다른 이름을 주세요`, "NAME_TAKEN");
          }
        } else {
          const u = uniqueName(name, siblings.map((s) => s.name));
          autoRenamed = u !== name;
          name = u;
        }

        const patch: { parent_id?: string | null; name?: string } = {};
        if (parentId !== node.parent_id) patch.parent_id = parentId;
        if (name !== node.name) patch.name = name;
        if (Object.keys(patch).length === 0) return ok(`바뀐 것이 없습니다: ${path}`, { id: node.id, path, changed: false });

        const updated = await store.update(node.id, patch);
        if (!updated) return fail(`항목이 없습니다: ${path}`, "NOT_FOUND");
        const newPath = tree.itemPath({ parent_id: parentId, name });
        const summary =
          patch.parent_id !== undefined
            ? `옮겼습니다: ${path} → ${newPath}${autoRenamed ? ` (같은 이름이 있어 "${name}" 으로 바꿈)` : ""}`
            : `이름을 바꿨습니다: ${path} → ${newPath}`;
        return ok(summary, {
          id: node.id,
          kind: node.kind,
          old_path: path,
          path: newPath,
          changed: true,
          ...(autoRenamed ? { renamed_to: name } : {}),
        });
      }),

    // ---------------------------------------------------------------- create
    report_create: (args: { title: string; kind: string; folder: string; blocks: unknown }) =>
      guard(async () => {
        const kind = reportKindSchema.safeParse(args.kind);
        if (!kind.success) return fail(kind.error.issues[0]?.message ?? "보고서 종류가 맞지 않습니다", "BAD_INPUT");
        const titleErr = validateName(typeof args.title === "string" ? args.title : "");
        if (titleErr) return fail(`제목: ${titleErr}`, "BAD_NAME");

        const tree = await Tree.load(store);
        const folderInput = typeof args.folder === "string" ? args.folder.trim() : "";
        const r = await resolve(store, tree, parsePath(folderInput));
        if (!r.found) {
          const nf = await notFound(store, tree, folderInput, r, "폴더가 없습니다");
          return r.reportPath ? nf : addNote(nf, " (먼저 drawer_mkdir 로 만드세요)");
        }
        if (r.node.kind !== "folder") return fail(`${r.path} 는 보고서입니다 — folder 에는 폴더 경로를 주세요`, "NOT_FOLDER");

        const v = validateBlocks(args.blocks);
        if (!v.ok) {
          return fail(
            `블록 검사에서 ${v.errors.length}곳이 틀렸습니다 — errors 의 자리와 이유를 보고 고쳐 다시 넣으세요`,
            "INVALID_BLOCKS",
            { errors: v.errors satisfies BlockError[] },
          );
        }

        const title = normalizeName(args.title);
        for (let attempt = 0; ; attempt++) {
          const siblings = await store.children(r.node.id);
          const name = uniqueName(title, siblings.map((s) => s.name));
          try {
            const item = await store.insert({
              kind: "report",
              parent_id: r.node.id,
              name,
              report_kind: kind.data,
              blocks: v.blocks,
              schema_version: SCHEMA_VERSION,
              agent,
              agent_updated_at: now().toISOString(),
            });
            const path = tree.itemPath(item);
            const renamed = name !== title;
            return ok(
              `보고서를 넣었습니다: ${path}${renamed ? ` (같은 제목이 있어 "${name}" 으로 바꿈)` : ""}`,
              { id: item.id, path, title: name, renamed, version: item.version, blocks: v.blocks.length },
            );
          } catch (e) {
            if ((e as { code?: string }).code !== "23505" || attempt >= 2) throw e;
          }
        }
      }),

    // ---------------------------------------------------------------- get
    report_get: (args: { id: string; from?: number; to?: number }) =>
      guard(async () => {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!UUID.test(id)) return fail("id 는 보고서의 uuid 입니다 — drawer_list 로 찾으세요", "BAD_INPUT");
        const rep = await store.getReport(id);
        if (!rep) {
          const other = await store.get(id);
          return other
            ? fail("폴더입니다 — drawer_list 로 안을 보세요", "NOT_REPORT")
            : fail(`보고서가 없습니다: ${id}`, "NOT_FOUND");
        }
        const tree = await Tree.load(store);
        const path = tree.itemPath(rep);
        const blocks = Array.isArray(rep.blocks) ? rep.blocks : [];
        const n = blocks.length;

        if (args.from === undefined && args.to === undefined) {
          const outline = blocks.map((b, i) => {
            const o: Record<string, unknown> = { i, type: isObj(b) ? b.type : null };
            if (isObj(b) && typeof b.h === "string") o.h = b.h;
            return o;
          });
          const vb = blocks.find((b) => isObj(b) && b.type === "verdict") as Record<string, unknown> | undefined;
          const verdict = vb ? { v: vb.v, ...(vb.w !== undefined ? { w: vb.w } : {}) } : undefined;
          return ok(`${rep.name} — 블록 ${n}개, version ${rep.version}. 내용은 from·to 로 범위를 주고 읽으세요`, {
            id: rep.id,
            title: rep.name,
            kind: rep.report_kind,
            path,
            version: rep.version,
            updated_at: rep.updated_at,
            outline,
            ...(verdict ? { verdict } : {}),
          });
        }

        const from = args.from ?? 0;
        const to = args.to ?? n - 1;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= n) {
          return fail(`범위 밖입니다 (from ${args.from ?? "-"}, to ${args.to ?? "-"}) — 이 보고서의 블록은 0~${n - 1} 입니다`, "OUT_OF_RANGE", {
            total: n,
          });
        }
        return ok(`${rep.name} — 블록 ${from}~${to} / 전체 ${n}개 (version ${rep.version})`, {
          id: rep.id,
          version: rep.version,
          from,
          to,
          total: n,
          blocks: blocks.slice(from, to + 1),
        });
      }),

    // ---------------------------------------------------------------- edit
    report_edit: (args: { id: string; base_version: number; ops: unknown[] }) =>
      guard(async () => {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!UUID.test(id)) return fail("id 는 보고서의 uuid 입니다 — drawer_list 로 찾으세요", "BAD_INPUT");
        if (!Number.isInteger(args.base_version)) return fail("base_version 은 report_get 으로 받은 version(정수)입니다", "BAD_INPUT");
        if (!Array.isArray(args.ops) || args.ops.length === 0) return fail("ops 가 비어 있습니다", "BAD_INPUT");

        const rep = await store.getReport(id);
        if (!rep) return fail(`보고서가 없습니다: ${id}`, "NOT_FOUND");
        const conflict = (current: number) =>
          fail(`그 사이 다른 곳에서 고쳤습니다 (지금 version ${current}) — report_get 으로 다시 읽고 고치세요`, "EZ_VERSION", {
            conflict: true,
            current_version: current,
          });
        if (rep.version !== args.base_version) return conflict(rep.version);

        const blocks = [...rep.blocks];
        for (let k = 0; k < args.ops.length; k++) {
          const op = args.ops[k];
          const bad = (msg: string) => fail(`ops[${k}]: ${msg}`, "BAD_OP", { op_index: k });
          if (!isObj(op)) return bad("{ op, at, block? } 객체여야 합니다");
          const at = op.at;
          if (typeof at !== "number" || !Number.isInteger(at)) return bad("at 은 0 이상의 정수입니다");
          const n = blocks.length;
          switch (op.op) {
            case "insert":
              if (at < 0 || at > n) return bad(`insert 의 at 은 0~${n} 입니다 (지금 블록 ${n}개, ${n} 이면 맨 끝)`);
              if (op.block === undefined) return bad("insert 에는 block 이 필요합니다");
              blocks.splice(at, 0, op.block);
              break;
            case "replace":
              if (at < 0 || at >= n) return bad(`replace 의 at 은 0~${n - 1} 입니다`);
              if (op.block === undefined) return bad("replace 에는 block 이 필요합니다");
              blocks[at] = op.block;
              break;
            case "remove":
              if (at < 0 || at >= n) return bad(`remove 의 at 은 0~${n - 1} 입니다`);
              blocks.splice(at, 1);
              break;
            default:
              return bad("op 는 insert · replace · remove 중 하나입니다");
          }
        }

        const v = validateBlocks(blocks);
        if (!v.ok) {
          return fail(
            `고친 결과가 블록 검사에서 ${v.errors.length}곳 틀렸습니다 (자리는 ops 를 모두 적용한 뒤의 번호) — 아무것도 바꾸지 않았습니다`,
            "INVALID_BLOCKS",
            { errors: v.errors },
          );
        }

        const updated = await store.update(
          id,
          { blocks: v.blocks, agent, agent_updated_at: now().toISOString() },
          args.base_version,
        );
        if (!updated) {
          const cur = await store.get(id);
          return cur ? conflict(cur.version) : fail(`보고서가 없습니다: ${id}`, "NOT_FOUND");
        }
        return ok(`고쳤습니다: ${rep.name} — version ${updated.version}, 블록 ${v.blocks.length}개`, {
          id,
          version: updated.version,
          blocks: v.blocks.length,
        });
      }),
  };
}

export type Drawer = ReturnType<typeof createDrawer>;
