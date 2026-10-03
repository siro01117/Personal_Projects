// 0013 (읽은 사람의 기록: ez_views · ez_view_open · ez_view_ping · ez_view_name)을 PGlite 에서 돌려 본다. Supabase 흉내는 db/testing.ts.

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

/** 사용자 id · "anon" · "service"(service_role, MCP) · "admin"(postgres) 으로 한 문장 */
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

/** 실패해야 한다. code 가 EZ_ 로 시작하면 P0001 + '[EZ_…] ' 메시지, 아니면 SQLSTATE */
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
/** 22자 기기 열쇠 (base64url 모양) */
const device = (seed = randomUUID()) => seed.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 22).padEnd(22, "_");
const UA = "PC · Chrome";

/** 공유를 켠 보고서 */
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

const open = (token: unknown, dev: unknown, ua: unknown = UA, who = "anon") => sql(who, "select * from ez_view_open($1, $2, $3)", [token, dev, ua]);
const ping = (token: unknown, dev: unknown, sec: unknown = 30, who = "anon") => sql(who, "select ez_view_ping($1, $2, $3)", [token, dev, sec]);
const rename = (token: unknown, dev: unknown, name: unknown, who = "anon") => sql(who, "select ez_view_name($1, $2, $3)", [token, dev, name]);
const rows = (id: string) => sql("admin", "select * from ez_views where item_id = $1 order by last_at desc, id", [id]);
/** 시각을 뒤로 민다 (first_at 도 같이 — last_at >= first_at) */
const backdate = (id: string, minutes: number) =>
  sql("admin", `update ez_views set first_at = first_at - $2 * interval '1 minute', last_at = last_at - $2 * interval '1 minute' where item_id = $1`, [id, minutes]);

// ---------------------------------------------------------------------------

describe("권한", () => {
  it("anon 은 테이블을 읽지도 쓰지도 못하고, 도우미도 못 부른다. 열린 것은 open · ping · name 셋뿐이다", async () => {
    const { id, token } = await shared();
    const d = device();
    await open(token, d);
    await fails(sql("anon", "select * from ez_views"), "42501");
    await fails(sql("anon", "select name from ez_views where item_id = $1", [id]), "42501");
    await fails(sql("anon", "insert into ez_views (item_id, device, guest_no) values ($1, $2, 9)", [id, device()]), "42501");
    await fails(sql("anon", "update ez_views set name = '바꿈' where item_id = $1", [id]), "42501");
    await fails(sql("anon", "delete from ez_views where item_id = $1", [id]), "42501");
    await fails(sql("anon", "select ez_view_target($1)", [token]), "42501");
    await fails(sql("anon", "select * from ez_view_seq"), "42501");
    expect(await open(token, d)).toHaveLength(1);
    expect(await ping(token, d)).toHaveLength(1);
    expect(await rename(token, d, "민서")).toHaveLength(1);
  });

  it("로그인한 사람 · MCP(service_role)도 도우미는 못 부른다. 주인도 테이블에 직접 쓰지 못한다", async () => {
    const { a, id, token } = await shared();
    for (const w of [a, "service"]) await fails(sql(w, "select ez_view_target($1)", [token]), "42501");
    await fails(sql(a, "insert into ez_views (item_id, device, guest_no) values ($1, $2, 1)", [id, device()]), "42501");
    await fails(sql(a, "update ez_views set hits = 99 where item_id = $1", [id]), "42501");
    await fails(sql(a, "delete from ez_views where item_id = $1", [id]), "42501");
    await fails(sql(a, "select * from ez_view_seq"), "42501");
  });

  it("주인은 자기 보고서의 줄만 읽는다. 남의 것은 비어 보인다", async () => {
    const { a, id, token } = await shared();
    const other = await shared();
    const d = device();
    await open(token, d);
    await rename(token, d, "민서");
    await open(other.token, device());
    expect(await sql(a, "select guest_no, name, hits, seconds, ua from ez_views where item_id = $1", [id])).toEqual([
      { guest_no: 1, name: "민서", hits: 1, seconds: 0, ua: UA },
    ]);
    expect(await sql(a, "select name from ez_views where item_id = $1", [other.id])).toEqual([]);
    expect(await sql(a, "select guest_no from ez_views")).toEqual([{ guest_no: 1 }]);
    expect(await sql(user(), "select guest_no from ez_views")).toEqual([]);
  });
});

describe("ez_view_open — 들어옴", () => {
  it("처음은 게스트 번호를 매기고 hits = 1. 다시 들어오면 ua · last_at 갱신 + hits + 1, 번호 · first_at · 이름은 그대로", async () => {
    const { id, token } = await shared();
    const d = device();
    expect(await open(token, d, "폰 · Safari")).toEqual([{ guest_no: 1, name: null }]);
    const [r1] = await rows(id);
    expect(r1).toMatchObject({ item_id: id, device: d, guest_no: 1, name: null, hits: 1, seconds: 0, ua: "폰 · Safari" });
    expect(r1!.first_at).toEqual(r1!.last_at);

    await rename(token, d, "민서");
    await backdate(id, 60);
    const [before] = await rows(id);
    expect(await open(token, d, "PC · Chrome")).toEqual([{ guest_no: 1, name: "민서" }]);
    const all = await rows(id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: r1!.id, guest_no: 1, name: "민서", hits: 2, ua: "PC · Chrome", first_at: before!.first_at });
    expect(new Date(all[0]!.last_at).getTime()).toBeGreaterThan(new Date(before!.last_at).getTime());
  });

  it("게스트 번호는 보고서마다 1부터, 기기가 온 순서. 지워진 번호는 다시 안 쓴다", async () => {
    const a = await shared();
    const b = await shared();
    const d1 = device();
    expect(await open(a.token, d1)).toEqual([{ guest_no: 1, name: null }]);
    expect(await open(a.token, device())).toEqual([{ guest_no: 2, name: null }]);
    expect(await open(b.token, device())).toEqual([{ guest_no: 1, name: null }]);
    expect(await open(a.token, d1)).toEqual([{ guest_no: 1, name: null }]);
    expect(await open(a.token, device())).toEqual([{ guest_no: 3, name: null }]);
    await sql("admin", "delete from ez_views where item_id = $1 and guest_no = 3", [a.id]);
    expect(await open(a.token, device())).toEqual([{ guest_no: 4, name: null }]);
  });

  it("없는 열쇠 · 모양이 다른 열쇠 · 꺼진 링크 · 지운 보고서는 빈 결과 (오류 없이)", async () => {
    const { a, id, token } = await shared();
    for (const t of [null, "", "abc", "a".repeat(22), "a".repeat(23), "%".repeat(22), "'; drop table ez_views; --"]) {
      expect(await open(t, device())).toEqual([]);
      expect(await ping(t, device())).toHaveLength(1);
      expect(await rename(t, device(), "민서")).toHaveLength(1);
    }
    expect(await rows(id)).toEqual([]);

    await sql(a, "select ez_unshare($1)", [id]);
    expect(await open(token, device())).toEqual([]);
    expect(await rows(id)).toEqual([]);

    const t2 = (await one(a, "select ez_share($1) as t", [id])).t as string;
    expect(await open(t2, device())).toHaveLength(1);

    await sql(a, "select ez_delete($1)", [id]);
    expect(await open(t2, device())).toEqual([]);
    expect(await rows(id)).toHaveLength(1);
    // 복원하면 기록은 그대로 있고 다시 적힌다
    const batch = (await one("admin", "select deleted_batch as b from ez_items where id = $1", [id])).b as string;
    await sql(a, "select ez_restore($1)", [batch]);
    expect(await open(t2, device())).toEqual([{ guest_no: 2, name: null }]);
    expect(await rows(id)).toHaveLength(2);
  });

  it("주인 본인(로그인 세션이 그 주인)은 적지 않는다. 다른 로그인 사용자는 적힌다", async () => {
    const { a, id, token } = await shared();
    const d = device();
    expect(await open(token, d, UA, a)).toEqual([]);
    await ping(token, d, 30, a);
    await rename(token, d, "나", a);
    expect(await rows(id)).toEqual([]);
    expect(await open(token, d, UA, user())).toEqual([{ guest_no: 1, name: null }]);
    // 주인이 같은 기기 열쇠로 다시 들어와도 그 줄을 건드리지 않는다
    expect(await open(token, d, UA, a)).toEqual([]);
    await rename(token, d, "나", a);
    expect(await rows(id)).toMatchObject([{ guest_no: 1, name: null, hits: 1 }]);
  });

  it("기기 열쇠 22자 모양을 검사한다. ua 는 80자로 잘라 넣고 비면 null", async () => {
    const { id, token } = await shared();
    await fails(open(token, "short"), "EZ_VALUE");
    await fails(open(token, "a".repeat(23)), "EZ_VALUE");
    await fails(open(token, "%".repeat(22)), "EZ_VALUE");
    await fails(open(token, null), "EZ_VALUE");
    expect(await rows(id)).toEqual([]);

    await open(token, device(), "x".repeat(200));
    await open(token, device(), "   ");
    await open(token, device(), null);
    expect((await rows(id)).map((r) => r.ua).sort()).toEqual([null, null, "x".repeat(80)]);
  });

  it("보고서당 500줄. 다 차면 새 기기는 적지 않고(번호도 안 매김) 빈 결과. 이미 적힌 기기는 그대로 갱신", async () => {
    const { id, token } = await shared();
    // 499줄을 last_at 이 다 다르게 (오래된 것이 앞)
    await sql(
      "admin",
      `insert into ez_views (item_id, device, guest_no, first_at, last_at)
         select $1, lpad(n::text, 22, '0'), n, now() - (1000 - n) * interval '1 minute', now() - (1000 - n) * interval '1 minute'
           from generate_series(1, 499) n`,
      [id],
    );
    await sql("admin", "insert into ez_view_seq (item_id, last) values ($1, 499)", [id]);
    const live = device();
    expect(await open(token, live)).toEqual([{ guest_no: 500, name: null }]);
    const count = async () => (await one("admin", "select count(*)::int as n from ez_views where item_id = $1", [id])).n as number;
    expect(await count()).toBe(500);
    // 501번째 기기는 적지 않는다 — 빈 결과, 줄 · 번호 그대로, 오래된 줄도 그대로
    const late = device();
    expect(await open(token, late)).toEqual([]);
    expect(await count()).toBe(500);
    expect((await one("admin", "select last from ez_view_seq where item_id = $1", [id])).last).toBe(500);
    expect(await sql("admin", "select guest_no from ez_views where item_id = $1 and guest_no in (1, 2, 500, 501) order by guest_no", [id])).toEqual([
      { guest_no: 1 },
      { guest_no: 2 },
      { guest_no: 500 },
    ]);
    // 적히지 않은 기기의 핑 · 이름은 아무것도 안 한다
    await sql("anon", "select ez_view_ping($1, $2, 30)", [token, late]);
    await sql("anon", "select ez_view_name($1, $2, '늦은 사람')", [token, late]);
    expect(await count()).toBe(500);
    // 이미 있던 기기는 다시 들어와도 그대로 갱신된다
    expect(await open(token, live)).toEqual([{ guest_no: 500, name: null }]);
    expect((await one("admin", "select hits from ez_views where item_id = $1 and device = $2", [id, live])).hits).toBe(2);
    expect(await count()).toBe(500);
  });
});

describe("ez_view_ping — 살아 있음 · 읽은 시간", () => {
  it("last_at 을 올리고 seconds 에 보인 초를 더한다 (한 번에 60초까지, 음수 · null 은 0). hits · 이름 · ua 는 그대로", async () => {
    const { id, token } = await shared();
    const d = device();
    await open(token, d);
    await rename(token, d, "민서");
    await backdate(id, 10);
    const [before] = await rows(id);
    await ping(token, d, 30);
    await ping(token, d, 95);
    await ping(token, d, -5);
    await ping(token, d, null);
    await ping(token, d, 0);
    const [after] = await rows(id);
    expect(after).toMatchObject({ id: before!.id, name: "민서", hits: 1, ua: UA, first_at: before!.first_at, seconds: 90 });
    expect(new Date(after!.last_at).getTime()).toBeGreaterThan(new Date(before!.last_at).getTime());
  });

  it("그 기기 줄이 없으면 아무것도 안 한다 (만들지 않는다). 꺼진 링크 · 모양이 다른 기기 열쇠도", async () => {
    const { a, id, token } = await shared();
    const d = device();
    await ping(token, d);
    expect(await rows(id)).toEqual([]);
    await open(token, d);
    expect(await ping(token, "short")).toHaveLength(1);
    expect(await ping(token, null)).toHaveLength(1);
    await sql(a, "select ez_unshare($1)", [id]);
    await backdate(id, 10);
    const [before] = await rows(id);
    await ping(token, d, 30);
    expect((await rows(id))[0]).toMatchObject({ last_at: before!.last_at, seconds: 0 });
  });
});

describe("ez_view_name — 이름", () => {
  it("적기 · 바꾸기 · 비우면 다시 게스트 n (null). 앞뒤 공백은 뗀다", async () => {
    const { id, token } = await shared();
    const d = device();
    await open(token, d);
    await rename(token, d, "  민서 ");
    expect((await rows(id))[0]).toMatchObject({ guest_no: 1, name: "민서" });
    expect(await open(token, d)).toEqual([{ guest_no: 1, name: "민서" }]);
    await rename(token, d, "Min Seo");
    expect((await rows(id))[0]!.name).toBe("Min Seo");
    for (const v of ["", "   ", null]) {
      await rename(token, d, "다시");
      await rename(token, d, v);
      expect((await rows(id))[0]!.name).toBeNull();
    }
  });

  it("20자 넘기거나 줄바꿈이 있으면 EZ_VALUE. 줄이 없으면 아무것도 안 한다", async () => {
    const { id, token } = await shared();
    const d = device();
    await open(token, d);
    await fails(rename(token, d, "가".repeat(21)), "EZ_VALUE");
    await fails(rename(token, d, "줄\n바꿈"), "EZ_VALUE");
    expect(await rename(token, d, "가".repeat(20))).toHaveLength(1);
    expect(await rename(token, device(), "유령")).toHaveLength(1);
    expect(await rows(id)).toHaveLength(1);
  });
});

describe("지우기", () => {
  it("보고서를 영구 삭제하면 같이 지워진다 (cascade). 공유를 끄고 다시 켜도 기록은 남는다", async () => {
    const { a, id, token } = await shared();
    await open(token, device());
    await sql(a, "select ez_unshare($1)", [id]);
    await sql(a, "select ez_share($1)", [id]);
    expect(await rows(id)).toHaveLength(1);
    await sql("admin", "delete from ez_items where id = $1", [id]);
    expect(await rows(id)).toEqual([]);
  });
});
