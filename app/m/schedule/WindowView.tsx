"use client";

// 스케쥴 입력 활성화 관리(2026-08-22, 기간제 폐지 후 전면 재작성) — ScheduleDemo.tsx 사이드바
// "입력 활성화" 항목에서 진입하는 독립 뷰. 학생 목록이 중심: 좌석·이름 / 마지막 제출 시각 / 현재
// 상태(열림(첫 입력)·열림(활성화됨)·잠김) / 활성화·회수. 여러 명 선택해 한 번에 활성화하거나(전체
// 선택 지원), 아직 소진되지 않은 활성화를 회수할 수 있다. 학생 목록은 이미 page.tsx 에서 지점 전체를
// 한 번에 내려받은 걸(ScheduleDemo 의 students prop) 그대로 받아써 이름 검색에 쓴다.
import { useEffect, useMemo, useState } from "react";
import { listActivationStatus, activateStudents, revokeActivation, type StudentActivationRow } from "./windowActions";
import type { SStudent } from "./ScheduleDemo";
import { useSort, SortHeader, SortLabel, type SortColumn } from "../_shared/sort";

const th: React.CSSProperties = { textAlign: "left", padding: "7px 10px", fontSize: 11.5, fontWeight: 700, color: "var(--faint)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, borderBottom: "1px solid var(--line)", verticalAlign: "middle" };

const stateChip: Record<StudentActivationRow["state"], { label: string; fg: string; bg: string }> = {
  first: { label: "열림(첫 입력)", fg: "var(--accent)", bg: "var(--accent-soft)" },
  grant: { label: "열림(활성화됨)", fg: "var(--accent)", bg: "var(--accent-soft)" },
  locked: { label: "잠김", fg: "var(--faint)", bg: "var(--panel2)" },
};

function StateChip({ state }: { state: StudentActivationRow["state"] }) {
  const c = stateChip[state];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, color: c.fg, background: c.bg }}>
      {c.label}
    </span>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="4.5" /><path d="M13.5 13.5l-3-3" />
    </svg>
  );
}
function IconUnlock() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7.5" width="10" height="6.5" rx="1.5" />
      <path d="M5.5 7.5V5a2.5 2.5 0 014.6-1.4" />
    </svg>
  );
}
function IconLock() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7.5" width="10" height="6.5" rx="1.5" />
      <path d="M5.5 7.5V5a2.5 2.5 0 015 0v2.5" />
    </svg>
  );
}

export default function WindowView({ students }: { students: SStudent[] }) {
  const [rows, setRows] = useState<StudentActivationRow[] | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => {
    listActivationStatus().then((r) => {
      setRows(r);
      // 다시 불러온 뒤 이미 잠기지 않게 된(활성화됐거나 회수된) 학생은 선택에서 뺀다.
      setSelected((prev) => {
        const lockedIds = new Set(r.filter((x) => x.state === "locked").map((x) => x.studentId));
        return new Set([...prev].filter((id) => lockedIds.has(id)));
      });
    });
  };
  useEffect(reload, []);

  const byName = useMemo(() => new Map(students.map((st) => [st.id, st])), [students]);

  // 정렬 가능한 속성: 좌석번호 / 이름 / 마지막 제출 / 상태(열림·잠김). 좌석은 학생 목록(byName)에서 끌어와야
  // 해서 컬럼 정의가 byName 에 의존한다.
  const sortColumns: SortColumn<StudentActivationRow>[] = useMemo(() => [
    { key: "seat", label: "좌석번호", sortValue: (r) => byName.get(r.studentId)?.seat_number, type: "number" },
    { key: "name", label: "이름", sortValue: (r) => r.studentName },
    { key: "lastSubmitted", label: "마지막 제출", sortValue: (r) => r.lastSubmittedAt },
    { key: "state", label: "상태", sortValue: (r) => stateChip[r.state].label },
  ], [byName]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const t = q.trim();
    return t ? rows.filter((r) => r.studentName.includes(t) || String(byName.get(r.studentId)?.seat_number ?? "").includes(t)) : rows;
  }, [rows, q, byName]);

  // 기본값은 기존 쿼리 순서(좌석번호 오름차순, listActivationStatus 의 `order by seat.number nulls last, s.name`)와 동일하게 둔다.
  const { sorted: sortedFiltered, sortKey, sortDir, requestSort } = useSort(filtered ?? [], sortColumns, "seat", "schedule-window");

  const lockedRows = useMemo(() => (filtered ?? []).filter((r) => r.state === "locked"), [filtered]);
  const allLockedSelected = lockedRows.length > 0 && lockedRows.every((r) => selected.has(r.studentId));

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllLocked = () => {
    setSelected((prev) => {
      if (allLockedSelected) {
        const next = new Set(prev);
        for (const r of lockedRows) next.delete(r.studentId);
        return next;
      }
      return new Set([...prev, ...lockedRows.map((r) => r.studentId)]);
    });
  };

  const openCount = rows?.filter((r) => r.state !== "locked").length ?? 0;
  const lockedCount = rows?.filter((r) => r.state === "locked").length ?? 0;
  const unsubmittedCount = rows?.filter((r) => r.state === "first").length ?? 0;

  const activate = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.set("studentIds", JSON.stringify([...selected]));
    if (note.trim()) fd.set("note", note.trim());
    try {
      await activateStudents(fd);
      setSelected(new Set());
      setNote("");
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "활성화에 실패했습니다");
    } finally {
      setBusy(false);
    }
  };

  const revokeOne = async (studentId: string) => {
    const prev = rows;
    setRows((cur) => (cur ?? []).map((r) => (r.studentId === studentId ? { ...r, state: "locked" as const } : r)));
    try {
      await revokeActivation([studentId]);
    } catch (e) {
      setRows(prev ?? null);
      setErr(e instanceof Error ? e.message : "회수에 실패했습니다");
    }
  };

  return (
    <>
      <div className="card" style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 20, fontWeight: 700 }}>입력 활성화</span>
        <span style={{ fontSize: 12, color: "var(--faint)" }}>학생이 언제 스케쥴을 고칠 수 있는지 관리합니다</span>
      </div>
      <div className="card" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 18px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 12.5, color: "var(--faint)" }}>
          {rows == null ? (
            "불러오는 중…"
          ) : (
            <>
              <span style={{ color: "var(--accent)", fontWeight: 700 }}>열림 {openCount}명</span>
              {" · "}
              <span>잠김 {lockedCount}명</span>
              {" · "}
              <span style={{ color: unsubmittedCount > 0 ? "var(--warn)" : undefined, fontWeight: unsubmittedCount > 0 ? 700 : undefined }}>미제출 {unsubmittedCount}명</span>
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flex: "1 1 220px", minWidth: 180 }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--dim)", pointerEvents: "none" }}><IconSearch /></span>
            <input className="input" style={{ height: 38, paddingLeft: 30, width: "100%" }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 또는 좌석 번호로 검색" />
          </div>
          <input className="input" style={{ height: 38, flex: "1 1 200px", minWidth: 160 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모(선택, 예: 여행으로 기간을 놓침)" />
          <button type="button" className="btn btn-accent" style={{ height: 38 }} disabled={busy || selected.size === 0} onClick={activate}>
            {selected.size > 0 ? `선택한 ${selected.size}명 활성화` : "활성화"}
          </button>
        </div>
        {err && <div style={{ fontSize: 12.5, color: "var(--danger)", fontWeight: 600 }}>{err}</div>}

        {filtered == null ? (
          <div style={{ fontSize: 12.5, color: "var(--faint)" }}>불러오는 중…</div>
        ) : filtered.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--faint)" }}>학생이 없습니다.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label="잠긴 학생 전체 선택"
                      checked={allLockedSelected}
                      disabled={lockedRows.length === 0}
                      onChange={toggleAllLocked}
                    />
                  </th>
                  <th style={th}>
                    {/* 표시는 "좌석·이름" 한 칸이지만 좌석/이름은 서로 다른 정렬 속성이라 각각 클릭할 수 있게 나눈다. */}
                    <SortLabel label="좌석" sortKey="seat" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                    {" · "}
                    <SortLabel label="이름" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  </th>
                  <SortHeader label="마지막 제출" sortKey="lastSubmitted" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                  <SortHeader label="상태" sortKey="state" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {sortedFiltered.map((r) => {
                  const seat = byName.get(r.studentId)?.seat_number ?? null;
                  const locked = r.state === "locked";
                  return (
                    <tr key={r.studentId}>
                      <td style={td}>
                        {locked && (
                          <input type="checkbox" aria-label={`${r.studentName} 선택`} checked={selected.has(r.studentId)} onChange={() => toggleOne(r.studentId)} />
                        )}
                      </td>
                      <td style={{ ...td, fontWeight: 700 }}>
                        {r.studentName}
                        {seat != null && <span style={{ marginLeft: 6, fontSize: 11.5, fontWeight: 600, color: "var(--faint)" }}>{seat}번</span>}
                      </td>
                      <td style={{ ...td, color: r.lastSubmittedLabel ? "var(--sub)" : "var(--warn)", fontWeight: r.lastSubmittedLabel ? 400 : 700, fontVariantNumeric: "tabular-nums" }}>
                        {r.lastSubmittedLabel ?? "미제출"}
                      </td>
                      <td style={td}><StateChip state={r.state} /></td>
                      <td style={{ ...td, textAlign: "right" }}>
                        {r.state === "grant" && (
                          <button
                            type="button"
                            onClick={() => revokeOne(r.studentId)}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 5, height: 28, padding: "0 10px", borderRadius: 8,
                              border: "1px solid var(--line)", background: "var(--card)", color: "var(--sub)", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                            }}
                          >
                            <IconLock />회수
                          </button>
                        )}
                        {locked && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--faint)" }}>
                            <IconUnlock />체크 후 활성화
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
