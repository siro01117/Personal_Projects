// 확인 모드 데이터 — 폴더 3개(하나는 빈 폴더, 하나는 안쪽), 보고서 4개(하나는 블록 종류 전부), 안 읽음 섞음.
// 개발 모드에서만 불린다 (source.ts 가 NODE_ENV 로 막는다).

import { sampleBlocks } from "../../lib/fixtures";
import { cachedDrawer, DataCache } from "./cache";
import { MemoryLive } from "./liveMemory";
import { MemoryDrawer, type Seed, type ViewSeed } from "./memory";
import { meetSeed } from "./meetDemo";
import { MemoryMeet } from "./meetMemory";
import { scheduleSeed } from "./scheduleDemo";
import { MemorySchedule } from "./scheduleMemory";
import type { Auth, Presence, Source } from "./types";

/** 공유 페이지 확인용 고정 열쇠: /s/demo-shared-link-0001?demo=1 */
export const DEMO_SHARE_TOKEN = "demo-shared-link-00001";

/** 사진 공유 페이지 확인용: /s/demo-photo-link-000001?demo=1 — local_path 가 빠지는지 */
export const DEMO_PHOTO_TOKEN = "demo-photo-link-000001";

// 확인 모드 사진: public/demo/<sha256>.webp (진짜 버킷 경로 모양 <주인>/<sha>.webp 를 그 주소로 바꿔 보여 준다)
const DEMO_OWNER = "d0000000-0000-4000-8000-0000000000aa";
// edge: MCP 가 재는 가장자리 밝기(mcp/images.ts edgeLuminance)를 이 파일들에 돌려 적었다
const PICS = {
  portrait: { sha: "6eeb1c254c7b8ad5448e0db1a5b49613b80c7126d0e50051f680c99d7adbb21d", w: 900, h: 1200 },
  screen: { sha: "4121404b1bc773d3811cf2dfd10cb84ca406476b5b5553b3b91f2423dbd577e2", w: 1280, h: 800, edge: "dark" },
  chart: { sha: "dacebad4d97e511644776d5b7b53a6b8359d63790b07dc721ff2af16df7bca11", w: 1280, h: 540, edge: "light" },
} as const;
const pic = (k: keyof typeof PICS) => {
  const p: { sha: string; w: number; h: number; edge?: "light" | "dark" } = PICS[k];
  return { src: `${DEMO_OWNER}/${p.sha}.webp`, w: p.w, h: p.h, ...(p.edge ? { edge: p.edge } : {}) };
};
export const DEMO_IMAGES: Record<string, string> = Object.fromEntries(
  Object.values(PICS).map((p) => [`${DEMO_OWNER}/${p.sha}.webp`, `/demo/${p.sha}.webp`]),
);

const LONG =
  "사진이 글과 같은 행에 서면 설명을 읽으면서 바로 옆의 그림을 볼 수 있다. 노션처럼 위아래로만 쌓으면 긴 보고서에서 그림과 설명이 멀어진다. " +
  "옆 사진은 ==바로 다음 글 하나와 짝==을 지어 2칸 행이 된다. 글이 사진 아래로 흘러 내려가지 않으니 한 행에 객체가 셋 서는 일이 없다.\n" +
  "배치는 에이전트가 블록 속성으로 적는다. 사람은 설명과 캡션 글자만 고칠 수 있다.";

function seed(now: Date): Seed[] {
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  return [
    {
      id: "d0000000-0000-4000-8000-000000000015",
      kind: "report",
      name: "사진 배치 확인",
      parent_id: "d0000000-0000-4000-8000-000000000001",
      report_kind: "reference",
      agent: "Claude Code",
      agent_updated_at: ago(60 * 24 * 9),
      created_at: ago(60 * 24 * 12),
      read_at: ago(60 * 24 * 8),
      share_token: DEMO_PHOTO_TOKEN,
      blocks: [
        { type: "verdict", v: "사진은 글과 같은 행에 세우되, 한 행에 객체는 둘까지", w: "옆 사진은 ==바로 다음 글과 2칸 행==을 이루고, 짝이 없으면 혼자 한쪽에 선다. 전체는 행을 다 쓴다." },
        { type: "image", ...pic("portrait"), alt: "산과 해가 있는 세로 그림", caption: "왼쪽 1/3 — 출처 번호", place: "left", size: "1/3", ref: 1 },
        { type: "text", h: "2칸 행", body: LONG },
        { type: "image", ...pic("screen"), alt: "앱 화면 캡처", place: "right", size: "1/2", credit: "직접 캡처" },
        {
          type: "list",
          h: "규칙",
          items: ["place: left · right · full", "size: 사진 칸 비율 1/3 · 1/2 · 2/3 (full 이면 무시)", "짝이 되는 다음 블록: ==문단 · 목록 · 근거==", "출처: ref · credit · local_path 중 하나 이상"],
        },
        { type: "image", ...pic("portrait"), alt: "산과 해가 있는 세로 그림", caption: "오른쪽 1/3 — 다음이 표라 혼자 선다", place: "right", size: "1/3", credit: "직접 그림" },
        {
          type: "table",
          h: "배치별 폭",
          cols: ["배치", "폭", "폰"],
          rows: [
            ["left / right", "사진 칸 1/3 · 1/2 · 2/3, 나머지는 글 칸", "==위아래로 쌓음=="],
            ["full", "행 전체", "그대로"],
          ],
        },
        { type: "text", h: "읽는 행", body: "보고서 본문은 넓은 화면에서도 ==최대 약 920px==, 가운데에 둔다. 표만 넘치면 가로로 밀어 본다." },
        {
          type: "image",
          ...pic("chart"),
          alt: "막대 12개 그래프",
          caption: "전체 폭 — 내 PC 원본",
          place: "full",
          local_path: "C:/Users/PC/Pictures/캡처/2026-09-30 막대 그래프.png",
        },
        {
          type: "claims",
          h: "근거",
          items: [
            { tag: "fact", text: "칸으로 나눈 행은 ==폰으로 옮기기 쉽다== — 데이터 순서대로 위아래로 쌓으면 된다", refs: [1] },
            { tag: "guess", text: "어울림보다 사진과 설명의 짝이 분명하게 읽힐 것이다", refs: [] },
          ],
        },
        { type: "sources", h: "출처", items: [{ title: "한글 워드프로세서 개체 배치", url: "https://www.hancom.com/" }] },
      ],
    },
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

/** 공유 중인 보고서(열쇠 DEMO_SHARE_TOKEN)의 id */
const SHARED_ID = "d0000000-0000-4000-8000-000000000013";
/** 표본 기기 열쇠 (22자) */
const dev = (n: number) => `demo-device-${String(n).padStart(10, "0")}`;

/** 읽은 사람 표본: 지금 보는 중 둘(핑 기준) + 지난 것들 */
function viewSeed(now: Date): ViewSeed[] {
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000).toISOString();
  const row = (n: number, name: string | null, firstSec: number, lastSec: number, hits: number, seconds: number, ua: string): ViewSeed => ({
    item_id: SHARED_ID,
    device: dev(n),
    guest_no: n,
    name,
    first_at: ago(firstSec),
    last_at: ago(lastSec),
    hits,
    seconds,
    ua,
  });
  return [
    row(1, "민서", 60 * 60 * 24 * 3, 20, 4, 1260, "PC · Chrome"),
    row(2, null, 60 * 60 * 2, 45, 1, 95, "폰 · Safari"),
    row(3, "도윤", 60 * 60 * 24 * 2, 60 * 60 * 5, 2, 40, "폰 · Chrome"),
    row(4, null, 60 * 60 * 24, 60 * 60 * 23, 1, 610, "PC · Edge"),
    row(5, "Jae", 60 * 60 * 24 * 6, 60 * 60 * 24 * 2, 3, 200, "태블릿 · Safari"),
  ];
}

/** 라이브 표본: 핑 기준 둘이 presence 에도 있다 (게스트 2 는 블록을 옮겨 다닌다) */
const liveSamples = (): Record<string, Presence[]> => ({
  [DEMO_SHARE_TOKEN]: [
    { device: dev(2), label: "게스트 2", block: 2 },
    { device: dev(1), label: "민서", block: 0 },
  ],
});

let instance: MemoryDrawer | null = null;

export function demoDrawer(): MemoryDrawer {
  if (!instance) {
    const now = new Date();
    instance = new MemoryDrawer(seed(now), { latency: 150, images: DEMO_IMAGES, views: viewSeed(now) });
  }
  return instance;
}

let liveInstance: MemoryLive | null = null;

export function demoLive(): MemoryLive {
  if (!liveInstance) liveInstance = new MemoryLive({ samples: liveSamples(), wanderMs: 5000, wanderBlocks: 5 });
  return liveInstance;
}

let scheduleInstance: MemorySchedule | null = null;

export function demoSchedule(): MemorySchedule {
  if (!scheduleInstance) scheduleInstance = new MemorySchedule(scheduleSeed(new Date()), { latency: 150 });
  return scheduleInstance;
}

let meetInstance: MemoryMeet | null = null;

/** 모임은 같은 확인 모드의 일정 저장소에 약속을 넣는다 */
export function demoMeet(): MemoryMeet {
  if (!meetInstance) meetInstance = new MemoryMeet(demoSchedule(), meetSeed(new Date()), { latency: 150 });
  return meetInstance;
}

/** 확인 모드 캐시: 메모리만 (저장소에 안 남긴다 — 새로 고치면 데이터도 처음으로 돌아가니까). 진짜 캐시와 따로 */
const demoCache = new DataCache(null, "demo");

const demoAuth: Auth = {
  signedIn: async () => true,
  signIn: async () => {},
  signOut: async () => {},
  onSignedOut: () => () => {},
};

export function demoSource(): Source {
  const data = demoDrawer();
  const schedule = demoSchedule();
  const meet = demoMeet();
  // 에이전트가 그 사이 고치거나 넣은 것을 흉내 — 브라우저 콘솔에서 ezDemo.touch('<보고서 id>'), ezDemo.insert(),
  // ezDemo.bumpEvent('<일정 id>') (다른 곳에서 일정을 고친 것처럼 버전만 올림)
  if (typeof window !== "undefined") {
    (window as unknown as { ezDemo: unknown }).ezDemo = {
      data,
      schedule,
      meet,
      touch: (id: string) => data.agentTouch(id),
      insert: (parentId: string | null = null) => data.agentInsert(parentId, "에이전트가 넣은 보고서", sampleBlocks()),
      bumpEvent: (id: string) => schedule.bump(id),
    };
  }
  return { data: cachedDrawer(data, demoCache), schedule, planner: schedule, meet, meetPublic: meet, live: demoLive(), auth: demoAuth, demo: true, cache: demoCache };
}
