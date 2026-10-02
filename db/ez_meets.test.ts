// 0011 (모임: ez_circles · ez_meets · ez_meet_people, 시간 ↔ 일정, ez_meet_decide · ez_meet_reopen)을 PGlite 에서 돌려 본다.
// Supabase 흉내는 db/testing.ts. 날짜: 2026-10-05 가 월요일.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { CIRCLE_NAME_MAX, CIRCLES_MAX, DEFAULT_MY_NAME, MEET_TITLE_MAX, MEMBERS_MAX, PEOPLE_MAX, PERSON_NAME_MAX, PLACE_TEXT_MAX } from "../lib/meet";
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
const val = (v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);

/** authenticated 는 열 권한이 있어 returning 을 고른다 */
async function ins(who: string, table: string, obj: Record<string, unknown>, returning = "id"): Promise<Row> {
  const keys = Object.keys(obj);
  return one(
    who,
    `insert into ${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning ${returning}`,
    keys.map((k) => val(obj[k])),
  );
}

const circle = async (who: string, name: string, extra: Record<string, unknown> = {}) => (await ins(who, "ez_circles", { name, ...extra })).id as string;
const meet = async (who: string, extra: Record<string, unknown> = {}) => (await ins(who, "ez_meets", { title: "회의", ...extra })).id as string;
const person = async (who: string, meetId: string, name: string, extra: Record<string, unknown> = {}) =>
  (await ins(who, "ez_meet_people", { meet_id: meetId, name, ...extra })).id as string;
const place = async (who: string, name: string) => (await ins(who, "ez_places", { name })).id as string;
const role = async (who: string, name: string) => (await ins(who, "ez_roles", { name })).id as string;

const AT = { meet_date: "2026-10-05", start_min: 1140, end_min: 1260 };
const mt = (id: string) => one("admin", "select *, meet_date::text as meet_date from ez_meets where id = $1", [id]);
const ev = (id: string) => one("admin", "select *, date::text as date from ez_events where id = $1", [id]);
const people = (meetId: string) => sql("admin", "select * from ez_meet_people where meet_id = $1 order by is_owner desc, created_at, id", [meetId]);
/** 그 모임에서 온 살아 있는 일정 */
const liveEvents = (meetId: string) =>
  sql("admin", "select *, date::text as date from ez_events where origin_kind = 'meet' and origin_id = $1 and deleted_at is null", [meetId]);
const softDelete = (who: string, table: string, id: string) => sql(who, `update ${table} set deleted_at = now() where id = $1`, [id]);
const decide = (who: string, id: string, base: number, date: string, s: number, e: number, as: string | null = null) =>
  one(who, "select *, meet_date::text as meet_date from ez_meet_decide($1, $2, $3, $4, $5, $6)", [id, base, date, s, e, as]);
const reopen = (who: string, id: string, base: number, as: string | null = null) => one(who, "select * from ez_meet_reopen($1, $2, $3)", [id, base, as]);

// ---------------------------------------------------------------------------

describe("권한 · RLS", () => {
  it("anon 은 세 표를 읽기 · 쓰기 못 하고 함수도 못 부른다", async () => {
    for (const t of ["ez_circles", "ez_meets", "ez_meet_people"]) await fails(sql("anon", `select id from ${t}`), "42501");
    await fails(sql("anon", "insert into ez_meets (owner, title) values ($1, 'x')", [user()]), "42501");
    await fails(sql("anon", "select ez_meet_decide($1, 1, '2026-10-05', 600, 660)", [randomUUID()]), "42501");
    await fails(sql("anon", "select ez_meet_reopen($1, 1)", [randomUUID()]), "42501");
    await fails(sql("anon", "select ez_poll_ok('{}'::jsonb)"), "42501");
  });

  it("남의 묶음 · 모임 · 사람은 안 보이고 못 고친다. 남의 주인으로 못 넣는다", async () => {
    const a = user();
    const b = user();
    const c = await circle(a, "스터디");
    const m = await meet(a);
    const p = await person(a, m, "민서");
    expect(await sql(b, "select id from ez_circles")).toHaveLength(0);
    expect(await sql(b, "select id from ez_meets")).toHaveLength(0);
    expect(await sql(b, "select id from ez_meet_people")).toHaveLength(0);
    expect(await sql(a, "select id from ez_meet_people")).toHaveLength(2);
    expect(await sql(b, "update ez_circles set name = '뺏음' where id = $1 returning id", [c])).toHaveLength(0);
    expect(await sql(b, "update ez_meets set title = '뺏음' where id = $1 returning id", [m])).toHaveLength(0);
    expect(await sql(b, "update ez_meet_people set name = '뺏음' where id = $1 returning id", [p])).toHaveLength(0);
    expect(await sql(b, "delete from ez_meet_people where id = $1 returning id", [p])).toHaveLength(0);
    await fails(sql(b, "insert into ez_meets (owner, title) values ($1, '침범')", [a]), "42501");
    await fails(sql(b, "insert into ez_circles (owner, name) values ($1, '침범')", [a]), "42501");
    await fails(person(b, m, "침범"), "42501");
    // 남의 묶음 · 지점은 못 건다 (같은 주인 외래키)
    await fails(meet(b, { circle_id: c }), "23503");
    await fails(meet(b, { place_id: await place(a, "카페") }), "23503");
    await fails(decide(b, m, 1, "2026-10-05", 600, 660), "EZ_NOT_FOUND");
    await fails(reopen(b, m, 1), "EZ_NOT_FOUND");
    expect((await mt(m)).title).toBe("회의");
  });

  it("묶음 · 모임은 행을 지울 수 없다 (지우기 = deleted_at). service_role 은 owner 를 적어 쓴다", async () => {
    const a = user();
    const c = await circle(a, "스터디");
    const m = await meet(a);
    await fails(sql(a, "delete from ez_circles where id = $1", [c]), "42501");
    await fails(sql(a, "delete from ez_meets where id = $1", [m]), "42501");
    await softDelete(a, "ez_meets", m);
    expect((await mt(m)).deleted_at).not.toBeNull();
    await fails(sql("service", "insert into ez_meets (title) values ('x')"), "23502");
    expect((await ins("service", "ez_meets", { owner: a, title: "대리" }, "owner")).owner).toBe(a);
  });

  it("주인도 일정 연결 · 공개 열쇠 · 핀 칸 · 내 줄 여부는 직접 못 쓴다. 핀 칸은 읽지도 못한다", async () => {
    const a = user();
    const m = await meet(a);
    await fails(sql(a, "update ez_meets set event_id = $2 where id = $1", [m, randomUUID()]), "42501");
    await fails(sql(a, "update ez_meets set token = 'aaaaaaaaaaaaaaaaaaaaaa' where id = $1", [m]), "42501");
    await fails(sql(a, "insert into ez_meets (title, token) values ('x', 'aaaaaaaaaaaaaaaaaaaaaa')"), "42501");
    await fails(sql(a, "insert into ez_meet_people (meet_id, name, is_owner) values ($1, '둘째 나', true)", [m]), "42501");
    await fails(sql(a, "insert into ez_meet_people (meet_id, name, pin_hash, pin_salt) values ($1, '핀', 'h', 's')", [m]), "42501");
    await fails(sql(a, "update ez_meet_people set pin_hash = 'h', pin_salt = 's' where meet_id = $1", [m]), "42501");
    await fails(sql(a, "select pin_hash from ez_meet_people where meet_id = $1", [m]), "42501");
    await fails(sql(a, "select * from ez_meet_people where meet_id = $1", [m]), "42501");
    expect(await sql(a, "select id, name, is_owner, attend, cells, auto from ez_meet_people where meet_id = $1", [m])).toHaveLength(1);
  });
});

describe("ez_circles 제약", () => {
  it("이름: 앞뒤 공백 없는 1~30자. 살아 있는 것끼리 겹침 금지 (대소문자 무시)", async () => {
    const a = user();
    expect(CIRCLE_NAME_MAX).toBe(30);
    await circle(a, "가".repeat(CIRCLE_NAME_MAX));
    for (const name of ["", " ", " 앞", "뒤 ", "가".repeat(CIRCLE_NAME_MAX + 1)]) await fails(circle(a, name), "23514");
    const c = await circle(a, "Study");
    await fails(circle(a, "study"), "23505");
    await circle(user(), "Study");
    await softDelete(a, "ez_circles", c);
    const again = await circle(a, "STUDY");
    await fails(sql(a, "update ez_circles set deleted_at = null where id = $1", [c]), "23505");
    await softDelete(a, "ez_circles", again);
    await sql(a, "update ez_circles set deleted_at = null where id = $1", [c]);
  });

  it("사람들: 0~50명, 각 앞뒤 공백 없는 1~20자, 겹침 없음(대소문자 · 공백 무시)", async () => {
    const a = user();
    expect([MEMBERS_MAX, PERSON_NAME_MAX]).toEqual([50, 20]);
    const c = await circle(a, "넉넉", { members: Array.from({ length: MEMBERS_MAX }, (_, i) => `사람${i}`) });
    expect((await one(a, "select members from ez_circles where id = $1", [c])).members).toHaveLength(MEMBERS_MAX);
    await circle(a, "빈 묶음");
    await circle(a, "긴 이름", { members: ["가".repeat(PERSON_NAME_MAX)] });
    const bad: string[][] = [
      Array.from({ length: MEMBERS_MAX + 1 }, (_, i) => `사람${i}`),
      [""],
      [" 민서"],
      ["가".repeat(PERSON_NAME_MAX + 1)],
      ["Kim", "kim"],
      ["민서", "민 서"],
    ];
    for (const [i, members] of bad.entries()) await fails(circle(a, `나쁨${i}`, { members }), "23514");
    await fails(sql(a, "insert into ez_circles (name, members) values ('널', array[null]::text[])"), "23514");
  });

  it("묶음은 30개까지 (넣을 때 · 되살릴 때)", async () => {
    const a = user();
    expect(CIRCLES_MAX).toBe(30);
    const ids: string[] = [];
    for (let i = 0; i < CIRCLES_MAX; i++) ids.push(await circle(a, `묶음${i}`));
    await fails(circle(a, "하나 더"), "EZ_LIMIT");
    await softDelete(a, "ez_circles", ids[0]!);
    await circle(a, "빈 자리");
    await fails(sql(a, "update ez_circles set deleted_at = null where id = $1", [ids[0]]), "EZ_LIMIT");
  });

  it("역할: 내 역할만, 지운 역할은 새로 못 건다. 걸어 둔 역할을 지우면 묶음은 그대로 가리킨다", async () => {
    const a = user();
    const r = await role(a, "동아리");
    const c = await circle(a, "APPTIVE", { role_id: r });
    await fails(circle(a, "남의 역할", { role_id: await role(user(), "남") }), "23503");
    await softDelete(a, "ez_roles", r);
    expect((await one("admin", "select role_id from ez_circles where id = $1", [c])).role_id).toBe(r);
    await fails(circle(a, "지운 역할", { role_id: r }), "EZ_ROLE");
    // 역할 행이 정말 지워지면 그 칸만 빈다
    await sql("admin", "delete from ez_roles where id = $1", [r]);
    expect(await one("admin", "select role_id, name from ez_circles where id = $1", [c])).toEqual({ role_id: null, name: "APPTIVE" });
  });

  it("버전: 넣으면 1, 바뀌면 +1, 그대로면 그대로. 프로젝트 구멍은 둘 다 있거나 둘 다 없다", async () => {
    const a = user();
    const c = await circle(a, "스터디");
    const v = async () => (await one("admin", "select version from ez_circles where id = $1", [c])).version;
    expect(await v()).toBe(1);
    await sql(a, "update ez_circles set members = $2 where id = $1", [c, ["민서"]]);
    expect(await v()).toBe(2);
    await sql(a, "update ez_circles set members = $2 where id = $1", [c, ["민서"]]);
    expect(await v()).toBe(2);
    await fails(circle(a, "구멍", { origin_kind: "project" }), "23514");
    await fails(circle(a, "구멍", { origin_kind: "meet", origin_id: randomUUID() }), "23514");
    await circle(a, "구멍", { origin_kind: "project", origin_id: randomUUID() });
  });
});

describe("ez_meets 제약", () => {
  it("제목 1~60자 · 메모 2000자 · 장소 글 1~60자", async () => {
    const a = user();
    expect([MEET_TITLE_MAX, PLACE_TEXT_MAX]).toEqual([60, 60]);
    await meet(a, { title: "가".repeat(MEET_TITLE_MAX), note: "가".repeat(2000), place_text: "가".repeat(PLACE_TEXT_MAX) });
    for (const title of ["", " ", " 앞", "가".repeat(MEET_TITLE_MAX + 1)]) await fails(meet(a, { title }), "23514");
    await fails(meet(a, { note: "가".repeat(2001) }), "23514");
    for (const place_text of ["", " 앞", "가".repeat(PLACE_TEXT_MAX + 1)]) await fails(meet(a, { place_text }), "23514");
  });

  it("시간: 셋 다 있거나 셋 다 없다. 시작 0~1439, 끝은 시작보다 늦고 1440 까지(자정을 넘기지 않는다)", async () => {
    const a = user();
    await meet(a, { meet_date: "2026-10-05", start_min: 1380, end_min: 1440 });
    await meet(a, { meet_date: "2026-10-05", start_min: 0, end_min: 1 });
    const bad: Record<string, unknown>[] = [
      { meet_date: "2026-10-05" },
      { start_min: 600, end_min: 660 },
      { meet_date: "2026-10-05", start_min: 600 },
      { meet_date: "2026-10-05", start_min: 600, end_min: 600 },
      { meet_date: "2026-10-05", start_min: -1, end_min: 60 },
      { meet_date: "2026-10-05", start_min: 1440, end_min: 1441 },
      { meet_date: "2026-10-05", start_min: 1380, end_min: 1441 },
    ];
    for (const x of bad) await fails(meet(a, x), "EZ_VALUE");
    const m = await meet(a);
    await fails(sql(a, "update ez_meets set meet_date = '2026-10-05' where id = $1", [m]), "EZ_VALUE");
    expect(await liveEvents(m)).toHaveLength(0);
  });

  it("맞추기 설정(poll): 후보 날짜 1~31개(겹침 없음 · 오름차순), 30분 단위 범위와 길이", async () => {
    const a = user();
    const good = { dates: ["2026-10-05", "2026-10-07"], day_from: 540, day_to: 1320, duration_min: 60 };
    await meet(a, { poll: good });
    await meet(a, { poll: { ...good, day_from: 0, day_to: 1440, duration_min: 480 } });
    const d31 = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    await meet(a, { poll: { ...good, dates: d31 } });
    const bad: unknown[] = [
      { ...good, dates: [] },
      { ...good, dates: [...d31, "2026-11-01"] },
      { ...good, dates: ["2026-10-07", "2026-10-05"] },
      { ...good, dates: ["2026-10-05", "2026-10-05"] },
      { ...good, dates: ["2026-02-30"] },
      { ...good, dates: [20261005] },
      { ...good, day_from: 545 },
      { ...good, day_to: 1470 },
      { ...good, day_from: 600, day_to: 600 },
      { ...good, duration_min: 0 },
      { ...good, duration_min: 45 },
      { ...good, duration_min: 510 },
      { ...good, duration_min: "60" },
      { ...good, extra: 1 },
      { dates: good.dates, day_from: 540, day_to: 1320 },
      [],
    ];
    for (const poll of bad) await fails(sql(a, "insert into ez_meets (title, poll) values ('x', $1::jsonb)", [JSON.stringify(poll)]), "23514");
  });

  it("공개 열쇠: 22자, 겹침 없음 (service_role 로 — 주인은 직접 못 쓴다)", async () => {
    const a = user();
    const m1 = await meet(a);
    const m2 = await meet(a);
    await sql("service", "update ez_meets set token = 'abcdefghijklmnopqrstu_' where id = $1", [m1]);
    await fails(sql("service", "update ez_meets set token = 'short' where id = $1", [m2]), "23514");
    await fails(sql("service", "update ez_meets set token = 'abcdefghijklmnopqrstu_' where id = $1", [m2]), "23505");
  });

  it("지운 묶음은 새로 못 건다. 걸어 둔 묶음을 지우면 그대로 가리키고, 묶음 행이 정말 지워지면 circle_id 만 빈다", async () => {
    const a = user();
    const c = await circle(a, "스터디");
    const m = await meet(a, { circle_id: c });
    await softDelete(a, "ez_circles", c);
    expect((await mt(m)).circle_id).toBe(c);
    await fails(meet(a, { circle_id: c }), "EZ_CIRCLE");
    const other = await meet(a);
    await fails(sql(a, "update ez_meets set circle_id = $2 where id = $1", [other, c]), "EZ_CIRCLE");
    // 지운 묶음을 건 채로 다른 칸은 고칠 수 있다
    await sql(a, "update ez_meets set title = '고침' where id = $1", [m]);
    await sql("admin", "delete from ez_circles where id = $1", [c]);
    expect(await mt(m)).toMatchObject({ circle_id: null, title: "고침" });
  });

  it("버전 · id · 주인: 바뀌면 +1, id 와 주인은 못 바꾼다", async () => {
    const a = user();
    const m = await meet(a);
    await sql(a, "update ez_meets set note = '안건' where id = $1", [m]);
    await sql(a, "update ez_meets set note = '안건' where id = $1", [m]);
    expect((await mt(m)).version).toBe(2);
    await fails(sql("service", "update ez_meets set owner = $2 where id = $1", [m, user()]), "EZ_FIXED");
  });
});

describe("ez_meet_people", () => {
  it("모임을 만들면 내 줄이 같이 생긴다 — 이름은 설정의 내 이름, 없으면 '나'", async () => {
    const a = user();
    const m = await meet(a);
    expect(await people(m)).toMatchObject([{ name: DEFAULT_MY_NAME, is_owner: true, user_id: a, attend: null, cells: null, auto: false, pin_hash: null }]);
    await sql(a, "insert into ez_schedule_settings (my_name) values ('이지')");
    const m2 = await meet(a);
    expect((await people(m2))[0]).toMatchObject({ name: "이지", is_owner: true });
    // service_role(MCP)이 만들어도 그 주인의 이름
    const m3 = (await ins("service", "ez_meets", { owner: a, title: "대리" })).id;
    expect((await people(m3))[0]).toMatchObject({ name: "이지", is_owner: true, user_id: a });
    // 이미 만든 모임의 내 줄은 그대로
    await sql(a, "update ez_schedule_settings set my_name = '새 이름'");
    expect((await people(m2))[0]!.name).toBe("이지");
  });

  it("내 이름: 앞뒤 공백 없는 1~20자 또는 없음", async () => {
    const a = user();
    await sql(a, "insert into ez_schedule_settings (my_name) values ($1)", ["가".repeat(20)]);
    for (const n of ["", " 앞", "가".repeat(21)]) await fails(sql(a, "update ez_schedule_settings set my_name = $1", [n]), "23514");
    await sql(a, "update ez_schedule_settings set my_name = null");
  });

  it("이름: 앞뒤 공백 없는 1~20자, 한 모임 안에서 겹침 없음(대소문자 · 공백 무시). 다른 모임에는 같은 이름이 된다", async () => {
    const a = user();
    const m = await meet(a);
    await person(a, m, "가".repeat(PERSON_NAME_MAX));
    for (const n of ["", " 앞", "가".repeat(PERSON_NAME_MAX + 1)]) await fails(person(a, m, n), "23514");
    const p = await person(a, m, "Kim 민서");
    for (const n of ["kim 민서", "KIM민서", "Kim  민서", DEFAULT_MY_NAME]) await fails(person(a, m, n), "23505");
    await person(a, await meet(a), "Kim 민서");
    const q = await person(a, m, "도윤");
    await fails(sql(a, "update ez_meet_people set name = 'kim민서' where id = $1", [q]), "23505");
    await sql(a, "update ez_meet_people set name = '민서' where id = $1", [p]);
  });

  it("참석: yes · no · 없음. 고치면 updated_at 이 바뀐다", async () => {
    const a = user();
    const m = await meet(a);
    const p = await person(a, m, "민서", { attend: "yes" });
    await sql(a, "update ez_meet_people set attend = 'no' where id = $1", [p]);
    await sql(a, "update ez_meet_people set attend = null where id = $1", [p]);
    await fails(sql(a, "update ez_meet_people set attend = 'maybe' where id = $1", [p]), "23514");
    const r = await one("admin", "select created_at, updated_at from ez_meet_people where id = $1", [p]);
    expect(r.updated_at.getTime()).toBeGreaterThanOrEqual(r.created_at.getTime());
  });

  it("칸(cells)은 객체만, 자동 채움(auto)은 내 줄만", async () => {
    const a = user();
    const m = await meet(a);
    const p = await person(a, m, "민서", { cells: { "2026-10-05": [540, 570] } });
    await fails(sql(a, "update ez_meet_people set cells = '[540]'::jsonb where id = $1", [p]), "23514");
    await fails(sql(a, "update ez_meet_people set auto = true where id = $1", [p]), "23514");
    await sql(a, "update ez_meet_people set auto = true, cells = '{}'::jsonb where meet_id = $1 and is_owner", [m]);
  });

  it("넣은 순서가 남는다: 한 문장으로 여럿을 넣어도 created_at 이 차례대로", async () => {
    const a = user();
    const m = await meet(a);
    await sql(a, "insert into ez_meet_people (meet_id, name) values ($1, '하린'), ($1, '도윤'), ($1, '민서')", [m]);
    await person(a, m, "가은");
    const rows = await sql("admin", "select name from ez_meet_people where meet_id = $1 order by created_at", [m]);
    expect(rows.map((r) => r.name)).toEqual([DEFAULT_MY_NAME, "하린", "도윤", "민서", "가은"]);
  });

  it("한 모임에 50명까지", async () => {
    const a = user();
    const m = await meet(a);
    expect(PEOPLE_MAX).toBe(50);
    for (let i = 1; i < PEOPLE_MAX; i++) await person(a, m, `사람${i}`);
    const e = await fails(person(a, m, "하나 더"), "EZ_LIMIT");
    expect(e.message).toContain("더는 받을 수 없습니다");
  });

  it("사람을 빼면 줄이 지워진다. 내 줄은 못 빼고, 내 줄 여부 · 모임은 못 바꾼다. 모임 행이 지워지면 사람도 같이", async () => {
    const a = user();
    const m = await meet(a);
    const p = await person(a, m, "민서");
    expect(await sql(a, "delete from ez_meet_people where id = $1 returning id", [p])).toHaveLength(1);
    await fails(sql(a, "delete from ez_meet_people where meet_id = $1 and is_owner", [m]), "EZ_FIXED");
    const q = await person(a, m, "도윤");
    await fails(sql("service", "update ez_meet_people set is_owner = true where id = $1", [q]), "EZ_FIXED");
    await fails(sql("service", "update ez_meet_people set meet_id = $2 where id = $1", [q, await meet(a)]), "EZ_FIXED");
    await fails(sql("service", "insert into ez_meet_people (meet_id, name, is_owner) values ($1, '둘째 나', true)", [m]), "23505");
    await sql("admin", "delete from ez_meets where id = $1", [m]);
    expect(await people(m)).toHaveLength(0);
  });
});

describe("시간 ↔ 일정", () => {
  it("시간을 적어 만들면 일정 한 건이 같이 생긴다 (origin_kind = 'meet', 제목 · 지점 · 장소 글)", async () => {
    const a = user();
    const cafe = await place(a, "카페");
    const m = await meet(a, { title: "APPTIVE 회의", place_id: cafe, place_text: "2층 스터디룸", ...AT });
    const row = await mt(m);
    expect(row.event_id).not.toBeNull();
    expect(row.version).toBe(1);
    expect(await ev(row.event_id)).toMatchObject({
      owner: a,
      title: "APPTIVE 회의",
      date: "2026-10-05",
      start_min: 1140,
      end_min: 1260,
      place_id: cafe,
      where_text: "2층 스터디룸",
      origin_kind: "meet",
      origin_id: m,
      source: null,
      task_id: null,
      repeat: null,
      deleted_at: null,
    });
    // 주인이 일정 화면에서 읽을 수 있다
    expect(await sql(a, "select id from ez_events where id = $1", [row.event_id])).toHaveLength(1);
  });

  it("시간 없이 만들면 일정이 없고, 나중에 시간을 적으면 생긴다", async () => {
    const a = user();
    const m = await meet(a);
    expect((await mt(m)).event_id).toBeNull();
    expect(await liveEvents(m)).toHaveLength(0);
    await sql(a, "update ez_meets set meet_date = '2026-10-06', start_min = 600, end_min = 660 where id = $1", [m]);
    const row = await mt(m);
    expect(row.version).toBe(2);
    expect(await liveEvents(m)).toMatchObject([{ id: row.event_id, date: "2026-10-06", start_min: 600, end_min: 660 }]);
  });

  it("모임 쪽에서 시간 · 제목 · 장소를 바꾸면 일정이 따라간다 (새 일정을 만들지 않는다)", async () => {
    const a = user();
    const cafe = await place(a, "카페");
    const m = await meet(a, AT);
    const e = (await mt(m)).event_id;
    await sql(a, "update ez_meets set meet_date = '2026-10-08', start_min = 600, end_min = 720 where id = $1", [m]);
    expect(await ev(e)).toMatchObject({ date: "2026-10-08", start_min: 600, end_min: 720, version: 2 });
    await sql(a, "update ez_meets set title = '바꾼 제목', place_id = $2, place_text = '안쪽 방' where id = $1", [m, cafe]);
    expect(await ev(e)).toMatchObject({ title: "바꾼 제목", place_id: cafe, where_text: "안쪽 방" });
    // 메모만 바꾸면 일정은 그대로
    const v = (await ev(e)).version;
    await sql(a, "update ez_meets set note = '안건' where id = $1", [m]);
    expect((await ev(e)).version).toBe(v);
    expect(await liveEvents(m)).toHaveLength(1);
    expect((await mt(m)).event_id).toBe(e);
  });

  it("일정에서 시각을 바꿔도 모임의 시간은 안 따라간다. 그 뒤 모임의 다른 칸을 고쳐도 일정 시각을 덮지 않는다", async () => {
    const a = user();
    const m = await meet(a, AT);
    const e = (await mt(m)).event_id;
    await sql(a, "update ez_events set start_min = 1200, end_min = 1320, title = '내가 고친 제목' where id = $1", [e]);
    expect(await mt(m)).toMatchObject({ meet_date: "2026-10-05", start_min: 1140, end_min: 1260, version: 1 });
    await sql(a, "update ez_meets set note = '안건' where id = $1", [m]);
    expect(await ev(e)).toMatchObject({ start_min: 1200, end_min: 1320, title: "내가 고친 제목" });
    // 모임 쪽에서 시간을 바꾸면 다시 모임이 기준
    await sql(a, "update ez_meets set start_min = 600, end_min = 660 where id = $1", [m]);
    expect(await ev(e)).toMatchObject({ start_min: 600, end_min: 660, title: "내가 고친 제목" });
  });

  it("모임의 시간을 비우면 딸린 일정이 지워지고 event_id 가 빈다", async () => {
    const a = user();
    const m = await meet(a, AT);
    const e = (await mt(m)).event_id;
    await sql(a, "update ez_meets set meet_date = null, start_min = null, end_min = null where id = $1", [m]);
    expect(await mt(m)).toMatchObject({ meet_date: null, event_id: null, version: 2 });
    expect((await ev(e)).deleted_at).not.toBeNull();
    // 다시 적으면 새 일정
    await sql(a, "update ez_meets set meet_date = '2026-10-09', start_min = 600, end_min = 660 where id = $1", [m]);
    const again = (await mt(m)).event_id;
    expect(again).not.toBe(e);
    expect(await liveEvents(m)).toMatchObject([{ id: again, date: "2026-10-09" }]);
  });

  it("일정에서 지우면 모임은 시간이 정해진 채 event_id 만 빈다. 다른 칸을 고쳐도 다시 안 생기고, 일정을 되돌리면 다시 붙는다", async () => {
    const a = user();
    const m = await meet(a, AT);
    const e = (await mt(m)).event_id;
    await softDelete(a, "ez_events", e);
    expect(await mt(m)).toMatchObject({ meet_date: "2026-10-05", start_min: 1140, end_min: 1260, event_id: null });
    await sql(a, "update ez_meets set title = '고침', start_min = 1200 where id = $1", [m]);
    expect(await liveEvents(m)).toHaveLength(0);
    expect((await mt(m)).event_id).toBeNull();
    await sql(a, "update ez_events set deleted_at = null where id = $1", [e]);
    expect((await mt(m)).event_id).toBe(e);
    // 되돌린 일정은 지울 때 모습 그대로 (모임 쪽에서 그 사이 바꾼 시간은 다음에 모임을 고칠 때 맞춰진다)
    expect(await ev(e)).toMatchObject({ start_min: 1140, title: "회의" });
  });

  it("일정을 되돌려도 그 사이 시간을 비웠거나 다른 일정이 붙었거나 모임을 지웠으면 안 붙는다", async () => {
    const a = user();
    const m = await meet(a, AT);
    const e = (await mt(m)).event_id;
    await softDelete(a, "ez_events", e);
    await decide(a, m, (await mt(m)).version, "2026-10-05", 1140, 1260);
    const e2 = (await mt(m)).event_id;
    await sql(a, "update ez_events set deleted_at = null where id = $1", [e]);
    expect((await mt(m)).event_id).toBe(e2);

    const m2 = await meet(a, AT);
    const x = (await mt(m2)).event_id;
    await softDelete(a, "ez_events", x);
    await softDelete(a, "ez_meets", m2);
    await sql(a, "update ez_events set deleted_at = null where id = $1", [x]);
    expect((await mt(m2)).event_id).toBeNull();
  });

  it("모임을 지우면 딸린 일정 · 할 일은 남는다. 되돌리면 그대로 이어져 있다", async () => {
    const a = user();
    const m = await meet(a, AT);
    const e = (await mt(m)).event_id;
    const t = (await ins(a, "ez_tasks", { title: "회의록 정리", origin_kind: "meet", origin_id: m })).id;
    await softDelete(a, "ez_meets", m);
    expect((await ev(e)).deleted_at).toBeNull();
    expect((await one("admin", "select deleted_at from ez_tasks where id = $1", [t])).deleted_at).toBeNull();
    await sql(a, "update ez_meets set deleted_at = null where id = $1", [m]);
    expect(await mt(m)).toMatchObject({ event_id: e, deleted_at: null });
    expect(await liveEvents(m)).toHaveLength(1);
  });

  it("일정 행이 정말 지워지면 event_id 만 빈다", async () => {
    const a = user();
    const m = await meet(a, AT);
    await sql("admin", "delete from ez_events where id = $1", [(await mt(m)).event_id]);
    expect(await mt(m)).toMatchObject({ event_id: null, meet_date: "2026-10-05" });
  });
});

describe("ez_meet_decide · ez_meet_reopen", () => {
  it("정하기: 시간과 일정을 한 번에. 돌려준 줄이 고친 모임이다", async () => {
    const a = user();
    const m = await meet(a, { title: "스터디" });
    const r = await decide(a, m, 1, "2026-10-07", 840, 960);
    expect(r).toMatchObject({ id: m, meet_date: "2026-10-07", start_min: 840, end_min: 960, version: 2 });
    expect(await liveEvents(m)).toMatchObject([{ id: r.event_id, title: "스터디", date: "2026-10-07", start_min: 840, end_min: 960 }]);
  });

  it("이미 일정이 있으면 그 일정을 옮긴다", async () => {
    const a = user();
    const m = await meet(a, AT);
    const e = (await mt(m)).event_id;
    const r = await decide(a, m, 1, "2026-10-12", 600, 660);
    expect(r.event_id).toBe(e);
    expect(await liveEvents(m)).toMatchObject([{ id: e, date: "2026-10-12", start_min: 600, end_min: 660 }]);
  });

  it("일정에 넣기: 일정 화면에서 지워 event_id 만 빈 모임에 같은 시간으로 부르면 일정이 다시 생긴다", async () => {
    const a = user();
    const m = await meet(a, AT);
    await softDelete(a, "ez_events", (await mt(m)).event_id);
    const r = await decide(a, m, (await mt(m)).version, "2026-10-05", 1140, 1260);
    expect(r.event_id).not.toBeNull();
    expect(await liveEvents(m)).toMatchObject([{ id: r.event_id, date: "2026-10-05", start_min: 1140, end_min: 1260 }]);
    // 그 설정은 트랜잭션 밖으로 새지 않는다: 다시 일정을 지우고 모임의 다른 칸을 고쳐도 안 생긴다
    await softDelete(a, "ez_events", r.event_id);
    await sql(a, "update ez_meets set note = 'x' where id = $1", [m]);
    expect(await liveEvents(m)).toHaveLength(0);
  });

  it("다시 열기: 시간을 비우고 딸린 일정을 지운다. 참석 · 칸은 남는다", async () => {
    const a = user();
    const m = await meet(a, AT);
    const e = (await mt(m)).event_id;
    const p = await person(a, m, "민서", { attend: "yes", cells: { "2026-10-05": [1140] } });
    const r = await reopen(a, m, 1);
    expect(r).toMatchObject({ meet_date: null, start_min: null, end_min: null, event_id: null, version: 2 });
    expect((await ev(e)).deleted_at).not.toBeNull();
    expect(await one("admin", "select attend, cells from ez_meet_people where id = $1", [p])).toEqual({ attend: "yes", cells: { "2026-10-05": [1140] } });
    // 이미 열려 있으면 그대로
    expect((await reopen(a, m, 2)).version).toBe(2);
  });

  it("버전이 다르면 [EZ_VERSION], 없는 · 지운 모임은 [EZ_NOT_FOUND], 값이 틀리면 [EZ_VALUE]", async () => {
    const a = user();
    const m = await meet(a);
    const e = await fails(decide(a, m, 9, "2026-10-07", 840, 960), "EZ_VERSION");
    expect(e.message).toContain("지금 버전 1");
    await fails(reopen(a, m, 9), "EZ_VERSION");
    await fails(decide(a, randomUUID(), 1, "2026-10-07", 840, 960), "EZ_NOT_FOUND");
    for (const [s, en] of [
      [840, 840],
      [-1, 60],
      [1440, 1500],
      [1380, 1441],
    ]) {
      await fails(decide(a, m, 1, "2026-10-07", s!, en!), "EZ_VALUE");
    }
    await fails(sql(a, "select ez_meet_decide($1, 1, null, 600, 660)", [m]), "EZ_VALUE");
    expect(await mt(m)).toMatchObject({ meet_date: null, version: 1 });
    await softDelete(a, "ez_meets", m);
    await fails(decide(a, m, 2, "2026-10-07", 840, 960), "EZ_NOT_FOUND");
  });

  it("p_as: service_role 은 그 주인으로 부른다. 로그인한 사람이 넣은 p_as 는 무시된다", async () => {
    const a = user();
    const b = user();
    const m = await meet(a);
    await fails(decide("service", m, 1, "2026-10-07", 840, 960), "EZ_NOT_FOUND");
    await fails(decide("service", m, 1, "2026-10-07", 840, 960, b), "EZ_NOT_FOUND");
    await fails(decide(b, m, 1, "2026-10-07", 840, 960, a), "EZ_NOT_FOUND");
    const r = await decide("service", m, 1, "2026-10-07", 840, 960, a);
    expect((await ev(r.event_id)).owner).toBe(a);
    expect((await reopen("service", m, 2, a)).meet_date).toBeNull();
  });
});

describe("다른 모듈과", () => {
  it("모임에서 나온 할 일: origin_kind = 'meet' 로 넣고 origin_id 로 찾는다", async () => {
    const a = user();
    const m = await meet(a);
    await ins(a, "ez_tasks", { title: "회의록 정리", origin_kind: "meet", origin_id: m });
    await ins(a, "ez_tasks", { title: "다른 할 일" });
    expect(await sql(a, "select title from ez_tasks where origin_kind = 'meet' and origin_id = $1", [m])).toEqual([{ title: "회의록 정리" }]);
  });

  it("지점: 지운(deleted_at) 지점은 그대로 가리키고, 지점 행이 정말 지워지면 place_id 만 빈다", async () => {
    const a = user();
    const cafe = await place(a, "카페");
    const m = await meet(a, { place_id: cafe });
    await softDelete(a, "ez_places", cafe);
    expect((await mt(m)).place_id).toBe(cafe);
    await sql("admin", "delete from ez_places where id = $1", [cafe]);
    expect((await mt(m)).place_id).toBeNull();
  });

  it("0007 의 일정 규칙은 그대로다: 일정을 지우면 딸린 마감이 끊긴다", async () => {
    const a = user();
    const e = (await ins(a, "ez_events", { title: "결혼식", date: "2026-10-11" })).id;
    const t = (await ins(a, "ez_tasks", { title: "봉투", due_event_id: e })).id;
    await softDelete(a, "ez_events", e);
    expect((await one("admin", "select due_event_id, due::text as due from ez_tasks where id = $1", [t]))).toEqual({ due_event_id: null, due: "2026-10-11" });
  });
});
