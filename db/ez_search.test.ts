// 0002 ez_search 를 PGlite 에서 0001 위에 그대로 돌려 본다. Supabase 흉내는 ez_items.test.ts 와 같다.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

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
  await db.exec(migration("0001_ez_items.sql"));
  await db.exec(migration("0002_ez_search.sql"));
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
async function report(who: string, name: string, parent: string | null, blocks: unknown): Promise<string> {
  const r = await sql(
    who,
    "insert into ez_items (kind, name, parent_id, report_kind, blocks) values ('report', $1, $2, 'data', $3) returning id",
    [name, parent, JSON.stringify(blocks)],
  );
  return r[0]!.id;
}

const search = (who: string, q: string, under: string | null = null, limit: number | null = null) =>
  sql(who, "select * from ez_search($1, null, $2, coalesce($3, 20))", [q, under, limit]);
const names = (rows: Row[]) => rows.map((r) => r.name).sort();

const BLOCKS = [
  { type: "verdict", v: "PGlite 를 쓴다" },
  { type: "text", h: "배경", body: "앞쪽 글자가 아주 길게 이어진다 ".repeat(5) + "가운데 바늘 " + "뒤쪽 글자도 길게 이어진다 ".repeat(5) },
  { type: "table", h: "표", cols: ["도구", "속도"], rows: [["표 안의 칸", "빠름"]] },
  { type: "claims", h: "근거", items: [{ tag: "fact", text: "근거 문장", refs: [1] }] },
  { type: "sources", h: "출처", items: [{ title: "문서 제목", url: "https://example.com/secret-path" }] },
];

describe("ez_search", () => {
  it("이름과 본문 문자열 값에서 찾고, match·snippet 을 준다", async () => {
    const a = user();
    const f = await folder(a, "PGlite 폴더");
    const r = await report(a, "시험 방법", f, BLOCKS);
    const rows = await search(a, "pglite");
    expect(rows.map((x) => [x.name, x.match])).toEqual([
      ["PGlite 폴더", "name"],
      ["시험 방법", "body"],
    ]);
    expect(rows[0]).toMatchObject({ kind: "folder", snippet: null });
    expect(rows[1]).toMatchObject({ id: r, kind: "report", parent_id: f, report_kind: "data" });
    expect(rows[1]!.snippet).toBe("PGlite 를 쓴다");

    // 표 칸 · 근거 문장 · 출처 제목도 사용자 글자다
    for (const q of ["표 안의", "근거 문장", "문서 제목", "빠름"]) expect(names(await search(a, q))).toEqual(["시험 방법"]);
  });

  it("snippet 은 맞은 자리 앞뒤 약 40자, 잘린 쪽에 …", async () => {
    const a = user();
    await report(a, "긴 글", null, BLOCKS);
    const [row] = await search(a, "바늘");
    expect(row!.snippet).toMatch(/^….*가운데 바늘 .*…$/);
    expect(row!.snippet.length).toBeLessThanOrEqual(2 + 40 + 2 + 40);
  });

  it("type · tag · url 값과 키 이름으로는 안 맞는다", async () => {
    const a = user();
    await report(a, "보고서", null, BLOCKS);
    for (const q of ["verdict", "sources", "fact", "example.com", "secret-path", "body", "items", "refs"]) {
      expect(await search(a, q), q).toEqual([]);
    }
  });

  it("% _ \\ 는 글자 그대로", async () => {
    const a = user();
    await folder(a, "100% 확신");
    await folder(a, "1000 확신");
    await folder(a, "a_b");
    await folder(a, "axb");
    await folder(a, "역\\슬래시");
    expect(names(await search(a, "0%"))).toEqual(["100% 확신"]);
    expect(names(await search(a, "%"))).toEqual(["100% 확신"]);
    expect(names(await search(a, "a_b"))).toEqual(["a_b"]);
    expect(names(await search(a, "\\"))).toEqual(["역\\슬래시"]);
  });

  it("대소문자 무시, 앞뒤 공백 무시, 빈 query 는 EZ_EMPTY", async () => {
    const a = user();
    await folder(a, "Alpha");
    expect(names(await search(a, "  ALPHA "))).toEqual(["Alpha"]);
    await fails(search(a, ""), "EZ_EMPTY");
    await fails(search(a, " 　 "), "EZ_EMPTY");
    await fails(search(a, null as any), "EZ_EMPTY");
  });

  it("남의 것은 안 나온다 (로그인한 사람 · service_role 대리)", async () => {
    const a = user();
    const b = user();
    await folder(a, "비밀 폴더");
    await report(a, "비밀 보고서", null, [{ type: "text", body: "비밀 본문" }]);
    expect(await search(b, "비밀")).toEqual([]);
    expect(names(await sql("service", "select * from ez_search($1, $2)", ["비밀", a]))).toEqual(["비밀 보고서", "비밀 폴더"]);
    expect(await sql("service", "select * from ez_search($1, $2)", ["비밀", b])).toEqual([]);
    expect(await sql("service", "select * from ez_search($1)", ["비밀"])).toEqual([]); // p_as 없음
    // 로그인한 B 가 p_as 에 A 를 넣어도 자기 것만
    expect(await sql(b, "select * from ez_search($1, $2)", ["비밀", a])).toEqual([]);
    await fails(sql("anon", "select * from ez_search($1)", ["비밀"]), "42501");
  });

  it("p_under 면 그 폴더 아래(자손 포함)만, 그 폴더 자신은 빼고", async () => {
    const a = user();
    const top = await folder(a, "찾기 위");
    const mid = await folder(a, "찾기 중간", top);
    await folder(a, "찾기 깊은", mid);
    await report(a, "찾기 보고서", mid, [{ type: "text", body: "x" }]);
    await folder(a, "찾기 바깥");
    expect(names(await search(a, "찾기", top))).toEqual(["찾기 깊은", "찾기 보고서", "찾기 중간"]);
    expect(names(await search(a, "찾기", mid))).toEqual(["찾기 깊은", "찾기 보고서"]);
    expect(names(await search(a, "찾기"))).toHaveLength(5);
    // 없는 폴더 · 남의 폴더 · 보고서
    await fails(search(a, "찾기", randomUUID()), "EZ_NOT_FOUND");
    await fails(search(user(), "찾기", top), "EZ_NOT_FOUND");
  });

  it("지운 것은 빠진다", async () => {
    const a = user();
    const f = await folder(a, "지울 폴더");
    await report(a, "지울 보고서", f, [{ type: "text", body: "지울 본문" }]);
    await folder(a, "남는 지울 것");
    await sql(a, "select ez_delete($1)", [f]);
    expect(names(await search(a, "지울"))).toEqual(["남는 지울 것"]);
    await fails(search(a, "지울", f), "EZ_NOT_FOUND");
  });

  it("이름 맞음이 먼저, 각각 최근 고친 순. p_limit 은 1~50 으로 자른다", async () => {
    const a = user();
    const r1 = await report(a, "본문만", null, [{ type: "text", body: "순서" }]);
    await folder(a, "순서 폴더");
    await sql(a, "update ez_items set name = '본문만 새로' where id = $1", [r1]); // 최근
    const rows = await search(a, "순서");
    expect(rows.map((r) => r.match)).toEqual(["name", "body"]);

    for (let i = 0; i < 55; i++) await folder(a, `많음 ${i}`);
    expect(await search(a, "많음", null, 100)).toHaveLength(50);
    expect(await search(a, "많음", null, 0)).toHaveLength(1);
    expect(await search(a, "많음", null, 3)).toHaveLength(3);
  });

  it("이름과 본문이 둘 다 맞으면 한 번만 (name)", async () => {
    const a = user();
    await report(a, "중복 제목", null, [{ type: "text", body: "중복 본문" }]);
    expect((await search(a, "중복")).map((r) => r.match)).toEqual(["name"]);
  });
});
