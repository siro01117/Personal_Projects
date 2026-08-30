"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import ImportView from "./ImportView";
import { loadImportBase, type ImportBase } from "./actions";

// 원본은 서버 컴포넌트였다. 브라우저 전용 PGlite 위에서 돌리기 위해 데이터 로딩을
// useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다. JSX·쿼리는 원본과 동일.
// 원본은 권한 없으면 redirect("/m/schedule") — window.location.href로 대체.

function ScheduleImportPageImpl() {
  const [base, setBase] = useState<ImportBase | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "schedule.manage")) {
      setDenied(true);
      window.location.href = "/m/schedule";
      return;
    }
    await ready();
    setBase(await loadImportBase());
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const handler = () => load();
    window.addEventListener("sq-revalidate", handler as EventListener);
    return () => window.removeEventListener("sq-revalidate", handler as EventListener);
  }, [load]);

  if (denied) {
    return <main style={{ padding: 24 }}>이동 중…</main>;
  }
  if (!base) {
    return <main style={{ padding: 24, color: "var(--dim)" }}>불러오는 중…</main>;
  }

  return (
    <main style={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)", flex: "none" }}>
        <div className="px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/m/schedule" className="chip" style={{ textDecoration: "none" }}>‹ 스케쥴러</Link>
            <span style={{ fontWeight: 700 }}>스케줄 JSON 일괄 반영</span>
          </div>
          <div className="hide-mobile" style={{ fontSize: 12.5, color: "var(--dim)" }}>재원생 {base.students.length}명</div>
        </div>
      </header>

      <ImportView base={base} />
    </main>
  );
}

export default dynamic(() => Promise.resolve(ScheduleImportPageImpl), { ssr: false });
