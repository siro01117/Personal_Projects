"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { todayKey } from "@/lib/date";
import ScheduleDemo, { type SStudent } from "./ScheduleDemo";
import type { Period } from "./actions";

// 원본은 서버 컴포넌트였다. 브라우저 전용 PGlite 위에서 돌리기 위해 데이터 로딩을
// useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다. JSX·쿼리는 원본과 동일.

type LoadedData = {
  students: SStudent[];
  initialPeriods: Period[];
  initialStudentId: string | null;
};

function SchedulePageImpl() {
  const searchParams = useSearchParams();
  const wantedId = searchParams?.get("student") ?? undefined;
  const [data, setData] = useState<LoadedData | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "schedule.view")) { setDenied(true); return; }
    await ready();

    const [studentRows, periodRows, hoursCountRows] = await Promise.all([
      db.query<{ id: string; name: string; seat_number: number | null }>(
        `select s.id, s.name, seat.number as seat_number
           from student s
           left join seat on seat.current_student_id = s.id and seat.branch_id = s.branch_id
          where s.branch_id=$1 and s.status='enrolled'
          order by seat.number nulls last, s.name`,
        [me.activeBranchId],
      ),
      db.query<{ id: string; label: string; start_min: number; end_min: number; ord: number }>(
        `select id, label, start_min, end_min, ord from schedule_period where branch_id=$1 order by ord`,
        [me.activeBranchId],
      ),
      db.query<{ student_id: string; cnt: number }>(
        `select student_id, count(*)::int as cnt from schedule_hours where branch_id=$1 group by student_id`,
        [me.activeBranchId],
      ),
    ]);
    const hoursCountOf = new Map(hoursCountRows.rows.map((r) => [r.student_id, r.cnt]));
    const students: SStudent[] = studentRows.rows.map((r) => ({ ...r, hoursCount: hoursCountOf.get(r.id) ?? 0 }));
    const initialPeriods: Period[] = periodRows.rows.map((r) => ({ id: r.id, label: r.label, start: r.start_min, end: r.end_min }));

    const initialStudentId = wantedId && students.some((s) => s.id === wantedId) ? wantedId : null;

    setData({ students, initialPeriods, initialStudentId });
  }, [wantedId]);

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
            <span style={{ fontWeight: 700 }}>학생 스케쥴러</span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/m/schedule/import" className="chip" style={{ textDecoration: "none" }}>JSON 일괄 반영</Link>
            <div className="hide-mobile" style={{ fontSize: 12.5, color: "var(--dim)" }}>
              학생 {data.students.length}명
            </div>
          </div>
        </div>
      </header>

      <ScheduleDemo students={data.students} today={todayKey()} initialPeriods={data.initialPeriods} initialStudentId={data.initialStudentId} />
    </main>
  );
}

export default dynamic(() => Promise.resolve(SchedulePageImpl), { ssr: false });
