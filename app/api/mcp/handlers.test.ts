// 원격 MCP 라우트의 몸통을 PGlite(마이그레이션 전부) 위에서 돌려 본다 (docs/에이전트-연결.md 2 · 5장).
// 토큰은 진짜 ez_token_new 로 만들고 확인은 진짜 ez_token_check(service_role)로 한다. 스토어는 시험용(PGlite) — 두 가지 길(service · user)로.
// HTTP 는 Request → Response 그대로: initialize → tools/list → tools/call.

import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sampleBlocks } from "../../../lib/fixtures";
import { NO_IMAGES } from "../../../mcp/drawer";
import { PgliteMeetStore } from "../../../mcp/meet-store-pglite";
import { READ_ONLY_MESSAGE } from "../../../mcp/readonly";
import { PgliteScheduleStore } from "../../../mcp/schedule-store-pglite";
import { createTestDb, PgliteStore, type StoreRole } from "../../../mcp/store-pglite";
import { isWriteTool, READ_TOOLS, TOOL_NAMES } from "../../../mcp/tools";
import { bearer, handleMcp, MAX_BODY_BYTES, parseTokenInfo, RPC, type McpDeps } from "./handlers";
import { JWT_TTL_SEC, userJwt } from "./jwt";
import { Limiter, LIMIT_PER_MINUTE } from "./limit";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

type Row = Record<string, any>;
const URL_ = "https://ez.test/api/mcp";
const NOW = new Date("2026-10-01T03:00:00Z");

/** 역할을 정해 한 문장 (who: 사용자 id · "service" · "admin"(postgres)) */
async function sql(who: string, text: string, params: unknown[] = []): Promise<Row[]> {
  return db.transaction(async (tx) => {
    const sub = who === "service" || who === "admin" ? "" : who;
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    if (who === "service") await tx.exec("set local role service_role");
    else if (who !== "admin") await tx.exec("set local role authenticated");
    return (await tx.query<Row>(text, params)).rows;
  });
}

let n = 0;
async function member(): Promise<string> {
  const id = randomUUID();
  const login = `mcp${++n}`;
  await sql("admin", "insert into auth.users (id, email) values ($1, $2)", [id, `${login}@members.ra-kan.cloud`]);
  await sql("service", "insert into ez_members (user_id, login_id, name) values ($1, $2, '회원')", [id, login]);
  return id;
}

async function token(owner: string, scope: "rw" | "ro" = "rw"): Promise<{ id: string; token: string }> {
  return (await sql(owner, "select ez_token_new('시험', $1) as v", [scope]))[0]!.v;
}

function deps(as: StoreRole = "service", over: Partial<McpDeps> = {}): McpDeps {
  return {
    check: async (t) => parseTokenInfo((await sql("service", "select ez_token_check($1) as v", [t]))[0]!.v),
    stores: (owner) => ({
      drawer: new PgliteStore(db, owner, () => NOW, as),
      schedule: new PgliteScheduleStore(db, owner, as),
      meet: new PgliteMeetStore(db, owner, as),
    }),
    limiter: new Limiter(),
    now: () => NOW,
    ...over,
  };
}

function post(tok: string | null, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(tok === null ? {} : { authorization: `Bearer ${tok}` }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let rid = 0;
const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: ++rid, method, params });

/** JSON-RPC 한 번 → result (오류면 실패) */
async function ask(d: McpDeps, tok: string, method: string, params: unknown = {}): Promise<Row> {
  const res = await handleMcp(post(tok, rpc(method, params)), d);
  expect(res.status, await res.clone().text()).toBe(200);
  const out = (await res.json()) as Row;
  expect(out.error, JSON.stringify(out.error)).toBeUndefined();
  return out.result as Row;
}

/** 도구 한 번 → { ok, summary, data } */
async function call(d: McpDeps, tok: string, name: string, args: Row = {}): Promise<{ ok: boolean; summary: string; data: Row }> {
  const r = await ask(d, tok, "tools/call", { name, arguments: args });
  return { ok: r.isError !== true, summary: r.content[0].text as string, data: r.content[1] ? (JSON.parse(r.content[1].text) as Row) : {} };
}

/** 실패 응답: 상태 + JSON-RPC 오류 본문 */
async function refused(res: Response, status: number, code: number): Promise<Row> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  const out = (await res.json()) as Row;
  expect(out).toMatchObject({ jsonrpc: "2.0", id: null, error: { code } });
  expect(typeof out.error.message).toBe("string");
  return out;
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };

// ---------------------------------------------------------------------------

describe("인증", () => {
  it("토큰이 없거나 모양이 다르면 401 + JSON-RPC 오류 (DB 에 묻지 않는다)", async () => {
    let asked = 0;
    const d = deps("service", {
      check: async () => {
        asked++;
        return null;
      },
    });
    for (const req of [
      post(null, rpc("initialize", INIT)),
      post("", rpc("tools/list")),
      post("ezt_short", rpc("tools/list")),
      post(`ezt_${"a".repeat(39)}-`, rpc("tools/list")),
      post(`ezt_${"a".repeat(41)}`, rpc("tools/list")),
      post(`sk_${"a".repeat(41)}`, rpc("tools/list")),
      new Request(URL_, { method: "POST", headers: { authorization: `Basic ${"a".repeat(44)}`, "content-type": "application/json" }, body: "{}" }),
    ]) {
      const res = await handleMcp(req, d);
      const out = await refused(res, 401, RPC.AUTH);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
      expect(out.error.message).toContain("토큰");
    }
    expect(asked).toBe(0);
  });

  it("없는 토큰 · 폐기한 토큰 · 꺼진 회원의 토큰은 401", async () => {
    const d = deps();
    const a = await member();
    const t = await token(a);
    await refused(await handleMcp(post(`ezt_${"0".repeat(40)}`, rpc("tools/list")), d), 401, RPC.AUTH);
    expect((await ask(d, t.token, "tools/list")).tools).toHaveLength(TOOL_NAMES.length);

    await sql("admin", "update ez_members set active = false where user_id = $1", [a]);
    await refused(await handleMcp(post(t.token, rpc("tools/list")), d), 401, RPC.AUTH);
    await sql("admin", "update ez_members set active = true where user_id = $1", [a]);
    expect((await ask(d, t.token, "tools/list")).tools).toHaveLength(TOOL_NAMES.length);

    await sql(a, "update ez_tokens set revoked_at = now() where id = $1", [t.id]);
    await refused(await handleMcp(post(t.token, rpc("tools/list")), d), 401, RPC.AUTH);
  });

  it("쓰면 last_used_at 이 적힌다", async () => {
    const d = deps();
    const t = await token(await member());
    await ask(d, t.token, "tools/list");
    expect((await sql("admin", "select last_used_at from ez_tokens where id = $1", [t.id]))[0]!.last_used_at).toBeInstanceOf(Date);
  });

  it("토큰을 확인하지 못하면(DB 오류) 503, 서버 설정이 없으면 500 — 어느 쪽도 통과시키지 않는다", async () => {
    const t = await token(await member());
    const broken = deps("service", {
      check: async () => {
        throw new Error("Could not find the function public.ez_token_check");
      },
    });
    const out = await refused(await handleMcp(post(t.token, rpc("tools/list")), broken), 503, RPC.SERVER);
    expect(out.error.message).not.toContain("ez_token_check");
    await refused(await handleMcp(post(t.token, rpc("tools/list")), null), 500, RPC.SERVER);
    // 설정이 없어도 토큰이 없으면 401 이 먼저다
    await refused(await handleMcp(post(null, rpc("tools/list")), null), 401, RPC.AUTH);
  });

  it("확인 함수가 준 모양이 다르면 통과시키지 않는다", () => {
    const id = randomUUID();
    const owner = randomUUID();
    expect(parseTokenInfo({ id, owner, scope: "rw" })).toEqual({ id, owner, scope: "rw" });
    expect(parseTokenInfo({ id, owner, scope: "ro" })).toEqual({ id, owner, scope: "ro" });
    // 모르는 범위는 읽기만
    expect(parseTokenInfo({ id, owner, scope: "admin" })?.scope).toBe("ro");
    expect(parseTokenInfo({ id, owner })?.scope).toBe("ro");
    for (const v of [null, undefined, "", [], { id }, { owner }, { id: "x", owner }, { id, owner: "*" }, { id, owner: null }]) expect(parseTokenInfo(v)).toBeNull();
  });

  it("Authorization 머리에서 토큰만 꺼낸다", () => {
    const tok = `ezt_${"aB3".repeat(13)}x`;
    const req = (v: string) => new Request(URL_, { method: "POST", headers: { authorization: v } });
    expect(bearer(req(`Bearer ${tok}`))).toBe(tok);
    expect(bearer(req(`bearer   ${tok}`))).toBe(tok);
    expect(bearer(req(tok))).toBeNull();
    expect(bearer(req(`Bearer ${tok} extra`))).toBeNull();
    expect(bearer(req(`Bearer ${tok}!`))).toBeNull();
  });
});

describe("전송 — Streamable HTTP, 상태 없음", () => {
  it("POST 만 받는다 (GET · DELETE 는 405)", async () => {
    const d = deps();
    const t = await token(await member());
    for (const method of ["GET", "DELETE"]) {
      const res = await handleMcp(new Request(URL_, { method, headers: { authorization: `Bearer ${t.token}`, accept: "text/event-stream" } }), d);
      await refused(res, 405, RPC.BAD);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("initialize → tools/list → tools/call 이 요청마다 따로 돈다 (세션 없음, JSON 응답)", async () => {
    const d = deps();
    const t = await token(await member());
    const res = await handleMcp(post(t.token, rpc("initialize", INIT)), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const init = ((await res.json()) as Row).result as Row;
    expect(init.serverInfo).toMatchObject({ name: "ezwork" });
    expect(init.capabilities.tools).toBeDefined();

    // 알림은 202
    expect((await handleMcp(post(t.token, { jsonrpc: "2.0", method: "notifications/initialized" }), d)).status).toBe(202);

    const list = await ask(d, t.token, "tools/list");
    expect((list.tools as Row[]).map((x) => x.name).sort()).toEqual([...TOOL_NAMES].sort());

    const made = await call(d, t.token, "drawer_mkdir", { path: "/원격" });
    expect(made.ok, made.summary).toBe(true);
    expect(made.data.url).toMatch(/^https:\/\/ez\.test\/drawer\/f\//);
    const root = await call(d, t.token, "drawer_list", {});
    expect((root.data.items as Row[]).map((i) => i.name)).toEqual(["원격"]);
  });

  it("진짜 MCP 클라이언트(SDK 의 Streamable HTTP)로 연결 → 목록 → 호출 → 끊기", async () => {
    const d = deps();
    const t = await token(await member());
    const seen: string[] = [];
    const transport = new StreamableHTTPClientTransport(new URL(URL_), {
      requestInit: { headers: { Authorization: `Bearer ${t.token}` } },
      fetch: async (input, init) => {
        const req = new Request(input, init);
        const res = await handleMcp(req, d);
        seen.push(`${req.method} ${res.status}`);
        return res;
      },
    });
    const client = new Client({ name: "ez-test", version: "0" });
    await client.connect(transport);
    expect(client.getServerVersion()).toMatchObject({ name: "ezwork" });
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...TOOL_NAMES].sort());
    const made = (await client.callTool({ name: "drawer_mkdir", arguments: { path: "/클라이언트" } })) as Row;
    expect(made.isError).toBeUndefined();
    expect(made.content[0].text).toContain("폴더를 만들었습니다: /클라이언트");
    const bad = (await client.callTool({ name: "report_get", arguments: { id: randomUUID() } })) as Row;
    expect(bad.isError).toBe(true);
    await client.close();
    // 세션이 없으니 스트림 열기(GET)는 405 로 답하고 클라이언트는 그대로 쓴다. 끊을 때 DELETE 도 보내지 않는다
    expect(seen.filter((x) => x.startsWith("POST")).every((x) => x === "POST 200" || x === "POST 202")).toBe(true);
    expect(seen.filter((x) => !x.startsWith("POST")).every((x) => x === "GET 405")).toBe(true);

    // 토큰이 틀리면 연결이 안 된다
    const wrong = new StreamableHTTPClientTransport(new URL(URL_), {
      requestInit: { headers: { Authorization: `Bearer ezt_${"0".repeat(40)}` } },
      fetch: async (input, init) => handleMcp(new Request(input, init), d),
    });
    await expect(new Client({ name: "ez-test", version: "0" }).connect(wrong)).rejects.toThrow();
  });

  it("본문이 1MB 를 넘으면 413, JSON 이 아니면 400", async () => {
    const d = deps();
    const t = await token(await member());
    const big = JSON.stringify(rpc("tools/call", { name: "drawer_mkdir", arguments: { path: `/${"가".repeat(MAX_BODY_BYTES)}` } }));
    const res = await handleMcp(post(t.token, big, { "content-length": String(Buffer.byteLength(big)) }), d);
    expect(res.status).toBe(413);
    // 길이를 안 알려 줘도 읽다가 막는다
    expect((await handleMcp(post(t.token, big), d)).status).toBe(413);
    expect((await handleMcp(post(t.token, "{"), d)).status).toBe(400);
  });

  it("토큰당 1분 120회 — 넘으면 429 + Retry-After, 1분 뒤 다시 된다. 다른 토큰은 따로 센다", async () => {
    let clock = NOW.getTime();
    const d = deps("service", { limiter: new Limiter(), now: () => new Date(clock) });
    const a = await member();
    const t = await token(a);
    const other = await token(a);
    for (let i = 0; i < LIMIT_PER_MINUTE; i++) {
      clock += 100;
      expect((await handleMcp(post(t.token, { jsonrpc: "2.0", method: "notifications/initialized" }), d)).status).toBe(202);
    }
    const res = await handleMcp(post(t.token, rpc("tools/list")), d);
    const out = await refused(res, 429, RPC.RATE);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(out.error.message).toContain("120");
    expect((await ask(d, other.token, "tools/list")).tools).toHaveLength(TOOL_NAMES.length);
    clock = NOW.getTime() + 61_000;
    expect((await ask(d, t.token, "tools/list")).tools).toHaveLength(TOOL_NAMES.length);
  });
});

describe.each(["service", "user"] as const)("도구 — %s", (as) => {
  it("읽기만 되는 토큰: 쓰는 도구가 목록에 없고, 불러도 안 되고, 읽는 도구는 DB 를 한 줄도 바꾸지 않는다", async () => {
    const d = deps(as);
    const a = await member();
    const rw = await token(a);
    const ro = await token(a, "ro");
    expect((await call(d, rw.token, "todo_save", { title: "반복 할 일", repeat: { freq: "daily" } })).ok).toBe(true);
    expect((await call(d, rw.token, "drawer_mkdir", { path: "/읽기" })).ok).toBe(true);

    const names = ((await ask(d, ro.token, "tools/list")).tools as Row[]).map((x) => x.name).sort();
    expect(names).toEqual([...READ_TOOLS].sort());
    expect(names.some(isWriteTool)).toBe(false);
    expect(names).toEqual(["drawer_list", "meet_get", "report_get", "schedule_get", "todo_list", "work_log"]);

    for (const name of TOOL_NAMES.filter(isWriteTool)) {
      const res = await handleMcp(post(ro.token, rpc("tools/call", { name, arguments: {} })), d);
      const out = (await res.json()) as Row;
      const failed = out.error !== undefined || out.result?.isError === true;
      expect(failed, `${name}: ${JSON.stringify(out)}`).toBe(true);
      expect(JSON.stringify(out)).toMatch(/not found|찾을 수 없|없는 도구/i);
    }

    // 읽는 도구는 된다 — 그리고 아무것도 안 바뀐다 (todo_list 의 반복 회차 만들기 · 역할 기본 셋 넣기도 건너뛴다)
    const count = async () => (await sql("admin", "select (select count(*) from ez_tasks where owner = $1)::int as tasks, (select count(*) from ez_roles where owner = $1)::int as roles, (select max(last_made)::text from ez_task_rules where owner = $1) as made", [a]))[0]!;
    await sql("admin", "update ez_roles set deleted_at = now() where owner = $1", [a]);
    const before = await count();
    const later = deps(as, { now: () => new Date("2026-10-03T03:00:00Z") });
    for (const [name, args] of [
      ["drawer_list", {}],
      ["schedule_get", { from: "2026-10-05", to: "2026-10-11" }],
      ["todo_list", { status: "all" }],
      ["todo_list", { status: "rules" }],
      ["work_log", { from: "2026-10-01", to: "2026-10-07" }],
      ["meet_get", {}],
    ] as const) {
      const r = await call(later, ro.token, name, args);
      expect(r.ok, `${name}: ${r.summary}`).toBe(true);
    }
    expect(await count()).toEqual(before);
    // 같은 때 읽고 쓰기 토큰으로 부르면 새 회차가 생긴다 (건너뛴 것이 맞다)
    expect((await call(later, rw.token, "todo_list", { status: "all" })).ok).toBe(true);
    expect((await count()).tasks).toBeGreaterThan(before.tasks);
  });

  it("읽기만 되는 스토어는 쓰는 메서드를 거절한다 (도구 등록과 따로 한 번 더)", async () => {
    const { readOnlyMeet, readOnlySchedule, readOnlyStore } = await import("../../../mcp/readonly");
    const a = await member();
    const s = deps(as).stores(a);
    await expect(readOnlyStore(s.drawer).insert({ kind: "folder", parent_id: null, name: "x" })).rejects.toThrow(READ_ONLY_MESSAGE);
    await expect(readOnlyStore(s.drawer).uploadImage(`${a}/x.webp`, new Uint8Array())).rejects.toThrow(READ_ONLY_MESSAGE);
    await expect(readOnlySchedule(s.schedule).insertTask({ title: "x", note: null, due: null, est_min: null, sort: 1, done_at: null })).rejects.toThrow(READ_ONLY_MESSAGE);
    await expect(readOnlySchedule(s.schedule).workStop()).rejects.toThrow(READ_ONLY_MESSAGE);
    await expect(readOnlyMeet(s.meet).insertMeet({ title: "x" })).rejects.toThrow(READ_ONLY_MESSAGE);
    expect(await readOnlySchedule(s.schedule).roll("2026-10-01", 0)).toBe(0);
    expect(await readOnlySchedule(s.schedule).seedRoles()).toBe(0);
    expect(readOnlyStore(s.drawer).owner).toBe(a);
    expect(await readOnlyStore(s.drawer).folders()).toEqual([]);
    expect(await sql("admin", "select 1 from ez_items where owner = $1 union all select 1 from ez_tasks where owner = $1 union all select 1 from ez_roles where owner = $1", [a])).toEqual([]);
  });

  it("사진 블록은 거절한다 — 서버의 파일을 읽지 않는다", async () => {
    const d = deps(as);
    const t = await token(await member());
    // 실제로 있는 파일을 줘도 열어 보지 않는다 (열었다면 '사진이 아닙니다' 류의 다른 오류가 난다)
    const file = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const image = { type: "image", file, alt: "침입", place: "full", credit: "x" };
    const made = await call(d, t.token, "report_create", { title: "사진", kind: "data", folder: "/", blocks: [...sampleBlocks(), image] });
    expect(made.ok).toBe(false);
    expect(made.summary).toContain(NO_IMAGES);
    expect(made.data.error.code).toBe("NO_IMAGES");
    expect((await call(d, t.token, "drawer_list", {})).data.items).toEqual([]);

    const rep = await call(d, t.token, "report_create", { title: "글", kind: "data", folder: "/", blocks: sampleBlocks() });
    expect(rep.ok, rep.summary).toBe(true);
    for (const op of ["insert", "replace"]) {
      const r = await call(d, t.token, "report_edit", { id: rep.data.id, base_version: rep.data.version, ops: [{ op, at: 0, block: image }] });
      expect(r.ok).toBe(false);
      expect(r.summary).toContain(NO_IMAGES);
    }
    // 이미 올린 사진을 가리키는 것처럼 src 를 줘도 안 받는다
    const src = await call(d, t.token, "report_edit", { id: rep.data.id, base_version: rep.data.version, ops: [{ op: "insert", at: 0, block: { type: "image", src: `${randomUUID()}/${"a".repeat(64)}.webp`, w: 1, h: 1, alt: "x", place: "full", local_path: "/etc/passwd" } }] });
    expect(src.summary).toContain(NO_IMAGES);
    // 글 블록 고치기는 된다
    const ok = await call(d, t.token, "report_edit", { id: rep.data.id, base_version: rep.data.version, ops: [{ op: "insert", at: 0, block: { type: "text", body: "원격에서 넣은 글" } }] });
    expect(ok.ok, ok.summary).toBe(true);
    // 도구 설명에도 file 로 사진을 넣으라는 말이 없다
    const tools = (await ask(d, t.token, "tools/list")).tools as Row[];
    const desc = tools.find((x) => x.name === "report_create")!.description as string;
    expect(desc).toContain("원격");
    expect(desc).not.toContain("PC 사진 절대 경로");
    expect(tools.find((x) => x.name === "report_edit")!.description).not.toContain("file 로 준다");
  });

  it("토큰의 주인 것만: 을의 토큰으로 갑의 보고서 · 일정 · 할 일 · 모임을 못 읽고 못 고친다", async () => {
    const d = deps(as);
    const [ta, tb] = [await token(await member()), await token(await member())];
    const rep = await call(d, ta.token, "report_create", { title: "갑비밀 보고서", kind: "data", folder: "/", blocks: sampleBlocks() });
    const ev = await call(d, ta.token, "schedule_save", { title: "갑비밀 일정", date: "2026-10-06", start: "10:00", end: "11:00" });
    const todo = await call(d, ta.token, "todo_save", { title: "갑비밀 할 일" });
    const meet = await call(d, ta.token, "meet_save", { title: "갑비밀 모임", date: "2026-10-07", start: "19:00" });
    for (const r of [rep, ev, todo, meet]) expect(r.ok, r.summary).toBe(true);

    const tries: [string, Row][] = [
      ["drawer_list", {}],
      ["report_get", { id: rep.data.id }],
      ["report_edit", { id: rep.data.id, base_version: rep.data.version, ops: [{ op: "remove", at: 0 }] }],
      ["drawer_update", { target: rep.data.id, delete: true }],
      ["schedule_get", { from: "2026-10-05", to: "2026-10-11" }],
      ["schedule_save", { id: ev.data.event.id, base_version: ev.data.event.version, title: "침입" }],
      ["schedule_delete", { id: ev.data.event.id }],
      ["todo_list", { status: "all" }],
      ["todo_save", { id: todo.data.task.id, base_version: todo.data.task.version, done: true }],
      ["work_log", { from: "2026-10-01", to: "2026-10-07" }],
      ["meet_get", {}],
      ["meet_get", { id: meet.data.meet.id }],
      ["meet_save", { id: meet.data.meet.id, base_version: meet.data.meet.version, delete: true }],
    ];
    for (const [name, args] of tries) {
      const r = await call(d, tb.token, name, args);
      expect(`${r.summary}${JSON.stringify(r.data)}`, name).not.toContain("갑비밀");
      if ("id" in args || "target" in args) expect(r.ok, `${name}: ${r.summary}`).toBe(false);
    }
    // 갑의 것은 그대로
    expect((await call(d, ta.token, "report_get", { id: rep.data.id })).data.version).toBe(rep.data.version);
    expect((await call(d, ta.token, "schedule_get", { from: "2026-10-05", to: "2026-10-11" })).summary).toContain("일정 2개");
    expect(((await call(d, ta.token, "todo_list", {})).data.items as Row[]).map((x) => x.title)).toEqual(["갑비밀 할 일"]);
  });
});

describe("주인의 JWT (가)", () => {
  it("HS256 으로 서명하고 sub · role · 짧은 수명을 싣는다", () => {
    const owner = randomUUID();
    const jwt = userJwt("비밀-secret", owner, NOW);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ sub: owner, role: "authenticated", aud: "authenticated", iat, exp: iat + JWT_TTL_SEC });
    expect(s).toBe(createHmac("sha256", "비밀-secret").update(`${h}.${p}`).digest("base64url"));
    expect(userJwt("다른 비밀", owner, NOW).split(".")[2]).not.toBe(s);
  });
});
