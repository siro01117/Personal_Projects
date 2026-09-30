// 보고서 → Markdown (GFM). 웹의 'Markdown 복사'와 MCP 가 같이 쓰는 순수 함수.
// 판정은 인용구, 표는 GFM 표, 근거는 [사실]/[추정] + 각주 [^n], 출처는 각주 정의.
// 모르는 블록·깨진 블록은 건너뛰고 한 줄 주석을 남긴다.

import { blockSchema, type Block } from "./blocks";

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

export function blocksToMarkdown(title: string, blocks: readonly unknown[], meta: MarkdownMeta = {}): string {
  const parsed: (Block | null)[] = blocks.map((b) => {
    const r = blockSchema.safeParse(b);
    return r.success ? r.data : null;
  });
  // 인용 번호는 첫 출처 블록을 가리킨다 (lib/blocks crossCheck 와 같다)
  const firstSources = parsed.findIndex((b) => b?.type === "sources");
  const sourceCount = firstSources < 0 ? 0 : (parsed[firstSources] as Extract<Block, { type: "sources" }>).items.length;

  const out: string[] = [`# ${lines(title).join(" ")}`];
  const by = [meta.agent, meta.date].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" · ");
  if (by) out.push(by);
  if (meta.url) out.push(`<${meta.url}>`);

  parsed.forEach((b, i) => {
    if (!b) return void out.push(comment(blocks[i]));
    switch (b.type) {
      case "verdict":
        out.push(b.w === undefined ? quote(`**${b.v}**`) : `${quote(`**${b.v}**`)}\n>\n${quote(b.w)}`);
        break;
      case "text":
        if (b.h !== undefined) out.push(`## ${b.h}`);
        out.push(paragraph(b.body));
        break;
      case "list":
        out.push(`## ${b.h}`, b.items.map((t) => listItem("- ", t)).join("\n"));
        break;
      case "table": {
        const row = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
        out.push(`## ${b.h}`, [row(b.cols), `|${b.cols.map(() => " --- |").join("")}`, ...b.rows.map(row)].join("\n"));
        break;
      }
      case "claims":
        out.push(
          `## ${b.h}`,
          b.items
            .map((c) => {
              const refs = c.refs.filter((n) => n >= 1 && n <= sourceCount).map((n) => `[^${n}]`).join("");
              return listItem(`- [${c.tag === "fact" ? "사실" : "추정"}] `, c.text) + refs;
            })
            .join("\n"),
        );
        break;
      case "sources": {
        out.push(`## ${b.h}`);
        if (i === firstSources) {
          out.push(
            b.items
              .map((s, j) => {
                const url = httpUrl(s.url);
                return `[^${j + 1}]: ${url ? `[${linkText(s.title)}](<${url}>)` : linkText(s.title)}`;
              })
              .join("\n"),
          );
        } else {
          out.push(b.items.map((s, j) => `${j + 1}. ${linkText(s.title)} ${httpUrl(s.url) ?? ""}`.trimEnd()).join("\n"));
        }
        break;
      }
    }
  });
  return out.join("\n\n") + "\n";
}
