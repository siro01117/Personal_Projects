import { describe, expect, it } from "vitest";
import { arrangeBlocks, arrangeError, blockSchema, editRule, isEditablePath, isSameOrder, LIMITS, REPORT_KINDS, reportKindSchema, SCHEMA_VERSION, tableSpans, tidyText, validateBlocks, withoutLocalPaths } from "./blocks";
import { sampleBlocks, sampleImage, sampleSrc } from "./fixtures";

type Any = any; // 시험용으로 일부러 틀린 모양을 만든다

function errorsOf(input: unknown) {
  const r = validateBlocks(input);
  if (r.ok) throw new Error("통과하면 안 되는데 통과했습니다");
  return r.errors;
}
function withBlock(i: number, patch: (b: Any) => void) {
  const blocks = sampleBlocks() as Any[];
  patch(blocks[i]);
  return blocks;
}
const repeat = (ch: string, n: number) => ch.repeat(n);

describe("정상 보고서", () => {
  it("모든 블록 종류를 쓴 서칭 보고서가 통과한다", () => {
    const r = validateBlocks(sampleBlocks());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.blocks.map((b) => b.type)).toEqual(["verdict", "text", "text", "list", "table", "claims", "sources"]);
  });

  it("앞뒤 공백을 지운 값을 돌려준다", () => {
    const r = validateBlocks([{ type: "text", h: "  제목 ", body: "\n 본문\u3000" }]);
    expect(r).toEqual({ ok: true, blocks: [{ type: "text", h: "제목", body: "본문" }] });
  });

  it("상수", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(REPORT_KINDS).toEqual({ method: "작업 방식 조사", data: "데이터 조사", reference: "레퍼런스 조사" });
    expect(reportKindSchema.safeParse("data").success).toBe(true);
    expect(reportKindSchema.safeParse("etc").success).toBe(false);
  });
});

describe("블록 개수", () => {
  it("0개는 안 된다", () => {
    expect(errorsOf([])).toEqual([{ path: "blocks", message: "1개 이상 있어야 합니다" }]);
  });
  it("200개는 되고 201개는 안 된다", () => {
    const one = { type: "text", body: "x" };
    expect(validateBlocks(Array(200).fill(one)).ok).toBe(true);
    expect(errorsOf(Array(201).fill(one))).toEqual([{ path: "blocks", message: "200개까지 넣을 수 있습니다 (지금 201개)" }]);
  });
  it("배열이 아니면", () => {
    expect(errorsOf({})).toEqual([{ path: "blocks", message: "목록(배열)이어야 합니다" }]);
    expect(errorsOf(undefined)).toEqual([{ path: "blocks", message: "필요한 칸이 빠졌습니다" }]);
  });
});

describe("블록 모양", () => {
  it("모르는 블록 종류", () => {
    expect(errorsOf([{ type: "video", src: "x" }])).toEqual([
      { path: "blocks[0].type", message: "모르는 블록 종류입니다 (verdict, text, list, table, claims, sources, image 중 하나)" },
    ]);
  });
  it("블록이 객체가 아니면", () => {
    expect(errorsOf(["문자열"])[0]).toEqual({ path: "blocks[0]", message: "블록은 객체({ type: … })여야 합니다" });
  });
  it("모르는 칸", () => {
    expect(errorsOf([{ type: "text", body: "x", html: "<b>" }])).toEqual([{ path: "blocks[0]", message: "모르는 칸이 있습니다: html" }]);
  });
  it("빠진 칸 · 틀린 타입", () => {
    expect(errorsOf([{ type: "text" }])).toEqual([{ path: "blocks[0].body", message: "필요한 칸이 빠졌습니다" }]);
    expect(errorsOf([{ type: "text", body: 3 }])).toEqual([{ path: "blocks[0].body", message: "글자여야 합니다" }]);
  });
  it("여러 오류를 한 번에 돌려준다", () => {
    const errs = errorsOf([{ type: "text", body: "" }, { type: "list", h: "h", items: [] }, { type: "nope" }]);
    expect(errs.map((e) => e.path)).toEqual(["blocks[0].body", "blocks[1].items", "blocks[2].type"]);
  });
});

describe("글자 규칙", () => {
  it("공백만 있으면 빈 값", () => {
    expect(errorsOf([{ type: "text", body: " \n\t\u3000" }])).toEqual([{ path: "blocks[0].body", message: "비어 있습니다" }]);
  });
  it("선택 칸도 넣었으면 비어 있으면 안 된다", () => {
    expect(errorsOf([{ type: "verdict", v: "판정", w: "  " }])).toEqual([{ path: "blocks[0].w", message: "비어 있습니다" }]);
  });
  it("text.body 4000자 경계 (앞뒤 공백은 안 센다)", () => {
    expect(validateBlocks([{ type: "text", body: ` ${repeat("가", 4000)} ` }]).ok).toBe(true);
    expect(errorsOf([{ type: "text", body: repeat("가", 4001) }])).toEqual([
      { path: "blocks[0].body", message: "4000자까지 쓸 수 있습니다 (지금 4001자)" },
    ]);
  });
  it("글자 수는 코드 포인트로 센다 (이모지 1개 = 1자)", () => {
    expect(validateBlocks([{ type: "text", body: repeat("😀", 4000) }]).ok).toBe(true);
  });
  it("verdict.v 는 한 줄, 300자", () => {
    expect(errorsOf([{ type: "verdict", v: "첫 줄\n둘째 줄" }])).toEqual([
      { path: "blocks[0].v", message: "한 줄로 써야 합니다 (줄바꿈 없이)" },
    ]);
    expect(validateBlocks([{ type: "verdict", v: repeat("a", 300) }]).ok).toBe(true);
    expect(errorsOf([{ type: "verdict", v: repeat("a", 301) }])[0]!.message).toBe("300자까지 쓸 수 있습니다 (지금 301자)");
  });
  it("제목 h 200자", () => {
    expect(validateBlocks([{ type: "text", h: repeat("h", 200), body: "b" }]).ok).toBe(true);
    expect(errorsOf([{ type: "text", h: repeat("h", 201), body: "b" }])[0]!.path).toBe("blocks[0].h");
  });
  it("\\u0000 금지", () => {
    expect(errorsOf([{ type: "text", body: "a\u0000b" }])[0]!.path).toBe("blocks[0].body");
  });
});

describe("list", () => {
  it("항목 1~30개, 각 600자", () => {
    const list = (items: string[]) => [{ type: "list", h: "h", items }];
    expect(validateBlocks(list(Array(30).fill("x"))).ok).toBe(true);
    expect(errorsOf(list(Array(31).fill("x")))).toEqual([{ path: "blocks[0].items", message: "30개까지 넣을 수 있습니다 (지금 31개)" }]);
    expect(errorsOf(list([]))).toEqual([{ path: "blocks[0].items", message: "1개 이상 있어야 합니다" }]);
    expect(validateBlocks(list([repeat("x", 600)])).ok).toBe(true);
    expect(errorsOf(list(["ok", repeat("x", 601)]))[0]!.path).toBe("blocks[0].items[1]");
  });
  it("h 는 반드시", () => {
    expect(errorsOf([{ type: "list", items: ["a"] }])).toEqual([{ path: "blocks[0].h", message: "필요한 칸이 빠졌습니다" }]);
  });
});

describe("table", () => {
  const table = (cols: string[], rows: string[][]) => [{ type: "table", h: "표", cols, rows }];
  it("모든 행의 칸 수 = 열 수", () => {
    const errs = errorsOf(table(["a", "b", "c", "d"], [["1", "2", "3", "4"], ["1", "2", "3", "4"], ["1", "2", "3", "4"], ["1", "2", "3"]]));
    expect(errs).toEqual([{ path: "blocks[0].rows[3]", message: "칸이 3개인데 열은 4개입니다" }]);
  });
  it("칸이 더 많아도", () => {
    expect(errorsOf(table(["a", "b"], [["1", "2", "3"]]))).toEqual([{ path: "blocks[0].rows[0]", message: "칸이 3개인데 열은 2개입니다" }]);
  });
  it("열 2~8", () => {
    expect(errorsOf(table(["a"], [["1"]]))).toEqual([{ path: "blocks[0].cols", message: "2개 이상 있어야 합니다" }]);
    const eight = Array.from({ length: 8 }, (_, i) => `c${i}`);
    expect(validateBlocks(table(eight, [eight])).ok).toBe(true);
    const nine = [...eight, "c8"];
    expect(errorsOf(table(nine, [nine]))).toEqual([{ path: "blocks[0].cols", message: "8개까지 넣을 수 있습니다 (지금 9개)" }]);
  });
  it("행 1~60", () => {
    expect(errorsOf(table(["a", "b"], []))).toEqual([{ path: "blocks[0].rows", message: "1개 이상 있어야 합니다" }]);
    expect(validateBlocks(table(["a", "b"], Array(60).fill(["1", "2"]))).ok).toBe(true);
    expect(errorsOf(table(["a", "b"], Array(61).fill(["1", "2"])))[0]!.path).toBe("blocks[0].rows");
  });
  it("칸 300자, 빈 칸 금지", () => {
    expect(validateBlocks(table(["a", "b"], [[repeat("x", 300), "y"]])).ok).toBe(true);
    expect(errorsOf(table(["a", "b"], [["x", repeat("x", 301)]]))[0]!.path).toBe("blocks[0].rows[0][1]");
    expect(errorsOf(table(["a", " "], [["x", "y"]]))).toEqual([{ path: "blocks[0].cols[1]", message: "비어 있습니다" }]);
  });
  it("행이 배열이 아니면", () => {
    expect(errorsOf(table(["a", "b"], ["x" as Any]))).toEqual([{ path: "blocks[0].rows[0]", message: "행은 배열이어야 합니다" }]);
  });
});

describe("table.merges (설계서 7-6)", () => {
  const cols = ["a", "b", "c"];
  const rows = () => [
    ["가", "1", "x"],
    ["", "2", ""],
    ["나", "3", "y"],
    ["다", "4", "z"],
  ];
  /** 0행 0열을 세로 2칸, 1행 1~2열 자리는 그대로, … */
  const t = (merges: unknown, r: string[][] = rows()) => [{ type: "text", body: "앞" }, { type: "text", body: "앞" }, { type: "table", h: "표", cols, rows: r, merges }];

  it("세로 · 가로 · 둘 다 합치기가 통과하고 merges 를 그대로 돌려준다", () => {
    const r0 = rows();
    r0[1]![2] = "w";
    r0[3]![1] = "";
    r0[3]![2] = "";
    const merges = [{ r: 0, c: 0, rows: 2, cols: 1 }, { r: 3, c: 0, rows: 1, cols: 3 }];
    const r = validateBlocks(t(merges, r0));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.blocks[2] as Any).merges).toEqual(merges);
    // 2×2
    const sq = [["가", "", "x"], ["", "", "y"]];
    expect(validateBlocks(t([{ r: 0, c: 0, rows: 2, cols: 2 }], sq)).ok).toBe(true);
    // 빈 목록 · 없음도 된다
    expect(validateBlocks(t([], [["1", "2", "3"]])).ok).toBe(true);
    expect(validateBlocks([{ type: "table", h: "표", cols, rows: [["1", "2", "3"]] }]).ok).toBe(true);
  });

  it("덮인 칸 '' 은 엄격 검사에서도 통과, 덮이지 않은 빈 칸은 그대로 거절", () => {
    const r0 = rows();
    r0[1]![2] = "w";
    expect(validateBlocks(t([{ r: 0, c: 0, rows: 2, cols: 1 }], r0)).ok).toBe(true);
    expect(errorsOf(t([{ r: 0, c: 0, rows: 2, cols: 1 }]))).toEqual([{ path: "blocks[2].rows[1][2]", message: "비어 있습니다" }]);
    // 시작 칸은 덮이지 않으므로 비면 거절
    const r1 = rows();
    r1[0]![0] = "";
    r1[1]![2] = "w";
    expect(errorsOf(t([{ r: 0, c: 0, rows: 2, cols: 1 }], r1))).toEqual([{ path: "blocks[2].rows[0][0]", message: "비어 있습니다" }]);
  });

  it("한 칸짜리는 거절", () => {
    expect(errorsOf(t([{ r: 0, c: 0, rows: 1, cols: 1 }], [["1", "2", "3"]]))).toEqual([
      { path: "blocks[2].merges[0]", message: "한 칸은 합칠 수 없습니다 — rows 나 cols 를 2 이상으로" },
    ]);
  });

  it("표 밖은 거절 (머리 행은 rows 에 없으므로 r 는 rows 기준)", () => {
    const one = [["1", "2", "3"]];
    expect(errorsOf(t([{ r: 0, c: 1, rows: 2, cols: 1 }], one))).toEqual([{ path: "blocks[2].merges[0]", message: "표 밖입니다 (행은 0~0번, 열은 0~2번)" }]);
    expect(errorsOf(t([{ r: 0, c: 2, rows: 1, cols: 2 }], [["1", "2", "3"]]))[0]!.message).toBe("표 밖입니다 (행은 0~0번, 열은 0~2번)");
    expect(errorsOf(t([{ r: 5, c: 0, rows: 1, cols: 2 }], [["1", "2", "3"]]))[0]!.path).toBe("blocks[2].merges[0]");
  });

  it("겹치면 거절 — 위치와 이유", () => {
    const r0 = [["가", "x", "x"], ["", "y", "y"]];
    expect(errorsOf(t([{ r: 0, c: 0, rows: 2, cols: 1 }, { r: 0, c: 0, rows: 1, cols: 2 }], r0))).toEqual([
      { path: "blocks[2].merges[1]", message: "칸이 겹칩니다 (먼저 놓인 merges[0])" },
    ]);
  });

  it("덮이는 칸에 글이 있으면 거절", () => {
    const r0 = rows();
    r0[1]![2] = "w";
    r0[1]![0] = "남은 글";
    expect(errorsOf(t([{ r: 0, c: 0, rows: 2, cols: 1 }], r0))).toEqual([
      { path: "blocks[2].merges[0]", message: '합쳐진 자리에 글이 있습니다: rows[1][0] — 덮이는 칸은 "" 로 비워 두세요' },
    ]);
  });

  it("모양: 0 이상 · 1 이상 정수, 모르는 칸, 배열", () => {
    const one = [["1", "2", "3"]];
    expect(errorsOf(t([{ r: -1, c: 0.5, rows: 0, cols: "2" }], one))).toEqual([
      { path: "blocks[2].merges[0].r", message: "0 이상의 정수여야 합니다" },
      { path: "blocks[2].merges[0].c", message: "0 이상의 정수여야 합니다" },
      { path: "blocks[2].merges[0].rows", message: "1 이상의 정수여야 합니다" },
      { path: "blocks[2].merges[0].cols", message: "숫자여야 합니다" },
    ]);
    expect(errorsOf(t([{ r: 0, c: 0, rows: 2 }], one))[0]).toEqual({ path: "blocks[2].merges[0].cols", message: "필요한 칸이 빠졌습니다" });
    expect(errorsOf(t([{ r: 0, c: 0, rows: 1, cols: 2, x: 1 }], one))[0]!.message).toBe("모르는 칸이 있습니다: x");
    expect(errorsOf(t({ r: 0 }, one))[0]).toEqual({ path: "blocks[2].merges", message: "목록(배열)이어야 합니다" });
  });

  it("allowEmpty 경로에서도 같은 규칙", () => {
    const loose = (blocks: unknown) => {
      const r = validateBlocks(blocks, { allowEmpty: true });
      return r.ok ? [] : r.errors;
    };
    // 사람이 비워 둔 칸은 봐주지만
    expect(loose(t([{ r: 0, c: 0, rows: 2, cols: 1 }]))).toEqual([]);
    // 겹침 · 표 밖 · 한 칸 · 덮인 칸의 글은 그대로 거절
    const r0 = [["가", "", "x"], ["", "", "y"]];
    expect(loose(t([{ r: 0, c: 0, rows: 2, cols: 1 }, { r: 1, c: 0, rows: 1, cols: 2 }], r0))).toEqual([
      { path: "blocks[2].merges[1]", message: "칸이 겹칩니다 (먼저 놓인 merges[0])" },
    ]);
    expect(loose(t([{ r: 1, c: 0, rows: 2, cols: 1 }], r0))[0]!.message).toBe("표 밖입니다 (행은 0~1번, 열은 0~2번)");
    expect(loose(t([{ r: 0, c: 1, rows: 1, cols: 1 }], r0))[0]!.message).toContain("한 칸은 합칠 수 없습니다");
    expect(loose(t([{ r: 0, c: 1, rows: 1, cols: 2 }], r0))).toEqual([
      { path: "blocks[2].merges[0]", message: '합쳐진 자리에 글이 있습니다: rows[0][2] — 덮이는 칸은 "" 로 비워 두세요' },
    ]);
  });

  it("tableSpans: 시작 칸은 { rows, cols }, 덮인 칸은 covered, 잘못된 합치기는 건너뛴다", () => {
    const spans = tableSpans({
      cols,
      rows: [["가", "", "x"], ["", "", "y"], ["a", "b", "c"]],
      merges: [{ r: 0, c: 0, rows: 2, cols: 2 }, { r: 1, c: 1, rows: 1, cols: 2 }, { r: 2, c: 2, rows: 2, cols: 1 }],
    });
    expect(spans).toEqual([
      [{ rows: 2, cols: 2 }, "covered", null],
      ["covered", "covered", null],
      [null, null, null],
    ]);
  });

  it("사람이 고칠 수 있는 칸: merges 는 아니다 (덮인 칸은 화면에 안 그려서 고칠 자리가 없다)", () => {
    const b = t([{ r: 0, c: 0, rows: 2, cols: 1 }]);
    expect(editRule(b, [2, "merges", 0, "r"])).toBeNull();
    expect(editRule(b, [2, "rows", 0, 0])).toEqual({ maxLength: LIMITS.table.cell, oneLine: false });
  });
});

describe("claims", () => {
  it("tag 는 fact/guess", () => {
    const errs = errorsOf(withBlock(5, (b) => (b.items[0].tag = "maybe")));
    expect(errs).toEqual([{ path: "blocks[5].items[0].tag", message: "tag 는 fact(사실) 또는 guess(추정) 입니다" }]);
  });
  it("refs 는 출처 범위 1..n", () => {
    expect(errorsOf(withBlock(5, (b) => (b.items[2].refs = [2, 3])))).toEqual([
      { path: "blocks[5].items[2].refs[1]", message: "출처 3번은 없습니다 (출처는 1~2번)" },
    ]);
  });
  it("refs 0 · 소수 · 음수", () => {
    const errs = errorsOf(withBlock(5, (b) => (b.items[0].refs = [0, 1.5, -1])));
    expect(errs.map((e) => e.path)).toEqual(["blocks[5].items[0].refs[0]", "blocks[5].items[0].refs[1]", "blocks[5].items[0].refs[2]"]);
    expect(errs[0]!.message).toBe("출처 번호는 1 이상의 정수여야 합니다");
  });
  it("출처 블록이 없는데 refs 가 있으면", () => {
    const blocks = sampleBlocks().filter((b) => b.type !== "sources");
    expect(errorsOf(blocks)).toEqual([
      { path: "blocks[5].items[0].refs[0]", message: "출처 블록이 없는데 출처 1번을 가리킵니다" },
      { path: "blocks[5].items[2].refs[0]", message: "출처 블록이 없는데 출처 1번을 가리킵니다" },
      { path: "blocks[5].items[2].refs[1]", message: "출처 블록이 없는데 출처 2번을 가리킵니다" },
    ]);
  });
  it("출처 블록이 없어도 refs 가 비었으면 괜찮다", () => {
    expect(validateBlocks([{ type: "claims", h: "근거", items: [{ tag: "guess", text: "추정", refs: [] }] }]).ok).toBe(true);
  });
  it("출처 블록이 claims 뒤에 있어도 번호를 맞춘다", () => {
    const blocks = [
      { type: "claims", h: "근거", items: [{ tag: "fact", text: "t", refs: [1] }] },
      { type: "sources", h: "출처", items: [{ title: "a", url: "https://a.com" }] },
    ];
    expect(validateBlocks(blocks).ok).toBe(true);
  });
  it("refs 는 반드시 (빈 배열 가능), 20개까지", () => {
    expect(errorsOf(withBlock(5, (b) => delete b.items[0].refs))[0]).toEqual({
      path: "blocks[5].items[0].refs",
      message: "필요한 칸이 빠졌습니다",
    });
    expect(errorsOf(withBlock(5, (b) => (b.items[0].refs = Array(21).fill(1))))[0]!.path).toBe("blocks[5].items[0].refs");
  });
});

describe("sources", () => {
  it("url 은 http/https 만", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "ftp://a.com/x", "//a.com", "a.com", "https://", "JAVASCRIPT:alert(1)"]) {
      const errs = errorsOf(withBlock(6, (b) => (b.items[1].url = bad)));
      expect(errs, bad).toEqual([
        { path: "blocks[6].items[1].url", message: "주소는 http:// 또는 https:// 로 시작하는 웹 주소만 쓸 수 있습니다" },
      ]);
    }
    expect(validateBlocks(withBlock(6, (b) => (b.items[1].url = "  HTTPS://Example.com/경로?q=1  "))).ok).toBe(true);
  });
  it("url 2000자", () => {
    const long = "https://a.com/" + repeat("x", 2000 - 14);
    expect(validateBlocks(withBlock(6, (b) => (b.items[0].url = long))).ok).toBe(true);
    expect(errorsOf(withBlock(6, (b) => (b.items[0].url = long + "x")))[0]!.message).toBe("주소는 2000자까지 쓸 수 있습니다 (지금 2001자)");
  });
  it("항목 1~100개", () => {
    const item = { title: "t", url: "https://a.com" };
    expect(validateBlocks([{ type: "sources", h: "출처", items: Array(100).fill(item) }]).ok).toBe(true);
    expect(errorsOf([{ type: "sources", h: "출처", items: Array(101).fill(item) }])[0]!.path).toBe("blocks[0].items");
    expect(errorsOf([{ type: "sources", h: "출처", items: [] }])[0]!.message).toBe("1개 이상 있어야 합니다");
  });
});

describe("보고서당 1개", () => {
  it("verdict 2개", () => {
    const blocks = [...sampleBlocks(), { type: "verdict", v: "또" }];
    expect(errorsOf(blocks)).toEqual([{ path: "blocks[7]", message: "판정 블록은 1개만 넣을 수 있습니다 (이미 blocks[0])" }]);
  });
  it("sources 2개", () => {
    const blocks = [...sampleBlocks(), { type: "sources", h: "또", items: [{ title: "t", url: "https://a.com" }] }];
    expect(errorsOf(blocks)).toEqual([{ path: "blocks[7]", message: "출처 블록은 1개만 넣을 수 있습니다 (이미 blocks[6])" }]);
  });
});

describe("크기", () => {
  it("JSON 580,000 바이트를 넘으면 (DB 상한 600,000 보다 여유)", () => {
    expect(LIMITS.bytes).toBe(580_000);
    // 한글 1자 = 3바이트. 4000자 본문 = 약 12,026바이트 → 49개면 넘고 48개는 된다
    const big = Array.from({ length: 49 }, () => ({ type: "text", body: repeat("가", 4000) }));
    const errs = errorsOf(big);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.path).toBe("blocks");
    expect(errs[0]!.message).toMatch(/^보고서가 너무 큽니다/);
    expect(validateBlocks(big.slice(0, 48)).ok).toBe(true);
  });
});

describe("사람이 고칠 수 있는 칸", () => {
  const blocks = sampleBlocks();
  const yes: (string | number)[][] = [
    ["title"],
    [0, "v"], [0, "w"],
    [1, "h"], [1, "body"], [2, "body"],
    [3, "h"], [3, "items", 0], [3, "items", 2],
    [4, "h"], [4, "cols", 0], [4, "cols", 2], [4, "rows", 0, 0], [4, "rows", 1, 2],
    [5, "h"], [5, "items", 0, "text"], [5, "items", 2, "text"],
    [6, "h"], [6, "items", 0, "title"], [6, "items", 1, "title"],
    ["4", "rows", "1", "2"],
  ];
  const no: (string | number)[][] = [
    [], ["name"], ["blocks"], [0], [0, "type"], [1, "type"],
    [2, "h"], // 없는 칸은 새로 만들 수 없다
    [3, "items"], [3, "items", 3], [3, "items", -1], [3, "items", "-1"], [3, "items", "01"], [3, "items", 1.5],
    [4, "cols"], [4, "rows", 0], [4, "rows", 2, 0], [4, "rows", 0, 3],
    [5, "items", 0, "tag"], [5, "items", 0, "refs"], [5, "items", 0, "refs", 0], [5, "items", 0],
    [6, "items", 0, "url"], [6, "items", 0],
    [7, "h"], [-1, "h"], ["x", "h"],
    [1, "body", "extra"], [0, "v", 0],
  ];
  it.each(yes)("허용 %j", (...path) => expect(isEditablePath(blocks, path)).toBe(true));
  it.each(no)("거절 %j", (...path) => expect(isEditablePath(blocks, path)).toBe(false));

  it("그 자리 값이 문자열이 아니면 거절", () => {
    const odd = [{ type: "text", h: { a: 1 }, body: 3 }];
    expect(isEditablePath(odd, [0, "h"])).toBe(false);
    expect(isEditablePath(odd, [0, "body"])).toBe(false);
  });
  it("길이 상한은 블록 규칙과 같다", () => {
    expect(editRule(blocks, [0, "v"])).toEqual({ maxLength: LIMITS.verdict.v, oneLine: true });
    expect(editRule(blocks, [1, "body"])).toEqual({ maxLength: 4000, oneLine: false });
    expect(editRule(blocks, [4, "rows", 0, 0])).toEqual({ maxLength: 300, oneLine: false });
    expect(editRule(blocks, ["title"])).toEqual({ maxLength: 100, oneLine: true });
    expect(editRule(blocks, ["agent"])).toEqual({ maxLength: 100, oneLine: true });
  });

  it("줄바꿈이 되는 칸: 문단 · 판정 풀이 · 목록 항목 · 표 칸 · 근거 글. 나머지는 한 줄", () => {
    const all = [...blocks, sampleImage()];
    const multi: (string | number)[][] = [[0, "w"], [1, "body"], [2, "body"], [3, "items", 0], [4, "rows", 0, 0], [4, "rows", 1, 2], [5, "items", 0, "text"]];
    const single: (string | number)[][] = [
      ["title"], ["agent"], [0, "v"], [1, "h"], [3, "h"], [4, "h"], [5, "h"], [6, "h"],
      [4, "cols", 0], [6, "items", 0, "title"], [7, "alt"], [7, "caption"],
    ];
    for (const p of multi) expect(editRule(all, p)?.oneLine, JSON.stringify(p)).toBe(false);
    for (const p of single) expect(editRule(all, p)?.oneLine, JSON.stringify(p)).toBe(true);
    // 고칠 수 있는 칸을 빠짐없이 나눴다
    const paths: (string | number)[][] = [];
    const walk = (node: unknown, path: (string | number)[]) => {
      if (typeof node === "string" && isEditablePath(all, path)) paths.push(path);
      else if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    };
    walk(all, []);
    const key = (p: (string | number)[]) => {
      const b = all[p[0] as number] as { type: string };
      return `${b.type}.${p.slice(1).filter((x) => typeof x === "string").join(".")}`;
    };
    const lines = Object.fromEntries(paths.map((p) => [key(p), editRule(all, p)!.oneLine ? "한 줄" : "여러 줄"]));
    expect(lines).toEqual({
      "verdict.v": "한 줄", "verdict.w": "여러 줄",
      "text.h": "한 줄", "text.body": "여러 줄",
      "list.h": "한 줄", "list.items": "여러 줄",
      "table.h": "한 줄", "table.cols": "한 줄", "table.rows": "여러 줄",
      "claims.h": "한 줄", "claims.items.text": "여러 줄",
      "sources.h": "한 줄", "sources.items.title": "한 줄",
      "image.alt": "한 줄", "image.caption": "한 줄",
    });
  });

  it("에이전트 쪽 검사는 줄 규칙을 좁히지 않는다 — 소제목·표 머리·출처 제목에 줄바꿈이 든 기존 보고서도 통과", () => {
    const old = sampleBlocks() as any[];
    old[1].h = "배경\n둘째 줄";
    old[4].cols[0] = "도구\n(이름)";
    old[6].items[0].title = "PGlite\n문서";
    expect(validateBlocks(old).ok).toBe(true);
  });
});

describe("빈 칸 (사람이 비워 둔 칸)", () => {
  /** 사람이 고칠 수 있는 칸을 모두 비운 보고서 */
  function blanked(): any[] {
    const b = [...sampleBlocks(), sampleImage()] as any[];
    b[0].v = ""; b[0].w = "";
    b[1].h = ""; b[1].body = "";
    b[3].h = ""; b[3].items[1] = "";
    b[4].h = ""; b[4].cols[0] = ""; b[4].rows[1][2] = "";
    b[5].h = ""; b[5].items[1].text = "";
    b[6].h = ""; b[6].items[1].title = "";
    b[7].alt = ""; b[7].caption = "";
    return b;
  }

  it("기본은 거절 — 빈 칸마다 위치를 알려준다", () => {
    const errs = errorsOf(blanked());
    expect(errs).toHaveLength(15);
    expect(errs.every((e) => e.message === "비어 있습니다")).toBe(true);
    expect(errs.map((e) => e.path)).toContain("blocks[4].rows[1][2]");
  });

  it("allowEmpty 면 통과하고 빈 값 그대로 돌려준다 (공백만이면 '' 로)", () => {
    const b = blanked();
    b[1].body = "  \n ";
    const r = validateBlocks(b, { allowEmpty: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.blocks[1] as any).body).toBe("");
      expect((r.blocks[6] as any).items[1]).toEqual({ title: "", url: (sampleBlocks()[6] as any).items[1].url });
    }
  });

  it("allowEmpty 는 사람이 고칠 수 있는 칸만 — 주소·사진 출처 글·경로는 여전히 거절, 다른 규칙도 그대로", () => {
    const loose = (blocks: unknown) => {
      const r = validateBlocks(blocks, { allowEmpty: true });
      return r.ok ? [] : r.errors;
    };
    const b = sampleBlocks() as any[];
    b[6].items[0].url = "";
    expect(loose(b)).toEqual([{ path: "blocks[6].items[0].url", message: "비어 있습니다" }]);
    expect(loose([...sampleBlocks(), sampleImage({ credit: "" })])).toEqual([{ path: "blocks[7].credit", message: "비어 있습니다" }]);
    expect(loose([...sampleBlocks(), sampleImage({ ref: undefined, local_path: " " })])).toEqual([{ path: "blocks[7].local_path", message: "비어 있습니다" }]);
    // 길이·한 줄·빠진 칸·개수는 그대로
    expect(loose([{ type: "verdict", v: "두\n줄" }])[0]!.message).toBe("한 줄로 써야 합니다 (줄바꿈 없이)");
    expect(loose([{ type: "text", body: "가".repeat(4001) }])).toHaveLength(1);
    expect(loose([{ type: "text" }])).toEqual([{ path: "blocks[0].body", message: "필요한 칸이 빠졌습니다" }]);
    expect(loose([{ type: "list", h: "", items: [] }])).toEqual([{ path: "blocks[0].items", message: "1개 이상 있어야 합니다" }]);
    expect(loose([])).toHaveLength(1);
  });

  it("그리기용 blockSchema 는 빈 칸이 든 블록을 읽는다", () => {
    for (const b of blanked()) expect(blockSchema.safeParse(b).success, b.type).toBe(true);
  });

  it("비운 칸도 여전히 고칠 수 있는 칸이다 (없는 칸은 아니다)", () => {
    const b = blanked();
    expect(isEditablePath(b, [1, "h"])).toBe(true);
    expect(isEditablePath(b, [4, "rows", 1, 2])).toBe(true);
    expect(isEditablePath(b, [2, "h"])).toBe(false);
  });
});

describe("tidyText — 사람이 고친 글자 다듬기", () => {
  it("앞뒤 공백·빈 줄과 줄 끝 공백을 지우고, 가운데 줄바꿈은 지키고, 연속 빈 줄은 하나로", () => {
    expect(tidyText("  \n 첫 줄  \r\n둘째 줄\t\n\n\n\n넷째\u3000\n마지막 \n\n ")).toBe("첫 줄\n둘째 줄\n\n넷째\n마지막");
    expect(tidyText("   ")).toBe("");
    expect(tidyText("한 줄")).toBe("한 줄");
    expect(tidyText("  들여쓴 둘째 줄\n  은 그대로")).toBe("들여쓴 둘째 줄\n  은 그대로");
  });
  it("한 줄 칸: 줄바꿈을 공백 하나로 잇는다", () => {
    expect(tidyText(" 첫 줄 \n\n 둘째 줄\r\n셋째 ", true)).toBe("첫 줄 둘째 줄 셋째");
  });
});

describe("image 사진", () => {
  const withImage = (img: Record<string, unknown>) => [...sampleBlocks(), img];
  const last = sampleBlocks().length;

  it("정상: 좌·우·전체, size 는 없어도 된다", () => {
    expect(validateBlocks(withImage(sampleImage())).ok).toBe(true);
    expect(validateBlocks(withImage(sampleImage({ place: "right", size: "2/3" }))).ok).toBe(true);
    const full = sampleImage({ place: "full" });
    delete (full as Any).size;
    expect(validateBlocks(withImage(full)).ok).toBe(true);
    // 버전은 그대로 1 (종류만 더했다)
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("출처 ref · credit · local_path 중 하나 이상", () => {
    const none = sampleImage();
    delete (none as Any).ref;
    expect(errorsOf(withImage(none))).toEqual([
      { path: `blocks[${last}]`, message: "사진 출처가 없습니다 — ref(출처 번호) · credit(예: 직접 캡처) · local_path 중 하나를 주세요" },
    ]);
    expect(validateBlocks(withImage({ ...none, credit: "직접 캡처" })).ok).toBe(true);
    expect(validateBlocks(withImage({ ...none, local_path: "C:/Users/PC/Pictures/a.png" })).ok).toBe(true);
    // 그리기용 스키마는 출처가 없어도 통과 (공유 페이지는 local_path 를 빼고 받는다)
    expect(blockSchema.safeParse(none).success).toBe(true);
  });

  it("ref 는 출처 범위 안", () => {
    expect(errorsOf(withImage(sampleImage({ ref: 3 })))).toEqual([{ path: `blocks[${last}].ref`, message: "출처 3번은 없습니다 (출처는 1~2번)" }]);
    expect(errorsOf([sampleImage()])).toEqual([{ path: "blocks[0].ref", message: "출처 블록이 없는데 출처 1번을 가리킵니다" }]);
    expect(errorsOf(withImage(sampleImage({ ref: 0 })))[0]!.message).toBe("출처 번호는 1 이상의 정수여야 합니다");
  });

  it("src 는 <uuid>/<sha256>.webp 만", () => {
    for (const src of ["x.webp", `${sampleSrc()}x`, sampleSrc().replace(".webp", ".png"), "../a/b.webp", `https://x.dev/${"a".repeat(64)}.webp`]) {
      expect(errorsOf([sampleImage({ src, ref: undefined, credit: "c" })])[0]!.path).toBe("blocks[0].src");
    }
    expect(errorsOf([{ ...sampleImage({ credit: "c" }), ref: undefined, src: undefined }])[0]).toEqual({ path: "blocks[0].src", message: "필요한 칸이 빠졌습니다" });
  });

  it("w·h 는 1~1280 정수, alt 필수·한 줄, place·size 는 정한 값만, 모르는 칸 금지", () => {
    const one = (patch: Record<string, unknown>) => errorsOf([{ ...sampleImage({ ref: undefined, credit: "c" }), ...patch }]);
    expect(one({ w: 1281 })[0]).toEqual({ path: "blocks[0].w", message: "1~1280 사이 정수여야 합니다" });
    expect(one({ h: 0.5 })[0]!.path).toBe("blocks[0].h");
    expect(one({ alt: undefined })[0]).toEqual({ path: "blocks[0].alt", message: "필요한 칸이 빠졌습니다" });
    expect(one({ alt: "두\n줄" })[0]!.message).toBe("한 줄로 써야 합니다 (줄바꿈 없이)");
    expect(one({ place: "center" })[0]).toEqual({ path: "blocks[0].place", message: "place 는 left · right · full 중 하나입니다" });
    expect(one({ size: "1/4" })[0]!.path).toBe("blocks[0].size");
    expect(one({ file: "C:/a.png" })[0]).toEqual({ path: "blocks[0]", message: "모르는 칸이 있습니다: file" });
    expect(one({ credit: "x".repeat(101) })[0]!.path).toBe("blocks[0].credit");
  });

  it("edge 는 light · dark 만, 없어도 된다. crop 은 저장하지 않는 칸", () => {
    expect(validateBlocks(withImage(sampleImage({ edge: "light" }))).ok).toBe(true);
    expect(validateBlocks(withImage(sampleImage({ edge: "dark" }))).ok).toBe(true);
    expect(errorsOf(withImage(sampleImage({ edge: "gray" })))[0]).toEqual({
      path: `blocks[${last}].edge`,
      message: "edge 는 light · dark 중 하나입니다 (MCP 가 채우므로 file 로 줄 때는 비워 두세요)",
    });
    expect(errorsOf(withImage(sampleImage({ crop: { x: 0, y: 0, w: 1, h: 1 } })))[0]).toEqual({ path: `blocks[${last}]`, message: "모르는 칸이 있습니다: crop" });
  });

  it("사람은 alt · caption 글자만 고친다", () => {
    const blocks = withImage(sampleImage({ credit: "직접", local_path: "C:/a.png", edge: "light" }));
    expect(editRule(blocks, [last, "alt"])).toEqual({ maxLength: 300, oneLine: true });
    expect(editRule(blocks, [last, "caption"])).toEqual({ maxLength: 300, oneLine: true });
    for (const k of ["src", "place", "size", "ref", "credit", "local_path", "edge", "w", "h", "type"]) {
      expect(isEditablePath(blocks, [last, k]), k).toBe(false);
    }
    const noCaption = withImage(sampleImage({ caption: undefined }));
    expect(isEditablePath(JSON.parse(JSON.stringify(noCaption)), [last, "caption"])).toBe(false);
  });

  it("공유용: local_path 만 뺀다 (원본은 그대로)", () => {
    const blocks = [sampleImage({ local_path: "C:/Users/PC/a.png" }), { type: "text", body: "local_path" }];
    const out = withoutLocalPaths(blocks);
    expect(out[0]).not.toHaveProperty("local_path");
    expect(out[0]).toMatchObject({ alt: "PGlite 문서 첫 화면", ref: 1 });
    expect(out[1]).toBe(blocks[1]);
    expect(blocks[0]).toHaveProperty("local_path");
  });
});

describe("사람이 블록을 지우고 옮기기 (ez_blocks_arrange 와 같은 규칙)", () => {
  it("order: 비었거나 · 범위 밖이거나 · 겹치면 이유를 돌려준다", () => {
    expect(arrangeError(7, [6, 0, 1])).toBeNull();
    expect(arrangeError(7, [0, 1, 2, 3, 4, 5, 6])).toBeNull();
    expect(arrangeError(7, [])).toBe("블록이 하나는 남아야 합니다");
    expect(arrangeError(7, [7])).toBe("없는 블록 번호가 있습니다 (블록은 0~6번)");
    expect(arrangeError(7, [-1])).toBe("없는 블록 번호가 있습니다 (블록은 0~6번)");
    expect(arrangeError(7, [1.5])).toBe("없는 블록 번호가 있습니다 (블록은 0~6번)");
    expect(arrangeError(7, [2, 3, 2])).toBe("같은 블록 번호가 두 번 들어 있습니다");
    expect(isSameOrder(3, [0, 1, 2])).toBe(true);
    expect(isSameOrder(3, [0, 1])).toBe(false);
    expect(isSameOrder(3, [0, 2, 1])).toBe(false);
  });

  it("순서대로 늘어놓는다 — 블록은 그대로(같은 객체), 원본 배열은 안 바뀐다", () => {
    const blocks = sampleBlocks();
    const out = arrangeBlocks(blocks, [6, 0, 5]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(blocks[6]);
    expect(out[1]).toBe(blocks[0]);
    expect(out[2]).toBe(blocks[5]);
    expect(blocks).toEqual(sampleBlocks());
    expect(validateBlocks(out).ok).toBe(true);
  });

  it("출처 블록이 안 남으면 근거의 refs 를 비운다 — 그래야 에이전트 검사(출처 범위)를 통과한다", () => {
    const blocks = sampleBlocks();
    const out = arrangeBlocks(blocks, [0, 1, 2, 3, 4, 5]) as Any[];
    expect(out[5].items.map((c: Any) => c.refs)).toEqual([[], [], []]);
    expect(out[5].items.map((c: Any) => c.text)).toEqual((blocks[5] as Any).items.map((c: Any) => c.text));
    expect(out.slice(0, 5)).toEqual(blocks.slice(0, 5));
    expect(validateBlocks(out).ok).toBe(true);
    // 원본은 그대로
    expect((blocks[5] as Any).items[0].refs).toEqual([1]);
    // 사진의 ref 도 뺀다
    const img = arrangeBlocks([...blocks, sampleImage()], [7, 5]) as Any[];
    expect(img[0].ref).toBeUndefined();
    expect(img[1].items[0].refs).toEqual([]);
  });

  it("모르는 모양이 섞여 있어도 깨지지 않는다", () => {
    const odd = ["글자", null, { type: "claims", items: "배열 아님" }, { type: "claims", items: [1, { refs: [3] }, { text: "refs 없음" }] }];
    expect(arrangeBlocks(odd, [3, 2, 1, 0])).toEqual([{ type: "claims", items: [1, { refs: [] }, { text: "refs 없음" }] }, { type: "claims", items: "배열 아님" }, null, "글자"]);
  });
});
