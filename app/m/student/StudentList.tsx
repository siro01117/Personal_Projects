"use client";

// 학생 목록 + 즉시 검색. 재원/휴원 탭. 행 클릭 → 상세 팝업, 우클릭 → 컨텍스트 메뉴(휴원/복귀).
// 추가 = 팝업 폼. 상태 드롭다운은 우클릭 메뉴로 대체(자주 안 쓰는 걸 메인에서 뺌).
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { addStudent, setStudentStatus, deleteStudent, issueAccessCodes } from "./actions";
import { releaseSeat } from "../seat/actions";
import { levelLabel, STU_STATUS, type Student } from "./util";
import StudentPopup, { ReleaseSeatIcon } from "../_shared/StudentPopup";
import ContextMenu, { type MenuItem } from "../_shared/ContextMenu";
import { useLongPress } from "../_shared/useLongPress";
import { useSort, SortPicker, type SortColumn } from "../_shared/sort";

// 정렬 가능한 속성: 좌석번호 / 이름 / 구분(학년·N수) / 상태(재원·휴원) / 등록일 / 코드 발급 여부.
const SORT_COLUMNS: SortColumn<Student>[] = [
  { key: "seat", label: "좌석", sortValue: (s) => s.seat_number, type: "number" },
  { key: "name", label: "이름", sortValue: (s) => s.name },
  { key: "level", label: "구분", sortValue: (s) => levelLabel(s) },
  { key: "status", label: "상태", sortValue: (s) => STU_STATUS[s.status] ?? s.status },
  { key: "enrolled", label: "등록일", sortValue: (s) => s.enrolled_at },
  { key: "code", label: "코드 발급 여부", sortValue: (s) => (s.access_code ? "발급" : "미발급") },
];

// 행 끝 '상세 보기' 화살표 — 인라인 stroke SVG(이모지 금지 원칙).
const ChevronIcon = () => (
  <svg viewBox="0 0 16 16" style={{ width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }}>
    <path d="M6 3.5l5 4.5-5 4.5" />
  </svg>
);

export default function StudentList({
  students, canEdit, canAttend, canManageSeat,
}: {
  students: Student[];
  canEdit: boolean;
  canAttend: boolean;
  canManageSeat: boolean;
}) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"enrolled" | "leave">("enrolled");
  const [openId, setOpenId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; s: Student } | null>(null);
  const [codeMsg, setCodeMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const openStudent = (id: string | null) => { setConfirmDel(false); setOpenId(id); };
  // 터치 꾹누르기 = 행 컨텍스트 메뉴(우클릭 대체)
  const rowLP = useLongPress<Student>((s, x, y) => { if (canEdit) setRowMenu({ x, y, s }); });
  // '휴원'이 아닌 상태는 전부 재원 탭으로(레거시 withdrawn 방어)
  const inTab = (s: Student) => (tab === "leave" ? s.status === "leave" : s.status !== "leave");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return students
      .filter(inTab)
      .filter((s) => {
        if (!needle) return true;
        return (
          s.name.toLowerCase().includes(needle) ||
          (s.school ?? "").toLowerCase().includes(needle) ||
          levelLabel(s).toLowerCase().includes(needle) ||
          (s.guardian_phone ?? "").includes(needle) ||
          (s.student_phone ?? "").includes(needle) ||
          String(s.seat_number ?? "").includes(needle)
        );
      });
  }, [students, q, tab]);

  // 정렬 상태는 화면(student-list)별로 localStorage 에 유지 — 기본값은 기존 쿼리 순서(이름 오름차순, page.tsx `order by s.name`)와 동일하게 둔다.
  const { sorted: list, sortKey, sortDir, requestSort } = useSort(filtered, SORT_COLUMNS, "name", "student-list");

  const enrolledCount = students.filter((s) => s.status !== "leave").length;
  const leaveCount = students.filter((s) => s.status === "leave").length;
  const open = students.find((s) => s.id === openId) ?? null;

  const changeStatus = (id: string, status: string) => {
    const fd = new FormData();
    fd.set("id", id); fd.set("status", status);
    start(async () => { await setStudentStatus(fd); });
  };
  const doRelease = (seatId: string) => {
    const fd = new FormData();
    fd.set("seatId", seatId);
    start(async () => { await releaseSeat(fd); openStudent(null); });
  };
  const doDelete = (id: string) => {
    const fd = new FormData();
    fd.set("id", id);
    start(async () => { await deleteStudent(fd); openStudent(null); });
  };

  return (
    <div className="card" style={{ padding: 14 }}>
      {/* 상단: 검색 + 추가 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="이름 · 좌석 · 학교 · 학년 · 연락처 검색"
          aria-label="학생 검색"
          style={{ height: 40, fontSize: 14 }}
        />
        {canEdit && (() => {
          const noCode = students.filter((s) => s.status === "enrolled" && !s.access_code).length;
          return (
            <>
              <button
                className="btn"
                disabled={pending || noCode === 0}
                onClick={() => start(async () => { const r = await issueAccessCodes(); setCodeMsg(`${r.issued}명 코드 발급`); })}
                title="공개 폼(도시락 등) 로그인용 코드를 미발급 재원생에게 부여"
                style={{ height: 40, padding: "0 14px", whiteSpace: "nowrap", flexShrink: 0, fontSize: 13 }}
              >
                {noCode > 0 ? `코드 발급 (${noCode})` : "코드 발급됨"}
              </button>
              <button className="btn btn-accent" onClick={() => setAddOpen(true)} style={{ height: 40, padding: "0 16px", whiteSpace: "nowrap", flexShrink: 0 }}>학생 추가</button>
            </>
          );
        })()}
      </div>
      {codeMsg && <div style={{ fontSize: 12, color: "var(--accent)", marginBottom: 8 }}>{codeMsg}</div>}

      {/* 재원 / 휴원 탭 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        {([["enrolled", "재원", enrolledCount], ["leave", "휴원", leaveCount]] as const).map(([key, label, cnt]) => {
          const on = tab === key;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                height: 34, padding: "0 14px", borderRadius: 9,
                border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
                background: on ? "var(--accent-soft)" : "transparent",
                color: on ? "var(--accent)" : "var(--sub)",
                fontWeight: on ? 800 : 500, fontSize: 13, cursor: "pointer",
              }}
            >
              {label} <span style={{ fontSize: 12, opacity: 0.8 }}>{cnt}</span>
            </button>
          );
        })}
        <SortPicker columns={SORT_COLUMNS} activeKey={sortKey} dir={sortDir} onSort={requestSort} ariaLabel="학생 목록 정렬 기준" />
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--faint)" }}>
          {q ? `검색 ${list.length}명` : `${list.length}명`}
        </span>
      </div>

      {/* 컬럼 헤더 */}
      <div style={{ display: "grid", gridTemplateColumns: "56px 1fr", gap: 10, padding: "0 6px 6px", fontSize: 11.5, color: "var(--faint)", fontWeight: 700 }}>
        <span>좌석</span>
        <span>이름 · 학년</span>
      </div>

      {list.length === 0 ? (
        <div style={{ color: "var(--faint)", fontSize: 13, padding: 16, textAlign: "center" }}>
          {q
            ? "검색 결과가 없습니다."
            : tab === "leave"
              ? "휴원 중인 학생이 없습니다."
              : students.length === 0
                ? "등록된 학생이 없습니다. ‘학생 추가’로 등록하세요."
                : "재원 중인 학생이 없습니다."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {list.map((s) => {
            const lv = levelLabel(s);
            return (
              <div
                key={s.id}
                className="touchable"
                {...rowLP.bind(s)}
                onClick={() => { if (rowLP.consumed()) return; openStudent(s.id); }}
                onContextMenu={canEdit ? (e) => { e.preventDefault(); setRowMenu({ x: e.clientX, y: e.clientY, s }); } : undefined}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") openStudent(s.id); }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "56px 1fr 26px",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 6px",
                  borderTop: "1px solid var(--line)",
                  cursor: "pointer",
                }}
              >
                {/* 좌석 번호 */}
                <span style={{ fontSize: 13, fontWeight: 800, color: s.seat_number != null ? "var(--accent)" : "var(--faint)" }}>
                  {s.seat_number != null ? s.seat_number : "—"}
                </span>

                {/* 이름 · 학년 · 학교 */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.name}
                    {lv && <span style={{ fontSize: 12, color: "var(--sub)", fontWeight: 500, marginLeft: 6 }}>{lv}</span>}
                    {s.school && <span style={{ fontSize: 12, color: "var(--faint)", marginLeft: 6 }}>{s.school}</span>}
                  </div>
                  {(s.guardian_phone || s.student_phone) && (
                    <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>
                      {s.student_phone && `학생 ${s.student_phone}`}
                      {s.student_phone && s.guardian_phone && " · "}
                      {s.guardian_phone && `보호자 ${s.guardian_phone}`}
                    </div>
                  )}
                </div>

                {/* 상세 화면 진입 — 팝업 열기와 별개 동작이라 클릭 전파 차단 */}
                <Link
                  href={`/m/student/detail?id=${s.id}`}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-label={`${s.name} 상세 보기`}
                  title="상세 보기"
                  className="chip"
                  style={{ width: 26, height: 26, padding: 0, justifyContent: "center", color: "var(--faint)" }}
                >
                  <ChevronIcon />
                </Link>
              </div>
            );
          })}
        </div>
      )}

      {/* 행 우클릭 컨텍스트 메뉴 */}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          header={rowMenu.s.name}
          items={((): MenuItem[] => {
            const s = rowMenu.s;
            const items: MenuItem[] = [];
            if (s.status === "leave") items.push({ label: "재원 복귀", onClick: () => changeStatus(s.id, "enrolled") });
            else items.push({ label: "휴원 처리", onClick: () => changeStatus(s.id, "leave") });
            items.push({ separator: true });
            items.push({ label: "학생 정보", onClick: () => openStudent(s.id) });
            return items;
          })()}
          onClose={() => setRowMenu(null)}
        />
      )}

      {/* 학생 상세 팝업 (좌석 배치도와 동일) */}
      {open && (
        <>
          <div onClick={() => openStudent(null)} style={{ position: "fixed", inset: 0, background: "rgba(20,22,30,.45)", zIndex: 55 }} />
          <div style={{
            position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
            width: 720, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100dvh - 60px)", overflowY: "auto",
            background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 20, boxShadow: "0 24px 70px rgba(20,22,30,.35)", zIndex: 56,
          }}>
            <StudentPopup
              student={open}
              seatLabel={open.seat_number != null ? `${open.seat_number}번` : null}
              accessCode={open.access_code}
              canManage={canManageSeat}
              canAttend={canAttend}
              onClose={() => openStudent(null)}
              actions={<>
                {canManageSeat && open.seat_id && <button className="btn" onClick={() => doRelease(open.seat_id!)} style={{ height: 40, fontSize: 13, gap: 6 }}><ReleaseSeatIcon /> 자리 비우기</button>}
                <a href="/m/seat" className="btn" style={{ height: 40, fontSize: 13, display: "grid", placeItems: "center", textDecoration: "none", gridColumn: canManageSeat && open.seat_id ? "auto" : "1 / -1" }}>
                  {open.seat_number != null ? "좌석 배치도" : "좌석 배치도에서 배정"}
                </a>
                {/* 재원 ↔ 휴원 전환 (우클릭 메뉴 없이도 여기서 바로) */}
                {canEdit && (
                  open.status === "leave" ? (
                    <button
                      className="btn btn-accent"
                      onClick={() => changeStatus(open.id, "enrolled")}
                      style={{ height: 40, fontSize: 13, gridColumn: "1 / -1" }}
                    >
                      재원으로 복귀
                    </button>
                  ) : (
                    <button
                      className="btn"
                      onClick={() => changeStatus(open.id, "leave")}
                      style={{ height: 40, fontSize: 13, gridColumn: "1 / -1" }}
                    >
                      휴원 처리 {open.seat_number != null && <span style={{ color: "var(--faint)", fontWeight: 500 }}>· 좌석 비움</span>}
                    </button>
                  )
                )}
                {canEdit && (
                  confirmDel ? (
                    <>
                      <button className="btn" onClick={() => setConfirmDel(false)} style={{ height: 38, fontSize: 12.5 }}>취소</button>
                      <button className="btn" onClick={() => doDelete(open.id)} style={{ height: 38, fontSize: 12.5, background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" }}>정말 삭제</button>
                    </>
                  ) : (
                    <button className="btn" onClick={() => setConfirmDel(true)} style={{ height: 38, fontSize: 12.5, color: "var(--danger)", gridColumn: "1 / -1" }}>학생 삭제</button>
                  )
                )}
              </>}
            />
          </div>
        </>
      )}

      {/* 학생 추가 팝업 */}
      {addOpen && canEdit && (
        <>
          <div onClick={() => setAddOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(20,22,30,.45)", zIndex: 60 }} />
          <div style={{
            position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
            width: 440, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100dvh - 60px)", overflowY: "auto",
            background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 20, boxShadow: "0 24px 70px rgba(20,22,30,.35)", zIndex: 61,
          }}>
            <div className="flex items-center justify-between" style={{ padding: "18px 22px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontSize: 17, fontWeight: 800 }}>학생 추가</div>
              <button onClick={() => setAddOpen(false)} className="chip" style={{ height: 30, width: 30, padding: 0, justifyContent: "center", cursor: "pointer" }}>✕</button>
            </div>
            <form action={addStudent} onSubmit={() => setAddOpen(false)} style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="label">이름 *</label>
                <input className="input" name="name" required placeholder="홍길동" style={{ height: 42 }} autoFocus />
              </div>
              <div className="flex gap-2">
                <div style={{ flex: 1 }}>
                  <label className="label">구분</label>
                  <select className="input" name="level" defaultValue="high" style={{ height: 42 }} aria-label="구분">
                    <option value="middle">중학생</option>
                    <option value="high">고등학생</option>
                    <option value="adult">성인</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label className="label">학년</label>
                  <select className="input" name="grade" defaultValue="" style={{ height: 42 }} aria-label="학년">
                    <option value="">–</option>
                    <option value="1">1학년</option>
                    <option value="2">2학년</option>
                    <option value="3">3학년</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <div style={{ flex: 1 }}>
                  <label className="label">성별</label>
                  <select className="input" name="gender" defaultValue="" style={{ height: 42 }} aria-label="성별">
                    <option value="">–</option>
                    <option value="male">남</option>
                    <option value="female">여</option>
                  </select>
                </div>
                <label style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 8, fontSize: 13, color: "var(--sub)", paddingBottom: 10 }}>
                  <input type="checkbox" name="is_repeat" /> 성인·N수생
                </label>
              </div>
              <div>
                <label className="label">학교</label>
                <input className="input" name="school" placeholder="○○고등학교" style={{ height: 42 }} />
              </div>
              <div>
                <label className="label">생년월일</label>
                <input className="input" name="birthdate" type="date" style={{ height: 42 }} aria-label="생년월일" />
              </div>
              <div className="flex gap-2">
                <div style={{ flex: 1 }}>
                  <label className="label">학생 연락처</label>
                  <input className="input" name="student_phone" placeholder="010-0000-0000" style={{ height: 42 }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="label">보호자 연락처</label>
                  <input className="input" name="guardian_phone" placeholder="010-0000-0000" style={{ height: 42 }} />
                </div>
              </div>
              <button className="btn btn-accent" style={{ height: 44, marginTop: 4 }}>추가</button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
