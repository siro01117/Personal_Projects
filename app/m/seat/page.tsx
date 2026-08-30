"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import FloorEditor, { type Room, type Seat, type Student, type ScheduleInfo } from "./FloorEditor";
import PhoneRedirect from "../_shared/PhoneRedirect";
import { todayKey as todayStr, weekdayOf, minuteOfKST } from "@/lib/date"; // KST 기준(서버 UTC 어긋남 방지)
import type { DaySlot, Period, ActualAttendance } from "@/lib/schedule";
import { getOpenPatrolSession } from "./patrolActions";
import { buildOccupancy, type SeatOcc } from "@/lib/occupancy";

// 원본은 서버 컴포넌트(async function + getMe/db 직접 조회)였다. 브라우저 전용 PGlite 위에서
// 돌리기 위해 데이터 로딩을 useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다.
// JSX·조회 로직은 원본과 동일 — 로딩 방식만 다르다.

type LoadedData = {
  branchName: string;
  rooms: Room[];
  seats: Seat[];
  students: Student[];
  canManage: boolean;
  canEditStudent: boolean;
  canAttend: boolean;
  canPatrol: boolean;
  initialRoomId: string | null;
  occupancy: Record<string, SeatOcc>;
  lastPatrolAt: string | null;
  openSession: Awaited<ReturnType<typeof getOpenPatrolSession>>;
  scheduleMap: Record<string, ScheduleInfo>;
  periods: Period[];
  actual: Record<string, ActualAttendance>;
  nowMin: number;
};

function SeatPageImpl() {
  const searchParams = useSearchParams();
  const roomParam = searchParams?.get("room") ?? null;
  const [data, setData] = useState<LoadedData | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "seat.view")) { setDenied(true); return; }
    await ready();
    const canManage = can(me, "seat.manage");
    const canEditStudent = can(me, "student.edit");
    const canAttend = can(me, "attendance.edit");
    const canPatrol = can(me, "patrol.manage");
    const canPatrolView = can(me, "patrol.view");
    const branch = me.activeBranchId;

    const today = todayStr();
    const jsDow = weekdayOf(today);
    const dbDay = jsDow === 0 ? 7 : jsDow;

    const [rooms, students, seats, br, att, pat, lastPat, openSession, hoursRows, ruleRows, excRows, periodRows] = await Promise.all([
      db.query<Room>(
        `select id, name, floor, cols, rows, pos_x, pos_y, door_side from room where branch_id=$1 order by floor, name`,
        [branch],
      ),
      db.query<Student>(
        `select id, name, grade, school, status, guardian_phone, student_phone, level, is_repeat,
                birthdate::text as birthdate, gender, enrolled_at::text as enrolled_at
           from student where branch_id=$1 order by name`,
        [branch],
      ),
      db.query<Seat>(
        `select id, room_id, grid_x, grid_y, number, label, seat_type, facing, status, current_student_id
           from seat where branch_id=$1`,
        [branch],
      ),
      db.query<{ name: string }>(`select name from branch where id=$1`, [branch]),
      db.query<{ student_id: string; kind: string; at: string; auto: boolean; note: string | null; first_in_at: string | null }>(
        `select distinct on (student_id) student_id, kind, at::text as at, auto, note,
                (min(at) filter (where kind='in') over (partition by student_id))::text as first_in_at
           from attendance_event where branch_id=$1 and date=$2
           order by student_id, at desc`,
        [branch, todayStr()],
      ),
      db.query<{ student_id: string; state: string | null; at: string | null; points: number }>(
        `select student_id,
                (array_agg(state order by at desc))[1] as state,
                (array_agg(at order by at desc))[1]::text as at,
                sum(points)::int as points
           from patrol_event where branch_id=$1 and date=$2
           group by student_id`,
        [branch, todayStr()],
      ),
      db.query<{ last: string | null }>(
        `select max(started_at)::text as last from patrol_session where branch_id=$1`,
        [branch],
      ),
      canPatrolView ? getOpenPatrolSession() : Promise.resolve(null),
      db.query<{ student_id: string; arrive_min: number; leave_min: number }>(
        `select student_id, arrive_min, leave_min from schedule_hours where branch_id=$1 and day=$2`,
        [branch, dbDay],
      ),
      db.query<{ id: string; student_id: string; reason: string; kind: string; start_min: number; end_min: number }>(
        `select id, student_id, reason, kind, start_min, end_min
           from schedule_rule
          where branch_id=$1 and (','||days||',') like ('%,'||$2||',%')`,
        [branch, String(dbDay)],
      ),
      db.query<{ student_id: string; reason: string; kind: string; start_min: number; end_min: number; skip_rule_id: string | null }>(
        `select student_id, reason, kind, start_min, end_min, skip_rule_id
           from schedule_exception where branch_id=$1 and date=$2`,
        [branch, today],
      ),
      db.query<{ start_min: number; end_min: number }>(
        `select start_min, end_min from schedule_period where branch_id=$1 order by ord`,
        [branch],
      ),
    ]);
    const periods: Period[] = periodRows.rows.map((r) => ({ start: r.start_min, end: r.end_min }));

    const branchName = br.rows[0]?.name ?? "";

    const skippedRuleIds = new Set(excRows.rows.filter((e) => e.skip_rule_id).map((e) => e.skip_rule_id as string));
    const scheduleMap: Record<string, ScheduleInfo> = {};
    const ensureSchedule = (sid: string): ScheduleInfo =>
      scheduleMap[sid] ?? (scheduleMap[sid] = { hours: null, slots: [] });
    for (const h of hoursRows.rows) ensureSchedule(h.student_id).hours = { arrive_min: h.arrive_min, leave_min: h.leave_min };
    for (const r of ruleRows.rows) {
      if (skippedRuleIds.has(r.id)) continue;
      const slot: DaySlot = { start: r.start_min, end: r.end_min, reason: r.reason, kind: r.kind };
      ensureSchedule(r.student_id).slots.push(slot);
    }
    for (const e of excRows.rows) {
      const slot: DaySlot = { start: e.start_min, end: e.end_min, reason: e.reason, kind: e.kind };
      ensureSchedule(e.student_id).slots.push(slot);
    }

    const occupancy: Record<string, SeatOcc> = buildOccupancy(att.rows, pat.rows, scheduleMap);
    const actual: Record<string, ActualAttendance> = {};
    for (const r of att.rows) {
      actual[r.student_id] = {
        firstInMin: r.first_in_at ? minuteOfKST(r.first_in_at) : null,
        lastOutMin: r.kind === "out" ? minuteOfKST(r.at) : null,
      };
    }
    const initialRoomId =
      (roomParam && rooms.rows.some((r) => r.id === roomParam) ? roomParam : rooms.rows[0]?.id) ?? null;

    const nowMin = minuteOfKST(new Date().toISOString());

    setData({
      branchName,
      rooms: rooms.rows,
      seats: seats.rows,
      students: students.rows,
      canManage,
      canEditStudent,
      canAttend,
      canPatrol,
      initialRoomId,
      occupancy,
      lastPatrolAt: lastPat.rows[0]?.last ?? null,
      openSession,
      scheduleMap,
      periods,
      actual,
      nowMin,
    });
  }, [roomParam]);

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
      {/* 원본은 폰 폭이면 별도 모바일 전용 라우트(/seat, 이번 이식 범위 밖)로 보냈다. 그 라우트가
          없으므로 404를 막기 위해 같은 화면(/m/seat)으로 대상만 바꿨다 — 폰 레이아웃은 sq.css의
          640px 미디어쿼리가 처리하므로 실사용에는 영향 없다. */}
      <PhoneRedirect to="/m/seat" />
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)" }}>
        <div className="px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/home" className="chip" style={{ textDecoration: "none" }}>‹ 홈</Link>
            <span style={{ fontWeight: 700 }}>좌석 배치도</span>
            {data.branchName && <span className="chip">{data.branchName}</span>}
          </div>
          <div className="flex items-center gap-3">
            {data.canPatrol && <Link href="/m/patrol" className="chip mobile-only" style={{ textDecoration: "none", color: "var(--accent)", fontWeight: 700 }}>순찰 시작 →</Link>}
            <span className="hide-mobile" style={{ fontSize: 12.5, color: "var(--dim)" }}>{data.rooms.length}개 방 · 좌석 {data.seats.length}</span>
          </div>
        </div>
      </header>

      <FloorEditor
        key={data.initialRoomId ?? "none"}
        rooms={data.rooms}
        seats={data.seats}
        students={data.students}
        canManage={data.canManage}
        canEditStudent={data.canEditStudent}
        initialRoomId={data.initialRoomId}
        occupancy={data.occupancy}
        canAttend={data.canAttend}
        canPatrol={data.canPatrol}
        lastPatrolAt={data.lastPatrolAt}
        openSession={data.openSession}
        scheduleMap={data.scheduleMap}
        periods={data.periods}
        actual={data.actual}
        serverNowMin={data.nowMin}
      />
    </main>
  );
}

export default dynamic(() => Promise.resolve(SeatPageImpl), { ssr: false });
