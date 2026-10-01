"use client";

// 어느 데이터 구현을 쓸지. `?demo=1` 은 개발 모드(NODE_ENV=development)에서만 메모리 저장소로 바꾼다.
// 프로덕션 빌드에서는 조건이 늘 거짓이 되어 메모리 구현은 번들에 들어가지도 않는다.
// 진짜 구현은 바로(기다림 없이) 나온다. 확인 모드는 처음 한 번만 불러오고 그 뒤로는 바로 나온다 — 모듈을 오갈 때 빈 화면을 거치지 않게.

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseSource } from "./supabase";
import type { Source } from "./types";

export function useDemo(): boolean {
  const sp = useSearchParams();
  return process.env.NODE_ENV === "development" && sp.get("demo") === "1";
}

let demoLoaded: Source | null = null;

/** 지금 바로 쓸 수 있는 구현. 확인 모드를 아직 안 불러왔으면 null */
export function peekSource(demo: boolean): Source | null {
  if (process.env.NODE_ENV === "development" && demo) return demoLoaded;
  return supabaseSource();
}

export async function loadSource(demo: boolean): Promise<Source> {
  if (process.env.NODE_ENV === "development" && demo) {
    if (!demoLoaded) {
      const { demoSource } = await import("./demo");
      demoLoaded ??= demoSource();
    }
    return demoLoaded;
  }
  return supabaseSource();
}

export function useSource(): Source | null {
  const demo = useDemo();
  const now = peekSource(demo);
  const [, bump] = useState(0);
  useEffect(() => {
    if (now) return;
    let alive = true;
    void loadSource(demo).then(() => {
      if (alive) bump((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [demo, now]);
  return now;
}

/** 확인 모드면 주소에 demo=1 을 이어 붙인다 (옮겨 다녀도 확인 모드 유지) */
export function withDemo(path: string, demo: boolean): string {
  if (!demo) return path;
  const [base, hash] = path.split("#", 2) as [string, string | undefined];
  return `${base}${base.includes("?") ? "&" : "?"}demo=1${hash === undefined ? "" : `#${hash}`}`;
}
