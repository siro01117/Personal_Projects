// MCP 도구 6개를 진짜 DB 규칙(PGlite + 마이그레이션, service_role) 위에서 시험한다.

import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sampleBlocks } from "../lib/fixtures";
import { createDrawer, type Drawer, type ToolResult } from "./drawer";
import { PgliteStore, createTestDb } from "./store-pglite";
import { createSchedule } from "./schedule";
import { PgliteScheduleStore } from "./schedule-store-pglite";
import { createMeet } from "./meet";
import { PgliteMeetStore } from "./meet-store-pglite";
import { DRAWER_TOOLS, TOOL_NAMES, registerTools } from "./tools";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

type Row = Record<string, any>;

function setup(owner = randomUUID()) {
  const store = new PgliteStore(db, owner);
  const drawer = createDrawer({ store, agent: "Claude Code" });
  return { owner, store, drawer };
}

async function raw(id: string): Promise<Row> {
  return (await db.query<Row>("select * from ez_items where id = $1", [id])).rows[0]!;
}

function good(r: ToolResult): Row {
  expect(r.ok, `${r.summary}\n${JSON.stringify(r.data)}`).toBe(true);
  return r.data as Row;
}
function bad(r: ToolResult, code?: string): Row {
  expect(r.ok, `실패해야 합니다: ${r.summary}`).toBe(false);
  const d = r.data as Row;
  expect(d.error.message).toBe(r.summary);
  if (code) expect(d.error.code).toBe(code);
  return d;
}

async function newReport(d: Drawer, folder: string, title: string, blocks: unknown[] = sampleBlocks()) {
  const r = await d.report_create({ title, kind: "data", folder, blocks });
  return good(r) as { id: string; path: string; version: number; title: string };
}

// ---------------------------------------------------------------------------

describe("drawer_mkdir", () => {
  it("중간 폴더까지 만들고, 다시 하면 created: false", async () => {
    const { drawer } = setup();
    const a = good(await drawer.drawer_mkdir({ path: "/EZ.WORK 준비/APPTIVE" }));
    expect(a.created).toBe(true);
    expect(a.path).toBe("/EZ.WORK 준비/APPTIVE");
    expect(a.created_paths).toEqual(["/EZ.WORK 준비", "/EZ.WORK 준비/APPTIVE"]);
    const again = await drawer.drawer_mkdir({ path: "/ez.work 준비/apptive/" });
    expect(good(again)).toMatchObject({ created: false, id: a.id, path: "/EZ.WORK 준비/APPTIVE" });
    expect(again.summary).toContain("이미 있습니다");
  });

  it("맨 위(/)는 이미 있다", async () => {
    const { drawer } = setup();
    expect(good(await drawer.drawer_mkdir({ path: "/" }))).toMatchObject({ created: false, path: "/" });
  });

  it("경로 중간에 같은 이름 보고서가 있으면 오류", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/A" }));
    await newReport(drawer, "/A", "보고서");
    const d = bad(await drawer.drawer_mkdir({ path: "/A/보고서/B" }), "NOT_FOLDER");
    expect(d.error.message).toContain("/A/보고서 는 보고서입니다");
    // 마지막 조각이 보고서여도
    bad(await drawer.drawer_mkdir({ path: "/a/보고서" }), "NOT_FOLDER");
  });

  it("경로 규칙 위반은 lib 의 한국어 오류", async () => {
    const { drawer } = setup();
    expect(bad(await drawer.drawer_mkdir({ path: "상대/경로" }), "BAD_PATH").error.message).toContain("/ 로 시작");
    expect(bad(await drawer.drawer_mkdir({ path: "/a//b" }), "BAD_PATH").error.message).toContain("비어 있습니다");
    bad(await drawer.drawer_mkdir({ path: "/a/.." }), "BAD_PATH");
  });

  it("깊이 초과(9단)는 DB 오류를 한국어로, 이번에 만든 폴더는 되돌린다", async () => {
    const { drawer } = setup();
    const r = await drawer.drawer_mkdir({ path: "/1/2/3/4/5/6/7/8/9" });
    const d = bad(r, "EZ_DEPTH");
    expect(r.summary).toMatch(/^폴더는 8단까지만 넣을 수 있습니다/);
    expect(r.summary).toContain("이번에 만든 폴더 8개는 되돌렸습니다");
    expect(r.summary).not.toContain("[EZ_");
    expect(d.rolled_back).toHaveLength(8);
    expect(good(await drawer.drawer_list({})).items).toEqual([]);
  });

  it("되돌릴 때 원래 있던 폴더와 그 안의 것은 건드리지 않는다", async () => {
    const { drawer, owner } = setup();
    good(await drawer.drawer_mkdir({ path: "/1/2/3/4/5/6" }));
    const keep = await newReport(drawer, "/1/2/3/4/5/6", "원래 있던 보고서");
    const r = await drawer.drawer_mkdir({ path: "/1/2/3/4/5/6/새7/새8/새9" });
    expect(bad(r, "EZ_DEPTH").rolled_back).toEqual(["/1/2/3/4/5/6/새7", "/1/2/3/4/5/6/새7/새8"]);
    const six = good(await drawer.drawer_list({ path: "/1/2/3/4/5/6" }));
    expect(six.items.map((i: Row) => i.name)).toEqual(["원래 있던 보고서"]);
    expect((await raw(keep.id)).deleted_at).toBeNull();
    const alive = await db.query<Row>("select count(*)::int n from ez_items where owner = $1 and deleted_at is null", [owner]);
    expect(alive.rows[0]!.n).toBe(7);
    // 지운 것은 휴지통에 한 묶음으로
    const trashed = await db.query<Row>("select name, deleted_batch from ez_items where owner = $1 and deleted_at is not null", [owner]);
    expect(trashed.rows.map((x) => x.name).sort()).toEqual(["새7", "새8"]);
    expect(new Set(trashed.rows.map((x) => x.deleted_batch)).size).toBe(1);
  });

  it("되돌리기마저 실패하면 남은 폴더를 알려준다", async () => {
    const { store } = setup();
    const broken = Object.create(store) as typeof store;
    broken.remove = async () => {
      throw new Error("연결 끊김");
    };
    const drawer = createDrawer({ store: broken, agent: "Claude Code" });
    const r = await drawer.drawer_mkdir({ path: "/1/2/3/4/5/6/7/8/9" });
    const d = bad(r, "EZ_DEPTH");
    expect(r.summary).toContain("되돌리지 못했습니다");
    expect(d.created).toHaveLength(8);
  });
});

describe("drawer_list", () => {
  it("폴더 먼저, 한국어 이름순. 항목 모양", async () => {
    const { drawer } = setup();
    for (const p of ["/top/하나", "/top/가나", "/top/Zeta", "/top/alpha"]) good(await drawer.drawer_mkdir({ path: p }));
    await newReport(drawer, "/top", "다 보고서");
    await newReport(drawer, "/top", "가 보고서");
    const d = good(await drawer.drawer_list({ path: "/top" }));
    expect(d.items.map((i: Row) => i.name)).toEqual(["가나", "하나", "alpha", "Zeta", "가 보고서", "다 보고서"]);
    const folder = d.items[0];
    expect(Object.keys(folder).sort()).toEqual(["id", "kind", "name", "path", "updated_at", "url"]);
    expect(folder.url).toBe(`http://localhost:3200/drawer/f/${folder.id}`);
    const rep = d.items[4];
    expect(rep).toMatchObject({ kind: "report", path: "/top/가 보고서", report_kind: "data", unread: true });
  });

  it("기본은 맨 위, 빈 서랍은 빈 목록", async () => {
    const { drawer } = setup();
    const r = await drawer.drawer_list({});
    expect(good(r)).toMatchObject({ path: "/", items: [] });
    expect(r.summary).toContain("빈 폴더");
  });

  it("대소문자 다른 경로도 찾고, 실제 이름으로 돌려준다", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/Alpha/Beta" }));
    await newReport(drawer, "/Alpha/Beta", "Report One");
    const d = good(await drawer.drawer_list({ path: "/ALPHA/beta" }));
    expect(d.path).toBe("/Alpha/Beta");
    expect(d.items[0].path).toBe("/Alpha/Beta/Report One");
  });

  it("없는 경로 → 오류 + 가장 가까운 폴더와 그 안 목록", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/a/b" }));
    good(await drawer.drawer_mkdir({ path: "/a/c" }));
    const r = await drawer.drawer_list({ path: "/a/x/y" });
    const d = bad(r, "NOT_FOUND");
    expect(r.summary).toContain("/a/x/y");
    expect(d.nearest.path).toBe("/a");
    expect(d.nearest.items.map((i: Row) => i.name)).toEqual(["b", "c"]);
    // 맨 위부터 없으면 / 를 제안
    expect(bad(await drawer.drawer_list({ path: "/없음" })).nearest.path).toBe("/");
  });

  it("보고서 경로를 주면 report_get 으로 안내", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/f" }));
    const rep = await newReport(drawer, "/f", "r");
    const r = await drawer.drawer_list({ path: "/f/r" });
    bad(r, "NOT_FOLDER");
    expect(r.summary).toContain(rep.id);
  });

  it("query: 이름·본문 찾기, 경로 포함, path 아래로 좁힘", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/조사/PGlite 폴더" }));
    good(await drawer.drawer_mkdir({ path: "/다른 곳" }));
    await newReport(drawer, "/조사", "DB 시험 방법");
    await newReport(drawer, "/다른 곳", "딴 보고서", [{ type: "text", body: "여기에도 pglite 가 나온다" }]);
    await newReport(drawer, "/다른 곳", "무관", [{ type: "text", body: "상관없는 글" }]);

    const all = good(await drawer.drawer_list({ query: "pglite" }));
    const byName = Object.fromEntries(all.items.map((i: Row) => [i.name, i]));
    expect(byName["PGlite 폴더"]).toMatchObject({ match: "name", path: "/조사/PGlite 폴더", kind: "folder" });
    expect(byName["DB 시험 방법"]).toMatchObject({ match: "body", path: "/조사/DB 시험 방법" });
    expect(byName["딴 보고서"].snippet).toContain("pglite");
    expect(byName["무관"]).toBeUndefined();
    // type·tag 같은 키 이름으로는 걸리지 않는다
    expect(good(await drawer.drawer_list({ query: "sources" })).items).toEqual([]);

    const scoped = good(await drawer.drawer_list({ path: "/조사", query: "PGLITE" }));
    expect(scoped.items.map((i: Row) => i.name).sort()).toEqual(["DB 시험 방법", "PGlite 폴더"]);
  });

  it("query 는 최대 20개", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/많음" }));
    for (let i = 0; i < 23; i++) good(await drawer.drawer_mkdir({ path: `/많음/항목 ${i}` }));
    const r = await drawer.drawer_list({ query: "항목" });
    expect(good(r).items).toHaveLength(20);
    expect(r.summary).toContain("최대 20개");
  });

  it("LIKE 특수문자(% _)는 글자 그대로 찾는다", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/100% 확신" }));
    good(await drawer.drawer_mkdir({ path: "/1000 확신" }));
    const d = good(await drawer.drawer_list({ query: "0%" }));
    expect(d.items.map((i: Row) => i.name)).toEqual(["100% 확신"]);
  });
});

describe("drawer_update", () => {
  it("옮기기 — 새 경로를 돌려준다. id 로도 경로로도", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/src" }));
    good(await drawer.drawer_mkdir({ path: "/dst" }));
    const rep = await newReport(drawer, "/src", "옮길 것");
    const d = good(await drawer.drawer_update({ target: rep.id, move_to: "/dst" }));
    expect(d).toMatchObject({ path: "/dst/옮길 것", old_path: "/src/옮길 것", changed: true });
    const back = good(await drawer.drawer_update({ target: "/DST/옮길 것", move_to: "/" }));
    expect(back.path).toBe("/옮길 것");
    expect((await raw(rep.id)).parent_id).toBeNull();
  });

  it("옮길 곳에 같은 이름이 있으면 (2) 붙여 옮기고 알린다", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/a/메모" }));
    good(await drawer.drawer_mkdir({ path: "/b/메모" }));
    const r = await drawer.drawer_update({ target: "/b/메모", move_to: "/a" });
    const d = good(r);
    expect(d.path).toBe("/a/메모 (2)");
    expect(d.renamed_to).toBe("메모 (2)");
    expect(r.summary).toContain("메모 (2)");
  });

  it("move_to + rename 이면 rename 이 우선, 겹치면 거절", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/a/있음" }));
    good(await drawer.drawer_mkdir({ path: "/b/x" }));
    bad(await drawer.drawer_update({ target: "/b/x", move_to: "/a", rename: "있음" }), "NAME_TAKEN");
    const d = good(await drawer.drawer_update({ target: "/b/x", move_to: "/a", rename: "새 이름" }));
    expect(d.path).toBe("/a/새 이름");
    expect(d.renamed_to).toBeUndefined();
  });

  it("rename: 겹치면 거절(대소문자 무시), 자기 대소문자만 바꾸기는 된다", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/Hello" }));
    good(await drawer.drawer_mkdir({ path: "/other" }));
    const r = await drawer.drawer_update({ target: "/other", rename: "HELLO" });
    bad(r, "NAME_TAKEN");
    expect(r.summary).toContain("/Hello");
    expect(good(await drawer.drawer_update({ target: "/hello", rename: "  HELLO " })).path).toBe("/HELLO");
    bad(await drawer.drawer_update({ target: "/other", rename: "a/b" }), "BAD_NAME");
    bad(await drawer.drawer_update({ target: "/other", rename: "   " }), "BAD_NAME");
  });

  it("바뀐 것이 없으면 changed: false", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/p/q" }));
    expect(good(await drawer.drawer_update({ target: "/p/q", move_to: "/p" })).changed).toBe(false);
  });

  it("delete 와 move/rename 을 같이 주면 거절, 아무것도 없으면 거절", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/x" }));
    bad(await drawer.drawer_update({ target: "/x", delete: true, move_to: "/" }), "BAD_INPUT");
    bad(await drawer.drawer_update({ target: "/x", delete: true, rename: "y" }), "BAD_INPUT");
    bad(await drawer.drawer_update({ target: "/x" }), "BAD_INPUT");
    bad(await drawer.drawer_update({ target: "/x", delete: false }), "BAD_INPUT");
    bad(await drawer.drawer_update({ target: "/", rename: "뿌리" }), "BAD_INPUT");
  });

  it("delete: 폴더째 휴지통(같은 묶음), 목록에서 사라짐", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/지울/안쪽" }));
    const rep = await newReport(drawer, "/지울/안쪽", "r");
    const r = await drawer.drawer_update({ target: "/지울", delete: true });
    const d = good(r);
    expect(r.summary).toContain("안에 든 것까지");
    const row = await raw(rep.id);
    expect(row.deleted_batch).toBe(d.batch);
    expect(good(await drawer.drawer_list({})).items).toEqual([]);
    bad(await drawer.drawer_update({ target: rep.id, delete: true }), "NOT_FOUND");
  });

  it("순환 이동은 DB 오류를 한국어로", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/a/b/c" }));
    const r = await drawer.drawer_update({ target: "/a", move_to: "/a/b/c" });
    bad(r, "EZ_CYCLE");
    expect(r.summary).toBe("폴더를 자기 자신이나 자기 안의 폴더로 옮길 수 없습니다");
    bad(await drawer.drawer_update({ target: "/a", move_to: "/a" }), "EZ_CYCLE");
  });

  it("옮겨서 8단을 넘으면 거절", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/1/2/3/4/5/6/7" }));
    good(await drawer.drawer_mkdir({ path: "/x/y" }));
    const r = await drawer.drawer_update({ target: "/x", move_to: "/1/2/3/4/5/6/7" });
    bad(r, "EZ_DEPTH");
    expect(r.summary).toContain("8단");
  });

  it("없는 곳으로 옮기기 · 보고서 안으로 옮기기", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/a" }));
    await newReport(drawer, "/a", "r");
    const d = bad(await drawer.drawer_update({ target: "/a", move_to: "/없는/곳" }), "NOT_FOUND");
    expect(d.nearest.path).toBe("/");
    good(await drawer.drawer_mkdir({ path: "/b" }));
    bad(await drawer.drawer_update({ target: "/b", move_to: "/a/r" }), "NOT_FOLDER");
    bad(await drawer.drawer_update({ target: "/b", move_to: "/a/r/c" }), "NOT_FOUND");
  });
});

describe("report_create", () => {
  it("넣으면 agent · agent_updated_at · schema_version 이 채워지고 trim 된 블록이 저장된다", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/f" }));
    const blocks = [{ type: "text", body: "  앞뒤 공백  " }];
    const r = await drawer.report_create({ title: "  제목  ", kind: "method", folder: "/F", blocks });
    const d = good(r);
    expect(d).toMatchObject({ path: "/f/제목", title: "제목", renamed: false, version: 1, blocks: 1 });
    const row = await raw(d.id);
    expect(row).toMatchObject({ agent: "Claude Code", schema_version: 1, report_kind: "method", kind: "report" });
    expect(row.agent_updated_at).not.toBeNull();
    expect(row.blocks).toEqual([{ type: "text", body: "앞뒤 공백" }]);
  });

  it("맨 위(/)에도 넣을 수 있다", async () => {
    const { drawer } = setup();
    expect((await newReport(drawer, "/", "맨 위 보고서")).path).toBe("/맨 위 보고서");
  });

  it("제목이 겹치면 (2)(3) 붙이고 알린다", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/f" }));
    good(await drawer.drawer_mkdir({ path: "/f/같은" }));
    const r2 = await drawer.report_create({ title: "같은", kind: "data", folder: "/f", blocks: sampleBlocks() });
    expect(good(r2)).toMatchObject({ title: "같은 (2)", renamed: true, path: "/f/같은 (2)" });
    expect(r2.summary).toContain('"같은 (2)"');
    const r3 = await drawer.report_create({ title: "같은", kind: "data", folder: "/f", blocks: sampleBlocks() });
    expect(good(r3).title).toBe("같은 (3)");
  });

  it("폴더가 없으면 오류 — 자동으로 만들지 않고 drawer_mkdir 를 안내", async () => {
    const { drawer } = setup();
    const r = await drawer.report_create({ title: "t", kind: "data", folder: "/없음", blocks: sampleBlocks() });
    const d = bad(r, "NOT_FOUND");
    expect(r.summary).toContain("drawer_mkdir");
    expect(d.nearest.path).toBe("/");
    expect(good(await drawer.drawer_list({})).items).toEqual([]);
  });

  it("블록 검사 실패 → 위치와 이유 목록, 아무것도 안 넣음", async () => {
    const { drawer } = setup();
    const blocks = sampleBlocks() as any[];
    blocks[4].rows[1] = ["칸 하나"];
    blocks[5].items[0].refs = [9];
    blocks.push({ type: "picture", src: "x" });
    const r = await drawer.report_create({ title: "틀림", kind: "data", folder: "/", blocks });
    const d = bad(r, "INVALID_BLOCKS");
    expect(d.errors).toEqual(
      expect.arrayContaining([
        { path: "blocks[4].rows[1]", message: "칸이 1개인데 열은 3개입니다" },
        { path: "blocks[5].items[0].refs[0]", message: "출처 9번은 없습니다 (출처는 1~2번)" },
        expect.objectContaining({ path: "blocks[7].type" }),
      ]),
    );
    expect(good(await drawer.drawer_list({})).items).toEqual([]);
    bad(await drawer.report_create({ title: "빈", kind: "data", folder: "/", blocks: [] }), "INVALID_BLOCKS");
  });

  it("종류·제목 검사", async () => {
    const { drawer } = setup();
    const r = await drawer.report_create({ title: "t", kind: "etc", folder: "/", blocks: sampleBlocks() });
    bad(r, "BAD_INPUT");
    expect(r.summary).toContain("method");
    bad(await drawer.report_create({ title: "a/b", kind: "data", folder: "/", blocks: sampleBlocks() }), "BAD_NAME");
    bad(await drawer.report_create({ title: "", kind: "data", folder: "/", blocks: sampleBlocks() }), "BAD_NAME");
  });

  it("folder 가 보고서면 거절", async () => {
    const { drawer } = setup();
    await newReport(drawer, "/", "r");
    bad(await drawer.report_create({ title: "t", kind: "data", folder: "/r", blocks: sampleBlocks() }), "NOT_FOLDER");
  });

  it("lib 은 통과해도 DB 크기(600KB) 상한에 걸리면 한국어로", async () => {
    const { drawer } = setup();
    // 숫자 refs 가 많으면 jsonb 가 JSON 보다 4배쯤 커진다 → lib 580KB 검사는 통과, DB pg_column_size 는 넘음
    const blocks: unknown[] = Array.from({ length: 45 }, () => ({
      type: "claims",
      h: "h",
      items: Array.from({ length: 50 }, () => ({ tag: "fact", text: "x", refs: Array(20).fill(1) })),
    }));
    blocks.push({ type: "sources", h: "s", items: [{ title: "t", url: "https://a.dev" }] });
    const r = await drawer.report_create({ title: "큼", kind: "data", folder: "/", blocks });
    bad(r, "TOO_LARGE");
    expect(r.summary).toBe("보고서가 너무 큽니다 — 블록을 나눠 두 보고서로 넣으세요");
  });

  it("lib 크기 상한(580KB)을 넘으면 lib 검사에서 거절", async () => {
    const { drawer } = setup();
    const blocks = Array.from({ length: 150 }, () => ({ type: "text", body: "a".repeat(4000) }));
    const d = bad(await drawer.report_create({ title: "큼", kind: "data", folder: "/", blocks }), "INVALID_BLOCKS");
    expect(d.errors[0].message).toContain("보고서가 너무 큽니다");
  });
});

describe("report_get", () => {
  it("범위 없으면 차례 + 판정 + version 만", async () => {
    const { drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/f" }));
    const rep = await newReport(drawer, "/f", "읽기");
    const d = good(await drawer.report_get({ id: rep.id }));
    expect(d).toMatchObject({ id: rep.id, title: "읽기", kind: "data", path: "/f/읽기", version: 1 });
    expect(d.blocks).toBeUndefined();
    expect(d.outline).toEqual([
      { i: 0, type: "verdict" },
      { i: 1, type: "text", h: "배경" },
      { i: 2, type: "text" },
      { i: 3, type: "list", h: "후보" },
      { i: 4, type: "table", h: "비교" },
      { i: 5, type: "claims", h: "근거" },
      { i: 6, type: "sources", h: "출처" },
    ]);
    expect(d.verdict).toEqual({ v: "PGlite 로 DB 시험을 돌린다", w: "도커 없이 트리거·RLS 까지 진짜 Postgres 로 확인된다." });
    expect(typeof d.updated_at).toBe("string");
  });

  it("판정 블록이 없으면 verdict 없음", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "판정 없음", [{ type: "text", body: "b" }]);
    expect(good(await drawer.report_get({ id: rep.id })).verdict).toBeUndefined();
  });

  it("범위(0부터, to 포함)면 그 블록들 + version", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "범위");
    const d = good(await drawer.report_get({ id: rep.id, from: 3, to: 4 }));
    expect(d).toMatchObject({ version: 1, from: 3, to: 4, total: 7 });
    expect(d.blocks.map((b: Row) => b.type)).toEqual(["list", "table"]);
    expect(good(await drawer.report_get({ id: rep.id, from: 6 })).blocks).toHaveLength(1);
    expect(good(await drawer.report_get({ id: rep.id, to: 0 })).blocks[0].type).toBe("verdict");
  });

  it("범위 밖이면 오류", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "밖");
    for (const [from, to] of [
      [0, 7],
      [7, undefined],
      [-1, 2],
      [3, 2],
      [1.5, 2],
    ] as const) {
      const r = await drawer.report_get({ id: rep.id, from, to });
      expect(bad(r, "OUT_OF_RANGE").total).toBe(7);
      expect(r.summary).toContain("0~6");
    }
  });

  it("없는 id · uuid 아님 · 폴더 id", async () => {
    const { drawer } = setup();
    bad(await drawer.report_get({ id: randomUUID() }), "NOT_FOUND");
    bad(await drawer.report_get({ id: "/경로" }), "BAD_INPUT");
    const f = good(await drawer.drawer_mkdir({ path: "/f" }));
    bad(await drawer.report_get({ id: f.id }), "NOT_REPORT");
  });
});

describe("report_edit", () => {
  it("ops 를 앞에서부터 차례로 적용하고 새 version 을 준다", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "고치기", [
      { type: "text", body: "A" },
      { type: "text", body: "B" },
      { type: "text", body: "C" },
    ]);
    const before = await raw(rep.id);
    const r = await drawer.report_edit({
      id: rep.id,
      base_version: 1,
      ops: [
        { op: "remove", at: 0 }, // B C
        { op: "insert", at: 0, block: { type: "text", body: "새것" } }, // 새것 B C
        { op: "replace", at: 2, block: { type: "text", body: " C2 " } }, // 새것 B C2
        { op: "insert", at: 3, block: { type: "verdict", v: "끝" } }, // 맨 끝
      ],
    });
    expect(good(r)).toMatchObject({ id: rep.id, version: 2, blocks: 4 });
    const row = await raw(rep.id);
    expect(row.blocks).toEqual([
      { type: "text", body: "새것" },
      { type: "text", body: "B" },
      { type: "text", body: "C2" },
      { type: "verdict", v: "끝" },
    ]);
    expect(row.version).toBe(2);
    expect(new Date(row.agent_updated_at).getTime()).toBeGreaterThanOrEqual(new Date(before.agent_updated_at).getTime());
  });

  it("base_version 이 낡았으면 충돌 + 현재 version, 아무것도 안 바뀜", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "충돌");
    good(await drawer.report_edit({ id: rep.id, base_version: 1, ops: [{ op: "remove", at: 2 }] }));
    const r = await drawer.report_edit({ id: rep.id, base_version: 1, ops: [{ op: "remove", at: 0 }] });
    const d = bad(r, "EZ_VERSION");
    expect(d).toMatchObject({ conflict: true, current_version: 2 });
    expect((await raw(rep.id)).blocks).toHaveLength(6);
  });

  it("읽은 뒤 저장 사이에 바뀌면(update 0행) 충돌", async () => {
    const owner = randomUUID();
    const { store } = setup(owner);
    let bumped = false;
    // getReport 뒤, update 전에 다른 곳이 고친 것처럼
    const racy = Object.create(store) as typeof store;
    racy.update = async (id, patch, base) => {
      if (!bumped) {
        bumped = true;
        await store.update(id, { name: "다른 곳이 고침" });
      }
      return store.update(id, patch, base);
    };
    const drawer = createDrawer({ store: racy, agent: "Claude Code" });
    const rep = await newReport(drawer, "/", "경합");
    const d = bad(await drawer.report_edit({ id: rep.id, base_version: 1, ops: [{ op: "remove", at: 0 }] }), "EZ_VERSION");
    expect(d.current_version).toBe(2);
    expect((await raw(rep.id)).blocks).toHaveLength(7);
  });

  it("결과가 블록 검사에 걸리면 위치·이유, 저장 안 함", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "검사");
    const r = await drawer.report_edit({
      id: rep.id,
      base_version: 1,
      ops: [{ op: "insert", at: 0, block: { type: "verdict", v: "두 번째 판정" } }],
    });
    const d = bad(r, "INVALID_BLOCKS");
    expect(d.errors).toEqual([{ path: "blocks[1]", message: "판정 블록은 1개만 넣을 수 있습니다 (이미 blocks[0])" }]);
    // 출처를 빼면 claims 의 refs 가 범위 밖
    const d2 = bad(await drawer.report_edit({ id: rep.id, base_version: 1, ops: [{ op: "remove", at: 6 }] }), "INVALID_BLOCKS");
    expect(d2.errors[0].message).toContain("출처 블록이 없는데");
    expect((await raw(rep.id)).version).toBe(1);
  });

  it("사람이 비워 둔 칸이 있어도 고칠 수 있다 — 빈 칸은 그대로 남는다", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "사람이 비움");
    // 사람이 웹에서 소제목·목록 항목·표 칸·근거 글·출처 제목을 비운 것처럼 (ez_edit_text 는 로그인한 사람만 — 여기서는 직접 넣는다)
    const b = sampleBlocks() as any[];
    b[1].h = "";
    b[3].items[1] = "";
    b[4].rows[0][1] = "";
    b[5].items[1].text = "";
    b[6].items[1].title = "";
    await db.query("update ez_items set blocks = $2 where id = $1", [rep.id, JSON.stringify(b)]);
    const ver = (await raw(rep.id)).version;

    const r = await drawer.report_edit({
      id: rep.id,
      base_version: ver,
      ops: [
        { op: "insert", at: 2, block: { type: "text", body: "에이전트가 더한 문단" } },
        { op: "remove", at: 3 },
      ],
    });
    expect(good(r).version).toBe(ver + 1);
    const row = await raw(rep.id);
    expect(row.blocks[1].h).toBe("");
    expect(row.blocks[2]).toEqual({ type: "text", body: "에이전트가 더한 문단" });
    expect(row.blocks[3].items).toEqual(["PGlite", "", "Supabase 브랜치"]);
    expect(row.blocks[6].items[1].title).toBe("");
    // 범위 읽기에도 빈 칸 그대로
    expect((good(await drawer.report_get({ id: rep.id, from: 1, to: 1 })).blocks[0] as Row).h).toBe("");
  });

  it("에이전트가 새로 넣거나 바꾸는 블록의 빈 값은 거절 — 사람이 비운 다른 블록은 탓하지 않는다", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "에이전트 빈 값");
    const b = sampleBlocks() as any[];
    b[1].h = "";
    await db.query("update ez_items set blocks = $2 where id = $1", [rep.id, JSON.stringify(b)]);
    const ver = (await raw(rep.id)).version;

    const d = bad(
      await drawer.report_edit({
        id: rep.id,
        base_version: ver,
        ops: [
          { op: "insert", at: 0, block: { type: "text", h: "", body: "새 문단" } }, // 뒤 블록이 한 칸씩 밀린다
          { op: "replace", at: 4, block: { type: "list", h: "후보", items: ["하나", " "] } },
        ],
      }),
      "INVALID_BLOCKS",
    );
    expect(d.errors).toEqual([
      { path: "blocks[0].h", message: "비어 있습니다" },
      { path: "blocks[4].items[1]", message: "비어 있습니다" },
    ]);
    expect((await raw(rep.id)).version).toBe(ver);

    // 사람이 비운 블록을 에이전트가 통째로 바꾸면 그 블록은 다시 엄격하게
    bad(await drawer.report_edit({ id: rep.id, base_version: ver, ops: [{ op: "replace", at: 1, block: { type: "text", h: "", body: "x" } }] }), "INVALID_BLOCKS");
    good(await drawer.report_edit({ id: rep.id, base_version: ver, ops: [{ op: "replace", at: 1, block: { type: "text", h: "배경", body: "x" } }] }));
  });

  it("report_create 는 빈 값을 받지 않는다", async () => {
    const { drawer } = setup();
    const d = bad(await drawer.report_create({ title: "빈 값", kind: "data", folder: "/", blocks: [{ type: "text", h: "", body: "글" }] }), "INVALID_BLOCKS");
    expect(d.errors).toEqual([{ path: "blocks[0].h", message: "비어 있습니다" }]);
  });

  it("사람이 고친 작성자는 에이전트가 다시 고치면 에이전트 이름으로 돌아간다", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "작성자");
    await db.query("update ez_items set agent = '김조사' where id = $1", [rep.id]);
    const ver = (await raw(rep.id)).version;
    good(await drawer.report_edit({ id: rep.id, base_version: ver, ops: [{ op: "insert", at: 2, block: { type: "text", body: "더함" } }] }));
    expect((await raw(rep.id)).agent).toBe("Claude Code");
  });

  it("op 모양·범위 오류", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "op");
    const e = async (ops: unknown[]) => bad(await drawer.report_edit({ id: rep.id, base_version: 1, ops }));
    expect((await e([{ op: "insert", at: 8, block: { type: "text", body: "x" } }])).error.message).toMatch(/^ops\[0\]: insert 의 at 은 0~7/);
    expect((await e([{ op: "replace", at: 7, block: { type: "text", body: "x" } }])).error.code).toBe("BAD_OP");
    expect((await e([{ op: "remove", at: 0 }, { op: "remove", at: 6 }])).error.message).toMatch(/^ops\[1\]: remove 의 at 은 0~5/);
    expect((await e([{ op: "insert", at: 0 }])).error.message).toContain("block 이 필요");
    expect((await e([{ op: "move", at: 0 }])).error.message).toContain("insert · replace · remove");
    expect((await e([{ op: "remove", at: "0" }])).error.message).toContain("정수");
    expect((await e([])).error.code).toBe("BAD_INPUT");
    bad(await drawer.report_edit({ id: rep.id, base_version: 1.5, ops: [{ op: "remove", at: 0 }] }), "BAD_INPUT");
  });

  it("lib 은 통과하지만 DB 크기 상한에 걸리면 한국어로", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "커짐", [{ type: "sources", h: "s", items: [{ title: "t", url: "https://a.dev" }] }]);
    const claims = {
      type: "claims",
      h: "h",
      items: Array.from({ length: 50 }, () => ({ tag: "fact", text: "x", refs: Array(20).fill(1) })),
    };
    const ops = Array.from({ length: 45 }, () => ({ op: "insert", at: 0, block: claims }));
    const r = await drawer.report_edit({ id: rep.id, base_version: 1, ops });
    bad(r, "TOO_LARGE");
  });
});

describe("웹 링크", () => {
  const WEB = "https://ez.work";
  const withWeb = () => {
    const owner = randomUUID();
    const store = new PgliteStore(db, owner);
    return createDrawer({ store, agent: "Claude Code", webUrl: `${WEB}/` });
  };

  it("모든 결과(보고서·폴더)에 url, 요약 한 줄 끝에도 링크", async () => {
    const drawer = withWeb();
    const mk = await drawer.drawer_mkdir({ path: "/조사/깊은" });
    expect(good(mk).url).toBe(`${WEB}/drawer/f/${mk.data.id}`);
    expect(mk.summary.endsWith(` — ${WEB}/drawer/f/${mk.data.id}`)).toBe(true);
    expect(good(await drawer.drawer_mkdir({ path: "/" })).url).toBe(`${WEB}/drawer`);

    const rep = await newReport(drawer, "/조사", "링크 보고서");
    const repUrl = `${WEB}/drawer/r/${rep.id}`;
    expect((rep as Row).url).toBe(repUrl);

    const top = await drawer.drawer_list({});
    expect(good(top).url).toBe(`${WEB}/drawer`);
    expect(top.summary).toContain(`${WEB}/drawer`);
    const inside = good(await drawer.drawer_list({ path: "/조사" }));
    expect(inside.items.map((i: Row) => i.url)).toEqual([`${WEB}/drawer/f/${mk.data.id}`, repUrl]);
    const found = good(await drawer.drawer_list({ query: "링크" }));
    expect(found.items[0].url).toBe(repUrl);

    for (const r of [await drawer.report_get({ id: rep.id }), await drawer.report_get({ id: rep.id, from: 0, to: 0 })]) {
      expect(good(r).url).toBe(repUrl);
      expect(r.summary.endsWith(repUrl)).toBe(true);
    }
    const ed = await drawer.report_edit({ id: rep.id, base_version: 1, ops: [{ op: "remove", at: 2 }] });
    expect(good(ed).url).toBe(repUrl);
    const mv = await drawer.drawer_update({ target: rep.id, move_to: "/" });
    expect(good(mv).url).toBe(repUrl);
    expect(mv.summary.endsWith(repUrl)).toBe(true);
    const del = await drawer.drawer_update({ target: rep.id, delete: true });
    expect(good(del).url).toBe(`${WEB}/drawer/trash`);

    const nf = bad(await drawer.drawer_list({ path: "/조사/없음" }), "NOT_FOUND");
    expect(nf.nearest.url).toBe((await drawer.drawer_list({ path: "/조사" })).data.url);
    expect(nf.nearest.url).toMatch(/^https:\/\/ez\.work\/drawer\/f\/[0-9a-f-]{36}$/);
  });

  it("EZ_WEB_URL 이 없으면 http://localhost:3200", async () => {
    const { drawer } = setup();
    const rep = await newReport(drawer, "/", "기본");
    expect((rep as Row).url).toBe(`http://localhost:3200/drawer/r/${rep.id}`);
  });

  it("report_get · drawer_update 의 target 으로 웹 링크를 받는다 (호스트·?demo=1 무시)", async () => {
    const drawer = withWeb();
    good(await drawer.drawer_mkdir({ path: "/옮길 곳" }));
    const f = good(await drawer.drawer_mkdir({ path: "/폴더" }));
    const rep = await newReport(drawer, "/", "링크로");
    const got = good(await drawer.report_get({ id: `http://localhost:3200/drawer/r/${rep.id}?demo=1` }));
    expect(got.title).toBe("링크로");
    bad(await drawer.report_get({ id: `${WEB}/drawer/f/${f.id}` }), "NOT_REPORT");
    bad(await drawer.report_get({ id: `${WEB}/s/abc` }), "BAD_INPUT");

    const mv = good(await drawer.drawer_update({ target: `${WEB}/drawer/r/${rep.id}`, move_to: "/옮길 곳" }));
    expect(mv.path).toBe("/옮길 곳/링크로");
    expect(good(await drawer.drawer_update({ target: `${WEB}/drawer/f/${f.id}/`, rename: "새 이름" })).path).toBe("/새 이름");
    bad(await drawer.drawer_update({ target: `${WEB}/drawer`, rename: "x" }), "BAD_INPUT");
    bad(await drawer.drawer_update({ target: "https://example.com/x", rename: "x" }), "BAD_INPUT");
    bad(await drawer.drawer_update({ target: `${WEB}/drawer/r/${randomUUID()}`, delete: true }), "NOT_FOUND");
    const nf = bad(await drawer.drawer_update({ target: "/없는 것", delete: true }), "NOT_FOUND");
    expect(nf.nearest).toMatchObject({ path: "/", url: `${WEB}/drawer` });
  });
});

describe("다른 사람 것", () => {
  it("다른 owner 의 항목은 안 보이고, 못 읽고, 못 건드린다", async () => {
    const A = setup();
    const B = setup();
    good(await A.drawer.drawer_mkdir({ path: "/A 폴더" }));
    const rep = await newReport(A.drawer, "/A 폴더", "A 보고서");
    const folderId = (await A.store.children(null))[0]!.id;

    expect(good(await B.drawer.drawer_list({})).items).toEqual([]);
    bad(await B.drawer.drawer_list({ path: "/A 폴더" }), "NOT_FOUND");
    expect(good(await B.drawer.drawer_list({ query: "A" })).items).toEqual([]);
    bad(await B.drawer.report_get({ id: rep.id }), "NOT_FOUND");
    bad(await B.drawer.report_edit({ id: rep.id, base_version: 1, ops: [{ op: "remove", at: 0 }] }), "NOT_FOUND");
    bad(await B.drawer.drawer_update({ target: rep.id, delete: true }), "NOT_FOUND");
    bad(await B.drawer.drawer_update({ target: folderId, rename: "뺏기" }), "NOT_FOUND");
    // B 의 폴더 안으로 A 것을 넣을 수도 없다 (경로가 B 기준으로 해석된다)
    good(await B.drawer.drawer_mkdir({ path: "/A 폴더" })); // B 는 같은 이름을 따로 가질 수 있다
    bad(await B.drawer.report_create({ title: "x", kind: "data", folder: "/없는", blocks: sampleBlocks() }), "NOT_FOUND");

    const row = await raw(rep.id);
    expect(row).toMatchObject({ owner: A.owner, deleted_at: null, version: 1, name: "A 보고서" });
    expect((await raw(folderId)).name).toBe("A 폴더");
    expect(good(await A.drawer.drawer_list({ path: "/A 폴더" })).items).toHaveLength(1);
  });
});

describe("MCP 프로토콜", () => {
  async function connect() {
    const { drawer, owner } = setup();
    const server = new McpServer({ name: "ez-drawer", version: "test" });
    const scheduleStore = new PgliteScheduleStore(db, owner);
    registerTools(server, drawer, createSchedule({ store: scheduleStore }), createMeet({ store: new PgliteMeetStore(db, owner), schedule: scheduleStore }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  it("도구 12개(서랍 6 + 일정·플래너 6), 설계서 이름 그대로. report_create 설명에 블록 어휘와 예시", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const create = tools.find((t) => t.name === "report_create")!;
    for (const w of ["verdict", "text", "list", "table", "claims", "sources", "http/https", "예:"]) {
      expect(create.description).toContain(w);
    }
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(["title", "kind", "folder", "blocks"]));
    // 서랍 도구 설명 길이를 절제한다 (일정·플래너 쪽은 schedule.test.ts)
    const drawerTools = tools.filter((t) => (DRAWER_TOOLS as readonly string[]).includes(t.name));
    const total = drawerTools.reduce((n, t) => n + (t.description?.length ?? 0), 0);
    expect(total).toBeLessThan(3000);
  });

  it("결과: 한 줄 요약 + JSON, 실패는 isError", async () => {
    const client = await connect();
    const okRes = (await client.callTool({ name: "drawer_mkdir", arguments: { path: "/a" } })) as any;
    expect(okRes.isError).toBeFalsy();
    expect(okRes.content[0].text).toMatch(/^폴더를 만들었습니다: \/a — http:\/\/localhost:3200\/drawer\/f\/[0-9a-f-]{36}$/);
    expect(JSON.parse(okRes.content[1].text)).toMatchObject({ path: "/a", created: true });

    const badRes = (await client.callTool({
      name: "report_create",
      arguments: { title: "t", kind: "data", folder: "/a", blocks: [{ type: "text" }] },
    })) as any;
    expect(badRes.isError).toBe(true);
    expect(JSON.parse(badRes.content[1].text).errors).toEqual([{ path: "blocks[0].body", message: "필요한 칸이 빠졌습니다" }]);
  });
});
