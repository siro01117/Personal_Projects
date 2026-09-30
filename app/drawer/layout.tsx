"use client";

import type { ReactNode } from "react";
import { DrawerProvider } from "../_ui/DrawerContext";
import { Shell } from "../_ui/Shell";

export default function DrawerLayout({ children }: { children: ReactNode }) {
  return (
    <DrawerProvider>
      <Shell>{children}</Shell>
    </DrawerProvider>
  );
}
