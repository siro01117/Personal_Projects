// 보고서 → Markdown (GFM). 웹의 'Markdown 복사'와 MCP 가 같이 쓰는 순수 함수.
// 판정은 인용구, 표는 GFM 표, 근거는 [사실]/[추정] + 각주 [^n], 출처는 각주 정의.
// 사진은 ![설명](출처 링크) — 파일 주소는 잠깐만 유효해 싣지 않는다. 출처 링크가 없으면 ![설명]() — 캡션은 다음 줄.
// 사람이 비워 둔 칸('')은 건너뛴다: 빈 소제목·문단·목록 항목·근거 줄·캡션은 빼고, 표 칸은 빈 칸으로, 출처 제목이 비면 주소만.
// 목록 항목·근거 글 안 줄바꿈은 들여쓴 이어지는 줄로, 표 칸 안 줄바꿈은 <br> 로.
// 모르는 블록·깨진 블록은 건너뛰고 한 줄 주석을 남긴다. 글 안 ==강조== 는 **강조** (판정 한 줄은 통째로 굵게라 강조 표시만 뺀다).

import { blockSchema, type Block } from "./blocks";
import { marksToMarkdown as md, stripMarks } from "./marks";

export type MarkdownMeta = {
  /** 쓴 에이전트 (예: Claude Code) */
  agent?: string | null;
  /** 날짜 글자 (화면과 같은 꼴로 넘긴다) */
  date?: string | null;
  /** 보고서 웹 링크 */
  url?: string | null;
};

// U+2028·U+2029 는 소스에 글자로 두면 정규식이 깨지므로 코드로 만든다
const NL = new RegExp(`\r\n?|[${String.fromCharCode(0x2028, 0x2029)}]`, "g");
const lines = (s: string) => s.replace(NL, "\n").split("\n");

/** 문단 안 줄바꿈을 살린다 (Markdown 은 줄바꿈 하나를 공백으로 본다): 줄 끝에 공백 두 칸. 빈 줄은 문단 나눔 그대로 */
function paragraph(s: string): string {
  const ls = lines(s);
  return ls.map((l, i) => (i < ls.length - 1 && l !== "" && ls[i + 1] !== "" ? `${l}  ` : l)).join("\n");
}

/** 목록 한 칸: 둘째 줄부터 들여써 같은 칸에 둔다 */
function listItem(prefix: string, s: string): string {
  const body = paragraph(s).split("\n");
  return body.map((l, i) => (i === 0 ? `${prefix}${l}` : l === "" ? "" : `  ${l}`)).join("\n");
}

function quote(s: string): string {
  return paragraph(s)
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n");
}

/** 표 칸: \ 와 | 를 이스케이프, 줄바꿈은 <br> */
function cell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(NL, "\n").replace(/\n/g, "<br>");
}

/** 링크 글자의 [ ] \ 이스케이프 */
function linkText(s: string): string {
  return s.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(NL, " ").replace(/\n/g, " ");
}

function httpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

function comment(raw: unknown): string {
  const t = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : undefined;
  const name = typeof t === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(t) ? t : "?";
  return `<!-- 이 블록은 옮기지 못했습니다: ${name} -->`;
}

type Parsed = { blocks: readonly unknown[]; parsed: (Block | null)[]; firstSources: number; sourceCount: number };

function parseAll(blocks: readonly unknown[]): Parsed {
  const parsed: (Block | null)[] = blocks.map((b) => {
    const r = blockSchema.safeParse(b);
    return r.success ? r.data : null;
  });
  // 인용 번호는 첫 출처 블록을 가리킨다 (lib/blocks crossCheck 와 같다)
  const firstSources = parsed.findIndex((b) => b?.type === "sources");
  const sourceCount = firstSources < 0 ? 0 : (parsed[firstSources] as Extract<Block, { type: "sources" }>).items.length;
  return { blocks, parsed, firstSources, sourceCount };
}

export function blocksToMarkdown(title: string, blocks: readonly unknown[], meta: MarkdownMeta = {}): string {
  const all = parseAll(blocks);
  const out: string[] = [`# ${lines(title).join(" ")}`];
  const by = [meta.agent, meta.date].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" · ");
  if (by) out.push(by);
  if (meta.url) out.push(`<${meta.url}>`);
  all.parsed.forEach((_, i) => blockParts(all, i, out));
  return out.join("\n\n") + "\n";
}

/**
 * 블록 하나만 (보고서 블록의 우클릭 메뉴 'Markdown 으로 복사'). 보고서 전체를 옮길 때와 같은 글 — 인용 번호 · 각주 번호는 보고서 전체의 것 그대로.
 * 보일 것이 없는 블록이면 빈 글자
 */
export function blockToMarkdown(blocks: readonly unknown[], i: number): string {
  if (!Number.isInteger(i) || i < 0 || i >= blocks.length) return "";
  const out: string[] = [];
  blockParts(parseAll(blocks), i, out);
  return out.length === 0 ? "" : out.join("\n\n") + "\n";
}

/** i 번째 블록의 Markdown 덩어리들을 out 에 넣는다 */
function blockParts({ blocks, parsed, firstSources, sourceCount }: Parsed, i: number, out: string[]): void {
  /** 소제목 줄 — 비었으면 없음 */
  const heading = (h: string | undefined) => {
    if (h) out.push(`## ${lines(md(h)).join(" ")}`);
  };

  {
    const b = parsed[i];
    if (!b) return void out.push(comment(blocks[i]));
    switch (b.type) {
      case "verdict": {
        const parts = [b.v ? quote(`**${stripMarks(b.v)}**`) : "", b.w ? quote(md(b.w)) : ""].filter((x) => x !== "");
        if (parts.length > 0) out.push(parts.join("\n>\n"));
        break;
      }
      case "text":
        heading(b.h);
        if (b.body) out.push(paragraph(md(b.body)));
        break;
      case "list": {
        heading(b.h);
        const items = b.items.filter((t) => t !== "");
        if (items.length > 0) out.push(items.map((t) => listItem("- ", md(t))).join("\n"));
        break;
      }
      case "table": {
        const row = (cells: readonly string[]) => `| ${cells.map((c) => cell(md(c))).join(" | ")} |`;
        heading(b.h);
        out.push([row(b.cols), `|${b.cols.map(() => " --- |").join("")}`, ...b.rows.map(row)].join("\n"));
        break;
      }
      case "claims": {
        heading(b.h);
        const items = b.items.filter((c) => c.text !== "");
        if (items.length > 0) {
          out.push(
            items
              .map((c) => {
                const refs = c.refs.filter((n) => n >= 1 && n <= sourceCount).map((n) => `[^${n}]`).join("");
                return listItem(`- [${c.tag === "fact" ? "사실" : "추정"}] `, md(c.text)) + refs;
              })
              .join("\n"),
          );
        }
        break;
      }
      case "image": {
        const src = b.ref !== undefined && b.ref <= sourceCount ? (parsed[firstSources] as Extract<Block, { type: "sources" }>).items[b.ref - 1] : undefined;
        const url = src ? httpUrl(src.url) : null;
        const img = `![${linkText(b.alt)}](${url ? `<${url}>` : ""})`;
        out.push(!b.caption ? img : `${img}  \n${paragraph(md(b.caption))}`);
        break;
      }
      case "sources": {
        heading(b.h);
        // 제목을 비운 출처는 주소만
        if (i === firstSources) {
          out.push(
            b.items
              .map((s, j) => {
                const url = httpUrl(s.url);
                const t = linkText(md(s.title));
                return `[^${j + 1}]: ${url ? (t ? `[${t}](<${url}>)` : `<${url}>`) : t || linkText(s.url)}`;
              })
              .join("\n"),
          );
        } else {
          out.push(b.items.map((s, j) => `${j + 1}. ${linkText(md(s.title))} ${httpUrl(s.url) ?? ""}`.replace(/ +/g, " ").trimEnd()).join("\n"));
        }
        break;
      }
    }
  }
}
