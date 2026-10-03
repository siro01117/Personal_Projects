// 사진 가장자리 테두리: 라이트 테마 + edge=light, 다크 테마 + edge=dark 일 때만 포인트색 2px.
// 블록은 figure 의 data-edge 로 싣고, 테마별 값은 globals.css 토큰(--img-edge-light/-dark)이 정한다 — 둘을 같이 본다.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { arrangeBlocks } from "../../lib/blocks";
import { sampleBlocks, sampleImage } from "../../lib/fixtures";
import { Blocks, enterAction, spanOf, tocOf, type ArrangeCtx, type EditCtx } from "./Blocks";

const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

/** 선택자 바로 뒤 { … } 안의 선언 */
function declarations(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector}{`);
  if (at < 0) throw new Error(`없음: ${selector}`);
  const body = css.slice(at + selector.length + 1, css.indexOf("}", at));
  return Object.fromEntries(
    body
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.startsWith("--"))
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  );
}

const THEMES = {
  light: declarations(":root"),
  "dark (시스템)": declarations('@media (prefers-color-scheme: dark){ :root:not([data-theme="light"])'),
  "dark (고름)": declarations(':root[data-theme="dark"]'),
};

/** data-edge 값 → 그 규칙이 쓰는 토큰 */
const RULES = Object.fromEntries([...css.matchAll(/\.b-image\[data-edge="(light|dark)"\] \.img\{border:var\((--[\w-]+)\)\}/g)].map((m) => [m[1]!, m[2]!]));

function border(theme: keyof typeof THEMES, edge: string | undefined): string {
  if (edge === undefined || !RULES[edge]) return "none";
  const v = THEMES[theme][RULES[edge]];
  return v === "0" ? "none" : v!;
}

function figure(edge?: "light" | "dark"): string {
  const html = renderToStaticMarkup(<Blocks blocks={[sampleImage({ ref: undefined, credit: "직접 캡처", ...(edge ? { edge } : {}) })]} />);
  return /<figure[^>]*>/.exec(html)![0];
}

describe("사진 가장자리 테두리", () => {
  it("블록의 edge 가 figure 의 data-edge 로 나간다 (없으면 속성 없음)", () => {
    expect(figure("light")).toContain('data-edge="light"');
    expect(figure("dark")).toContain('data-edge="dark"');
    expect(figure()).not.toContain("data-edge");
  });

  it("라이트/다크 × light/dark/없음", () => {
    const KIWI = "2px solid var(--point)";
    const table = (["light", "dark (시스템)", "dark (고름)"] as const).map((t) => [t, border(t, "light"), border(t, "dark"), border(t, undefined)]);
    expect(table).toEqual([
      ["light", KIWI, "none", "none"],
      ["dark (시스템)", "none", KIWI, "none"],
      ["dark (고름)", "none", KIWI, "none"],
    ]);
    // 포인트색은 테마마다 키위
    for (const t of Object.values(THEMES)) expect(t["--point"]).toMatch(/^#(9be15d|a8e063)$/);
  });

  it("테두리는 사진(.img)에만, 둥근 모서리는 그대로", () => {
    expect(Object.keys(RULES).sort()).toEqual(["dark", "light"]);
    expect(css).toMatch(/\.b-image \.img\{[^}]*border-radius:var\(--r-m\);overflow:hidden/);
  });
});

// ---------------------------------------------------------------------------
// 빈 칸 · 줄바꿈 (설계서 3장 "사람이 고칠 수 있는 칸")

/** 사람이 여러 칸을 비운 보고서 */
function blanked(): unknown[] {
  return [
    { type: "verdict", v: "", w: "풀이는 남음" },
    { type: "text", h: "", body: "문단은 남음" },
    { type: "text", h: "소제목만 남음", body: "" },
    { type: "text", body: "" },
    { type: "list", h: "목록", items: ["하나", "", "셋"] },
    { type: "table", h: "", cols: ["a", ""], rows: [["", "칸"]] },
    { type: "claims", h: "근거", items: [{ tag: "fact", text: "", refs: [1] }, { tag: "guess", text: "남는 근거", refs: [] }] },
    { type: "sources", h: "", items: [{ title: "", url: "https://a.dev/x" }, { title: "둘째", url: "https://b.dev" }] },
    { type: "list", h: "", items: ["", ""] },
  ];
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("빈 칸", () => {
  it("읽을 때: 빈 소제목 · 문단 · 목록 항목 · 근거 줄 · 판정 한 줄은 안 그린다. 표 칸은 빈 칸, 출처 제목이 비면 주소", () => {
    const html = renderToStaticMarkup(<Blocks blocks={blanked()} />);
    expect(html).not.toContain("볼 수 없습니다"); // 빈 칸이 있어도 블록은 읽힌다
    expect(html).not.toContain('class="v"');
    expect(html).toContain('<p class="w">풀이는 남음</p>');
    expect(count(html, /<h3/g)).toBe(3); // 소제목만 남음 · 목록 · 근거
    expect(html).toContain('<div class="blk b-text" id="b1"><p>문단은 남음</p></div>');
    expect(html).toContain('<div class="blk b-text" id="b2"><h3>소제목만 남음</h3></div>');
    expect(count(html, /<li>/g)).toBe(2);
    expect(html).toContain("<li><span>하나</span></li><li><span>셋</span></li>");
    expect(html).toContain("<th><span></span></th>");
    expect(html).toContain('<td data-col="a"><span></span></td><td data-col=""><span>칸</span></td>');
    expect(count(html, /class="c"/g)).toBe(1);
    expect(html).toContain("남는 근거");
    expect(html).toContain('<a href="https://a.dev/x" target="_blank" rel="noopener noreferrer">https://a.dev/x</a>');
    // 다 비운 블록(제목 없는 빈 문단 · 다 비운 목록)은 행째 없다
    expect(html).not.toContain('id="b3"');
    expect(html).not.toContain('id="b8"');
    expect(count(html, /class="row/g)).toBe(7);
    // 빈 소제목은 구분선(sec)도 차례도 없는 것으로
    expect(html).toContain('<div class="row"><div class="blk b-text" id="b1">');
    expect(html).toContain('<div class="row sec"><div class="blk b-text" id="b2">');
    expect(tocOf(blanked())).toEqual([[0, "판정"], [2, "소제목만 남음"], [4, "목록"], [6, "근거"]]);
    expect(tocOf([{ type: "verdict", v: "", w: "" }])).toEqual([]);
    expect(html).not.toContain("data-edit");
  });

  it("고치기 모드: 비운 칸도 전부 고치는 칸으로 그린다 (자리표시는 CSS :empty). 키가 없는 선택 칸은 없다", () => {
    const raw = blanked();
    const ctx = { raw, editing: true, commit: async () => {} };
    const html = renderToStaticMarkup(<Blocks blocks={raw} ctx={ctx} />);
    // 판정 2 · 문단 2+2+1 · 목록 1+3 · 표 1+2+2 · 근거 1+2 · 출처 1+2 · 목록 1+2
    expect(count(html, /data-edit=""/g)).toBe(25);
    expect(count(html, /<h3[^>]*data-edit/g)).toBe(7); // b3 은 h 키가 없다
    expect(html).toContain('<div class="blk b-text" id="b3"><p data-edit="" contentEditable="plaintext-only" spellCheck="false"></p></div>');
    expect(count(html, /<li>/g)).toBe(5);
    expect(count(html, /class="c"/g)).toBe(2);
    expect(count(html, /class="row/g)).toBe(9);
    // 자리표시: 소제목 · 작성자 · 그 밖
    expect(css).toContain('.editing [data-edit]:empty::before{content:"비어 있음";color:var(--text-3)');
    expect(css).toContain('.editing h3[data-edit]:empty::before{content:"소제목"}');
    expect(css).toContain('.editing .by [data-edit]:empty::before{content:"작성자"}');
  });

  it("사진: 빈 캡션은 읽을 때 없고 고치기 모드에서는 칸으로, 빈 설명은 빈 alt", () => {
    const img = sampleImage({ ref: undefined, credit: "직접 캡처", alt: "", caption: "" });
    const read = renderToStaticMarkup(<Blocks blocks={[img]} />);
    expect(read).not.toContain('class="cap"');
    expect(read).toContain("직접 캡처");
    const edit = renderToStaticMarkup(<Blocks blocks={[img]} ctx={{ raw: [img], editing: true, commit: async () => {} }} />);
    expect(edit).toMatch(/<span class="alt" data-edit=""[^>]*><\/span><span class="cap" data-edit=""[^>]*><\/span>/);
    const noCap = sampleImage({ ref: undefined, credit: "직접 캡처", caption: undefined });
    const edit2 = renderToStaticMarkup(<Blocks blocks={[noCap]} ctx={{ raw: [noCap], editing: true, commit: async () => {} }} />);
    expect(edit2).not.toContain('class="cap"');
  });
});

describe("표 첫 열 합치기", () => {
  const rows = [["가", "1"], ["가", "2"], ["나", "3"], ["", "4"], ["", "5"], ["나", "6"]];
  const raw = [{ type: "table", h: "표", cols: ["대", "중"], rows }];

  it("읽을 때: 바로 위 행과 같은 첫 칸은 rowSpan 으로 합치고 이어지는 행은 .dup (빈 칸은 안 합침)", () => {
    const html = renderToStaticMarkup(<Blocks blocks={raw} />);
    expect(html).toContain('<td rowSpan="2" data-col="대"><span>가</span></td><td data-col="중"><span>1</span></td>');
    expect(html).toContain('<td class="dup" data-col="대"><span>가</span></td><td data-col="중"><span>2</span></td>');
    expect(html).toContain('<td data-col="대"><span>나</span></td><td data-col="중"><span>3</span></td>');
    expect(html).toContain('<td data-col="대"><span></span></td><td data-col="중"><span>4</span></td>');
    expect(html).toContain('<td data-col="대"><span></span></td><td data-col="중"><span>5</span></td>');
    expect(html).toContain('<td data-col="대"><span>나</span></td><td data-col="중"><span>6</span></td>');
    expect(count(html, /rowSpan/g)).toBe(1);
    expect(spanOf(rows, 0)).toBe(2);
    expect(spanOf(rows, 1)).toBe(1);
    expect(spanOf(rows, 3)).toBe(1);
    // 넓을 때 .dup 은 숨기고, 카드가 되는 좁은 폭에서는 보인다
    expect(css).toContain("td.dup{display:none}");
    expect(css).toContain(".page:not(.editing) .tbl-wrap td.dup{display:block}");
  });

  it("고치기 모드: 합치지 않는다 (칸마다 고칠 수 있게)", () => {
    const ctx = { raw, editing: true, commit: async () => {} };
    const html = renderToStaticMarkup(<Blocks blocks={raw} ctx={ctx} />);
    expect(html).not.toContain("rowSpan");
    expect(html).not.toContain('class="dup"');
    expect(count(html, /data-col="대"/g)).toBe(6);
  });
});

describe("표 셀 병합 (merges, 설계서 7-6)", () => {
  const raw = [
    {
      type: "table",
      h: "표",
      cols: ["구분", "항목", "값", "비고"],
      rows: [
        ["A", "가", "1", "공통"],
        ["", "나", "2", ""],
        ["합계", "", "3", "-"],
      ],
      merges: [
        { r: 0, c: 0, rows: 2, cols: 1 },
        { r: 0, c: 3, rows: 2, cols: 1 },
        { r: 2, c: 0, rows: 1, cols: 2 },
      ],
    },
  ];
  const rowsOf = (html: string) => [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => m[1]!).slice(1); // 머리 행 빼고

  it("시작 칸에 rowSpan · colSpan, 덮인 칸은 안 그린다. 가로로 합친 칸의 열 이름은 a · b", () => {
    const rows = rowsOf(renderToStaticMarkup(<Blocks blocks={raw} />));
    expect(rows).toEqual([
      '<td rowSpan="2" data-col="구분"><span>A</span></td><td data-col="항목"><span>가</span></td><td data-col="값"><span>1</span></td><td rowSpan="2" data-col="비고"><span>공통</span></td>',
      // 첫 열이 위에서 덮인 행: .dup 에 시작 칸 글 (넓을 때 숨김 · 좁은 폭 카드 제목). 덮인 비고 칸은 없음 — 세로 병합은 첫 행 카드에만
      '<td class="dup" data-col="구분"><span>A</span></td><td data-col="항목"><span>나</span></td><td data-col="값"><span>2</span></td>',
      '<td colSpan="2" data-col="구분 · 항목"><span>합계</span></td><td data-col="값"><span>3</span></td><td data-col="비고"><span>-</span></td>',
    ]);
  });

  it("고치기 모드: 합친 모양 그대로, 시작 칸만 고칠 수 있고 덮인 칸(.dup 포함)은 고칠 자리가 없다", () => {
    const ctx = { raw, editing: true, commit: async () => {} };
    const html = renderToStaticMarkup(<Blocks blocks={raw} ctx={ctx} />);
    expect(count(html, /rowSpan="2"/g)).toBe(2);
    expect(count(html, /colSpan="2"/g)).toBe(1);
    // 제목 1 + 머리 4 + 칸 4 · 2 · 3
    expect(count(html, /data-edit=""/g)).toBe(14);
    expect(rowsOf(html)[1]).toMatch(/^<td class="dup" data-col="구분"><span>A<\/span><\/td>/);
  });

  it("첫 열 자동 합치기는 merges 에 든 행과 섞이지 않는다", () => {
    const t = [{ type: "table", h: "표", cols: ["대", "중"], rows: [["A", "1"], ["A", "2"], ["", "3"]], merges: [{ r: 1, c: 0, rows: 2, cols: 1 }] }];
    expect(rowsOf(renderToStaticMarkup(<Blocks blocks={t} />))).toEqual([
      '<td data-col="대"><span>A</span></td><td data-col="중"><span>1</span></td>',
      '<td rowSpan="2" data-col="대"><span>A</span></td><td data-col="중"><span>2</span></td>',
      '<td class="dup" data-col="대"><span>A</span></td><td data-col="중"><span>3</span></td>',
    ]);
  });

  it("잘못 저장된 합치기(겹침 · 표 밖)는 건너뛰고 그린다", () => {
    const t = [{ type: "table", h: "표", cols: ["a", "b"], rows: [["1", "2"]], merges: [{ r: 0, c: 0, rows: 3, cols: 1 }] }];
    const html = renderToStaticMarkup(<Blocks blocks={t} />);
    expect(rowsOf(html)).toEqual(['<td data-col="a"><span>1</span></td><td data-col="b"><span>2</span></td>']);
  });
});

describe("줄바꿈", () => {
  it("줄바꿈이 든 글이 그대로 들어가고, 줄바꿈이 되는 칸은 pre-line 으로 보인다", () => {
    const html = renderToStaticMarkup(
      <Blocks
        blocks={[
          { type: "verdict", v: "한 줄", w: "풀이\n둘째" },
          { type: "text", body: "문단\n둘째" },
          { type: "list", h: "목록", items: ["첫 줄\n둘째 줄"] },
          { type: "table", h: "표", cols: ["a", "b"], rows: [["칸\n둘째", "x"]] },
          { type: "claims", h: "근거", items: [{ tag: "fact", text: "근거\n둘째", refs: [] }] },
        ]}
      />,
    );
    for (const t of ["풀이\n둘째", "문단\n둘째", "첫 줄\n둘째 줄", "칸\n둘째", "근거\n둘째"]) expect(html).toContain(t);
    expect(html).not.toContain("<br");
    expect(css).toMatch(/\.b-verdict \.w\{[^}]*white-space:pre-line/);
    expect(css).toMatch(/\.b-text p\{[^}]*white-space:pre-line/);
    expect(css).toMatch(/\.b-list li\{[^}]*white-space:pre-line/);
    expect(css).toMatch(/\ntd\{white-space:pre-line\}/);
    expect(css).toMatch(/\.b-claims p\{[^}]*white-space:pre-line/);
    expect(css).toMatch(/\.editing \[data-edit\]\{[^}]*white-space:pre-wrap/);
    // 표 칸이 여러 줄이어도 위로 맞춘다
    expect(css).toMatch(/th,td\{[^}]*vertical-align:top/);
  });

  it("Enter 는 저장, Shift+Enter 는 줄바꿈(되는 칸만), 한글 조합 중에는 건드리지 않는다", () => {
    const k = (o: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; composing: boolean }>) => ({ shiftKey: false, ctrlKey: false, metaKey: false, composing: false, ...o });
    for (const oneLine of [true, false]) {
      expect(enterAction(k({}), oneLine)).toBe("save");
      expect(enterAction(k({ ctrlKey: true }), oneLine)).toBe("save");
      expect(enterAction(k({ metaKey: true }), oneLine)).toBe("save");
      expect(enterAction(k({ composing: true }), oneLine)).toBe("ignore");
      expect(enterAction(k({ composing: true, shiftKey: true }), oneLine)).toBe("ignore");
    }
    expect(enterAction(k({ shiftKey: true }), false)).toBe("break");
    expect(enterAction(k({ shiftKey: true }), true)).toBe("none");
  });
});

describe("블록 고르기 · 옮기기 표시", () => {
  const blocks = () => [...sampleBlocks(), sampleImage(), { type: "모르는 종류" }];
  const KEYS = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"];
  const arrange = (selected: string[] = [], moving: string[] = []): ArrangeCtx => ({
    selected: new Set(selected),
    moving: new Set(moving),
    onGripDown: () => {},
    onGripClick: () => {},
  });
  const ctx = (editing: boolean, a?: ArrangeCtx, raw: unknown[] = blocks()): EditCtx => ({ raw, editing, commit: async () => {}, arrange: a });
  /** 블록 맨 바깥 요소의 여는 태그들 (문서 순서) */
  const roots = (html: string) => [...html.matchAll(/<(?:div|figure) class="blk [^>]*>/g)].map((m) => m[0]);
  const count = (html: string, needle: string) => html.split(needle).length - 1;

  it("읽을 때 · 공유 페이지(ctx 없음)에는 손잡이도 열쇠도 없다 — id 만", () => {
    for (const html of [renderToStaticMarkup(<Blocks blocks={blocks()} />), renderToStaticMarkup(<Blocks blocks={blocks()} ctx={ctx(false, arrange(["k1"]))} keys={KEYS} />)]) {
      expect(html).not.toContain("grip");
      expect(html).not.toContain("data-bk");
      expect(html).not.toContain("data-flip");
      expect(html).not.toContain("data-sel");
      expect(roots(html).map((t) => /id="(b\d+)"/.exec(t)![1])).toEqual(["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"]);
    }
  });

  it("고치기 모드라도 arrange 가 없으면 손잡이가 없다", () => {
    const html = renderToStaticMarkup(<Blocks blocks={blocks()} ctx={ctx(true)} keys={KEYS} />);
    expect(html).not.toContain("grip");
    expect(html).toContain("data-edit");
  });

  it("고치기 모드: 블록마다 손잡이 하나 — 사진 · 모르는 블록에도", () => {
    const html = renderToStaticMarkup(<Blocks blocks={blocks()} ctx={ctx(true, arrange())} keys={KEYS} />);
    expect(count(html, 'class="grip"')).toBe(9);
    expect(count(html, 'aria-label="블록 고르기"')).toBe(9);
    expect(roots(html).map((t) => /data-bk="(\w+)"/.exec(t)![1])).toEqual(KEYS);
    expect(roots(html).every((t) => /data-flip="k\d"/.test(t))).toBe(true);
    // 설명 글자 · 개수 표시는 없다: 손잡이 안은 아이콘뿐
    expect(/<button[^>]*class="grip"[^>]*>(.*?)<\/button>/.exec(html)![1]).toMatch(/^<svg[^>]*>.*<\/svg>$/);
  });

  it("고른 블록 · 끌리는 블록만 표시가 붙는다", () => {
    const html = renderToStaticMarkup(<Blocks blocks={blocks()} ctx={ctx(true, arrange(["k1", "k7"], ["k7"]))} keys={KEYS} />);
    const tags = roots(html);
    expect(tags.filter((t) => t.includes("data-sel")).map((t) => /data-bk="(\w+)"/.exec(t)![1])).toEqual(["k1", "k7"]);
    expect(tags.filter((t) => t.includes("data-moving")).map((t) => /data-bk="(\w+)"/.exec(t)![1])).toEqual(["k7"]);
    expect(count(html, 'aria-pressed="true"')).toBe(2);
  });

  it("순서를 바꾸면 열쇠는 블록을 따라가고 id 와 차례는 새 번호를 따른다", () => {
    const order = [6, 3, 0, 1, 2, 4, 5, 7, 8];
    const moved = arrangeBlocks(blocks(), order);
    const keys = order.map((i) => KEYS[i]!);
    const html = renderToStaticMarkup(<Blocks blocks={moved} ctx={ctx(true, arrange(), moved)} keys={keys} />);
    const tags = roots(html);
    expect(tags.map((t) => /id="(b\d+)"/.exec(t)![1])).toEqual(["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"]);
    expect(tags.map((t) => /data-bk="(\w+)"/.exec(t)![1])).toEqual(keys);
    expect(tags[0]).toContain("b-sources");
    expect(tags[1]).toContain("b-list");
    expect(tocOf(moved)).toEqual([[0, "출처"], [1, "후보"], [2, "판정"], [3, "배경"], [5, "비교"], [6, "근거"]]);
    // 고칠 칸의 경로도 새 번호: 출처가 맨 앞이어도 인용 번호는 그 출처를 가리킨다
    expect(html).toContain('id="src-1"');
  });

  it("고르기 · 손잡이 스타일은 키위 토큰만 쓴다 (밝기 양쪽에서 같은 규칙)", () => {
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector}{`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at + selector.length + 1, css.indexOf("}", at));
    };
    expect(rule(".editing .blk[data-sel]")).toBe("background:var(--point-soft);box-shadow:0 0 0 10px var(--point-soft)");
    expect(rule(".drop-line")).toContain("background:var(--point-ink)");
    expect(rule(".grip")).toContain("touch-action:none");
    for (const r of [rule(".grip"), rule(".drop-line"), rule(".editing .blk[data-moving]")]) expect(r).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});
