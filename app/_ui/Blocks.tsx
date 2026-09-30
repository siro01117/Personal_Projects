"use client";

// 보고서 블록 그리기 (설계서 3장). 글자는 전부 텍스트 노드로만 — HTML 로 해석하지 않는다.
// 모르는 종류·깨진 블록은 자리표시 한 줄로 두고 나머지는 그린다. 링크는 http/https 만.
// 글자 고치기 모드에서는 lib 의 isEditablePath 가 참인 칸만 contentEditable(plaintext-only).
// 인용 번호는 첫 출처 블록의 그 항목으로 가는 링크 — 올리거나 초점 두면 출처 제목·도메인 미리보기(글자만).
// 글 안 ==강조== 는 <strong> 으로(굵게만) (lib/marks — 구분자만 나눈다). 고치는 칸에서는 원문 그대로.
// 블록은 행으로 묶어 그린다(app/_logic/rows — 한 행에 객체 최대 2개). 옆 사진은 다음 글과 2칸 행, 아니면 혼자 한쪽.
// 사진 주소는 볼 때만 잠깐 유효한 것을 받고, 못 받거나 깨지면 설명 글자로.

import { Component, Fragment, useEffect, useLayoutEffect, useRef, useState, type ElementType, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { blockSchema, isEditablePath, type Block, type ImageBlock, type SourcesBlock } from "../../lib/blocks";
import { splitMarks, stripMarks } from "../../lib/marks";
import { domainOf, httpUrl, imageCredit, type ImageCredit } from "../_logic/drawer";
import { rowBlocks, toRows, type Row } from "../_logic/rows";
import { Icon } from "./Icon";

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

/** 글 안 ==강조== → <strong>. 글자는 텍스트 노드로만 */
export function marked(s: string): ReactNode {
  const parts = splitMarks(s);
  if (!parts.some((p) => p.mark)) return s;
  return parts.map((p, k) => (p.mark ? <strong key={k}>{p.text}</strong> : <Fragment key={k}>{p.text}</Fragment>));
}

export function Field({
  as: Tag,
  className,
  path,
  value,
  ctx,
  plain,
}: {
  as: ElementType;
  className?: string;
  path: Path;
  value: string;
  ctx?: EditCtx;
  /** 강조 표시를 해석하지 않는다 (보고서 제목·사진 설명) */
  plain?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const editable = !!ctx?.editing && isEditablePath(ctx.raw, path);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && editable && document.activeElement !== el && el.textContent !== value) el.textContent = value;
  }, [value, editable]);

  if (!editable || !ctx) return <Tag className={className}>{plain ? value : marked(value)}</Tag>;

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
    else if (p.type !== "image" && p.h) out.push([i, stripMarks(p.h)]); // 사진의 h 는 높이
  });
  return out;
}

type Source = SourcesBlock["items"][number];

/** 인용 번호. 가리킬 출처가 없으면(출처 블록 없음·범위 밖) 링크 없이 글자만 */
function Cite({ n, src }: { n: number; src: Source | undefined }) {
  const [open, setOpen] = useState(false);
  const aRef = useRef<HTMLAnchorElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  // 화면 밖으로 넘치지 않게 번호 아래 가운데에 둔다
  useLayoutEffect(() => {
    const a = aRef.current;
    const p = popRef.current;
    if (!open || !a || !p) return;
    const r = a.getBoundingClientRect();
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    p.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8))}px`;
    p.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? r.top - h - 6 : r.bottom + 6}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    addEventListener("scroll", close, true);
    addEventListener("resize", close);
    return () => {
      removeEventListener("scroll", close, true);
      removeEventListener("resize", close);
    };
  }, [open]);

  if (!src) return <sup className="r">{n}</sup>;
  const domain = domainOf(src.url);
  return (
    <sup className="r">
      <a
        ref={aRef}
        href={`#src-${n}`}
        aria-label={`출처 ${n}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          setOpen(false);
          const li = document.getElementById(`src-${n}`);
          li?.scrollIntoView({ behavior: "smooth", block: "center" });
          li?.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
        }}
      >
        {n}
      </a>
      {open && (
        <span className="cite-pop" role="tooltip" ref={popRef}>
          <span className="t">{stripMarks(src.title)}</span>
          {domain && <span className="d">{domain}</span>}
        </span>
      )}
    </sup>
  );
}

// ---------------------------------------------------------------- 사진 (설계서 8-1장)

/** 사진 경로들 → 잠깐 유효한 주소. 못 받은 경로는 빠진다 */
export type ImageUrls = (paths: string[]) => Promise<Record<string, string>>;

/** 크게 보기: 원래 크기까지만(늘리지 않음). Esc · 바깥 누르기로 닫는다 */
function Lightbox({ url, b, onClose }: { url: string; b: ImageBlock; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      prev?.focus?.({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={b.alt}
      tabIndex={-1}
      ref={ref}
      onClick={(e) => e.target === e.currentTarget && close.current()}
    >
      <img src={url} alt={b.alt} width={b.w} height={b.h} />
    </div>,
    document.body,
  );
}

function CopyPath({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="iconbtn cp"
      aria-label="경로 복사"
      title="경로 복사"
      onClick={() => {
        navigator.clipboard?.writeText(path).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          },
          () => {},
        );
      }}
    >
      <Icon name={done ? "check" : "copy"} />
    </button>
  );
}

function CreditLine({ c }: { c: NonNullable<ImageCredit> }) {
  switch (c.kind) {
    case "ref": {
      const text = `출처 [${c.n}] ${stripMarks(c.title)}${c.domain ? ` · ${c.domain}` : ""}`;
      return (
        <span className="src">
          {c.url ? (
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              {text}
            </a>
          ) : (
            text
          )}
        </span>
      );
    }
    case "credit":
      return <span className="src">{c.text}</span>;
    case "local":
      return (
        <span className="src">
          <span className="path">원본 · 내 PC · {c.path}</span>
          <CopyPath path={c.path} />
        </span>
      );
  }
}

/** url: undefined = 받는 중, null = 못 받음 */
function ImageView({ b, i, ctx, sources, url }: { b: ImageBlock; i: number; ctx?: EditCtx; sources?: Source[]; url: string | null | undefined }) {
  const [broken, setBroken] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const cls = `blk b-image p-${b.place}`;
  const credit = imageCredit(b, sources);
  const box = { maxWidth: `${b.w}px` };
  const editing = !!ctx?.editing;
  return (
    <figure className={cls} id={`b${i}`}>
      {url === undefined ? (
        <div className="img-wait" style={{ ...box, aspectRatio: `${b.w} / ${b.h}` }} />
      ) : url === null || broken ? (
        <div className="img-alt" style={box}>
          {b.alt}
        </div>
      ) : (
        <button type="button" className="img" style={box} onClick={() => setBig(true)}>
          <img src={url} alt={b.alt} width={b.w} height={b.h} decoding="async" onError={() => setBroken(true)} />
        </button>
      )}
      {(editing || b.caption !== undefined || credit) && (
        <figcaption>
          {editing && <Field as="span" className="alt" path={[i, "alt"]} value={b.alt} ctx={ctx} plain />}
          {b.caption !== undefined && <Field as="span" className="cap" path={[i, "caption"]} value={b.caption} ctx={ctx} />}
          {credit && <CreditLine c={credit} />}
        </figcaption>
      )}
      {big && url && !broken && <Lightbox url={url} b={b} onClose={() => setBig(false)} />}
    </figure>
  );
}

function BlockView({
  b,
  i,
  ctx,
  sources,
  isFirstSources,
  urls,
}: {
  b: Block;
  i: number;
  ctx?: EditCtx;
  sources?: Source[];
  isFirstSources: boolean;
  urls: Record<string, string> | null;
}) {
  const id = `b${i}`;
  const F = (props: { as: ElementType; className?: string; path: Path; value: string }) => <Field {...props} ctx={ctx} />;
  switch (b.type) {
    case "image":
      return <ImageView b={b} i={i} ctx={ctx} sources={sources} url={urls === null ? undefined : (urls[b.src] ?? null)} />;
    case "verdict":
      return (
        <div className="blk b-verdict" id={id}>
          {F({ as: "p", className: "v", path: [i, "v"], value: b.v })}
          {b.w !== undefined && F({ as: "p", className: "w", path: [i, "w"], value: b.w })}
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
                  <Cite key={n} n={k} src={sources?.[k - 1]} />
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
                <li key={j} id={isFirstSources ? `src-${j + 1}` : undefined}>
                  <span>{j + 1}</span>
                  {ctx?.editing || !url ? (
                    F({ as: "span", className: "t", path: [i, "items", j, "title"], value: s.title })
                  ) : (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {marked(s.title)}
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

/** 행 모양 클래스. 소제목이 있는 블록으로 시작하는 행(섹션 머리)은 위에 가는 선 */
function rowClass(r: Row, parsed: (Block | null)[]): string {
  const sec = rowBlocks(r).some((k) => {
    const b = parsed[k];
    return !!b && b.type !== "image" && b.type !== "verdict" && b.h !== undefined;
  });
  const shape = r.kind === "one" ? "" : ` ${r.kind === "side" ? "solo" : "pair"} to-${r.side} s-${r.size.replace("/", "-")}`;
  const img = r.kind !== "one" || parsed[r.i]?.type === "image" ? " has-img" : "";
  return `row${shape}${img}${sec ? " sec" : ""}`;
}

export function Blocks({ blocks, ctx, images }: { blocks: unknown[]; ctx?: EditCtx; images?: ImageUrls }) {
  const parsed = blocks.map(parseBlock);
  // 인용 번호는 첫 출처 블록을 가리킨다 (lib/blocks 검사와 같다)
  const firstSources = parsed.findIndex((b) => b?.type === "sources");
  const sources = firstSources < 0 ? undefined : (parsed[firstSources] as SourcesBlock).items;

  // 사진 주소는 한 번에 받는다. 같은 사진들이면 다시 받지 않는다 (데이터 층이 페이지 안에서 기억한다)
  const srcs = [...new Set(parsed.flatMap((b) => (b?.type === "image" ? [b.src] : [])))];
  const key = srcs.join("|");
  const [urls, setUrls] = useState<{ key: string; map: Record<string, string> } | null>(null);
  useEffect(() => {
    if (key === "" || !images) return;
    let alive = true;
    images(key.split("|")).then(
      (map) => alive && setUrls({ key, map }),
      () => alive && setUrls({ key, map: {} }),
    );
    return () => {
      alive = false;
    };
  }, [key, images]);
  const map = !images ? {} : urls && urls.key === key ? urls.map : null;

  const one = (i: number) => {
    const b = parsed[i];
    return (
      <Boundary key={i}>
        {b ? (
          <BlockView b={b} i={i} ctx={ctx} sources={sources} isFirstSources={i === firstSources} urls={map} />
        ) : (
          <div className="blk b-unknown" id={`b${i}`}>{UNKNOWN_BLOCK}</div>
        )}
      </Boundary>
    );
  };

  return (
    <>
      {toRows(parsed).map((r) => (
        <div key={r.i} className={rowClass(r, parsed)}>
          {rowBlocks(r).map(one)}
        </div>
      ))}
    </>
  );
}
