// 보고서 블록 → 행 (설계서 7-3장). 한 행에 객체 최대 2개.
// 옆(left·right) 사진은 바로 다음 블록이 문단·목록·근거면 둘이 한 행(2칸), 아니면 사진 혼자 그 비율 폭으로 한쪽에 선다.
// 전체(full) 사진과 나머지 블록은 행 하나를 혼자 쓴다. 행 안 순서는 데이터 순서 그대로(좁은 폭에서 위아래로 쌓는 순서).

import type { Block, ImageBlock } from "../../lib/blocks";

export type Side = "left" | "right";
export type ImageSize = NonNullable<ImageBlock["size"]>;

export type Row =
  /** 블록 하나가 행 전체 (전체 사진·모르는 블록 포함) */
  | { kind: "one"; i: number }
  /** 옆 사진 혼자 — 그 비율 폭으로 한쪽 정렬 */
  | { kind: "side"; i: number; side: Side; size: ImageSize }
  /** 옆 사진 i + 바로 다음 글 j. 사진 칸 비율 = size, 나머지가 글 칸 */
  | { kind: "pair"; i: number; j: number; side: Side; size: ImageSize };

const PARTNERS: ReadonlySet<Block["type"]> = new Set(["text", "list", "claims"]);

export function toRows(blocks: readonly (Block | null)[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b?.type !== "image" || b.place === "full") {
      rows.push({ kind: "one", i });
      continue;
    }
    const side = b.place;
    const size = b.size ?? "1/2";
    const next = blocks[i + 1];
    if (next && PARTNERS.has(next.type)) {
      rows.push({ kind: "pair", i, j: i + 1, side, size });
      i++;
    } else {
      rows.push({ kind: "side", i, side, size });
    }
  }
  return rows;
}

/** 행이 담은 블록 번호 (데이터 순서) */
export function rowBlocks(r: Row): number[] {
  return r.kind === "pair" ? [r.i, r.j] : [r.i];
}
