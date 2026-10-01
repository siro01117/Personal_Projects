"use client";

import type { ReactNode } from "react";
import { AppProvider } from "../_ui/AppContext";
import { Shell } from "../_ui/Shell";

export default function PlannerLayout({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
