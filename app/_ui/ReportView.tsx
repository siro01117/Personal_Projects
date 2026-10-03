"use client";

// 보고서 화면 (설계서 5장 · 7-1장). 블록 · 오른쪽 차례(블록 8개 이상) · 연필(글자 고치기) · Markdown 복사 · 공유. 열면 읽음 처리.
// 고치기 모드에서는 블록을 고르고 · 지우고 · 옮길 수 있다 (설계서 3장, 조작은 useArrange).
// 저장은 전부 한 줄(queue)로 선다: 글자(ez_edit_text)와 블록 순서(ez_blocks_arrange)가 화면에서 한 순서 그대로 서버에 간다.
//  - 지우기는 알림이 떠 있는 동안 미뤄 둔다(held). 다른 저장이 오거나 고치기 모드를 끄거나 화면을 떠나면 그때 먼저 보낸다
//  - 순서 저장이 실패하면 그 전 모습으로 되돌리고, 그 뒤에 줄 서 있던 저장은 버린다(번호가 어긋난 채 보내지 않는다 — epoch)
// 고치는 동안에는 종이 왼쪽에 도구 줄(EditBar)이 선다: 휴지통 · 위/아래 · 완료. 되돌리기(Ctrl+Z) · 전부 고르기(Ctrl+A)는 키로만.
// 되돌리기 기록(undo)은 이 화면을 연 동안 쌓인다. 글자는 블록 열쇠로 기억했다가 원래 글자를 다시 저장하고, 옮기기는 거꾸로 옮긴다.
//  - 지우기는 아직 미뤄 둔(held) 동안만 살린다. 지우기가 저장되면(flushHeld) 번호가 달라지므로 기록을 전부 비운다
//  - 새로 불러오거나(load) 순서 저장이 실패해 되돌려질 때(epoch 가 바뀔 때)도 비운다. 되돌리기 자체는 기록을 남기지 않는다
// 읽은 사람 (설계서 7-4장): 기록(ez_views)은 열어 둔 동안 30초마다(tick) 다시 읽고, 라이브는 공유가 켜져 있을 때 presence 채널을 듣는다.
//  - 도구 줄의 아바타 줄(없으면 눈) → 작은 창. 보는 블록 왼쪽에 작은 아바타(PeerMarks), 차례 레일에 점
// 방명록 · 댓글 · 방문 (설계서 7-5장): 글(ez_notes)도 기록과 같이 30초마다 읽는다. 작은 창은 세 칸(보는 사람 · 방명록 · 댓글).
//  - 마지막으로 창을 연 때를 기기에 기억해, 그 뒤에 온 것이 있으면 단추와 칸에 키위 점. 본 사람을 누르면 방문 목록(날짜 · 읽은 시간 · 그때 버전)
//  - 댓글은 블록 옆에 공개 페이지와 같은 모양으로(고치기 모드가 아닐 때만). 주인은 답글(by_owner)을 달고 아무 글이나 지운다
//  - 버전이 바뀌어 블록을 다시 찾은 댓글은 그 블록 옆에, 못 찾은 것은 창의 댓글 칸에 "원래 n번째 블록"

import { ThemeToggle } from "./ThemeToggle";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { arrangeBlocks, editRule, isSameOrder, tidyText } from "../../lib/blocks";
import { toKorean } from "../../lib/errors";
import { blocksToMarkdown } from "../../lib/markdown";
import { validateName } from "../../lib/names";
import { browserStore } from "../_data/cache";
import { withDemo } from "../_data/source";
import type { NoteRow, Presence, ReportDoc, ViewRow, VisitRow } from "../_data/types";
import {
  folderTrail,
  formatDay,
  freshAt,
  isUnread,
  orderBack,
  orderWithout,
  pushUndo,
  relativeDay,
  textAt,
  undoForText,
  undoTextPath,
  withTextAt,
  type UndoEntry,
} from "../_logic/drawer";
import { anchorsOf, hasNew, lostLabel, markSeen, newSince, noteCounts, placeNotes, seenAt } from "../_logic/notes";
import { liveNow } from "../_logic/views";
import { useApp } from "./AppContext";
import { Blocks, Field, tocOf, type EditCtx, type ImageUrls, type NotesCtx, type Path } from "./Blocks";
import { Crumbs, type Crumb } from "./Crumbs";
import { useDrawer } from "./DrawerContext";
import { EditBar, type EditAct } from "./EditBar";
import { Icon } from "./Icon";
import { useFlip } from "./motion/useFlip";
import { HomeButton } from "./Shell";
import { useToast } from "./Toast";
import { useArrange } from "./useArrange";
import { NoteInput, NoteList, Thread } from "./Notes";
import { PeerMarks, ViewersButton, ViewsPop, type ReadersTab } from "./Viewers";

const CONFLICT = "방금 다른 곳에서 이 보고서를 고쳤습니다";
/** 차례 레일은 블록이 이만큼 이상일 때만 */
export const RAIL_MIN = 8;
/** 지운 뒤 되돌리기 알림이 떠 있는 시간 — 그동안 저장을 미룬다 */
export const DELETE_HOLD_MS = 6000;
/** 주인 화면에서 주인 글의 이름 */
const ME = "나";

/** keys: 블록마다 순서가 바뀌어도 유지되는 열쇠 (blocks 와 같은 길이). 불러올 때 번호로 매긴다 */
type Doc = ReportDoc & { keys: string[] };
/** 순서를 바꾸기 전 모습 (실패 · 되돌리기 때 돌아갈 곳) */
type Snap = { blocks: unknown[]; keys: string[] };
/** 보고서 하나의 저장 상태. 다른 보고서로 넘어가면 새것으로 갈린다 — 떠난 보고서의 저장이 새 보고서를 건드리지 않게 */
type Scope = { id: string; version: number; conflict: boolean; epoch: number };
/** 미뤄 둔 지우기 */
type Held = { scope: Scope; order: number[]; snap: Snap; timer: ReturnType<typeof setTimeout>; closeToast: () => void };
type Undo = UndoEntry<Held>;

const NO_KEYS: readonly string[] = [];
const NO_BLOCKS: unknown[] = [];
const NO_ROOT = { current: null };
const ALL = () => true;

export function ReportView({ id }: { id: string }) {
  const { data, demo, href, folders, tick, fail } = useDrawer();
  const { live } = useApp().src;
  const toast = useToast();
  const router = useRouter();
  const sp = useSearchParams();

  const [doc, setDoc] = useState<Doc | null | "missing">(null);
  const [editing, setEditing] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [shareOpen, setShareOpen] = useState(sp.get("share") === "1");
  const [shareBusy, setShareBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mdCopied, setMdCopied] = useState(false);
  const [views, setViews] = useState<ViewRow[]>([]);
  const [presence, setPresence] = useState<Presence[] | null>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [viewsMore, setViewsMore] = useState(false);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [openBlock, setOpenBlock] = useState<number | null>(null);
  const [tab, setTab] = useState<ReadersTab>("viewers");
  /** 방문 목록을 펼친 사람 · 그 사람의 방문 */
  const [picked, setPicked] = useState<string | null>(null);
  const [visits, setVisits] = useState<VisitRow[] | null>(null);
  /** 마지막으로 창을 연 때 (기기에 기억). 창을 여는 순간 지금으로 바뀌고, 열려 있는 동안의 점은 popSeen 기준 */
  const [seen, setSeen] = useState<string | null>(null);
  const [popSeen, setPopSeen] = useState<string | null>(null);

  const images = useCallback<ImageUrls>((paths) => data.imageUrls(paths), [data]);

  const scope = useRef<Scope>({ id, version: 0, conflict: false, epoch: 0 });
  if (scope.current.id !== id) scope.current = { id, version: 0, conflict: false, epoch: 0 };
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const held = useRef<Held | null>(null);
  const undo = useRef<Undo[]>([]);
  const flipArmed = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const shareRef = useRef<HTMLDivElement>(null);
  const shareBtn = useRef<HTMLButtonElement>(null);
  const viewsRef = useRef<HTMLDivElement>(null);
  const viewsBtn = useRef<HTMLButtonElement>(null);
  const loadSeq = useRef(0);

  const record = useCallback((e: Undo) => {
    undo.current = pushUndo(undo.current, e);
    setCanUndo(true);
  }, []);
  /** 기록 하나를 뺀다. 안 주면 전부 비운다 */
  const forget = useCallback((e?: Undo) => {
    undo.current = e ? undo.current.filter((x) => x !== e) : [];
    setCanUndo(undo.current.length > 0);
  }, []);

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
      forget();
      sc.version = r.version;
      sc.conflict = false;
      setDoc({ ...r, keys: r.blocks.map((_, i) => `k${i}`) });
      // 열면 읽음. 보는 중에 에이전트가 고쳐 다시 불러왔을 때도 본 것으로 친다
      if (isUnread(r)) data.markRead(id).catch(() => {});
    } catch (e) {
      if (seq === loadSeq.current) fail(e);
    }
  }, [data, id, fail, forget]);

  useEffect(() => {
    setDoc(null);
    setEditing(false);
    forget();
  }, [id, forget]);

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

  // 공유 창 · 읽은 사람 창: 바깥을 누르면 닫힘
  useEffect(() => {
    if (!shareOpen && !viewsOpen) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (shareOpen && !(shareRef.current?.contains(t) || shareBtn.current?.contains(t))) setShareOpen(false);
      if (viewsOpen && !(viewsRef.current?.contains(t) || viewsBtn.current?.contains(t))) setViewsOpen(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [shareOpen, viewsOpen]);

  // ------------------------------------------------------------ 읽은 사람

  // 기록 · 글: 열 때와 30초마다(tick — 탭이 숨겨지면 멈춘다). 다른 보고서로 넘어가면 비운다
  const docReady = doc !== null && doc !== "missing";
  useEffect(() => {
    setViews([]);
    setViewsMore(false);
    setNotes([]);
    setOpenBlock(null);
    setTab("viewers");
    setPicked(null);
    setVisits(null);
    setSeen(seenAt(browserStore(), id));
  }, [id]);
  useEffect(() => {
    if (!docReady) return;
    let alive = true;
    data.views(id).then(
      (rows) => alive && setViews(rows),
      () => {},
    );
    data.notes(id).then(
      (rows) => alive && setNotes(rows),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [data, id, docReady, tick]);

  // 창을 열면: 열려 있는 동안의 점은 그 전에 본 때 기준, 단추의 점은 바로 꺼진다 (지금을 본 때로 기억)
  useEffect(() => {
    if (!viewsOpen) return;
    setPopSeen(seen);
    const at = new Date();
    markSeen(browserStore(), id, at);
    setSeen(at.toISOString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewsOpen, id]);

  // 본 사람을 누르면 그 사람의 방문들
  useEffect(() => {
    if (!picked) return;
    let alive = true;
    setVisits(null);
    data.visits(picked).then(
      (rows) => alive && setVisits(rows),
      (e) => alive && fail(e),
    );
    return () => {
      alive = false;
    };
  }, [data, picked, fail]);

  // 라이브: 공유가 켜져 있는 동안 채널을 듣는다 (자기 상태는 올리지 않는다). 안 되면 null → 기록의 70초 판정만
  const shareToken = docReady ? doc.share_token : null;
  useEffect(() => {
    if (!shareToken) {
      setPresence(null);
      return;
    }
    return live.watch(shareToken, setPresence);
  }, [live, shareToken]);

  const now = new Date();
  const liveNowList = liveNow(presence, views, now);
  const liveBlocks = new Set(liveNowList.flatMap((p) => (p.block === null ? [] : [p.block])));

  // ------------------------------------------------------------ 방명록 · 댓글

  const blocksNow = docReady ? doc.blocks : NO_BLOCKS;
  const versionNow = docReady ? doc.version : 0;
  const anchors = useMemo(() => anchorsOf(blocksNow), [blocksNow]);
  const placed = useMemo(() => placeNotes(notes, anchors, versionNow), [notes, anchors, versionNow]);
  const counts = useMemo(() => noteCounts(placed), [placed]);
  const dots = newSince(views, notes, seen);
  const popDots = newSince(views, notes, popSeen);

  const reply = useCallback(
    async (body: string, block?: number) => {
      const row = await data.noteReply(id, body, block ?? null, block === undefined ? null : (anchors[block] ?? null));
      setNotes((list) => [...list, row]);
    },
    [data, id, anchors],
  );

  const removeNote = useCallback(
    async (noteId: string) => {
      let prev: NoteRow[] = [];
      setNotes((list) => {
        prev = list;
        return list.filter((x) => x.id !== noteId);
      });
      try {
        await data.noteDelete(noteId);
      } catch (e) {
        setNotes(prev);
        throw e;
      }
    },
    [data],
  );

  /** 창의 댓글 칸에서 블록을 누르면 그 블록으로 가서 댓글 줄을 펼친다 */
  const goBlock = useCallback((i: number) => {
    setViewsOpen(false);
    setOpenBlock(i);
    requestAnimationFrame(() => document.getElementById(`b${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, []);

  const notesCtx: NotesCtx | undefined = docReady
    ? {
        counts,
        open: openBlock,
        onToggle: (i) => setOpenBlock((cur) => (cur === i ? null : i)),
        thread: (i) => (
          <Thread
            notes={placed.byBlock.get(i) ?? []}
            current={versionNow}
            ownerLabel={ME}
            now={now}
            canDelete={ALL}
            onDelete={removeNote}
            onWrite={(body) => reply(body, i)}
          />
        ),
      }
    : undefined;

  /** 창의 댓글 칸: 전부 — 다시 찾은 것은 그 블록 이름(누르면 그 블록으로), 못 찾은 것은 "원래 n번째 블록" */
  const commentRows = useMemo(() => {
    const at = new Map<string, number>();
    for (const [i, list] of placed.byBlock) for (const n of list) at.set(n.id, i);
    return [...placed.byBlock.values()].flat().concat(placed.lost).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }, [placed]);
  const placeOf = (n: NoteRow) => {
    for (const [i, list] of placed.byBlock) {
      if (!list.includes(n)) continue;
      return (
        <button type="button" className="lnk plc" onClick={() => goBlock(i)}>
          {anchors[i] ?? `${i + 1}번째 블록`}
        </button>
      );
    }
    return <span className="plc">{lostLabel(n)}</span>;
  };

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
        forget();
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
    [data, saveFailed, forget],
  );

  /** 미뤄 둔 지우기를 지금 저장 줄에 세운다 (알림이 사라질 때 · 다른 저장 앞 · 고치기 모드를 끌 때 · 화면을 떠날 때) */
  const flushHeld = useCallback(() => {
    const h = held.current;
    if (!h) return;
    clearTimeout(h.timer);
    held.current = null;
    // 저장된 지우기는 되돌릴 수 없고, 번호가 달라지니 그 앞의 기록도 쓸 수 없다
    forget();
    void sendArrange(h.scope, h.order, h.snap);
  }, [sendArrange, forget]);
  const flushRef = useRef(flushHeld);
  flushRef.current = flushHeld;

  // 화면을 떠나거나 다른 보고서로 넘어갈 때. 창을 그냥 닫으면 저장하지 않는다(안 지워진 채로 남는다 — 안전한 쪽)
  useEffect(() => () => flushRef.current(), [id]);
  useEffect(() => {
    if (!editing) flushRef.current();
  }, [editing]);

  const commit = useCallback(
    /** quiet = 되돌리기가 부른 저장 (기록을 남기지 않는다) */
    async (path: Path, raw: string, quiet = false) => {
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
      const entry = quiet ? null : undoForText(doc.keys, path, orig);
      if (entry) record(entry);
      apply(value);
      pending.current++;
      const ep = sc.epoch;
      const job = queue.current.then(async () => {
        try {
          // 앞선 순서 저장이 실패해 되돌려졌다 — 번호가 어긋났으니 보내지 않는다(글자도 그때 같이 되돌려졌다)
          if (ep !== sc.epoch) return;
          if (sc.conflict) {
            apply(orig);
            if (entry && scope.current === sc) forget(entry);
            return;
          }
          const v = await data.editText(sc.id, sc.version, path, value);
          sc.version = v;
          if (scope.current === sc) setDoc((d) => (d && d !== "missing" ? { ...d, version: v } : d));
        } catch (e) {
          if (ep !== sc.epoch) return;
          apply(orig);
          if (entry && scope.current === sc) forget(entry);
          saveFailed(e, sc);
        } finally {
          pending.current--;
        }
      });
      queue.current = job;
      return job;
    },
    [doc, data, toast, flushHeld, saveFailed, record, forget],
  );

  // ------------------------------------------------------------ 블록 지우기 · 옮기기

  /** 화면의 블록을 order 대로 바꾼다 (낙관적). 그 전 모습을 돌려준다 */
  const arrangeNow = useCallback((d: Doc, order: number[]): Snap => {
    flipArmed.current = true;
    setDoc((cur) => (cur && cur !== "missing" ? { ...cur, blocks: arrangeBlocks(cur.blocks, order), keys: order.map((i) => cur.keys[i]!) } : cur));
    return { blocks: d.blocks, keys: d.keys };
  }, []);

  const move = useCallback(
    /** quiet = 되돌리기가 부른 옮기기 (기록을 남기지 않는다) */
    (order: number[], quiet = false) => {
      if (doc === null || doc === "missing") return;
      flushHeld();
      if (!quiet) record({ kind: "move", keys: doc.keys });
      void sendArrange(scope.current, order, arrangeNow(doc, order));
    },
    [doc, flushHeld, sendArrange, arrangeNow, record],
  );
  const moveBlocks = useCallback((order: number[]) => move(order), [move]);

  /** 미뤄 둔 지우기를 없던 일로 (알림의 되돌리기 · 도구 줄의 되돌리기) */
  const revive = useCallback((h: Held) => {
    clearTimeout(h.timer);
    held.current = null;
    if (scope.current !== h.scope) return;
    flipArmed.current = true;
    setDoc((d) => (d && d !== "missing" ? { ...d, blocks: h.snap.blocks, keys: h.snap.keys } : d));
  }, []);

  const deleteBlocks = useCallback(
    (picked: number[]) => {
      if (doc === null || doc === "missing") return;
      const order = orderWithout(doc.blocks.length, picked);
      if (order.length === doc.blocks.length) return;
      if (order.length === 0) return void toast("블록이 하나는 남아야 합니다");
      flushHeld();
      const snap = arrangeNow(doc, order);
      const h: Held = { scope: scope.current, order, snap, timer: setTimeout(() => flushRef.current(), DELETE_HOLD_MS), closeToast: () => {} };
      held.current = h;
      const entry: Undo = { kind: "delete", held: h };
      record(entry);
      const n = doc.blocks.length - order.length;
      h.closeToast = toast(
        n > 1 ? `블록 ${n}개 삭제` : "블록 삭제",
        {
          label: "되돌리기",
          run: () => {
            // 그 사이 다른 저장이 지우기를 먼저 내보냈으면 되돌릴 수 없다
            if (held.current !== h) return void toast("이미 저장되어 되돌릴 수 없습니다");
            forget(entry);
            revive(h);
          },
        },
        DELETE_HOLD_MS,
      );
    },
    [doc, toast, flushHeld, arrangeNow, record, forget, revive],
  );

  /** 방금 한 고치기 하나를 되돌린다. 더는 가리킬 곳이 없는 기록은 건너뛴다 */
  const undoLast = useCallback(() => {
    if (doc === null || doc === "missing") return;
    for (let e = undo.current.at(-1); e; e = undo.current.at(-1)) {
      forget(e);
      if (e.kind === "delete") {
        if (held.current !== e.held) continue;
        e.held.closeToast();
        revive(e.held);
        return;
      }
      if (e.kind === "move") {
        const order = orderBack(doc.keys, e.keys);
        if (!order || isSameOrder(order.length, order)) continue;
        move(order, true);
        return;
      }
      const path = undoTextPath(doc.keys, e);
      if (!path) continue;
      void commit(path, e.value, true);
      return;
    }
  }, [doc, forget, revive, move, commit]);

  const done = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setEditing(false);
  }, []);

  const ready = doc !== null && doc !== "missing";
  const arr = useArrange({
    editing: editing && ready,
    keys: ready ? doc.keys : NO_KEYS,
    body: bodyRef,
    line: lineRef,
    onDelete: deleteBlocks,
    onMove: moveBlocks,
    onUndo: undoLast,
    onDone: done,
  });

  // 도구 줄. 칸에 커서가 있는 채로 누르면 그 칸을 먼저 저장(blur)하고, 그 저장이 화면에 반영된 뒤에 동작한다
  const acts = useRef<Record<EditAct, () => void>>(null!);
  acts.current = { up: () => arr.step(-1), down: () => arr.step(1), trash: arr.remove, done };
  const act = useCallback((name: EditAct) => {
    const el = document.activeElement as HTMLElement | null;
    if (!el?.isContentEditable) return acts.current[name]();
    el.blur();
    setTimeout(() => acts.current[name](), 0);
  }, []);

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
            <ViewersButton
              ref={viewsBtn}
              live={liveNowList}
              open={viewsOpen}
              dot={hasNew(dots)}
              onClick={() => {
                setShareOpen(false);
                setViewsOpen((v) => !v);
              }}
            />
            <button
              type="button"
              ref={shareBtn}
              className="iconbtn"
              aria-expanded={shareOpen}
              aria-pressed={shareOpen}
              aria-label="공유 링크"
              title="공유 링크"
              onClick={() => {
                setViewsOpen(false);
                setShareOpen((v) => !v);
              }}
            >
              <Icon name="link" />
            </button>
          </div>
        )}
        {ready && viewsOpen && (
          <ViewsPop
            ref={viewsRef}
            live={liveNowList}
            rows={views}
            toc={tocOf(doc.blocks)}
            now={now}
            expanded={viewsMore}
            onMore={() => setViewsMore(true)}
            tab={tab}
            onTab={setTab}
            dots={popDots}
            picked={picked}
            onPick={(vid) => setPicked((cur) => (cur === vid ? null : vid))}
            visits={visits}
            version={doc.version}
            guestbook={
              <div className="vp-notes">
                <NoteList notes={placed.guestbook} current={doc.version} ownerLabel={ME} now={now} canDelete={ALL} onDelete={removeNote} small />
                <NoteInput placeholder="답글" ariaLabel="방명록 답글" onSave={(body) => reply(body)} />
              </div>
            }
            comments={
              <div className="vp-notes">
                {commentRows.length === 0 ? (
                  <p className="none">아직 댓글이 없습니다</p>
                ) : (
                  <NoteList notes={commentRows} current={doc.version} ownerLabel={ME} now={now} canDelete={ALL} onDelete={removeNote} place={placeOf} small />
                )}
              </div>
            }
          />
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
            <Blocks blocks={doc.blocks} ctx={ctx} images={images} keys={doc.keys} notes={notesCtx} />
            {!editing && <PeerMarks live={liveNowList} page={pageRef} blockCount={doc.blocks.length} />}
          </article>
          {editing && <div className="drop-line" ref={lineRef} aria-hidden="true" />}
          {editing && <EditBar canUp={arr.canUp} canDown={arr.canDown} hasSelection={arr.selected.size > 0} onAct={act} />}
          {doc.blocks.length >= RAIL_MIN && <Rail blocks={doc.blocks} marks={liveBlocks} />}
        </div>
      ) : null}
    </>
  );
}

/** marks: 지금 누가 보고 있는 블록 번호들 — 그 블록이 속한 절 항목 옆에 점 */
export function Rail({ blocks, marks }: { blocks: unknown[]; marks?: ReadonlySet<number> }) {
  const toc = tocOf(blocks);
  // 블록 번호 → 그 블록이 속한 차례 항목(그 번호 이하 가장 가까운 것)
  const marked = new Set<number>();
  if (marks) {
    for (const b of marks) {
      let hit: number | null = null;
      for (const [i] of toc) {
        if (i > b) break;
        hit = i;
      }
      if (hit !== null) marked.add(hit);
    }
  }
  return (
    <nav className="rail" aria-label="차례">
      {toc.map(([i, name]) => (
        <a
          key={i}
          href={`#b${i}`}
          data-live={marked.has(i) ? "" : undefined}
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
