"use client";

// 서랍 화면들이 같이 쓰는 것: 폴더 목록(위쪽 경로·옮길 곳) · 다시 불러오기 신호 · 클립보드(복사·잘라내기) · 실행취소 스택.
// 클립보드와 실행취소는 이 세션(탭)에서만, 폴더를 옮겨 다녀도 남는다.
// 로그인 · 데이터 구현 · 오류 처리 · 다시 불러오기 신호(tick)는 모듈 공용 AppProvider 에서 온다.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DRAWER, KEY } from "../_data/cache";
import type { DrawerData, Entry, Folder } from "../_data/types";
import { useApp } from "./AppContext";

export { AUTH_MESSAGE, REFRESH_MS, useSignedIn } from "./AppContext";

export type Clip = { mode: "copy" | "cut"; items: Entry[] };

/** 새 값 알림을 모으는 시간 — 목록 · 안 읽음 · 폴더가 거의 같이 오니 한 번만 다시 그린다 */
const FRESH_GAP_MS = 60;

/** 실행취소 스택 길이 */
const UNDO_MAX = 50;

export type DrawerCtx = {
  data: DrawerData;
  demo: boolean;
  href: (path: string) => string;
  folders: Folder[];
  foldersLoaded: boolean;
  refreshFolders: () => Promise<void>;
  setFolders: (fn: (prev: Folder[]) => Folder[]) => void;
  /** 창에 다시 들어오거나 30초마다 오른다 — 목록·보고서가 다시 불러온다 */
  tick: number;
  /** 실패 알림. 로그인 풀림이면 로그인 화면으로 */
  fail: (err: unknown) => void;
  /** 되돌리기가 끝나면 오른다 — 목록을 무조건 다시 불러온다 */
  rev: number;
  clip: Clip | null;
  setClip: (c: Clip | null) => void;
  /** 되돌릴 동작을 쌓는다. 돌려준 번호로 알림의 '되돌리기'가 같은 동작을 부른다 */
  pushUndo: (run: () => Promise<void>) => number;
  /** 번호가 있으면 그것을, 없으면 마지막 것을 되돌린다 (Ctrl+Z). 없으면 조용히 */
  undo: (id?: number) => Promise<void>;
};

const Ctx = createContext<DrawerCtx | null>(null);

export function useDrawer(): DrawerCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDrawer 는 DrawerProvider 안에서만");
  return c;
}

export function DrawerProvider({ children }: { children: ReactNode }) {
  const { src, demo, href, fail, tick: appTick } = useApp();
  const cache = src.cache;
  // 폴더 목록은 담아 둔 것으로 바로 시작한다 (경로 · 옮길 곳이 처음부터 보인다)
  const [folders, setFoldersState] = useState<Folder[]>(() => cache.peek<Folder[]>(KEY.folders) ?? []);
  const [foldersLoaded, setFoldersLoaded] = useState(() => cache.peek(KEY.folders) !== undefined);
  const [rev, setRev] = useState(0);
  const [clip, setClip] = useState<Clip | null>(null);
  const undoStack = useRef<{ id: number; run: () => Promise<void> }[]>([]);
  const undoSeq = useRef(0);

  // 담아 둔 것을 먼저 그린 뒤, 뒤에서 읽은 새 값이 다르면 다시 불러오기 신호를 한 번 더 올린다.
  // tick 과 같은 길이라 저장 중 · 이름 입력 중에는 화면이 알아서 미룬다 (그때는 다음 신호에 새 값이 온다)
  const [fresh, setFresh] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = cache.subscribe((key) => {
      if (!key.startsWith(DRAWER) || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        setFresh((n) => n + 1);
      }, FRESH_GAP_MS);
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [cache]);
  const tick = appTick + fresh;

  const data = src.data;
  const refreshFolders = useCallback(async () => {
    try {
      setFoldersState(await data.folders());
      setFoldersLoaded(true);
    } catch (e) {
      fail(e);
    }
  }, [data, fail]);

  useEffect(() => {
    void refreshFolders();
  }, [refreshFolders, tick]);

  const pushUndo = useCallback((run: () => Promise<void>) => {
    const id = ++undoSeq.current;
    undoStack.current.push({ id, run });
    if (undoStack.current.length > UNDO_MAX) undoStack.current.shift();
    return id;
  }, []);

  const undo = useCallback(
    async (id?: number) => {
      const stack = undoStack.current;
      const i = id === undefined ? stack.length - 1 : stack.findIndex((u) => u.id === id);
      if (i < 0) return;
      const [u] = stack.splice(i, 1);
      try {
        await u!.run();
      } catch (e) {
        fail(e);
      } finally {
        setRev((r) => r + 1);
        void refreshFolders();
      }
    },
    [fail, refreshFolders],
  );

  const value = useMemo<DrawerCtx>(
    () => ({ data, demo, href, folders, foldersLoaded, refreshFolders, setFolders: setFoldersState, tick, fail, rev, clip, setClip, pushUndo, undo }),
    [data, demo, href, folders, foldersLoaded, refreshFolders, tick, fail, rev, clip, pushUndo, undo],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
