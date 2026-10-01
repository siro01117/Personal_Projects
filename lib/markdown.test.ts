import { describe, expect, it } from "vitest";
import { sampleBlocks, sampleImage } from "./fixtures";
import { blocksToMarkdown } from "./markdown";

describe("blocksToMarkdown", () => {
  it("블록 종류 전부 — 판정 인용구 · 표 · 근거 각주 · 출처 각주 정의", () => {
    const md = blocksToMarkdown("DB 시험 방법", sampleBlocks(), { agent: "Claude Code", date: "9월 30일" });
    expect(md).toBe(
      [
        "# DB 시험 방법",
        "Claude Code · 9월 30일",
        "> **PGlite 로 DB 시험을 돌린다**\n>\n> 도커 없이 트리거·RLS 까지 진짜 Postgres 로 확인된다.",
        "## 배경",
        "보고서 서랍의 무결성은 DB 가 막는다.  \n그래서 DB 를 진짜로 돌려 봐야 한다.",
        "제목 없는 문단.",
        "## 후보",
        "- PGlite\n- Docker Postgres\n- Supabase 브랜치",
        "## 비교",
        "| 도구 | 속도 | 비용 |\n| --- | --- | --- |\n| PGlite | 빠름 | 0원 |\n| Docker | 보통 | 0원 |",
        "## 근거",
        "- [사실] PGlite 는 WASM 으로 컴파일된 Postgres 다[^1]\n- [추정] Supabase 와 동작이 거의 같을 것이다\n- [사실] RLS 도 돈다[^1][^2]",
        "## 출처",
        "[^1]: [PGlite 문서](<https://pglite.dev/docs/>)\n[^2]: [Supabase RLS](<http://supabase.com/docs/guides/auth/row-level-security>)",
      ].join("\n\n") + "\n",
    );
  });

  it("표 칸의 | · \\ · 줄바꿈을 이스케이프", () => {
    const md = blocksToMarkdown("t", [{ type: "table", h: "표", cols: ["a|b", "c"], rows: [["줄\n바꿈", "역\\슬래시 |끝"]] }]);
    expect(md).toContain("| a\\|b | c |");
    expect(md).toContain("| 줄<br>바꿈 | 역\\\\슬래시 \\|끝 |");
  });

  it("모르는 블록·깨진 블록은 건너뛰고 한 줄 주석", () => {
    const md = blocksToMarkdown("t", [
      { type: "timeline", items: [] },
      { type: "text" },
      { type: "--><script>" },
      "문자열",
      { type: "text", body: "남는 글" },
    ]);
    expect(md).toContain("<!-- 이 블록은 옮기지 못했습니다: timeline -->");
    expect(md).toContain("<!-- 이 블록은 옮기지 못했습니다: text -->");
    expect(md.match(/<!-- 이 블록은 옮기지 못했습니다: \? -->/g)).toHaveLength(2);
    expect(md).not.toContain("<script>");
    expect(md).toContain("남는 글");
  });

  it("출처 범위 밖 번호·출처 없음은 각주를 달지 않는다. http/https 가 아닌 주소는 글자만", () => {
    const md = blocksToMarkdown("t", [
      { type: "claims", h: "근거", items: [{ tag: "fact", text: "a", refs: [1, 3] }] },
      { type: "sources", h: "출처", items: [{ title: "제목 [괄호]", url: "https://a.dev/x" }] },
    ]);
    expect(md).toContain("- [사실] a[^1]\n");
    expect(md).not.toContain("[^3]");
    expect(md).toContain("[^1]: [제목 \\[괄호\\]](<https://a.dev/x>)");
    const none = blocksToMarkdown("t", [{ type: "claims", h: "근거", items: [{ tag: "guess", text: "b", refs: [1] }] }]);
    expect(none).toContain("- [추정] b\n");
    expect(none).not.toContain("[^");
  });

  it("여러 줄 목록 칸은 들여쓰고, 판정 풀이가 없으면 한 줄 인용구. 링크 메타", () => {
    const md = blocksToMarkdown("제목\n둘째 줄", [
      { type: "verdict", v: "한 줄" },
      { type: "list", h: "목록", items: ["첫 줄\n둘째 줄"] },
    ], { url: "http://localhost:3200/drawer/r/x" });
    expect(md.startsWith("# 제목 둘째 줄\n\n<http://localhost:3200/drawer/r/x>\n\n> **한 줄**\n\n")).toBe(true);
    expect(md).toContain("- 첫 줄  \n  둘째 줄");
  });

  it("근거 글·목록 항목 안 줄바꿈은 들여쓴 이어지는 줄, 표 칸은 <br>", () => {
    const md = blocksToMarkdown("t", [
      { type: "list", h: "목록", items: ["하나\n둘\n\n넷", "다음"] },
      { type: "table", h: "표", cols: ["a", "b"], rows: [["첫 줄\n둘째 줄", "x"]] },
      { type: "claims", h: "근거", items: [{ tag: "fact", text: "사실\n이어짐", refs: [1] }] },
      { type: "sources", h: "출처", items: [{ title: "문서", url: "https://a.dev" }] },
    ]);
    expect(md).toContain("- 하나  \n  둘\n\n  넷\n- 다음");
    expect(md).toContain("| 첫 줄<br>둘째 줄 | x |");
    expect(md).toContain("- [사실] 사실  \n  이어짐[^1]");
  });

  it("사람이 비운 칸은 건너뛴다 — 소제목 · 문단 · 목록 항목 · 근거 줄 · 판정 · 캡션. 표 칸은 빈 칸, 출처 제목이 비면 주소만", () => {
    const md = blocksToMarkdown("제목", [
      { type: "verdict", v: "", w: "풀이만" },
      { type: "text", h: "", body: "문단" },
      { type: "text", h: "소제목만", body: "" },
      { type: "text", body: "" },
      { type: "list", h: "", items: ["하나", "", "셋"] },
      { type: "list", h: "다 비운 목록", items: ["", ""] },
      { type: "table", h: "", cols: ["a", ""], rows: [["", "2"]] },
      { type: "claims", h: "", items: [{ tag: "fact", text: "", refs: [1] }, { tag: "guess", text: "남는 근거", refs: [] }] },
      { type: "sources", h: "", items: [{ title: "", url: "https://a.dev/x" }, { title: "둘째", url: "https://b.dev" }] },
      { type: "image", src: sampleImage().src, w: 10, h: 10, alt: "", caption: "", place: "full", credit: "직접 캡처" },
    ], { agent: "", date: "10월 2일" });
    expect(md).toBe(
      [
        "# 제목",
        "10월 2일",
        "> 풀이만",
        "문단",
        "## 소제목만",
        "- 하나\n- 셋",
        "## 다 비운 목록",
        "| a |  |\n| --- | --- |\n|  | 2 |",
        "- [추정] 남는 근거",
        "[^1]: <https://a.dev/x>\n[^2]: [둘째](<https://b.dev/>)",
        "![]()",
      ].join("\n\n") + "\n",
    );
    expect(md).not.toContain("##\n");
    // 판정을 다 비우면 줄이 없다. 작성자가 없으면(null) 날짜만
    expect(blocksToMarkdown("t", [{ type: "verdict", v: "", w: "" }, { type: "text", body: "글" }], { agent: null, date: "오늘" })).toBe("# t\n\n오늘\n\n글\n");
    expect(blocksToMarkdown("t", [{ type: "verdict", v: "한 줄", w: "" }])).toBe("# t\n\n> **한 줄**\n");
  });

  it("사진: ![설명](출처 링크) + 캡션 한 줄. 출처 링크가 없으면 ()", () => {
    const md = blocksToMarkdown("t", [
      ...sampleBlocks(),
      sampleImage({ alt: "첫 [화면]" }),
      sampleImage({ ref: undefined, credit: "직접 캡처", caption: undefined, local_path: "C:/a.png" }),
    ]);
    expect(md).toContain("![첫 \\[화면\\]](<https://pglite.dev/docs/>)  \n문서 첫 화면\n");
    expect(md).toContain("![PGlite 문서 첫 화면]()\n");
    expect(md).not.toContain("C:/a.png");
    expect(md).not.toContain(".webp");
  });

  it("==강조== 는 **강조** — 모든 글 칸. 판정 한 줄은 통째로 굵게라 표시만 뺀다. 짝 없는 == 는 그대로", () => {
    const md = blocksToMarkdown("t", [
      { type: "verdict", v: "==A== 를 쓴다", w: "==무료==이고 문서가 좋다" },
      { type: "text", h: "==배경==", body: "앞 ==강조== 뒤 == 짝 없음" },
      { type: "list", h: "목록", items: ["==하나=="] },
      { type: "table", h: "표", cols: ["==열==", "b"], rows: [["==칸|a==", "2"]] },
      { type: "claims", h: "근거", items: [{ tag: "fact", text: "==사실==이다", refs: [1] }] },
      { type: "sources", h: "출처", items: [{ title: "==문서==", url: "https://a.dev" }] },
    ]);
    expect(md).toContain("> **A 를 쓴다**\n>\n> **무료**이고 문서가 좋다");
    expect(md).toContain("## **배경**\n\n앞 **강조** 뒤 == 짝 없음");
    expect(md).toContain("- **하나**");
    expect(md).toContain("| **열** | b |");
    expect(md).toContain("| **칸\\|a** | 2 |");
    expect(md).toContain("- [사실] **사실**이다[^1]");
    expect(md).toContain("[^1]: [**문서**](<https://a.dev/>)");
    expect(md.split("==").length).toBe(2); // 짝 없는 것 하나만 남는다
  });
});
