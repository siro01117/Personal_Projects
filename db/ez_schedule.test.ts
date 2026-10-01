// 0006 (일정 · 플래너: 지점 · 이동시간 · 할 일 · 일정 · 예외 · 설정 · 출처, sync · split · cut)을 PGlite 에서 0001~0005 위에 돌려 본다.
// Supabase 흉내는 db/testing.ts. 날짜: 2026-10-05 가 월요일.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/schedule/types";
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
const val = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

/** 표에 한 줄 넣고 그 줄 */
async function ins(who: string, table: string, obj: Record<string, unknown>): Promise<Row> {
  const keys = Object.keys(obj);
  if (keys.length === 0) return one(who, `insert into ${table} default values returning *`);
  return one(
    who,
    `insert into ${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    keys.map((k) => val(obj[k])),
  );
}

const EV_COLS = "id, owner, title, date::text as date, start_min, end_min, place_id, where_text, travel_min, note, repeat, source, external_id, task_id, version, deleted_at";

async function place(who: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await ins(who, "ez_places", { name, ...extra })).id;
}
async function event(who: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await ins(who, "ez_events", { title: "일정", date: "2026-10-05", start_min: 540, end_min: 600, ...extra })).id;
}
async function task(who: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await ins(who, "ez_tasks", { title: "할 일", ...extra })).id;
}
const ev = (id: string) => one("admin", `select ${EV_COLS} from ez_events where id = $1`, [id]);
const exs = async (id: string) =>
  (await sql("admin", "select on_date::text as on_date, skip, patch from ez_event_exceptions where event_id = $1 order by on_date", [id])).map(
    (r) => r.on_date,
  );
const addEx = (who: string, id: string, on: string, patch: unknown = null, skip = patch === null) =>
  sql(who, "insert into ez_event_exceptions (event_id, on_date, skip, patch) values ($1, $2, $3, $4)", [id, on, skip, val(patch)]);

const sync = (who: string, source: string, from: string, to: string, events: unknown, label: string | null = null, as: string | null = null) =>
  one(who, "select ez_schedule_sync($1, $2, $3, $4, $5, $6) r", [source, from, to, JSON.stringify(events), label, as]).then((r) => r.r);
const split = (who: string, id: string, base: number, on: string, patch: unknown, as: string | null = null) =>
  one(who, `select ${EV_COLS} from ez_event_split($1, $2, $3, $4, $5)`, [id, base, on, val(patch), as]);
const cut = (who: string, id: string, base: number, on: string, as: string | null = null) =>
  one(who, `select ${EV_COLS} from ez_event_cut($1, $2, $3, $4)`, [id, base, on, as]);

const ext = (external_id: string, date: string, extra: Record<string, unknown> = {}) => ({
  external_id,
  title: `근무 ${external_id}`,
  date,
  start_min: 600,
  end_min: 900,
  ...extra,
});
/** sync 로 바깥 일정 하나 만들고 id */
async function external(a: string, source = "studycube"): Promise<string> {
  await sync(a, source, "2026-10-01", "2026-10-31", [ext("x1", "2026-10-06")]);
  return (await one(a, "select id from ez_events where source = $1 and external_id = 'x1' and deleted_at is null", [source])).id;
}

const TABLES = ["ez_places", "ez_travel", "ez_tasks", "ez_events", "ez_event_exceptions", "ez_schedule_settings", "ez_sources"];

// ---------------------------------------------------------------------------

describe("권한 · RLS", () => {
  it("anon 은 일곱 표 모두 읽기 · 쓰기 못 하고 함수도 못 부른다", async () => {
    for (const t of TABLES) await fails(sql("anon", `select * from ${t}`), "42501");
    await fails(sql("anon", "insert into ez_places (owner, name) values ($1, '집')", [user()]), "42501");
    await fails(sql("anon", "select ez_schedule_sync('x', '2026-10-01', '2026-10-02', '[]')"), "42501");
    await fails(sql("anon", "select ez_event_split($1, 1, '2026-10-05', '{}')", [randomUUID()]), "42501");
    await fails(sql("anon", "select ez_event_cut($1, 1, '2026-10-05')", [randomUUID()]), "42501");
    await fails(sql("anon", "select ez_occurs_on(null, '2026-10-05', '2026-10-05')"), "42501");
  });

  it("남의 것은 안 보이고 못 고친다", async () => {
    const a = user();
    const b = user();
    const p = await place(a, "집", { role: "home" });
    const q = await place(a, "회사", { role: "work" });
    const [x, y] = [p, q].sort();
    await ins(a, "ez_travel", { a: x, b: y, minutes: 30 });
    const t = await task(a);
    const e = await event(a, { repeat: { freq: "daily" } });
    await addEx(a, e, "2026-10-06");
    await ins(a, "ez_schedule_settings", {});
    await sync(a, "univ", "2026-10-01", "2026-10-31", [ext("u1", "2026-10-07")]);

    for (const t2 of TABLES) expect(await sql(b, `select * from ${t2}`), t2).toHaveLength(0);
    expect(await sql(a, "select * from ez_event_exceptions")).toHaveLength(1);

    expect(await sql(b, "update ez_places set name = '뺏음' where id = $1 returning id", [p])).toHaveLength(0);
    expect(await sql(b, "update ez_tasks set title = '뺏음' where id = $1 returning id", [t])).toHaveLength(0);
    expect(await sql(b, "update ez_events set title = '뺏음' where id = $1 returning id", [e])).toHaveLength(0);
    expect(await sql(b, "update ez_schedule_settings set prep_first = 0 returning owner")).toHaveLength(0);
    expect(await sql(b, "delete from ez_travel returning owner")).toHaveLength(0);
    expect(await sql(b, "delete from ez_event_exceptions returning event_id")).toHaveLength(0);
    // 남의 일정에 예외 넣기 · 남의 주인으로 넣기
    await fails(addEx(b, e, "2026-10-07"), "42501");
    await fails(sql(b, "insert into ez_tasks (owner, title) values ($1, '침범')", [a]), "42501");
    await fails(sql(b, "insert into ez_events (owner, title, date) values ($1, '침범', '2026-10-05')", [a]), "42501");
    // 남의 일정을 split · cut
    await fails(split(b, e, 1, "2026-10-07", {}), "EZ_NOT_FOUND");
    await fails(split(b, e, 1, "2026-10-07", {}, a), "EZ_NOT_FOUND"); // authenticated 의 p_as 는 무시
    await fails(cut(b, e, 1, "2026-10-07"), "EZ_NOT_FOUND");
    expect((await ev(e)).version).toBe(1);
  });

  it("지점 · 할 일 · 일정은 authenticated 가 행을 지울 수 없다 (soft delete 만)", async () => {
    const a = user();
    const p = await place(a, "집");
    const t = await task(a);
    const e = await event(a);
    await fails(sql(a, "delete from ez_places where id = $1", [p]), "42501");
    await fails(sql(a, "delete from ez_tasks where id = $1", [t]), "42501");
    await fails(sql(a, "delete from ez_events where id = $1", [e]), "42501");
    await sql(a, "update ez_events set deleted_at = now() where id = $1", [e]);
    expect((await ev(e)).deleted_at).not.toBeNull();
  });

  it("service_role 은 owner 를 적어 직접 쓰고, 안 적으면 실패", async () => {
    const a = user();
    await fails(sql("service", "insert into ez_events (title, date) values ('주인 없음', '2026-10-05')"), "23502");
    await fails(sql("service", "insert into ez_places (name) values ('주인 없음')"), "23502");
    const e = await ins("service", "ez_events", { owner: a, title: "대리", date: "2026-10-05" });
    expect(e.owner).toBe(a);
    expect(await sql(a, "select id from ez_events")).toHaveLength(1);
  });
});

describe("지점", () => {
  it("이름 1~30자, 앞뒤 공백 없음", async () => {
    const a = user();
    await place(a, "가".repeat(30));
    await fails(place(a, "나".repeat(31)), "23514");
    await fails(place(a, ""), "23514");
    await fails(place(a, " 앞공백"), "23514");
    await fails(place(a, "뒤공백　"), "23514");
  });

  it("역할 · 심볼 · 색은 정해진 것만. 심볼은 역할에서, 색은 덜 쓴 것부터", async () => {
    const a = user();
    await fails(place(a, "x", { role: "gym" }), "23514");
    await fails(place(a, "x", { symbol: "star" }), "23514");
    await fails(place(a, "x", { color: "red" }), "23514");
    const rows = [];
    for (const [name, role] of [["집", "home"], ["학교", "school"], ["회사", "work"], ["카페", null]] as const)
      rows.push(await ins(a, "ez_places", { name, role }));
    expect(rows.map((r) => r.symbol)).toEqual(["home", "school", "work", "pin"]);
    expect(rows.map((r) => r.color)).toEqual(["sky", "violet", "peach", "sand"]);
    const gym = await ins(a, "ez_places", { name: "헬스", symbol: "gym", color: "sky" });
    expect([gym.symbol, gym.color]).toEqual(["gym", "sky"]);
    expect((await ins(a, "ez_places", { name: "다음" })).color).toBe("mint");
    // 지운 지점의 색은 다시 쓸 수 있다
    await sql(a, "update ez_places set deleted_at = now() where id = $1", [rows[1]!.id]);
    expect((await ins(a, "ez_places", { name: "또" })).color).toBe("violet");
  });

  it("살아 있는 지점끼리 이름 겹침 금지 (대소문자 무시). 지운 것 · 남의 것과는 된다", async () => {
    const a = user();
    const p = await place(a, "Cafe");
    await fails(place(a, "cafe"), "23505");
    await place(user(), "cafe");
    await sql(a, "update ez_places set deleted_at = now() where id = $1", [p]);
    await place(a, "CAFE");
    const q = await place(a, "다른");
    await fails(sql(a, "update ez_places set name = 'cafe' where id = $1", [q]), "23505");
  });

  it("집은 한 사람에 하나 (지운 집은 빼고). 근무지 · 학교는 여럿", async () => {
    const a = user();
    const h = await place(a, "집", { role: "home" });
    await fails(place(a, "본가", { role: "home" }), "23505");
    await place(a, "회사1", { role: "work" });
    await place(a, "회사2", { role: "work" });
    await place(a, "학교1", { role: "school" });
    await place(a, "학교2", { role: "school" });
    await place(user(), "남의 집", { role: "home" });
    await sql(a, "update ez_places set deleted_at = now() where id = $1", [h]);
    await place(a, "새 집", { role: "home" });
    await fails(sql(a, "update ez_places set deleted_at = null where id = $1", [h]), "23505");
  });

  it("살아 있는 지점 12개까지 — 넣기와 되살리기 모두", async () => {
    const a = user();
    const ids: string[] = [];
    for (let i = 1; i <= 12; i++) ids.push(await place(a, `지점${i}`));
    const e = await fails(place(a, "13번째"), "EZ_LIMIT");
    expect(e.message).toContain("12개");
    await sql(a, "update ez_places set deleted_at = now() where id = $1", [ids[0]]);
    await place(a, "13번째");
    await fails(sql(a, "update ez_places set deleted_at = null where id = $1", [ids[0]]), "EZ_LIMIT");
    await place(user(), "남은 상관없음");
  });

  it("version: 바뀌면 +1, 같은 값이면 그대로, 손으로 못 바꿈. 주인은 못 바꿈", async () => {
    const a = user();
    const r = await ins(a, "ez_places", { name: "집", version: 9 });
    expect(r.version).toBe(1);
    await sql(a, "update ez_places set name = '우리 집' where id = $1", [r.id]);
    await sql(a, "update ez_places set name = '우리 집' where id = $1", [r.id]);
    await sql(a, "update ez_places set version = 50 where id = $1", [r.id]);
    expect((await one(a, "select version from ez_places where id = $1", [r.id])).version).toBe(2);
    await fails(sql("service", "update ez_places set owner = $2 where id = $1", [r.id, user()]), "EZ_FIXED");
  });
});

describe("이동시간", () => {
  it("a < b, 1~600분", async () => {
    const a = user();
    const [x, y] = [await place(a, "집"), await place(a, "회사")].sort();
    await fails(ins(a, "ez_travel", { a: y, b: x, minutes: 10 }), "23514");
    await fails(ins(a, "ez_travel", { a: x, b: x, minutes: 10 }), "23514");
    await fails(ins(a, "ez_travel", { a: x, b: y, minutes: 0 }), "23514");
    await fails(ins(a, "ez_travel", { a: x, b: y, minutes: 601 }), "23514");
    await ins(a, "ez_travel", { a: x, b: y, minutes: 600 });
    await sql(a, "update ez_travel set minutes = 1 where a = $1", [x]);
    await fails(ins(a, "ez_travel", { a: x, b: y, minutes: 5 }), "23505");
  });

  it("남의 지점 · 없는 지점 · 지운 지점은 안 된다", async () => {
    const a = user();
    const b = user();
    const mine = await place(a, "집");
    const theirs = await place(b, "집");
    const [x, y] = [mine, theirs].sort();
    await fails(ins(a, "ez_travel", { a: x, b: y, minutes: 10 }), "23503");
    const [p, q] = [mine, randomUUID()].sort();
    await fails(ins(a, "ez_travel", { a: p, b: q, minutes: 10 }), "23503");
    const dead = await place(a, "옛집");
    await sql(a, "update ez_places set deleted_at = now() where id = $1", [dead]);
    const [m, n] = [mine, dead].sort();
    await fails(ins(a, "ez_travel", { a: m, b: n, minutes: 10 }), "EZ_PLACE");
  });

  it("지점을 지우면 그 지점이 낀 이동시간만 지워지고, 일정의 지점은 남는다(이름도 읽힘)", async () => {
    const a = user();
    const home = await place(a, "집", { role: "home" });
    const work = await place(a, "회사", { role: "work" });
    const cafe = await place(a, "카페");
    const pair = (p: string, q: string) => [p, q].sort();
    for (const [p, q] of [pair(home, work), pair(home, cafe), pair(work, cafe)]) await ins(a, "ez_travel", { a: p, b: q, minutes: 20 });
    const e = await event(a, { place_id: work });

    await sql(a, "update ez_places set deleted_at = now() where id = $1", [work]);
    const left = await sql(a, "select a, b from ez_travel");
    expect(left).toEqual([{ a: pair(home, cafe)[0], b: pair(home, cafe)[1] }]);
    expect((await ev(e)).place_id).toBe(work);
    expect((await one(a, "select p.name from ez_events e join ez_places p on p.id = e.place_id where e.id = $1", [e])).name).toBe("회사");
    // 지운 지점을 새 일정에 붙여도 된다(이름은 남는다)
    await event(a, { place_id: work, title: "지운 지점" });
  });
});

describe("일정 칸 검사", () => {
  it("제목 1~100자, 앞뒤 공백 없음", async () => {
    const a = user();
    await event(a, { title: "가".repeat(100) });
    for (const title of ["가".repeat(101), "", " 앞", "뒤 ", "\t탭"]) await fails(event(a, { title }), "EZ_VALUE");
  });

  it("시작 0~1439, 끝은 시작 초과 ~ 시작+1440. 종일은 둘 다 null", async () => {
    const a = user();
    await event(a, { start_min: null, end_min: null });
    await event(a, { start_min: 0, end_min: 1 });
    await event(a, { start_min: 1439, end_min: 2879 });
    await event(a, { start_min: 600, end_min: 2040 });
    for (const [s, e] of [
      [600, null],
      [null, 600],
      [-1, 10],
      [1440, 1500],
      [600, 600],
      [600, 599],
      [600, 2041],
    ])
      await fails(event(a, { start_min: s, end_min: e }), "EZ_VALUE");
  });

  it("이동시간 0~600, 메모 2000자, 상세 장소 100자", async () => {
    const a = user();
    await event(a, { travel_min: 0, note: "가".repeat(2000), where_text: "나".repeat(100) });
    await event(a, { travel_min: 600 });
    await fails(event(a, { travel_min: -1 }), "EZ_VALUE");
    await fails(event(a, { travel_min: 601 }), "EZ_VALUE");
    const e = await fails(event(a, { note: "가".repeat(2001) }), "EZ_VALUE");
    expect(e.message).toContain("2001자");
    await fails(event(a, { where_text: "나".repeat(101) }), "EZ_VALUE");
  });

  it("반복 모양: null | daily(until?) | weekly(days 1..7, until?)", async () => {
    const a = user();
    const ok = [
      { freq: "daily" },
      { freq: "daily", until: null },
      { freq: "daily", until: "2026-10-05" },
      { freq: "weekly", days: [1, 3, 5] },
      { freq: "weekly", days: [7], until: "2026-10-11" },
    ];
    for (const repeat of ok) await event(a, { repeat });
    const bad = [
      { freq: "monthly" },
      { days: [1] },
      { freq: "daily", days: [1] },
      { freq: "weekly" },
      { freq: "weekly", days: [] },
      { freq: "weekly", days: [0] },
      { freq: "weekly", days: [8] },
      { freq: "weekly", days: [1.5] },
      { freq: "weekly", days: ["1"] },
      { freq: "weekly", days: [1, 1] },
      { freq: "weekly", days: [1], every: 2 },
      { freq: "daily", until: "2026-10-04" }, // 시작보다 이름
      { freq: "daily", until: "2026/10/30" },
      { freq: "daily", until: "2026-02-30" },
      { freq: "daily", until: 20261030 },
      { freq: "weekly", days: [3], until: "2026-10-06" }, // 월 시작, 화까지 — 수요일이 한 번도 없음
      [1, 2],
      '"daily"', // JSON 문자열
    ];
    for (const repeat of bad) await fails(event(a, { repeat }), "EZ_VALUE");
    await fails(sql(a, "insert into ez_events (title, date, repeat) values ('x', '2026-10-05', 'null'::jsonb)"), "EZ_VALUE");
  });

  it("source · external_id, origin_kind · origin_id 는 둘 다 있거나 둘 다 없거나", async () => {
    const a = user();
    await fails(event(a, { external_id: "x" }), "23514");
    await event(a, { origin_kind: "project", origin_id: randomUUID() });
    await event(a, { origin_kind: "meet", origin_id: randomUUID() });
    await fails(event(a, { origin_kind: "project" }), "23514");
    await fails(event(a, { origin_id: randomUUID() }), "23514");
    await fails(event(a, { origin_kind: "club", origin_id: randomUUID() }), "23514");
  });

  it("지점은 같은 주인 것만", async () => {
    const a = user();
    await fails(event(a, { place_id: await place(user(), "남의 집") }), "23503");
    await fails(event(a, { place_id: randomUUID() }), "23503");
    const p = await place(a, "집");
    const e = await event(a, { place_id: p });
    expect((await ev(e)).place_id).toBe(p);
  });
});

describe("일정 version", () => {
  it("넣을 때 1, 바뀔 때마다 +1, 같은 값이면 그대로, 손으로 못 바꿈", async () => {
    const a = user();
    const r = await ins(a, "ez_events", { title: "v", date: "2026-10-05", version: 7 });
    expect(r.version).toBe(1);
    await sql(a, "update ez_events set title = 'v2' where id = $1", [r.id]);
    await sql(a, "update ez_events set start_min = 60, end_min = 120 where id = $1", [r.id]);
    expect((await ev(r.id)).version).toBe(3);
    await sql(a, "update ez_events set title = 'v2' where id = $1", [r.id]);
    await sql(a, "update ez_events set version = 99 where id = $1", [r.id]);
    expect((await ev(r.id)).version).toBe(3);
    await fails(sql("service", "update ez_events set owner = $2 where id = $1", [r.id, user()]), "EZ_FIXED");
  });

  it("낡은 version 으로 고치면 0행", async () => {
    const a = user();
    const id = await event(a);
    expect(await sql(a, "update ez_events set title = '먼저' where id = $1 and version = 1 returning version", [id])).toEqual([{ version: 2 }]);
    expect(await sql(a, "update ez_events set title = '나중' where id = $1 and version = 1 returning version", [id])).toHaveLength(0);
    expect((await ev(id)).title).toBe("먼저");
  });
});

describe("바깥 일정 보호", () => {
  it("source 있는 일정을 직접 넣을 수 없다 (사용자 · service_role 모두)", async () => {
    const a = user();
    const e = await fails(event(a, { source: "studycube", external_id: "x" }), "EZ_EXTERNAL");
    expect(e.message).toContain("studycube");
    await fails(ins("service", "ez_events", { owner: a, title: "x", date: "2026-10-05", source: "univ", external_id: "1" }), "EZ_EXTERNAL");
  });

  it("sync 로 들어온 일정은 고치기 · 지우기 · 되돌리기 모두 거절", async () => {
    const a = user();
    const id = await external(a);
    await fails(sql(a, "update ez_events set title = '내 맘대로' where id = $1", [id]), "EZ_EXTERNAL");
    await fails(sql(a, "update ez_events set deleted_at = now() where id = $1", [id]), "EZ_EXTERNAL");
    await fails(sql(a, "update ez_events set source = null, external_id = null where id = $1", [id]), "EZ_EXTERNAL");
    await fails(sql("service", "update ez_events set note = 'x' where id = $1", [id]), "EZ_EXTERNAL");
    await fails(sql("service", "delete from ez_events where id = $1", [id]), "EZ_EXTERNAL");
    await fails(sql("admin", "delete from ez_events where id = $1", [id]), "EZ_EXTERNAL");
    const now = await ev(id);
    expect([now.title, now.deleted_at, now.version]).toEqual(["근무 x1", null, 1]);
  });

  it("내 일정을 바깥 일정으로 바꿀 수 없다", async () => {
    const a = user();
    const id = await event(a);
    await fails(sql(a, "update ez_events set source = 'studycube', external_id = 'x' where id = $1", [id]), "EZ_EXTERNAL");
  });

  it("바깥 일정의 회차 예외도 거절, split · cut 도 거절", async () => {
    const a = user();
    await sync(a, "univ", "2026-10-01", "2026-10-31", [ext("w", "2026-10-05", { repeat: { freq: "weekly", days: [1] } })]);
    const id = (await one(a, "select id from ez_events where source = 'univ'")).id;
    await fails(addEx(a, id, "2026-10-12"), "EZ_EXTERNAL");
    await fails(addEx("service", id, "2026-10-12", { title: "x" }), "EZ_EXTERNAL");
    await fails(split(a, id, 1, "2026-10-12", { title: "x" }), "EZ_EXTERNAL");
    await fails(cut(a, id, 1, "2026-10-12"), "EZ_EXTERNAL");
  });

  it("sync 가 끝나면 같은 연결에서도 보호가 다시 켜진다", async () => {
    const a = user();
    const id = await external(a);
    await db.exec("begin");
    try {
      await db.query("select ez_schedule_sync('other', '2026-10-01', '2026-10-02', '[]', null, $1)", [a]);
      const e = await db.query("update ez_events set title = '몰래' where id = $1", [id]).then(
        () => null,
        (err) => err,
      );
      expect(e?.message).toMatch(/^\[EZ_EXTERNAL\]/);
    } finally {
      await db.exec("rollback");
    }
  });
});

describe("ez_schedule_sync", () => {
  it("처음: 넣고 {inserted, updated, deleted}, 출처 이름 · 맞춘 시각", async () => {
    const a = user();
    const r = await sync(a, "studycube", "2026-10-01", "2026-10-31", [ext("1", "2026-10-05"), ext("2", "2026-10-06", { start_min: null, end_min: null })], "스터디큐브");
    expect(r).toEqual({ inserted: 2, updated: 0, deleted: 0 });
    const rows = await sql(a, "select title, date::text as date, start_min, source, external_id, version from ez_events order by external_id");
    expect(rows).toEqual([
      { title: "근무 1", date: "2026-10-05", start_min: 600, source: "studycube", external_id: "1", version: 1 },
      { title: "근무 2", date: "2026-10-06", start_min: null, source: "studycube", external_id: "2", version: 1 },
    ]);
    const s = await one(a, "select label, synced_at from ez_sources where source = 'studycube'");
    expect(s.label).toBe("스터디큐브");
    expect(s.synced_at).not.toBeNull();
  });

  it("갈아끼우기: 같은 id 는 고치고, 빠진 것은 지우고, 새 것은 넣고, 기간 밖 · 다른 출처는 그대로", async () => {
    const a = user();
    await sync(a, "studycube", "2026-09-01", "2026-10-31", [
      ext("old", "2026-09-10"), // 다음 기간 밖
      ext("keep", "2026-10-05"),
      ext("change", "2026-10-06"),
      ext("gone", "2026-10-07"),
      ext("late", "2026-10-30"), // 다음 기간 밖 (뒤)
    ]);
    await sync(a, "univ", "2026-10-01", "2026-10-31", [ext("u", "2026-10-07")]);
    const mine = await event(a, { date: "2026-10-07" });
    const before = await one(a, "select synced_at from ez_sources where source = 'studycube'");

    const r = await sync(a, "studycube", "2026-10-01", "2026-10-15", [
      ext("keep", "2026-10-05"),
      ext("change", "2026-10-06", { title: "바뀐 근무", end_min: 960 }),
      ext("new", "2026-10-08"),
    ]);
    expect(r).toEqual({ inserted: 1, updated: 1, deleted: 1 });

    const alive = await sql(a, "select external_id, title, end_min, version from ez_events where source = 'studycube' and deleted_at is null order by external_id");
    expect(alive).toEqual([
      { external_id: "change", title: "바뀐 근무", end_min: 960, version: 2 },
      { external_id: "keep", title: "근무 keep", end_min: 900, version: 1 },
      { external_id: "late", title: "근무 late", end_min: 900, version: 1 },
      { external_id: "new", title: "근무 new", end_min: 900, version: 1 },
      { external_id: "old", title: "근무 old", end_min: 900, version: 1 },
    ]);
    expect((await one(a, "select deleted_at from ez_events where external_id = 'gone'")).deleted_at).not.toBeNull();
    expect(await sql(a, "select id from ez_events where source = 'univ' and deleted_at is null")).toHaveLength(1);
    expect((await ev(mine)).deleted_at).toBeNull();
    const after = await one(a, "select label, synced_at from ez_sources where source = 'studycube'");
    expect(after.synced_at.getTime()).toBeGreaterThanOrEqual(before.synced_at.getTime());
  });

  it("기간 밖에 있던 같은 external_id 는 옮겨 온다. 지운 뒤 다시 오면 새로 넣는다. label 은 안 주면 그대로", async () => {
    const a = user();
    await sync(a, "s", "2026-09-01", "2026-09-30", [ext("m", "2026-09-20")], "처음 이름");
    const r1 = await sync(a, "s", "2026-10-01", "2026-10-31", [ext("m", "2026-10-03")]);
    expect(r1).toEqual({ inserted: 0, updated: 1, deleted: 0 });
    expect(await sql(a, "select date::text as date from ez_events where deleted_at is null")).toEqual([{ date: "2026-10-03" }]);

    expect(await sync(a, "s", "2026-10-01", "2026-10-31", [])).toEqual({ inserted: 0, updated: 0, deleted: 1 });
    expect(await sync(a, "s", "2026-10-01", "2026-10-31", [ext("m", "2026-10-03")])).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(await sql(a, "select id from ez_events where external_id = 'm'")).toHaveLength(2);
    expect((await one(a, "select label from ez_sources where source = 's'")).label).toBe("처음 이름");
  });

  it("한 건이라도 잘못되면 아무것도 안 바뀐다 — 위치와 이유", async () => {
    const a = user();
    await sync(a, "studycube", "2026-10-01", "2026-10-31", [ext("1", "2026-10-05")], "스큐");
    const snap = async () => [await sql(a, "select * from ez_events order by external_id"), await sql(a, "select * from ez_sources")];
    const before = await snap();

    const e = await fails(
      sync(a, "studycube", "2026-10-01", "2026-10-31", [
        ext("1", "2026-10-05", { title: "고침" }),
        ext("2", "2026-10-06", { end_min: 500 }),
        ext("3", "2026-11-02"),
        ext("4", "2026-10-07", { colour: "red" }),
        ext("1", "2026-10-08"),
        { title: "id 없음", date: "2026-10-09" },
        ext("7", "2026-10-09", { start_min: 600, end_min: undefined }),
      ]),
      "EZ_SYNC",
    );
    expect(e.message).toContain("6건");
    expect(e.message).toContain("events[1]: 끝은 시작보다");
    expect(e.message).toContain("events[2]: 날짜 2026-11-02");
    expect(e.message).toContain("events[3]: 쓸 수 없는 칸입니다: colour");
    expect(e.message).toContain("events[4]: external_id 1 가 목록에 두 번");
    expect(e.message).toContain("events[5]: external_id");
    expect(e.message).toContain("events[6]: start_min 과 end_min");
    expect(JSON.parse(e.detail).map((x: Row) => x.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await snap()).toEqual(before);

    await fails(sync(a, "studycube", "2026-10-01", "2026-10-31", [ext("9", "2026-10-05", { place_id: await place(user(), "남의 곳") })]), "EZ_SYNC");
    await fails(sync(a, "studycube", "2026-10-01", "2026-10-31", ["문자열"]), "EZ_SYNC");
    expect(await snap()).toEqual(before);
  });

  it("상한: 500개 · 200일. 출처 · 기간 · 모양 검사", async () => {
    const a = user();
    const many = (n: number) => Array.from({ length: n }, (_, i) => ext(`k${i}`, "2026-10-05"));
    expect((await sync(a, "big", "2026-10-01", "2026-10-31", many(500))).inserted).toBe(500);
    const e = await fails(sync(a, "big", "2026-10-01", "2026-10-31", many(501)), "EZ_LIMIT");
    expect(e.message).toContain("501개");
    await sync(a, "big", "2026-01-01", "2026-07-19", []); // 200일
    expect((await fails(sync(a, "big", "2026-01-01", "2026-07-20", []), "EZ_RANGE")).message).toContain("201일");
    await fails(sync(a, "big", "2026-10-02", "2026-10-01", []), "EZ_RANGE");
    await fails(sync(a, "Big Name", "2026-10-01", "2026-10-02", []), "EZ_VALUE");
    await fails(one(a, "select ez_schedule_sync('big', '2026-10-01', '2026-10-02', '{}')"), "EZ_VALUE");
    await fails(sync(a, "big", "2026-10-01", "2026-10-02", [], "가".repeat(31)), "EZ_VALUE");
  });

  it("service_role 은 p_as 로 대리. p_as 가 없으면 거절. 다른 사람의 같은 출처는 그대로", async () => {
    const a = user();
    const b = user();
    await sync(b, "studycube", "2026-10-01", "2026-10-31", [ext("b1", "2026-10-05")]);
    await fails(sync("service", "studycube", "2026-10-01", "2026-10-31", []), "EZ_AUTH");
    expect(await sync("service", "studycube", "2026-10-01", "2026-10-31", [ext("a1", "2026-10-05")], null, a)).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    // authenticated 의 p_as 는 무시 — 자기 것으로
    expect(await sync(b, "studycube", "2026-10-01", "2026-10-31", [], null, a)).toEqual({ inserted: 0, updated: 0, deleted: 1 });
    expect(await sql(a, "select external_id from ez_events where deleted_at is null")).toEqual([{ external_id: "a1" }]);
    expect((await one(a, "select owner from ez_events")).owner).toBe(a);
  });

  it("지점 · 반복 · 메모를 실어 올 수 있고, 빠진 칸은 비운다", async () => {
    const a = user();
    const p = await place(a, "스터디큐브");
    await sync(a, "univ", "2026-09-01", "2026-12-31", [
      ext("c", "2026-09-01", { place_id: p, note: "302호", repeat: { freq: "weekly", days: [2, 4], until: "2026-12-15" } }),
    ]);
    const r = await one(a, `select ${EV_COLS} from ez_events`);
    expect([r.place_id, r.note, r.repeat]).toEqual([p, "302호", { freq: "weekly", days: [2, 4], until: "2026-12-15" }]);
    expect(await sync(a, "univ", "2026-09-01", "2026-12-31", [ext("c", "2026-09-01")])).toEqual({ inserted: 0, updated: 1, deleted: 0 });
    const r2 = await one(a, `select ${EV_COLS} from ez_events`);
    expect([r2.place_id, r2.note, r2.repeat, r2.version]).toEqual([null, null, null, 2]);
  });
});

describe("ez_occurs_on", () => {
  it("반복 아님 · 매일 · 매주 · until(그날 포함)", async () => {
    const q = async (repeat: unknown, start: string, d: string) =>
      (await one("admin", "select ez_occurs_on($1, $2, $3) v", [val(repeat), start, d])).v;
    expect(await q(null, "2026-10-05", "2026-10-05")).toBe(true);
    expect(await q(null, "2026-10-05", "2026-10-06")).toBe(false);
    expect(await q({ freq: "daily" }, "2026-10-05", "2026-10-04")).toBe(false);
    expect(await q({ freq: "daily" }, "2026-10-05", "2027-10-05")).toBe(true);
    expect(await q({ freq: "daily", until: "2026-10-07" }, "2026-10-05", "2026-10-07")).toBe(true);
    expect(await q({ freq: "daily", until: "2026-10-07" }, "2026-10-05", "2026-10-08")).toBe(false);
    const wk = { freq: "weekly", days: [1, 7] }; // 월 · 일
    expect(await q(wk, "2026-10-05", "2026-10-11")).toBe(true);
    expect(await q(wk, "2026-10-05", "2026-10-12")).toBe(true);
    expect(await q(wk, "2026-10-05", "2026-10-06")).toBe(false);
    expect(await q(wk, "2026-10-05", "2026-10-04")).toBe(false); // 시작 전 일요일
  });
});

describe("회차 예외", () => {
  it("반복일만, 반복 아닌 일정은 거절, 지운 일정은 거절", async () => {
    const a = user();
    const wk = await event(a, { repeat: { freq: "weekly", days: [1, 3], until: "2026-10-21" } });
    await addEx(a, wk, "2026-10-05");
    await addEx(a, wk, "2026-10-07", { title: "이번만" });
    await addEx(a, wk, "2026-10-21");
    for (const d of ["2026-10-06", "2026-10-04", "2026-10-26", "2026-10-28"])
      expect((await fails(addEx(a, wk, d), "EZ_DATE")).message).toContain(d);
    const single = await event(a);
    await fails(addEx(a, single, "2026-10-05"), "EZ_REPEAT");
    const dead = await event(a, { repeat: { freq: "daily" } });
    await sql(a, "update ez_events set deleted_at = now() where id = $1", [dead]);
    await fails(addEx(a, dead, "2026-10-06"), "EZ_NOT_FOUND");
    await fails(sql(a, "update ez_event_exceptions set on_date = '2026-10-06' where event_id = $1 and on_date = '2026-10-05'", [wk]), "EZ_DATE");
  });

  it("patch 는 정해진 키만, 값 모양 · 범위 검사. 건너뛰기면 patch 없음", async () => {
    const a = user();
    const p = await place(a, "회사");
    const id = await event(a, { repeat: { freq: "daily" } });
    let d = 5;
    const next = () => `2026-10-${String(d++).padStart(2, "0")}`;
    await addEx(a, id, next(), { date: "2026-10-20", start_min: 0, end_min: 1440, title: "옮김", place_id: p, where_text: null, travel_min: 600, note: "메모" });
    await addEx(a, id, next(), { start_min: null, end_min: null }); // 이번만 종일
    for (const patch of [{ repeat: null }, { source: "x" }, { version: 3 }, { task_id: null }])
      expect((await fails(addEx(a, id, next(), patch), "EZ_PATCH")).message).toContain("쓸 수 없는 칸");
    for (const patch of [{}, [1], '"x"', { start_min: 600 }, { date: "2026-13-01" }, { start_min: "600", end_min: 700 }, { place_id: "집" }, { title: 3 }])
      await fails(addEx(a, id, next(), patch), "EZ_PATCH");
    await fails(addEx(a, id, next(), null, false), "EZ_PATCH");
    await fails(addEx(a, id, next(), { title: "x" }, true), "23514");
    for (const patch of [{ title: "" }, { start_min: 600, end_min: 600 }, { travel_min: 601 }, { note: "가".repeat(2001) }])
      await fails(addEx(a, id, next(), patch), "EZ_VALUE");
    await fails(addEx(a, id, next(), { place_id: await place(user(), "남의 곳") }), "EZ_PLACE");
  });

  it("반복 규칙 · 시작 날짜가 바뀌면 더는 회차가 아닌 예외는 지워진다", async () => {
    const a = user();
    const id = await event(a, { repeat: { freq: "daily" } });
    for (const d of ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-12"]) await addEx(a, id, d);
    await sql(a, "update ez_events set repeat = '{\"freq\":\"weekly\",\"days\":[1,3]}' where id = $1", [id]);
    expect(await exs(id)).toEqual(["2026-10-05", "2026-10-07", "2026-10-12"]);
    await sql(a, "update ez_events set date = '2026-10-06' where id = $1", [id]);
    expect(await exs(id)).toEqual(["2026-10-07", "2026-10-12"]);
    await sql(a, "update ez_events set title = '이름만' where id = $1", [id]);
    expect(await exs(id)).toEqual(["2026-10-07", "2026-10-12"]);
    await sql(a, "update ez_events set repeat = null where id = $1", [id]);
    expect(await exs(id)).toEqual([]);
  });

  it("일정 행이 정말 지워지면 예외도 같이 (on delete cascade)", async () => {
    const a = user();
    const id = await event(a, { repeat: { freq: "daily" } });
    await addEx(a, id, "2026-10-06");
    await sql("service", "delete from ez_events where id = $1", [id]);
    expect(await exs(id)).toEqual([]);
  });
});

describe("ez_event_split (이후 모두)", () => {
  async function series(a: string) {
    const id = await event(a, { title: "수업", start_min: 540, end_min: 630, repeat: { freq: "weekly", days: [1, 3], until: "2026-11-30" } });
    await addEx(a, id, "2026-10-05", { title: "첫 주" });
    await addEx(a, id, "2026-10-12");
    await addEx(a, id, "2026-10-14", { start_min: 600, end_min: 690 });
    await addEx(a, id, "2026-10-19", { note: "그 뒤" });
    return id;
  }

  it("중간 회차: 원래는 전날까지, 새 일정은 그날부터 patch 를 얹고, 그날 이후 예외는 새 일정으로", async () => {
    const a = user();
    const id = await series(a);
    const n = await split(a, id, 1, "2026-10-12", { title: "수업(변경)", start_min: 600, end_min: 690 });
    expect(n.id).not.toBe(id);
    expect([n.title, n.date, n.start_min, n.end_min, n.version]).toEqual(["수업(변경)", "2026-10-12", 600, 690, 1]);
    expect(n.repeat).toEqual({ freq: "weekly", days: [1, 3], until: "2026-11-30" });
    const o = await ev(id);
    expect(o.repeat).toEqual({ freq: "weekly", days: [1, 3], until: "2026-10-11" });
    expect([o.title, o.version]).toEqual(["수업", 2]);
    expect(await exs(id)).toEqual(["2026-10-05"]);
    expect(await exs(n.id)).toEqual(["2026-10-12", "2026-10-14", "2026-10-19"]);
  });

  it("patch.repeat 가 있으면 새 반복을 쓰고, 새 반복의 회차가 아닌 예외는 지운다. date 를 주면 그날부터", async () => {
    const a = user();
    const id = await series(a);
    const n = await split(a, id, 1, "2026-10-12", { repeat: { freq: "weekly", days: [1] } });
    expect(n.repeat).toEqual({ freq: "weekly", days: [1] });
    expect(await exs(n.id)).toEqual(["2026-10-12", "2026-10-19"]);
    expect(await exs(id)).toEqual(["2026-10-05"]);

    const b = user();
    const id2 = await series(b);
    const m = await split(b, id2, 1, "2026-10-14", { date: "2026-10-15", repeat: { freq: "weekly", days: [4] } });
    expect([m.date, m.repeat]).toEqual(["2026-10-15", { freq: "weekly", days: [4] }]);
    expect(await exs(m.id)).toEqual([]);
    expect((await ev(id2)).repeat.until).toBe("2026-10-13");
  });

  it("첫 회차면 나누지 않고 원래 일정을 고친다", async () => {
    const a = user();
    const id = await series(a);
    const r = await split(a, id, 1, "2026-10-05", { title: "처음부터 바꿈" });
    expect([r.id, r.title, r.version, r.repeat.until]).toEqual([id, "처음부터 바꿈", 2, "2026-11-30"]);
    expect(await sql(a, "select id from ez_events")).toHaveLength(1);
    expect(await exs(id)).toEqual(["2026-10-05", "2026-10-12", "2026-10-14", "2026-10-19"]);

    // 시작일 요일이 days 에 없으면 첫 회차는 그 뒤 첫 반복일
    const w = await event(a, { date: "2026-10-04", repeat: { freq: "weekly", days: [3] } }); // 일요일 시작, 수요일 반복
    expect((await split(a, w, 1, "2026-10-07", { note: "첫 회차" })).id).toBe(w);
    // 반복 아닌 일정은 그날이 곧 첫 회차
    const s = await event(a);
    expect((await split(a, s, 1, "2026-10-05", { title: "한 번" })).id).toBe(s);
  });

  it("낡은 버전 · 회차 아닌 날 · 잘못된 patch 는 거절하고 아무것도 안 바꾼다", async () => {
    const a = user();
    const id = await series(a);
    await sql(a, "update ez_events set note = '다른 곳에서' where id = $1", [id]);
    const e = await fails(split(a, id, 1, "2026-10-12", { title: "x" }), "EZ_VERSION");
    expect(e.message).toContain("지금 버전 2");
    await fails(split(a, id, 2, "2026-10-13", { title: "x" }), "EZ_DATE");
    await fails(split(a, id, 2, "2026-12-07", { title: "x" }), "EZ_DATE");
    await fails(split(a, id, 2, "2026-10-12", { task_id: null }), "EZ_PATCH");
    await fails(split(a, id, 2, "2026-10-12", { start_min: 700 }), "EZ_PATCH");
    await fails(split(a, id, 2, "2026-10-12", { title: "" }), "EZ_VALUE");
    await fails(split(a, id, 2, "2026-10-12", { date: "2026-12-01" }), "EZ_VALUE"); // until(11-30)보다 늦은 시작
    expect(await sql(a, "select id from ez_events")).toHaveLength(1);
    expect((await ev(id)).version).toBe(2);
    expect(await exs(id)).toHaveLength(4);
    const dead = await event(a, { repeat: { freq: "daily" } });
    await sql(a, "update ez_events set deleted_at = now() where id = $1", [dead]);
    await fails(split(a, dead, 2, "2026-10-06", {}), "EZ_NOT_FOUND");
  });

  it("할 일 연결은 원래 일정에 남는다. service_role 은 p_as 로", async () => {
    const a = user();
    const t = await task(a);
    const id = await event(a, { task_id: t, repeat: { freq: "daily" } });
    await fails(split("service", id, 1, "2026-10-08", {}), "EZ_NOT_FOUND");
    const n = await split("service", id, 1, "2026-10-08", { title: "대리" }, a);
    expect([n.task_id, n.title]).toEqual([null, "대리"]);
    expect((await ev(id)).task_id).toBe(t);
  });
});

describe("ez_event_cut (이후 모두 지우기)", () => {
  it("중간 회차: 전날까지로 끊고 그날 이후 예외를 지운다", async () => {
    const a = user();
    const id = await event(a, { repeat: { freq: "daily", until: "2026-10-31" } });
    for (const d of ["2026-10-06", "2026-10-09", "2026-10-10"]) await addEx(a, id, d);
    const r = await cut(a, id, 1, "2026-10-09");
    expect([r.id, r.version, r.deleted_at, r.repeat]).toEqual([id, 2, null, { freq: "daily", until: "2026-10-08" }]);
    expect(await exs(id)).toEqual(["2026-10-06"]);
  });

  it("첫 회차면 일정을 지운다(soft). 낡은 버전 · 회차 아님 거절", async () => {
    const a = user();
    const id = await event(a, { repeat: { freq: "weekly", days: [1] } });
    await addEx(a, id, "2026-10-12");
    await fails(cut(a, id, 0, "2026-10-12"), "EZ_VERSION");
    await fails(cut(a, id, 1, "2026-10-13"), "EZ_DATE");
    const r = await cut(a, id, 1, "2026-10-05");
    expect(r.deleted_at).not.toBeNull();
    expect(await exs(id)).toEqual(["2026-10-12"]); // 되돌리기용으로 남김
    const single = await event(a);
    expect((await cut(a, single, 1, "2026-10-05")).deleted_at).not.toBeNull();
  });
});

describe("할 일 ↔ 일정", () => {
  it("살아 있는 일정 중 할 일 하나에 하나. 지운 일정은 빠진다", async () => {
    const a = user();
    const t = await task(a);
    const e1 = await event(a, { task_id: t });
    await fails(event(a, { task_id: t }), "23505");
    await sql(a, "update ez_events set deleted_at = now() where id = $1", [e1]);
    const e2 = await event(a, { task_id: t });
    await fails(sql(a, "update ez_events set deleted_at = null where id = $1", [e1]), "23505");
    expect((await ev(e2)).task_id).toBe(t);
  });

  it("남의 할 일 · 없는 할 일 · 지운 할 일에는 못 잇는다", async () => {
    const a = user();
    await fails(event(a, { task_id: await task(user()) }), "23503");
    await fails(event(a, { task_id: randomUUID() }), "23503");
    const t = await task(a);
    await sql(a, "update ez_tasks set deleted_at = now() where id = $1", [t]);
    await fails(event(a, { task_id: t }), "EZ_TASK");
  });

  it("할 일을 지워도(끝내도) 일정은 남는다. 행이 정말 지워지면 연결만 끊긴다", async () => {
    const a = user();
    const t = await task(a);
    const e = await event(a, { task_id: t });
    await sql(a, "update ez_tasks set done_at = now() where id = $1", [t]);
    await sql(a, "update ez_tasks set deleted_at = now() where id = $1", [t]);
    const now = await ev(e);
    expect([now.deleted_at, now.task_id]).toEqual([null, t]);
    await sql(a, "update ez_events set title = '고쳐도 됨' where id = $1", [e]); // 연결이 그대로여도 다른 칸은 고친다
    await sql("service", "delete from ez_tasks where id = $1", [t]);
    const gone = await ev(e);
    expect([gone.deleted_at, gone.task_id]).toEqual([null, null]);
  });
});

describe("ez_tasks", () => {
  it("제목 1~200자 trim, 메모 2000자, 걸릴 시간 5~600, 순서는 유한한 수", async () => {
    const a = user();
    await task(a, { title: "가".repeat(200), note: "나".repeat(2000), est_min: 5, due: "2026-10-10" });
    await task(a, { est_min: 600, sort: -1.5 });
    for (const extra of [
      { title: "가".repeat(201) },
      { title: "" },
      { title: " 앞" },
      { note: "나".repeat(2001) },
      { est_min: 4 },
      { est_min: 601 },
      { sort: "NaN" },
      { sort: "Infinity" },
    ])
      await fails(task(a, extra), "23514");
  });

  it("origin 은 둘 다 있거나 둘 다 없거나, project | meet", async () => {
    const a = user();
    await task(a, { origin_kind: "project", origin_id: randomUUID() });
    await fails(task(a, { origin_kind: "meet" }), "23514");
    await fails(task(a, { origin_id: randomUUID() }), "23514");
    await fails(task(a, { origin_kind: "club", origin_id: randomUUID() }), "23514");
  });

  it("version: 넣을 때 1, 바뀔 때마다 +1, 낡은 버전으로 고치면 0행", async () => {
    const a = user();
    const r = await ins(a, "ez_tasks", { title: "v", version: 5 });
    expect(r.version).toBe(1);
    await sql(a, "update ez_tasks set done_at = now() where id = $1", [r.id]);
    await sql(a, "update ez_tasks set sort = 3 where id = $1", [r.id]);
    await sql(a, "update ez_tasks set sort = 3 where id = $1", [r.id]);
    expect((await one(a, "select version from ez_tasks where id = $1", [r.id])).version).toBe(3);
    expect(await sql(a, "update ez_tasks set title = '낡음' where id = $1 and version = 1 returning id", [r.id])).toHaveLength(0);
    await fails(sql(a, "update ez_tasks set id = gen_random_uuid() where id = $1", [r.id]), "EZ_FIXED");
  });
});

describe("설정 · 출처", () => {
  it("기본값은 lib DEFAULT_SETTINGS 와 같다", async () => {
    const a = user();
    const r = await ins(a, "ez_schedule_settings", {});
    const { owner, updated_at, ...rest } = r;
    expect(owner).toBe(a);
    expect(rest).toEqual(DEFAULT_SETTINGS);
    await fails(ins(a, "ez_schedule_settings", {}), "23505");
  });

  it("범위 · 식사 창 모양", async () => {
    const a = user();
    await ins(a, "ez_schedule_settings", { prep_first: 120, prep_again: 0, home_stay: 600, meal_min: 0, lunch: { from: 0, to: 1440, prefer: 0 } });
    const set = (col: string, v: unknown) => sql(a, `update ez_schedule_settings set ${col} = $1`, [val(v)]);
    for (const [col, v] of [
      ["prep_first", 121],
      ["prep_again", -1],
      ["home_stay", 601],
      ["meal_min", 121],
      ["lunch", { from: 700, to: 700, prefer: 700 }],
      ["lunch", { from: 600, to: 1441, prefer: 700 }],
      ["lunch", { from: 600, to: 800, prefer: 900 }],
      ["dinner", { from: 600, to: 800 }],
      ["dinner", { from: 600, to: 800, prefer: 700, x: 1 }],
      ["dinner", { from: "600", to: 800, prefer: 700 }],
      ["dinner", [600, 800, 700]],
      ["tz", "서울"],
    ] as const)
      await fails(set(col, v), "23514");
    await set("tz", "America/New_York");
  });

  it("출처 이름 1~30자, 출처는 영문 소문자 꼴", async () => {
    const a = user();
    await ins(a, "ez_sources", { source: "apptive", label: "APPTIVE" });
    await fails(ins(a, "ez_sources", { source: "APPTIVE" }), "23514");
    await fails(ins(a, "ez_sources", { source: "x", label: "" }), "23514");
    await fails(ins(a, "ez_sources", { source: "y", label: "가".repeat(31) }), "23514");
  });
});
