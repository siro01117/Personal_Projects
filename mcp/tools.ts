// MCP 도구 등록: 이름·설명·입력 모양 (설계서 4장). 로직은 drawer.ts.
// 도구 설명은 매번 에이전트 컨텍스트에 실리므로 짧게 쓴다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { reportKindSchema } from "../lib/blocks";
import type { Drawer, ToolResult } from "./drawer";

export const TOOL_NAMES = ["drawer_list", "drawer_mkdir", "drawer_update", "report_create", "report_get", "report_edit"] as const;

export function toCallResult(r: ToolResult): CallToolResult {
  return {
    content: [
      { type: "text", text: r.summary },
      { type: "text", text: JSON.stringify(r.data) },
    ],
    ...(r.ok ? {} : { isError: true }),
  };
}

const PATH_NOTE = "경로는 / 로 시작 (예: /EZ.WORK 준비/APPTIVE). 이름 대소문자는 무시";

const BLOCKS_HELP = `블록 어휘 v1 — 정해진 칸만 쓴다. 글자는 앞뒤 공백을 지운 뒤 비면 안 되고, 화면에는 텍스트로만 나온다(마크다운·HTML 해석 안 함).
- {type:"verdict", v, w?} 판정. v 한 줄 ≤300자, w 풀이 ≤2000자. 보고서당 1개까지
- {type:"text", h?, body} 문단. body ≤4000자
- {type:"list", h, items:[글]} 1~30개, 각 ≤600자
- {type:"table", h, cols:[글], rows:[[글]]} 열 2~8, 행 1~60, 모든 행의 칸 수 = 열 수, 칸 ≤300자
- {type:"claims", h, items:[{tag, text, refs}]} 1~50개. tag: fact(사실)|guess(추정). text ≤600자. refs: sources 의 출처 번호 배열(1부터, 없으면 [])
- {type:"sources", h, items:[{title, url}]} 1~100개, url 은 http/https 만. 보고서당 1개까지
- {type:"image", file, alt, place, size?, caption?, ref?, credit?} 사진. file = PC 사진 절대 경로(줄여 올리고 src·w·h·local_path 를 채움). alt 설명 ≤300자. place: left|right(글이 옆으로 흐름)|full, size: "1/3"|"1/2"|"2/3". 출처 ref(출처 번호)·credit(예: 직접 캡처) 중 하나 — 없으면 local_path 가 출처
h(소제목) ≤200자. 블록 1~200개, 전체 약 580KB 까지(넘으면 두 보고서로 나눈다). 틀리면 "blocks[2].rows[3]: 이유" 목록이 돌아온다.
예: [{"type":"verdict","v":"A 를 쓴다","w":"무료이고 문서가 좋다"},{"type":"claims","h":"근거","items":[{"tag":"fact","text":"A 는 무료다","refs":[1]},{"tag":"guess","text":"B 보다 빠를 것이다","refs":[]}]},{"type":"sources","h":"출처","items":[{"title":"A 문서","url":"https://a.dev/docs"}]}]`;

export function registerTools(server: McpServer, drawer: Drawer): void {
  const call = async (p: Promise<ToolResult>) => toCallResult(await p);

  server.registerTool(
    "drawer_list",
    {
      title: "서랍 목록",
      description: `보고서 서랍의 폴더 안 목록 (폴더 먼저, 이름순). query 를 주면 제목·본문에서 찾는다(path 아래, 최대 20개). ${PATH_NOTE}. 없는 경로면 가장 가까운 폴더와 그 안 목록을 알려준다.`,
      inputSchema: {
        path: z.string().optional().describe("폴더 경로. 기본 /"),
        query: z.string().optional().describe("찾을 글자 (대소문자 무시)"),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => call(drawer.drawer_list(a)),
  );

  server.registerTool(
    "drawer_mkdir",
    {
      title: "폴더 만들기",
      description: `폴더를 만든다. 중간 폴더도 같이 만들고, 이미 있으면 그대로 성공(created: false). 폴더는 8단까지. ${PATH_NOTE}.`,
      inputSchema: { path: z.string().describe("만들 폴더 경로") },
      annotations: { idempotentHint: true },
    },
    (a) => call(drawer.drawer_mkdir(a)),
  );

  server.registerTool(
    "drawer_update",
    {
      title: "옮기기·이름 바꾸기·지우기",
      description: `폴더나 보고서를 옮기거나(move_to) 이름을 바꾸거나(rename) 휴지통으로 보낸다(delete: true, 폴더면 안의 것까지). delete 는 다른 것과 같이 못 쓴다. 옮길 곳에 같은 이름이 있으면 "이름 (2)" 로 옮기고 알려준다. rename 은 겹치면 거절한다. target 은 id(uuid) · 경로 · 웹 링크. ${PATH_NOTE}.`,
      inputSchema: {
        target: z.string().describe("id · 경로 · 웹 링크"),
        move_to: z.string().optional().describe("옮길 폴더 경로 (/ 는 맨 위)"),
        rename: z.string().optional().describe("새 이름"),
        delete: z.boolean().optional().describe("true 면 휴지통으로"),
      },
      annotations: { destructiveHint: true },
    },
    (a) => call(drawer.drawer_update(a)),
  );

  server.registerTool(
    "report_create",
    {
      title: "보고서 넣기",
      description: `서칭 보고서 한 편을 블록 배열로 넣는다. folder 는 이미 있어야 한다(없으면 drawer_mkdir 먼저). 같은 제목이 있으면 "제목 (2)" 로 넣고 알려준다.
kind: method(작업 방식 조사) · data(데이터 조사) · reference(레퍼런스 조사)
${BLOCKS_HELP}`,
      inputSchema: {
        title: z.string().describe("보고서 제목 (1~100자, / 금지)"),
        kind: reportKindSchema.describe("method · data · reference"),
        folder: z.string().describe("넣을 폴더 경로"),
        blocks: z.array(z.unknown()).describe("블록 배열 (설명의 블록 어휘 v1)"),
      },
    },
    (a) => call(drawer.report_create(a)),
  );

  server.registerTool(
    "report_get",
    {
      title: "보고서 읽기",
      description:
        "보고서 읽기. 범위 없이 부르면 차례(outline)·판정·version 만 준다. 내용은 from·to(0부터, to 포함)로 필요한 블록만 읽는다.",
      inputSchema: {
        id: z.string().describe("보고서 id (uuid) 또는 웹 링크"),
        from: z.number().int().optional().describe("첫 블록 번호 (0부터)"),
        to: z.number().int().optional().describe("끝 블록 번호 (포함)"),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => call(drawer.report_get(a)),
  );

  server.registerTool(
    "report_edit",
    {
      title: "보고서 고치기",
      description: `보고서 블록을 넣기·바꾸기·빼기. ops 는 앞에서부터 차례로 적용되고(앞 op 가 번호를 바꾼다), 결과 전체가 블록 어휘 v1 검사를 통과해야 저장된다. base_version 은 report_get 의 version — 그 사이 누가 고쳤으면 충돌과 현재 version 을 돌려준다.
op: {op:"insert", at, block} (at = 0~블록 수, 블록 수면 맨 끝) · {op:"replace", at, block} · {op:"remove", at}. 사진 블록은 report_create 처럼 file 로 준다`,
      inputSchema: {
        id: z.string().describe("보고서 id (uuid)"),
        base_version: z.number().int().describe("report_get 으로 받은 version"),
        ops: z
          .array(
            z.object({
              op: z.enum(["insert", "replace", "remove"]),
              at: z.number().int(),
              block: z.unknown().optional(),
            }),
          )
          .describe("차례로 적용할 편집"),
      },
    },
    (a) => call(drawer.report_edit(a)),
  );
}
