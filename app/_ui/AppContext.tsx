"use client";

// 모듈(서랍 · 일정 · 플래너)이 같이 쓰는 것: 로그인 확인 · 데이터 구현 · 주소(확인 모드 유지) · 오류 처리 · 다시 불러오기 신호.
// 로그인이 안 됐거나 풀리면 /login?next=지금 자리 로 보낸다.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { toKorean } from "../../lib/errors";
import { useSource, withDemo } from "../_data/source";
import type { Source } from "../_data/types";
import { useToast } from "./Toast";

/** 에이전트가 그 사이 넣은 것을 보려고 다시 불러오는 간격 (보이는 동안만) */
export const REFRESH_MS = 30_000;

export const AUTH_MESSAGE = "로그인이 풀렸습니다. 다시 로그인하세요";

export type AppCtx = {
  src: Source;
  demo: boolean;
  href: (path: string) => string;
  /** 실패 알림. 로그인 풀림이면 로그인 화면으로 */
  fail: (err: unknown) => void;
  /** 창에 다시 들어오거나 30초마다 오른다 — 화면이 다시 불러온다 */
  tick: number;
};

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp 는 AppProvider 안에서만");
  return c;
}

/** 지금 자리 (로그인 뒤 돌아올 곳) */
function useHere(): RefObject<string> {
  const pathname = usePathname();
  const sp = useSearchParams();
  const here = `${pathname}${sp.size ? `?${sp.toString()}` : ""}`;
  const ref = useRef(here);
  ref.current = here;
  return ref;
}

/**
 * 이 탭에서 이미 로그인을 확인한 구현. 모듈(서랍 · 일정 · 플래너 · 홈)을 오갈 때 다시 기다리지 않고 바로 그린다.
 * 새로 고치면 비어 있어서 서버가 그린 것(빈 화면)과 첫 그림이 같다
 */
const known = new WeakSet<object>();

/**
 * 로그인 확인. 안 됐으면 로그인 화면으로 보내고 false.
 * 확인은 기기에 저장된 세션을 읽는 것이라 네트워크를 타지 않는다. 한 번 확인했으면 바로 ready 이고 뒤에서 다시 본다
 */
export function useSignedIn(): { ready: boolean; src: ReturnType<typeof useSource> } {
  const src = useSource();
  const router = useRouter();
  const hereRef = useHere();
  const [checked, setChecked] = useState<object | null>(null);

  useEffect(() => {
    if (!src) return;
    let alive = true;
    const toLogin = () => {
      known.delete(src);
      router.replace(`/login?next=${encodeURIComponent(hereRef.current)}`);
    };
    src.auth.signedIn().then(
      (ok) => {
        if (ok) known.add(src);
        if (!alive) return;
        if (ok) setChecked(src);
        else toLogin();
      },
      () => alive && toLogin(),
    );
    const off = src.auth.onSignedOut(toLogin);
    return () => {
      alive = false;
      off();
    };
  }, [src, router, hereRef]);

  return { ready: src !== null && (checked === src || known.has(src)), src };
}

/** 창 복귀는 focus 와 visibilitychange 가 같이 온다 — 이 안에 온 두 번째는 버린다 */
const BUMP_GAP_MS = 1_000;

export function AppProvider({ children }: { children: ReactNode }) {
  const { ready, src } = useSignedIn();
  const toast = useToast();
  const router = useRouter();
  const hereRef = useHere();
  const [tick, setTick] = useState(0);

  const fail = useCallback(
    (err: unknown) => {
      const k = toKorean(err, { authMessage: AUTH_MESSAGE });
      if (k.code === "AUTH") {
        router.replace(`/login?next=${encodeURIComponent(hereRef.current)}`);
        return;
      }
      toast(k.message);
    },
    [router, toast, hereRef],
  );

  // 창에 다시 들어올 때 + 보이는 동안 30초마다
  useEffect(() => {
    if (!ready) return;
    let last = 0;
    const bump = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < BUMP_GAP_MS) return;
      last = now;
      setTick((t) => t + 1);
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

  const value = useMemo<AppCtx | null>(() => (ready && src ? { src, demo, href, fail, tick } : null), [ready, src, demo, href, fail, tick]);

  if (!value) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
