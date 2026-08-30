"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { MODULE_ROUTES } from "@/lib/modules";

// 원본은 서버 컴포넌트(항상 redirect)였다. 브라우저 전용 PGlite 위에서 돌리기 위해 판정을
// useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다. 로직은 원본과 동일 —
// 좌석 권한이 있으면 곧장 /m/seat, 없으면 접근 가능한 첫 모듈로, 그것도 없으면 안내 문구.
// (이 데모의 관리자 계정은 항상 seat.view가 있어 사실상 /m/seat로 즉시 이동한다.)

function HomePageImpl() {
  const [noModules, setNoModules] = useState<{ name: string } | null>(null);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    await ready();

    if (can(me, "seat.view")) { window.location.replace("/m/seat"); return; }

    const { rows } = await db.query<{ key: string; requires: string[] }>(
      `select m.key, coalesce(to_jsonb(m.requires), '[]'::jsonb) as requires from module m
         join branch_module bm on bm.module_key = m.key
        where bm.branch_id = $1 and bm.enabled = true
        order by m.ord`,
      [me.activeBranchId],
    );
    const landing = rows.find(
      (m) => MODULE_ROUTES[m.key] && (me.isCto || (m.requires ?? []).every((p) => me.perms.includes(p))),
    );
    if (landing) { window.location.replace(MODULE_ROUTES[landing.key]); return; }

    setNoModules({ name: me.name });
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!noModules) {
    return <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh", color: "var(--dim)" }}>불러오는 중…</main>;
  }

  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh", padding: 24 }}>
      <div className="card" style={{ padding: 32, textAlign: "center", maxWidth: 380 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>이용 가능한 모듈이 없습니다</div>
        <div style={{ fontSize: 13, color: "var(--sub)", marginTop: 6 }}>
          {noModules.name} 님 계정에 배정된 모듈이 없어요. 관리자에게 권한을 요청하세요.
        </div>
      </div>
    </main>
  );
}

export default dynamic(() => Promise.resolve(HomePageImpl), { ssr: false });
