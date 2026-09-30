// 0004 (사진 블록 · 사진 저장소 정책 · 휴지통 자동 비우기)를 PGlite 에서 0001~0003 위에 돌려 본다.
// storage 는 db/testing.ts 의 흉내(버킷·objects 테이블·foldername)라 정책(RLS)만 시험한다. 파일 내용·용량 검사는 진짜 Storage 몫.
// pg_cron 은 PGlite 에 없어 확장·일정 부분은 건너뛴다 — ez_purge_trash 만 시험한다.

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { editRule } from "../lib/blocks";
import { sampleBlocks } from "../lib/fixtures";
import { forPglite, migrations, SUPABASE_STUB } from "./testing";

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

async function fails(p: Promise<unknown>, code: string): Promise<void> {
  const e: any = await p.then(
    () => null,
    (err) => err,
  );
  expect(e, `${code} 로 실패해야 합니다`).not.toBeNull();
  if (code.startsWith("EZ_")) {
    expect(e.code).toBe("P0001");
    expect(e.message).toMatch(new RegExp(`^\\[${code}\\] \\S`));
  } else expect(e.code, e.message).toBe(code);
}

const user = () => randomUUID();
const hex = (c: string) => c.repeat(64);
const src = (owner: string, c = "a") => `${owner}/${hex(c)}.webp`;

function image(s: string, extra: Record<string, unknown> = {}) {
  return { type: "image", src: s, w: 800, h: 600, alt: "설명", caption: "캡션", place: "right", size: "1/2", credit: "직접 캡처", local_path: "C:/Users/PC/Pictures/비밀 폴더/a.png", ...extra };
}

async function folder(who: string, name: string, parent: string | null = null): Promise<string> {
  const r = await sql(who, "insert into ez_items (kind, name, parent_id) values ('folder', $1, $2) returning id", [name, parent]);
  return r[0]!.id;
}
async function report(who: string, name: string, blocks: unknown[], parent: string | null = null): Promise<string> {
  const r = await sql(
    who,
    "insert into ez_items (kind, name, parent_id, report_kind, blocks, agent, agent_updated_at) values ('report', $1, $2, 'data', $3, 'Claude Code', now()) returning id",
    [name, parent, JSON.stringify(blocks)],
  );
  return r[0]!.id;
}
const share = async (who: string, id: string) => (await sql(who, "select ez_share($1) t", [id]))[0]!.t as string;

// ---------------------------------------------------------------------------

describe("0004 파일", () => {
  it("pg_cron 부분: Supabase 권장 방식으로 설치하고 매일 한 번 ez_purge_trash(14). PGlite 에서는 뺀다", () => {
    const text = readFileSync(new URL("./migrations/0004_ez_images.sql", import.meta.url), "utf8");
    expect(text).toContain("create extension if not exists pg_cron with schema pg_catalog;");
    expect(text).toContain("select cron.schedule('ez-purge-trash', '17 3 * * *', 'select public.ez_purge_trash(14)');");
    const stripped = forPglite(text);
    expect(stripped).not.toMatch(/create extension|cron\.|schema cron/);
    expect(stripped).toContain("ez_purge_trash(p_days int default 14)");
  });
});

describe("사람이 고칠 수 있는 칸 (사진)", () => {
  it("DB ez_edit_rule 이 lib editRule 과 같다 — alt·caption 만", async () => {
    const blocks = [...sampleBlocks(), image(src(user()), { ref: 1 })];
    const paths: (string | number)[][] = [];
    const walk = (node: unknown, path: (string | number)[]) => {
      paths.push(path);
      if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    };
    walk(blocks, []);
    let allowed = 0;
    for (const p of paths) {
      const lib = editRule(blocks, p);
      const [r] = await sql("admin", "select * from ez_edit_rule($1, $2)", [JSON.stringify(blocks), p.map(String)]);
      expect({ max_length: r!.max_length, one_line: r!.one_line }, JSON.stringify(p)).toEqual({
        max_length: lib?.maxLength ?? null,
        one_line: lib?.oneLine ?? false,
      });
      if (p[0] === 7 && lib) allowed++;
    }
    expect(allowed).toBe(2);
  });

  it("ez_edit_text: alt·caption 은 고치고 src·place·local_path 는 EZ_PATH", async () => {
    const a = user();
    const id = await report(a, "사진", [image(src(a))]);
    const [v] = await sql(a, "select ez_edit_text($1, 1, '{0,alt}', '새 설명') v", [id]);
    expect(v!.v).toBe(2);
    await sql(a, "select ez_edit_text($1, 2, '{0,caption}', '새 캡션')", [id]);
    for (const k of ["src", "place", "size", "credit", "local_path", "w"]) {
      await fails(sql(a, `select ez_edit_text($1, 3, '{0,${k}}', 'x')`, [id]), "EZ_PATH");
    }
    await fails(sql(a, "select ez_edit_text($1, 3, '{0,alt}', E'두\\n줄')", [id]), "EZ_VALUE");
    const [row] = await sql("admin", "select blocks from ez_items where id = $1", [id]);
    expect(row!.blocks[0]).toMatchObject({ alt: "새 설명", caption: "새 캡션", place: "right" });
  });
});

describe("공유 페이지에는 local_path 를 싣지 않는다", () => {
  it("ez_shared 가 image 블록의 local_path 만 빼고, 나머지·순서는 그대로", async () => {
    const a = user();
    const blocks = [{ type: "text", body: "local_path 라는 글자" }, image(src(a)), { type: "unknown", local_path: "그대로" }];
    const id = await report(a, "공유 사진", blocks);
    const t = await share(a, id);
    const [got] = await sql("anon", "select * from ez_shared($1)", [t]);
    expect(Object.keys(got!).sort()).toEqual(["blocks", "name", "report_kind", "schema_version", "updated_at"]);
    const { local_path: _, ...noPath } = image(src(a));
    expect(got!.blocks).toEqual([blocks[0], noPath, blocks[2]]);
    expect(JSON.stringify(got!.blocks)).not.toContain("비밀 폴더");
    // 원본 행은 그대로
    const [row] = await sql("admin", "select blocks from ez_items where id = $1", [id]);
    expect(row!.blocks[1].local_path).toBe("C:/Users/PC/Pictures/비밀 폴더/a.png");
  });

  it("anon 은 여전히 ez_shared 만 부를 수 있다", async () => {
    await fails(sql("anon", "select ez_image_srcs(null)"), "42501");
    await fails(sql("anon", "select ez_purge_trash(0)"), "42501");
  });
});

describe("찾기", () => {
  it("사진의 alt·caption·credit 은 찾고 src·place·size·local_path 는 안 찾는다", async () => {
    const a = user();
    await report(a, "사진 보고서", [image(src(a, "b"), { alt: "고양이 사진", caption: "창가의 오후", credit: "직접 촬영함" })]);
    const q = async (s: string) => (await sql(a, "select name, match from ez_search($1)", [s])).map((r) => r.match);
    expect(await q("고양이")).toEqual(["body"]);
    expect(await q("창가의")).toEqual(["body"]);
    expect(await q("촬영함")).toEqual(["body"]);
    for (const s of ["bbbbbbbb", ".webp", "right", "1/2", "비밀 폴더", "Pictures"]) expect(await q(s), s).toEqual([]);
  });
});

describe("사진 저장소 정책 (storage.objects)", () => {
  const put = (who: string, name: string, bucket = "ez-images") =>
    sql(who, "insert into storage.objects (bucket_id, name) values ($1, $2) returning name", [bucket, name]);
  const see = async (who: string, name: string) =>
    (await sql(who, "select name from storage.objects where bucket_id = 'ez-images' and name = $1", [name])).length === 1;

  it("버킷: 비공개 · WebP 만 · 512,000바이트", async () => {
    const [b] = await sql("admin", "select * from storage.buckets where id = 'ez-images'");
    expect(b).toMatchObject({ name: "ez-images", public: false, allowed_mime_types: ["image/webp"] });
    expect(Number(b!.file_size_limit)).toBe(512000);
  });

  it("다시 넣어도(on conflict) 설정이 맞춰진다", async () => {
    await sql("admin", "update storage.buckets set public = true, file_size_limit = 1, allowed_mime_types = '{image/png}' where id = 'ez-images'");
    const text = readFileSync(new URL("./migrations/0004_ez_images.sql", import.meta.url), "utf8");
    const insert = /insert into storage\.buckets[\s\S]*?;/.exec(text)![0];
    await sql("admin", insert);
    const [b] = await sql("admin", "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'ez-images'");
    expect(b).toMatchObject({ public: false, allowed_mime_types: ["image/webp"] });
    expect(Number(b!.file_size_limit)).toBe(512000);
  });

  it("로그인한 사람: 첫 폴더가 자기 uid 인 것만 올리기·읽기·지우기", async () => {
    const a = user();
    const b = user();
    await put(a, src(a, "1"));
    await fails(put(a, src(b, "1")), "42501");
    await fails(put(a, `${hex("2")}.webp`), "42501"); // 폴더 없이 맨 위
    await fails(put(a, src(a, "3"), "other"), "42501"); // 다른 버킷
    expect(await see(a, src(a, "1"))).toBe(true);
    expect(await see(b, src(a, "1"))).toBe(false);
    // 남의 것은 지워지지 않는다 (보이지 않으므로 0행)
    expect(await sql(b, "delete from storage.objects where name = $1 returning name", [src(a, "1")])).toEqual([]);
    expect(await see(a, src(a, "1"))).toBe(true);
    // 고치기(덮어쓰기) 정책은 없다
    expect(await sql(a, "update storage.objects set metadata = '{}' where name = $1 returning name", [src(a, "1")])).toEqual([]);
    expect(await sql(a, "delete from storage.objects where name = $1 returning name", [src(a, "1")])).toHaveLength(1);
  });

  it("anon: 공유 켜진 살아 있는 보고서가 쓰는 사진만 읽는다. 올리기·지우기 없음", async () => {
    const a = user();
    const p = src(a, "4");
    const other = src(a, "5");
    await put("service", p);
    await put("service", other);
    const id = await report(a, "공유할 사진", [image(p)]);
    expect(await see("anon", p)).toBe(false); // 공유 전

    await share(a, id);
    expect(await see("anon", p)).toBe(true);
    expect(await see("anon", other)).toBe(false); // 보고서가 안 쓰는 사진
    expect(await sql("anon", "select name from storage.objects where bucket_id = 'ez-images'")).toEqual([{ name: p }]);
    await fails(put("anon", src(a, "6")), "42501");
    expect(await sql("anon", "delete from storage.objects where name = $1 returning name", [p])).toEqual([]);

    await sql(a, "select ez_unshare($1)", [id]);
    expect(await see("anon", p)).toBe(false);
    await share(a, id);
    await sql(a, "select ez_delete($1)", [id]);
    expect(await see("anon", p)).toBe(false); // 휴지통
  });

  it("anon: 남의 사진 경로를 내 공유 보고서에 적어도 못 본다", async () => {
    const a = user();
    const b = user();
    const theirs = src(a, "7");
    await put("service", theirs);
    const mine = await report(b, "남의 사진 경로", [image(theirs)]);
    await share(b, mine);
    expect(await see("anon", theirs)).toBe(false);
  });

  it("ez_image_srcs: 주인의 보고서(휴지통 포함)가 쓰는 경로만, service_role 대리", async () => {
    const a = user();
    const r1 = await report(a, "살아 있음", [image(src(a, "8")), image(src(a, "8")), { type: "text", body: "x" }]);
    const r2 = await report(a, "지울 것", [image(src(a, "9"))]);
    await report(user(), "남의 것", [image(src(a, "c"))]);
    await sql(a, "select ez_delete($1)", [r2]);
    const rows = await sql("service", "select s from ez_image_srcs($1) s", [a]);
    expect(rows.map((r) => r.s).sort()).toEqual([src(a, "8"), src(a, "9")]);
    expect(r1).toBeTruthy();
    await fails(sql(a, "select ez_image_srcs(null)"), "42501");
  });
});

describe("휴지통 자동 비우기 ez_purge_trash", () => {
  /** 묶음을 n일 전에 지운 것으로 */
  const age = (batch: string, days: number) =>
    sql("admin", "update ez_items set deleted_at = now() - make_interval(days => $2) where deleted_batch = $1", [batch, days]);
  const exists = async (id: string) => (await sql("admin", "select 1 from ez_items where id = $1", [id])).length === 1;
  const purge = async (days?: number) =>
    (await sql("service", days === undefined ? "select ez_purge_trash() n" : "select ez_purge_trash($1) n", days === undefined ? [] : [days]))[0]!.n as number;

  it("14일 지난 묶음만, 폴더 안까지 깊은 것부터 영구 삭제. 지운 행 수", async () => {
    await purge(); // 앞 시험들이 남긴 오래된 것 없음 확인용
    const a = user();
    const top = await folder(a, "오래된 폴더");
    const mid = await folder(a, "가운데", top);
    const low = await folder(a, "깊은 곳", mid);
    const r1 = await report(a, "깊은 보고서", sampleBlocks(), low);
    const r2 = await report(a, "가운데 보고서", sampleBlocks(), mid);
    const [{ b: old }] = (await sql(a, "select ez_delete($1) b", [top])) as [Row];
    await age(old.toString(), 15);

    const fresh = await report(a, "최근에 지움", sampleBlocks());
    const [{ b: recent }] = (await sql(a, "select ez_delete($1) b", [fresh])) as [Row];
    await age(recent.toString(), 13);
    const alive = await report(a, "살아 있음", sampleBlocks());

    expect(await purge()).toBe(5);
    for (const id of [top, mid, low, r1, r2]) expect(await exists(id)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(alive)).toBe(true);
    expect(await purge(14)).toBe(0);
    // 기준을 줄이면 최근 것도
    expect(await purge(13)).toBe(1);
    expect(await exists(fresh)).toBe(false);
  });

  it("묶음의 지운 때는 가장 늦은 deleted_at — 안에 아직 안 지난 묶음이 있으면 그 폴더는 다음으로", async () => {
    const a = user();
    const f = await folder(a, "폴더");
    const inner = await report(a, "안", sampleBlocks(), f);
    // 안의 것을 먼저(20일 전) 지우고, 폴더는 나중(20일 전 → 실제로는 5일 전)에
    const [{ b: b1 }] = (await sql(a, "select ez_delete($1) b", [inner])) as [Row];
    const [{ b: b2 }] = (await sql(a, "select ez_delete($1) b", [f])) as [Row];
    await age(b1.toString(), 5);
    await age(b2.toString(), 20);
    // 폴더 묶음은 지났지만 안의 행(다른 묶음)이 아직 남아 → 폴더는 남는다 (외래키를 어기지 않는다)
    expect(await purge()).toBe(0);
    expect(await exists(f)).toBe(true);
    await age(b1.toString(), 30);
    expect(await purge()).toBe(2);
  });

  it("살아 있는 것·휴지통이 아닌 것은 안 건드린다. p_days 는 0 이상", async () => {
    const a = user();
    const f = await folder(a, "살아 있는 폴더");
    await report(a, "살아 있는 보고서", sampleBlocks(), f);
    expect(await purge(0)).toBeGreaterThanOrEqual(0);
    expect(await exists(f)).toBe(true);
    await fails(sql("service", "select ez_purge_trash(-1)"), "EZ_VALUE");
    await fails(sql("service", "select ez_purge_trash(null)"), "EZ_VALUE");
  });

  it("실행 권한: postgres·service_role 만", async () => {
    await fails(sql(user(), "select ez_purge_trash(14)"), "42501");
    await fails(sql("anon", "select ez_purge_trash(14)"), "42501");
    expect(typeof (await purge(14))).toBe("number");
  });
});
