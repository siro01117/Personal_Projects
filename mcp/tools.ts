// MCP 도구 등록: 이름·설명·입력 모양. 로직은 drawer.ts(보고서 6개, docs/보고서-서랍.md 4장)와
// schedule.ts(일정 4개 · 플래너 2개, docs/일정.md 5장 · docs/플래너.md 4장).
// 도구 설명은 매번 에이전트 컨텍스트에 실리므로 짧게 쓴다.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { reportKindSchema } from "../lib/blocks";
import type { Drawer, ToolResult } from "./drawer";
import type { Schedule } from "./schedule";

export const DRAWER_TOOLS = ["drawer_list", "drawer_mkdir", "drawer_update", "report_create", "report_get", "report_edit"] as const;
export const SCHEDULE_TOOLS = ["schedule_get", "schedule_save", "schedule_delete", "schedule_sync", "todo_list", "todo_save"] as const;
export const TOOL_NAMES = [...DRAWER_TOOLS, ...SCHEDULE_TOOLS] as const;

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
- {type:"image", file, crop?, alt, place, size?, caption?, ref?, credit?} 사진. file = PC 사진 절대 경로(줄여 올리고 src·w·h·local_path 를 채움). crop:{x,y,w,h}(원본 픽셀)으로 보여줄 부분만 잘라 올릴 것 — 화면 캡처는 통째로 넣지 말 것. alt 설명 ≤300자. place: left|right(바로 다음 text·list·claims 와 한 행 2칸, 아니면 사진 혼자 한쪽)|full(행 전체), size: 사진 칸 비율 "1/3"|"1/2"|"2/3". 출처 ref(출처 번호)·credit(예: 직접 캡처) 중 하나 — 없으면 local_path 가 출처
글 안 ==…== 는 굵게 강조(아껴 쓸 것).
h(소제목) ≤200자. 블록 1~200개, 전체 약 580KB 까지(넘으면 두 보고서로 나눈다). 틀리면 "blocks[2].rows[3]: 이유" 목록이 돌아온다.
예: [{"type":"verdict","v":"A 를 쓴다","w":"무료이고 문서가 좋다"},{"type":"claims","h":"근거","items":[{"tag":"fact","text":"A 는 무료다","refs":[1]},{"tag":"guess","text":"B 보다 빠를 것이다","refs":[]}]},{"type":"sources","h":"출처","items":[{"title":"A 문서","url":"https://a.dev/docs"}]}]`;

export function registerTools(server: McpServer, drawer: Drawer, schedule: Schedule): void {
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

  registerScheduleTools(server, schedule, call);
}

// ---------------------------------------------------------------------------
// 일정 · 플래너

const DATE = "YYYY-MM-DD";
const HM = "HH:MM";
const repeatSchema = z
  .object({
    freq: z.enum(["daily", "weekly"]),
    days: z.array(z.union([z.string(), z.number().int()])).optional().describe('요일 ["월","수"]'),
    until: z.string().nullable().optional().describe(`끝나는 날 ${DATE} (그날 포함)`),
  })
  .nullable();

function registerScheduleTools(
  server: McpServer,
  schedule: Schedule,
  call: (p: Promise<ToolResult>) => Promise<CallToolResult>,
): void {
  server.registerTool(
    "schedule_get",
    {
      title: "일정 보기",
      description:
        "from~to(62일까지) 날짜별 일정 회차 + 계산된 준비·이동 띠(늦음)·식사. free_min 을 주면 그 길이 이상 빈 시간(07~24시, 동선 뺌). 시각 HH:MM, 다음 날은 +1. 지점 목록도 준다.",
      inputSchema: {
        from: z.string().describe(DATE),
        to: z.string().describe(`${DATE} (포함)`),
        free_min: z.number().int().optional().describe("빈 시간 최소 길이(분)"),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => call(schedule.schedule_get(a)),
  );

  server.registerTool(
    "schedule_save",
    {
      title: "일정 넣기·고치기",
      description:
        "id 없으면 새 일정(title·date + start/end 또는 all_day). 고칠 땐 id+base_version, 준 칸만 바뀜. end≤start 면 다음 날. place 는 지점 이름(null=없음). 반복 회차는 on_date+scope(once 이번만·following 이후 모두·all 전체). task_id 로 할 일과 잇는다(길이 기본=est_min). 바깥 일정은 못 고침.",
      inputSchema: {
        id: z.string().optional().describe("고칠 일정 id"),
        base_version: z.number().int().optional().describe("고칠 때 schedule_get 의 version"),
        on_date: z.string().optional().describe(`반복 회차 날짜 ${DATE}`),
        scope: z.enum(["once", "following", "all"]).optional(),
        title: z.string().optional(),
        date: z.string().optional().describe(DATE),
        start: z.string().optional().describe(HM),
        end: z.string().optional().describe(HM),
        all_day: z.boolean().optional(),
        place: z.string().nullable().optional().describe("지점 이름"),
        where: z.string().nullable().optional().describe("상세 장소 글"),
        travel_min: z.number().int().nullable().optional().describe("이 일정만의 이동시간(분)"),
        note: z.string().nullable().optional(),
        repeat: repeatSchema.optional(),
        task_id: z.string().nullable().optional().describe("이을 할 일 id (null=끊기)"),
      },
    },
    (a) => call(schedule.schedule_save(a)),
  );

  server.registerTool(
    "schedule_delete",
    {
      title: "일정 지우기",
      description: "일정 지우기. 반복이면 on_date+scope(once·following·all). 바깥 일정은 못 지움.",
      inputSchema: {
        id: z.string(),
        on_date: z.string().optional().describe(`반복 회차 날짜 ${DATE}`),
        scope: z.enum(["once", "following", "all"]).optional(),
      },
      annotations: { destructiveHint: true },
    },
    (a) => call(schedule.schedule_delete(a)),
  );

  server.registerTool(
    "schedule_sync",
    {
      title: "바깥 일정 맞추기",
      description:
        "바깥 일정 source(예: studycube)의 from~to 를 events 로 갈아끼운다. external_id 가 같으면 고치고, 빠진 것은 지우고, 새 것은 넣는다. 하나라도 틀리면 아무것도 안 바꾸고 자리·이유 목록. 200일·500개까지.",
      inputSchema: {
        source: z.string().describe("영문 소문자·숫자·_·-"),
        from: z.string().describe(DATE),
        to: z.string().describe(`${DATE} (포함)`),
        events: z
          .array(
            z.object({
              external_id: z.string().optional(),
              title: z.string().optional(),
              date: z.string().optional(),
              start: z.string().optional(),
              end: z.string().optional(),
              all_day: z.boolean().optional(),
              place: z.string().nullable().optional(),
              where: z.string().nullable().optional(),
              travel_min: z.number().int().nullable().optional(),
              note: z.string().nullable().optional(),
              repeat: repeatSchema.optional(),
            }),
          )
          .describe("{external_id, title, date, start, end | all_day, place?, where?, note?, repeat?}"),
        label: z.string().optional().describe("출처 표시 이름 (예: 스터디큐브)"),
      },
      annotations: { idempotentHint: true },
    },
    (a) => call(schedule.schedule_sync(a)),
  );

  server.registerTool(
    "todo_list",
    {
      title: "할 일 목록",
      description:
        "플래너 할 일. status: open(기본)·done·all·rules(반복 규칙). query 는 제목·메모에서 찾기. role 은 역할 이름으로 거르기. 이어진 일정·지점·역할·체크 항목·late(지난 것)·repeat(+rule_id)도 준다. 부를 때 반복 규칙의 새 회차가 생긴다.",
      inputSchema: {
        status: z.enum(["open", "done", "all", "rules"]).optional(),
        query: z.string().optional(),
        role: z.string().nullable().optional().describe('역할 이름 (null·"없음"=역할 없는 것만)'),
      },
      // 부를 때 ez_tasks_roll 이 새 회차를 만들므로 읽기 전용이 아니다. 같은 때 다시 불러도 더 생기지는 않는다
      annotations: { idempotentHint: true },
    },
    (a) => call(schedule.todo_list(a)),
  );

  server.registerTool(
    "todo_save",
    {
      title: "할 일 넣기·고치기",
      description:
        "id 없으면 새 할 일(맨 위). 고칠 땐 id+base_version. done true/false 로 끝냄·되돌림, delete true 로 지우기. 시간 정하기는 schedule_save(task_id). repeat 를 주면 반복 규칙이 생긴다(after_event 는 규칙만). 규칙에서 온 할 일은 scope(once 이것만·rule 규칙도). 규칙만: rule_id+칸(base_version) 또는 stop.",
      inputSchema: {
        id: z.string().optional(),
        base_version: z.number().int().optional().describe("고칠 때 todo_list 의 version"),
        title: z.string().optional(),
        note: z.string().nullable().optional(),
        due: z.string().nullable().optional().describe(`마감 ${DATE}`),
        est_min: z.number().int().nullable().optional().describe("걸릴 시간(분) 5~600"),
        done: z.boolean().optional(),
        delete: z.boolean().optional(),
        place: z.string().nullable().optional().describe("지점 이름"),
        role: z.string().nullable().optional().describe("역할 이름 (null=없음). 안 주면 지점에서 채움"),
        checklist: z
          .array(z.union([z.string(), z.object({ t: z.string(), done: z.boolean().optional() })]))
          .nullable()
          .optional()
          .describe("체크 항목 0~20개: 글자 또는 {t, done}. 통째로 갈아끼움"),
        due_event: z
          .object({ id: z.string(), on_date: z.string().optional().describe(`반복 일정이면 회차 날짜 ${DATE}`) })
          .nullable()
          .optional()
          .describe("이 일정 날짜를 마감으로 (null=끊기)"),
        repeat: z
          .object({
            freq: z.enum(["daily", "weekly"]).optional(),
            days: z.array(z.union([z.string(), z.number().int()])).optional().describe('요일 ["월"]'),
            after_event: z.string().optional().describe("반복 일정 id — 회차가 끝날 때마다"),
          })
          .optional(),
        due_after: z.number().int().nullable().optional().describe("반복: 생긴 날부터 마감까지 며칠 0~60"),
        scope: z.enum(["once", "rule"]).optional(),
        rule_id: z.string().optional().describe("반복 규칙 id (todo_list status: rules)"),
        stop: z.boolean().optional().describe("rule_id 와 같이: 반복 멈춤"),
      },
    },
    (a) => call(schedule.todo_save(a)),
  );
}
