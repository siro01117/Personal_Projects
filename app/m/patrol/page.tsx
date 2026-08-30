"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getMe, can } from "@/lib/auth";
import PhoneRedirect from "../_shared/PhoneRedirect";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { getPatrolSessions, getPatrolDates } from "../seat/patrolActions";
import { todayKey } from "@/lib/date";
import PatrolBoard, { type PSeat, type PRoom, type PStudent } from "./PatrolBoard";

// 원본은 서버 컴포넌트였다. 브라우저 전용 PGlite 위에서 돌리기 위해 데이터 로딩을
// useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다. JSX·쿼리는 원본과 동일.

type LoadedData = {
  rooms: PRoom[];
  seats: PSeat[];
  students: PStudent[];
  sessions: Awaited<ReturnType<typeof getPatrolSessions>>;
  dates: string[];
  canManage: boolean;
};

function PatrolPageImpl() {
  const [data, setData] = useState<LoadedData | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "patrol.view")) { setDenied(true); return; }
    await ready();
    const canManage = can(me, "patrol.manage");
    const branch = me.activeBranchId;

    const [rooms, seats, students, sessions, dates] = await Promise.all([
      db.query<PRoom>(`select id, name, floor from room where branch_id=$1 order by floor, name`, [branch]),
      db.query<PSeat>(
        `select id, room_id, grid_x, grid_y, number, label, current_student_id from seat where branch_id=$1`,
        [branch],
      ),
      db.query<PStudent>(`select id, name from student where branch_id=$1`, [branch]),
      getPatrolSessions(),
      getPatrolDates(),
    ]);

    setData({ rooms: rooms.rows, seats: seats.rows, students: students.rows, sessions, dates, canManage });
  }, []);

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
      <PhoneRedirect to="/m/patrol" />
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)", flex: "none" }}>
        <div className="px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/m/seat" className="chip" style={{ textDecoration: "none" }}>‹ 좌석</Link>
            <span style={{ fontWeight: 700 }}>순찰 기록</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hide-mobile" style={{ fontSize: 12.5, color: "var(--dim)" }}>오늘 순찰 {data.sessions.length}회</span>
          </div>
        </div>
      </header>

      <PatrolBoard
        rooms={data.rooms}
        seats={data.seats}
        students={data.students}
        sessions={data.sessions}
        dates={data.dates}
        today={todayKey()}
        canManage={data.canManage}
      />
    </main>
  );
}

export default dynamic(() => Promise.resolve(PatrolPageImpl), { ssr: false });
