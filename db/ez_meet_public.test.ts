// 0012 (모임의 공개 쪽: ez_meet_public · ez_meet_enter · ez_meet_answer · ez_meet_rsvp, 링크 켜기 · 끄기, 핀)을 PGlite 에서 돌려 본다.
// Supabase 흉내는 db/testing.ts. 날짜: 2026-10-05 가 월요일.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { PEOPLE_MAX, PIN_TRIES, TOKEN_RE } from "../lib/meet";
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
const POLL = { dates: ["2026-10-05", "2026-10-06", "2026-10-08"], day_from: 540, day_to: 720, duration_min: 60 };
const PIN = "4821";

/** 맞추는 중인 모임 + 켠 링크 */
async function open(extra: Record<string, unknown> = {}): Promise<{ a: string; m: string; token: string }> {
  const a = user();
  const row = { title: "기획 회의", poll: JSON.stringify(POLL), ...extra };
  const keys = Object.keys(row);
  const m = (
    await one(a, `insert into ez_meets (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))
  ).id as string;
  const token = (await one(a, "select ez_meet_link($1, true) as t", [m])).t as string;
  return { a, m, token };
}

const pub = async (token: unknown, who = "anon") => (await one(who, "select ez_meet_public($1) as r", [token])).r as Row | null;
const enter = async (token: string, name: unknown, pin: unknown, who = "anon") => (await one(who, "select ez_meet_enter($1, $2, $3) as r", [token, name, pin])).r as Row;
const answer = async (token: string, name: string, pin: string, cells: unknown) =>
  (await one("anon", "select ez_meet_answer($1, $2, $3, $4::jsonb) as r", [token, name, pin, JSON.stringify(cells)])).r as Row;
const rsvp = async (token: string, name: string, pin: string, attend: string | null) =>
  (await one("anon", "select ez_meet_rsvp($1, $2, $3, $4) as r", [token, name, pin, attend])).r as Row;
const person = (m: string, name: string) => one("admin", "select * from ez_meet_people where meet_id = $1 and name = $2", [m, name]);
const who = (r: Row, name: string) => (r.meet.people as Row[]).find((p) => p.name === name)!;

// ---------------------------------------------------------------------------

describe("권한", () => {
  it("anon 은 테이블을 직접 못 읽고 못 쓴다. 열린 것은 함수 넷뿐이다", async () => {
    const { m, token } = await open();
    for (const t of ["ez_meets", "ez_meet_people", "ez_circles"]) await fails(sql("anon", `select * from ${t}`), "42501");
    await fails(sql("anon", "select name from ez_meet_people where meet_id = $1", [m]), "42501");
    await fails(sql("anon", "select token from ez_meets"), "42501");
    await fails(sql("anon", "update ez_meet_people set cells = '{}'::jsonb where meet_id = $1", [m]), "42501");
    await fails(sql("anon", "insert into ez_meet_people (meet_id, name) values ($1, '침범')", [m]), "42501");
    await fails(sql("anon", "delete from ez_meet_people where meet_id = $1", [m]), "42501");
    // 도우미 · 주최자 함수는 못 부른다 — 부를 수 있으면 열쇠 없이 모임 id 만으로 읽거나 핀을 시도할 수 있다
    await fails(sql("anon", "select ez_meet_id($1)", [token]), "42501");
    await fails(sql("anon", "select ez_meet_snapshot($1)", [m]), "42501");
    await fails(sql("anon", "select * from ez_meet_pin_check($1, '민서', '1234', true)", [m]), "42501");
    await fails(sql("anon", "select ez_pin_hash('a', '1234')"), "42501");
    await fails(sql("anon", "select ez_meet_link($1, true)", [m]), "42501");
    await fails(sql("anon", "select ez_meet_pin_clear($1)", [randomUUID()]), "42501");
    await fails(sql("anon", "select ez_cells_ok('{}'::jsonb)"), "42501");
    expect(await pub(token)).not.toBeNull();
  });

  it("로그인한 사람 · MCP(service_role)도 도우미는 못 부른다", async () => {
    const { a, m, token } = await open();
    for (const w of [a, "service"]) {
      await fails(sql(w, "select ez_meet_id($1)", [token]), "42501");
      await fails(sql(w, "select ez_meet_snapshot($1)", [m]), "42501");
      await fails(sql(w, "select * from ez_meet_pin_check($1, '민서', '1234', true)", [m]), "42501");
    }
    // MCP 가 핀을 지우거나 링크 함수를 부르는 길은 없다
    await fails(sql("service", "select ez_meet_pin_clear($1)", [randomUUID()]), "42501");
    await fails(sql("service", "select ez_meet_link($1, true)", [m]), "42501");
  });

  it("주최자는 핀 칸을 읽지도 쓰지도 못하고, 핀이 있는지만 읽는다. 열쇠는 직접 못 쓴다", async () => {
    const { a, m, token } = await open();
    await enter(token, "민서", PIN);
    await fails(sql(a, "select pin_hash from ez_meet_people where meet_id = $1", [m]), "42501");
    await fails(sql(a, "select pin_salt, pin_fails, pin_locked_until from ez_meet_people where meet_id = $1", [m]), "42501");
    await fails(sql(a, "select * from ez_meet_people where meet_id = $1", [m]), "42501");
    await fails(sql(a, "update ez_meet_people set pin_hash = null, pin_salt = null where meet_id = $1", [m]), "42501");
    await fails(sql(a, "update ez_meets set token = 'aaaaaaaaaaaaaaaaaaaaaa' where id = $1", [m]), "42501");
    const rows = await sql(a, "select name, has_pin from ez_meet_people where meet_id = $1 order by is_owner desc", [m]);
    expect(rows).toEqual([
      { name: "나", has_pin: false },
      { name: "민서", has_pin: true },
    ]);
  });
});

describe("공개 링크 켜기 · 끄기", () => {
  it("켜면 22자 열쇠, 다시 켜면 그대로, 끄면 죽고, 다시 켜면 새 열쇠", async () => {
    const a = user();
    const m = (await one(a, "insert into ez_meets (title) values ('회의') returning id")).id as string;
    const v0 = (await one("admin", "select version from ez_meets where id = $1", [m])).version;
    const t1 = (await one(a, "select ez_meet_link($1, true) as t", [m])).t as string;
    expect(t1).toMatch(TOKEN_RE);
    expect((await one(a, "select token, version from ez_meets where id = $1", [m]))).toEqual({ token: t1, version: v0 + 1 });
    expect((await one(a, "select ez_meet_link($1, true) as t", [m])).t).toBe(t1);
    expect((await pub(t1))!.title).toBe("회의");

    expect((await one(a, "select ez_meet_link($1, false) as t", [m])).t).toBeNull();
    expect(await pub(t1)).toBeNull();
    expect((await one(a, "select ez_meet_link($1, false) as t", [m])).t).toBeNull();
    const t2 = (await one(a, "select ez_meet_link($1, true) as t", [m])).t as string;
    expect(t2).toMatch(TOKEN_RE);
    expect(t2).not.toBe(t1);
    expect(await pub(t1)).toBeNull();
    expect(await pub(t2)).not.toBeNull();
    await fails(enter(t1, "민서", PIN), "EZ_NOT_FOUND");
  });

  it("남의 모임 · 지운 모임의 링크는 못 켠다. 모임을 지우면 링크가 바로 죽고, 되돌리면 살아난다", async () => {
    const { a, m, token } = await open();
    await fails(sql(user(), "select ez_meet_link($1, true)", [m]), "EZ_NOT_FOUND");
    await fails(sql(user(), "select ez_meet_link($1, false)", [m]), "EZ_NOT_FOUND");
    expect(await pub(token)).not.toBeNull();
    await sql(a, "update ez_meets set deleted_at = now() where id = $1", [m]);
    expect(await pub(token)).toBeNull();
    await fails(enter(token, "민서", PIN), "EZ_NOT_FOUND");
    await fails(sql(a, "select ez_meet_link($1, true)", [m]), "EZ_NOT_FOUND");
    await sql(a, "update ez_meets set deleted_at = null where id = $1", [m]);
    expect(await pub(token)).not.toBeNull();
  });

  it("없는 열쇠 · 모양이 다른 열쇠는 빈 결과", async () => {
    await open();
    for (const t of [null, "", "abc", "a".repeat(22), "a".repeat(23), "%".repeat(22), "'; drop table ez_meets; --"]) expect(await pub(t)).toBeNull();
  });
});

describe("ez_meet_public", () => {
  it("제목 · 지점 이름 · 장소 글 · 시간 · 설정 · 사람들만. 내부 값은 없다", async () => {
    const a = user();
    const place = (await one(a, "insert into ez_places (name) values ('학교 앞 카페') returning id")).id as string;
    const circle = (await one(a, "insert into ez_circles (name) values ('비밀 묶음') returning id")).id as string;
    const { m, token } = await (async () => {
      const m = (
        await one(a, "insert into ez_meets (title, note, place_id, place_text, circle_id, poll) values ('기획 회의', '비밀 메모', $1, '2층 창가', $2, $3) returning id", [
          place,
          circle,
          JSON.stringify(POLL),
        ])
      ).id as string;
      return { m, token: (await one(a, "select ez_meet_link($1, true) as t", [m])).t as string };
    })();
    await sql(a, "insert into ez_meet_people (meet_id, name) values ($1, '도윤')", [m]);
    await enter(token, "민서", PIN);
    await answer(token, "민서", PIN, { "2026-10-05": [540, 570] });

    const r = (await pub(token))!;
    expect(Object.keys(r).sort()).toEqual(["end_min", "meet_date", "people", "place", "poll", "start_min", "title", "where"]);
    expect(r).toMatchObject({ title: "기획 회의", place: "학교 앞 카페", where: "2층 창가", meet_date: null, start_min: null, end_min: null, poll: POLL });
    expect(r.people).toEqual([
      { name: "나", is_owner: true, cells: null, attend: null, has_pin: false },
      { name: "도윤", is_owner: false, cells: null, attend: null, has_pin: false },
      { name: "민서", is_owner: false, cells: { "2026-10-05": [540, 570] }, attend: null, has_pin: true },
    ]);

    // 들어오기 · 칠하기 결과에도 없다
    const all = JSON.stringify([r, await enter(token, "민서", PIN), await answer(token, "민서", PIN, {})]);
    const p = await person(m, "민서");
    const ids = (await sql("admin", "select id from ez_meet_people where meet_id = $1", [m])).map((x) => x.id as string);
    for (const secret of [a, m, place, circle, token, PIN, p.pin_hash, p.pin_salt, "비밀 메모", "비밀 묶음", '"owner"', "pin_", "note", "token", "event", "version", ...ids]) {
      expect(all, `밖으로 나가면 안 되는 값: ${secret}`).not.toContain(secret);
    }
  });

  it("정한 뒤에는 정한 시간이 보인다 (딸린 일정의 id · 내용은 없다)", async () => {
    const { a, m, token } = await open();
    const row = await one(a, "select * from ez_meet_decide($1, $2, '2026-10-06', 600, 660)", [m, 2]);
    const r = (await pub(token))!;
    expect(r).toMatchObject({ meet_date: "2026-10-06", start_min: 600, end_min: 660 });
    expect(JSON.stringify(r)).not.toContain(row.event_id);
  });
});

describe("ez_meet_enter — 이름 · 핀", () => {
  it("없는 이름이면 새 줄 + 핀 설정. 핀은 sha256(salt ‖ pin) 으로만 남는다", async () => {
    const { m, token } = await open();
    const r = await enter(token, "  민서 ", PIN);
    expect(r.me).toBe("민서");
    expect(who(r, "민서")).toEqual({ name: "민서", is_owner: false, cells: null, attend: null, has_pin: true });
    const p = await person(m, "민서");
    expect(p.pin_salt).toMatch(/^[0-9a-f]{32}$/);
    expect(p.pin_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.pin_hash).toBe((await one("admin", "select encode(sha256(convert_to($1 || $2, 'UTF8')), 'hex') as h", [p.pin_salt, PIN])).h);
    expect(p.pin_hash).not.toContain(PIN);
    expect(p).toMatchObject({ is_owner: false, user_id: null, pin_fails: 0, pin_locked_until: null, auto: false });
    // 같은 핀이어도 사람마다 소금이 다르다
    await enter(token, "도윤", PIN);
    expect((await person(m, "도윤")).pin_hash).not.toBe(p.pin_hash);
  });

  it("다시 오면 확인: 맞으면 들어오고(대소문자 · 공백 무시한 같은 이름), 틀리면 못 들어온다", async () => {
    const { m, token } = await open();
    await enter(token, "Min Seo", PIN);
    expect((await enter(token, "minseo", PIN)).me).toBe("Min Seo");
    const bad = await enter(token, "Min Seo", "0000");
    expect(bad).toEqual({ error: { code: "EZ_PIN", message: "핀번호가 다릅니다. 잊었으면 주최자에게 지워 달라고 하세요" } });
    expect(await sql("admin", "select id from ez_meet_people where meet_id = $1", [m])).toHaveLength(2);
  });

  it("미리 넣어 둔 사람은 처음 들어올 때 핀을 정한다 (칠해 둔 것 · 참석은 그대로)", async () => {
    const { a, m, token } = await open();
    await sql(a, "insert into ez_meet_people (meet_id, name, attend) values ($1, '도윤', 'yes')", [m]);
    expect((await pub(token))!.people[1]).toMatchObject({ name: "도윤", has_pin: false });
    const r = await enter(token, "도윤", "123456");
    expect(who(r, "도윤")).toMatchObject({ attend: "yes", has_pin: true });
    expect((await enter(token, "도윤", "1234")).error.code).toBe("EZ_PIN");
    expect((await enter(token, "도윤", "123456")).me).toBe("도윤");
    expect(await sql("admin", "select id from ez_meet_people where meet_id = $1", [m])).toHaveLength(2);
  });

  it("주최자 이름으로는 못 들어온다. 이름 · 핀 모양이 다르면 거절", async () => {
    const { m, token } = await open();
    await fails(enter(token, "나", PIN), "EZ_OWNER");
    await fails(enter(token, " 나 ", PIN), "EZ_OWNER");
    for (const name of ["", "   ", null, "가".repeat(21)]) await fails(enter(token, name, PIN), "EZ_VALUE");
    for (const pin of ["", null, "123", "1234567", "12a4", "12 34", "１２３４", "-1234"]) await fails(enter(token, "민서", pin), "EZ_VALUE");
    expect((await enter(token, "가".repeat(20), PIN)).me).toBe("가".repeat(20));
    expect(await sql("admin", "select id from ez_meet_people where meet_id = $1", [m])).toHaveLength(2);
    expect((await person(m, "나")).pin_hash).toBeNull();
  });

  it(`${PEOPLE_MAX}명을 넘으면 더 못 들어온다`, async () => {
    const { a, m, token } = await open();
    await sql(a, "insert into ez_meet_people (meet_id, name) select $1, '사람' || g from generate_series(1, $2::int) g", [m, PEOPLE_MAX - 1]);
    await fails(enter(token, "하나 더", PIN), "EZ_LIMIT");
    // 이미 있는 사람은 들어온다
    expect((await enter(token, "사람1", PIN)).me).toBe("사람1");
  });

  it("로그인한 사람도 링크로는 남처럼 들어온다", async () => {
    const { token } = await open();
    expect((await enter(token, "민서", PIN, user())).me).toBe("민서");
    expect((await pub(token, user()))!.people).toHaveLength(2);
  });
});

describe("핀 잠금 · 지우기", () => {
  it(`${PIN_TRIES}번 틀리면 10분 잠긴다. 잠긴 동안에는 맞는 핀도 안 받는다`, async () => {
    const { m, token } = await open();
    await enter(token, "민서", PIN);
    for (let i = 1; i < PIN_TRIES; i++) {
      expect((await enter(token, "민서", "0000")).error.code).toBe("EZ_PIN");
      // 틀린 횟수가 남는다 (예외로 던지면 되돌아가 버린다)
      expect((await person(m, "민서")).pin_fails).toBe(i);
    }
    const last = await enter(token, "민서", "0000");
    expect(last).toEqual({ error: { code: "EZ_LOCKED", message: "핀번호를 5번 틀렸습니다. 10분 뒤에 다시 해 주세요" } });
    const p = await person(m, "민서");
    const mins = (new Date(p.pin_locked_until).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(9);
    expect(mins).toBeLessThan(11);

    expect((await enter(token, "민서", PIN)).error.code).toBe("EZ_LOCKED");
    expect((await answer(token, "민서", PIN, {})).error.code).toBe("EZ_LOCKED");
    expect((await rsvp(token, "민서", PIN, "yes")).error.code).toBe("EZ_LOCKED");
    // 다른 사람은 그대로 들어온다
    expect((await enter(token, "도윤", PIN)).me).toBe("도윤");

    // 10분이 지나면 풀리고, 틀린 횟수는 처음부터 다시 센다
    await sql("admin", "update ez_meet_people set pin_locked_until = now() - interval '1 second' where id = $1", [p.id]);
    expect((await enter(token, "민서", "0000")).error.code).toBe("EZ_PIN");
    expect(await person(m, "민서")).toMatchObject({ pin_fails: 1, pin_locked_until: null });
    expect((await enter(token, "민서", PIN)).me).toBe("민서");
    expect((await person(m, "민서")).pin_fails).toBe(0);
  });

  it("맞으면 틀린 횟수가 지워진다. 칠하기 · 참석에서 틀려도 센다", async () => {
    const { m, token } = await open();
    await enter(token, "민서", PIN);
    expect((await answer(token, "민서", "0000", {})).error.code).toBe("EZ_PIN");
    expect((await rsvp(token, "민서", "0000", "yes")).error.code).toBe("EZ_PIN");
    expect((await person(m, "민서")).pin_fails).toBe(2);
    await answer(token, "민서", PIN, {});
    expect((await person(m, "민서")).pin_fails).toBe(0);
  });

  it("주최자가 핀을 지우면 그 이름으로 다시 들어오며 새 핀을 정한다. 칠한 것은 그대로", async () => {
    const { a, m, token } = await open();
    await enter(token, "민서", PIN);
    await answer(token, "민서", PIN, { "2026-10-05": [600] });
    for (let i = 0; i < PIN_TRIES; i++) await enter(token, "민서", "0000");
    const p = await person(m, "민서");
    expect(p.pin_locked_until).not.toBeNull();

    // 남의 모임 사람 · anon 은 못 지운다
    await fails(sql(user(), "select ez_meet_pin_clear($1)", [p.id]), "EZ_NOT_FOUND");
    await fails(sql(a, "select ez_meet_pin_clear($1)", [randomUUID()]), "EZ_NOT_FOUND");
    expect((await person(m, "민서")).pin_hash).toBe(p.pin_hash);

    await sql(a, "select ez_meet_pin_clear($1)", [p.id]);
    expect(await person(m, "민서")).toMatchObject({ pin_hash: null, pin_salt: null, pin_fails: 0, pin_locked_until: null, cells: { "2026-10-05": [600] } });
    expect(who({ meet: await pub(token) }, "민서")).toMatchObject({ has_pin: false, cells: { "2026-10-05": [600] } });
    // 핀이 없는 동안에는 칠하기 · 참석을 못 한다 (들어와 새로 정해야 한다)
    expect((await answer(token, "민서", PIN, {})).error.code).toBe("EZ_PIN");

    const r = await enter(token, "민서", "777777");
    expect(who(r, "민서")).toMatchObject({ has_pin: true, cells: { "2026-10-05": [600] } });
    expect((await enter(token, "민서", PIN)).error.code).toBe("EZ_PIN");
    expect((await enter(token, "민서", "777777")).me).toBe("민서");
    expect((await person(m, "민서")).id).toBe(p.id);
  });
});

describe("ez_meet_answer — 되는 칸", () => {
  it("저장하면 전체를 다시 준다. 이른 순 · 겹침 없이 정리되고, 보낸 것이 통째로 갈아끼운다", async () => {
    const { token } = await open();
    await enter(token, "민서", PIN);
    await enter(token, "도윤", "9999");
    await answer(token, "도윤", "9999", { "2026-10-06": [690] });
    const r = await answer(token, "민서", PIN, { "2026-10-08": [600, 540, 600], "2026-10-05": [690], "2026-10-06": [] });
    expect(r.me).toBe("민서");
    expect(who(r, "민서").cells).toEqual({ "2026-10-05": [690], "2026-10-08": [540, 600] });
    expect(who(r, "도윤").cells).toEqual({ "2026-10-06": [690] });
    expect(who(await answer(token, "민서", PIN, { "2026-10-05": [540] }), "민서").cells).toEqual({ "2026-10-05": [540] });
    // 다 지우면 '칠했는데 되는 칸이 없음' ({}) — 안 칠함(null)과 다르다
    expect(who(await answer(token, "민서", PIN, {}), "민서").cells).toEqual({});
  });

  it("검사: 후보 날짜 · 30분 단위 · 하루 범위 · 모양 · 크기", async () => {
    const { m, token } = await open();
    await enter(token, "민서", PIN);
    await answer(token, "민서", PIN, { "2026-10-05": [540] });
    const bad: unknown[] = [
      { "2026-10-07": [540] },
      { "2026-10-05": [550] },
      { "2026-10-05": [510] },
      { "2026-10-05": [720] },
      { "2026-10-05": [-30] },
      { "2026-10-05": [540.5] },
      { "2026-10-05": ["540"] },
      { "2026-10-05": [null] },
      { "2026-10-05": 540 },
      { "2026-10-05": { "0": 540 } },
      { "2026-10-05": Array.from({ length: 49 }, () => 540) },
      { "2026-10-05 ": [540] },
      [540],
      "칸",
      null,
    ];
    for (const cells of bad) await fails(answer(token, "민서", PIN, cells), "EZ_VALUE");
    await fails(answer(token, "민서", PIN, { "2026-10-05": Array.from({ length: 4000 }, () => 540000) }), "EZ_VALUE");
    expect((await person(m, "민서")).cells).toEqual({ "2026-10-05": [540] });
    // 범위의 끝 칸까지
    expect(who(await answer(token, "민서", PIN, { "2026-10-05": [540, 690] }), "민서").cells).toEqual({ "2026-10-05": [540, 690] });
  });

  it("들어온 적 없는 이름 · 주최자 이름 · 틀린 핀으로는 못 칠한다", async () => {
    const { a, m, token } = await open();
    await sql(a, "insert into ez_meet_people (meet_id, name) values ($1, '도윤')", [m]);
    expect((await answer(token, "없는 사람", PIN, {})).error.code).toBe("EZ_PIN");
    expect((await answer(token, "도윤", PIN, {})).error.code).toBe("EZ_PIN");
    await fails(answer(token, "나", PIN, {}), "EZ_OWNER");
    await enter(token, "민서", PIN);
    expect((await answer(token, "민서", "1111", { "2026-10-05": [540] })).error.code).toBe("EZ_PIN");
    expect(await sql("admin", "select name from ez_meet_people where meet_id = $1 and cells is not null", [m])).toHaveLength(0);
    expect(await sql("admin", "select name from ez_meet_people where meet_id = $1", [m])).toHaveLength(3);
  });

  it("시간이 정해진 뒤 · 맞추기를 안 쓰는 모임에는 못 칠한다. 다시 열면 칠한 것이 남아 있고 다시 칠해진다", async () => {
    const { a, m, token } = await open();
    await enter(token, "민서", PIN);
    await answer(token, "민서", PIN, { "2026-10-05": [540] });
    const v = (await one("admin", "select version from ez_meets where id = $1", [m])).version;
    const row = await one(a, "select * from ez_meet_decide($1, $2, '2026-10-05', 540, 600)", [m, v]);
    await fails(answer(token, "민서", PIN, { "2026-10-06": [540] }), "EZ_CLOSED");
    expect((await person(m, "민서")).cells).toEqual({ "2026-10-05": [540] });

    await sql(a, "select ez_meet_reopen($1, $2)", [m, row.version]);
    expect(who({ meet: await pub(token) }, "민서").cells).toEqual({ "2026-10-05": [540] });
    expect(who(await answer(token, "민서", PIN, { "2026-10-06": [540] }), "민서").cells).toEqual({ "2026-10-06": [540] });

    await sql(a, "update ez_meets set poll = null where id = $1", [m]);
    await fails(answer(token, "민서", PIN, {}), "EZ_CLOSED");
  });

  it("후보 날짜 · 범위를 줄여 밖으로 나간 칸은 남는다 (다시 넓히면 살아난다)", async () => {
    const { a, m, token } = await open();
    await enter(token, "민서", PIN);
    await answer(token, "민서", PIN, { "2026-10-05": [540, 690], "2026-10-08": [600] });
    await sql(a, "update ez_meets set poll = $2 where id = $1", [m, JSON.stringify({ ...POLL, dates: ["2026-10-05", "2026-10-06"], day_from: 600 })]);
    // 지금 설정 밖의 칸은 못 보내지만, 이미 있던 것은 지워지지 않는다
    await fails(answer(token, "민서", PIN, { "2026-10-08": [600] }), "EZ_VALUE");
    await fails(answer(token, "민서", PIN, { "2026-10-05": [540] }), "EZ_VALUE");
    const r = await answer(token, "민서", PIN, { "2026-10-05": [600], "2026-10-06": [660] });
    expect(who(r, "민서").cells).toEqual({ "2026-10-05": [540, 600], "2026-10-06": [660], "2026-10-08": [600] });
    // 안쪽은 통째로 갈아끼운다 (10/5 11:30 은 지금 범위 안이라 지워졌다)
    expect(who(await answer(token, "민서", PIN, {}), "민서").cells).toEqual({ "2026-10-05": [540], "2026-10-08": [600] });
  });
});

describe("ez_meet_rsvp — 온다 / 못 온다", () => {
  it("정해진 뒤에만. yes · no · 비움", async () => {
    const { a, m, token } = await open();
    await enter(token, "민서", PIN);
    await fails(rsvp(token, "민서", PIN, "yes"), "EZ_OPEN");
    const v = (await one("admin", "select version from ez_meets where id = $1", [m])).version;
    await sql(a, "select ez_meet_decide($1, $2, '2026-10-05', 540, 600)", [m, v]);

    expect(who(await rsvp(token, "민서", PIN, "yes"), "민서").attend).toBe("yes");
    expect(who(await rsvp(token, "민서", PIN, "no"), "민서").attend).toBe("no");
    expect(who(await rsvp(token, "민서", PIN, null), "민서").attend).toBeNull();
    await fails(rsvp(token, "민서", PIN, "maybe"), "EZ_VALUE");
    await fails(rsvp(token, "나", PIN, "yes"), "EZ_OWNER");
    expect((await rsvp(token, "민서", "0000", "yes")).error.code).toBe("EZ_PIN");
    expect((await rsvp(token, "없는 사람", PIN, "yes")).error.code).toBe("EZ_PIN");
    // 정한 뒤 처음 들어온 남도 온다 / 못 온다를 누른다
    await enter(token, "하린", "2468");
    expect(who(await rsvp(token, "하린", "2468", "no"), "하린").attend).toBe("no");
    // 주최자가 본다
    expect(await sql(a, "select name, attend from ez_meet_people where meet_id = $1 and not is_owner order by created_at", [m])).toEqual([
      { name: "민서", attend: null },
      { name: "하린", attend: "no" },
    ]);
  });
});

describe("내 줄의 자동 채움 · 칸의 생김새", () => {
  it("맞추기를 켠 모임을 만들면 내 줄이 자동 채움 상태다. 나중에 켜도, 이미 칠했으면 그대로", async () => {
    const a = user();
    const mine = (m: string) => one("admin", "select auto, cells from ez_meet_people where meet_id = $1 and is_owner", [m]);
    const m1 = (await one(a, "insert into ez_meets (title, poll) values ('회의', $1) returning id", [JSON.stringify(POLL)])).id as string;
    expect(await mine(m1)).toEqual({ auto: true, cells: null });

    const m2 = (await one(a, "insert into ez_meets (title) values ('회의') returning id")).id as string;
    expect(await mine(m2)).toEqual({ auto: false, cells: null });
    await sql(a, "update ez_meets set poll = $2 where id = $1", [m2, JSON.stringify(POLL)]);
    expect(await mine(m2)).toEqual({ auto: true, cells: null });

    // 내가 손으로 고친 뒤(auto = false)에는 설정을 바꿔도 안 건드린다
    await sql(a, "update ez_meet_people set cells = $2, auto = false where meet_id = $1 and is_owner", [m2, JSON.stringify({ "2026-10-05": [540] })]);
    await sql(a, "update ez_meets set poll = null where id = $1", [m2]);
    await sql(a, "update ez_meets set poll = $2 where id = $1", [m2, JSON.stringify(POLL)]);
    expect(await mine(m2)).toEqual({ auto: false, cells: { "2026-10-05": [540] } });

    // MCP(service_role)로 만들어도 같다
    const m3 = (await one("service", "insert into ez_meets (owner, title, poll) values ($1, '회의', $2) returning id", [a, JSON.stringify(POLL)])).id as string;
    expect(await mine(m3)).toEqual({ auto: true, cells: null });
  });

  it("주최자가 직접 쓰는 칸도 생김새를 지킨다", async () => {
    const a = user();
    const m = (await one(a, "insert into ez_meets (title, poll) values ('회의', $1) returning id", [JSON.stringify(POLL)])).id as string;
    const set = (cells: unknown) => sql(a, "update ez_meet_people set cells = $2::jsonb, auto = true where meet_id = $1 and is_owner", [m, JSON.stringify(cells)]);
    await set({ "2026-10-05": [0, 30, 1410], "2026-12-31": [] });
    await set({});
    for (const cells of [{ "2026-10-05": [15] }, { "2026-10-05": [1440] }, { "2026-10-05": [60, 30] }, { "2026-10-05": [30, 30] }, { "10/5": [30] }, { "2026-10-05": "30" }, { "2026-10-05": [30.5] }, { "2026-02-30": [30] }]) {
      await fails(set(cells), "23514");
    }
    await fails(sql(a, "update ez_meet_people set cells = '[]'::jsonb where meet_id = $1 and is_owner", [m]), "23514");
  });
});
