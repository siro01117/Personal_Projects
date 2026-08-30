"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getMe, can } from "@/lib/auth";
import PhoneRedirect from "../_shared/PhoneRedirect";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { weekStartLabel, PENALTY_BY_KEY } from "@/lib/penalty";
import { weekStartKey, todayKey } from "@/lib/date";
import { PATROL_BY_KEY } from "@/lib/patrol";
import PenaltyView, { type PRoom, type PSeat, type PStudent, type Breakdown } from "./PenaltyView";

// 원본은 서버 컴포넌트였다. 브라우저 전용 PGlite 위에서 돌리기 위해 데이터 로딩을
// useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다. JSX·쿼리는 원본과 동일.

type LoadedData = {
  rooms: PRoom[];
  seats: PSeat[];
  students: PStudent[];
  weekly: Record<string, number>;
  breakdown: Breakdown[];
  weekLabel: string;
  weekStart: string;
  canManage: boolean;
  canPatrolManage: boolean;
};

function PenaltyPageImpl() {
  const [data, setData] = useState<LoadedData | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "penalty.view")) { setDenied(true); return; }
    await ready();
    const canManage = can(me, "penalty.manage");
    const canPatrolManage = can(me, "patrol.manage");
    const branch = me.activeBranchId;
    const ws = weekStartKey(new Date());
    const wsLabel = weekStartLabel(ws);

    const [rooms, seats, students, patRows, manRows] = await Promise.all([
      db.query<PRoom>(`select id, name, floor from room where branch_id=$1 order by floor, name`, [branch]),
      db.query<PSeat>(`select id, room_id, grid_x, grid_y, number, label, current_student_id from seat where branch_id=$1`, [branch]),
      db.query<PStudent>(
        `select s.id, s.name, s.level, s.grade, s.is_repeat, seat.number as seat_number
           from student s left join seat on seat.current_student_id = s.id and seat.branch_id = s.branch_id
          where s.branch_id=$1 and s.status='enrolled' order by s.name`,
        [branch],
      ),
      db.query<{ student_id: string; state: string; pts: number; cnt: number }>(
        `select pe.student_id, pe.state, sum(pe.points)::int as pts, count(*)::int as cnt from patrol_event pe
           join student s on s.id=pe.student_id and s.status='enrolled'
          where pe.branch_id=$1 and pe.date>=$2 and pe.points<>0 group by pe.student_id, pe.state`,
        [branch, ws],
      ),
      db.query<{ student_id: string; reason: string; pts: number; cnt: number }>(
        `select pn.student_id, pn.reason, sum(pn.points)::int as pts, count(*)::int as cnt from penalty_event pn
           join student s on s.id=pn.student_id and s.status='enrolled'
          where pn.branch_id=$1 and pn.date>=$2 group by pn.student_id, pn.reason`,
        [branch, ws],
      ),
    ]);

    const weekly: Record<string, number> = {};
    const patByState = new Map<string, { pts: number; cnt: number }>();
    for (const r of patRows.rows) {
      weekly[r.student_id] = (weekly[r.student_id] ?? 0) + r.pts;
      const c = patByState.get(r.state) ?? { pts: 0, cnt: 0 };
      c.pts += r.pts; c.cnt += r.cnt; patByState.set(r.state, c);
    }
    const manByReason = new Map<string, { pts: number; cnt: number }>();
    for (const r of manRows.rows) {
      weekly[r.student_id] = (weekly[r.student_id] ?? 0) + r.pts;
      const c = manByReason.get(r.reason) ?? { pts: 0, cnt: 0 };
      c.pts += r.pts; c.cnt += r.cnt; manByReason.set(r.reason, c);
    }

    const breakdown: Breakdown[] = [
      ...[...patByState].map(([state, v]) => ({ label: `순찰 · ${PATROL_BY_KEY[state]?.label ?? state}`, points: v.pts, count: v.cnt })),
      ...[...manByReason].map(([reason, v]) => ({ label: PENALTY_BY_KEY[reason]?.label ?? reason, points: v.pts, count: v.cnt })),
    ].filter((b) => b.points > 0).sort((a, b) => b.points - a.points);

    setData({ rooms: rooms.rows, seats: seats.rows, students: students.rows, weekly, breakdown, weekLabel: wsLabel, weekStart: ws, canManage, canPatrolManage });
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
      <PhoneRedirect to="/m/penalty" />
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)", flex: "none" }}>
        <div className="px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/m/seat" className="chip" style={{ textDecoration: "none" }}>‹ 좌석</Link>
            <span style={{ fontWeight: 700 }}>벌점</span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--dim)" }}>이번 주 {data.weekLabel} ~ · 월요일 리셋</div>
        </div>
      </header>

      <PenaltyView
        rooms={data.rooms}
        seats={data.seats}
        students={data.students}
        weekly={data.weekly}
        breakdown={data.breakdown}
        weekLabel={data.weekLabel}
        weekStart={data.weekStart}
        today={todayKey()}
        canManage={data.canManage}
        canPatrolManage={data.canPatrolManage}
      />
    </main>
  );
}

export default dynamic(() => Promise.resolve(PenaltyPageImpl), { ssr: false });
