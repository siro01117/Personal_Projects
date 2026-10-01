"use client";

// 보고서 화면 (설계서 5장 · 7-1장). 블록 · 오른쪽 차례(블록 8개 이상) · 연필(글자 고치기) · Markdown 복사 · 공유. 열면 읽음 처리.
// 고치기 모드에서는 블록을 고르고 · 지우고 · 옮길 수 있다 (설계서 3장, 조작은 useArrange).
// 저장은 전부 한 줄(queue)로 선다: 글자(ez_edit_text)와 블록 순서(ez_blocks_arrange)가 화면에서 한 순서 그대로 서버에 간다.
//  - 지우기는 알림이 떠 있는 동안 미뤄 둔다(held). 다른 저장이 오거나 고치기 모드를 끄거나 화면을 떠나면 그때 먼저 보낸다
//  - 순서 저장이 실패하면 그 전 모습으로 되돌리고, 그 뒤에 줄 서 있던 저장은 버린다(번호가 어긋난 채 보내지 않는다 — epoch)

import { ThemeToggle } from "./ThemeToggle";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { arrangeBlocks, editRule, tidyText } from "../../lib/blocks";
import { toKorean } from "../../lib/errors";
import { blocksToMarkdown } from "../../lib/markdown";
import { validateName } from "../../lib/names";
import { withDemo } from "../_data/source";
import type { ReportDoc } from "../_data/types";
import { folderTrail, formatDay, freshAt, isUnread, orderWithout, relativeDay, textAt, withTextAt } from "../_logic/drawer";
import { Blocks, Field, tocOf, type EditCtx, type ImageUrls, type Path } from "./Blocks";
import { Crumbs, type Crumb } from "./Crumbs";
import { useDrawer } from "./DrawerContext";
import { Icon } from "./Icon";
import { useFlip } from "./motion/useFlip";
import { HomeButton } from "./Shell";
import { useToast } from "./Toast";
import { useArrange } from "./useArrange";

const CONFLICT = "방금 다른 곳에서 이 보고서를 고쳤습니다";
/** 차례 레일은 블록이 이만큼 이상일 때만 */
export const RAIL_MIN = 8;
/** 지운 뒤 되돌리기 알림이 떠 있는 시간 — 그동안 저장을 미룬다 */
export const DELETE_HOLD_MS = 6000;

/** keys: 블록마다 순서가 바뀌어도 유지되는 열쇠 (blocks 와 같은 길이). 불러올 때 번호로 매긴다 */
type Doc = ReportDoc & { keys: string[] };
/** 순서를 바꾸기 전 모습 (실패 · 되돌리기 때 돌아갈 곳) */
type Snap = { blocks: unknown[]; keys: string[] };
/** 보고서 하나의 저장 상태. 다른 보고서로 넘어가면 새것으로 갈린다 — 떠난 보고서의 저장이 새 보고서를 건드리지 않게 */
type Scope = { id: string; version: number; conflict: boolean; epoch: number };
/** 미뤄 둔 지우기 */
type Held = { scope: Scope; order: number[]; snap: Snap; timer: ReturnType<typeof setTimeout> };

const NO_KEYS: readonly string[] = [];
const NO_ROOT = { current: null };

export function ReportView({ id }: { id: string }) {
  const { data, demo, href, folders, tick, fail } = useDrawer();
  const toast = useToast();
  const router = useRouter();
  const sp = useSearchParams();

  const [doc, setDoc] = useState<Doc | null | "missing">(null);
  const [editing, setEditing] = useState(false);
  const [shareOpen, setShareOpen] = useState(sp.get("share") === "1");
  const [shareBusy, setShareBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mdCopied, setMdCopied] = useState(false);

  const images = useCallback<ImageUrls>((paths) => data.imageUrls(paths), [data]);

  const scope = useRef<Scope>({ id, version: 0, conflict: false, epoch: 0 });
  if (scope.current.id !== id) scope.current = { id, version: 0, conflict: false, epoch: 0 };
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const held = useRef<Held | null>(null);
  const flipArmed = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const shareRef = useRef<HTMLDivElement>(null);
  const shareBtn = useRef<HTMLButtonElement>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const r = await data.report(id);
      if (seq !== loadSeq.current) return;
      if (!r) return setDoc("missing");
      // 새로 읽은 것이 기준이다: 미뤄 둔 지우기와 줄 서 있던 저장은 버린다
      const sc = scope.current;
      if (held.current?.scope === sc) {
        clearTimeout(held.current.timer);
        held.current = null;
      }
      sc.epoch++;
      sc.version = r.version;
      sc.conflict = false;
      setDoc({ ...r, keys: r.blocks.map((_, i) => `k${i}`) });
      // 열면 읽음. 보는 중에 에이전트가 고쳐 다시 불러왔을 때도 본 것으로 친다
      if (isUnread(r)) data.markRead(id).catch(() => {});
    } catch (e) {
      if (seq === loadSeq.current) fail(e);
    }
  }, [data, id, fail]);

  useEffect(() => {
    setDoc(null);
    setEditing(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // 다시 불러오기 신호: 고치는 중에는 덮어쓰지 않는다 — 에이전트가 그 사이 고쳤으면 저장할 때 알게 된다
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const loadRef = useRef(load);
  loadRef.current = load;
  const seenTick = useRef(tick);
  useEffect(() => {
    if (seenTick.current === tick) return;
    seenTick.current = tick;
    if (editingRef.current || pending.current > 0 || held.current) return;
    void loadRef.current();
  }, [tick]);

  // 공유 창: 바깥을 누르면 닫힘
  useEffect(() => {
    if (!shareOpen) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (shareRef.current?.contains(t) || shareBtn.current?.contains(t)) return;
      setShareOpen(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [shareOpen]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  /** 저장 실패: 버전 충돌이면 알리고(새로 불러오기), 아니면 평소 오류 알림 */
  const saveFailed = useCallback(
    (e: unknown, sc: Scope) => {
      const k = toKorean(e);
      if (k.code === "EZ_VERSION") {
        sc.conflict = true;
        if (scope.current === sc) toast(CONFLICT, { label: "새로 불러오기", run: reload }, 12000);
      } else if (k.code === "NAME_TAKEN") {
        toast("같은 이름이 이미 있습니다");
      } else {
        fail(e);
      }
    },
    [toast, fail, reload],
  );

  /** 블록 순서 저장을 줄 세운다. 화면은 이미 바뀌어 있다 — 실패하면 snap 으로 되돌리고 뒤에 줄 선 저장은 버린다 */
  const sendArrange = useCallback(
    (sc: Scope, order: number[], snap: Snap) => {
      const ep = sc.epoch;
      const back = () => {
        sc.epoch++;
        if (scope.current !== sc) return;
        flipArmed.current = true;
        setDoc((d) => (d && d !== "missing" ? { ...d, blocks: snap.blocks, keys: snap.keys } : d));
      };
      pending.current++;
      const job = queue.current.then(async () => {
        try {
          if (ep !== sc.epoch) return;
          if (sc.conflict) return back();
          const v = await data.arrangeBlocks(sc.id, sc.version, order);
          sc.version = v;
          if (scope.current === sc) setDoc((d) => (d && d !== "missing" ? { ...d, version: v } : d));
        } catch (e) {
          if (ep !== sc.epoch) return;
          back();
          saveFailed(e, sc);
        } finally {
          pending.current--;
        }
      });
      queue.current = job;
      return job;
    },
    [data, saveFailed],
  );

  /** 미뤄 둔 지우기를 지금 저장 줄에 세운다 (알림이 사라질 때 · 다른 저장 앞 · 고치기 모드를 끌 때 · 화면을 떠날 때) */
  const flushHeld = useCallback(() => {
    const h = held.current;
    if (!h) return;
    clearTimeout(h.timer);
    held.current = null;
    void sendArrange(h.scope, h.order, h.snap);
  }, [sendArrange]);
  const flushRef = useRef(flushHeld);
  flushRef.current = flushHeld;

  // 화면을 떠나거나 다른 보고서로 넘어갈 때. 창을 그냥 닫으면 저장하지 않는다(안 지워진 채로 남는다 — 안전한 쪽)
  useEffect(() => () => flushRef.current(), [id]);
  useEffect(() => {
    if (!editing) flushRef.current();
  }, [editing]);

  const commit = useCallback(
    async (path: Path, raw: string) => {
      if (doc === null || doc === "missing") return;
      const isTitle = path.length === 1 && path[0] === "title";
      const isAgent = path.length === 1 && path[0] === "agent";
      const rule = editRule(doc.blocks, path);
      const orig = isTitle ? doc.name : isAgent ? (doc.agent ?? "") : textAt(doc.blocks, path);
      if (orig === null || !rule) return;
      // 가운데 줄바꿈은 지키고 줄 끝 공백·앞뒤 빈 줄만 다듬는다. 한 줄 칸에 붙여 넣은 여러 줄은 한 줄로 잇는다
      const value = tidyText(raw, rule.oneLine);
      if (value === orig) return;
      // 빈 칸으로 둘 수 있다 — 보고서 제목만 예외
      if (isTitle) {
        if (value === "") return void toast("이름이 비어 있습니다");
        const bad = validateName(value);
        if (bad) return void toast(bad);
      }

      const sc = scope.current;
      // 화면에서는 블록을 열쇠로 찾는다 — 저장을 기다리는 사이 순서가 바뀌어도 그 블록에 반영 · 되돌림
      const key = typeof path[0] === "number" ? doc.keys[path[0]] : undefined;
      const apply = (v: string) =>
        setDoc((d) => {
          if (!d || d === "missing" || scope.current !== sc) return d;
          if (isTitle) return { ...d, name: v };
          if (isAgent) return { ...d, agent: v === "" ? null : v };
          const i = key === undefined ? -1 : d.keys.indexOf(key);
          return i < 0 ? d : { ...d, blocks: withTextAt(d.blocks, [i, ...path.slice(1)], v) };
        });
      // 미뤄 둔 지우기가 있으면 먼저 저장 줄에 세운다. 화면의 블록은 이미 지운 뒤라 path 는 지운 뒤의 번호다
      flushHeld();
      apply(value);
      pending.current++;
      const ep = sc.epoch;
      const job = queue.current.then(async () => {
        try {
          // 앞선 순서 저장이 실패해 되돌려졌다 — 번호가 어긋났으니 보내지 않는다(글자도 그때 같이 되돌려졌다)
          if (ep !== sc.epoch) return;
          if (sc.conflict) {
            apply(orig);
            return;
          }
          const v = await data.editText(sc.id, sc.version, path, value);
          sc.version = v;
          if (scope.current === sc) setDoc((d) => (d && d !== "missing" ? { ...d, version: v } : d));
        } catch (e) {
          if (ep !== sc.epoch) return;
          apply(orig);
          saveFailed(e, sc);
        } finally {
          pending.current--;
        }
      });
      queue.current = job;
      return job;
    },
    [doc, data, toast, flushHeld, saveFailed],
  );

  // ------------------------------------------------------------ 블록 지우기 · 옮기기

  /** 화면의 블록을 order 대로 바꾼다 (낙관적). 그 전 모습을 돌려준다 */
  const arrangeNow = useCallback((d: Doc, order: number[]): Snap => {
    flipArmed.current = true;
    setDoc((cur) => (cur && cur !== "missing" ? { ...cur, blocks: arrangeBlocks(cur.blocks, order), keys: order.map((i) => cur.keys[i]!) } : cur));
    return { blocks: d.blocks, keys: d.keys };
  }, []);

  const moveBlocks = useCallback(
    (order: number[]) => {
      if (doc === null || doc === "missing") return;
      flushHeld();
      void sendArrange(scope.current, order, arrangeNow(doc, order));
    },
    [doc, flushHeld, sendArrange, arrangeNow],
  );

  const deleteBlocks = useCallback(
    (picked: number[]) => {
      if (doc === null || doc === "missing") return;
      const order = orderWithout(doc.blocks.length, picked);
      if (order.length === doc.blocks.length) return;
      if (order.length === 0) return void toast("블록이 하나는 남아야 합니다");
      flushHeld();
      const snap = arrangeNow(doc, order);
      const h: Held = { scope: scope.current, order, snap, timer: setTimeout(() => flushRef.current(), DELETE_HOLD_MS) };
      held.current = h;
      const n = doc.blocks.length - order.length;
      toast(
        n > 1 ? `블록 ${n}개 삭제` : "블록 삭제",
        {
          label: "되돌리기",
          run: () => {
            // 그 사이 다른 저장이 지우기를 먼저 내보냈으면 되돌릴 수 없다
            if (held.current !== h) return void toast("이미 저장되어 되돌릴 수 없습니다");
            clearTimeout(h.timer);
            held.current = null;
            if (scope.current !== h.scope) return;
            flipArmed.current = true;
            setDoc((d) => (d && d !== "missing" ? { ...d, blocks: snap.blocks, keys: snap.keys } : d));
          },
        },
        DELETE_HOLD_MS,
      );
    },
    [doc, toast, flushHeld, arrangeNow],
  );

  const ready = doc !== null && doc !== "missing";
  const arr = useArrange({ editing: editing && ready, keys: ready ? doc.keys : NO_KEYS, body: bodyRef, line: lineRef, onDelete: deleteBlocks, onMove: moveBlocks });

  // 순서가 바뀐 커밋에서만 나머지 블록이 자리를 비켜 준다 (docs/모션.md 목록 재배치). 글자를 고쳐 높이가 바뀐 것은 움직이지 않는다
  useFlip(editing ? pageRef : NO_ROOT, ".blk[data-flip]", { when: () => flipArmed.current });
  useLayoutEffect(() => {
    flipArmed.current = false;
  });

  // ------------------------------------------------------------ 공유

  async function shareOn() {
    if (doc === null || doc === "missing") return;
    setShareBusy(true);
    try {
      const token = await data.share(id);
      setDoc((d) => (d && d !== "missing" ? { ...d, share_token: token } : d));
    } catch (e) {
      fail(e);
    } finally {
      setShareBusy(false);
    }
  }

  async function shareOff() {
    if (doc === null || doc === "missing") return;
    const prev = doc.share_token;
    setDoc((d) => (d && d !== "missing" ? { ...d, share_token: null } : d));
    try {
      await data.unshare(id);
    } catch (e) {
      setDoc((d) => (d && d !== "missing" ? { ...d, share_token: prev } : d));
      fail(e);
    }
  }

  const shareUrl = doc && doc !== "missing" && doc.share_token && typeof location !== "undefined"
    ? `${location.origin}${withDemo(`/s/${doc.share_token}`, demo)}`
    : null;

  const codeRef = useRef<HTMLElement>(null);
  function copy() {
    if (!shareUrl) return;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    };
    const pick = () => {
      const el = codeRef.current;
      if (!el) return;
      const r = document.createRange();
      r.selectNodeContents(el);
      const g = getSelection();
      g?.removeAllRanges();
      g?.addRange(r);
    };
    try {
      navigator.clipboard.writeText(shareUrl).then(done, pick);
    } catch {
      pick();
    }
  }

  async function copyMarkdown() {
    if (doc === null || doc === "missing") return;
    const md = blocksToMarkdown(doc.name, doc.blocks, { agent: doc.agent, date: formatDay(doc.agent_updated_at ?? doc.updated_at) });
    try {
      await navigator.clipboard.writeText(md);
      setMdCopied(true);
      setTimeout(() => setMdCopied(false), 1400);
    } catch {
      toast("복사하지 못했습니다. 다시 눌러 보세요");
    }
  }

  // ------------------------------------------------------------ 그리기

  const goFolder = (fid: string | null) => router.push(href(fid === null ? "/drawer" : `/drawer/f/${fid}`));
  const trail = ready ? (folderTrail(folders, doc.parent_id) ?? []) : [];
  const crumbs: Crumb[] = [{ id: null, name: "보고서 서랍" }, ...trail.map((f) => ({ id: f.id, name: f.name }))];
  if (ready) crumbs.push({ id: doc.id, name: doc.name, current: true });

  const ctx: EditCtx | undefined = ready ? { raw: doc.blocks, editing, commit, arrange: arr.ctx } : undefined;

  return (
    <>
      <div className="bar-top">
        <HomeButton />
        <Crumbs trail={crumbs} onGo={goFolder} />
        <span className="grow" />
        {ready && (
          <div className="tools">
            {/* 고른 블록이 있을 때만 (터치에서 지우는 길) */}
            {editing && arr.selected.size > 0 && (
              <button type="button" className="iconbtn sel-trash" aria-label="고른 블록 지우기" title="고른 블록 지우기" onClick={arr.remove}>
                <Icon name="trash" />
              </button>
            )}
            <button
              type="button"
              className="iconbtn"
              aria-pressed={editing}
              aria-label="글자 고치기"
              title="글자 고치기"
              onClick={() => {
                (document.activeElement as HTMLElement | null)?.blur?.();
                setEditing((v) => !v);
              }}
            >
              <Icon name="pen" />
            </button>
            <button type="button" className="iconbtn" aria-label="Markdown 복사" title="Markdown 복사" onClick={() => void copyMarkdown()}>
              <Icon name={mdCopied ? "check" : "copy"} />
            </button>
            <button
              type="button"
              ref={shareBtn}
              className="iconbtn"
              aria-expanded={shareOpen}
              aria-pressed={shareOpen}
              aria-label="공유 링크"
              title="공유 링크"
              onClick={() => setShareOpen((v) => !v)}
            >
              <Icon name="link" />
            </button>
          </div>
        )}
        {ready && shareOpen && (
          <div className="share-pop" ref={shareRef}>
            {shareUrl ? (
              <>
                <div className="l">
                  <code ref={codeRef}>{shareUrl}</code>
                  <button type="button" className="btn" onClick={copy}>
                    {copied ? "복사됨" : "복사"}
                  </button>
                </div>
                <p>로그인 없이 읽기만 됩니다. 끄면 이 링크는 막히고, 다시 켜면 새 링크가 생깁니다.</p>
                <button type="button" className="off" onClick={() => void shareOff()}>
                  공유 끄기
                </button>
              </>
            ) : (
              <button type="button" className="btn" style={{ alignSelf: "flex-start" }} disabled={shareBusy} onClick={() => void shareOn()}>
                공유 켜기
              </button>
            )}
          </div>
        )}
        <ThemeToggle />
      </div>
      {doc === "missing" ? (
        <div className="empty">없는 보고서입니다</div>
      ) : ready ? (
        <div
          className={doc.blocks.length >= RAIL_MIN ? "doc-body" : "doc-body no-rail"}
          ref={bodyRef}
          onPointerDown={editing ? arr.onBodyDown : undefined}
          onClick={editing ? arr.onBodyClick : undefined}
        >
          <article className={editing ? "page editing" : "page"} ref={pageRef}>
            <div className="blk b-head">
              <Field as="h1" path={["title"]} value={doc.name} ctx={ctx} />
              {/* 작성자 · n일 전 (에이전트가 마지막으로 쓴 때, 없으면 만든 때). 작성자는 고칠 수 있고 날짜는 자동. 작성자가 없으면 날짜만 */}
              <div className="by">
                {(editing || doc.agent) && (
                  <>
                    <Field as="span" className="who" path={["agent"]} value={doc.agent ?? ""} ctx={ctx} plain />
                    {" · "}
                  </>
                )}
                <span>{relativeDay(freshAt(doc))}</span>
              </div>
            </div>
            <Blocks blocks={doc.blocks} ctx={ctx} images={images} keys={doc.keys} />
          </article>
          {editing && <div className="drop-line" ref={lineRef} aria-hidden="true" />}
          {doc.blocks.length >= RAIL_MIN && <Rail blocks={doc.blocks} />}
        </div>
      ) : null}
    </>
  );
}

export function Rail({ blocks }: { blocks: unknown[] }) {
  return (
    <nav className="rail" aria-label="차례">
      {tocOf(blocks).map(([i, name]) => (
        <a
          key={i}
          href={`#b${i}`}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(`b${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {name}
        </a>
      ))}
    </nav>
  );
}
