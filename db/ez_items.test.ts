// ez_items 마이그레이션을 PGlite(진짜 Postgres, WASM)에서 그대로 돌려 본다.
// Supabase 흉내: auth.uid() = request.jwt.claim.sub, 역할 anon/authenticated.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { editRule, LIMITS, validateBlocks } from "../lib/blocks";
import { sampleBlocks } from "../lib/fixtures";
import { normalizeName, uniqueName, validateName } from "../lib/names";

const MIGRATION = readFileSync(new URL("./migrations/0001_ez_items.sql", import.meta.url), "utf8");

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
  await db.exec(MIGRATION);
}, 60_000);

/** 사용자 id · "anon" · "service"(service_role, MCP) · "admin"(postgres) */
type Who = string;
type Row = Record<string, any>;

/** who 로 역할을 바꿔 한 문장 실행. 사용자 id 면 authenticated + sub */
async function sql<T = Row>(who: Who, text: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("reset role");
  const sub = who === "anon" || who === "admin" || who === "service" ? "" : who;
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub]);
  if (who === "anon") await db.exec("set role anon");
  else if (who === "service") await db.exec("set role service_role");
  else if (who !== "admin") await db.exec("set role authenticated");
  try {
    return (await db.query<T>(text, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

async function one<T = Row>(who: Who, text: string, params: unknown[] = []): Promise<T> {
  const rows = await sql<T>(who, text, params);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** 실패해야 한다. code 가 EZ_ 로 시작하면 P0001 + '[EZ_…] ' 메시지, 아니면 SQLSTATE */
async function fails(p: Promise<unknown>, code: string): Promise<string> {
  const e = await p.then(
    () => null,
    (err: any) => err,
  );
  expect(e, `${code} 로 실패해야 합니다`).not.toBeNull();
  if (code.startsWith("EZ_")) {
    expect(e.code).toBe("P0001");
    expect(e.message).toMatch(new RegExp(`^\\[${code}\\] \\S`));
  } else {
    expect(e.code, e.message).toBe(code);
  }
  return e.message as string;
}

const user = () => randomUUID();

async function folder(who: string, name: string, parent: string | null = null): Promise<string> {
  const r = await one<{ id: string }>(who, "insert into ez_items (kind, name, parent_id) values ('folder', $1, $2) returning id", [name, parent]);
  return r.id;
}
async function report(who: string, name: string, parent: string | null = null, blocks: unknown = sampleBlocks()): Promise<string> {
  const r = await one<{ id: string }>(
    who,
    "insert into ez_items (kind, name, parent_id, report_kind, blocks, agent) values ('report', $1, $2, 'data', $3, 'Claude Code') returning id",
    [name, parent, JSON.stringify(blocks)],
  );
  return r.id;
}
async function item(id: string): Promise<Row> {
  return one("admin", "select * from ez_items where id = $1", [id]);
}

// ---------------------------------------------------------------------------

describe("이름", () => {
  it("같은 폴더 안 같은 이름 금지 — 대소문자 무시, 폴더·보고서 사이에도", async () => {
    const a = user();
    const top = await folder(a, "Alpha");
    await fails(folder(a, "alpha"), "23505");
    await fails(report(a, "ALPHA"), "23505");
    await folder(a, "alpha", top); // 다른 폴더면 된다
    await fails(folder(a, "ALPHA", top), "23505");
  });

  it("다른 사람의 같은 이름은 상관없다", async () => {
    const a = user();
    const b = user();
    await folder(a, "공통");
    await folder(b, "공통");
  });

  it("지운 것과는 겹쳐도 된다", async () => {
    const a = user();
    const id = await folder(a, "지울 것");
    await sql(a, "select ez_delete($1)", [id]);
    await folder(a, "지울 것");
  });

  it("이름을 바꿔 겹치게 할 수 없다", async () => {
    const a = user();
    await folder(a, "하나");
    const two = await folder(a, "둘");
    await fails(sql(a, "update ez_items set name = '하나' where id = $1", [two]), "23505");
  });

  it("이름 규칙 CHECK — lib validateName 과 같은 판정", async () => {
    const a = user();
    const cases = [
      "보통 이름",
      "가".repeat(100),
      "가".repeat(101),
      "😀".repeat(100),
      "😀".repeat(101),
      "a/b",
      " 앞 공백",
      "뒤 공백 ",
      "뒤 전각공백\u3000",
      "뒤 nbsp\u00a0",
      "\ufeffBOM",
      "줄\n바꿈",
      "탭\t",
      "a\u0001b",
      "a\u007fb",
      "a\u0085b",
      "a\u2028b",
      "폭없는\u200b공백",
      "",
      ".",
      "..",
      " .. ",
      "...",
      ".a",
      "a.",
    ];
    for (const [i, name] of cases.entries()) {
      // 부모를 따로 둬 이름 겹침과 섞이지 않게
      const parent = await folder(a, `p${i}`);
      const libOk = validateName(name) === null && normalizeName(name) === name;
      const dbOk = await folder(a, name, parent).then(
        () => true,
        (e: any) => (expect(e.code, JSON.stringify(name)).toBe("23514"), false),
      );
      expect(dbOk, JSON.stringify(name)).toBe(libOk);
    }
  });

  it("DB ez_trim 은 JS trim 과 같은 문자를 지운다", async () => {
    const ws: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (c >= 0xd800 && c <= 0xdfff) continue;
      if (ch.trim() === "") ws.push(ch);
    }
    expect(ws.length).toBeGreaterThan(20);
    const probe = [...ws, "\u200b", "\u180e", "\u0085", "a", "가"];
    for (const ch of probe) {
      const s = `${ch}x${ch}`;
      const r = await one<{ t: string }>("admin", "select ez_trim($1) t", [s]);
      expect(r.t, `U+${ch.charCodeAt(0).toString(16)}`).toBe(s.trim());
    }
  });

  it("ez_unique_name 은 lib uniqueName 과 같은 답", async () => {
    const a = user();
    const p = await folder(a, "겹침 시험");
    const existing = ["새 폴더", "새 폴더 (2)", "Report", "이름 (2)", "이름 (3)", "가".repeat(100), "이름(2)"];
    for (const n of existing) await folder(a, n, p);
    for (const base of ["새 폴더", "없는 이름", "report", " Report ", "이름 (2)", "가".repeat(100), "이름(2)", "새 폴더 (2)"]) {
      const r = await one<{ n: string }>(a, "select ez_unique_name($1, $2, $3) n", [a, p, base]);
      expect(r.n, base).toBe(uniqueName(base, existing));
    }
  });
});

describe("종류별 칸", () => {
  it("폴더는 blocks·report_kind 없음, 보고서는 blocks 배열 + 종류", async () => {
    const a = user();
    await fails(sql(a, "insert into ez_items (kind, name, blocks) values ('folder', 'f', '[]')"), "23514");
    await fails(sql(a, "insert into ez_items (kind, name, report_kind) values ('folder', 'f', 'data')"), "23514");
    await fails(sql(a, "insert into ez_items (kind, name, report_kind) values ('report', 'r', 'data')"), "23514");
    await fails(sql(a, "insert into ez_items (kind, name, report_kind, blocks) values ('report', 'r', 'etc', '[]')"), "23514");
    await fails(sql(a, "insert into ez_items (kind, name, report_kind, blocks) values ('report', 'r', 'data', '{}')"), "23514");
    await fails(sql(a, "insert into ez_items (kind, name) values ('file', 'x')"), "23514");
    await report(a, "정상 보고서");
  });

  it("lib 크기 상한(580,000바이트)을 통과하면 DB(600,000 미만)도 통과한다", async () => {
    const a = user();
    const bytes = (b: unknown) => Buffer.byteLength(JSON.stringify(b));
    const text = (n: number) => ({ type: "text", body: "가나다라마바사아자차카타파하 abc 123. ".repeat(200).slice(0, n) });
    const blocks: unknown[] = [];
    while (bytes([...blocks, text(4000)]) <= LIMITS.bytes) blocks.push(text(4000));
    // 마지막 블록을 한 글자씩 늘려 상한 바로 아래까지
    let n = 0;
    while (bytes([...blocks, text(n + 1)]) <= LIMITS.bytes) n++;
    blocks.push(text(n));
    const size = bytes(blocks);
    expect(size).toBeGreaterThan(LIMITS.bytes - 4);
    expect(size).toBeLessThanOrEqual(LIMITS.bytes);
    expect(validateBlocks(blocks).ok).toBe(true);
    const id = await report(a, "경계", null, blocks);
    const r = await one<{ s: number }>("admin", "select pg_column_size(blocks) s from ez_items where id = $1", [id]);
    expect(r.s).toBeLessThan(600000);
  });

  it("blocks 600KB 상한", async () => {
    const a = user();
    const body = (n: number) => Array.from({ length: n }, () => ({ type: "text", body: "a".repeat(4000) }));
    await report(a, "140블록", null, body(140)); // 약 565KB
    await fails(report(a, "160블록", null, body(160)), "23514"); // 약 646KB
  });

  it("종류·주인은 바꿀 수 없다", async () => {
    const a = user();
    const f = await folder(a, "고정");
    await fails(sql(a, "update ez_items set kind = 'report', report_kind = 'data', blocks = '[]' where id = $1", [f]), "EZ_FIXED");
    await fails(sql("admin", "update ez_items set owner = $2 where id = $1", [f, user()]), "EZ_FIXED");
  });
});

describe("부모", () => {
  it("없는 부모 · 보고서 부모 · 지운 부모 · 남의 폴더", async () => {
    const a = user();
    const b = user();
    expect(await fails(folder(a, "x", randomUUID()), "EZ_PARENT")).toContain("넣을 폴더가 없습니다");

    const r = await report(a, "보고서");
    expect(await fails(folder(a, "x", r), "EZ_PARENT")).toContain("폴더가 아닌 곳");
    expect(await fails(report(a, "x", r), "EZ_PARENT")).toContain("폴더가 아닌 곳");

    const dead = await folder(a, "지운 폴더");
    await sql(a, "select ez_delete($1)", [dead]);
    expect(await fails(folder(a, "x", dead), "EZ_PARENT")).toContain("지워진 폴더");

    const bf = await folder(b, "B 폴더");
    // 남의 폴더는 없는 것과 같은 문구 (있는지 드러내지 않음)
    expect(await fails(folder(a, "x", bf), "EZ_PARENT")).toContain("넣을 폴더가 없습니다");
  });

  it("옮길 때도 검사한다", async () => {
    const a = user();
    const f = await folder(a, "옮길 것");
    const dead = await folder(a, "죽은 곳");
    await sql(a, "select ez_delete($1)", [dead]);
    await fails(sql(a, "update ez_items set parent_id = $2 where id = $1", [f, dead]), "EZ_PARENT");
    const r = await report(a, "보고서");
    await fails(sql(a, "update ez_items set parent_id = $2 where id = $1", [f, r]), "EZ_PARENT");
  });

  it("지운 항목도 남의 폴더를 가리키게 할 수 없다", async () => {
    const a = user();
    const b = user();
    const bf = await folder(b, "B 폴더");
    const r = await report(a, "휴지통 속");
    await sql(a, "select ez_delete($1)", [r]);
    await fails(sql(a, "update ez_items set parent_id = $2 where id = $1", [r, bf]), "EZ_PARENT");
  });
});

describe("순환", () => {
  it("자기 자신·자손 아래로 옮기기 금지", async () => {
    const a = user();
    const top = await folder(a, "A");
    const mid = await folder(a, "B", top);
    const low = await folder(a, "C", mid);
    await fails(sql(a, "update ez_items set parent_id = $2 where id = $1", [top, top]), "EZ_CYCLE");
    await fails(sql(a, "update ez_items set parent_id = $2 where id = $1", [top, low]), "EZ_CYCLE");
    await fails(sql(a, "update ez_items set parent_id = $2 where id = $1", [mid, low]), "EZ_CYCLE");
    // 옆으로·위로는 된다
    await sql(a, "update ez_items set parent_id = null where id = $1", [low]);
    await sql(a, "update ez_items set parent_id = $2 where id = $1", [top, low]);
  });
});

describe("깊이", () => {
  it("폴더 8단까지, 9단은 거절. 8단 폴더 안 보고서는 된다", async () => {
    const a = user();
    let parent: string | null = null;
    const chain: string[] = [];
    for (let d = 1; d <= 8; d++) {
      parent = await folder(a, `${d}단`, parent);
      chain.push(parent);
    }
    expect(await fails(folder(a, "9단", parent), "EZ_DEPTH")).toContain("9단");
    await report(a, "8단 안 보고서", parent);

    // 2단짜리 하위 트리를 옮기기: 6단 아래(=8) 는 되고, 7단 아래(=9) 는 거절
    const x = await folder(a, "X");
    await folder(a, "Y", x);
    await sql(a, "update ez_items set parent_id = $2 where id = $1", [x, chain[5]]);
    await fails(sql(a, "update ez_items set parent_id = $2 where id = $1", [x, chain[6]]), "EZ_DEPTH");
  });

  it("지운 하위 폴더는 높이에 안 센다", async () => {
    const a = user();
    let parent: string | null = null;
    const chain: string[] = [];
    for (let d = 1; d <= 7; d++) chain.push((parent = await folder(a, `${d}`, parent)));
    const x = await folder(a, "X");
    const y = await folder(a, "Y", x);
    await fails(sql(a, "update ez_items set parent_id = $2 where id = $1", [x, chain[6]]), "EZ_DEPTH");
    await sql(a, "select ez_delete($1)", [y]);
    await sql(a, "update ez_items set parent_id = $2 where id = $1", [x, chain[6]]);
  });
});

describe("RLS", () => {
  it("B 는 A 것을 못 보고 못 고치고 못 지운다", async () => {
    const a = user();
    const b = user();
    const r = await report(a, "A 보고서");
    expect(await sql(b, "select * from ez_items where id = $1", [r])).toHaveLength(0);
    expect(await sql(b, "update ez_items set name = '뺏음' where id = $1 returning id", [r])).toHaveLength(0);
    expect(await sql(b, "delete from ez_items where id = $1 returning id", [r])).toHaveLength(0);
    expect((await item(r)).name).toBe("A 보고서");
    expect(await sql(a, "select id from ez_items where id = $1", [r])).toHaveLength(1);
  });

  it("남의 owner 로 넣을 수 없다 · owner 는 자동으로 나", async () => {
    const a = user();
    const b = user();
    await fails(sql(b, "insert into ez_items (owner, kind, name) values ($1, 'folder', '남의 것')", [a]), "42501");
    const id = await folder(b, "내 것");
    expect((await item(id)).owner).toBe(b);
  });

  it("B 는 A 것에 함수도 못 쓴다", async () => {
    const a = user();
    const b = user();
    const r = await report(a, "A 보고서");
    await fails(sql(b, "select ez_delete($1)", [r]), "EZ_NOT_FOUND");
    await fails(sql(b, "select ez_edit_text($1, 1, '{0,v}', '뺏음')", [r]), "EZ_NOT_FOUND");
    await fails(sql(b, "select ez_mark_read($1)", [r]), "EZ_NOT_FOUND");
    await fails(sql(b, "select ez_share($1)", [r]), "EZ_NOT_FOUND");
    await fails(sql(b, "select ez_unshare($1)", [r]), "EZ_NOT_FOUND");
    const batch = (await one<{ b: string }>(a, "select ez_delete($1) b", [r])).b;
    await fails(sql(b, "select * from ez_restore($1)", [batch]), "EZ_NOT_FOUND");
  });

  it("anon 은 테이블·함수 모두 못 쓴다 (ez_shared 만)", async () => {
    const a = user();
    const r = await report(a, "A 보고서");
    await fails(sql("anon", "select * from ez_items"), "42501");
    await fails(sql("anon", "insert into ez_items (kind, name) values ('folder', 'x')"), "42501");
    for (const call of [
      "select ez_delete($1)",
      "select * from ez_restore($1)",
      "select ez_mark_read($1)",
      "select ez_share($1)",
      "select ez_unshare($1)",
    ]) {
      await fails(sql("anon", call, [r]), "42501");
    }
    await fails(sql("anon", "select ez_edit_text($1, 1, '{0,v}', 'x')", [r]), "42501");
    expect(await sql("anon", "select * from ez_shared('nope')")).toEqual([]);
  });

  it("로그인 안 한 authenticated(sub 없음)는 아무것도 못 본다", async () => {
    const a = user();
    await folder(a, "A");
    expect(await sql("", "select * from ez_items")).toEqual([]);
  });
});

describe("ez_delete · ez_restore", () => {
  async function tree(a: string) {
    const f = await folder(a, "F");
    const g = await folder(a, "G", f);
    const r1 = await report(a, "r1", g);
    const r2 = await report(a, "r2", f);
    return { f, g, r1, r2 };
  }

  it("폴더를 지우면 살아 있는 자손 전부 같은 묶음으로", async () => {
    const a = user();
    const t = await tree(a);
    const other = await report(a, "밖");
    const batch = (await one<{ b: string }>(a, "select ez_delete($1) b", [t.f])).b;
    const rows = await sql("admin", "select id, deleted_batch, deleted_at from ez_items where owner = $1 order by name", [a]);
    for (const r of rows) {
      if (r.id === other) expect(r.deleted_at).toBeNull();
      else expect(r.deleted_batch).toBe(batch);
    }
    expect(new Set(rows.filter((r) => r.id !== other).map((r) => String(r.deleted_at))).size).toBe(1);
    await fails(sql(a, "select ez_delete($1)", [t.f]), "EZ_NOT_FOUND"); // 이미 지움
  });

  it("미리 지운 자손은 다른 묶음 그대로", async () => {
    const a = user();
    const t = await tree(a);
    const first = (await one<{ b: string }>(a, "select ez_delete($1) b", [t.r1])).b;
    const second = (await one<{ b: string }>(a, "select ez_delete($1) b", [t.f])).b;
    expect((await item(t.r1)).deleted_batch).toBe(first);
    expect((await item(t.g)).deleted_batch).toBe(second);
  });

  it("살아 있는 것이 든 폴더를 직접 휴지통으로 보낼 수 없다", async () => {
    const a = user();
    const t = await tree(a);
    await fails(
      sql(a, "update ez_items set deleted_at = now(), deleted_batch = gen_random_uuid() where id = $1", [t.f]),
      "EZ_PARENT",
    );
    // 안이 빈 것·보고서는 된다
    await sql(a, "update ez_items set deleted_at = now(), deleted_batch = gen_random_uuid() where id = $1", [t.r2]);
  });

  it("묶음째 제자리로 복원 (얕은 것부터)", async () => {
    const a = user();
    const t = await tree(a);
    const batch = (await one<{ b: string }>(a, "select ez_delete($1) b", [t.f])).b;
    const res = await sql(a, "select * from ez_restore($1)", [batch]);
    expect(res.map((r) => r.id)[0]).toBe(t.f);
    expect(res).toHaveLength(4);
    for (const r of res) expect([r.to_root, r.renamed]).toEqual([false, false]);
    const after = await sql("admin", "select id, parent_id, deleted_at, deleted_batch from ez_items where owner = $1", [a]);
    const byId = Object.fromEntries(after.map((r) => [r.id, r]));
    expect(byId[t.g].parent_id).toBe(t.f);
    expect(byId[t.r1].parent_id).toBe(t.g);
    expect(byId[t.r2].parent_id).toBe(t.f);
    expect(after.every((r) => r.deleted_at === null && r.deleted_batch === null)).toBe(true);
    await fails(sql(a, "select * from ez_restore($1)", [batch]), "EZ_NOT_FOUND"); // 두 번은 안 됨
  });

  it("부모가 그 사이 지워졌으면 맨 위로", async () => {
    const a = user();
    const t = await tree(a);
    const b1 = (await one<{ b: string }>(a, "select ez_delete($1) b", [t.r1])).b;
    await sql(a, "select ez_delete($1)", [t.f]);
    const res = await sql(a, "select * from ez_restore($1)", [b1]);
    expect(res).toEqual([{ id: t.r1, name: "r1", to_root: true, renamed: false }]);
    expect((await item(t.r1)).parent_id).toBeNull();
  });

  it("이름이 그 사이 생긴 것과 겹치면 (2) 붙여 복원", async () => {
    const a = user();
    const x = await report(a, "X");
    const batch = (await one<{ b: string }>(a, "select ez_delete($1) b", [x])).b;
    await folder(a, "x");
    const res = await sql(a, "select * from ez_restore($1)", [batch]);
    expect(res).toEqual([{ id: x, name: "X (2)", to_root: false, renamed: true }]);
  });

  it("맨 위로 가면서 이름도 겹치면 둘 다", async () => {
    const a = user();
    const f = await folder(a, "F");
    const r = await report(a, "보고서", f);
    await folder(a, "보고서"); // 맨 위에 같은 이름
    const b1 = (await one<{ b: string }>(a, "select ez_delete($1) b", [r])).b;
    await sql(a, "select ez_delete($1)", [f]);
    const res = await sql(a, "select * from ez_restore($1)", [b1]);
    expect(res).toEqual([{ id: r, name: "보고서 (2)", to_root: true, renamed: true }]);
  });

  it("없는 묶음", async () => {
    await fails(sql(user(), "select * from ez_restore($1)", [randomUUID()]), "EZ_NOT_FOUND");
  });
});

describe("ez_edit_text", () => {
  async function fresh() {
    const a = user();
    const id = await report(a, "편집 시험");
    return { a, id };
  }
  const edit = (who: string, id: string, ver: number, path: (string | number)[], value: string) =>
    one<{ v: number }>(who, "select ez_edit_text($1, $2, $3, $4) v", [id, ver, path.map(String), value]).then((r) => r.v);

  it("허용 칸을 고치면 version 이 오르고 값은 trim 된다", async () => {
    const { a, id } = await fresh();
    let v = 1;
    const paths: (string | number)[][] = [
      [0, "v"], [0, "w"], [1, "h"], [1, "body"], [3, "h"], [3, "items", 1],
      [4, "h"], [4, "cols", 0], [4, "rows", 1, 2], [5, "h"], [5, "items", 0, "text"], [6, "h"], [6, "items", 1, "title"],
    ];
    for (const p of paths) {
      const next = await edit(a, id, v, p, `  고침 ${p.join(".")}  `);
      expect(next).toBe(v + 1);
      v = next;
    }
    const row = await item(id);
    expect(row.version).toBe(v);
    expect(row.blocks[4].rows[1][2]).toBe("고침 4.rows.1.2");
    expect(row.blocks[6].items[1].title).toBe("고침 6.items.1.title");
    expect(row.blocks[6].items[1].url).toBe((sampleBlocks()[6] as any).items[1].url); // 옆 칸은 그대로
  });

  it("고칠 수 없는 칸은 EZ_PATH", async () => {
    const { a, id } = await fresh();
    const bad: string[][] = [
      ["6", "items", "0", "url"], ["0", "type"], ["5", "items", "0", "refs"], ["5", "items", "0", "refs", "0"],
      ["5", "items", "0", "tag"], ["3", "items", "-1"], ["3", "items", "01"], ["3", "items", "9"], ["2", "h"],
      ["4", "rows", "0"], ["4", "cols"], ["-1", "h"], ["title", "x"], ["name"], [], ["99", "h"],
    ];
    for (const p of bad) await fails(sql(a, "select ez_edit_text($1, 1, $2, 'x')", [id, p]), "EZ_PATH");
    expect((await item(id)).version).toBe(1);
  });

  it("버전이 낡았으면 EZ_VERSION (지금 버전 알려줌)", async () => {
    const { a, id } = await fresh();
    await edit(a, id, 1, [1, "body"], "첫 수정");
    const msg = await fails(edit(a, id, 1, [1, "body"], "낡은 수정"), "EZ_VERSION");
    expect(msg).toContain("지금 버전 2");
    expect((await item(id)).blocks[1].body).toBe("첫 수정");
  });

  it("빈 값은 EZ_EMPTY", async () => {
    const { a, id } = await fresh();
    await fails(edit(a, id, 1, [1, "body"], "   \n\u3000"), "EZ_EMPTY");
    await fails(edit(a, id, 1, ["title"], " "), "EZ_EMPTY");
    await fails(sql(a, "select ez_edit_text($1, 1, '{1,body}', null)", [id]), "EZ_EMPTY");
  });

  it("길이 상한·한 줄 규칙은 블록 규칙과 같다", async () => {
    const { a, id } = await fresh();
    let v = await edit(a, id, 1, [1, "body"], "가".repeat(4000));
    await fails(edit(a, id, v, [1, "body"], "가".repeat(4001)), "EZ_VALUE");
    v = await edit(a, id, v, [0, "v"], "a".repeat(300));
    await fails(edit(a, id, v, [0, "v"], "a".repeat(301)), "EZ_VALUE");
    await fails(edit(a, id, v, [0, "v"], "두\n줄"), "EZ_VALUE");
    v = await edit(a, id, v, [1, "body"], "문단은\n여러 줄 가능");
    await fails(edit(a, id, v, [4, "rows", 0, 0], "x".repeat(301)), "EZ_VALUE");
  });

  it("title 로 이름 바꾸기 — 이름 규칙·겹침은 CHECK/인덱스가 막는다", async () => {
    const { a, id } = await fresh();
    await report(a, "다른 보고서");
    const v = await edit(a, id, 1, ["title"], "  새 제목 ");
    expect(v).toBe(2);
    expect((await item(id)).name).toBe("새 제목");
    await fails(edit(a, id, 2, ["title"], "다른 보고서"), "23505");
    await fails(edit(a, id, 2, ["title"], "a/b"), "23514");
  });

  it("폴더는 title 만", async () => {
    const a = user();
    const f = await folder(a, "폴더");
    expect(await edit(a, f, 1, ["title"], "새 폴더 이름")).toBe(2);
    await fails(edit(a, f, 2, [0, "v"], "x"), "EZ_PATH");
  });

  it("지운 항목은 EZ_NOT_FOUND", async () => {
    const { a, id } = await fresh();
    await sql(a, "select ez_delete($1)", [id]);
    await fails(edit(a, id, 1, [1, "body"], "x"), "EZ_NOT_FOUND");
  });

  it("허용 칸 판정·상한이 lib editRule 과 같다", async () => {
    const blocks = sampleBlocks();
    // 모든 칸(잎·중간)과 몇 가지 엉뚱한 경로
    const paths: (string | number)[][] = [];
    const walk = (node: unknown, path: (string | number)[]) => {
      paths.push(path);
      if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    };
    walk(blocks, []);
    paths.push([2, "h"], [3, "items", 5], [3, "items", "-1"], [3, "items", "01"], [9, "h"], ["x"], ["1", "body", "x"]);
    expect(paths.length).toBeGreaterThan(50);
    for (const p of paths) {
      const lib = editRule(blocks, p);
      const r = await one<{ max_length: number | null; one_line: boolean }>("admin", "select * from ez_edit_rule($1, $2)", [
        JSON.stringify(blocks),
        p.map(String),
      ]);
      expect({ max_length: r.max_length, one_line: r.one_line }, JSON.stringify(p)).toEqual({
        max_length: lib?.maxLength ?? null,
        one_line: lib?.oneLine ?? false,
      });
    }
  });
});

describe("공유", () => {
  it("발급 → anon 이 읽음 → 재발급하면 옛 열쇠 무효 → 끄면 무효", async () => {
    const a = user();
    const r = await report(a, "공유 보고서");
    const t1 = (await one<{ t: string }>(a, "select ez_share($1) t", [r])).t;
    expect(t1).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const got = await sql("anon", "select * from ez_shared($1)", [t1]);
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0]!).sort()).toEqual(["blocks", "name", "report_kind", "schema_version", "updated_at"]);
    expect(got[0]!.name).toBe("공유 보고서");
    expect(got[0]!.blocks).toEqual(sampleBlocks());

    const t2 = (await one<{ t: string }>(a, "select ez_share($1) t", [r])).t;
    expect(t2).not.toBe(t1);
    expect(await sql("anon", "select * from ez_shared($1)", [t1])).toEqual([]);
    expect(await sql("anon", "select * from ez_shared($1)", [t2])).toHaveLength(1);

    await sql(a, "select ez_unshare($1)", [r]);
    expect(await sql("anon", "select * from ez_shared($1)", [t2])).toEqual([]);
    expect((await item(r)).share_token).toBeNull();
  });

  it("지운 보고서는 빈 결과", async () => {
    const a = user();
    const r = await report(a, "지울 공유");
    const t = (await one<{ t: string }>(a, "select ez_share($1) t", [r])).t;
    await sql(a, "select ez_delete($1)", [r]);
    expect(await sql("anon", "select * from ez_shared($1)", [t])).toEqual([]);
  });

  it("엉뚱한 열쇠는 빈 결과", async () => {
    for (const t of ["", "short", "a".repeat(22), "' or 1=1 --", null]) {
      expect(await sql("anon", "select * from ez_shared($1)", [t])).toEqual([]);
    }
  });

  it("로그인한 다른 사람도 링크로는 읽을 수 있다", async () => {
    const a = user();
    const r = await report(a, "링크");
    const t = (await one<{ t: string }>(a, "select ez_share($1) t", [r])).t;
    expect(await sql(user(), "select name from ez_shared($1)", [t])).toEqual([{ name: "링크" }]);
  });

  it("폴더는 공유 안 됨", async () => {
    const a = user();
    const f = await folder(a, "폴더");
    await fails(sql(a, "select ez_share($1)", [f]), "EZ_NOT_FOUND");
  });

  it("열쇠를 손으로 넣으면 모양 검사 (22자 base64url)", async () => {
    const a = user();
    const r = await report(a, "손 열쇠");
    await fails(sql(a, "update ez_items set share_token = 'weak' where id = $1", [r]), "23514");
  });
});

describe("version", () => {
  it("넣을 때 1, 내용이 바뀔 때만 +1", async () => {
    const a = user();
    const r = await one(a, "insert into ez_items (kind, name, report_kind, blocks, version) values ('report', 'v', 'data', '[]', 99) returning version, updated_at");
    expect(r.version).toBe(1);
    const id = (await one<{ id: string }>(a, "select id from ez_items where name = 'v'")).id;
    const before = await item(id);

    // 읽음·공유·옮기기는 버전을 올리지 않는다 (에이전트 수정과 충돌하지 않게)
    await sql(a, "select ez_mark_read($1)", [id]);
    await sql(a, "select ez_share($1)", [id]);
    const f = await folder(a, "담을 곳");
    await sql(a, "update ez_items set parent_id = $2 where id = $1", [id, f]);
    let now = await item(id);
    expect(now.version).toBe(1);
    expect(now.read_at).not.toBeNull();
    expect(now.updated_at).toEqual(before.updated_at);

    await sql(a, "update ez_items set blocks = $2 where id = $1", [id, JSON.stringify([{ type: "text", body: "새" }])]);
    now = await item(id);
    expect(now.version).toBe(2);
    await sql(a, "update ez_items set name = 'v2' where id = $1", [id]);
    expect((await item(id)).version).toBe(3);

    // 손으로 version 을 바꿀 수 없다
    await sql(a, "update ez_items set version = 50 where id = $1", [id]);
    expect((await item(id)).version).toBe(3);
  });

  it("ez_mark_read", async () => {
    const a = user();
    const r = await report(a, "읽기");
    expect((await item(r)).read_at).toBeNull();
    await sql(a, "select ez_mark_read($1)", [r]);
    expect((await item(r)).read_at).not.toBeNull();
  });
});

describe("service_role (MCP) 대리 실행", () => {
  it("ez_actor: 로그인한 사람은 자기 자신, service_role 만 p_as, 그 외 null", async () => {
    const a = user();
    const b = user();
    expect((await one(b, "select ez_actor($1) u", [a])).u).toBe(b);
    expect((await one("service", "select ez_actor($1) u", [a])).u).toBe(a);
    expect((await one("service", "select ez_actor(null) u")).u).toBeNull();
    expect((await one("", "select ez_actor($1) u", [a])).u).toBeNull(); // sub 없는 authenticated
    expect((await one("admin", "select ez_actor($1) u", [a])).u).toBeNull();
    await fails(sql("anon", "select ez_actor($1)", [a]), "42501");
  });

  it("service_role 이 p_as 로 A 의 항목을 지우고 복원한다", async () => {
    const a = user();
    const f = await folder(a, "F");
    const r = await report(a, "r", f);
    const batch = (await one<{ b: string }>("service", "select ez_delete($1, $2) b", [f, a])).b;
    expect((await item(r)).deleted_batch).toBe(batch);
    const res = await sql("service", "select * from ez_restore($1, $2)", [batch, a]);
    expect(res.map((x) => x.id)).toEqual([f, r]);
    expect((await item(r)).deleted_at).toBeNull();
  });

  it("service_role 이라도 p_as 가 없거나 주인이 다르면 못 한다", async () => {
    const a = user();
    const r = await report(a, "r");
    await fails(sql("service", "select ez_delete($1)", [r]), "EZ_NOT_FOUND");
    await fails(sql("service", "select ez_delete($1, $2)", [r, user()]), "EZ_NOT_FOUND");
    const batch = (await one<{ b: string }>(a, "select ez_delete($1) b", [r])).b;
    await fails(sql("service", "select * from ez_restore($1)", [batch]), "EZ_NOT_FOUND");
    await fails(sql("service", "select * from ez_restore($1, $2)", [batch, user()]), "EZ_NOT_FOUND");
  });

  it("authenticated 인 B 가 p_as 에 A 를 넣어도 A 것을 못 지우고 못 복원한다", async () => {
    const a = user();
    const b = user();
    const r = await report(a, "A 것");
    await fails(sql(b, "select ez_delete($1, $2)", [r, a]), "EZ_NOT_FOUND");
    expect((await item(r)).deleted_at).toBeNull();
    const batch = (await one<{ b: string }>(a, "select ez_delete($1) b", [r])).b;
    await fails(sql(b, "select * from ez_restore($1, $2)", [batch, a]), "EZ_NOT_FOUND");
    expect((await item(r)).deleted_at).not.toBeNull();
    await fails(sql("anon", "select ez_delete($1, $2)", [r, a]), "42501");
  });

  it("service_role 이 insert 할 때 owner 를 안 주면 실패", async () => {
    await fails(sql("service", "insert into ez_items (kind, name) values ('folder', '주인 없음')"), "23502");
  });

  it("service_role 로 직접 쓰더라도 트리거·CHECK·인덱스가 그대로 막는다", async () => {
    const a = user();
    const b = user();
    const ins = (name: string, parent: string | null, owner = a) =>
      one<{ id: string }>(
        "service",
        "insert into ez_items (owner, kind, name, parent_id) values ($1, 'folder', $2, $3) returning id",
        [owner, name, parent],
      ).then((r) => r.id);
    const move = (id: string, parent: string | null) => sql("service", "update ez_items set parent_id = $2 where id = $1", [id, parent]);

    const top = await ins("A", null);
    const low = await ins("B", top);
    // 이름 겹침 · 이름 규칙
    await fails(ins("a", null), "23505");
    await fails(ins("x/y", null), "23514");
    await fails(ins("..", null), "23514");
    // 남의 폴더 · 없는 폴더 · 보고서 · 지운 폴더
    const bf = await ins("B 폴더", null, b);
    expect(await fails(ins("침범", bf), "EZ_PARENT")).toContain("넣을 폴더가 없습니다");
    await fails(ins("x", randomUUID()), "EZ_PARENT");
    const rep = (
      await one<{ id: string }>(
        "service",
        "insert into ez_items (owner, kind, name, report_kind, blocks) values ($1, 'report', 'r', 'data', '[]') returning id",
        [a],
      )
    ).id;
    await fails(ins("x", rep), "EZ_PARENT");
    const dead = await ins("죽은", null);
    await sql("service", "select ez_delete($1, $2)", [dead, a]);
    await fails(ins("x", dead), "EZ_PARENT");
    // 순환
    await fails(move(top, low), "EZ_CYCLE");
    await fails(move(top, top), "EZ_CYCLE");
    // 깊이
    let p: string | null = null;
    for (let d = 1; d <= 8; d++) p = await ins(`깊이${d}`, p);
    await fails(ins("9단", p), "EZ_DEPTH");
    // 주인 고정
    await fails(sql("service", "update ez_items set owner = $2 where id = $1", [top, b]), "EZ_FIXED");
  });
});

describe("ez_restore 깊이 초과", () => {
  it("원래 부모 아래로 가면 8단을 넘는 항목은 맨 위로 (자손은 그 아래 그대로)", async () => {
    const a = user();
    const chain: string[] = [];
    let p: string | null = null;
    for (let d = 1; d <= 6; d++) chain.push((p = await folder(a, `${d}단`, p)));
    const P = await folder(a, "P");
    const X = await folder(a, "X", P);
    const Y = await folder(a, "Y", X);
    const r = await report(a, "Y 안 보고서", Y);
    const batch = (await one<{ b: string }>(a, "select ez_delete($1) b", [X])).b;
    // 지운 사이 P 를 6단 아래로 → P 는 7단. X 는 8단(된다), Y 는 9단(안 된다)
    await sql(a, "update ez_items set parent_id = $2 where id = $1", [P, chain[5]]);
    await folder(a, "Y"); // 맨 위에 같은 이름도 둬서 이름 겹침까지

    const res = await sql(a, "select * from ez_restore($1)", [batch]);
    const by = Object.fromEntries(res.map((x) => [x.id, x]));
    expect(by[X]).toEqual({ id: X, name: "X", to_root: false, renamed: false });
    expect(by[Y]).toEqual({ id: Y, name: "Y (2)", to_root: true, renamed: true });
    expect(by[r]).toEqual({ id: r, name: "Y 안 보고서", to_root: false, renamed: false });
    expect((await item(X)).parent_id).toBe(P);
    expect((await item(Y)).parent_id).toBeNull();
    expect((await item(r)).parent_id).toBe(Y);
  });

  it("묶음의 맨 위 폴더가 깊이를 넘어도 맨 위로", async () => {
    const a = user();
    const chain: string[] = [];
    let p: string | null = null;
    for (let d = 1; d <= 6; d++) chain.push((p = await folder(a, `${d}단`, p)));
    const X = await folder(a, "X", chain[5]); // 7단
    const batch = (await one<{ b: string }>(a, "select ez_delete($1) b", [X])).b;
    // 그 사이 3단 이하를 두 칸 내린다 → 원래 부모(6단)가 8단이 되어 X 는 9단
    const k1 = await folder(a, "끼움1", chain[1]); // 3단
    const k2 = await folder(a, "끼움2", k1); // 4단 → 3단 폴더가 5단으로
    await sql(a, "update ez_items set parent_id = $2 where id = $1", [chain[2], k2]);
    const res = await sql(a, "select * from ez_restore($1)", [batch]);
    expect(res).toEqual([{ id: X, name: "X", to_root: true, renamed: false }]);
    expect((await item(X)).parent_id).toBeNull();
  });
});
