"use client";

import type { ReactNode } from "react";
import { AppProvider } from "../_ui/AppContext";
import { DrawerProvider } from "../_ui/DrawerContext";
import { Shell } from "../_ui/Shell";

export default function DrawerLayout({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <DrawerProvider>
        <Shell>{children}</Shell>
      </DrawerProvider>
    </AppProvider>
  );
}
