"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { todayKey, addDays, weekStartKey } from "@/lib/date";
import { STU_STATUS } from "../util";
import {
  RECENT_DAYS, hoursByDayOf, buildAttendanceDays, summarizeAttendance, buildAttendanceCalendar,
  patrolStateCounts, buildPatrolCalendar,
  summarizePenalty, combinePointEvents, buildPenaltyWeekSummary, buildPenaltyHourly,
  buildPenaltyReasonBars, buildScheduleMiniature, buildReliabilityFlags, reliabilityTooltip,
  type PatrolRow, type PenaltyRow, type RuleRow, type ExceptionRow, type AttendanceEventRow,
} from "./util";
import StudentDetail from "./StudentDetail";

// 원본은 서버 컴포넌트(경로 /m/student/[id], params: Promise<{id}>) 였다. 브라우저 전용
// PGlite 위에서 돌리기 위해 데이터 로딩을 useEffect로 옮기고 'use client' + dynamic(ssr:false)로
// 감싼다.
// ⚠ 원본 경로 구조에서 벗어난 지점: output:'export'(정적 추출)는 동적 세그먼트([id])에
// generateStaticParams가 "실제로 존재하는 id 목록"을 반환하길 요구한다 — 브라우저에서 시드되는
// 데모 학생 id는 빌드 시점에 알 수 없고, 확인해보니 next dev 조차 클라이언트 사이드 <Link> 이동
// (RSC payload를 서버에 다시 요청)에서 이 검증을 그대로 적용해 모르는 id면 500 에러가 났다.
// 그래서 부득이 라우트를 정적 경로 /m/student/detail + ?id= 쿼리스트링으로 바꿨다(아래
// useSearchParams). 그 외 데이터 로딩·렌더링 로직은 원본과 동일.

type StudentRow = {
  id: string; name: string; status: string; level: string | null; grade: string | null;
  is_repeat: boolean | null; school: string | null; seat_number: number | null;
};

type LoadedData = {
  student: StudentRow;
  attendanceDays: ReturnType<typeof buildAttendanceDays>;
  attendanceSummary: ReturnType<typeof summarizeAttendance>;
  attendanceHeatmap: ReturnType<typeof buildAttendanceCalendar>;
  patrolCounts: ReturnType<typeof patrolStateCounts>;
  patrolHeatmap: ReturnType<typeof buildPatrolCalendar>;
  patrolTotal: number;
  penaltyWeek: ReturnType<typeof buildPenaltyWeekSummary>;
  penaltyHourly: ReturnType<typeof buildPenaltyHourly>;
  penaltyReasonBars: ReturnType<typeof buildPenaltyReasonBars>;
  penaltyTotal30: number;
  scheduleMiniature: ReturnType<typeof buildScheduleMiniature>;
  ruleCount: number;
  hasSchedule: boolean;
  canEditSchedule: boolean;
  reliability: { attendance: string | null; late: string | null; patrol: string | null };
};

function StudentDetailPageImpl() {
  const searchParams = useSearchParams();
  const id = searchParams?.get("id") ?? "";
  const [data, setData] = useState<LoadedData | null>(null);
  const [denied, setDenied] = useState(false);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const me = await getMe();
    if (!me) return;
    if (!can(me, "student.view")) { setDenied(true); return; }
    await ready();

    const today = todayKey();
    const cutoffDate = addDays(today, -(RECENT_DAYS - 1));
    const cutoffTs = `${cutoffDate}T00:00:00+09:00`;
    const thisWeekStart = weekStartKey(new Date(`${today}T12:00:00Z`));
    const thisWeekEnd = addDays(thisWeekStart, 6);

    const [studentRows, hoursRows, attRows, patrolRows, penaltyRows, ruleRows, exceptionRows] = await Promise.all([
      db.query<StudentRow>(
        `select s.id, s.name, s.status, s.level, s.grade, s.is_repeat, s.school,
                seat.number as seat_number
           from student s
           left join seat on seat.current_student_id = s.id and seat.branch_id = s.branch_id
          where s.id = $1 and s.branch_id = $2`,
        [id, me.activeBranchId],
      ),
      db.query<{ day: number; arrive_min: number; leave_min: number }>(
        `select day, arrive_min, leave_min from schedule_hours where branch_id=$1 and student_id=$2 order by day`,
        [me.activeBranchId, id],
      ),
      db.query<AttendanceEventRow>(
        `select at::text as at, kind, note
           from attendance_event
          where student_id=$1 and branch_id=$2 and at >= $3::timestamptz
          order by at asc`,
        [id, me.activeBranchId, cutoffTs],
      ),
      db.query<PatrolRow>(
        `select date::text as date, at::text as at, state, points, note,
                extract(hour from at at time zone 'Asia/Seoul')::int as hour
           from patrol_event
          where student_id=$1 and branch_id=$2 and at >= $3::timestamptz
          order by at desc`,
        [id, me.activeBranchId, cutoffTs],
      ),
      db.query<PenaltyRow>(
        `select date::text as date, at::text as at, reason, points, note
           from penalty_event
          where student_id=$1 and branch_id=$2 and at >= $3::timestamptz
          order by at desc`,
        [id, me.activeBranchId, cutoffTs],
      ),
      db.query<RuleRow>(
        `select id, reason, kind, title, start_min, end_min, days
           from schedule_rule where branch_id=$1 and student_id=$2 order by start_min`,
        [me.activeBranchId, id],
      ),
      db.query<ExceptionRow>(
        `select id, reason, title, start_min, end_min, date::text as date, skip_rule_id
           from schedule_exception
          where branch_id=$1 and student_id=$2 and date between $3 and $4`,
        [me.activeBranchId, id, thisWeekStart, thisWeekEnd],
      ),
    ]);

    const student = studentRows.rows[0];
    if (!student) { setMissing(true); return; }

    const hoursByDay = hoursByDayOf(hoursRows.rows);
    const hasSchedule = hoursRows.rows.length > 0;

    const attendanceDays = buildAttendanceDays(attRows.rows, hoursByDay, today);
    const attendanceSummary = summarizeAttendance(attendanceDays, hasSchedule);
    const attendanceHeatmap = buildAttendanceCalendar(attendanceDays, hoursByDay, today);

    const patrolCounts = patrolStateCounts(patrolRows.rows);
    const patrolHeatmap = buildPatrolCalendar(patrolRows.rows, today);

    const penaltySummary = summarizePenalty(penaltyRows.rows, today);
    const penaltyEvents = combinePointEvents(patrolRows.rows, penaltyRows.rows);
    const penaltyWeek = buildPenaltyWeekSummary(penaltyEvents, today);
    const penaltyHourly = buildPenaltyHourly(penaltyEvents, today);
    const penaltyReasonBars = buildPenaltyReasonBars(penaltyEvents);

    const scheduleMiniature = buildScheduleMiniature(ruleRows.rows, exceptionRows.rows, hoursByDay, today);

    const reliabilityFlags = buildReliabilityFlags(attendanceDays, patrolRows.rows, hasSchedule);
    const reliability = {
      attendance: reliabilityTooltip(reliabilityFlags.attendance),
      late: reliabilityTooltip(reliabilityFlags.late),
      patrol: reliabilityTooltip(reliabilityFlags.patrol),
    };

    const canEditSchedule = can(me, "schedule.view");

    setData({
      student,
      attendanceDays,
      attendanceSummary,
      attendanceHeatmap,
      patrolCounts,
      patrolHeatmap,
      patrolTotal: patrolRows.rows.length,
      penaltyWeek,
      penaltyHourly,
      penaltyReasonBars,
      penaltyTotal30: penaltySummary.total30,
      scheduleMiniature,
      ruleCount: ruleRows.rows.length,
      hasSchedule,
      canEditSchedule,
      reliability,
    });
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const handler = () => load();
    window.addEventListener("sq-revalidate", handler as EventListener);
    return () => window.removeEventListener("sq-revalidate", handler as EventListener);
  }, [load]);

  if (denied) {
    return <main style={{ padding: 24 }}>이 화면을 볼 권한이 없습니다.</main>;
  }
  if (missing) {
    return <main style={{ padding: 24 }}>학생을 찾을 수 없습니다.</main>;
  }
  if (!data) {
    return <main style={{ padding: 24, color: "var(--dim)" }}>불러오는 중…</main>;
  }

  const seatLabel = data.student.seat_number != null ? `${data.student.seat_number}번` : "미배정";
  const statusLabel = STU_STATUS[data.student.status] ?? data.student.status;

  return (
    <main style={{ minHeight: "100dvh" }}>
      <div className="mx-auto" style={{ maxWidth: 1400, padding: "14px 18px" }}>
        <StudentDetail
          student={{ id: data.student.id, name: data.student.name, seatLabel, statusLabel, isLeave: data.student.status === "leave" }}
          attendanceDays={data.attendanceDays}
          attendanceSummary={data.attendanceSummary}
          attendanceHeatmap={data.attendanceHeatmap}
          patrolCounts={data.patrolCounts}
          patrolHeatmap={data.patrolHeatmap}
          patrolTotal={data.patrolTotal}
          penaltyWeek={data.penaltyWeek}
          penaltyHourly={data.penaltyHourly}
          penaltyReasonBars={data.penaltyReasonBars}
          penaltyTotal30={data.penaltyTotal30}
          scheduleMiniature={data.scheduleMiniature}
          ruleCount={data.ruleCount}
          hasSchedule={data.hasSchedule}
          canEditSchedule={data.canEditSchedule}
          reliability={data.reliability}
        />
      </div>
    </main>
  );
}

export default dynamic(() => Promise.resolve(StudentDetailPageImpl), { ssr: false });
