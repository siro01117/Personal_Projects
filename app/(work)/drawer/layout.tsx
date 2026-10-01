"use client";

import type { ReactNode } from "react";
import { DrawerProvider } from "../../_ui/DrawerContext";

export default function DrawerLayout({ children }: { children: ReactNode }) {
  return <DrawerProvider>{children}</DrawerProvider>;
}
