"use client";

// 어느 데이터 구현을 쓸지. `?demo=1` 은 개발 모드(NODE_ENV=development)에서만 메모리 저장소로 바꾼다.
// 프로덕션 빌드에서는 조건이 늘 거짓이 되어 메모리 구현은 번들에 들어가지도 않는다.

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseSource } from "./supabase";
import type { Source } from "./types";

export function useDemo(): boolean {
  const sp = useSearchParams();
  return process.env.NODE_ENV === "development" && sp.get("demo") === "1";
}

export async function loadSource(demo: boolean): Promise<Source> {
  if (process.env.NODE_ENV === "development" && demo) {
    const { demoSource } = await import("./demo");
    return demoSource();
  }
  return supabaseSource();
}

export function useSource(): Source | null {
  const demo = useDemo();
  const [src, setSrc] = useState<Source | null>(null);
  useEffect(() => {
    let alive = true;
    loadSource(demo).then((s) => {
      if (alive) setSrc(s);
    });
    return () => {
      alive = false;
    };
  }, [demo]);
  return src;
}

/** 확인 모드면 주소에 demo=1 을 이어 붙인다 (옮겨 다녀도 확인 모드 유지) */
export function withDemo(path: string, demo: boolean): string {
  if (!demo) return path;
  const [base, hash] = path.split("#", 2) as [string, string | undefined];
  return `${base}${base.includes("?") ? "&" : "?"}demo=1${hash === undefined ? "" : `#${hash}`}`;
}
