"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { getMe } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { MODULE_ROUTES } from "@/lib/modules";
import NavRail from "./NavRail";
import type { NavModule } from "./NavRail";
import BootProgress from "./_shared/BootProgress";
import "./sq.css";

// 원본은 서버 컴포넌트였다. 브라우저 전용 PGlite 위에서 돌리기 위해 데이터 로딩을
// useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다. JSX·쿼리는 원본과 동일.

function ModuleLayoutImpl({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Awaited<ReturnType<typeof getMe>>>(null);
  const [modules, setModules] = useState<NavModule[] | null>(null);

  const load = useCallback(async () => {
    const m = await getMe();
    if (!m) return;
    await ready();
    const { rows } = await db.query<{ key: string; label: string; requires: string[]; ord: number }>(
      `select m.key, m.label, coalesce(to_jsonb(m.requires), '[]'::jsonb) as requires, m.ord from module m
         join branch_module bm on bm.module_key = m.key
        where bm.branch_id = $1 and bm.enabled = true
        order by m.ord`,
      [m.activeBranchId],
    );
    const mods: NavModule[] = rows
      .filter((row) => m.isCto || (row.requires ?? []).every((p) => m.perms.includes(p)))
      .map((row) => ({ key: row.key, label: row.label, href: MODULE_ROUTES[row.key] ?? null }));
    setMe(m);
    setModules(mods);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const handler = () => load();
    window.addEventListener("sq-revalidate", handler as EventListener);
    return () => window.removeEventListener("sq-revalidate", handler as EventListener);
  }, [load]);

  if (!me || !modules) {
    return <div className="app-shell" style={{ display: "flex", minHeight: "100dvh", alignItems: "center", justifyContent: "center" }}><BootProgress /></div>;
  }

  return (
    <div className="app-shell" style={{ display: "flex", minHeight: "100dvh" }}>
      <NavRail modules={modules} me={{ name: me.name, isCto: me.isCto }} />
      <div className="app-main" style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const ModuleLayoutClient = dynamic(() => Promise.resolve(ModuleLayoutImpl), { ssr: false });

export default function ModuleLayout({ children }: { children: React.ReactNode }) {
  return <ModuleLayoutClient>{children}</ModuleLayoutClient>;
}
