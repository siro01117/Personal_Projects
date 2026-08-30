"use client";

// 학생 상세 팝업(좌석 배치도·학생 관리 공용). 내부 UI + 입·퇴실 기록 조회를 모두 자급.
// 좌석 컨텍스트(자리 비우기·이동 등)는 부모가 actions 슬롯으로 주입.
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { checkIn, checkOut, undoLastEvent, getAttendanceEvents, setAbsent, clearDailyStatus, getDailyStatus } from "@/app/m/seat/attendanceActions";
import { ABSENCE_REASONS, absenceReasonLabel } from "@/lib/attendance";

export type PopupStudent = {
  id: string; name: string; level: string | null; grade: string | null; is_repeat: boolean | null;
  school: string | null; birthdate: string | null;
  guardian_phone: string | null; student_phone: string | null; enrolled_at: string | null;
};

export function lbl(s: Pick<PopupStudent, "level" | "grade" | "is_repeat">): string {
  if (s.level === "adult") return s.is_repeat ? "성인·N수생" : "성인";
  const lv = s.level === "middle" ? "중" : s.level === "high" ? "고" : "";
  return lv && s.grade ? `${lv}${s.grade}` : lv || s.grade || "";
}

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ageFrom(bd: string | null): number | null {
  if (!bd) return null;
  const b = new Date(bd);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) a--;
  return a;
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--faint)" }}>{k}</div>
      <div style={{ fontWeight: 600, marginTop: 1 }}>{v}</div>
    </div>
  );
}

const XIcon = () => (
  <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

// 동작 버튼 아이콘 — 인라인 stroke SVG(이모지 금지 원칙). 전부 16x16 / strokeWidth 1.6 로 통일.
const iconProps = {
  viewBox: "0 0 16 16", width: 16, height: 16, fill: "none",
  stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};

const ScheduleIcon = () => (
  <svg {...iconProps}>
    <rect x="2" y="3.5" width="12" height="10.5" rx="1.6" />
    <path d="M2 6.5h12M5.5 2v3M10.5 2v3" />
  </svg>
);
const DetailIcon = () => (
  <svg {...iconProps}>
    <rect x="4" y="1.5" width="8" height="13" rx="1.2" />
    <path d="M6.2 5h3.6M6.2 8h3.6M6.2 11h2" />
  </svg>
);
// 좌석 컨텍스트(자리 비우기·이동) 아이콘 — 호출부(FloorEditor 등)의 actions 슬롯 버튼에서도 쓰도록 export.
export const ReleaseSeatIcon = () => (
  <svg {...iconProps}>
    <rect x="2" y="8.5" width="6" height="5" rx="1" />
    <path d="M9 8l5-5M10 3h4v4" />
  </svg>
);
export const MoveSeatIcon = () => (
  <svg {...iconProps}>
    <path d="M2 8h12M2 8l3-3M2 8l3 3M14 8l-3-3M14 8l-3 3" />
  </svg>
);
const CheckInIcon = () => (
  <svg {...iconProps}>
    <path d="M10 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3" />
    <path d="M2 8h7M6 5l3 3-3 3" />
  </svg>
);
const CheckOutIcon = () => (
  <svg {...iconProps}>
    <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    <path d="M7 8h7M11 5l3 3-3 3" />
  </svg>
);
const AbsentIcon = () => (
  <svg {...iconProps}>
    <circle cx="8" cy="8" r="6" />
    <path d="M4 12l8-8" />
  </svg>
);
const RestoreIcon = () => (
  <svg {...iconProps}>
    <path d="M3 8a5 5 0 1 1 1.5 3.6" />
    <path d="M3 8V4.5M3 8h3.5" />
  </svg>
);

export default function StudentPopup({
  student, seatLabel, accessCode, canManage, canAttend, onClose, actions, onCheckOutRequest,
}: {
  student: PopupStudent;
  seatLabel: string | null;   // 예: "1번" / null(미배정)
  accessCode?: string | null; // 공개 폼 로그인 코드(있는 화면에서만 전달 → 좌석맵 팝업은 미표시)
  canManage: boolean;
  canAttend: boolean;
  onClose: () => void;
  actions?: ReactNode;        // 좌·하단 액션 버튼(컨텍스트별)
  // 퇴실 버튼을 즉시 처리하지 않고 확인창을 띄우고 싶은 화면(좌석 배치도)이 넘긴다 — 있으면 직접
  // checkOut 대신 이걸 호출한다. 없으면(예: StudentList) 기존처럼 즉시 checkOut.
  onCheckOutRequest?: (studentId: string) => void;
}) {
  const [attDate, setAttDate] = useState(todayLocal());
  const [attEvents, setAttEvents] = useState<{ kind: string; auto: boolean; at: string }[]>([]);
  const [daily, setDaily] = useState<{ status: string; reason: string | null } | null>(null);
  const [absentPick, setAbsentPick] = useState(false); // 결석 사유 고르기 펼침
  const [tick, setTick] = useState(0);
  const [pending, start] = useTransition();

  const call = (action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>) => {
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.set(k, v));
    start(async () => { await action(fd); setAbsentPick(false); setTick((t) => t + 1); });
  };

  useEffect(() => {
    let live = true;
    getAttendanceEvents(student.id, attDate).then((rows) => { if (live) setAttEvents(rows); }).catch(() => {});
    getDailyStatus(student.id, attDate).then((d) => { if (live) setDaily(d); }).catch(() => {});
    return () => { live = false; };
  }, [student.id, attDate, tick]);

  const isToday = attDate === todayLocal();
  const isAbsent = daily?.status === "absent";

  return (
    <>
      {/* 헤더 — 이름을 크게(20px+/700), 좌석번호·학년은 이름 옆에 작게 */}
      <div className="flex items-center justify-between" style={{ padding: "18px 22px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div style={{ width: 44, height: 44, borderRadius: 13, background: "var(--accent-soft)", color: "var(--accent)", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 18, flexShrink: 0 }}>{student.name[0]}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
            <span style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25 }}>{student.name}</span>
            <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{seatLabel ? `${seatLabel} 좌석` : "미배정"}{lbl(student) ? ` · ${lbl(student)}` : ""}</span>
          </div>
        </div>
        <button onClick={onClose} aria-label="닫기" className="chip" style={{ height: 30, width: 30, padding: 0, justifyContent: "center", cursor: "pointer", flexShrink: 0 }}><XIcon /></button>
      </div>

      {/* 본문 2단 */}
      <div style={{ padding: 20, display: "flex", gap: 20 }}>
        {/* 왼쪽: 정보 + 결제 + 액션 */}
        <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div className="label">학생 정보</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", fontSize: 13.5 }}>
              <Info k="학년" v={lbl(student) || "—"} />
              <Info k="학교" v={student.school || "—"} />
              <Info k="나이" v={ageFrom(student.birthdate) != null ? `만 ${ageFrom(student.birthdate)}세` : "—"} />
              <Info k="첫 등록" v={student.enrolled_at || "—"} />
              <Info k="학생 연락처" v={student.student_phone || "—"} />
              <Info k="보호자 연락처" v={student.guardian_phone || "—"} />
            </div>
          </div>
          {accessCode !== undefined && (
            <div>
              <div className="label">공개 폼 로그인 코드</div>
              {accessCode ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: "0.08em", fontFamily: "ui-monospace, monospace" }}>{accessCode}</span>
                  <span style={{ fontSize: 11.5, color: "var(--faint)" }}>이름 + 이 코드로 도시락 등 신청</span>
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--faint)" }}>미발급 — 목록 상단 ‘코드 발급’ 버튼으로 부여</div>
              )}
            </div>
          )}
          <div>
            <div className="label">결제</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px 12px", fontSize: 13.5 }}>
              <Info k="요금제" v="—" />
              <Info k="다음 납부" v="—" />
              <Info k="미납" v="—" />
            </div>
            <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 6 }}>결제 모듈이 붙으면 표시됩니다.</div>
          </div>

          {actions && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 14, marginTop: "auto" }}>
              {actions}
            </div>
          )}
        </div>

        {/* 오른쪽: 입·퇴실 기록 */}
        <div style={{ flex: "0 0 232px", borderLeft: "1px solid var(--line)", paddingLeft: 18, display: "flex", flexDirection: "column", minHeight: 300 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: "var(--faint)", fontWeight: 700 }}>입·퇴실 기록</span>
            {canAttend && attEvents.length > 0 && isToday && (
              <button onClick={() => call(undoLastEvent, { studentId: student.id, date: attDate })} disabled={pending} className="chip" style={{ height: 22, fontSize: 11, cursor: "pointer", color: "var(--danger)" }}>마지막 취소</button>
            )}
          </div>
          <input type="date" className="input" value={attDate} onChange={(e) => setAttDate(e.target.value)} style={{ height: 36, fontSize: 13, marginBottom: 10 }} />
          {/* 결석 배너 — 이 날 결석 처리돼 있으면 사유와 함께 표시 */}
          {isAbsent && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", marginBottom: 10, borderRadius: 10, background: "rgba(229,72,77,.1)", border: "1px solid rgba(229,72,77,.4)" }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, color: "#c92a2f" }}>결석</span>
              {daily?.reason && <span style={{ fontSize: 12, color: "var(--dim)" }}>· {absenceReasonLabel(daily.reason)}</span>}
            </div>
          )}
          <div style={{ flex: 1, overflowY: "auto", maxHeight: 260 }}>
            {attEvents.length === 0 ? (
              <div style={{ color: "var(--faint)", fontSize: 12.5, padding: "10px 2px" }}>기록 없음</div>
            ) : (
              attEvents.map((e, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 2px", borderTop: i ? "1px solid var(--line)" : "none" }}>
                  <span style={{ width: 34, fontSize: 12.5, fontWeight: 800, color: e.kind === "in" ? "var(--ok)" : "var(--dim)" }}>{e.kind === "in" ? "입실" : "퇴실"}</span>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{new Date(e.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>
                  <span style={{ fontSize: 11, color: "var(--faint)", marginLeft: "auto" }}>{e.auto ? "자동" : "수동"}</span>
                </div>
              ))
            )}
          </div>
          {canAttend && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              {isToday && !isAbsent && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <button className="btn btn-accent" disabled={pending} onClick={() => call(checkIn, { studentId: student.id })} style={{ height: 38, fontSize: 12.5, gap: 6 }}><CheckInIcon /> 입실</button>
                  <button className="btn" disabled={pending} onClick={() => (onCheckOutRequest ? onCheckOutRequest(student.id) : call(checkOut, { studentId: student.id }))} style={{ height: 38, fontSize: 12.5, gap: 6, border: "1px solid #cdd2dd" }}><CheckOutIcon /> 퇴실</button>
                </div>
              )}
              {/* 결석 처리 / 취소 (선택한 날짜 기준) */}
              {isAbsent ? (
                <button className="btn" disabled={pending} onClick={() => call(clearDailyStatus, { studentId: student.id, date: attDate })} style={{ height: 38, fontSize: 12.5, gap: 6 }}><RestoreIcon /> 결석 취소</button>
              ) : absentPick ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "8px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--panel2)" }}>
                  <div style={{ width: "100%", fontSize: 11, color: "var(--faint)", marginBottom: 2 }}>결석 사유 선택</div>
                  {ABSENCE_REASONS.map((r) => (
                    <button key={r.key} disabled={pending} onClick={() => call(setAbsent, { studentId: student.id, reason: r.key, date: attDate })} className="chip" style={{ height: 28, fontSize: 12, cursor: "pointer" }}>{r.label}</button>
                  ))}
                  <button onClick={() => setAbsentPick(false)} className="chip" style={{ height: 28, fontSize: 12, cursor: "pointer", color: "var(--faint)" }}>닫기</button>
                </div>
              ) : (
                <button className="btn" disabled={pending} onClick={() => setAbsentPick(true)} style={{ height: 38, fontSize: 12.5, gap: 6, border: "1px solid #cdd2dd", color: "var(--danger)" }}><AbsentIcon /> 결석 처리</button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 스케쥴·상세 이동 — 위 동작 버튼들과 구분되는 팝업 맨 아래 줄(이동 성격 = accent 틴트) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: "14px 22px", borderTop: "1px solid var(--line)" }}>
        <a
          href={`/m/schedule?student=${student.id}`}
          className="btn"
          style={{ height: 40, gap: 6, fontSize: 13.5, fontWeight: 700, textDecoration: "none", background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid rgba(79,70,229,.28)" }}
        >
          <ScheduleIcon /> 스케쥴
        </a>
        <a
          href={`/m/student/detail?id=${student.id}`}
          className="btn"
          style={{ height: 40, gap: 6, fontSize: 13.5, fontWeight: 700, textDecoration: "none", background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid rgba(79,70,229,.28)" }}
        >
          <DetailIcon /> 상세 보기
        </a>
      </div>
    </>
  );
}
