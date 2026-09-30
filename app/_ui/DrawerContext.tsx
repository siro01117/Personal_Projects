"use client";

// 서랍 화면들이 같이 쓰는 것: 데이터 구현 · 폴더 목록(위쪽 경로·옮길 곳) · 다시 불러오기 신호 · 오류 처리.
// 로그인이 안 됐거나 풀리면 /login?next=지금 자리 로 보낸다.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toKorean } from "../../lib/errors";
import { useSource, withDemo } from "../_data/source";
import type { DrawerData, Folder } from "../_data/types";
import { useToast } from "./Toast";

/** 에이전트가 그 사이 넣은 것을 보려고 다시 불러오는 간격 (보이는 동안만) */
export const REFRESH_MS = 30_000;

export const AUTH_MESSAGE = "로그인이 풀렸습니다. 다시 로그인하세요";

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
};

const Ctx = createContext<DrawerCtx | null>(null);

export function useDrawer(): DrawerCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDrawer 는 DrawerProvider 안에서만");
  return c;
}

/** 로그인 확인. 안 됐으면 로그인 화면으로 보내고 false */
export function useSignedIn(): { ready: boolean; src: ReturnType<typeof useSource> } {
  const src = useSource();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [ready, setReady] = useState(false);
  const here = `${pathname}${sp.size ? `?${sp.toString()}` : ""}`;
  const hereRef = useRef(here);
  hereRef.current = here;

  useEffect(() => {
    if (!src) return;
    let alive = true;
    const toLogin = () => router.replace(`/login?next=${encodeURIComponent(hereRef.current)}`);
    src.auth.signedIn().then(
      (ok) => {
        if (!alive) return;
        if (ok) setReady(true);
        else toLogin();
      },
      () => alive && toLogin(),
    );
    const off = src.auth.onSignedOut(toLogin);
    return () => {
      alive = false;
      off();
    };
  }, [src, router]);

  return { ready, src };
}

export function DrawerProvider({ children }: { children: ReactNode }) {
  const { ready, src } = useSignedIn();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [folders, setFoldersState] = useState<Folder[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const here = `${pathname}${sp.size ? `?${sp.toString()}` : ""}`;
  const hereRef = useRef(here);
  hereRef.current = here;

  const fail = useCallback(
    (err: unknown) => {
      const k = toKorean(err, { authMessage: AUTH_MESSAGE });
      if (k.code === "AUTH") {
        router.replace(`/login?next=${encodeURIComponent(hereRef.current)}`);
        return;
      }
      toast(k.message);
    },
    [router, toast],
  );

  const data = src?.data;
  const refreshFolders = useCallback(async () => {
    if (!data) return;
    try {
      setFoldersState(await data.folders());
      setFoldersLoaded(true);
    } catch (e) {
      fail(e);
    }
  }, [data, fail]);

  useEffect(() => {
    if (ready) void refreshFolders();
  }, [ready, refreshFolders, tick]);

  // 창에 다시 들어올 때 + 보이는 동안 30초마다
  useEffect(() => {
    if (!ready) return;
    const bump = () => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    };
    const id = setInterval(bump, REFRESH_MS);
    addEventListener("focus", bump);
    document.addEventListener("visibilitychange", bump);
    return () => {
      clearInterval(id);
      removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", bump);
    };
  }, [ready]);

  const demo = src?.demo ?? false;
  const href = useCallback((path: string) => withDemo(path, demo), [demo]);

  const value = useMemo<DrawerCtx | null>(
    () =>
      ready && data
        ? { data, demo, href, folders, foldersLoaded, refreshFolders, setFolders: setFoldersState, tick, fail }
        : null,
    [ready, data, demo, href, folders, foldersLoaded, refreshFolders, tick, fail],
  );

  if (!value) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
