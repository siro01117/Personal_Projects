"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { todayKey } from "@/lib/date";
import { getOrCreateMonth, listClosures } from "@/lib/lunch-server";
import LunchAdmin, { type OrderRow, type FloorCount } from "./LunchAdmin";
import type { LunchMonth, Closure } from "@/lib/lunch";

// 원본은 서버 컴포넌트(searchParams로 연/월 조회)였다. 브라우저 전용 PGlite 위에서 돌리기 위해
// 데이터 로딩을 useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다. 이 화면은
// lib/modules.ts 상 lunch 키의 실제 경로가 아니다(→/m/meal) — 구 화면이지만 이식 지시에 따라
// 그대로 살려둔다(NavRail에는 노출되지 않고 직접 URL로만 접근).

type LoadedData = {
  monthRow: LunchMonth;
  closures: Closure[];
  todayByFloor: FloorCount[];
  orders: OrderRow[];
  canManage: boolean;
};

function LunchAdminPageImpl() {
  const searchParams = useSearchParams();
  const today = todayKey();
  const [ty, tm] = today.split("-").map(Number);
  const year = Number(searchParams?.get("y")) || ty;
  const month = Number(searchParams?.get("m")) || tm;
  const [data, setData] = useState<LoadedData | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "lunch.view")) { setDenied(true); return; }
    await ready();
    const branch = me.activeBranchId!;

    const monthRow = await getOrCreateMonth(branch, year, month);
    const closures = await listClosures(monthRow.id);

    const [todayByFloor, orders] = await Promise.all([
      db.query<FloorCount>(
        `select coalesce(rm.floor,0) as floor, lm.meal_type, count(*)::int as cnt
           from lunch_meal lm
           join lunch_order o on o.id=lm.order_id
           join student st on st.id=o.student_id
           left join seat se on se.current_student_id=st.id and se.branch_id=o.branch_id
           left join room rm on rm.id=se.room_id
          where o.branch_id=$1 and lm.date=$2
          group by rm.floor, lm.meal_type`,
        [branch, today],
      ),
      db.query<OrderRow>(
        `select o.id, st.name as student_name, se.number as seat_number, rm.floor,
                o.paid, o.paid_amount, o.paid_date::text as paid_date, o.memo,
                count(*) filter (where lm.meal_type='lunch')::int as lunch_cnt,
                count(*) filter (where lm.meal_type='dinner')::int as dinner_cnt
           from lunch_order o
           join student st on st.id=o.student_id
           left join seat se on se.current_student_id=st.id and se.branch_id=o.branch_id
           left join room rm on rm.id=se.room_id
           left join lunch_meal lm on lm.order_id=o.id
          where o.month_id=$1
          group by o.id, st.name, se.number, rm.floor, o.paid, o.paid_amount, o.paid_date, o.memo
          order by rm.floor nulls last, st.name`,
        [monthRow.id],
      ),
    ]);

    setData({ monthRow, closures, todayByFloor: todayByFloor.rows, orders: orders.rows, canManage: can(me, "lunch.manage") });
  }, [year, month, today]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const handler = () => load();
    window.addEventListener("sq-revalidate", handler as EventListener);
    return () => window.removeEventListener("sq-revalidate", handler as EventListener);
  }, [load]);

  if (denied) {
    return <main style={{ padding: 24 }}>이 화면을 볼 권한이 없습니다.</main>;
  }
  if (!data) {
    return <main style={{ padding: 24, color: "var(--dim)" }}>불러오는 중…</main>;
  }

  return (
    <main style={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)", flex: "none" }}>
        <div className="px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/home" className="chip" style={{ textDecoration: "none" }}>‹ 홈</Link>
            <span style={{ fontWeight: 700 }}>도시락</span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--dim)" }}>공개 접수: /apply/lunch (데모 범위 외)</div>
        </div>
      </header>
      <LunchAdmin
        month={data.monthRow}
        closures={data.closures}
        todayByFloor={data.todayByFloor}
        orders={data.orders}
        today={today}
        canManage={data.canManage}
      />
    </main>
  );
}

export default dynamic(() => Promise.resolve(LunchAdminPageImpl), { ssr: false });
