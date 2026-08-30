"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { dateTimeLabel, todayKey } from "@/lib/date";
import SubmissionList, { type SubmissionRow } from "./SubmissionList";

// 원본은 서버 컴포넌트(searchParams로 GET 필터 재조회)였다. 브라우저 전용 PGlite 위에서
// 돌리기 위해 데이터 로딩을 useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다.
// GET 폼(<form method="get">)은 그대로 두어도 useSearchParams가 쿼리스트링을 읽어 재조회한다.

type LoadedData = {
  types: string[];
  rows: (SubmissionRow & { created_at_label: string })[];
  canManage: boolean;
};

function SubmissionPageImpl() {
  const searchParams = useSearchParams();
  const typeFilter = searchParams?.get("type") ?? "";
  const dateFilter = searchParams?.get("date") ?? "";
  const [data, setData] = useState<LoadedData | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "student.view")) { setDenied(true); return; }
    await ready();
    const canManage = can(me, "student.edit");
    const branch = me.activeBranchId;

    const conds = ["sub.branch_id=$1"];
    const params: unknown[] = [branch];
    if (typeFilter) {
      params.push(typeFilter);
      conds.push(`sub.type=$${params.length}`);
    }
    if (dateFilter) {
      params.push(dateFilter);
      conds.push(`(sub.created_at at time zone 'Asia/Seoul')::date = $${params.length}::date`);
    }

    const [types, rows] = await Promise.all([
      db.query<{ type: string }>(`select distinct type from submission where branch_id=$1 order by type`, [branch]),
      db.query<SubmissionRow>(
        `select sub.id, sub.type, sub.payload, sub.status, sub.note,
                sub.submitter_name, sub.submitter_phone,
                sub.created_at as created_at_raw,
                st.name as student_name, se.number as seat_number
           from submission sub
           left join student st on st.id = sub.student_id
           left join seat se on se.current_student_id = st.id and se.branch_id = sub.branch_id
          where ${conds.join(" and ")}
          order by sub.created_at desc
          limit 200`,
        params,
      ),
    ]);

    const list: (SubmissionRow & { created_at_label: string })[] = rows.rows.map((r) => ({
      ...r,
      created_at_label: dateTimeLabel(r.created_at_raw as unknown as string),
    }));

    setData({ types: types.rows.map((t) => t.type), rows: list, canManage });
  }, [typeFilter, dateFilter]);

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
    <main style={{ minHeight: "100dvh" }}>
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)" }}>
        <div className="mx-auto max-w-[1080px] px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/home" className="chip" style={{ textDecoration: "none" }}>‹ 홈</Link>
            <span style={{ fontWeight: 700 }}>신청·설문 응답</span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--sub)" }}>최근 {data.rows.length}건</div>
        </div>
      </header>
      <div className="mx-auto max-w-[1080px] px-5 py-5">
        <SubmissionList
          rows={data.rows}
          types={data.types}
          typeFilter={typeFilter}
          dateFilter={dateFilter}
          today={todayKey()}
          canManage={data.canManage}
        />
      </div>
    </main>
  );
}

export default dynamic(() => Promise.resolve(SubmissionPageImpl), { ssr: false });
