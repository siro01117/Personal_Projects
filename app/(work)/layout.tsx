"use client";

// 모듈(보고서 서랍 · 일정 · 플래너 · 모임)이 같이 쓰는 틀. 사이드바는 모듈을 오가도 그대로 있고 오른쪽 내용만 바뀐다 (docs/모션.md 페이지 전환).

import type { ReactNode } from "react";
import { AppProvider } from "../_ui/AppContext";
import { Shell } from "../_ui/Shell";

export default function WorkLayout({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
