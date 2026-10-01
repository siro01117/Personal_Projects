// 블록 어휘 v1 — 설계서 3장. 웹·MCP 가 같이 쓰는 유일한 정의.
// 사람이 고칠 수 있는 칸·길이 상한은 DB 함수 ez_edit_rule 과 같아야 한다 (db/ez_items.test.ts 가 맞춰 본다).

import { z } from "zod";
import { charCount, NAME_MAX } from "./names";

export const SCHEMA_VERSION = 1;

export const LIMITS = {
  blocks: { min: 1, max: 200 },
  /** JSON(UTF-8) 크기. DB 는 pg_column_size(blocks) < 600000 으로 막는다 — jsonb 가 JSON 보다 조금 커서 여유를 둔다 */
  bytes: 580_000,
  /** 작성자(agent 열) — DB ez_items_agent_check 와 같다 */
  agent: 100,
  heading: 200,
  verdict: { v: 300, w: 2000 },
  text: { body: 4000 },
  list: { items: { min: 1, max: 30 }, item: 600 },
  table: { cols: { min: 2, max: 8 }, rows: { min: 1, max: 60 }, cell: 300 },
  claims: { items: { min: 1, max: 50 }, text: 600, refs: { max: 20 } },
  sources: { items: { min: 1, max: 100 }, title: 300, url: 2000 },
  /** 사진: 긴 변 상한(px)은 MCP 가 줄이는 크기와 같다 */
  image: { side: 1280, alt: 300, caption: 300, credit: 100, localPath: 1000 },
} as const;

/** 사진 파일 경로: <주인 uuid>/<sha256 hex>.webp (Storage 버킷 ez-images 안) */
export const IMAGE_SRC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}\.webp$/;
export const IMAGE_PLACES = ["left", "right", "full"] as const;
export const IMAGE_SIZES = ["1/3", "1/2", "2/3"] as const;
/** 사진 가장자리가 아주 밝음·어두움 — MCP 가 올릴 때 재서 채운다. 같은 색 테마 화면에서 테두리를 그린다 */
export const IMAGE_EDGES = ["light", "dark"] as const;
export type ImageEdge = (typeof IMAGE_EDGES)[number];

export const REPORT_KINDS = {
  method: "작업 방식 조사",
  data: "데이터 조사",
  reference: "레퍼런스 조사",
} as const;
export type ReportKind = keyof typeof REPORT_KINDS;
export const reportKindSchema = z.enum(["method", "data", "reference"], {
  error: "보고서 종류는 method(작업 방식 조사) · data(데이터 조사) · reference(레퍼런스 조사) 중 하나입니다",
});

// ---------- 조각 ----------

const LINE_BREAK = /[\n\r\u2028\u2029]/;

function typeError(expected: string) {
  return (iss: { input?: unknown }) => (iss.input === undefined ? "필요한 칸이 빠졌습니다" : expected);
}

/** 앞뒤 공백 제거 → 빈 값 금지(blank 면 허용) → 길이(코드 포인트) 상한 */
function str(max: number, oneLine = false, blank = false) {
  return z
    .string({ error: typeError("글자여야 합니다") })
    .trim()
    .superRefine((v, ctx) => {
      if (v.length === 0) {
        if (!blank) ctx.addIssue({ code: "custom", message: "비어 있습니다" });
        return;
      }
      const n = charCount(v);
      if (n > max) ctx.addIssue({ code: "custom", message: `${max}자까지 쓸 수 있습니다 (지금 ${n}자)` });
      if (oneLine && LINE_BREAK.test(v)) ctx.addIssue({ code: "custom", message: "한 줄로 써야 합니다 (줄바꿈 없이)" });
      if (v.includes("\u0000")) ctx.addIssue({ code: "custom", message: "글자 \\u0000 은 쓸 수 없습니다" });
    });
}

function arr<T extends z.ZodType>(item: T, min: number, max: number) {
  return z.array(item, { error: typeError("목록(배열)이어야 합니다") }).superRefine((a, ctx) => {
    if (a.length < min) ctx.addIssue({ code: "custom", message: `${min}개 이상 있어야 합니다` });
    if (a.length > max) ctx.addIssue({ code: "custom", message: `${max}개까지 넣을 수 있습니다 (지금 ${a.length}개)` });
  });
}

function obj<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject(shape, {
    error: (iss) =>
      iss.code === "unrecognized_keys"
        ? `모르는 칸이 있습니다: ${(iss as { keys: string[] }).keys.join(", ")}`
        : typeError("객체({ … })여야 합니다")(iss),
  });
}

const url = z
  .string({ error: typeError("글자여야 합니다") })
  .trim()
  .superRefine((v, ctx) => {
    if (v.length === 0) return void ctx.addIssue({ code: "custom", message: "비어 있습니다" });
    const n = charCount(v);
    if (n > LIMITS.sources.url) {
      return void ctx.addIssue({ code: "custom", message: `주소는 ${LIMITS.sources.url}자까지 쓸 수 있습니다 (지금 ${n}자)` });
    }
    let u: URL | null = null;
    try {
      u = new URL(v);
    } catch {
      /* 아래에서 알림 */
    }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) {
      ctx.addIssue({ code: "custom", message: "주소는 http:// 또는 https:// 로 시작하는 웹 주소만 쓸 수 있습니다" });
    }
  });

const ref = z
  .number({ error: typeError("숫자여야 합니다") })
  .refine((n) => Number.isInteger(n) && n >= 1, { message: "출처 번호는 1 이상의 정수여야 합니다" });

// ---------- 블록 ----------

const H = LIMITS.heading;

const side = z
  .number({ error: typeError("숫자여야 합니다") })
  .refine((n) => Number.isInteger(n) && n >= 1 && n <= LIMITS.image.side, { message: `1~${LIMITS.image.side} 사이 정수여야 합니다` });

export const BLOCK_TYPES = ["verdict", "text", "list", "table", "claims", "sources", "image"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/**
 * 블록 스키마 한 벌. blank 면 **사람이 고칠 수 있는 문자열 칸**(editRule 이 인정하는 칸 — 아래 E)에 한해 빈 값('')을 받는다.
 * 사람은 칸을 비워 둘 수 있지만(설계서 3장), 에이전트가 새로 넣는 글자는 비면 안 된다.
 * 줄 규칙(한 줄·여러 줄)은 여기서 좁히지 않는다 — 사람 고치기 쪽 한 줄 규칙은 editRule 이 따로 정한다.
 */
function build(blank: boolean) {
  /** 사람이 고칠 수 있는 칸 */
  const E = (max: number, oneLine = false) => str(max, oneLine, blank);

  const verdictBlock = obj({
    type: z.literal("verdict"),
    v: E(LIMITS.verdict.v, true),
    w: E(LIMITS.verdict.w).optional(),
  });
  const textBlock = obj({
    type: z.literal("text"),
    h: E(H).optional(),
    body: E(LIMITS.text.body),
  });
  const listBlock = obj({
    type: z.literal("list"),
    h: E(H),
    items: arr(E(LIMITS.list.item), LIMITS.list.items.min, LIMITS.list.items.max),
  });
  const tableBlock = obj({
    type: z.literal("table"),
    h: E(H),
    cols: arr(E(LIMITS.table.cell), LIMITS.table.cols.min, LIMITS.table.cols.max),
    rows: arr(z.array(E(LIMITS.table.cell), { error: typeError("행은 배열이어야 합니다") }), LIMITS.table.rows.min, LIMITS.table.rows.max),
  });
  const claimsBlock = obj({
    type: z.literal("claims"),
    h: E(H),
    items: arr(
      obj({
        tag: z.enum(["fact", "guess"], { error: "tag 는 fact(사실) 또는 guess(추정) 입니다" }),
        text: E(LIMITS.claims.text),
        refs: arr(ref, 0, LIMITS.claims.refs.max),
      }),
      LIMITS.claims.items.min,
      LIMITS.claims.items.max,
    ),
  });
  const sourcesBlock = obj({
    type: z.literal("sources"),
    h: E(H),
    items: arr(obj({ title: E(LIMITS.sources.title), url }), LIMITS.sources.items.min, LIMITS.sources.items.max),
  });

  /**
   * 사진. 파일은 Storage 에, 블록에는 위치·크기·설명·출처만. 배치는 에이전트가 정한다(size 없으면 1/2, full 이면 size 무시).
   * 출처 ref · credit · local_path 중 하나 이상은 validateBlocks 가 본다 — 공유 페이지는 local_path 를 빼고 받으므로
   * 그리기용 blockSchema 는 출처 없이도 통과시킨다.
   */
  const imageBlock = obj({
    type: z.literal("image"),
    src: z
      .string({ error: typeError("글자여야 합니다") })
      .regex(IMAGE_SRC, { message: "src 는 서랍에 올린 사진 경로(<주인 id>/<sha256>.webp)입니다 — PC 사진은 file 로 주세요" }),
    w: side,
    h: side,
    alt: E(LIMITS.image.alt, true),
    caption: E(LIMITS.image.caption, true).optional(),
    place: z.enum(IMAGE_PLACES, { error: "place 는 left · right · full 중 하나입니다" }),
    size: z.enum(IMAGE_SIZES, { error: 'size 는 "1/3" · "1/2" · "2/3" 중 하나입니다' }).optional(),
    ref: ref.optional(),
    credit: str(LIMITS.image.credit, true).optional(),
    local_path: str(LIMITS.image.localPath, true).optional(),
    edge: z.enum(IMAGE_EDGES, { error: "edge 는 light · dark 중 하나입니다 (MCP 가 채우므로 file 로 줄 때는 비워 두세요)" }).optional(),
  });

  const blockSchema = z.discriminatedUnion(
    "type",
    [verdictBlock, textBlock, listBlock, tableBlock, claimsBlock, sourcesBlock, imageBlock],
    {
      error: (iss) =>
        iss.code === "invalid_union"
          ? `모르는 블록 종류입니다 (${BLOCK_TYPES.join(", ")} 중 하나)`
          : typeError("블록은 객체({ type: … })여야 합니다")(iss),
    },
  );
  return { verdictBlock, textBlock, listBlock, tableBlock, claimsBlock, sourcesBlock, imageBlock, blockSchema, blocksSchema: arr(blockSchema, LIMITS.blocks.min, LIMITS.blocks.max) };
}

/** 엄격: 빈 값 거절 — 에이전트가 넣는 블록 */
const STRICT = build(false);
/** 느슨: 사람이 비워 둔 칸('')을 받는다 — 그리기 · 이미 저장된 보고서 */
const LOOSE = build(true);

export const { verdictBlock, textBlock, listBlock, tableBlock, claimsBlock, sourcesBlock, imageBlock } = STRICT;
/** 그리기용(화면 · Markdown): 사람이 비워 둔 칸이 있어도 블록을 읽는다. 넣기 전 검사는 validateBlocks */
export const blockSchema = LOOSE.blockSchema;
export const blocksSchema = STRICT.blocksSchema;

export type VerdictBlock = z.infer<typeof verdictBlock>;
export type TextBlock = z.infer<typeof textBlock>;
export type ListBlock = z.infer<typeof listBlock>;
export type TableBlock = z.infer<typeof tableBlock>;
export type ClaimsBlock = z.infer<typeof claimsBlock>;
export type SourcesBlock = z.infer<typeof sourcesBlock>;
export type ImageBlock = z.infer<typeof imageBlock>;
export type Block = z.infer<typeof blockSchema>;

// ---------- 검사 ----------

export type BlockError = { path: string; message: string };
export type ValidateResult = { ok: true; blocks: Block[] } | { ok: false; errors: BlockError[] };

export function formatBlockPath(path: readonly PropertyKey[]): string {
  let out = "blocks";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : `.${String(p)}`;
  return out;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** 블록끼리 걸린 규칙. 원본 입력을 조심스럽게 훑으므로 모양 오류와 함께 한 번에 알려줄 수 있다 */
function crossCheck(input: unknown[]): BlockError[] {
  const errors: BlockError[] = [];
  const at = (path: PropertyKey[], message: string) => errors.push({ path: formatBlockPath(path), message });

  const firstOf: Partial<Record<"verdict" | "sources", number>> = {};
  input.forEach((b, i) => {
    if (!isObj(b) || (b.type !== "verdict" && b.type !== "sources")) return;
    const first = firstOf[b.type];
    if (first === undefined) firstOf[b.type] = i;
    else at([i], `${b.type === "verdict" ? "판정" : "출처"} 블록은 1개만 넣을 수 있습니다 (이미 blocks[${first}])`);
  });

  const src = firstOf.sources === undefined ? undefined : input[firstOf.sources];
  const sourceCount = isObj(src) && Array.isArray(src.items) ? src.items.length : firstOf.sources === undefined ? 0 : null;

  input.forEach((b, i) => {
    if (!isObj(b)) return;
    if (b.type === "table" && Array.isArray(b.cols) && Array.isArray(b.rows)) {
      const cols = b.cols.length;
      b.rows.forEach((row, r) => {
        if (Array.isArray(row) && row.length !== cols) at([i, "rows", r], `칸이 ${row.length}개인데 열은 ${cols}개입니다`);
      });
    }
    if (b.type === "image") {
      const has = (k: string) => b[k] !== undefined;
      if (!has("ref") && !has("credit") && !has("local_path")) {
        at([i], "사진 출처가 없습니다 — ref(출처 번호) · credit(예: 직접 캡처) · local_path 중 하나를 주세요");
      }
      const n = b.ref;
      if (typeof n === "number" && Number.isInteger(n) && n >= 1 && sourceCount !== null) {
        if (sourceCount === 0) at([i, "ref"], `출처 블록이 없는데 출처 ${n}번을 가리킵니다`);
        else if (n > sourceCount) at([i, "ref"], `출처 ${n}번은 없습니다 (출처는 1~${sourceCount}번)`);
      }
    }
    if (b.type === "claims" && Array.isArray(b.items) && sourceCount !== null) {
      b.items.forEach((item, j) => {
        if (!isObj(item) || !Array.isArray(item.refs)) return;
        item.refs.forEach((n, k) => {
          if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return;
          if (sourceCount === 0) at([i, "items", j, "refs", k], `출처 블록이 없는데 출처 ${n}번을 가리킵니다`);
          else if (n > sourceCount) at([i, "items", j, "refs", k], `출처 ${n}번은 없습니다 (출처는 1~${sourceCount}번)`);
        });
      });
    }
  });
  return errors;
}

/**
 * 블록 배열 검사. 통과하면 앞뒤 공백을 지운 블록을 돌려준다.
 * allowEmpty: 사람이 고칠 수 있는 문자열 칸의 빈 값('')을 통과시킨다 — 사람이 비워 둔 칸이 든 보고서를 에이전트가 고칠 때.
 * 기본은 빈 값 거절.
 */
export function validateBlocks(input: unknown, opts: { allowEmpty?: boolean } = {}): ValidateResult {
  const parsed = (opts.allowEmpty ? LOOSE : STRICT).blocksSchema.safeParse(input);
  const errors: BlockError[] = parsed.success
    ? []
    : parsed.error.issues.map((iss) => ({ path: formatBlockPath(iss.path), message: iss.message }));
  if (Array.isArray(input)) errors.push(...crossCheck(input));

  if (errors.length === 0 && parsed.success) {
    const bytes = new TextEncoder().encode(JSON.stringify(parsed.data)).length;
    if (bytes > LIMITS.bytes) {
      errors.push({ path: "blocks", message: `보고서가 너무 큽니다 (${bytes.toLocaleString("en-US")}바이트, 최대 ${LIMITS.bytes.toLocaleString("en-US")})` });
    }
  }
  if (errors.length > 0 || !parsed.success) {
    // 같은 자리·같은 이유는 한 번만, 앞 블록부터
    const seen = new Set<string>();
    const unique = errors.filter((e) => {
      const k = `${e.path}\u0000${e.message}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    return { ok: false, errors: unique };
  }
  return { ok: true, blocks: parsed.data };
}

// ---------- 사람이 고칠 수 있는 칸 ----------

export type EditRule = { maxLength: number; oneLine: boolean };

const INDEX = /^(0|[1-9][0-9]{0,5})$/;

function toIndex(seg: string | number | undefined): number | null {
  if (typeof seg === "number") return Number.isInteger(seg) && seg >= 0 ? seg : null;
  return typeof seg === "string" && INDEX.test(seg) ? Number(seg) : null;
}

/**
 * 그 자리를 사람이 고칠 수 있으면 규칙(길이 상한·한 줄)을, 아니면 null.
 * path 는 blocks 기준: [2, 'body'], [3, 'rows', 1, 0]. ['title'] 은 보고서 제목, ['agent'] 는 작성자.
 * 그 자리에 원래 문자열이 있어야 한다. DB ez_edit_rule 과 같은 규칙.
 * 줄바꿈이 되는 칸(oneLine: false): 문단 · 판정 풀이 · 목록 항목 · 표 칸(머리 제외) · 근거 글. 나머지는 한 줄.
 * 화면의 키 처리(Shift+Enter)도 이 값을 본다 — 목록을 따로 두지 않는다.
 */
export function editRule(blocks: unknown, path: readonly (string | number)[]): EditRule | null {
  if (path.length === 1 && path[0] === "title") return { maxLength: NAME_MAX, oneLine: true };
  if (path.length === 1 && path[0] === "agent") return { maxLength: LIMITS.agent, oneLine: true };
  if (!Array.isArray(blocks) || path.length < 2) return null;

  const bi = toIndex(path[0]);
  const block: unknown = bi === null ? undefined : blocks[bi];
  if (!isObj(block)) return null;

  // 그 자리에 원래 문자열이 있어야 한다
  let here: unknown = block;
  for (const seg of path.slice(1)) {
    if (Array.isArray(here)) {
      const i = toIndex(seg);
      here = i === null ? undefined : here[i];
    } else if (isObj(here) && typeof seg === "string" && Object.hasOwn(here, seg)) {
      here = here[seg];
    } else return null;
  }
  if (typeof here !== "string") return null;

  const [, a, b, c, ...more] = path;
  const idx = (s: string | number | undefined) => toIndex(s) !== null;
  const len = path.length - 1;
  if (more.length > 0) return null;
  const rule = (maxLength: number, oneLine = false): EditRule => ({ maxLength, oneLine });

  switch (block.type) {
    case "verdict":
      if (len === 1 && a === "v") return rule(LIMITS.verdict.v, true);
      if (len === 1 && a === "w") return rule(LIMITS.verdict.w);
      return null;
    case "text":
      if (len === 1 && a === "h") return rule(H, true);
      if (len === 1 && a === "body") return rule(LIMITS.text.body);
      return null;
    case "list":
      if (len === 1 && a === "h") return rule(H, true);
      if (len === 2 && a === "items" && idx(b)) return rule(LIMITS.list.item);
      return null;
    case "table":
      if (len === 1 && a === "h") return rule(H, true);
      if (len === 2 && a === "cols" && idx(b)) return rule(LIMITS.table.cell, true);
      if (len === 3 && a === "rows" && idx(b) && idx(c)) return rule(LIMITS.table.cell);
      return null;
    case "claims":
      if (len === 1 && a === "h") return rule(H, true);
      if (len === 3 && a === "items" && idx(b) && c === "text") return rule(LIMITS.claims.text);
      return null;
    case "sources":
      if (len === 1 && a === "h") return rule(H, true);
      if (len === 3 && a === "items" && idx(b) && c === "title") return rule(LIMITS.sources.title, true);
      return null;
    case "image":
      // 설명·캡션 글자만. src·배치·크기·출처 번호·경로는 못 고친다
      if (len === 1 && a === "alt") return rule(LIMITS.image.alt, true);
      if (len === 1 && a === "caption") return rule(LIMITS.image.caption, true);
      return null;
    default:
      return null;
  }
}

const LINE_END_SPACE = /[ \t\u00a0\u3000]+\n/g;

/**
 * 사람이 고친 글자 다듬기 (DB ez_edit_text 와 같다): 앞뒤 공백·빈 줄을 지우고, 줄 끝 공백을 지우고, 연속 빈 줄은 하나로. 가운데 줄바꿈은 지킨다.
 * oneLine 이면 줄바꿈을 공백 하나로 잇는다(붙여 넣은 여러 줄 — 화면 쪽 편의. DB 는 한 줄 칸의 줄바꿈을 거절한다).
 */
export function tidyText(s: string, oneLine = false): string {
  const t = s.trim().replace(/\r\n?/g, "\n");
  if (oneLine) return t.replace(/\s*[\n\u2028\u2029]+\s*/g, " ");
  return t.replace(LINE_END_SPACE, "\n").replace(/\n{3,}/g, "\n\n");
}

/** 공유 페이지로 내보낼 블록: 사진의 local_path(내 PC 경로)를 뺀다. DB ez_shared 와 같은 규칙 */
export function withoutLocalPaths(blocks: readonly unknown[]): unknown[] {
  return blocks.map((b) => {
    if (!isObj(b) || b.type !== "image" || !Object.hasOwn(b, "local_path")) return b;
    const { local_path: _, ...rest } = b;
    return rest;
  });
}

// ---------- 사람이 블록을 지우고 옮기기 ----------

/**
 * order(새 순서로 늘어놓은 옛 블록 번호, 0부터)가 받을 수 있는 모양인지. 틀리면 이유(한국어), 맞으면 null.
 * DB ez_blocks_arrange 와 같은 규칙 · 같은 문구: 비었거나, 범위 밖이거나, 겹치면 거절
 */
export function arrangeError(count: number, order: readonly number[]): string | null {
  if (order.length === 0) return "블록이 하나는 남아야 합니다";
  if (order.some((x) => !Number.isInteger(x) || x < 0 || x >= count)) return `없는 블록 번호가 있습니다 (블록은 0~${count - 1}번)`;
  if (new Set(order).size !== order.length) return "같은 블록 번호가 두 번 들어 있습니다";
  return null;
}

/** 순서도 그대로, 지운 것도 없음 */
export function isSameOrder(count: number, order: readonly number[]): boolean {
  return order.length === count && order.every((x, i) => x === i);
}

/**
 * order 대로 늘어놓은 새 블록 배열 (원본은 그대로). 빠진 번호 = 지움. order 는 arrangeError 를 통과한 것이어야 한다.
 * 출처 블록이 하나도 안 남으면 근거 블록의 출처 번호(refs)를 비우고 사진 블록의 ref 를 뺀다 — 가리킬 곳이 없어지므로. 그 밖의 블록 안은 건드리지 않는다
 */
export function arrangeBlocks(blocks: readonly unknown[], order: readonly number[]): unknown[] {
  const out = order.map((i) => blocks[i]);
  if (out.some((b) => isObj(b) && b.type === "sources")) return out;
  return out.map((b) => {
    if (isObj(b) && b.type === "image" && Object.hasOwn(b, "ref")) {
      const { ref: _ref, ...rest } = b;
      return rest;
    }
    if (!isObj(b) || b.type !== "claims" || !Array.isArray(b.items)) return b;
    return { ...b, items: b.items.map((it: unknown) => (isObj(it) && Object.hasOwn(it, "refs") ? { ...it, refs: [] } : it)) };
  });
}

/** 설계서 3장 "사람이 고칠 수 있는 칸" */
export function isEditablePath(blocks: unknown, path: readonly (string | number)[]): boolean {
  return editRule(blocks, path) !== null;
}
