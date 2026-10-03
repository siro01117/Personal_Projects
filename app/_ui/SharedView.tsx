"use client";

// 공유 페이지 — 로그인 없이 ez_shared 로 읽기만(사진의 내 PC 경로는 DB 가 빼고 준다). 없거나 꺼졌거나 지웠으면 한 줄 (있었는지 드러내지 않는다).
// 읽은 사람 (설계서 7-4장): 처음 열면 바로 보고서. 조용히 ez_view_open(기기 열쇠 · 기기 힌트) → 라이브 채널 들어가기 → 핑.
//  - 핑은 보이는 동안 30초마다 (그 사이 보인 초를 함께, 60초까지). 숨겨지면 한 번 보내고 멈추고 채널에서 나간다. 돌아오면 바로 한 번 + 다시 들어간다.
//    페이지를 떠날 때(pagehide)는 keepalive 로 마지막 한 번
//  - 라이브에는 {기기, 라벨, 화면 가운데 블록 번호} 만 올린다. 블록은 스크롤이 멈춘 뒤 300ms, 바뀔 때만. 남의 상태는 읽지 않는다
//  - 맨 아래 작은 글자 "이름 적기"(이미 적었으면 "이름 · 바꾸기"). 한글 조합 중 Enter 는 무시. 비우면 다시 게스트 n
//  - 주인 본인(로그인 세션)은 DB 가 건너뛴다(open 이 빈 결과) — 그때는 핑 · 라이브 · 이름 칸 · 적는 칸 모두 없다
// 방명록 · 댓글 (설계서 7-5장): 글은 ez_notes_list 로 읽고(열어 둔 동안 30초마다 다시), 쓰기 · 고치기 · 지우기는 기기 열쇠로.
//  - 맨 아래 방명록(글 목록 + 적는 칸). 블록 옆 댓글 수, 블록을 누르면 그 아래 댓글 줄 + 적는 칸. 자기 것(같은 게스트 번호)만 고치고 지운다
//  - 글마다 썼을 때 버전 — 지금 버전과 다르면 옅은 v12. 버전이 바뀌어 옮겨진 블록은 anchor 로 다시 찾는다 (_logic/notes)
//  - 라벨이 "게스트 n" 이면 적는 칸 옆에 "이름 적기" 가 한 번 더 보인다

import { ThemeToggle } from "./ThemeToggle";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { charCount } from "../../lib/names";
import { DbError, toKorean } from "../../lib/errors";
import { browserStore } from "../_data/cache";
import { useSource } from "../_data/source";
import type { LiveSession, NoteRow, Presence, SharedDoc, Viewer } from "../_data/types";
import { formatDay } from "../_logic/drawer";
import { anchorsOf, noteCounts, NOTES_REFRESH_MS, placeNotes } from "../_logic/notes";
import { centerBlock, deviceOf, PING_MS, SEEN_MAX_SEC, uaHint, VIEWER_NAME_MAX, viewerLabel } from "../_logic/views";
import { Blocks, type ImageUrls, type NotesCtx } from "./Blocks";
import { NoteInput, NoteList, Thread } from "./Notes";
import { Rail, RAIL_MIN } from "./ReportView";

/** 스크롤이 멈춘 뒤 이만큼 지나면 가운데 블록을 다시 본다 */
const SCROLL_SETTLE_MS = 300;
const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;
/** 공개 페이지에서 주인 글의 이름 */
const OWNER = "주인";

export function SharedView({ token }: { token: string }) {
  const src = useSource();
  const [doc, setDoc] = useState<SharedDoc | null | "gone">(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [naming, setNaming] = useState(false);
  const [nameIn, setNameIn] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [openBlock, setOpenBlock] = useState<number | null>(null);
  /** 라이브에 올린 상태 · 들어가 있는 채널 */
  const state = useRef<Presence | null>(null);
  const session = useRef<LiveSession | null>(null);
  const nameRef = useRef<HTMLDivElement>(null);
  // 사진은 로그인 없이(anon) — 공유 켜진 보고서가 쓰는 것만 정책이 허용한다
  const images = useCallback<ImageUrls>((paths) => (src ? src.data.imageUrls(paths, true) : Promise.resolve({})), [src]);

  useEffect(() => {
    if (!src) return;
    let alive = true;
    src.data.shared(token).then(
      (d) => alive && setDoc(d ?? "gone"),
      (e) => {
        if (!alive) return;
        // 연결 실패만 따로 알린다. 그 밖의 실패는 없는 링크와 똑같이 (있었는지 드러내지 않는다)
        const k = toKorean(e);
        if (k.code === "NETWORK") setNetError(k.message);
        setDoc("gone");
      },
    );
    return () => {
      alive = false;
    };
  }, [src, token]);

  // 이 기기의 열쇠 (브라우저에서만)
  useEffect(() => {
    setDevice(deviceOf(browserStore(), (n) => crypto.getRandomValues(new Uint8Array(n))));
  }, []);

  const ready = doc !== null && doc !== "gone";

  // 들어옴 → 보이는 동안 라이브 + 핑. 보고서가 바뀌거나 떠나면 정리한다
  useEffect(() => {
    if (!src || !device || !ready) return;
    const { data, live } = src;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    /** 보이기 시작한(또는 마지막으로 핑한) 때 — 그 뒤로 보인 초를 다음 핑에 더한다. 숨겨져 있으면 null */
    let since: number | null = null;

    const seen = () => {
      if (since === null) return 0;
      const s = Math.min(SEEN_MAX_SEC, Math.round((Date.now() - since) / 1000));
      since = Date.now();
      return s;
    };
    const ping = (keepalive = false) => void data.viewPing(token, device, seen(), keepalive).catch(() => {});
    const show = () => {
      if (since !== null) return;
      since = Date.now();
      ping();
      timer = setInterval(() => ping(), PING_MS);
      if (state.current) session.current = live.join(token, state.current);
    };
    const hide = (final = false) => {
      if (since === null) return;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      ping(final);
      since = null;
      session.current?.leave();
      session.current = null;
    };
    const onVisible = () => (document.visibilityState === "visible" ? show() : hide());
    const onLeave = () => hide(true);

    data.viewOpen(token, device, uaHint(navigator.userAgent)).then(
      (v) => {
        if (!alive || !v) return; // 주인 본인 · 꺼진 링크 — 조용히
        setViewer(v);
        state.current = { device, label: viewerLabel(v), block: state.current?.block ?? null };
        if (document.visibilityState === "visible") show();
        document.addEventListener("visibilitychange", onVisible);
        addEventListener("pagehide", onLeave);
      },
      () => {},
    );
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      removeEventListener("pagehide", onLeave);
      hide(true);
    };
  }, [src, token, device, ready]);

  // 글: 열 때와 보이는 동안 30초마다 다시 읽는다 (남이 쓴 것 · 주인 답글이 들어온다)
  useEffect(() => {
    if (!src || !ready) return;
    let alive = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      src.data.sharedNotes(token).then(
        (rows) => alive && setNotes(rows),
        () => {},
      );
    };
    load();
    const timer = setInterval(load, NOTES_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [src, token, ready]);

  // 화면 가운데 블록: 스크롤이 멈춘 뒤 300ms, 바뀔 때만 올린다
  const blockCount = ready && Array.isArray(doc.blocks) ? doc.blocks.length : 0;
  useEffect(() => {
    if (!ready || blockCount === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      timer = undefined;
      const rects: { top: number; bottom: number }[] = [];
      for (let i = 0; i < blockCount; i++) {
        const el = document.getElementById(`b${i}`);
        if (!el) break;
        const r = el.getBoundingClientRect();
        rects.push({ top: r.top, bottom: r.bottom });
      }
      const block = centerBlock(rects, innerHeight / 2);
      const cur = state.current;
      if (!cur || cur.block === block) return;
      state.current = { ...cur, block };
      session.current?.track(state.current);
    };
    const onScroll = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(look, SCROLL_SETTLE_MS);
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
    };
  }, [ready, blockCount, viewer]);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (!src || !device || nameBusy) return;
    const n = nameIn.trim();
    if (charCount(n) > VIEWER_NAME_MAX) return setNameErr(`이름은 ${VIEWER_NAME_MAX}자까지입니다`);
    setNameBusy(true);
    setNameErr(null);
    const next = n === "" ? null : n;
    try {
      await src.data.viewName(token, device, next);
      setViewer((v) => (v ? { ...v, name: next } : v));
      if (state.current && viewer) {
        state.current = { ...state.current, label: viewerLabel({ ...viewer, name: next }) };
        session.current?.track(state.current);
      }
      // 내 글의 라벨도 바뀐다 (서버는 읽을 때 기기 줄에서 가져온다)
      if (viewer) setNotes((list) => list.map((x) => (x.guest_no === viewer.guest_no && !x.by_owner ? { ...x, label: next ?? `게스트 ${viewer.guest_no}` } : x)));
      setNaming(false);
    } catch (err) {
      setNameErr(toKorean(err).message);
    } finally {
      setNameBusy(false);
    }
  }

  /** 적는 칸 옆 "이름 적기" — 맨 아래 이름 칸을 열고 거기로 */
  const openNaming = useCallback(() => {
    setNameIn("");
    setNaming(true);
    requestAnimationFrame(() => nameRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, []);

  // ------------------------------------------------------------ 방명록 · 댓글

  const blocks = ready && Array.isArray(doc.blocks) ? doc.blocks : [];
  const version = ready ? doc.version : 0;
  const anchors = useMemo(() => anchorsOf(blocks), [blocks]);
  const placed = useMemo(() => placeNotes(notes, anchors, version), [notes, anchors, version]);
  const counts = useMemo(() => noteCounts(placed), [placed]);
  const now = new Date();
  const mine = useCallback((n: NoteRow) => viewer !== null && !n.by_owner && n.guest_no === viewer.guest_no, [viewer]);

  const write = useCallback(
    async (body: string, block?: number) => {
      if (!src || !device) throw new DbError("[EZ_NOT_FOUND] 아직 준비되지 않았습니다. 잠시 뒤 다시 하세요", "P0001");
      const row = await src.data.noteWrite(token, device, body, block ?? null, block === undefined ? null : (anchors[block] ?? null));
      if (!row) throw new DbError("[EZ_NOT_FOUND] 이 링크에는 남길 수 없습니다", "P0001");
      setNotes((list) => [...list, row]);
    },
    [src, device, token, anchors],
  );

  const edit = useCallback(
    async (id: string, body: string) => {
      if (!src || !device) return;
      let prev: NoteRow | undefined;
      setNotes((list) =>
        list.map((x) => {
          if (x.id !== id) return x;
          prev = x;
          return { ...x, body, updated_at: new Date().toISOString() };
        }),
      );
      try {
        await src.data.noteEdit(token, device, id, body);
      } catch (e) {
        setNotes((list) => list.map((x) => (x.id === id && prev ? prev : x)));
        throw e;
      }
    },
    [src, device, token],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!src || !device) return;
      let prev: NoteRow[] = [];
      setNotes((list) => {
        prev = list;
        return list.filter((x) => x.id !== id);
      });
      try {
        await src.data.noteEdit(token, device, id, null);
      } catch (e) {
        setNotes(prev);
        throw e;
      }
    },
    [src, device, token],
  );

  const nameAside =
    viewer && !viewer.name ? (
      <button type="button" className="lnk" onClick={openNaming}>
        이름 적기
      </button>
    ) : null;

  const notesCtx: NotesCtx | undefined = ready
    ? {
        counts,
        open: openBlock,
        onToggle: (i) => setOpenBlock((cur) => (cur === i ? null : i)),
        thread: (i) => (
          <Thread
            notes={placed.byBlock.get(i) ?? []}
            current={version}
            ownerLabel={OWNER}
            now={now}
            canEdit={mine}
            canDelete={mine}
            onEdit={edit}
            onDelete={remove}
            onWrite={viewer ? (body) => write(body, i) : undefined}
            aside={nameAside}
          />
        ),
      }
    : undefined;

  if (doc === null) return null;
  if (doc === "gone") {
    return (
      <div className="app">
        <div className="corner-tools"><ThemeToggle /></div>
        <div className="gone">{netError ?? "없는 링크입니다"}</div>
      </div>
    );
  }
  const rail = blocks.length >= RAIL_MIN;
  return (
    <div className="app shared">
      <div className="corner-tools"><ThemeToggle /></div>
      <div className={rail ? "doc-body view" : "doc-body no-rail view"}>
        <article className="page">
          <div className="blk b-head">
            <h1>{doc.name}</h1>
            <div className="by">{formatDay(doc.updated_at)}</div>
          </div>
          <Blocks blocks={blocks} images={images} notes={notesCtx} />
          {(viewer || placed.guestbook.length > 0) && (
            <section className="gb" aria-label="방명록">
              <NoteList notes={placed.guestbook} current={version} ownerLabel={OWNER} now={now} canEdit={mine} canDelete={mine} onEdit={edit} onDelete={remove} />
              {/* 방명록 칸 옆에는 "이름 적기" 를 두지 않는다 — 바로 아래 이름 칸이 있다 */}
              {viewer && <NoteInput placeholder="남길 말" ariaLabel="방명록" onSave={(body) => write(body)} />}
            </section>
          )}
          {viewer && (
            <div className="sv-name" ref={nameRef}>
              {naming ? (
                <form onSubmit={(e) => void saveName(e)} aria-label="이름">
                  <input
                    className="txt-in"
                    placeholder="이름"
                    aria-label="이름"
                    autoComplete="off"
                    autoFocus
                    maxLength={VIEWER_NAME_MAX}
                    value={nameIn}
                    onChange={(e) => { setNameIn(e.target.value); setNameErr(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && composing(e)) e.preventDefault();
                      if (e.key === "Escape") setNaming(false);
                    }}
                  />
                  <button type="submit" className="btn" disabled={nameBusy}>
                    저장
                  </button>
                  <button type="button" className="lnk" onClick={() => setNaming(false)}>
                    취소
                  </button>
                  {nameErr && (
                    <p className="err" role="alert">
                      {nameErr}
                    </p>
                  )}
                </form>
              ) : (
                <button type="button" className="lnk" onClick={() => { setNameIn(viewer.name ?? ""); setNaming(true); }}>
                  {viewer.name ? `${viewer.name} · 바꾸기` : "이름 적기"}
                </button>
              )}
            </div>
          )}
        </article>
        {rail && <Rail blocks={blocks} />}
      </div>
    </div>
  );
}
