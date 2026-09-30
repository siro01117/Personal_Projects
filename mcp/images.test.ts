// 사진 전처리(줄이기·WebP·메타데이터 제거·500KB·확대 안 함)와 MCP 도구의 사진 블록(file → src), 주인 없는 사진 치우기.
// 사진 저장소는 PgliteStore 의 메모리 흉내(버킷 규칙: WebP 만 · 512,000바이트).

import type { PGlite } from "@electric-sql/pglite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleBlocks } from "../lib/fixtures";
import { createDrawer, type ToolResult } from "./drawer";
import { IMAGE_MAX_BYTES, prepareImage, purgeImages } from "./images";
import { createTestDb, PgliteStore } from "./store-pglite";

let db: PGlite;
let dir: string;

/** 잡음 사진 — 압축이 잘 안 돼 크기 줄이기를 시험하기 좋다 */
async function noise(w: number, h: number, file: string, format: "png" | "jpeg" = "png") {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (Math.random() * 256) | 0;
  const img = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  await (format === "png" ? img.png({ compressionLevel: 1 }) : img.jpeg({ quality: 95 })).toFile(file);
  return file;
}

async function solid(w: number, h: number, file: string, color = { r: 155, g: 225, b: 93 }) {
  await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toFile(file);
  return file;
}

beforeAll(async () => {
  db = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "ez-images-"));
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("prepareImage", () => {
  it("긴 변 1280px 이하로 줄이고 WebP, 비율 유지", async () => {
    const f = await solid(3000, 2000, join(dir, "big.png"));
    const img = await prepareImage(f);
    expect([img.width, img.height]).toEqual([1280, 853]);
    const meta = await sharp(img.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([1280, 853]);
    expect(img.sha256).toBe(sha(img.bytes));
    expect(img.localPath).toBe(f.replace(/\\/g, "/"));
  });

  it("작은 사진은 늘리지 않는다", async () => {
    const img = await prepareImage(await solid(200, 100, join(dir, "small.png")));
    expect([img.width, img.height]).toEqual([200, 100]);
    expect(img.quality).toBe(80);
  });

  it("세로 사진도 긴 변 기준", async () => {
    const img = await prepareImage(await solid(900, 2400, join(dir, "tall.png")));
    expect([img.width, img.height]).toEqual([480, 1280]);
  });

  it("500KB 를 넘으면 품질을 낮추고, 그래도 넘으면 크기를 줄인다", async () => {
    const f = await noise(2600, 2600, join(dir, "noise.png"));
    const img = await prepareImage(f);
    expect(img.bytes.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect(img.quality).toBeGreaterThanOrEqual(50);
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1280);
    // 잡음은 품질 50 에서도 1280px 이면 500KB 를 넘는다 → 크기를 더 줄였다
    expect(Math.max(img.width, img.height)).toBeLessThan(1280);
  }, 60_000);

  it("EXIF·GPS 는 빼고, 방향(Orientation)은 반영한다", async () => {
    const f = join(dir, "exif.jpg");
    await sharp({ create: { width: 400, height: 200, channels: 3, background: "#888" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Copyright: "my-name-here", Make: "camera-make" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "37/1 33/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "126/1 58/1 0/1" },
      })
      .toFile(f);
    const before = await sharp(f).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);

    const img = await prepareImage(f);
    const meta = await sharp(img.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect([img.width, img.height]).toEqual([200, 400]); // 90도 돌린 모양
    expect(img.bytes.includes(Buffer.from("my-name-here"))).toBe(false);
    expect(img.bytes.includes(Buffer.from("camera-make"))).toBe(false);
    expect(img.bytes.includes(Buffer.from("GPS"))).toBe(false);
  });

  it("PC 의 원래 파일은 그대로", async () => {
    const f = await noise(300, 300, join(dir, "keep.jpg"), "jpeg");
    const before = { hash: sha(readFileSync(f)), mtime: statSync(f).mtimeMs };
    await prepareImage(f);
    expect({ hash: sha(readFileSync(f)), mtime: statSync(f).mtimeMs }).toEqual(before);
  });

  it("같은 사진은 같은 해시", async () => {
    const f = await solid(300, 200, join(dir, "same.png"), { r: 1, g: 2, b: 3 });
    const g = join(dir, "same-copy.png");
    writeFileSync(g, readFileSync(f));
    expect((await prepareImage(f)).sha256).toBe((await prepareImage(g)).sha256);
  });

  it("한국어 오류: 없음 · 폴더 · 사진 아님 · 빈 파일 · 상대 경로", async () => {
    const err = (p: string) => prepareImage(p).then(() => "통과", (e: Error) => e.message);
    expect(await err(join(dir, "없는파일.png"))).toMatch(/^파일이 없습니다: /);
    expect(await err(dir)).toMatch(/^파일이 아니라 폴더입니다: /);
    const txt = join(dir, "note.txt");
    writeFileSync(txt, "사진이 아님");
    expect(await err(txt)).toMatch(/^사진 파일이 아닙니다 /);
    const empty = join(dir, "empty.png");
    writeFileSync(empty, "");
    expect(await err(empty)).toMatch(/^빈 파일입니다: /);
    expect(await err("pictures/a.png")).toMatch(/^file 은 절대 경로로 주세요/);
    expect(await err("")).toMatch(/^file 이 비어 있습니다/);
  });
});

// ---------------------------------------------------------------------------

function good(r: ToolResult): Record<string, any> {
  expect(r.ok, `${r.summary}\n${JSON.stringify(r.data)}`).toBe(true);
  return r.data as Record<string, any>;
}
function bad(r: ToolResult, code: string): Record<string, any> {
  expect(r.ok, `실패해야 합니다: ${r.summary}`).toBe(false);
  expect((r.data as any).error.code).toBe(code);
  return r.data as Record<string, any>;
}

function setup(now?: () => Date) {
  const owner = randomUUID();
  const store = new PgliteStore(db, owner, now);
  const drawer = createDrawer({ store, agent: "Claude Code" });
  return { owner, store, drawer };
}

const blocksOf = async (id: string) => (await db.query<{ blocks: any[] }>("select blocks from ez_items where id = $1", [id])).rows[0]!.blocks;

describe("report_create · report_edit 의 사진 블록", () => {
  it("file → 줄여 올리고 src·w·h·local_path 를 채운다. 원본은 올리지 않는다", async () => {
    const { owner, store, drawer } = setup();
    good(await drawer.drawer_mkdir({ path: "/사진" }));
    const f = await solid(2000, 1000, join(dir, "화면 캡처.png"));
    const r = good(
      await drawer.report_create({
        title: "사진 보고서",
        kind: "reference",
        folder: "/사진",
        blocks: [...sampleBlocks(), { type: "image", file: f, alt: "첫 화면", place: "left", size: "1/3", ref: 1 }],
      }),
    );
    expect(r.images).toEqual({ count: 1, uploaded: 1 });
    const img = (await blocksOf(r.id))[7];
    expect(img).toMatchObject({ type: "image", w: 1280, h: 640, alt: "첫 화면", place: "left", size: "1/3", ref: 1, local_path: f.replace(/\\/g, "/") });
    expect(img).not.toHaveProperty("file");
    expect(img.src).toMatch(new RegExp(`^${owner}/[0-9a-f]{64}\\.webp$`));
    const stored = store.images.get(img.src)!;
    expect(stored.bytes.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect((await sharp(stored.bytes).metadata()).format).toBe("webp");
    expect(store.images.size).toBe(1);
  });

  it("같은 사진은 한 번만 올리고 다시 쓴다 (같은 보고서 안 · 다른 보고서)", async () => {
    const { store, drawer } = setup();
    const f = await solid(640, 480, join(dir, "reuse.png"), { r: 10, g: 20, b: 30 });
    const g = join(dir, "reuse-other-name.png");
    writeFileSync(g, readFileSync(f));
    const block = (file: string) => ({ type: "image", file, alt: "같은 사진", place: "full", credit: "직접 캡처" });
    const a = good(await drawer.report_create({ title: "하나", kind: "data", folder: "/", blocks: [block(f), block(g)] }));
    expect(a.images).toEqual({ count: 1, uploaded: 1 });
    const b = good(await drawer.report_create({ title: "둘", kind: "data", folder: "/", blocks: [block(f)] }));
    expect(b.images).toEqual({ count: 1, uploaded: 0 });
    expect(store.uploads).toBe(1);
    const [x, y] = await blocksOf(a.id);
    expect(x.src).toBe(y.src);
    expect(x.local_path).not.toBe(y.local_path); // 경로는 각자 읽은 파일
  });

  it("블록 검사가 틀리면 올리지 않는다. 사진 오류는 자리와 이유로", async () => {
    const { store, drawer } = setup();
    const f = await solid(300, 300, join(dir, "invalid.png"));
    const d = bad(
      await drawer.report_create({
        title: "틀림",
        kind: "data",
        folder: "/",
        blocks: [
          { type: "image", file: f, alt: "출처 번호 틀림", place: "left", ref: 5 },
          { type: "image", file: join(dir, "없음.png"), alt: "x", place: "full", credit: "c" },
          { type: "image", file: f, src: "x", w: 1, h: 1, alt: "x", place: "full", credit: "c" },
        ],
      }),
      "INVALID_BLOCKS",
    );
    expect(d.errors).toEqual([
      { path: "blocks[1].file", message: expect.stringMatching(/^파일이 없습니다: /) },
      { path: "blocks[2].file", message: "file 과 src 는 같이 줄 수 없습니다 — PC 사진이면 file 만" },
      { path: "blocks[2].src", message: expect.stringContaining("src 는 서랍에 올린 사진 경로") },
      { path: "blocks[0].ref", message: "출처 블록이 없는데 출처 5번을 가리킵니다" },
    ]);
    expect(store.images.size).toBe(0);
  });

  it("src 를 직접 주면 이 서랍에 있는 사진이어야 한다", async () => {
    const { owner, drawer } = setup();
    const other = setup();
    const f = await solid(100, 100, join(dir, "theirs.png"), { r: 99, g: 1, b: 1 });
    const t = good(await other.drawer.report_create({ title: "남", kind: "data", folder: "/", blocks: [{ type: "image", file: f, alt: "a", place: "full", credit: "c" }] }));
    const theirSrc = (await blocksOf(t.id))[0].src as string;
    const block = (src: string) => ({ type: "image", src, w: 100, h: 100, alt: "a", place: "full", credit: "c" });
    const d = bad(await drawer.report_create({ title: "x", kind: "data", folder: "/", blocks: [block(theirSrc), block(`${owner}/${"e".repeat(64)}.webp`)] }), "INVALID_BLOCKS");
    expect(d.errors.map((e: any) => e.path)).toEqual(["blocks[0].src", "blocks[1].src"]);

    // 내 서랍에 있는 사진은 src 로 다시 쓸 수 있다 (report_get 으로 읽은 블록 옮기기)
    const mine = good(await drawer.report_create({ title: "내 것", kind: "data", folder: "/", blocks: [{ type: "image", file: f, alt: "a", place: "full", credit: "c" }] }));
    const mySrc = (await blocksOf(mine.id))[0].src;
    good(await drawer.report_create({ title: "다시 씀", kind: "data", folder: "/", blocks: [block(mySrc)] }));
  });

  it("report_edit 도 file 을 받는다. 오류 자리는 ops[k].block", async () => {
    const { store, drawer } = setup();
    const r = good(await drawer.report_create({ title: "고칠 것", kind: "data", folder: "/", blocks: sampleBlocks() }));
    const f = await solid(1600, 900, join(dir, "edit.png"), { r: 7, g: 7, b: 7 });
    const e = good(
      await drawer.report_edit({
        id: r.id,
        base_version: 1,
        ops: [
          { op: "insert", at: 1, block: { type: "image", file: f, alt: "편집으로 넣음", place: "right", size: "1/2", ref: 2 } },
          { op: "remove", at: 3 },
        ],
      }),
    );
    expect(e.images).toEqual({ count: 1, uploaded: 1 });
    const blocks = await blocksOf(r.id);
    expect(blocks[1]).toMatchObject({ type: "image", w: 1280, h: 720, ref: 2 });
    expect(store.images.has(blocks[1].src)).toBe(true);

    const d = bad(
      await drawer.report_edit({ id: r.id, base_version: e.version, ops: [{ op: "replace", at: 0, block: { type: "image", file: join(dir, "nope.png"), alt: "a", place: "full", credit: "c" } }] }),
      "INVALID_BLOCKS",
    );
    expect(d.errors[0].path).toBe("ops[0].block.file");
    // 결과가 검사에서 틀리면(출처 번호 범위 밖) 올리지 않는다
    const g = await solid(120, 120, join(dir, "edit2.png"), { r: 8, g: 8, b: 8 });
    const before = store.images.size;
    bad(
      await drawer.report_edit({ id: r.id, base_version: e.version, ops: [{ op: "insert", at: 0, block: { type: "image", file: g, alt: "a", place: "full", ref: 9 } }] }),
      "INVALID_BLOCKS",
    );
    expect(store.images.size).toBe(before);
  });
});

describe("주인 없는 사진 치우기", () => {
  it("어느 보고서(휴지통 포함)에도 안 쓰이고 올린 지 14일 넘은 것만 지운다", async () => {
    let clock = new Date("2026-09-01T00:00:00Z");
    const { owner, store, drawer } = setup(() => clock);
    const pic = async (name: string, c: number) => solid(64, 64, join(dir, name), { r: c, g: c, b: c });
    const block = (file: string) => ({ type: "image", file, alt: "a", place: "full", credit: "c" });

    const live = good(await drawer.report_create({ title: "살아 있음", kind: "data", folder: "/", blocks: [block(await pic("p1.png", 1))] }));
    const trashed = good(await drawer.report_create({ title: "휴지통", kind: "data", folder: "/", blocks: [block(await pic("p2.png", 2))] }));
    good(await drawer.drawer_update({ target: trashed.id, delete: true }));
    // 올렸지만 보고서에 안 들어간 사진 (예: 올린 뒤 실패) — 오래된 것과 최근 것
    const orphanOld = `${owner}/${"1".repeat(64)}.webp`;
    const orphanNew = `${owner}/${"2".repeat(64)}.webp`;
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).webp().toBuffer();
    await store.uploadImage(orphanOld, webp);
    clock = new Date("2026-09-20T00:00:00Z");
    await store.uploadImage(orphanNew, webp);

    const now = new Date("2026-09-30T00:00:00Z");
    const gone = await purgeImages(store, { now });
    expect(gone).toEqual([orphanOld]);
    expect(store.images.size).toBe(3);
    const used = [(await blocksOf(live.id))[0].src, (await blocksOf(trashed.id))[0].src];
    for (const s of used) expect(store.images.has(s)).toBe(true);

    // 휴지통 보고서가 영구 삭제되면 그 사진도 다음 번에 치워진다
    await db.query("update ez_items set deleted_at = now() - interval '15 days' where id = $1", [trashed.id]);
    await db.query("select ez_purge_trash(14)");
    expect(await purgeImages(store, { now })).toEqual([used[1]]);
    expect(await purgeImages(store, { now })).toEqual([]);
  });

  it("버킷 규칙 흉내: WebP 아님 · 500KB 넘음은 거절", async () => {
    const { owner, store } = setup();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
    await expect(store.uploadImage(`${owner}/${"3".repeat(64)}.webp`, png)).rejects.toThrow(/WebP 만/);
    const big = Buffer.concat([Buffer.from("RIFF0000WEBP"), Buffer.alloc(IMAGE_MAX_BYTES)]);
    await expect(store.uploadImage(`${owner}/${"4".repeat(64)}.webp`, big)).rejects.toThrow(/500KB/);
  });
});
