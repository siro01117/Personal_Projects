"use client";

// 보고서 블록 그리기 (설계서 3장). 글자는 전부 텍스트 노드로만 — HTML 로 해석하지 않는다.
// 모르는 종류·깨진 블록은 자리표시 한 줄로 두고 나머지는 그린다. 링크는 http/https 만.
// 글자 고치기 모드에서는 lib 의 editRule 이 인정하는 칸만 contentEditable(plaintext-only).
// 고치는 칸: Enter 는 저장, Shift+Enter 는 줄바꿈(줄바꿈이 되는 칸만 — editRule 의 oneLine), Esc 는 되돌리기.
// 사람이 비워 둔 칸('')은 읽을 때 안 그리고, 고치기 모드에서는 빈 칸으로 그려 자리표시(globals.css [data-edit]:empty)가 보인다.
// 인용 번호는 첫 출처 블록의 그 항목으로 가는 링크 — 올리거나 초점 두면 출처 제목·도메인 미리보기(글자만).
// 글 안 ==강조== 는 <strong> 으로(굵게만) (lib/marks — 구분자만 나눈다). 고치는 칸에서는 원문 그대로.
// 블록은 행으로 묶어 그린다(app/_logic/rows — 한 행에 객체 최대 2개). 옆 사진은 다음 글과 2칸 행, 아니면 혼자 한쪽.
// 사진 주소는 볼 때만 잠깐 유효한 것을 받고, 못 받거나 깨지면 설명 글자로.
// 가장자리가 화면 바탕과 같은 밝기(라이트+light · 다크+dark)인 사진만 포인트색 테두리 — globals.css --img-edge-*.
// 고치기 모드에서 arrange 를 받으면 블록마다 손잡이(점 여섯 개)와 고름 표시가 붙는다 — 고르기 · 지우기 · 옮기기는 useArrange 가 한다.
// 블록의 React 열쇠는 keys(순서가 바뀌어도 유지) — id="b{번호}" 는 늘 지금 순서의 번호다.
// 댓글(설계서 7-5 · 7-6장): notes 를 받으면(고치기 모드가 아닐 때) 블록마다 오른쪽 여백에 댓글 수(없으면 올렸을 때만 +), 블록을 누르면 댓글 줄(thread).
//  종이가 넓으면(notes.side) 댓글 줄은 화면이 블록 옆 패널에 그리고, 좁으면 여기서 블록 아래에 그린다.
// 링크 · 단추 · 글자 고르기 · 댓글 줄 안을 누른 것은 블록 누르기로 치지 않는다.

import { Component, Fragment, useEffect, useLayoutEffect, useRef, useState, type ElementType, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { blockSchema, editRule, tableSpans, type Block, type ImageBlock, type SourcesBlock } from "../../lib/blocks";
import { splitMarks, stripMarks } from "../../lib/marks";
import { domainOf, httpUrl, imageCredit, type ImageCredit } from "../_logic/drawer";
import { rowBlocks, toRows, type Row } from "../_logic/rows";
import { Icon } from "./Icon";
import type { MenuBind } from "./useContextMenu";

export const UNKNOWN_BLOCK = "이 블록은 아직 볼 수 없습니다";

export type Path = (string | number)[];

/** 블록 고르기 · 옮기기 (설계서 3장). 열쇠는 Blocks 의 keys */
export type ArrangeCtx = {
  selected: ReadonlySet<string>;
  /** 지금 끌려가는 블록 */
  moving: ReadonlySet<string>;
  onGripDown: (e: PointerEvent<HTMLButtonElement>, key: string) => void;
  onGripClick: (e: MouseEvent<HTMLButtonElement>, key: string) => void;
};

export type EditCtx = {
  /** 원본 블록 배열 — 고칠 수 있는 칸인지 여기서 본다 */
  raw: unknown[];
  editing: boolean;
  /** 칸에서 벗어날 때. 저장이 끝나면(성공이든 실패든) 칸 글자를 그때의 값으로 맞춘다 */
  commit: (path: Path, value: string) => Promise<void>;
  /** 있으면 고치기 모드에서 손잡이가 보인다 */
  arrange?: ArrangeCtx;
};

/** 댓글 (설계서 7-5 · 7-6장). 블록 번호 기준 */
export type NotesCtx = {
  counts: ReadonlyMap<number, number>;
  /** 펼친 블록 */
  open: number | null;
  onToggle: (i: number) => void;
  /** 펼친 블록 아래에 그릴 댓글 줄 */
  thread: (i: number) => ReactNode;
  /** 종이가 넓어 댓글 줄을 블록 옆 패널(Notes 의 SidePanel)에 그린다 — 블록 아래에는 안 그린다 */
  side?: boolean;
};

/** 블록 어디를 눌렀을 때 댓글을 펼치거나 접을지 — 링크 · 단추 · 칸 · 댓글 줄 · 사진 크게 보기는 아니고, 글자를 골랐으면 아니다 */
export function wantsToggle(target: EventTarget | null, selectionCollapsed: boolean): boolean {
  if (!selectionCollapsed) return false;
  const el = target instanceof Element ? target : null;
  return !el?.closest("a, button, input, textarea, [contenteditable], .cmt, .lightbox");
}

export type EnterAction = "ignore" | "save" | "break" | "none";

/**
 * 고치는 칸에서 Enter 가 하는 일. 한글 조합 중이면 글자 확정용이라 건드리지 않는다(ignore).
 * Shift+Enter 는 줄바꿈이 되는 칸에서만 줄바꿈(break), 한 줄 칸이면 아무것도 안 한다(none). 그 밖의 Enter(Ctrl/⌘ 포함)는 저장.
 */
export function enterAction(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; composing: boolean }, oneLine: boolean): EnterAction {
  if (e.composing) return "ignore";
  if (e.shiftKey && !e.ctrlKey && !e.metaKey) return oneLine ? "none" : "break";
  return "save";
}

/**
 * 커서 자리에 줄바꿈 한 줄. 브라우저마다 plaintext-only 의 기본 동작이 달라 직접 넣는다.
 * 맨 끝에 넣은 줄바꿈은 뒤에 글자가 없으면 화면에서 줄이 안 바뀌어 보이므로 하나를 더 둔다 — 저장할 때 다듬어진다(tidyText).
 */
function insertBreak(el: HTMLElement): void {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const nl = document.createTextNode("\n");
  range.insertNode(nl);
  const rest = document.createRange();
  rest.selectNodeContents(el);
  rest.setStartAfter(nl);
  if (rest.toString() === "") el.appendChild(document.createTextNode("\n"));
  const caret = document.createRange();
  caret.setStart(nl, 1);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
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
  const rule = ctx?.editing ? editRule(ctx.raw, path) : null;
  const editable = rule !== null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && editable && document.activeElement !== el && el.textContent !== value) el.textContent = value;
  }, [value, editable]);

  if (!rule || !ctx) return <Tag className={className}>{plain ? value : marked(value)}</Tag>;

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
    const act = enterAction(
      { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, composing: e.nativeEvent.isComposing || e.keyCode === 229 },
      rule.oneLine,
    );
    if (act === "ignore") return;
    e.preventDefault();
    if (act === "break") insertBreak(e.currentTarget);
    else if (act === "save") e.currentTarget.blur();
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
        const el = e.currentTarget;
        const text = el.textContent ?? "";
        // 다 지우면 브라우저가 <br> 을 남기기도 한다 — 비워야 자리표시(:empty)가 보인다
        if (text === "" && el.firstChild) el.textContent = "";
        if (text === valueRef.current) return;
        void ctx.commit(path, text).finally(() => requestAnimationFrame(sync));
      }}
    />
  );
}

class Boundary extends Component<{ children: ReactNode; fallback: ReactNode }, { broken: boolean }> {
  override state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  override render() {
    return this.state.broken ? this.props.fallback : this.props.children;
  }
}

/** 블록 맨 바깥 요소에 싣는 것: 지금 번호의 id, 고치기 모드면 열쇠 · 고름 · 끌림, 댓글이 있으면 누르기 · 펼침 */
type RootAttrs = {
  id: string;
  "data-bk"?: string;
  "data-flip"?: string;
  "data-sel"?: "";
  "data-moving"?: "";
  "data-cmt"?: "";
  onClick?: (e: MouseEvent<HTMLElement>) => void;
} & Partial<MenuBind>;

/** 손잡이: 누르면 고르고, 끌면 옮긴다. 블록 왼쪽 바깥에 선다 (globals.css .grip) */
function Grip({ k, a }: { k: string; a: ArrangeCtx }) {
  return (
    <button
      type="button"
      className="grip"
      aria-label="블록 고르기"
      aria-pressed={a.selected.has(k)}
      onPointerDown={(e) => a.onGripDown(e, k)}
      onClick={(e) => a.onGripClick(e, k)}
      onContextMenu={(e) => e.preventDefault()}
      data-menu-skip=""
    >
      <Icon name="grip" />
    </button>
  );
}

/** 블록 하나를 검사해 본다. 틀리면 null (자리표시) */
/** 표 r 행의 첫 칸이 아래로 몇 행과 같은지(자기 포함). 빈 칸은 합치지 않는다. free(r) 가 거짓인 행(첫 칸이 merges 에 든 행)에서 멈춘다 */
export function spanOf(rows: readonly (readonly string[])[], r: number, free: (r: number) => boolean = () => true): number {
  const v = rows[r]?.[0];
  if (!v) return 1;
  let n = 1;
  while (rows[r + n]?.[0] === v && free(r + n)) n++;
  return n;
}

export function parseBlock(raw: unknown): Block | null {
  const r = blockSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** 읽을 때 통째로 안 보이는 블록 — 사람이 보일 칸을 모두 비웠다. 표 · 출처 · 사진은 늘 그린다(빈 칸 · 주소 · 사진이 남는다) */
export function isBlankBlock(b: Block): boolean {
  switch (b.type) {
    case "verdict":
      return !b.v && !b.w;
    case "text":
      return !b.h && !b.body;
    case "list":
      return !b.h && b.items.every((t) => !t);
    case "claims":
      return !b.h && b.items.every((c) => !c.text);
    default:
      return false;
  }
}

/** 오른쪽 레일 차례: [블록 번호, 이름]. 빈 소제목은 없는 것으로 */
export function tocOf(raw: unknown[]): [number, string][] {
  const out: [number, string][] = [];
  raw.forEach((b, i) => {
    const p = parseBlock(b);
    if (!p) return;
    if (isBlankBlock(p)) return;
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
      {/* body 로 — 댓글 패널이 열려 종이가 밀린(transform) 동안에도 화면 기준(fixed)으로 선다 */}
      {open &&
        createPortal(
          <span className="cite-pop" role="tooltip" ref={popRef}>
            <span className="t">{stripMarks(src.title)}</span>
            {domain && <span className="d">{domain}</span>}
          </span>,
          document.body,
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
function ImageView({
  b,
  i,
  ctx,
  sources,
  url,
  root,
  grip,
}: {
  b: ImageBlock;
  i: number;
  ctx?: EditCtx;
  sources?: Source[];
  url: string | null | undefined;
  root: RootAttrs;
  grip: ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const cls = `blk b-image p-${b.place}`;
  const credit = imageCredit(b, sources);
  const box = { maxWidth: `${b.w}px` };
  const editing = !!ctx?.editing;
  return (
    <figure className={cls} {...root} data-edge={b.edge}>
      {url === undefined ? (
        <div className="img-wait" style={{ ...box, aspectRatio: `${b.w} / ${b.h}` }} />
      ) : url === null || broken ? (
        <div className="img-alt" style={box}>
          {b.alt}
        </div>
      ) : (
        <button type="button" className="img" style={box} onClick={() => setBig(true)}>
          {/* 고치기 모드: 사진에서 누른 채 끌어 블록을 고를 수 있게 사진 끌어 내기를 끈다 */}
          <img src={url} alt={b.alt} width={b.w} height={b.h} decoding="async" draggable={editing ? false : undefined} onError={() => setBroken(true)} />
        </button>
      )}
      {(editing || b.caption || credit) && (
        <figcaption>
          {editing && <Field as="span" className="alt" path={[i, "alt"]} value={b.alt} ctx={ctx} plain />}
          {(b.caption || (editing && b.caption !== undefined)) && <Field as="span" className="cap" path={[i, "caption"]} value={b.caption ?? ""} ctx={ctx} />}
          {credit && <CreditLine c={credit} />}
        </figcaption>
      )}
      {big && url && !broken && <Lightbox url={url} b={b} onClose={() => setBig(false)} />}
      {grip}
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
  root,
  grip,
}: {
  b: Block;
  i: number;
  ctx?: EditCtx;
  sources?: Source[];
  isFirstSources: boolean;
  urls: Record<string, string> | null;
  root: RootAttrs;
  grip: ReactNode;
}) {
  const editing = !!ctx?.editing;
  const F = (props: { as: ElementType; className?: string; path: Path; value: string }) => <Field {...props} ctx={ctx} />;
  /** 빈 칸은 읽을 때 안 그린다. 고치기 모드에서는 그려서 다시 채울 수 있게 (키가 없는 선택 칸은 그대로 없음) */
  const show = (v: string | undefined): v is string => v !== undefined && (v !== "" || editing);
  switch (b.type) {
    case "image":
      return <ImageView b={b} i={i} ctx={ctx} sources={sources} url={urls === null ? undefined : (urls[b.src] ?? null)} root={root} grip={grip} />;
    case "verdict":
      return (
        <div className="blk b-verdict" {...root}>
          {show(b.v) && F({ as: "p", className: "v", path: [i, "v"], value: b.v })}
          {show(b.w) && F({ as: "p", className: "w", path: [i, "w"], value: b.w })}
          {grip}
        </div>
      );
    case "text":
      return (
        <div className="blk b-text" {...root}>
          {show(b.h) && F({ as: "h3", path: [i, "h"], value: b.h })}
          {show(b.body) && F({ as: "p", path: [i, "body"], value: b.body })}
          {grip}
        </div>
      );
    case "list":
      return (
        <div className="blk b-list" {...root}>
          {show(b.h) && F({ as: "h3", path: [i, "h"], value: b.h })}
          <ul>
            {b.items.map((t, j) => show(t) && <li key={j}>{F({ as: "span", path: [i, "items", j], value: t })}</li>)}
          </ul>
          {grip}
        </div>
      );
    case "table": {
      const spans = tableSpans(b);
      /** 첫 칸이 merges 에 들지 않은 행 — 첫 열 자동 합치기는 이런 행끼리만 */
      const free = (r: number) => (spans[r]?.[0] ?? null) === null;
      return (
        <div className="blk b-table" {...root}>
          {show(b.h) && F({ as: "h3", path: [i, "h"], value: b.h })}
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
                {/* td 의 data-col: 좁은 화면에서 행이 카드가 될 때 칸 앞에 붙는 열 이름 (globals.css .tbl-wrap 컨테이너 쿼리) */}
                {/* merges(설계서 7-6): 시작 칸에 rowSpan · colSpan, 덮인 칸은 안 그린다. 가로로 합친 칸의 열 이름은 "a · b".
                    첫 열이 세로로 덮인 행은 .dup 에 시작 칸 글 — 넓을 때 숨기고, 행이 카드가 되는 좁은 폭에서는 카드 제목 */}
                {/* 첫 열이 바로 위 행과 같으면(읽을 때만) 한 칸으로 합친다(rowSpan). 이어지는 행의 첫 칸은 .dup — 넓을 때 숨기고, 행이 카드가 되는 좁은 폭에서는 카드 제목 */}
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, j) => {
                      const s = spans[r]?.[j] ?? null;
                      if (s === "covered") {
                        if (j !== 0) return null;
                        let top = r;
                        while (top > 0 && spans[top]?.[0] === "covered") top--;
                        return (
                          <td key={j} className="dup" data-col={b.cols[0] ?? ""}>
                            <Field as="span" path={[i, "rows", top, 0]} value={b.rows[top]?.[0] ?? ""} />
                          </td>
                        );
                      }
                      if (s) {
                        return (
                          <td
                            key={j}
                            rowSpan={s.rows > 1 ? s.rows : undefined}
                            colSpan={s.cols > 1 ? s.cols : undefined}
                            data-col={b.cols.slice(j, j + s.cols).join(" · ")}
                          >
                            {F({ as: "span", path: [i, "rows", r, j], value: c })}
                          </td>
                        );
                      }
                      if (j === 0 && !editing && c !== "") {
                        if (r > 0 && b.rows[r - 1]?.[0] === c && free(r - 1)) {
                          return (
                            <td key={j} className="dup" data-col={b.cols[j] ?? ""}>
                              {F({ as: "span", path: [i, "rows", r, j], value: c })}
                            </td>
                          );
                        }
                        const span = spanOf(b.rows, r, free);
                        if (span > 1) {
                          return (
                            <td key={j} rowSpan={span} data-col={b.cols[j] ?? ""}>
                              {F({ as: "span", path: [i, "rows", r, j], value: c })}
                            </td>
                          );
                        }
                      }
                      return (
                        <td key={j} data-col={b.cols[j] ?? ""}>
                          {F({ as: "span", path: [i, "rows", r, j], value: c })}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {grip}
        </div>
      );
    }
    case "claims":
      return (
        <div className="blk b-claims" {...root}>
          {show(b.h) && F({ as: "h3", path: [i, "h"], value: b.h })}
          {b.items.map(
            (c, j) =>
              show(c.text) && (
                <div className="c" key={j}>
                  <span className={`tag ${c.tag}`}>{c.tag === "fact" ? "사실" : "추정"}</span>
                  <p>
                    {F({ as: "span", path: [i, "items", j, "text"], value: c.text })}
                    {c.refs.map((k, n) => (
                      <Cite key={n} n={k} src={sources?.[k - 1]} />
                    ))}
                  </p>
                </div>
              ),
          )}
          {grip}
        </div>
      );
    case "sources":
      return (
        <div className="blk b-sources" {...root}>
          {show(b.h) && F({ as: "h3", path: [i, "h"], value: b.h })}
          <ol>
            {b.items.map((s, j) => {
              const url = httpUrl(s.url);
              return (
                <li key={j} id={isFirstSources ? `src-${j + 1}` : undefined}>
                  <span>{j + 1}</span>
                  {editing ? (
                    F({ as: "span", className: "t", path: [i, "items", j, "title"], value: s.title })
                  ) : url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {/* 제목을 비웠으면 주소를 글자로 */}
                      {s.title ? marked(s.title) : s.url}
                    </a>
                  ) : (
                    <span className="t">{s.title ? marked(s.title) : s.url}</span>
                  )}
                </li>
              );
            })}
          </ol>
          {grip}
        </div>
      );
  }
}

/** 행 모양 클래스. 소제목이 있는 블록으로 시작하는 행(섹션 머리)은 위에 가는 선 — 빈 소제목은 없는 것으로 */
function rowClass(r: Row, parsed: (Block | null)[]): string {
  const sec = rowBlocks(r).some((k) => {
    const b = parsed[k];
    return !!b && b.type !== "image" && b.type !== "verdict" && !!b.h;
  });
  const shape = r.kind === "one" ? "" : ` ${r.kind === "side" ? "solo" : "pair"} to-${r.side} s-${r.size.replace("/", "-")}`;
  const img = r.kind !== "one" || parsed[r.i]?.type === "image" ? " has-img" : "";
  return `row${shape}${img}${sec ? " sec" : ""}`;
}

export function Blocks({
  blocks,
  ctx,
  images,
  keys,
  notes,
  menu,
}: {
  blocks: unknown[];
  ctx?: EditCtx;
  images?: ImageUrls;
  /** 블록마다 순서가 바뀌어도 유지되는 열쇠 (blocks 와 같은 길이). 없으면 번호 */
  keys?: readonly string[];
  /** 댓글 — 고치기 모드에서는 쓰지 않는다 (손잡이 · 도구 줄과 겹치지 않게) */
  notes?: NotesCtx;
  /** 블록의 우클릭 · 길게 누르기 메뉴 (docs/공통.md 2장). i = 지금 번호, key = 열쇠 */
  menu?: (i: number, key: string) => MenuBind | undefined;
}) {
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

  const keyOf = (i: number) => keys?.[i] ?? `k${i}`;
  const arrange = ctx?.editing ? ctx.arrange : undefined;
  const nc = ctx?.editing ? undefined : notes;

  const one = (i: number) => {
    const b = parsed[i];
    const k = keyOf(i);
    const root: RootAttrs = { id: `b${i}` };
    if (arrange) {
      root["data-bk"] = k;
      root["data-flip"] = k;
      if (arrange.selected.has(k)) root["data-sel"] = "";
      if (arrange.moving.has(k)) root["data-moving"] = "";
    }
    const mb = menu?.(i, k);
    if (mb) Object.assign(root, mb);
    let grip: ReactNode = arrange ? <Grip k={k} a={arrange} /> : null;
    if (nc) {
      const count = nc.counts.get(i) ?? 0;
      const open = nc.open === i;
      root["data-cmt"] = "";
      root.onClick = (e) => {
        const sel = typeof getSelection === "function" ? getSelection() : null;
        if (wantsToggle(e.target, !sel || sel.isCollapsed)) nc.onToggle(i);
      };
      grip = (
        <>
          <button
            type="button"
            className={count === 0 ? "cmt-n num zero" : "cmt-n num"}
            aria-label={count === 0 ? "댓글 적기" : `댓글 ${count}개`}
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              nc.onToggle(i);
            }}
          >
            {count === 0 ? "+" : count}
          </button>
          {open && !nc.side && nc.thread(i)}
        </>
      );
    }
    const unknown = (
      <div className="blk b-unknown" {...root}>
        {UNKNOWN_BLOCK}
        {grip}
      </div>
    );
    return (
      <Boundary key={k} fallback={unknown}>
        {b ? <BlockView b={b} i={i} ctx={ctx} sources={sources} isFirstSources={i === firstSources} urls={map} root={root} grip={grip} /> : unknown}
      </Boundary>
    );
  };

  return (
    <>
      {toRows(parsed).map((r) => {
        // 읽을 때: 보일 것이 없는 블록(사람이 다 비운 블록)은 건너뛰고, 그런 블록뿐인 행은 안 그린다
        const shown = rowBlocks(r).filter((k) => ctx?.editing || !(parsed[k] && isBlankBlock(parsed[k])));
        return shown.length === 0 ? null : (
          <div key={keyOf(r.i)} className={rowClass(r, parsed)}>
            {shown.map(one)}
          </div>
        );
      })}
    </>
  );
}
