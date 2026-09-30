"use client";

// 보고서 화면 (설계서 5장 · 7-1장). 블록 · 오른쪽 차례(블록 8개 이상) · 연필(글자 고치기) · Markdown 복사 · 공유. 열면 읽음 처리.

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toKorean } from "../../lib/errors";
import { blocksToMarkdown } from "../../lib/markdown";
import { validateName } from "../../lib/names";
import { withDemo } from "../_data/source";
import type { ReportDoc } from "../_data/types";
import { folderTrail, formatDay, freshAt, isUnread, relativeDay, textAt, withTextAt } from "../_logic/drawer";
import { Blocks, Field, tocOf, type EditCtx, type ImageUrls, type Path } from "./Blocks";
import { Crumbs, type Crumb } from "./Crumbs";
import { useDrawer } from "./DrawerContext";
import { Icon } from "./Icon";
import { HomeButton } from "./Shell";
import { useToast } from "./Toast";

const CONFLICT = "방금 다른 곳에서 이 보고서를 고쳤습니다";
/** 차례 레일은 블록이 이만큼 이상일 때만 */
export const RAIL_MIN = 8;

export function ReportView({ id }: { id: string }) {
  const { data, demo, href, folders, tick, fail } = useDrawer();
  const toast = useToast();
  const router = useRouter();
  const sp = useSearchParams();

  const [doc, setDoc] = useState<ReportDoc | null | "missing">(null);
  const [editing, setEditing] = useState(false);
  const [shareOpen, setShareOpen] = useState(sp.get("share") === "1");
  const [shareBusy, setShareBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mdCopied, setMdCopied] = useState(false);

  const images = useCallback<ImageUrls>((paths) => data.imageUrls(paths), [data]);

  const version = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const conflict = useRef(false);
  const shareRef = useRef<HTMLDivElement>(null);
  const shareBtn = useRef<HTMLButtonElement>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const r = await data.report(id);
      if (seq !== loadSeq.current) return;
      if (!r) return setDoc("missing");
      version.current = r.version;
      conflict.current = false;
      setDoc(r);
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
    if (editingRef.current || pending.current > 0) return;
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

  const commit = useCallback(
    async (path: Path, raw: string) => {
      if (doc === null || doc === "missing") return;
      const isTitle = path.length === 1 && path[0] === "title";
      const orig = isTitle ? doc.name : textAt(doc.blocks, path);
      if (orig === null) return;
      const value = raw.trim();
      if (value === orig) return;
      if (value === "") return void toast(isTitle ? "이름이 비어 있습니다" : "빈 칸으로 둘 수 없습니다");
      if (isTitle) {
        const bad = validateName(value);
        if (bad) return void toast(bad);
      }

      const apply = (v: string) =>
        setDoc((d) => (d && d !== "missing" ? (isTitle ? { ...d, name: v } : { ...d, blocks: withTextAt(d.blocks, path, v) }) : d));
      apply(value);
      pending.current++;
      const job = queue.current.then(async () => {
        try {
          if (conflict.current) {
            apply(orig);
            return;
          }
          const v = await data.editText(id, version.current, path, value);
          version.current = v;
          setDoc((d) => (d && d !== "missing" ? { ...d, version: v } : d));
        } catch (e) {
          apply(orig);
          const k = toKorean(e);
          if (k.code === "EZ_VERSION") {
            conflict.current = true;
            toast(CONFLICT, { label: "새로 불러오기", run: reload }, 12000);
          } else if (k.code === "NAME_TAKEN") {
            toast("같은 이름이 이미 있습니다");
          } else {
            fail(e);
          }
        } finally {
          pending.current--;
        }
      });
      queue.current = job;
      return job;
    },
    [doc, data, id, toast, fail, reload],
  );

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
  const ready = doc !== null && doc !== "missing";
  const trail = ready ? (folderTrail(folders, doc.parent_id) ?? []) : [];
  const crumbs: Crumb[] = [{ id: null, name: "보고서 서랍" }, ...trail.map((f) => ({ id: f.id, name: f.name }))];
  if (ready) crumbs.push({ id: doc.id, name: doc.name, current: true });

  const ctx: EditCtx | undefined = ready ? { raw: doc.blocks, editing, commit } : undefined;
  // 신선도: 작성 에이전트 · n일 전 (에이전트가 마지막으로 쓴 때, 없으면 만든 때). 색·경고 없음
  const by = ready ? [doc.agent, relativeDay(freshAt(doc))].filter(Boolean).join(" · ") : "";

  return (
    <>
      <div className="bar-top">
        <HomeButton />
        <Crumbs trail={crumbs} onGo={goFolder} />
        <span className="grow" />
        {ready && (
          <div className="tools">
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
      </div>
      {doc === "missing" ? (
        <div className="empty">없는 보고서입니다</div>
      ) : ready ? (
        <div className={doc.blocks.length >= RAIL_MIN ? "doc-body" : "doc-body no-rail"}>
          <article className={editing ? "page editing" : "page"}>
            <div className="blk b-head">
              <Field as="h1" path={["title"]} value={doc.name} ctx={ctx} />
              <div className="by">{by}</div>
            </div>
            <Blocks blocks={doc.blocks} ctx={ctx} images={images} />
          </article>
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
