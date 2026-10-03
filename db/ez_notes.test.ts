// 0014 (방명록 · 댓글 · 방문 기록: ez_visits · ez_notes · ez_notes_list · ez_note_write · ez_note_edit · 고친 ez_view_open / ez_view_ping)을 PGlite 에서 돌려 본다.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sampleBlocks } from "../lib/fixtures";
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

async function one(who: string, text: string, params: unknown[] = []): Promise<Row> {
  const rows = await sql(who, text, params);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function fails(p: Promise<unknown>, code: string): Promise<any> {
  const e: any = await p.then(
    () => null,
    (err) => err,
  );
  expect(e, `${code} 로 실패해야 합니다`).not.toBeNull();
  if (code.startsWith("EZ_")) {
    expect(e.code, e.message).toBe("P0001");
    expect(e.message).toMatch(new RegExp(`^\\[${code}\\] \\S`));
  } else expect(e.code, e.message).toBe(code);
  return e;
}

const user = () => randomUUID();
const device = (seed = randomUUID()) => seed.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 22).padEnd(22, "_");

async function shared(): Promise<{ a: string; id: string; token: string }> {
  const a = user();
  const id = (
    await one(a, "insert into ez_items (kind, name, report_kind, blocks) values ('report', $1, 'method', $2::jsonb) returning id", [
      `보고서 ${randomUUID().slice(0, 8)}`,
      JSON.stringify(sampleBlocks()),
    ])
  ).id as string;
  const token = (await one(a, "select ez_share($1) as t", [id])).t as string;
  return { a, id, token };
}

const open = (token: unknown, dev: unknown, who = "anon") => sql(who, "select * from ez_view_open($1, $2, $3)", [token, dev, "PC · Chrome"]);
const ping = (token: unknown, dev: unknown, sec: unknown = 30, who = "anon") => sql(who, "select ez_view_ping($1, $2, $3)", [token, dev, sec]);
const list = (token: unknown, who = "anon") => sql(who, "select * from ez_notes_list($1)", [token]);
const write = (token: unknown, dev: unknown, body: unknown, block: unknown = null, anchor: unknown = null, who = "anon") =>
  sql(who, "select * from ez_note_write($1, $2, $3, $4, $5)", [token, dev, body, block, anchor]);
const edit = (token: unknown, dev: unknown, id: unknown, body: unknown = null, who = "anon") =>
  sql(who, "select ez_note_edit($1, $2, $3, $4)", [token, dev, id, body]);
const notes = (id: string) => sql("admin", "select * from ez_notes where item_id = $1 order by created_at, id", [id]);
const visits = (id: string) =>
  sql("admin", "select x.*, v.device from ez_visits x join ez_views v on v.id = x.view_id where v.item_id = $1 order by x.started_at, x.id", [id]);
const viewRow = async (id: string, dev: string) => one("admin", "select * from ez_views where item_id = $1 and device = $2", [id, dev]);
/** 그 기기의 방문 시각을 뒤로 민다 */
const backdateVisits = (id: string, dev: string, minutes: number) =>
  sql(
    "admin",
    `update ez_visits x set started_at = x.started_at - $3 * interval '1 minute', last_at = x.last_at - $3 * interval '1 minute'
       from ez_views v where v.id = x.view_id and v.item_id = $1 and v.device = $2`,
    [id, dev, minutes],
  );
/** 보고서를 고쳐 버전을 올린다 */
const bump = async (a: string, id: string): Promise<number> => {
  const v = (await one(a, "select version from ez_items where id = $1", [id])).version as number;
  return (await one(a, "select ez_edit_text($1, $2, $3, $4) as v", [id, v, ["title"], `고침 ${randomUUID().slice(0, 6)}`])).v as number;
};

// ---------------------------------------------------------------------------

describe("권한", () => {
  it("anon 은 두 테이블을 읽지도 쓰지도 못하고 도우미도 못 부른다. 열린 것은 list · write · edit 셋뿐", async () => {
    const { id, token } = await shared();
    const d = device();
    await open(token, d);
    await write(token, d, "안녕");
    await fails(sql("anon", "select * from ez_notes"), "42501");
    await fails(sql("anon", "select * from ez_visits"), "42501");
    await fails(sql("anon", "insert into ez_notes (item_id, body, version) values ($1, 'x', 1)", [id]), "42501");
    await fails(sql("anon", "update ez_notes set body = 'y' where item_id = $1", [id]), "42501");
    await fails(sql("anon", "delete from ez_notes where item_id = $1", [id]), "42501");
    await fails(sql("anon", "insert into ez_visits (view_id, version) select id, 1 from ez_views limit 1"), "42501");
    await fails(sql("anon", "select ez_visit_touch($1, $2, 0)", [randomUUID(), id]), "42501");
    expect(await list(token)).toHaveLength(1);
    expect(await write(token, device(), "유령")).toEqual([]); // 기기 줄이 없다
    expect(await edit(token, d, randomUUID())).toHaveLength(1);
  });

  it("주인은 자기 보고서의 글 · 방문만 읽는다. 남의 것은 비어 보인다. 로그인한 남도 도우미는 못 부른다", async () => {
    const { a, id, token } = await shared();
    const other = await shared();
    const d = device();
    await open(token, d);
    await write(token, d, "첫 글");
    await open(other.token, device());
    await write(other.token, device(), "남의 글"); // 기기 줄이 없어 안 적힌다
    expect(await sql(a, "select body from ez_notes")).toEqual([{ body: "첫 글" }]);
    expect(await sql(a, "select body from ez_notes where item_id = $1", [other.id])).toEqual([]);
    expect(await sql(user(), "select body from ez_notes")).toEqual([]);
    expect(await sql(a, "select count(*)::int as n from ez_visits")).toEqual([{ n: 1 }]);
    expect(await sql(other.a, "select count(*)::int as n from ez_visits")).toEqual([{ n: 1 }]);
    expect(await sql(user(), "select count(*)::int as n from ez_visits")).toEqual([{ n: 0 }]);
    for (const w of [a, "service"]) await fails(sql(w, "select ez_visit_touch($1, $2, 0)", [randomUUID(), id]), "42501");
  });

  it("주인: 답글은 by_owner 로만 (아무 블록에나), 아무 글이나 soft delete, 그 밖은 못 바꾼다 · 못 지운다", async () => {
    const { a, id, token } = await shared();
    const d = device();
    await open(token, d);
    const [n] = await write(token, d, "질문입니다", 1, "배경");
    // 답글
    const [r] = await sql(a, "insert into ez_notes (item_id, body, block, anchor, by_owner) values ($1, '답입니다', 1, '배경', true) returning *", [id]);
    expect(r).toMatchObject({ item_id: id, view_id: null, by_owner: true, body: "답입니다", block: 1, anchor: "배경", version: 1, deleted_at: null });
    // 방명록 답글 (block 없이)
    expect(await sql(a, "insert into ez_notes (item_id, body, by_owner) values ($1, '고맙습니다', true) returning by_owner", [id])).toEqual([{ by_owner: true }]);
    // by_owner 가 아니면 · 다른 사람 보고서면 · version 을 직접 주면 거절
    await fails(sql(a, "insert into ez_notes (item_id, body) values ($1, '남인 척')", [id]), "42501");
    await fails(sql(user(), "insert into ez_notes (item_id, body, by_owner) values ($1, '남', true)", [id]), "42501");
    await fails(sql(a, "insert into ez_notes (item_id, body, by_owner, version) values ($1, 'v', true, 99)", [id]), "42501");
    // 글 · 자리는 못 바꾼다 (열 권한), 지우기는 soft 만
    await fails(sql(a, "update ez_notes set body = '바꿈' where id = $1", [n!.id]), "42501");
    await fails(sql(a, "update ez_notes set block = 3 where id = $1", [n!.id]), "42501");
    await fails(sql(a, "delete from ez_notes where id = $1", [n!.id]), "42501");
    expect(await sql(a, "update ez_notes set deleted_at = now() where id = $1 returning id", [n!.id])).toHaveLength(1);
    expect((await notes(id))[0]!.deleted_at).not.toBeNull();
    // 지운 것은 공개 목록에서 빠진다. 주인 화면은 deleted_at is null 로 걸러 읽는다
    expect((await sql(a, "select body from ez_notes where item_id = $1 and deleted_at is null order by created_at", [id])).map((x) => x.body)).toEqual([
      "답입니다",
      "고맙습니다",
    ]);
    expect((await list(token)).map((x) => x.body)).toEqual(["답입니다", "고맙습니다"]);
    // 남의 보고서 글은 못 지운다
    const other = await shared();
    await sql(other.a, "update ez_notes set deleted_at = now() where item_id = $1", [id]);
    expect((await notes(id)).filter((x) => x.deleted_at !== null)).toHaveLength(1);
  });
});

describe("방문 (ez_visits)", () => {
  it("들어오면 방문 한 줄 (그때 버전). 30분 안에 다시 들어오면 같은 방문, 지나면 새 방문. 핑은 현재 방문과 요약 둘 다에 더한다", async () => {
    const { a, id, token } = await shared();
    const d = device();
    await open(token, d);
    let vs = await visits(id);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ device: d, version: 1, seconds: 0 });
    expect(vs[0]!.started_at).toEqual(vs[0]!.last_at);

    await ping(token, d, 30);
    await ping(token, d, 95);
    await open(token, d); // 30분 안 — 같은 방문
    vs = await visits(id);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ version: 1, seconds: 90 });
    expect(new Date(vs[0]!.last_at).getTime()).toBeGreaterThan(new Date(vs[0]!.started_at).getTime());
    expect(await viewRow(id, d)).toMatchObject({ hits: 2, seconds: 90 });

    // 31분 지난 뒤 — 새 방문, 보고서는 그 사이 고쳐져 v2
    await backdateVisits(id, d, 31);
    expect(await bump(a, id)).toBe(2);
    await ping(token, d, 10);
    vs = await visits(id);
    expect(vs).toHaveLength(2);
    expect(vs[0]).toMatchObject({ version: 1, seconds: 90 });
    expect(vs[1]).toMatchObject({ version: 2, seconds: 10 });
    await open(token, d);
    await ping(token, d, 5);
    vs = await visits(id);
    expect(vs).toHaveLength(2);
    expect(vs[1]).toMatchObject({ version: 2, seconds: 15 });
    expect(await viewRow(id, d)).toMatchObject({ hits: 3, seconds: 105 });
  });

  it("기기당 200줄. 넘으면 오래된 것부터 지운다. 기기 줄이 지워지면 방문도 같이 (cascade)", async () => {
    const { id, token } = await shared();
    const d = device();
    await open(token, d);
    const v = await viewRow(id, d);
    await sql(
      "admin",
      `insert into ez_visits (view_id, version, started_at, last_at)
         select $1, 1, now() - (1000 - n) * interval '1 hour', now() - (1000 - n) * interval '1 hour' from generate_series(1, 199) n`,
      [v.id],
    );
    const count = async () => (await one("admin", "select count(*)::int as n from ez_visits where view_id = $1", [v.id])).n as number;
    expect(await count()).toBe(200);
    await backdateVisits(id, d, 31); // 지금 것도 지나게
    await ping(token, d, 1); // 새 방문 → 201 → 가장 오래된 것이 빠진다
    expect(await count()).toBe(200);
    const oldest = (await one("admin", "select min(started_at) as t from ez_visits where view_id = $1", [v.id])).t as Date;
    expect(Date.now() - new Date(oldest).getTime()).toBeLessThan(999 * 3600_000);
    await sql("admin", "delete from ez_views where id = $1", [v.id]);
    expect(await count()).toBe(0);
  });

  it("없는 열쇠 · 주인 본인 · 모르는 기기는 방문을 안 만든다", async () => {
    const { a, id, token } = await shared();
    const d = device();
    await open("a".repeat(22), d);
    await open(token, d, a);
    await ping(token, device(), 30);
    expect(await visits(id)).toEqual([]);
  });
});

describe("ez_note_write — 쓰기", () => {
  it("방명록(block 없음) · 댓글(block + anchor). version 은 함수가 지금 값을 적고, 쓴 줄을 라벨과 함께 돌려준다", async () => {
    const { a, id, token } = await shared();
    const d = device();
    await open(token, d);
    const [g] = await write(token, d, "  잘 읽었습니다  ");
    expect(g).toMatchObject({ guest_no: 1, label: "게스트 1", by_owner: false, body: "잘 읽었습니다", version: 1, block: null, anchor: null });
    expect(g!.created_at).toEqual(g!.updated_at);

    expect(await bump(a, id)).toBe(2);
    await sql("admin", "update ez_notes set created_at = created_at - interval '1 minute' where item_id = $1", [id]);
    await sql("anon", "select ez_view_name($1, $2, $3)", [token, d, "민서"]);
    const [c] = await write(token, d, "여기 근거가 약합니다", 5, "  근거 ");
    expect(c).toMatchObject({ guest_no: 1, label: "민서", body: "여기 근거가 약합니다", version: 2, block: 5, anchor: "근거" });
    // 방명록에 anchor 를 줘도 버린다
    await sql("admin", "update ez_notes set created_at = created_at - interval '1 minute' where item_id = $1", [id]);
    const [g2] = await write(token, d, "둘째", null, "버려짐");
    expect(g2).toMatchObject({ block: null, anchor: null, version: 2 });

    const all = await list(token);
    expect(all.map((x) => [x.label, x.body, x.version, x.block])).toEqual([
      ["민서", "잘 읽었습니다", 1, null],
      ["민서", "여기 근거가 약합니다", 2, 5],
      ["민서", "둘째", 2, null],
    ]);
    // 주인 답글은 label null · by_owner
    await sql(a, "insert into ez_notes (item_id, body, by_owner) values ($1, '고맙습니다', true)", [id]);
    const last = (await list(token)).at(-1)!;
    expect(last).toMatchObject({ guest_no: null, label: null, by_owner: true, body: "고맙습니다", version: 2 });
  });

  it("없는 열쇠 · 꺼진 링크 · 주인 본인 · 기기 줄 없음은 빈 결과. 글이 비거나 1,000자 넘으면 EZ_VALUE. 10초에 하나 (EZ_RATE)", async () => {
    const { a, id, token } = await shared();
    const d = device();
    expect(await write(token, d, "아직 안 들어옴")).toEqual([]);
    await open(token, d);
    expect(await write("b".repeat(22), d, "없는 열쇠")).toEqual([]);
    expect(await write(token, d, "주인", null, null, a)).toEqual([]);
    await fails(write(token, d, "   "), "EZ_VALUE");
    await fails(write(token, d, null), "EZ_VALUE");
    await fails(write(token, d, "가".repeat(1001)), "EZ_VALUE");
    await fails(write(token, d, "제어\u0001문자"), "EZ_VALUE");
    await fails(write(token, d, "x", -1), "EZ_VALUE");
    expect(await notes(id)).toEqual([]);

    expect(await write(token, d, "가".repeat(1000))).toHaveLength(1);
    await fails(write(token, d, "너무 빨리"), "EZ_RATE");
    await sql("admin", "update ez_notes set created_at = created_at - interval '11 seconds' where item_id = $1", [id]);
    expect(await write(token, d, "이제 됩니다")).toHaveLength(1);
    // 다른 기기는 바로 쓸 수 있다
    const d2 = device();
    await open(token, d2);
    expect(await write(token, d2, "다른 기기")).toHaveLength(1);
    // 꺼진 링크
    await sql(a, "select ez_unshare($1)", [id]);
    expect(await write(token, d2, "꺼짐")).toEqual([]);
    expect(await list(token)).toEqual([]);
    expect(await notes(id)).toHaveLength(3);
  });

  it("보고서당 1,000줄 (지운 것 포함). 넘으면 EZ_LIMIT — 주인 답글도", async () => {
    const { a, id, token } = await shared();
    const d = device();
    await open(token, d);
    const v = await viewRow(id, d);
    await sql(
      "admin",
      `insert into ez_notes (item_id, view_id, body, version, deleted_at)
         select $1, $2, 'n' || n, 1, case when n % 2 = 0 then now() else null end from generate_series(1, 999) n`,
      [id, v.id],
    );
    // 트리거가 created_at 을 now() 로 적으니 뒤에서 민다 (10초 규칙에 안 걸리게)
    await sql("admin", "update ez_notes set created_at = created_at - interval '1 hour', updated_at = updated_at - interval '1 hour' where item_id = $1", [id]);
    expect(await write(token, d, "1000번째")).toHaveLength(1);
    await sql("admin", "update ez_notes set created_at = created_at - interval '11 seconds' where item_id = $1", [id]);
    await fails(write(token, d, "1001번째"), "EZ_LIMIT");
    await fails(sql(a, "insert into ez_notes (item_id, body, by_owner) values ($1, '주인', true)", [id]), "EZ_LIMIT");
    expect(await one("admin", "select count(*)::int as n from ez_notes where item_id = $1", [id])).toEqual({ n: 1000 });
  });
});

describe("ez_note_edit — 고치기 · 지우기", () => {
  it("같은 기기가 쓴 것만 고치고(updated_at 오름) 지운다(soft). 다른 기기 · 주인 글 · 꺼진 링크는 아무것도 안 한다", async () => {
    const { a, id, token } = await shared();
    const d = device();
    const d2 = device();
    await open(token, d);
    await open(token, d2);
    const [mine] = await write(token, d, "내 글");
    // 같은 밀리초에 쓰이면 순서가 id 로 갈리니 내 글을 더 앞으로 민다
    await sql("admin", "update ez_notes set created_at = created_at - interval '2 minutes', updated_at = updated_at - interval '2 minutes' where id = $1", [mine!.id]);
    const [theirs] = await write(token, d2, "남의 글");
    await sql("admin", "update ez_notes set created_at = created_at - interval '1 minute', updated_at = updated_at - interval '1 minute' where id = $1", [theirs!.id]);

    await edit(token, d2, mine!.id, "남이 고침");
    await edit(token, d2, mine!.id);
    expect((await list(token)).map((x) => x.body)).toEqual(["내 글", "남의 글"]);

    await edit(token, d, mine!.id, "  고친 글 ");
    const after = (await list(token)).find((x) => x.id === mine!.id)!;
    expect(after.body).toBe("고친 글");
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(after.created_at).getTime());
    expect(after.version).toBe(1);
    await fails(edit(token, d, mine!.id, "가".repeat(1001)), "EZ_VALUE");

    // 주인 글은 기기로 못 건드린다
    const [o] = await sql(a, "insert into ez_notes (item_id, body, by_owner) values ($1, '주인 글', true) returning id", [id]);
    await edit(token, d, o!.id, "바꿈");
    await edit(token, d, o!.id);
    expect((await list(token)).find((x) => x.id === o!.id)).toMatchObject({ body: "주인 글" });

    // 지우기 — 비우거나 null
    await edit(token, d, mine!.id, "   ");
    expect((await list(token)).map((x) => x.body)).toEqual(["남의 글", "주인 글"]);
    expect((await notes(id)).find((x) => x.id === mine!.id)!.deleted_at).not.toBeNull();
    // 지운 것은 다시 못 살리고 못 고친다
    await edit(token, d, mine!.id, "되살리기");
    expect((await notes(id)).find((x) => x.id === mine!.id)).toMatchObject({ body: "고친 글" });

    await sql(a, "select ez_unshare($1)", [id]);
    await edit(token, d2, theirs!.id);
    expect((await notes(id)).find((x) => x.id === theirs!.id)!.deleted_at).toBeNull();
  });
});

describe("지우기", () => {
  it("보고서를 영구 삭제하면 글 · 방문이 같이 지워진다. 기기 줄이 지워지면 글은 남고 라벨만 없어진다", async () => {
    const { id, token } = await shared();
    const d = device();
    await open(token, d);
    await write(token, d, "남는 글");
    await sql("admin", "delete from ez_views where item_id = $1", [id]);
    expect(await list(token)).toMatchObject([{ body: "남는 글", guest_no: null, label: null, by_owner: false }]);
    await sql("admin", "delete from ez_items where id = $1", [id]);
    expect(await notes(id)).toEqual([]);
    expect(await sql("admin", "select 1 from ez_visits x join ez_views v on v.id = x.view_id where v.item_id = $1", [id])).toEqual([]);
  });
});
