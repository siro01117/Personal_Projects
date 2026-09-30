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
import { EDGE_BAND, EDGE_DARK, EDGE_LIGHT, edgeLuminance, edgeOf, IMAGE_MAX_BYTES, prepareImage, purgeImages } from "./images";
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

// ---------------------------------------------------------------------------

/** 왼쪽 절반 빨강, 오른쪽 절반 파랑 */
async function halves(w: number, h: number, file: string) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[(y * w + x) * 3 + (x < w / 2 ? 0 : 2)] = 255;
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(file);
  return file;
}

/** 가운데 색 (r,g,b) */
async function centerColor(bytes: Uint8Array): Promise<number[]> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

/** 화면 캡처 흉내: 바탕색 위에 글줄·상자. 글줄 하나는 가장자리 띠에 걸친다 */
async function capture(file: string, bg: string, ink: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">
    <rect width="1440" height="900" fill="${bg}"/>
    <rect x="12" y="10" width="220" height="16" rx="3" fill="${ink}"/>
    <rect x="160" y="140" width="520" height="22" rx="4" fill="${ink}"/>
    <rect x="160" y="190" width="760" height="14" rx="4" fill="${ink}"/>
    <rect x="160" y="220" width="700" height="14" rx="4" fill="${ink}"/>
    <rect x="160" y="300" width="1100" height="420" rx="12" fill="${ink}" opacity=".35"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

describe("crop — 보여줄 부분만 잘라 올린다", () => {
  it("원본 픽셀 기준으로 먼저 자르고, 그다음 긴 변 1280 규칙", async () => {
    const f = await halves(4000, 2000, join(dir, "halves.png"));
    const right = await prepareImage(f, { x: 2000, y: 0, w: 2000, h: 2000 });
    expect([right.width, right.height]).toEqual([1280, 1280]);
    expect(await centerColor(right.bytes)).toEqual([0, 0, 255].map((v) => expect.closeTo(v, -1.5)));
    const left = await prepareImage(f, { x: 100, y: 500, w: 1500, h: 600 });
    expect([left.width, left.height]).toEqual([1280, 512]);
    const [r, , b] = await centerColor(left.bytes);
    expect(r).toBeGreaterThan(200);
    expect(b).toBeLessThan(40);
  });

  it("자른 뒤 작으면 늘리지 않는다", async () => {
    const f = await halves(3000, 2000, join(dir, "halves-small.png"));
    const img = await prepareImage(f, { x: 10, y: 20, w: 200, h: 100 });
    expect([img.width, img.height]).toEqual([200, 100]);
  });

  it("좌표는 방향(EXIF)을 반영한 모양 기준", async () => {
    // 저장은 400×200(왼쪽 빨강·오른쪽 파랑), 90도 돌려 보이면 200×400 — 위 빨강 · 아래 파랑
    const raw = Buffer.alloc(400 * 200 * 3);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 400; x++) raw[(y * 400 + x) * 3 + (x < 200 ? 0 : 2)] = 255;
    const f = join(dir, "turned.jpg");
    await sharp(raw, { raw: { width: 400, height: 200, channels: 3 } }).jpeg().withMetadata({ orientation: 6 }).toFile(f);
    const bottom = await prepareImage(f, { x: 0, y: 300, w: 200, h: 100 });
    expect([bottom.width, bottom.height]).toEqual([200, 100]);
    const [r, , b] = await centerColor(bottom.bytes);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(40);
    const err = await prepareImage(f, { x: 0, y: 0, w: 400, h: 100 }).catch((e: Error) => e.message);
    expect(err).toMatch(/^crop 이 사진 밖으로 나갑니다 \(사진 200×400,/);
  });

  it("사진 밖 · 모양 틀림은 한국어 오류. 원래 파일은 그대로", async () => {
    const f = await halves(800, 600, join(dir, "crop-err.png"));
    const before = sha(readFileSync(f));
    const err = (c: unknown) => prepareImage(f, c).then(() => "통과", (e: Error) => e.message);
    expect(await err({ x: 700, y: 0, w: 200, h: 100 })).toBe(
      "crop 이 사진 밖으로 나갑니다 (사진 800×600, 자를 곳 x 700~900 · y 0~100) — 원본 픽셀 기준으로 주세요",
    );
    expect(await err({ x: 0, y: 0, w: 800, h: 601 })).toMatch(/^crop 이 사진 밖으로 나갑니다/);
    expect(await err({ x: 0, y: 0, w: 800, h: 600 })).toBe("통과");
    expect(await err({ x: -1, y: 0, w: 10, h: 10 })).toBe("crop.x 는 0 이상입니다");
    expect(await err({ x: 0, y: 0, w: 0, h: 10 })).toBe("crop.w 는 1 이상입니다");
    expect(await err({ x: 0, y: 0, w: 10.5, h: 10 })).toBe("crop.w 는 정수(픽셀)여야 합니다");
    expect(await err({ x: 0, y: 0, w: 10 })).toBe("crop.h 가 빠졌습니다 — x, y, w, h 를 모두 주세요");
    expect(await err({ x: 0, y: 0, w: 10, h: 10, left: 1 })).toBe("crop 에 모르는 칸이 있습니다: left — x, y, w, h 만 씁니다");
    expect(await err([0, 0, 10, 10])).toBe("crop 은 {x, y, w, h} 객체입니다 (원본 픽셀, 정수)");
    expect(sha(readFileSync(f))).toBe(before);
  });

  it("MCP: crop 은 저장하지 않고 잘린 사진만 올린다. 오류 자리는 .crop", async () => {
    const { store, drawer } = setup();
    const f = await halves(2400, 1200, join(dir, "mcp-crop.png"));
    const block = (crop: unknown) => ({ type: "image", file: f, crop, alt: "오른쪽만", place: "full", credit: "직접 캡처" });
    const r = good(await drawer.report_create({ title: "자름", kind: "data", folder: "/", blocks: [block({ x: 1200, y: 0, w: 1200, h: 600 })] }));
    const [img] = await blocksOf(r.id);
    expect(img).toMatchObject({ w: 1200, h: 600, local_path: f.replace(/\\/g, "/") });
    expect(img).not.toHaveProperty("crop");
    expect(await centerColor(store.images.get(img.src)!.bytes)).toEqual([0, 0, 255].map((v) => expect.closeTo(v, -1.5)));

    const d = bad(await drawer.report_create({ title: "밖", kind: "data", folder: "/", blocks: [block({ x: 0, y: 0, w: 2401, h: 10 })] }), "INVALID_BLOCKS");
    expect(d.errors).toEqual([{ path: "blocks[0].crop", message: expect.stringMatching(/^crop 이 사진 밖으로 나갑니다/) }]);

    // file 없이 crop (이미 올린 사진은 못 자른다)
    const e = bad(
      await drawer.report_edit({ id: r.id, base_version: 1, ops: [{ op: "replace", at: 0, block: { ...img, crop: { x: 0, y: 0, w: 10, h: 10 } } }] }),
      "INVALID_BLOCKS",
    );
    expect(e.errors).toEqual([{ path: "ops[0].block.crop", message: "crop 은 file 과 같이 줄 때만 씁니다 — 이미 올린 사진(src)은 자를 수 없습니다" }]);
  });
});

describe("edge — 가장자리 밝기", () => {
  it("흰 바탕 캡처는 light, 검은 바탕 캡처는 dark", async () => {
    const white = await prepareImage(await capture(join(dir, "cap-white.png"), "#ffffff", "#161619"));
    expect(white.edge).toBe("light");
    const soft = await prepareImage(await capture(join(dir, "cap-soft.png"), "#f4f4f6", "#46464d"));
    expect(soft.edge).toBe("light");
    const black = await prepareImage(await capture(join(dir, "cap-black.png"), "#0f0f12", "#f3f3f6"));
    expect(black.edge).toBe("dark");
    const dim = await prepareImage(await capture(join(dir, "cap-dim.png"), "#17171b", "#c3c3cb"));
    expect(dim.edge).toBe("dark");
  });

  it("사진류 · 중간 밝기 · 반반 · 투명은 없음", async () => {
    // 잡음(사진처럼 섞인 색), 회색 바탕, 왼쪽 검정 + 오른쪽 흰색
    expect((await prepareImage(await noise(600, 400, join(dir, "edge-noise.png")))).edge).toBeUndefined();
    expect((await prepareImage(await capture(join(dir, "cap-gray.png"), "#808080", "#ffffff"))).edge).toBeUndefined();
    const split = join(dir, "edge-split.png");
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#fff"/><rect width="400" height="400" fill="#000"/></svg>`))
      .png()
      .toFile(split);
    expect((await prepareImage(split)).edge).toBeUndefined();
    const clear = join(dir, "edge-clear.png");
    await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toFile(clear);
    expect((await prepareImage(clear)).edge).toBeUndefined();
    // 풍경 그림처럼 가장자리가 어둑한 중간 톤
    expect((await prepareImage(await solid(500, 300, join(dir, "edge-mid.png"), { r: 90, g: 110, b: 80 }))).edge).toBeUndefined();
  });

  it("기준값: 띠 평균 휘도 0.8 이상 light, 0.03 이하 dark. 가운데는 안 본다", async () => {
    expect([EDGE_LIGHT, EDGE_DARK, EDGE_BAND]).toEqual([0.8, 0.03, 0.04]);
    expect(edgeOf(0.8)).toBe("light");
    expect(edgeOf(0.79)).toBeUndefined();
    expect(edgeOf(0.03)).toBe("dark");
    expect(edgeOf(0.031)).toBeUndefined();
    expect(edgeOf(null)).toBeUndefined();
    // 흰 테두리 띠 + 가운데 검정: 가운데는 평균에 안 들어간다
    const framed = await sharp(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><rect width="1000" height="500" fill="#fff"/><rect x="60" y="30" width="880" height="440" fill="#000"/></svg>`),
    )
      .png()
      .toBuffer();
    expect(await edgeLuminance(framed)).toBeCloseTo(1, 2);
  });

  it("MCP 가 edge 를 채운다 — 에이전트가 준 값은 버리고 잰 값으로", async () => {
    const { drawer } = setup();
    const w = await capture(join(dir, "mcp-white.png"), "#ffffff", "#161619");
    const n = await noise(300, 200, join(dir, "mcp-noise.png"));
    const r = good(
      await drawer.report_create({
        title: "가장자리",
        kind: "data",
        folder: "/",
        blocks: [
          { type: "image", file: w, alt: "흰 캡처", place: "full", credit: "직접 캡처", edge: "dark" },
          { type: "image", file: n, alt: "잡음", place: "full", credit: "직접 캡처", edge: "light" },
        ],
      }),
    );
    const [a, b] = await blocksOf(r.id);
    expect(a.edge).toBe("light");
    expect(b).not.toHaveProperty("edge");
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
