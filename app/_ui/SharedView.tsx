"use client";

// 공유 페이지 — 로그인 없이 ez_shared 로 읽기만(사진의 내 PC 경로는 DB 가 빼고 준다). 없거나 꺼졌거나 지웠으면 한 줄 (있었는지 드러내지 않는다).
// 읽은 사람 (설계서 7-4장): 처음 열면 바로 보고서. 조용히 ez_view_open(기기 열쇠 · 기기 힌트) → 라이브 채널 들어가기 → 핑.
//  - 핑은 보이는 동안 30초마다 (그 사이 보인 초를 함께, 60초까지). 숨겨지면 한 번 보내고 멈추고 채널에서 나간다. 돌아오면 바로 한 번 + 다시 들어간다.
//    페이지를 떠날 때(pagehide)는 keepalive 로 마지막 한 번
//  - 라이브에는 {기기, 라벨, 화면 가운데 블록 번호} 만 올린다. 블록은 스크롤이 멈춘 뒤 300ms, 바뀔 때만. 남의 상태는 읽지 않는다
//  - 맨 아래 작은 글자 "이름 적기"(이미 적었으면 "이름 · 바꾸기"). 한글 조합 중 Enter 는 무시. 비우면 다시 게스트 n
//  - 주인 본인(로그인 세션)은 DB 가 건너뛴다(open 이 빈 결과) — 그때는 핑 · 라이브 · 이름 칸 모두 없다

import { ThemeToggle } from "./ThemeToggle";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { charCount } from "../../lib/names";
import { toKorean } from "../../lib/errors";
import { browserStore } from "../_data/cache";
import { useSource } from "../_data/source";
import type { LiveSession, Presence, SharedDoc, Viewer } from "../_data/types";
import { formatDay } from "../_logic/drawer";
import { centerBlock, deviceOf, PING_MS, SEEN_MAX_SEC, uaHint, VIEWER_NAME_MAX, viewerLabel } from "../_logic/views";
import { Blocks, type ImageUrls } from "./Blocks";
import { Rail, RAIL_MIN } from "./ReportView";

/** 스크롤이 멈춘 뒤 이만큼 지나면 가운데 블록을 다시 본다 */
const SCROLL_SETTLE_MS = 300;
const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

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
  /** 라이브에 올린 상태 · 들어가 있는 채널 */
  const state = useRef<Presence | null>(null);
  const session = useRef<LiveSession | null>(null);
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
      setNaming(false);
    } catch (err) {
      setNameErr(toKorean(err).message);
    } finally {
      setNameBusy(false);
    }
  }

  if (doc === null) return null;
  if (doc === "gone") {
    return (
      <div className="app">
        <div className="corner-tools"><ThemeToggle /></div>
        <div className="gone">{netError ?? "없는 링크입니다"}</div>
      </div>
    );
  }
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
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
          <Blocks blocks={blocks} images={images} />
          {viewer && (
            <div className="sv-name">
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
