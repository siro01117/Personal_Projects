// 0018 (작업대 v2: 시간 기록 ez_work_log · ez_work_start/stop/sum/week/list, 단계 안 단계 · 단계별 걸릴 시간,
// 규칙의 bench, 작업대 · 기록이 있는 지난 회차 보호)을 PGlite 에서 돌려 본다. Supabase 흉내는 db/testing.ts.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
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

/** 실패해야 한다. code 가 EZ_ 로 시작하면 P0001 + '[EZ_…] ' 메시지, 아니면 SQLSTATE */
async function fails(p: Promise<unknown>, code: string): Promise<void> {
  const e: any = await p.then(
    () => null,
    (err) => err,
  );
  expect(e, `${code} 로 실패해야 합니다`).not.toBeNull();
  if (code.startsWith("EZ_")) {
    expect(e.code, e.message).toBe("P0001");
    expect(e.message).toMatch(new RegExp(`^\\[${code}\\] \\S`));
  } else expect(e.code, e.message).toBe(code);
}

const user = () => randomUUID();
const J = (v: unknown) => JSON.stringify(v);
const task = async (who: string, title = "할 일") => (await sql(who, "insert into ez_tasks (title) values ($1) returning id", [title]))[0]!.id as string;
const start = (who: string, id: string, as: string | null = null) =>
  sql(who, "select id, task_id, started_at, ended_at from ez_work_start($1, $2)", [id, as]).then((r) => r[0]!);
const stop = (who: string, as: string | null = null) => sql(who, "select ez_work_stop($1) n", [as]).then((r) => r[0]!.n as number);
/** 그 주인의 구간들 (시작 순) */
const spans = (owner: string) =>
  sql(
    "admin",
    "select id, task_id, ended_at is null as open, extract(epoch from (ended_at - started_at))::int as sec from ez_work_log where owner = $1 order by started_at, created_at",
    [owner],
  );
/** 시험용: 정한 때의 구간을 바로 넣는다 (ended 가 null 이면 열린 채) */
const put = (owner: string, id: string, started: string, ended: string | null) =>
  sql("admin", "insert into ez_work_log (owner, task_id, started_at, ended_at) values ($1, $2, $3::timestamptz, $4::timestamptz)", [owner, id, started, ended]);
const sum = (who: string, as: string | null = null) => sql(who, "select task_id, today_sec, total_sec, running from ez_work_sum($1) order by task_id", [as]);
const week = (who: string, mon: string, as: string | null = null) =>
  sql(who, "select task_id, day::text as day, seconds from ez_work_week($1, $2)", [mon, as]);

describe("0018 파일", () => {
  it("지우기 · 버리기 문이 없다 (원격 도구가 거절한다)", () => {
    const text = readFileSync(new URL("./migrations/0018_ez_work.sql", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(text).not.toMatch(/\bdelete\s+from\b/i);
    expect(text).not.toMatch(/\bdrop\s/i);
    expect(text).not.toMatch(/\btruncate\b/i);
  });
});

describe("ez_work_start · ez_work_stop", () => {
  it("시작하면 구간이 열리고 중지하면 닫힌다", async () => {
    const a = user();
    const x = await task(a);
    const s = await start(a, x);
    expect(s).toMatchObject({ task_id: x, ended_at: null });
    expect(await spans(a)).toMatchObject([{ task_id: x, open: true }]);
    expect(await stop(a)).toBe(1);
    expect(await spans(a)).toMatchObject([{ task_id: x, open: false }]);
    expect(await stop(a)).toBe(0);
  });

  it("열린 구간은 사람당 하나 — 다른 할 일에서 시작하면 앞의 것이 닫힌다", async () => {
    const a = user();
    const x = await task(a);
    const y = await task(a);
    await start(a, x);
    await start(a, y);
    expect(await spans(a)).toMatchObject([
      { task_id: x, open: false },
      { task_id: y, open: true },
    ]);
    // 색인이 한 번 더 막는다
    await fails(put(a, x, "2026-10-01T00:00:00Z", null), "23505");
  });

  it("이미 이 할 일에서 돌고 있으면 그대로 (구간이 늘지 않는다)", async () => {
    const a = user();
    const x = await task(a);
    const s1 = await start(a, x);
    const s2 = await start(a, x);
    expect(s2.id).toBe(s1.id);
    expect(await spans(a)).toHaveLength(1);
  });

  it("24시간 넘게 열린 구간은 24시간으로 잘라 닫는다 (시작 · 중지 둘 다)", async () => {
    const a = user();
    const x = await task(a);
    const y = await task(a);
    await sql("admin", "insert into ez_work_log (owner, task_id, started_at) values ($1, $2, now() - interval '30 hours')", [a, x]);
    // 읽을 때도 24시간 · 돌지 않음
    expect(await sum(a)).toMatchObject([{ task_id: x, total_sec: 86400, running: false }]);
    await start(a, y);
    expect(await spans(a)).toMatchObject([
      { task_id: x, open: false, sec: 86400 },
      { task_id: y, open: true },
    ]);

    const b = user();
    const z = await task(b);
    await sql("admin", "insert into ez_work_log (owner, task_id, started_at) values ($1, $2, now() - interval '3 days')", [b, z]);
    // 같은 할 일을 다시 시작해도 낡은 구간은 닫고 새로 연다
    await start(b, z);
    expect(await spans(b)).toMatchObject([
      { task_id: z, open: false, sec: 86400 },
      { task_id: z, open: true },
    ]);
    const c = user();
    const w = await task(c);
    await sql("admin", "insert into ez_work_log (owner, task_id, started_at) values ($1, $2, now() - interval '25 hours')", [c, w]);
    expect(await stop(c)).toBe(1);
    expect(await spans(c)).toMatchObject([{ open: false, sec: 86400 }]);
  });

  it("끝낸 것은 못 시작하고, 없거나 지운 것 · 남의 것은 없다고 한다", async () => {
    const a = user();
    const b = user();
    const x = await task(a);
    await sql(a, "update ez_tasks set done_at = now() where id = $1", [x]);
    await fails(start(a, x), "EZ_VALUE");
    const y = await task(a);
    await sql(a, "update ez_tasks set deleted_at = now() where id = $1", [y]);
    await fails(start(a, y), "EZ_NOT_FOUND");
    await fails(start(a, randomUUID()), "EZ_NOT_FOUND");
    const z = await task(a);
    await fails(start(b, z), "EZ_NOT_FOUND");
  });

  it("할 일을 끝내거나 지우면 그 할 일의 열린 구간이 닫힌다. 기록은 남는다", async () => {
    const a = user();
    const x = await task(a);
    await start(a, x);
    await sql(a, "update ez_tasks set done_at = now() where id = $1", [x]);
    expect(await spans(a)).toMatchObject([{ task_id: x, open: false }]);

    const y = await task(a);
    await start(a, y);
    await sql(a, "update ez_tasks set deleted_at = now() where id = $1", [y]);
    expect(await spans(a)).toMatchObject([{ open: false }, { task_id: y, open: false }]);

    // 다른 할 일을 끝내도 도는 구간은 그대로
    const z = await task(a);
    const w = await task(a);
    await start(a, z);
    await sql(a, "update ez_tasks set done_at = now() where id = $1", [w]);
    expect((await spans(a)).filter((s) => s.open)).toMatchObject([{ task_id: z }]);
    // 제목만 고쳐도 그대로
    await sql(a, "update ez_tasks set title = '고침' where id = $1", [z]);
    expect((await spans(a)).filter((s) => s.open)).toHaveLength(1);
  });

  it("읽기는 주인만, 쓰기는 함수로만. anon 은 아무것도 못 한다", async () => {
    const a = user();
    const b = user();
    const x = await task(a);
    await start(a, x);
    expect(await sql(a, "select id from ez_work_log")).toHaveLength(1);
    expect(await sql(b, "select id from ez_work_log")).toHaveLength(0);
    await fails(sql(a, "insert into ez_work_log (owner, task_id) values ($1, $2)", [a, x]), "42501");
    await fails(sql(a, "update ez_work_log set started_at = now() - interval '5 hours'"), "42501");
    await fails(sql("anon", "select * from ez_work_log"), "42501");
    await fails(sql("anon", "select ez_work_start($1)", [x]), "42501");
    await fails(sql("anon", "select ez_work_stop()"), "42501");
    await fails(sql("anon", "select * from ez_work_sum()"), "42501");
    await fails(sql("anon", "select * from ez_work_week('2026-10-05')"), "42501");
    // 남의 것을 중지시키지 못한다 (p_as 는 로그인한 사람에게는 무시된다)
    expect(await stop(b, a)).toBe(0);
    expect((await spans(a))[0]!.open).toBe(true);
  });

  it("service_role 은 p_as 로 대리한다. p_as 가 없으면 거절", async () => {
    const a = user();
    const x = await task(a);
    await fails(start("service", x), "EZ_AUTH");
    await fails(stop("service"), "EZ_AUTH");
    const s = await start("service", x, a);
    expect(s.task_id).toBe(x);
    expect(await sum("service", a)).toMatchObject([{ task_id: x, running: true }]);
    expect(await stop("service", a)).toBe(1);
    expect(await sum("service", a)).toMatchObject([{ task_id: x, running: false }]);
  });
});

describe("ez_work_sum · ez_work_week · ez_work_list", () => {
  it("오늘(Asia/Seoul) · 누적을 할 일별로. 지운 할 일은 빠진다", async () => {
    const a = user();
    const x = await task(a);
    const y = await task(a);
    const gone = await task(a);
    // 지난 구간 1시간 (오늘 아님)
    await put(a, x, "2026-01-05T01:00:00Z", "2026-01-05T02:00:00Z");
    // 오늘 10분
    await sql("admin", "insert into ez_work_log (owner, task_id, started_at, ended_at) values ($1, $2, now() - interval '10 minutes', now())", [a, x]);
    await put(a, gone, "2026-01-05T03:00:00Z", "2026-01-05T04:00:00Z");
    await sql(a, "update ez_tasks set deleted_at = now() where id = $1", [gone]);
    const rows = await sum(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: x, total_sec: 4200, running: false });
    // 자정 직후에 돌리면 오늘 몫이 10분보다 작을 수 있다
    expect(rows[0]!.today_sec).toBeGreaterThan(0);
    expect(rows[0]!.today_sec).toBeLessThanOrEqual(600);
    expect(await sum(user())).toEqual([]);
    void y;
  });

  it("한 주의 할 일 × 날짜 합. 자정을 넘는 구간은 날짜별로 나눈다", async () => {
    const a = user();
    const x = await task(a, "상법");
    const y = await task(a, "과제");
    // 2026-10-05(월) 주. 한국 시각 10/6 23:30 ~ 10/7 00:30 → 30분씩
    await put(a, x, "2026-10-06T14:30:00Z", "2026-10-06T15:30:00Z");
    // 10/5 09:00 ~ 09:45 (한국)
    await put(a, x, "2026-10-05T00:00:00Z", "2026-10-05T00:45:00Z");
    // 10/5 10:00 ~ 10:15 (한국) 다른 할 일
    await put(a, y, "2026-10-05T01:00:00Z", "2026-10-05T01:15:00Z");
    // 앞 주 일요일 23:50 ~ 월 00:10 → 이 주에는 10분만
    await put(a, y, "2026-10-04T14:50:00Z", "2026-10-04T15:10:00Z");
    // 다음 주는 안 들어온다
    await put(a, y, "2026-10-12T01:00:00Z", "2026-10-12T02:00:00Z");
    const rows = await week(a, "2026-10-05");
    const got = Object.fromEntries(rows.map((r) => [`${r.task_id === x ? "x" : "y"}:${r.day}`, r.seconds]));
    expect(got).toEqual({ "x:2026-10-05": 2700, "y:2026-10-05": 1500, "x:2026-10-06": 1800, "x:2026-10-07": 1800 });
    expect(await week(user(), "2026-10-05")).toEqual([]);
    expect(await week("service", "2026-10-05", a)).toHaveLength(4);
  });

  it("ez_work_list: 기간에 걸친 원 구간 (계산한 끝)", async () => {
    const a = user();
    const x = await task(a);
    await put(a, x, "2026-10-05T00:00:00Z", "2026-10-05T00:45:00Z");
    await put(a, x, "2026-10-08T00:00:00Z", "2026-10-08T00:45:00Z");
    const rows = await sql(a, "select task_id, started_at, ended_at, running from ez_work_list('2026-10-05', '2026-10-06')");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: x, running: false });
    expect(await sql(a, "select 1 from ez_work_list('2026-10-05', '2026-10-08')")).toHaveLength(2);
    const live = await task(a);
    await start(a, live);
    const today = (await sql("admin", "select (now() at time zone 'Asia/Seoul')::date::text d"))[0]!.d;
    const now = await sql(a, "select task_id, running, ended_at from ez_work_list($1, $1)", [today]);
    expect(now).toMatchObject([{ task_id: live, running: true }]);
    expect(now[0]!.ended_at).not.toBeNull();
  });
});

describe("체크 항목 새 모양 — 단계 안 단계 · 단계별 걸릴 시간", () => {
  const item = (t: string, extra: Record<string, unknown> = {}) => ({ t, done: false, ...extra });

  it("{t, done, est?, sub?: [{t, done, est?}]} 를 받는다. 옛 모양도 그대로", async () => {
    const a = user();
    const x = await task(a);
    const ok = [
      [item("옛 모양"), { t: "끝", done: true }],
      [item("시간", { est: 30 })],
      [item("윗단", { sub: [item("아랫단"), item("아랫단 2", { est: 600 })] })],
      [item("빈 아랫단", { sub: [] })],
      [item("둘 다", { est: 1, sub: [item("a", { est: 5 })] })],
    ];
    for (const c of ok) {
      await sql(a, "update ez_tasks set checklist = $2 where id = $1", [x, J(c)]);
      expect((await sql("admin", "select checklist from ez_tasks where id = $1", [x]))[0]!.checklist).toEqual(c);
    }
  });

  it("둘째 단 밑 · 틀린 est · 모르는 키는 거절", async () => {
    const a = user();
    const x = await task(a);
    const bad = [
      [item("깊다", { sub: [item("둘째", { sub: [item("셋째")] })] })],
      [item("깊다", { sub: [item("둘째", { sub: [] })] })],
      [item("x", { est: 0 })],
      [item("x", { est: 601 })],
      [item("x", { est: 1.5 })],
      [item("x", { est: "30" })],
      [item("x", { est: null })],
      [item("x", { sub: "글자" })],
      [item("x", { sub: [{ t: "done 없음" }] })],
      [item("x", { sub: ["글자"] })],
      [item("x", { sub: [item(" 앞")] })],
      [item("x", { note: "덤" })],
    ];
    for (const c of bad) await fails(sql(a, "update ez_tasks set checklist = $2 where id = $1", [x, J(c)]), "23514");
  });

  it("윗단 + 아랫단 합쳐 50개까지", async () => {
    const a = user();
    const x = await task(a);
    const sub = (n: number) => Array.from({ length: n }, (_, i) => item(`아랫단 ${i}`));
    await sql(a, "update ez_tasks set checklist = $2 where id = $1", [x, J([item("윗단", { sub: sub(49) })])]);
    await fails(sql(a, "update ez_tasks set checklist = $2 where id = $1", [x, J([item("윗단", { sub: sub(50) })])]), "23514");
    await fails(
      sql(a, "update ez_tasks set checklist = $2 where id = $1", [x, J([...Array.from({ length: 30 }, (_, i) => item(`윗단 ${i}`)), item("끝", { sub: sub(20) })])]),
      "23514",
    );
  });

  it("규칙의 단계 틀: 글자 또는 {t, est?, sub?} (done 없음). 합쳐 50개까지", async () => {
    const a = user();
    const mk = (checklist: unknown) =>
      sql(a, "insert into ez_task_rules (kind, title, repeat, start, checklist) values ('cycle', '주간', '{\"freq\":\"daily\"}', '2026-10-05', $1) returning id", [J(checklist)]);
    await mk(["글자", { t: "틀", est: 20 }, { t: "윗단", sub: ["아랫단", { t: "아랫단 2", est: 10 }] }]);
    await mk([{ t: "윗단", sub: Array.from({ length: 49 }, (_, i) => `아랫단 ${i}`) }]);
    for (const c of [
      [{ t: "done 은 못 쓴다", done: false }],
      [{ t: "윗단", sub: [{ t: "둘째", sub: [] }] }],
      [{ t: "윗단", sub: [{ t: "둘째", done: false }] }],
      [{ t: "x", est: 0 }],
      [{ t: "윗단", sub: Array.from({ length: 50 }, (_, i) => `아랫단 ${i}`) }],
      [{ est: 5 }],
      [{ t: "x", sub: [1] }],
    ])
      await fails(mk(c), "23514");
  });
});

describe("ez_tasks_roll — 단계 틀 · 작업대에 올리기 · 손댄 지난 회차 보호", () => {
  const DAILY = J({ freq: "daily" });
  const rule = async (who: string, extra: { checklist?: unknown; bench?: boolean } = {}) =>
    (
      await sql(who, "insert into ez_task_rules (kind, title, repeat, start, checklist, bench) values ('cycle', '복습', $1, '2026-10-05', $2, $3) returning id", [
        DAILY,
        J(extra.checklist ?? []),
        extra.bench ?? false,
      ])
    )[0]!.id as string;
  const roll = (who: string, today: string) => sql(who, "select ez_tasks_roll($1, 600) n", [today]).then((r) => r[0]!.n as number);
  const made = (ruleId: string) =>
    sql("admin", "select id, rule_date::text as rule_date, deleted_at, bench_order, checklist from ez_tasks where rule_id = $1 order by rule_date", [ruleId]);
  const alive = async (ruleId: string) => (await made(ruleId)).filter((t) => t.deleted_at === null).map((t) => t.rule_date);

  it("규칙의 bench 는 기본 꺼짐. 새 회차의 단계는 틀에서 (아랫단 · 걸릴 시간 포함, 전부 안 끝남)", async () => {
    const a = user();
    const r = await rule(a, { checklist: ["읽기", { t: "정리", est: 20, sub: ["1장", { t: "2장", est: 15 }] }] });
    expect((await sql("admin", "select bench from ez_task_rules where id = $1", [r]))[0]!.bench).toBe(false);
    expect(await roll(a, "2026-10-05")).toBe(1);
    const [t] = await made(r);
    expect(t!.bench_order).toBeNull();
    expect(t!.checklist).toEqual([
      { t: "읽기", done: false },
      { t: "정리", done: false, est: 20, sub: [{ t: "1장", done: false }, { t: "2장", done: false, est: 15 }] },
    ]);
  });

  it("bench 가 켜진 규칙의 회차는 작업대 맨 뒤에 올라간 채 생긴다", async () => {
    const a = user();
    const x = await task(a);
    await sql(a, "select ez_task_bench($1, true)", [x]);
    const r = await rule(a, { bench: true });
    await roll(a, "2026-10-05");
    expect((await made(r))[0]!.bench_order).toBe(2);
  });

  it("밀린 지난 회차는 지우되, 작업대에 올라가 있거나 시간 기록이 있으면 남긴다", async () => {
    const a = user();
    // 손 안 댄 것: 지워진다 (0008 그대로)
    const plain = await rule(a);
    await roll(a, "2026-10-05");
    await roll(a, "2026-10-06");
    expect(await alive(plain)).toEqual(["2026-10-06"]);

    // 작업대에 올라간 것: 남는다
    const b = user();
    const onBench = await rule(b);
    await roll(b, "2026-10-05");
    await sql(b, "select ez_task_bench($1, true)", [(await made(onBench))[0]!.id]);
    expect(await roll(b, "2026-10-06")).toBe(1);
    expect(await alive(onBench)).toEqual(["2026-10-05", "2026-10-06"]);

    // 시간 기록이 있는 것: 남는다 (닫힌 구간이어도)
    const c = user();
    const logged = await rule(c);
    await roll(c, "2026-10-05");
    await start(c, (await made(logged))[0]!.id);
    await stop(c);
    expect(await roll(c, "2026-10-06")).toBe(1);
    expect(await alive(logged)).toEqual(["2026-10-05", "2026-10-06"]);
    // 남은 것을 작업대에서 내리고 기록도 없으면 다음에 지워진다 — 기록은 남으니 이 회차는 계속 남는다
    expect(await roll(c, "2026-10-07")).toBe(1);
    expect(await alive(logged)).toEqual(["2026-10-05", "2026-10-07"]);
  });

  it("멈춘(paused) 규칙은 회차를 안 만든다. 다시 켜면 가장 최근 회차 하나 (기본은 안 멈춤)", async () => {
    const a = user();
    const r = await rule(a);
    expect((await sql("admin", "select paused from ez_task_rules where id = $1", [r]))[0]!.paused).toBe(false);
    await sql(a, "update ez_task_rules set paused = true where id = $1", [r]);
    expect(await roll(a, "2026-10-07")).toBe(0);
    expect(await made(r)).toEqual([]);
    await sql(a, "update ez_task_rules set paused = false where id = $1", [r]);
    expect(await roll(a, "2026-10-09")).toBe(1);
    expect(await alive(r)).toEqual(["2026-10-09"]);
  });

  it("bench 규칙: 올라간 지난 회차와 새 회차가 같이 있다", async () => {
    const a = user();
    const r = await rule(a, { bench: true });
    await roll(a, "2026-10-05");
    await roll(a, "2026-10-06");
    const rows = (await made(r)).filter((t) => t.deleted_at === null);
    expect(rows.map((t) => [t.rule_date, t.bench_order])).toEqual([
      ["2026-10-05", 1],
      ["2026-10-06", 2],
    ]);
  });
});
