"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getMe, can } from "@/lib/auth";
import { ready } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { todayKey } from "@/lib/date";
import PhoneBox, { type PhoneSeat } from "./PhoneBox";

// 원본은 서버 컴포넌트(데스크톱용 휴대폰 보관함 크로스체크)였다. 브라우저 전용 PGlite 위에서
// 돌리기 위해 데이터 로딩을 useEffect로 옮기고 'use client' + dynamic(ssr:false)로 감싼다.
// PhoneBox.tsx는 원본이 src/app/phone/(공개 폰 라우트, 이식 범위 밖)와 공유하던 컴포넌트라
// 이 모듈 아래 그대로 복사해 왔다.

function PhonePageImpl() {
  const [seats, setSeats] = useState<(PhoneSeat & { attendance: "in" | "out" | "none" })[] | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const me = await getMe();
    if (!me) return;
    if (!can(me, "patrol.view")) { setDenied(true); return; }
    await ready();
    const branch = me.activeBranchId;

    const [seatRows, att] = await Promise.all([
      db.query<PhoneSeat>(
        `select s.id as "seatId", s.number as number, s.room_id as "roomId", r.name as "roomName",
                st.id as "studentId", st.name as "studentName"
           from seat s
           join student st on st.id = s.current_student_id
           left join room r on r.id = s.room_id
          where s.branch_id=$1 and s.current_student_id is not null
          order by s.number asc nulls last`,
        [branch],
      ),
      db.query<{ student_id: string; kind: string }>(
        `select distinct on (student_id) student_id, kind
           from attendance_event where branch_id=$1 and date=$2
           order by student_id, at desc`,
        [branch, todayKey()],
      ),
    ]);

    const attendance: Record<string, "in" | "out"> = {};
    for (const r of att.rows) attendance[r.student_id] = r.kind === "in" ? "in" : "out";

    setSeats(seatRows.rows.map((s) => ({ ...s, attendance: attendance[s.studentId] ?? "none" })));
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
  if (!seats) {
    return <main style={{ padding: 24, color: "var(--dim)" }}>불러오는 중…</main>;
  }

  return (
    <main style={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <header style={{ borderBottom: "1px solid var(--line)", background: "var(--card)", flex: "none" }}>
        <div className="px-5 h-14 flex items-center gap-3">
          <Link href="/home" className="chip" style={{ textDecoration: "none" }}>‹ 홈</Link>
          <span style={{ fontWeight: 700 }}>휴대폰 보관함</span>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <PhoneBox seats={seats} layout="wide" />
      </div>
    </main>
  );
}

export default dynamic(() => Promise.resolve(PhonePageImpl), { ssr: false });
