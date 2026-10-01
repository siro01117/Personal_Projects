// 0010 (사람이 블록을 지우고 옮기기: ez_blocks_arrange)를 PGlite 에서 0001~0009 위에 돌려 본다.
// 규칙의 짝: lib/blocks.ts arrangeBlocks · arrangeError (메모리 저장소와 화면이 같은 것을 쓴다).

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { arrangeBlocks, arrangeError, validateBlocks } from "../lib/blocks";
import { sampleBlocks, sampleImage, SAMPLE_OWNER } from "../lib/fixtures";
import { migrations, SUPABASE_STUB } from "./testing";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const m of migrations()) await db.exec(m);
}, 60_000);

type Row = Record<string, any>;

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
  return e.message as string;
}

const user = () => randomUUID();

/** 판정 0 · 문단 1 · 문단 2 · 목록 3 · 표 4 · 근거 5 · 출처 6 · 사진 7 */
const allBlocks = () => [...sampleBlocks(), sampleImage({ src: `${SAMPLE_OWNER}/${"a".repeat(64)}.webp` })];

async function report(who: string, blocks: unknown[] = allBlocks()): Promise<string> {
  const r = await sql(
    who,
    "insert into ez_items (kind, name, report_kind, blocks, agent, agent_updated_at) values ('report', '순서 시험', 'data', $1, 'Claude Code', '2026-09-01T10:00:00Z') returning id",
    [JSON.stringify(blocks)],
  );
  return r[0]!.id;
}
const item = async (id: string) => (await sql("admin", "select * from ez_items where id = $1", [id]))[0]!;
/** int[] 는 '{…}' 글자로 보낸다 (null 은 그대로) */
const lit = (order: unknown) => (Array.isArray(order) ? `{${order.join(",")}}` : order);
const arrange = async (who: string, id: string, ver: number, order: unknown) =>
  (await sql(who, "select ez_blocks_arrange($1, $2, $3::int[]) v", [id, ver, lit(order)]))[0]!.v as number;

// ---------------------------------------------------------------------------

describe("옮기기 · 지우기", () => {
  it("순서를 바꾼다 — 블록 안은 그대로, version 이 오른다. agent_updated_at · read_at 은 그대로", async () => {
    const a = user();
    const id = await report(a);
    await sql(a, "select ez_mark_read($1)", [id]);
    const before = await item(id);
    const order = [0, 3, 1, 2, 7, 4, 5, 6];
    expect(await arrange(a, id, 1, order)).toBe(2);
    const row = await item(id);
    expect(row.blocks).toEqual(order.map((i) => allBlocks()[i]));
    expect(row.version).toBe(2);
    expect(row.agent_updated_at).toEqual(before.agent_updated_at);
    expect(row.read_at).toEqual(before.read_at);
    expect(row.agent).toBe("Claude Code");
    expect(validateBlocks(row.blocks).ok).toBe(true);
    expect(await sql(a, "select * from ez_unread_folders()")).toEqual([]);
  });

  it("빠진 번호는 지워진다 — 지우면서 옮길 수도 있다", async () => {
    const a = user();
    const id = await report(a);
    expect(await arrange(a, id, 1, [0, 1, 3, 4, 5, 6])).toBe(2);
    expect((await item(id)).blocks.map((b: any) => b.type)).toEqual(["verdict", "text", "list", "table", "claims", "sources"]);
    // 번호는 늘 지금 블록 기준
    expect(await arrange(a, id, 2, [5, 0])).toBe(3);
    const row = await item(id);
    expect(row.blocks).toEqual([allBlocks()[6], allBlocks()[0]]);
  });

  it("순서가 그대로면(지움도 없음) 아무것도 안 바꾸고 지금 version 을 돌려준다", async () => {
    const a = user();
    const id = await report(a);
    const before = await item(id);
    expect(await arrange(a, id, 1, [0, 1, 2, 3, 4, 5, 6, 7])).toBe(1);
    const row = await item(id);
    expect(row.version).toBe(1);
    expect(row.updated_at).toEqual(before.updated_at);
    expect(row.blocks).toEqual(before.blocks);
  });

  it("출처 블록이 안 남으면 근거의 출처 번호(refs)가 모두 비워진다. 그 밖의 블록 안은 그대로", async () => {
    const a = user();
    const id = await report(a);
    expect(await arrange(a, id, 1, [0, 1, 2, 3, 4, 5, 7])).toBe(2);
    const row = await item(id);
    const claims = row.blocks[5];
    expect(claims.items.map((c: any) => c.refs)).toEqual([[], [], []]);
    expect(claims.items.map((c: any) => [c.tag, c.text])).toEqual((allBlocks()[5] as any).items.map((c: any) => [c.tag, c.text]));
    expect(claims.h).toBe("근거");
    expect(row.blocks.slice(0, 5)).toEqual(allBlocks().slice(0, 5));
    // 사진의 ref 도 빠진다
    const { ref: _ref, ...img } = allBlocks()[7] as any;
    expect(row.blocks[6]).toEqual(img);
    // lib 과 같은 결과
    expect(row.blocks).toEqual(arrangeBlocks(allBlocks(), [0, 1, 2, 3, 4, 5, 7]));
  });

  it("출처 블록이 남아 있으면 refs 는 그대로 — 출처를 옮기기만 해도", async () => {
    const a = user();
    const id = await report(a);
    await arrange(a, id, 1, [6, 5, 0]);
    const row = await item(id);
    expect(row.blocks[1].items.map((c: any) => c.refs)).toEqual([[1], [], [1, 2]]);
    expect(row.blocks).toEqual(arrangeBlocks(allBlocks(), [6, 5, 0]));
  });

  it("근거 블록이 여러 개여도 전부 비운다. 모양이 깨진 항목은 그대로 둔다", async () => {
    const a = user();
    const blocks = [
      { type: "claims", h: "하나", items: [{ tag: "fact", text: "가", refs: [1] }] },
      { type: "sources", h: "출처", items: [{ title: "t", url: "https://a.example" }] },
      { type: "claims", h: "둘", items: [{ tag: "guess", text: "나", refs: [1] }, "깨진 항목", { tag: "fact", text: "refs 없음" }] },
      { type: "claims", h: "셋", items: "배열 아님" },
      "블록 아님",
    ];
    const id = await report(a, blocks);
    expect(await arrange(a, id, 1, [4, 3, 2, 0])).toBe(2);
    const row = await item(id);
    expect(row.blocks).toEqual([
      "블록 아님",
      { type: "claims", h: "셋", items: "배열 아님" },
      { type: "claims", h: "둘", items: [{ tag: "guess", text: "나", refs: [] }, "깨진 항목", { tag: "fact", text: "refs 없음" }] },
      { type: "claims", h: "하나", items: [{ tag: "fact", text: "가", refs: [] }] },
    ]);
    expect(row.blocks).toEqual(arrangeBlocks(blocks, [4, 3, 2, 0]));
  });

  it("출처 블록이 안 남으면 사진 블록의 ref 도 빠진다. 남아 있으면 그대로", async () => {
    const a = user();
    const blocks = [
      { type: "image", path: "p/a.png", alt: "가", ref: 1, credit: "직접 캡처" },
      { type: "sources", h: "출처", items: [{ title: "t", url: "https://a.example" }] },
      { type: "text", body: "글" },
    ];
    const id = await report(a, blocks);
    expect(await arrange(a, id, 1, [1, 0, 2])).toBe(2);
    expect((await item(id)).blocks[1].ref).toBe(1);
    expect(await arrange(a, id, 2, [1, 2])).toBe(3);
    const row = await item(id);
    expect(row.blocks[0]).toEqual({ type: "image", path: "p/a.png", alt: "가", credit: "직접 캡처" });
    expect(row.blocks).toEqual(arrangeBlocks([blocks[1], blocks[0], blocks[2]], [1, 2]));
  });
});

describe("거절", () => {
  it("비었거나 · 겹치거나 · 범위 밖이면 EZ_VALUE — 문구가 lib arrangeError 와 같다", async () => {
    const a = user();
    const id = await report(a);
    const cases: number[][] = [[], [0, 0], [1, 2, 1], [8], [-1], [0, 1, 99], [-1, -1]];
    for (const order of cases) {
      const msg = await fails(arrange(a, id, 1, order), "EZ_VALUE");
      expect(msg, JSON.stringify(order)).toBe(`[EZ_VALUE] ${arrangeError(8, order)}`);
    }
    expect(await fails(arrange(a, id, 1, []), "EZ_VALUE")).toContain("블록이 하나는 남아야 합니다");
    await fails(arrange(a, id, 1, null), "EZ_VALUE");
    await fails(sql(a, "select ez_blocks_arrange($1, 1, '{0,null}'::int[])", [id]), "EZ_VALUE");
    await fails(sql(a, "select ez_blocks_arrange($1, 1, '{{0,1},{2,3}}'::int[])", [id]), "EZ_VALUE");
    const row = await item(id);
    expect(row.version).toBe(1);
    expect(row.blocks).toEqual(allBlocks());
  });

  it("버전 불일치는 ez_edit_text 와 같은 EZ_VERSION 문구", async () => {
    const a = user();
    const id = await report(a);
    await sql(a, "select ez_edit_text($1, 1, '{1,body}', '먼저 고침')", [id]);
    const msg = await fails(arrange(a, id, 1, [1, 0]), "EZ_VERSION");
    const same = await fails(sql(a, "select ez_edit_text($1, 1, '{1,body}', '늦음')", [id]), "EZ_VERSION");
    expect(msg).toBe(same);
    expect(msg).toContain("지금 버전 2");
    // 그대로인 순서여도 낡은 버전이면 충돌
    await fails(arrange(a, id, 1, [0, 1, 2, 3, 4, 5, 6, 7]), "EZ_VERSION");
    expect(await arrange(a, id, 2, [1, 0])).toBe(3);
    // 순서를 바꾼 뒤 낡은 버전으로 글자를 고쳐도 충돌
    await fails(sql(a, "select ez_edit_text($1, 2, '{0,body}', '낡은 수정')", [id]), "EZ_VERSION");
    expect((await sql(a, "select ez_edit_text($1, 3, '{0,body}', '새 번호로') v", [id]))[0]!.v).toBe(4);
    expect((await item(id)).blocks[0].body).toBe("새 번호로");
  });

  it("보고서만 · 주인만 · 지워지지 않은 것만 (EZ_NOT_FOUND)", async () => {
    const a = user();
    const id = await report(a);
    const f = (await sql(a, "insert into ez_items (kind, name) values ('folder', '폴더') returning id"))[0]!.id;
    await fails(arrange(a, f, 1, [0]), "EZ_NOT_FOUND");
    await fails(arrange(user(), id, 1, [1, 0]), "EZ_NOT_FOUND");
    await fails(arrange(a, randomUUID(), 1, [0]), "EZ_NOT_FOUND");
    await sql(a, "select ez_delete($1)", [id]);
    await fails(arrange(a, id, 1, [1, 0]), "EZ_NOT_FOUND");
    expect((await item(id)).blocks).toEqual(allBlocks());
  });

  it("로그인한 사람만 — anon · service_role 은 못 쓴다", async () => {
    const a = user();
    const id = await report(a);
    await fails(sql("anon", "select ez_blocks_arrange($1, 1, '{1,0}'::int[])", [id]), "42501");
    await fails(sql("service", "select ez_blocks_arrange($1, 1, '{1,0}'::int[])", [id]), "42501");
    expect((await item(id)).version).toBe(1);
  });
});
