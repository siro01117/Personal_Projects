// 확인 모드 데이터 — 폴더 3개(하나는 빈 폴더, 하나는 안쪽), 보고서 4개(하나는 블록 종류 전부), 안 읽음 섞음.
// 개발 모드에서만 불린다 (source.ts 가 NODE_ENV 로 막는다).

import { sampleBlocks } from "../../lib/fixtures";
import { MemoryDrawer, type Seed } from "./memory";
import type { Auth, Source } from "./types";

/** 공유 페이지 확인용 고정 열쇠: /s/demo-shared-link-0001?demo=1 */
export const DEMO_SHARE_TOKEN = "demo-shared-link-00001";

function seed(now: Date): Seed[] {
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  return [
    { id: "d0000000-0000-4000-8000-000000000001", kind: "folder", name: "EZ.WORK 준비" },
    { id: "d0000000-0000-4000-8000-000000000002", kind: "folder", name: "APPTIVE" },
    {
      id: "d0000000-0000-4000-8000-000000000011",
      kind: "report",
      name: "DB 시험 방법 조사",
      parent_id: "d0000000-0000-4000-8000-000000000001",
      report_kind: "method",
      blocks: sampleBlocks(),
      agent: "Claude Code",
      agent_updated_at: ago(30),
      read_at: null,
    },
    // 깊은 폴더 속 안 읽은 보고서 — 위 폴더들에도 점이 번진다. 블록 8개 이상이라 차례 레일이 보인다
    { id: "d0000000-0000-4000-8000-000000000003", kind: "folder", name: "자료", parent_id: "d0000000-0000-4000-8000-000000000001" },
    {
      id: "d0000000-0000-4000-8000-000000000014",
      kind: "report",
      name: "PGlite 자세히",
      parent_id: "d0000000-0000-4000-8000-000000000003",
      report_kind: "data",
      agent: "Claude Code",
      agent_updated_at: ago(5),
      read_at: null,
      blocks: [...sampleBlocks(), { type: "text", h: "덧붙임", body: "차례 레일은 블록이 8개 이상일 때만 보인다." }],
    },
    {
      id: "d0000000-0000-4000-8000-000000000012",
      kind: "report",
      name: "개인용 올인원 ERP 서비스 조사",
      parent_id: "d0000000-0000-4000-8000-000000000001",
      report_kind: "reference",
      agent: "Claude Code",
      agent_updated_at: ago(60 * 26),
      read_at: ago(60 * 20),
      blocks: [
        { type: "verdict", v: "기능 조합은 넘치고, 이 조합 그대로는 없다", w: "문서·DB·프로젝트·캘린더는 노션이 거의 완결했다. 기능으로 겨루면 진다." },
        {
          type: "list",
          h: "요약",
          items: ["노션은 메일·폼·회의록·에이전트까지 붙였다.", "ClickUp 은 다 하려다 전부 그저 괜찮은 수준이 됐다는 평.", "Coda 는 독립 올인원으로 살아남지 못했다."],
        },
        {
          type: "sources",
          h: "출처",
          items: [
            { title: "Notion will never replace most dedicated tools — XDA", url: "https://www.xda-developers.com/reasons-notion-will-never-replace-most-dedicated-tools/" },
            { title: "Coda becomes Superhuman Docs", url: "https://help.superhuman.com/hc/en-us/articles/46210093285773-What-s-changing-Coda-becomes-Superhuman-Docs" },
          ],
        },
      ],
    },
    {
      id: "d0000000-0000-4000-8000-000000000013",
      kind: "report",
      name: "기획·일정 도구 9종 비교",
      parent_id: null,
      report_kind: "data",
      agent: "Claude Code",
      agent_updated_at: ago(60 * 24 * 3),
      read_at: null,
      share_token: DEMO_SHARE_TOKEN,
      blocks: [
        { type: "verdict", v: "진짜 틈은 기능 개수가 아니라 이어짐", w: "투두·프로젝트 관리·암기 앱은 무료로 충분하다." },
        { type: "list", h: "남은 빈칸", items: ["의견을 결정·할 일로 옮기는 단계", "IA·플로우와 프로젝트가 같은 것을 가리키는 것", "시간을 맞춘 뒤의 모임 기록"] },
        // 화면이 모르는 블록 — 자리표시가 나와야 한다
        { type: "timeline", h: "다음 버전 블록", items: [] },
        { type: "sources", h: "출처", items: [{ title: "When2meet alternatives — Cal.com", url: "https://cal.com/blog/when2meet-alternatives" }] },
      ],
    },
  ];
}

let instance: MemoryDrawer | null = null;

export function demoDrawer(): MemoryDrawer {
  if (!instance) instance = new MemoryDrawer(seed(new Date()), { latency: 150 });
  return instance;
}

const demoAuth: Auth = {
  signedIn: async () => true,
  signIn: async () => {},
  signOut: async () => {},
  onSignedOut: () => () => {},
};

export function demoSource(): Source {
  const data = demoDrawer();
  // 에이전트가 그 사이 고치거나 넣은 것을 흉내 — 브라우저 콘솔에서 ezDemo.touch('<보고서 id>'), ezDemo.insert()
  if (typeof window !== "undefined") {
    (window as unknown as { ezDemo: unknown }).ezDemo = {
      data,
      touch: (id: string) => data.agentTouch(id),
      insert: (parentId: string | null = null) => data.agentInsert(parentId, "에이전트가 넣은 보고서", sampleBlocks()),
    };
  }
  return { data, auth: demoAuth, demo: true };
}
