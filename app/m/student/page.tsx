"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import StudentList from "./StudentList";
import type { Student } from "./util";

// 원본은 서버 컴포넌트였다. 브라우저 전용 PGlite 위에서 돌리기 위해 데이터 로딩을
// useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다. JSX·쿼리는 원본과 동일.

function StudentPageImpl() {
  const [rows, setRows] = useState<Student[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [canAttend, setCanAttend] = useState(false);
  const [canManageSeat, setCanManageSeat] = useState(false);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "student.view")) { setDenied(true); return; }
    await ready();
    setCanEdit(can(me, "student.edit"));
    setCanAttend(can(me, "attendance.edit"));
    setCanManageSeat(can(me, "seat.manage"));

    const { rows } = await db.query<Student>(
      `select s.id, s.name, s.level, s.grade, s.school, s.is_repeat, s.status,
              s.guardian_phone, s.student_phone,
              s.birthdate::text as birthdate, s.enrolled_at::text as enrolled_at, s.access_code,
              seat.number as seat_number, seat.id as seat_id
         from student s
         left join seat on seat.current_student_id = s.id and seat.branch_id = s.branch_id
        where s.branch_id = $1
        order by s.name`,
      [me.activeBranchId],
    );
    setRows(rows);
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
  if (!rows) {
    return <main style={{ padding: 24, color: "var(--dim)" }}>불러오는 중…</main>;
  }
  const enrolled = rows.filter((s) => s.status === "enrolled").length;

  return (
    <main style={{ minHeight: "100dvh" }}>
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)" }}>
        <div className="mx-auto max-w-[1080px] px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/home" className="chip" style={{ cursor: "pointer" }}>‹ 홈</Link>
            <span style={{ fontWeight: 700 }}>학생 관리</span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/m/submission" className="chip" style={{ cursor: "pointer" }}>신청·설문 응답 →</Link>
            <div style={{ fontSize: 12.5, color: "var(--sub)" }}>재원 {enrolled} · 전체 {rows.length}</div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1080px] px-5 py-5">
        <StudentList students={rows} canEdit={canEdit} canAttend={canAttend} canManageSeat={canManageSeat} />
      </div>
    </main>
  );
}

export default dynamic(() => Promise.resolve(StudentPageImpl), { ssr: false });
