"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import MealDemo from "./MealDemo";

// 원본은 서버 컴포넌트(권한 확인만 서버에서)였다. 도시락 화면 자체는 원래도 localStorage 전용
// (_demo/api.ts, DB 미접근)이라 브라우저 전용 데모와 그대로 맞는다 — 여기서는 권한 확인 로딩만
// useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다.

function MealAdminPageImpl() {
  const [canView, setCanView] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [denied, setDenied] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "lunch.view")) { setDenied(true); return; }
    await ready();
    setCanView(true);
    setCanManage(can(me, "lunch.manage"));
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (denied) {
    return <main style={{ padding: 24 }}>이 화면을 볼 권한이 없습니다.</main>;
  }
  if (!loaded || !canView) {
    return <main style={{ padding: 24, color: "var(--dim)" }}>불러오는 중…</main>;
  }

  return (
    <main style={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)", flex: "none" }}>
        <div className="px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/home" className="chip" style={{ textDecoration: "none" }}>‹ 홈</Link>
            <span style={{ fontWeight: 700 }}>도시락 관리</span>
          </div>
          {!canManage && (
            <div className="hide-mobile" style={{ fontSize: 12.5, color: "var(--dim)" }}>조회 전용</div>
          )}
        </div>
      </header>

      <MealDemo />
    </main>
  );
}

export default dynamic(() => Promise.resolve(MealAdminPageImpl), { ssr: false });
