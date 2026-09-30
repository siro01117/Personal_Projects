"use client";

// 보고서 블록 그리기 (설계서 3장). 글자는 전부 텍스트 노드로만 — HTML 로 해석하지 않는다.
// 모르는 종류·깨진 블록은 자리표시 한 줄로 두고 나머지는 그린다. 링크는 http/https 만.
// 글자 고치기 모드에서는 lib 의 isEditablePath 가 참인 칸만 contentEditable(plaintext-only).

import { Component, useLayoutEffect, useRef, type ElementType, type KeyboardEvent, type ReactNode } from "react";
import { blockSchema, isEditablePath, type Block } from "../../lib/blocks";
import { httpUrl } from "../_logic/drawer";

export const UNKNOWN_BLOCK = "이 블록은 아직 볼 수 없습니다";

export type Path = (string | number)[];

export type EditCtx = {
  /** 원본 블록 배열 — 고칠 수 있는 칸인지 여기서 본다 */
  raw: unknown[];
  editing: boolean;
  /** 칸에서 벗어날 때. 저장이 끝나면(성공이든 실패든) 칸 글자를 그때의 값으로 맞춘다 */
  commit: (path: Path, value: string) => Promise<void>;
};

/** 여러 줄을 쓰는 칸 — Enter 는 줄바꿈, Ctrl/⌘+Enter 가 저장 */
function multiLine(raw: unknown[], path: Path): boolean {
  const b = raw[path[0] as number] as { type?: unknown } | undefined;
  return path.length === 2 && ((b?.type === "text" && path[1] === "body") || (b?.type === "verdict" && path[1] === "w"));
}

export function Field({
  as: Tag,
  className,
  path,
  value,
  ctx,
}: {
  as: ElementType;
  className?: string;
  path: Path;
  value: string;
  ctx?: EditCtx;
}) {
  const ref = useRef<HTMLElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const editable = !!ctx?.editing && isEditablePath(ctx.raw, path);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && editable && document.activeElement !== el && el.textContent !== value) el.textContent = value;
  }, [value, editable]);

  if (!editable || !ctx) return <Tag className={className}>{value}</Tag>;

  const sync = () => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== valueRef.current) el.textContent = valueRef.current;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.textContent = valueRef.current;
      e.currentTarget.blur();
      return;
    }
    if (e.key !== "Enter") return;
    // 한글 조합 중 Enter 는 글자 확정용
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (multiLine(ctx.raw, path) && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.currentTarget.blur();
  };

  return (
    <Tag
      key="edit"
      ref={ref}
      className={className}
      data-edit=""
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onKeyDown={onKeyDown}
      onBlur={(e: React.FocusEvent<HTMLElement>) => {
        const text = e.currentTarget.textContent ?? "";
        if (text === valueRef.current) return;
        void ctx.commit(path, text).finally(() => requestAnimationFrame(sync));
      }}
    />
  );
}

class Boundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  override state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  override render() {
    return this.state.broken ? <div className="blk b-unknown">{UNKNOWN_BLOCK}</div> : this.props.children;
  }
}

/** 블록 하나를 검사해 본다. 틀리면 null (자리표시) */
export function parseBlock(raw: unknown): Block | null {
  const r = blockSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** 오른쪽 레일 차례: [블록 번호, 이름] */
export function tocOf(raw: unknown[]): [number, string][] {
  const out: [number, string][] = [];
  raw.forEach((b, i) => {
    const p = parseBlock(b);
    if (!p) return;
    if (p.type === "verdict") out.push([i, "판정"]);
    else if (p.h) out.push([i, p.h]);
  });
  return out;
}

function BlockView({ b, i, ctx }: { b: Block; i: number; ctx?: EditCtx }) {
  const id = `b${i}`;
  const F = (props: { as: ElementType; className?: string; path: Path; value: string }) => <Field {...props} ctx={ctx} />;
  switch (b.type) {
    case "verdict":
      return (
        <div className="blk b-verdict" id={id}>
          {F({ as: "div", className: "v", path: [i, "v"], value: b.v })}
          {b.w !== undefined && F({ as: "div", className: "w", path: [i, "w"], value: b.w })}
        </div>
      );
    case "text":
      return (
        <div className="blk b-text" id={id}>
          {b.h !== undefined && F({ as: "h3", path: [i, "h"], value: b.h })}
          {F({ as: "p", path: [i, "body"], value: b.body })}
        </div>
      );
    case "list":
      return (
        <div className="blk b-list" id={id}>
          {F({ as: "h3", path: [i, "h"], value: b.h })}
          <ul>
            {b.items.map((t, j) => (
              <li key={j}>{F({ as: "span", path: [i, "items", j], value: t })}</li>
            ))}
          </ul>
        </div>
      );
    case "table":
      return (
        <div className="blk b-table" id={id}>
          {F({ as: "h3", path: [i, "h"], value: b.h })}
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  {b.cols.map((c, j) => (
                    <th key={j}>{F({ as: "span", path: [i, "cols", j], value: c })}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, j) => (
                      <td key={j}>{F({ as: "span", path: [i, "rows", r, j], value: c })}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case "claims":
      return (
        <div className="blk b-claims" id={id}>
          {F({ as: "h3", path: [i, "h"], value: b.h })}
          {b.items.map((c, j) => (
            <div className="c" key={j}>
              <span className={`tag ${c.tag}`}>{c.tag === "fact" ? "사실" : "추정"}</span>
              <p>
                {F({ as: "span", path: [i, "items", j, "text"], value: c.text })}
                {c.refs.map((k, n) => (
                  <sup className="r" key={n}>
                    {k}
                  </sup>
                ))}
              </p>
            </div>
          ))}
        </div>
      );
    case "sources":
      return (
        <div className="blk b-sources" id={id}>
          {F({ as: "h3", path: [i, "h"], value: b.h })}
          <ol>
            {b.items.map((s, j) => {
              const url = httpUrl(s.url);
              return (
                <li key={j}>
                  <span>{j + 1}</span>
                  {ctx?.editing || !url ? (
                    F({ as: "span", className: "t", path: [i, "items", j, "title"], value: s.title })
                  ) : (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {s.title}
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      );
  }
}

export function Blocks({ blocks, ctx }: { blocks: unknown[]; ctx?: EditCtx }) {
  return (
    <>
      {blocks.map((raw, i) => {
        const b = parseBlock(raw);
        return (
          <Boundary key={i}>
            {b ? <BlockView b={b} i={i} ctx={ctx} /> : <div className="blk b-unknown" id={`b${i}`}>{UNKNOWN_BLOCK}</div>}
          </Boundary>
        );
      })}
    </>
  );
}
