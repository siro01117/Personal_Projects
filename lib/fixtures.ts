// 시험용 서칭 보고서 — 설계서 3장의 모든 블록 종류를 쓴다.

export function sampleBlocks() {
  return [
    { type: "verdict", v: "PGlite 로 DB 시험을 돌린다", w: "도커 없이 트리거·RLS 까지 진짜 Postgres 로 확인된다." },
    { type: "text", h: "배경", body: "보고서 서랍의 무결성은 DB 가 막는다.\n그래서 DB 를 진짜로 돌려 봐야 한다." },
    { type: "text", body: "제목 없는 문단." },
    { type: "list", h: "후보", items: ["PGlite", "Docker Postgres", "Supabase 브랜치"] },
    {
      type: "table",
      h: "비교",
      cols: ["도구", "속도", "비용"],
      rows: [
        ["PGlite", "빠름", "0원"],
        ["Docker", "보통", "0원"],
      ],
    },
    {
      type: "claims",
      h: "근거",
      items: [
        { tag: "fact", text: "PGlite 는 WASM 으로 컴파일된 Postgres 다", refs: [1] },
        { tag: "guess", text: "Supabase 와 동작이 거의 같을 것이다", refs: [] },
        { tag: "fact", text: "RLS 도 돈다", refs: [1, 2] },
      ],
    },
    {
      type: "sources",
      h: "출처",
      items: [
        { title: "PGlite 문서", url: "https://pglite.dev/docs/" },
        { title: "Supabase RLS", url: "http://supabase.com/docs/guides/auth/row-level-security" },
      ],
    },
  ];
}
