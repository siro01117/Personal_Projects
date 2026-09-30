// 사진 블록 (설계서 8-1장): PC 사진 파일 → 줄인 WebP 한 장 → Storage. 원본은 올리지 않고, PC 의 원래 파일은 건드리지 않는다.
// 에이전트는 image 블록에 src 대신 file(PC 절대 경로)을 준다. 여기서 읽고 줄이고 올린 뒤 src·w·h·local_path 를 채운다.
// 주인 없는 사진 치우기(purgeImages)도 여기 — SQL 로는 Storage 파일을 못 지우므로 MCP 가 Storage API 로 한다.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import sharp, { type Metadata, type OutputInfo } from "sharp";
import { IMAGE_SRC, LIMITS, type BlockError } from "../lib/blocks";
import type { ImageStore } from "./store";

/** 긴 변 상한 (확대는 안 함) */
export const IMAGE_MAX_SIDE = LIMITS.image.side;
/** 버킷 file_size_limit 과 같다 */
export const IMAGE_MAX_BYTES = 512_000;
/** 읽을 원본 파일 상한 — 이보다 크면 사진이 아닐 가능성이 크고 메모리를 너무 쓴다 */
export const INPUT_MAX_BYTES = 50 * 1024 * 1024;
const INPUT_MAX_PIXELS = 100_000_000;
const QUALITY = { start: 80, step: 10, min: 50 } as const;
/** 품질 하한에서도 넘으면 이만큼씩 더 줄인다 */
const SHRINK = 0.85;
const MIN_SIDE = 64;

export class ImageError extends Error {
  override name = "ImageError";
}

export type PreparedImage = {
  bytes: Buffer;
  width: number;
  height: number;
  sha256: string;
  /** 읽은 파일의 절대 경로 (슬래시는 / 로) */
  localPath: string;
  quality: number;
};

function readable(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * PC 사진 파일을 읽어 줄인다: 방향(EXIF) 반영 → 긴 변 1280px 이하(확대 안 함) → WebP.
 * 메타데이터(EXIF·GPS·ICC 등)는 싣지 않는다(sharp 기본). 품질 80 에서 시작해 500KB 를 넘으면 10씩 낮추고(하한 50),
 * 그래도 넘으면 크기를 줄인다. 원래 파일은 읽기만 한다.
 */
export async function prepareImage(file: string): Promise<PreparedImage> {
  if (typeof file !== "string" || file.trim() === "") throw new ImageError("file 이 비어 있습니다 — PC 사진의 절대 경로를 주세요");
  const raw = file.trim();
  if (!isAbsolute(raw)) throw new ImageError(`file 은 절대 경로로 주세요 (예: C:/Users/PC/Pictures/a.png): ${raw}`);
  const abs = resolve(raw);

  let size: number;
  try {
    const st = await stat(abs);
    if (st.isDirectory()) throw new ImageError(`파일이 아니라 폴더입니다: ${readable(abs)}`);
    if (!st.isFile()) throw new ImageError(`보통 파일이 아닙니다: ${readable(abs)}`);
    size = st.size;
  } catch (e) {
    if (e instanceof ImageError) throw e;
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new ImageError(`파일이 없습니다: ${readable(abs)}`);
    if (code === "EACCES" || code === "EPERM") throw new ImageError(`파일을 읽을 권한이 없습니다: ${readable(abs)}`);
    throw new ImageError(`파일을 열지 못했습니다: ${readable(abs)} (${code ?? String(e)})`);
  }
  if (size === 0) throw new ImageError(`빈 파일입니다: ${readable(abs)}`);
  if (size > INPUT_MAX_BYTES) {
    throw new ImageError(`파일이 너무 큽니다 (${(size / 1024 / 1024).toFixed(1)}MB, 최대 ${INPUT_MAX_BYTES / 1024 / 1024}MB): ${readable(abs)}`);
  }

  const input = await readFile(abs);
  const open = () => sharp(input, { limitInputPixels: INPUT_MAX_PIXELS, failOn: "error" });

  let meta: Metadata;
  try {
    meta = await open().metadata();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/pixel limit/i.test(msg)) throw new ImageError(`사진이 너무 큽니다 (가로×세로 ${INPUT_MAX_PIXELS.toLocaleString("en-US")}픽셀까지): ${readable(abs)}`);
    throw new ImageError(`사진 파일이 아닙니다 (JPEG · PNG · WebP · GIF · AVIF · TIFF 를 읽습니다): ${readable(abs)}`);
  }
  if (!meta.width || !meta.height) throw new ImageError(`사진 크기를 읽지 못했습니다: ${readable(abs)}`);

  // 방향을 반영한 뒤의 긴 변
  const rotated = (meta.orientation ?? 1) >= 5;
  const w0 = rotated ? meta.height : meta.width;
  const h0 = rotated ? meta.width : meta.height;
  let side = Math.min(IMAGE_MAX_SIDE, Math.max(w0, h0));

  for (let guard = 0; guard < 40; guard++) {
    for (let q: number = QUALITY.start; q >= QUALITY.min; q -= QUALITY.step) {
      let out: { data: Buffer; info: OutputInfo };
      try {
        out = await open()
          .rotate()
          .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
          .webp({ quality: q, effort: 4 })
          .toBuffer({ resolveWithObject: true });
      } catch (e) {
        throw new ImageError(`사진을 줄이지 못했습니다: ${readable(abs)} (${e instanceof Error ? e.message : String(e)})`);
      }
      if (out.data.length <= IMAGE_MAX_BYTES) {
        return {
          bytes: out.data,
          width: out.info.width,
          height: out.info.height,
          sha256: createHash("sha256").update(out.data).digest("hex"),
          localPath: readable(abs),
          quality: q,
        };
      }
    }
    const next = Math.floor(side * SHRINK);
    if (next < MIN_SIDE) break;
    side = next;
  }
  throw new ImageError(`500KB 이하로 줄이지 못했습니다: ${readable(abs)}`);
}

// ---------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** 올릴 준비가 된 사진 한 장 (경로 → 내용). 같은 사진은 한 번만 */
export type PendingUploads = Map<string, Buffer>;

export type ResolvedBlocks = { blocks: unknown[]; uploads: PendingUploads; errors: BlockError[] };

/**
 * 블록 배열 안 image 블록의 file 을 줄인 사진으로 바꾼다 (아직 올리지는 않는다 — 블록 검사를 통과한 뒤 uploadPending).
 * src 를 직접 준 블록은 이 서랍에 이미 있는 사진인지 본다. where(i) 는 오류 자리 글자 (report_edit 은 ops[k].block).
 */
export async function resolveImages(
  input: readonly unknown[],
  store: Pick<ImageStore, "imageExists"> & { owner: string },
  where: (i: number) => string = (i) => `blocks[${i}]`,
): Promise<ResolvedBlocks> {
  const blocks = [...input];
  const uploads: PendingUploads = new Map();
  const errors: BlockError[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!isObj(b) || b.type !== "image") continue;
    if (Object.hasOwn(b, "file")) {
      if (b.src !== undefined) {
        errors.push({ path: `${where(i)}.file`, message: "file 과 src 는 같이 줄 수 없습니다 — PC 사진이면 file 만" });
        const { file: _, ...rest } = b;
        blocks[i] = rest;
        continue;
      }
      try {
        const img = await prepareImage(b.file as string);
        const src = `${store.owner}/${img.sha256}.webp`;
        uploads.set(src, img.bytes);
        const { file: _, w: _w, h: _h, local_path: _l, ...rest } = b;
        blocks[i] = { ...rest, src, w: img.width, h: img.height, local_path: img.localPath };
      } catch (e) {
        if (!(e instanceof ImageError)) throw e;
        errors.push({ path: `${where(i)}.file`, message: e.message });
        // 나머지 칸 검사는 계속하되 file 때문에 같은 자리 오류가 겹치지 않게 자리만 채운다 (저장은 안 된다)
        const { file: _, ...rest } = b;
        blocks[i] = { ...rest, src: `${store.owner}/${"0".repeat(64)}.webp`, w: 1, h: 1, local_path: "-" };
      }
    } else if (typeof b.src === "string" && IMAGE_SRC.test(b.src)) {
      if (!b.src.startsWith(`${store.owner}/`) || !(await store.imageExists(b.src))) {
        errors.push({ path: `${where(i)}.src`, message: "이 서랍에 없는 사진입니다 — PC 사진은 file 로 주세요" });
      }
    }
  }
  return { blocks, uploads, errors };
}

/** 준비한 사진 중 저장소에 없는 것만 올린다. 올린 수 */
export async function uploadPending(store: Pick<ImageStore, "imageExists" | "uploadImage">, uploads: PendingUploads): Promise<number> {
  let n = 0;
  for (const [path, bytes] of uploads) {
    if (await store.imageExists(path)) continue;
    await store.uploadImage(path, bytes);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------

export const PURGE_DAYS = 14;

/**
 * 어느 보고서(살아 있든 휴지통이든)에도 안 쓰이는 사진 중 올린 지 days 일 넘은 것을 지운다. 지운 경로들.
 * 휴지통 비우기(ez_purge_trash)가 행을 지우면, 그 보고서만 쓰던 사진이 다음 번에 여기서 지워진다
 */
export async function purgeImages(
  store: Pick<ImageStore, "listImages" | "imageSrcs" | "deleteImages">,
  { days = PURGE_DAYS, now = new Date() }: { days?: number; now?: Date } = {},
): Promise<string[]> {
  const cut = now.getTime() - days * 24 * 60 * 60 * 1000;
  const [files, used] = await Promise.all([store.listImages(), store.imageSrcs()]);
  const gone = files.filter((f) => !used.has(f.path) && Date.parse(f.created_at) < cut).map((f) => f.path);
  if (gone.length > 0) await store.deleteImages(gone);
  return gone;
}
