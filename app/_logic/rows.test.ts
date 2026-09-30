import { describe, expect, it } from "vitest";
import type { Block } from "../../lib/blocks";
import { rowBlocks, toRows } from "./rows";

const SRC = "d0000000-0000-4000-8000-0000000000aa/" + "0".repeat(64) + ".webp";
const img = (place: "left" | "right" | "full", size?: "1/3" | "1/2" | "2/3"): Block =>
  ({ type: "image", src: SRC, w: 100, h: 100, alt: "그림", place, ...(size ? { size } : {}), credit: "직접" }) as Block;
const text: Block = { type: "text", body: "글" };
const list: Block = { type: "list", h: "목록", items: ["a"] };
const claims: Block = { type: "claims", h: "근거", items: [{ tag: "fact", text: "a", refs: [] }] };
const table: Block = { type: "table", h: "표", cols: ["a", "b"], rows: [["1", "2"]] };
const verdict: Block = { type: "verdict", v: "판정" };
const sources: Block = { type: "sources", h: "출처", items: [{ title: "a", url: "https://a.dev" }] };

/** 모든 블록이 순서대로 정확히 한 번, 행마다 2개 이하 */
function checkShape(blocks: (Block | null)[]) {
  const rows = toRows(blocks);
  expect(rows.flatMap(rowBlocks)).toEqual(blocks.map((_, i) => i));
  for (const r of rows) expect(rowBlocks(r).length).toBeLessThanOrEqual(2);
  return rows;
}

describe("toRows", () => {
  it("옆 사진 + 바로 다음 문단·목록·근거 → 2칸 행", () => {
    for (const next of [text, list, claims]) {
      expect(checkShape([img("left", "1/3"), next])).toEqual([{ kind: "pair", i: 0, j: 1, side: "left", size: "1/3" }]);
    }
    expect(checkShape([img("right"), text])).toEqual([{ kind: "pair", i: 0, j: 1, side: "right", size: "1/2" }]);
  });

  it("다음이 짝이 될 수 없으면(표·판정·출처·사진·끝·모르는 블록) 사진 혼자", () => {
    for (const next of [table, verdict, sources, img("left"), img("full"), null]) {
      expect(checkShape([img("right", "2/3"), next])[0]).toEqual({ kind: "side", i: 0, side: "right", size: "2/3" });
    }
    expect(checkShape([text, img("left")])).toEqual([
      { kind: "one", i: 0 },
      { kind: "side", i: 1, side: "left", size: "1/2" },
    ]);
  });

  it("사진-사진-글: 앞 사진은 혼자, 뒤 사진이 글과 짝 — 한 행에 셋은 없다", () => {
    expect(checkShape([img("left"), img("right"), text])).toEqual([
      { kind: "side", i: 0, side: "left", size: "1/2" },
      { kind: "pair", i: 1, j: 2, side: "right", size: "1/2" },
    ]);
  });

  it("글은 한 번만 짝이 된다: 사진-글-글 → 둘째 글은 혼자", () => {
    expect(checkShape([img("left"), text, text])).toEqual([
      { kind: "pair", i: 0, j: 1, side: "left", size: "1/2" },
      { kind: "one", i: 2 },
    ]);
  });

  it("연속 사진은 모두 혼자, 전체 사진은 짝을 짓지 않는다", () => {
    const rows = checkShape([img("left"), img("left"), img("right"), img("full"), text]);
    expect(rows.map((r) => r.kind)).toEqual(["side", "side", "side", "one", "one"]);
  });

  it("글 앞의 글은 사진과 짝이 되지 않는다 (사진 뒤 블록만)", () => {
    expect(checkShape([text, img("right"), table]).map((r) => r.kind)).toEqual(["one", "side", "one"]);
  });

  it("아무렇게나 섞어도 모양 규칙은 지킨다", () => {
    const pool: (Block | null)[] = [img("left"), img("right"), img("full"), text, list, claims, table, verdict, sources, null];
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < 300; k++) {
      const blocks = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => pool[Math.floor(rand() * pool.length)]!);
      const rows = checkShape(blocks);
      for (const r of rows) {
        if (r.kind !== "pair") continue;
        expect(blocks[r.i]?.type).toBe("image");
        expect(["text", "list", "claims"]).toContain(blocks[r.j]?.type);
      }
    }
  });
});
