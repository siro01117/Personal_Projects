// 0009 (사람이 고치는 칸: 빈칸 허용 · 줄바꿈 되는 칸 · 작성자)를 PGlite 에서 0001~0008 위에 돌려 본다.
// 규칙의 짝: lib/blocks.ts editRule(한 줄·여러 줄) · tidyText(다듬기).

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { editRule, tidyText, validateBlocks } from "../lib/blocks";
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
type P = (string | number)[];

/** 모든 블록 종류 + 사진 */
const allBlocks = () => [...sampleBlocks(), sampleImage({ src: `${SAMPLE_OWNER}/${"a".repeat(64)}.webp` })];

async function report(who: string, name = "편집 시험", blocks: unknown[] = allBlocks()): Promise<string> {
  const r = await sql(
    who,
    "insert into ez_items (kind, name, report_kind, blocks, agent, agent_updated_at) values ('report', $1, 'data', $2, 'Claude Code', '2026-09-01T10:00:00Z') returning id",
    [name, JSON.stringify(blocks)],
  );
  return r[0]!.id;
}
const item = async (id: string) => (await sql("admin", "select * from ez_items where id = $1", [id]))[0]!;
const edit = async (who: string, id: string, ver: number, path: P, value: string | null) =>
  (await sql(who, "select ez_edit_text($1, $2, $3, $4) v", [id, ver, path.map(String), value]))[0]!.v as number;

/** 사람이 고칠 수 있는 블록 칸 전부 */
const EDITABLE: P[] = [
  [0, "v"], [0, "w"], [1, "h"], [1, "body"], [2, "body"], [3, "h"], [3, "items", 1],
  [4, "h"], [4, "cols", 0], [4, "rows", 1, 2], [5, "h"], [5, "items", 0, "text"], [6, "h"], [6, "items", 1, "title"],
  [7, "alt"], [7, "caption"],
];
const MULTI: P[] = [[0, "w"], [1, "body"], [2, "body"], [3, "items", 1], [4, "rows", 1, 2], [5, "items", 0, "text"]];
const SINGLE: P[] = EDITABLE.filter((p) => !MULTI.some((m) => JSON.stringify(m) === JSON.stringify(p)));

const at = (blocks: any, path: P) => path.reduce((x, k) => x[k], blocks);

// ---------------------------------------------------------------------------

describe("빈칸 허용", () => {
  it("블록 칸은 모두 비울 수 있다 — 공백만이어도, null 이어도 빈 값('')으로. 버전은 오른다", async () => {
    const a = user();
    const id = await report(a);
    let v = 1;
    for (const [k, p] of EDITABLE.entries()) {
      const next = await edit(a, id, v, p, k % 3 === 0 ? "" : k % 3 === 1 ? "  \n　 " : null);
      expect(next, JSON.stringify(p)).toBe(v + 1);
      v = next;
    }
    const row = await item(id);
    for (const p of EDITABLE) expect(at(row.blocks, p), JSON.stringify(p)).toBe("");
    // 구조는 그대로 — 옆 칸·개수·종류
    expect(row.blocks.map((b: any) => b.type)).toEqual(allBlocks().map((b: any) => b.type));
    expect(row.blocks[3].items).toEqual(["PGlite", "", "Supabase 브랜치"]);
    expect(row.blocks[6].items[1].url).toBe((sampleBlocks()[6] as any).items[1].url);
    // 에이전트 쪽 검사: 기본은 거절, allowEmpty 는 통과 (lib 과 DB 가 같은 칸을 비울 수 있게 한다)
    expect(validateBlocks(row.blocks).ok).toBe(false);
    expect(validateBlocks(row.blocks, { allowEmpty: true }).ok).toBe(true);
  });

  it("비운 칸은 다시 채울 수 있다 — 여전히 고칠 수 있는 칸", async () => {
    const a = user();
    const id = await report(a);
    let v = await edit(a, id, 1, [1, "h"], "");
    v = await edit(a, id, v, [4, "rows", 0, 0], " ");
    // 이미 빈 칸에 빈 값: 바뀐 것이 없어 버전 그대로
    expect(await edit(a, id, v, [1, "h"], "")).toBe(v);
    v = await edit(a, id, v, [1, "h"], "다시 채움");
    v = await edit(a, id, v, [4, "rows", 0, 0], "칸");
    const row = await item(id);
    expect(row.blocks[1].h).toBe("다시 채움");
    expect(row.blocks[4].rows[0][0]).toBe("칸");
    // 키가 없는 선택 칸은 새로 만들 수 없다
    await fails(edit(a, id, v, [2, "h"], "x"), "EZ_PATH");
    await fails(edit(a, id, v, [2, "h"], ""), "EZ_PATH");
  });

  it("보고서 제목은 비울 수 없다", async () => {
    const a = user();
    const id = await report(a);
    await fails(edit(a, id, 1, ["title"], ""), "EZ_EMPTY");
    await fails(edit(a, id, 1, ["title"], " \n "), "EZ_EMPTY");
    await fails(edit(a, id, 1, ["title"], null), "EZ_EMPTY");
    expect((await item(id)).name).toBe("편집 시험");
  });

  it("고칠 수 없는 칸은 빈 값이어도 EZ_PATH, 길이 상한은 그대로", async () => {
    const a = user();
    const id = await report(a);
    for (const p of [[6, "items", 0, "url"], [0, "type"], [5, "items", 0, "tag"], [7, "src"], [7, "credit"]] as P[]) {
      await fails(edit(a, id, 1, p, ""), "EZ_PATH");
    }
    await fails(edit(a, id, 1, [1, "h"], "가".repeat(201)), "EZ_VALUE");
    await fails(edit(a, id, 1, [3, "items", 0], "가".repeat(601)), "EZ_VALUE");
    expect(await edit(a, id, 1, [3, "items", 0], "가".repeat(600))).toBe(2);
  });
});

describe("줄바꿈", () => {
  it("되는 칸: 문단 · 판정 풀이 · 목록 항목 · 표 칸 · 근거 글 — 가운데 줄바꿈을 지킨다", async () => {
    const a = user();
    const id = await report(a);
    let v = 1;
    for (const p of MULTI) v = await edit(a, id, v, p, "첫 줄\n둘째 줄");
    const row = await item(id);
    for (const p of MULTI) expect(at(row.blocks, p), JSON.stringify(p)).toBe("첫 줄\n둘째 줄");
  });

  it("한 줄 칸: 소제목 · 판정 한 줄 · 표 머리 · 출처 제목 · 사진 설명·캡션 · 제목 — 줄바꿈은 EZ_VALUE", async () => {
    const a = user();
    const id = await report(a);
    for (const p of SINGLE) {
      for (const nl of ["\n", "\r", " ", " "]) {
        const msg = await fails(edit(a, id, 1, p, `두${nl}줄`), "EZ_VALUE");
        expect(msg, JSON.stringify(p)).toContain("한 줄로");
      }
    }
    await fails(edit(a, id, 1, ["title"], "두\n줄"), "23514");
    expect((await item(id)).version).toBe(1);
  });

  it("한 줄·여러 줄 판정이 lib editRule 과 같다 (고칠 수 있는 칸 전부)", async () => {
    const blocks = allBlocks();
    for (const p of EDITABLE) {
      const [r] = await sql("admin", "select * from ez_edit_rule($1, $2)", [JSON.stringify(blocks), p.map(String)]);
      const lib = editRule(blocks, p)!;
      expect({ max_length: r!.max_length, one_line: r!.one_line }, JSON.stringify(p)).toEqual({ max_length: lib.maxLength, one_line: lib.oneLine });
      expect(lib.oneLine, JSON.stringify(p)).toBe(SINGLE.includes(p));
    }
  });

  it("다듬기가 lib tidyText 와 같다 — 줄 끝 공백·앞뒤 빈 줄은 지우고 연속 빈 줄은 하나로", async () => {
    const a = user();
    const id = await report(a);
    const samples = [
      "  첫 줄  \r\n둘째 줄\t\n\n\n\n넷째　\n마지막 \n\n ",
      "\n\n앞뒤 빈 줄\n\n",
      "맥 줄바꿈\r둘째\r\r\r\r셋째",
      "한 줄 그대로",
      "  들여쓴 둘째 줄\n  은 그대로 \n끝",
      " \n ",
    ];
    let v = 1;
    for (const s of samples) {
      const next = await edit(a, id, v, [1, "body"], s);
      const got = (await item(id)).blocks[1].body;
      expect(got, JSON.stringify(s)).toBe(tidyText(s));
      v = next;
    }
    expect(tidyText(samples[0]!)).toBe("첫 줄\n둘째 줄\n\n넷째\n마지막");
    // 길이는 다듬은 뒤로 센다
    v = await edit(a, id, v, [3, "items", 0], `${"가".repeat(300)} \n\n\n\n${"나".repeat(298)}  `);
    expect([...(await item(id)).blocks[3].items[0]]).toHaveLength(600);
  });
});

describe("작성자 (path {agent})", () => {
  it("고치면 trim 된 값이 들어가고 version 이 오른다. agent_updated_at · read_at 은 그대로 (안 읽음 점이 생기지 않는다)", async () => {
    const a = user();
    const id = await report(a);
    await sql(a, "select ez_mark_read($1)", [id]);
    const before = await item(id);
    expect(await edit(a, id, 1, ["agent"], "  김조사  ")).toBe(2);
    const row = await item(id);
    expect(row.agent).toBe("김조사");
    expect(row.version).toBe(2);
    expect(row.agent_updated_at).toEqual(before.agent_updated_at);
    expect(row.read_at).toEqual(before.read_at);
    expect(row.blocks).toEqual(before.blocks);
    expect(await sql(a, "select * from ez_unread_folders()")).toEqual([]);
    // 같은 값이면 버전 그대로
    expect(await edit(a, id, 2, ["agent"], "김조사")).toBe(2);
  });

  it("1~100자 한 줄. 빈 값이면 null", async () => {
    const a = user();
    const id = await report(a);
    expect(await edit(a, id, 1, ["agent"], "가".repeat(100))).toBe(2);
    await fails(edit(a, id, 2, ["agent"], "가".repeat(101)), "EZ_VALUE");
    await fails(edit(a, id, 2, ["agent"], "두\n줄"), "EZ_VALUE");
    await fails(edit(a, id, 2, ["agent"], "두 줄"), "EZ_VALUE");
    expect(await edit(a, id, 2, ["agent"], "   ")).toBe(3);
    expect((await item(id)).agent).toBeNull();
    // 이미 없는데 또 비우면 그대로, null 도 빈 값
    expect(await edit(a, id, 3, ["agent"], null)).toBe(3);
    expect(await edit(a, id, 3, ["agent"], "다시")).toBe(4);
    expect((await item(id)).agent).toBe("다시");
  });

  it("폴더는 거절 (EZ_PATH), 남의 것 · 지운 것은 EZ_NOT_FOUND", async () => {
    const a = user();
    const f = (await sql(a, "insert into ez_items (kind, name) values ('folder', '폴더') returning id"))[0]!.id;
    await fails(edit(a, f, 1, ["agent"], "x"), "EZ_PATH");
    expect((await item(f)).agent).toBeNull();
    const id = await report(a);
    await fails(edit(user(), id, 1, ["agent"], "뺏음"), "EZ_NOT_FOUND");
    await sql(a, "select ez_delete($1)", [id]);
    await fails(edit(a, id, 1, ["agent"], "x"), "EZ_NOT_FOUND");
    expect((await item(id)).agent).toBe("Claude Code");
  });

  it("버전 충돌 — 낡은 버전이면 EZ_VERSION, 작성자를 고친 뒤 낡은 버전으로 글자를 고쳐도 충돌", async () => {
    const a = user();
    const id = await report(a);
    await edit(a, id, 1, [1, "body"], "먼저 고침");
    const msg = await fails(edit(a, id, 1, ["agent"], "늦음"), "EZ_VERSION");
    expect(msg).toContain("지금 버전 2");
    expect((await item(id)).agent).toBe("Claude Code");
    expect(await edit(a, id, 2, ["agent"], "사람")).toBe(3);
    await fails(edit(a, id, 2, [1, "body"], "낡은 수정"), "EZ_VERSION");
  });

  it("{agent, x} 같은 경로는 고칠 수 없다", async () => {
    const a = user();
    const id = await report(a);
    await fails(edit(a, id, 1, ["agent", "x"], "x"), "EZ_PATH");
    await fails(edit(a, id, 1, ["Agent"], "x"), "EZ_PATH");
  });
});

describe("권한 · 트리거", () => {
  it("ez_edit_text 는 로그인한 사람만 — anon · service_role 은 못 쓴다 (0001 과 같다)", async () => {
    const a = user();
    const id = await report(a);
    await fails(sql("anon", "select ez_edit_text($1, 1, '{agent}', 'x')", [id]), "42501");
    await fails(sql("anon", "select ez_edit_text($1, 1, '{1,body}', '')", [id]), "42501");
    await fails(sql("service", "select ez_edit_text($1, 1, '{agent}', 'x')", [id]), "42501");
    expect(await sql("service", "select max_length, one_line from ez_edit_rule($1, '{1,h}')", [JSON.stringify(allBlocks())])).toEqual([
      { max_length: 200, one_line: true },
    ]);
  });

  it("직접 update 로 작성자만 바꿔도 version 이 오른다. 읽음·공유·옮기기는 여전히 안 오른다", async () => {
    const a = user();
    const id = await report(a);
    await sql(a, "select ez_mark_read($1)", [id]);
    await sql(a, "select ez_share($1)", [id]);
    expect((await item(id)).version).toBe(1);
    await sql(a, "update ez_items set agent = '직접' where id = $1", [id]);
    expect((await item(id)).version).toBe(2);
    await sql(a, "update ez_items set agent = '직접' where id = $1", [id]);
    expect((await item(id)).version).toBe(2);
  });
});
