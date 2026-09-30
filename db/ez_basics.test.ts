// 0003 (복사 · 여러 개 지우기 · 폴더 안 읽음 · 휴지통 목록 · 공개 중 표시)를 PGlite 에서 0001·0002 위에 그대로 돌려 본다.
// Supabase 흉내는 ez_items.test.ts 와 같다.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { sampleBlocks } from "../lib/fixtures";
import { copyName } from "../lib/names";

const migration = (f: string) => readFileSync(new URL(`./migrations/${f}`, import.meta.url), "utf8");

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

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const f of ["0001_ez_items.sql", "0002_ez_search.sql", "0003_ez_basics.sql"]) await db.exec(migration(f));
}, 60_000);

type Row = Record<string, any>;

/** 사용자 id · "anon" · "service" · "admin" 으로 한 문장 */
async function sql(who: string, text: string, params: unknown[] = []): Promise<Row[]> {
  await db.exec("reset role");
  const sub = who === "anon" || who === "admin" || who === "service" ? "" : who;
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub]);
  if (who === "anon") await db.exec("set role anon");
  else if (who === "service") await db.exec("set role service_role");
  else if (who !== "admin") await db.exec("set role authenticated");
  try {
    return (await db.query<Row>(text, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

async function fails(p: Promise<unknown>, code: string): Promise<string> {
  const e: any = await p.then(
    () => null,
    (err) => err,
  );
  expect(e, `${code} 로 실패해야 합니다`).not.toBeNull();
  if (code.startsWith("EZ_")) {
    expect(e.code).toBe("P0001");
    expect(e.message).toMatch(new RegExp(`^\\[${code}\\] \\S`));
  } else expect(e.code, e.message).toBe(code);
  return e.message;
}

const user = () => randomUUID();

async function folder(who: string, name: string, parent: string | null = null): Promise<string> {
  const r = await sql(who, "insert into ez_items (kind, name, parent_id) values ('folder', $1, $2) returning id", [name, parent]);
  return r[0]!.id;
}
async function report(who: string, name: string, parent: string | null = null, blocks: unknown = sampleBlocks()): Promise<string> {
  const r = await sql(
    who,
    "insert into ez_items (kind, name, parent_id, report_kind, blocks, agent, agent_updated_at) values ('report', $1, $2, 'data', $3, 'Claude Code', now()) returning id",
    [name, parent, JSON.stringify(blocks)],
  );
  return r[0]!.id;
}
const row = async (id: string) => (await sql("admin", "select * from ez_items where id = $1", [id]))[0]!;
const copy = (who: string, ids: string[], to: string | null) => sql(who, "select * from ez_copy($1::uuid[], $2)", [ids, to]);
const kids = async (who: string, parent: string | null) =>
  (await sql(who, "select name from ez_items where parent_id is not distinct from $1 and deleted_at is null", [parent]))
    .map((r) => r.name)
    .sort();
const alive = async (owner: string) =>
  (await sql("admin", "select count(*)::int n from ez_items where owner = $1 and deleted_at is null", [owner]))[0]!.n as number;

// ---------------------------------------------------------------------------

describe("ez_copy — 이름", () => {
  it("같은 폴더면 - 복사본, 또 하면 - 복사본 (2), 다른 폴더에 겹치지 않으면 원래 이름", async () => {
    const a = user();
    const r = await report(a, "보고서");
    const dst = await folder(a, "다른 곳");
    expect((await copy(a, [r], null)).map((x) => x.name)).toEqual(["보고서 - 복사본"]);
    expect((await copy(a, [r], null)).map((x) => x.name)).toEqual(["보고서 - 복사본 (2)"]);
    expect((await copy(a, [r], dst)).map((x) => x.name)).toEqual(["보고서"]);
    expect((await copy(a, [r], dst)).map((x) => x.name)).toEqual(["보고서 - 복사본"]);
    expect(await kids(a, null)).toEqual(["다른 곳", "보고서", "보고서 - 복사본", "보고서 - 복사본 (2)"]);
  });

  it("ez_copy_name 은 lib copyName 과 같은 답", async () => {
    const a = user();
    const p = await folder(a, "겹침");
    const long = "가".repeat(100);
    const existing = ["보고서", "보고서 - 복사본", "Report", "긴", long, "가".repeat(94) + " - 복사본", "x - 복사본 (2)"];
    for (const n of existing) await folder(a, n, p);
    for (const base of ["보고서", "없는 이름", "report", " Report ", long, "x", "x - 복사본 (2)", "보고서 - 복사본"]) {
      const [r] = await sql(a, "select ez_copy_name($1, $2, $3) n", [a, p, base]);
      expect(r!.n, base).toBe(copyName(base, existing));
    }
  });

  it("여러 개를 한 번에 — 입력 순서대로, 서로의 이름과도 안 겹치게", async () => {
    const a = user();
    const x = await folder(a, "x");
    const r = await report(a, "r");
    const got = await copy(a, [r, x], null);
    expect(got.map((g) => [g.src, g.name])).toEqual([
      [r, "r - 복사본"],
      [x, "x - 복사본"],
    ]);
  });
});

describe("ez_copy — 내용", () => {
  it("폴더는 자손까지 통째로, 자손 이름은 그대로, 원본은 그대로. 지운 자손은 안 따라온다", async () => {
    const a = user();
    const top = await folder(a, "위");
    const mid = await folder(a, "가운데", top);
    const rep = await report(a, "깊은 보고서", mid);
    await report(a, "곁 보고서", top);
    const gone = await report(a, "지운 것", top);
    await sql(a, "select ez_delete($1)", [gone]);

    const [c] = await copy(a, [top], null);
    expect(c).toMatchObject({ src: top, name: "위 - 복사본" });
    expect(await kids(a, c!.id)).toEqual(["가운데", "곁 보고서"]);
    const newMid = (await sql(a, "select id from ez_items where parent_id = $1 and name = '가운데'", [c!.id]))[0]!.id;
    const [deep] = await sql(a, "select * from ez_items where parent_id = $1", [newMid]);
    expect(deep).toMatchObject({ name: "깊은 보고서", kind: "report", report_kind: "data" });
    expect(deep!.id).not.toBe(rep);
    expect(deep!.blocks).toEqual((await row(rep)).blocks);
    // 원본은 그대로
    expect(await kids(a, top)).toEqual(["가운데", "곁 보고서"]);
    expect((await row(rep)).parent_id).toBe(mid);
  });

  it("복사본: 공유 끔, 안 읽음 아님, agent 그대로, version 1", async () => {
    const a = user();
    const r = await report(a, "원본");
    await sql(a, "select ez_share($1)", [r]);
    await sql(a, "update ez_items set name = '원본 고침' where id = $1", [r]); // version 2
    const src = await row(r);
    expect(src).toMatchObject({ version: 2, read_at: null });
    expect(src.share_token).not.toBeNull();

    const [c] = await copy(a, [r], null);
    const got = await row(c!.id);
    expect(got).toMatchObject({ share_token: null, agent_updated_at: null, agent: "Claude Code", version: 1, owner: a, deleted_at: null });
    expect(got.read_at).not.toBeNull();
    // 폴더 안 자손도 같은 규칙
    const f = await folder(a, "공유 폴더");
    const inner = await report(a, "안쪽", f);
    await sql(a, "select ez_share($1)", [inner]);
    const [cf] = await copy(a, [f], null);
    const [innerCopy] = await sql(a, "select * from ez_items where parent_id = $1", [cf!.id]);
    expect(innerCopy).toMatchObject({ share_token: null, agent_updated_at: null, version: 1 });
  });
});

describe("ez_copy — 거절하면 아무것도 안 생긴다", () => {
  it("폴더를 자기 자신·자기 안으로는 EZ_CYCLE", async () => {
    const a = user();
    const top = await folder(a, "위");
    const low = await folder(a, "아래", await folder(a, "가운데", top));
    const before = await alive(a);
    await fails(copy(a, [top], top), "EZ_CYCLE");
    await fails(copy(a, [top], low), "EZ_CYCLE");
    await fails(copy(a, [low, top], low), "EZ_CYCLE");
    expect(await alive(a)).toBe(before);
    // 옆·위로는 된다 (같은 폴더 = 복제)
    expect((await copy(a, [low], (await row(low)).parent_id)).map((x) => x.name)).toEqual(["아래 - 복사본"]);
    expect((await copy(a, [low], top)).map((x) => x.name)).toEqual(["아래"]);
  });

  it("깊이 8단 초과면 EZ_DEPTH — 앞에서 만든 것까지 전부 취소", async () => {
    const a = user();
    let parent: string | null = null;
    for (let d = 1; d <= 7; d++) parent = await folder(a, `${d}단`, parent);
    const x = await folder(a, "X");
    await folder(a, "Y", x); // X-Y 2단
    const r = await report(a, "보고서");
    const before = await alive(a);
    // r 은 먼저 복사되지만 X 에서 9단이 되어 전부 취소
    await fails(copy(a, [r, x], parent), "EZ_DEPTH");
    expect(await alive(a)).toBe(before);
    expect(await kids(a, parent)).toEqual([]);
    // 1단짜리는 8단째로 들어간다
    await copy(a, [r], parent);
  });

  it("남의 것 · 지운 것 · 없는 것은 EZ_NOT_FOUND, 섞여 있어도 전부 거절", async () => {
    const a = user();
    const b = user();
    const mine = await report(a, "내 것");
    const theirs = await report(b, "남의 것");
    const gone = await report(a, "지운 것");
    await sql(a, "select ez_delete($1)", [gone]);
    const before = await alive(a);
    await fails(copy(a, [theirs], null), "EZ_NOT_FOUND");
    await fails(copy(a, [mine, theirs], null), "EZ_NOT_FOUND");
    await fails(copy(a, [mine, gone], null), "EZ_NOT_FOUND");
    await fails(copy(a, [randomUUID()], null), "EZ_NOT_FOUND");
    await fails(copy(a, [], null), "EZ_EMPTY");
    expect(await alive(a)).toBe(before);
    expect(await alive(b)).toBe(1);
  });

  it("남의 폴더·지운 폴더·보고서 안으로는 EZ_PARENT", async () => {
    const a = user();
    const b = user();
    const mine = await report(a, "내 것");
    const bf = await folder(b, "B 폴더");
    const dead = await folder(a, "지운 폴더");
    await sql(a, "select ez_delete($1)", [dead]);
    const other = await report(a, "다른 보고서");
    const before = await alive(a);
    await fails(copy(a, [mine], bf), "EZ_PARENT");
    await fails(copy(a, [mine], dead), "EZ_PARENT");
    await fails(copy(a, [mine], other), "EZ_PARENT");
    await fails(copy(a, [mine], mine), "EZ_CYCLE");
    expect(await alive(a)).toBe(before);
  });

  it("자손을 같이 골랐으면 한 번만 (맨 위 것으로)", async () => {
    const a = user();
    const top = await folder(a, "위");
    const inner = await report(a, "안", top);
    const got = await copy(a, [top, inner, top], null);
    expect(got.map((g) => g.src)).toEqual([top]);
    expect(await kids(a, got[0]!.id)).toEqual(["안"]);
  });
});

describe("ez_copy — 누구로서", () => {
  it("service_role 은 p_as 대리, p_as 없으면 거절. 로그인한 사람의 p_as 는 무시", async () => {
    const a = user();
    const b = user();
    const r = await report(a, "대리 복사");
    const [c] = await sql("service", "select * from ez_copy($1::uuid[], null, $2)", [[r], a]);
    expect((await row(c!.id)).owner).toBe(a);
    await fails(sql("service", "select * from ez_copy($1::uuid[], null)", [[r]]), "EZ_NOT_FOUND");
    await fails(sql(b, "select * from ez_copy($1::uuid[], null, $2)", [[r], a]), "EZ_NOT_FOUND");
    await fails(sql("anon", "select * from ez_copy($1::uuid[], null)", [[r]]), "42501");
  });
});

// ---------------------------------------------------------------------------

describe("ez_delete_many", () => {
  it("여러 개를 한 묶음으로, 자손 포함. 한 번에 복원", async () => {
    const a = user();
    const f = await folder(a, "폴더");
    const inner = await report(a, "안", f);
    const r1 = await report(a, "하나");
    const r2 = await report(a, "둘");
    const keep = await report(a, "남김");
    // inner 는 f 의 자손 — 중복 처리하지 않는다
    const [{ batch }] = (await sql(a, "select ez_delete_many($1::uuid[]) batch", [[f, inner, r1, r2, r1]])) as [{ batch: string }];
    for (const id of [f, inner, r1, r2]) expect((await row(id)).deleted_batch).toBe(batch);
    expect((await row(keep)).deleted_at).toBeNull();
    expect(await kids(a, null)).toEqual(["남김"]);

    const restored = await sql(a, "select * from ez_restore($1)", [batch]);
    expect(restored.map((x) => x.name).sort()).toEqual(["둘", "안", "폴더", "하나"]);
    expect(await kids(a, f)).toEqual(["안"]);
  });

  it("하나라도 없거나 남의 것이면 아무것도 안 지운다", async () => {
    const a = user();
    const b = user();
    const r = await report(a, "내 것");
    const t = await report(b, "남의 것");
    await fails(sql(a, "select ez_delete_many($1::uuid[])", [[r, t]]), "EZ_NOT_FOUND");
    await fails(sql(a, "select ez_delete_many($1::uuid[])", [[]]), "EZ_NOT_FOUND");
    expect((await row(r)).deleted_at).toBeNull();
    expect((await row(t)).deleted_at).toBeNull();
    // service_role 대리
    await sql("service", "select ez_delete_many($1::uuid[], $2)", [[r], a]);
    expect((await row(r)).deleted_at).not.toBeNull();
  });
});

describe("ez_unread_folders", () => {
  it("깊은 자손의 안 읽은 보고서가 조상 폴더 전부에 전파, 읽으면 사라진다", async () => {
    const a = user();
    const top = await folder(a, "위");
    const mid = await folder(a, "가운데", top);
    const low = await folder(a, "아래", mid);
    const side = await folder(a, "곁");
    await folder(a, "빈", top);
    const r = await report(a, "새 보고서", low);
    await report(a, "맨 위 보고서"); // 맨 위 보고서는 폴더가 없다
    const unread = async (who = a) => (await sql(who, "select ez_unread_folders() id")).map((x) => x.id).sort();
    expect(await unread()).toEqual([top, mid, low].sort());
    expect(await unread()).not.toContain(side);

    await sql(a, "select ez_mark_read($1)", [r]);
    expect(await unread()).toEqual([]);
    // 에이전트가 다시 고치면 다시 생긴다
    await sql("admin", "update ez_items set agent_updated_at = now() + interval '1 second' where id = $1", [r]);
    expect(await unread()).toEqual([top, mid, low].sort());
    // 남의 것은 안 나온다 · service_role 대리
    expect(await unread(user())).toEqual([]);
    expect((await sql("service", "select ez_unread_folders($1) id", [a])).map((x) => x.id).sort()).toEqual([top, mid, low].sort());
    expect(await sql("service", "select ez_unread_folders() id")).toEqual([]);
  });

  it("지운 보고서·지운 폴더는 빠진다", async () => {
    const a = user();
    const f = await folder(a, "폴더");
    const g = await folder(a, "지울 폴더");
    const r = await report(a, "지울 보고서", f);
    await report(a, "안", g);
    await sql(a, "select ez_delete($1)", [r]);
    await sql(a, "select ez_delete($1)", [g]);
    expect(await sql(a, "select ez_unread_folders() id")).toEqual([]);
  });
});

describe("ez_trash", () => {
  it("묶음마다 맨 위 항목과 묶음 안 항목 수, 최근 지운 묶음 먼저", async () => {
    const a = user();
    const f = await folder(a, "폴더");
    await report(a, "안1", f);
    await folder(a, "안2", f);
    const r1 = await report(a, "하나");
    const r2 = await report(a, "둘");
    const b1 = (await sql(a, "select ez_delete($1) b", [f]))[0]!.b;
    const b2 = (await sql(a, "select ez_delete_many($1::uuid[]) b", [[r1, r2]]))[0]!.b;
    await report(a, "살아 있음");

    const rows = await sql(a, "select * from ez_trash()");
    expect(rows.map((x) => [x.batch, x.name, x.kind, x.count])).toEqual([
      [b2, "둘", "report", 2],
      [b2, "하나", "report", 2],
      [b1, "폴더", "folder", 3],
    ]);
    expect(rows[0]!.deleted_at).toBeInstanceOf(Date);

    // 복원하면 빠진다. 남의 것은 안 보인다
    await sql(a, "select * from ez_restore($1)", [b2]);
    expect((await sql(a, "select * from ez_trash()")).map((x) => x.batch)).toEqual([b1]);
    expect(await sql(user(), "select * from ez_trash()")).toEqual([]);
    expect((await sql("service", "select * from ez_trash($1)", [a])).map((x) => x.batch)).toEqual([b1]);
  });

  it("먼저 지운 자식의 묶음은 따로 — 부모가 나중에 지워져도 자식이 그 묶음의 맨 위", async () => {
    const a = user();
    const f = await folder(a, "부모");
    const c = await report(a, "자식", f);
    await sql(a, "select ez_delete($1)", [c]);
    await sql(a, "select ez_delete($1)", [f]);
    const rows = await sql(a, "select name, count from ez_trash()");
    expect(rows).toEqual([
      { name: "부모", count: 1 },
      { name: "자식", count: 1 },
    ]);
  });
});

describe("ez_is_shared", () => {
  it("공유 켜졌는지만 (열쇠 값 없이)", async () => {
    const a = user();
    const r = await report(a, "공유");
    await report(a, "비공개");
    await sql(a, "select ez_share($1)", [r]);
    const rows = await sql(a, "select i.name, ez_is_shared(i) s from ez_items i order by i.name");
    expect(rows).toEqual([
      { name: "공유", s: true },
      { name: "비공개", s: false },
    ]);
  });
});
