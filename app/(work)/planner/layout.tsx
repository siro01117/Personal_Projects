// 플래너 · 작업대 목록 · 집중 화면이 데이터 하나를 같이 쓴다 (docs/플래너.md 7-15).

import type { ReactNode } from "react";
import { PlannerDataProvider } from "../../_ui/planner/usePlannerData";

export default function PlannerLayout({ children }: { children: ReactNode }) {
  return <PlannerDataProvider>{children}</PlannerDataProvider>;
}
