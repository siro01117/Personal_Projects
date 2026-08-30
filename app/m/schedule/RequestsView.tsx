"use client";

// 학생 일정 변경 신청 관리 — ScheduleDemo.tsx 사이드바 "변경 신청" 항목에서 진입하는 독립 뷰.
// 대기 중 신청을 위에, 처리된 신청을 아래에 보여준다. 행을 펼치면 종류별로 다른 정보를 보여준다:
// temp=그 날짜·그 학생의 정기 일정(겹침 판단용, 기존 그대로), rule_edit="현재 → 신청" 비교,
// rule_delete=삭제될 정기 일정.
import { useEffect, useMemo, useState } from "react";
import {
  listRequests, setAutoApprove, getRequestDetail, approveRequest, rejectRequest, revertRequest,
  type RequestRow, type RequestListResult, type RequestDetail, type RuleCompareRow,
} from "./requestActions";
import { blockStyleOf, requestTypeOf, requestKindOf, REQUEST_KINDS, type RequestKind } from "@/lib/schedule";
import { useSort, SortHeader, type SortColumn } from "../_shared/sort";

const th: React.CSSProperties = { textAlign: "left", padding: "7px 10px", fontSize: 11.5, fontWeight: 700, color: "var(--faint)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "9px 10px", fontSize: 13, borderBottom: "1px solid var(--line)", verticalAlign: "middle" };

const statusChip: Record<RequestRow["status"], { label: string; fg: string; bg: string }> = {
  pending: { label: "대기", fg: "var(--warn)", bg: "var(--warn-soft)" },
  approved: { label: "승인", fg: "var(--accent)", bg: "var(--accent-soft)" },
  rejected: { label: "반려", fg: "var(--danger)", bg: "color-mix(in srgb, var(--danger) 12%, transparent)" },
};
const STATUS_FILTERS: { key: "all" | RequestRow["status"]; label: string }[] = [
  { key: "all", label: "전체" }, { key: "pending", label: "대기" }, { key: "approved", label: "승인" }, { key: "rejected", label: "반려" },
];
const KIND_FILTERS: { key: "all" | RequestKind; label: string }[] = [
  { key: "all", label: "전체" }, ...REQUEST_KINDS.map((k) => ({ key: k.key, label: k.label })),
];

function StatusChip({ status }: { status: RequestRow["status"] }) {
  const c = statusChip[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, color: c.fg, background: c.bg }}>
      {c.label}
    </span>
  );
}

function ReasonChip({ reason }: { reason: string }) {
  const style = blockStyleOf(reason);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, color: style.fg, background: style.bg, border: `1px solid ${style.bd}` }}>
      {reason}
    </span>
  );
}

const KIND_TONE: Record<RequestKind, { fg: string; bg: string }> = {
  temp: { fg: "var(--sub)", bg: "var(--panel2)" },
  rule_edit: { fg: "var(--accent)", bg: "var(--accent-soft)" },
  rule_delete: { fg: "var(--danger)", bg: "color-mix(in srgb, var(--danger) 12%, transparent)" },
};
function KindChip({ reqKind }: { reqKind: RequestKind }) {
  const tone = KIND_TONE[reqKind];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, color: tone.fg, background: tone.bg }}>
      {requestKindOf(reqKind).label}
    </span>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}>
      <polyline points="5.5 3.5 10.5 8 5.5 12.5" />
    </svg>
  );
}
function IconToggleOn() {
  return (
    <svg width="30" height="18" viewBox="0 0 30 18" fill="none">
      <rect x="0.5" y="0.5" width="29" height="17" rx="8.5" fill="var(--accent)" stroke="var(--accent)" />
      <circle cx="21" cy="9" r="6.5" fill="#fff" />
    </svg>
  );
}
function IconToggleOff() {
  return (
    <svg width="30" height="18" viewBox="0 0 30 18" fill="none">
      <rect x="0.5" y="0.5" width="29" height="17" rx="8.5" fill="var(--panel2)" stroke="var(--line)" />
      <circle cx="9" cy="9" r="6.5" fill="#fff" stroke="var(--line)" />
    </svg>
  );
}
function IconArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h9" />
      <path d="M8.5 4.5L12.5 8l-4 3.5" />
    </svg>
  );
}

// 정렬 가능한 속성: 학생 / 날짜 / 종류 / 상태 / 신청 시각.
const SORT_COLUMNS: SortColumn<RequestRow>[] = [
  { key: "student", label: "학생", sortValue: (r) => r.studentName },
  { key: "date", label: "날짜", sortValue: (r) => r.date },
  { key: "kind", label: "종류", sortValue: (r) => requestKindOf(r.reqKind).label },
  { key: "status", label: "상태", sortValue: (r) => statusChip[r.status].label },
  { key: "createdAt", label: "신청 시각", sortValue: (r) => r.createdAt },
];

export default function RequestsView() {
  const [data, setData] = useState<RequestListResult | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [kindFilter, setKindFilter] = useState<"all" | RequestKind>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | RequestRow["status"]>("all");
  const reload = () => { listRequests().then(setData); };
  useEffect(reload, []);

  const toggleAuto = async () => {
    if (!data || autoBusy) return;
    const next = !data.autoApprove;
    setAutoBusy(true);
    setData({ ...data, autoApprove: next });
    try {
      await setAutoApprove(next);
    } catch {
      setData({ ...data, autoApprove: !next });
    } finally {
      setAutoBusy(false);
    }
  };

  const filteredRows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => (kindFilter === "all" || r.reqKind === kindFilter) && (statusFilter === "all" || r.status === statusFilter));
  }, [data, kindFilter, statusFilter]);

  // 정렬 상태는 화면(schedule-requests)별로 localStorage 에 유지 — 기본값은 정렬 미적용(서버가 내려준 순서 그대로).
  const { sorted: sortedRows, sortKey, sortDir, requestSort } = useSort(filteredRows, SORT_COLUMNS, "__original__", "schedule-requests");

  return (
    <>
      <div className="card" style={{ flex: "none", display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 20, fontWeight: 700 }}>변경 신청</span>
        {data && data.pendingCount > 0 && (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--warn)", background: "var(--warn-soft)", borderRadius: 999, padding: "2px 10px" }}>
            대기 {data.pendingCount}건
          </span>
        )}
        <button
          type="button"
          onClick={toggleAuto}
          disabled={!data || autoBusy}
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, border: "none", background: "none", cursor: data ? "pointer" : "default", padding: 0 }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--sub)" }}>자동 승인</span>
          {data?.autoApprove ? <IconToggleOn /> : <IconToggleOff />}
        </button>
      </div>

      <div className="card" style={{ flex: "none", display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", flexWrap: "wrap" }}>
        {/* 제네릭 타입인자를 명시 — 포털 tsconfig(strict:false)에서는 onChange={setState} 하나로
            K 추론이 string 으로 풀려버려 빌드가 깨진다(원본 strict:true에서는 문제없음). 동작은 동일. */}
        <FilterGroup<"all" | RequestKind> label="종류" options={KIND_FILTERS} value={kindFilter} onChange={setKindFilter} />
        <FilterGroup<"all" | RequestRow["status"]> label="상태" options={STATUS_FILTERS} value={statusFilter} onChange={setStatusFilter} />
      </div>

      <div className="card" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px 18px" }}>
        {data == null ? (
          <div style={{ fontSize: 12.5, color: "var(--faint)", padding: "14px 4px" }}>불러오는 중…</div>
        ) : filteredRows.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--faint)", padding: "14px 4px" }}>{data.rows.length === 0 ? "변경 신청이 없습니다." : "조건에 맞는 신청이 없습니다."}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 28 }} />
                  <SortHeader label="학생" sortKey="student" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                  <SortHeader label="종류" sortKey="kind" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                  <SortHeader label="날짜" sortKey="date" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                  <th style={th}>사유</th>
                  <th style={th}>내용</th>
                  <th style={th}>메모</th>
                  <SortHeader label="상태" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                  <SortHeader label="신청 시각" sortKey="createdAt" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <RequestRowItem key={r.id} row={r} onChanged={reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function FilterGroup<K extends string>({ label, options, value, onChange }: { label: string; options: { key: K; label: string }[]; value: K; onChange: (v: K) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)" }}>{label}</span>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map((o) => {
          const active = o.key === value;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onChange(o.key)}
              style={{
                height: 26, padding: "0 10px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
                background: active ? "var(--accent-soft)" : "var(--card)",
                color: active ? "var(--accent)" : "var(--sub)",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RequestRowItem({ row, onChanged }: { row: RequestRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      getRequestDetail(row.id).then(setDetail).catch((e) => setErr(e instanceof Error ? e.message : "불러오기 실패"));
    }
  };

  // 승인/반려/되돌리기는 실패해도(예: 대상 정기 일정이 이미 사라져 반려로 처리된 경우) DB 상태가
  // 바뀌었을 수 있어 항상 목록을 새로고침한다(에러 배너는 별도로 보여준다).
  const doApprove = async () => {
    setBusy(true); setErr(null);
    try { await approveRequest(row.id); } catch (e) { setErr(e instanceof Error ? e.message : "승인 실패"); }
    finally { setBusy(false); onChanged(); }
  };
  const doReject = async () => {
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.set("id", row.id);
    fd.set("note", note);
    try { await rejectRequest(fd); } catch (e) { setErr(e instanceof Error ? e.message : "반려 실패"); }
    finally { setBusy(false); onChanged(); }
  };
  const doRevert = async () => {
    setBusy(true); setErr(null);
    try { await revertRequest(row.id); } catch (e) { setErr(e instanceof Error ? e.message : "되돌리기 실패"); }
    finally { setBusy(false); onChanged(); }
  };

  return (
    <>
      <tr>
        <td style={{ ...td, textAlign: "center" }}>
          <button type="button" onClick={toggleOpen} aria-label="펼치기"
            style={{ width: 24, height: 24, borderRadius: 6, display: "inline-grid", placeItems: "center", border: "1px solid var(--line)", background: "var(--card)", color: "var(--sub)", cursor: "pointer" }}>
            <IconChevron open={open} />
          </button>
        </td>
        <td style={{ ...td, fontWeight: 700 }}>
          {row.studentName}
          {row.seatNumber != null && <span style={{ marginLeft: 6, fontSize: 11.5, fontWeight: 600, color: "var(--faint)" }}>{row.seatNumber}번</span>}
        </td>
        <td style={td}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
            <KindChip reqKind={row.reqKind} />
            {row.reqKind === "temp" && <span style={{ fontSize: 10.5, color: "var(--faint)" }}>{requestTypeOf(row.reqType).label}</span>}
          </div>
        </td>
        <td style={{ ...td, fontVariantNumeric: "tabular-nums", color: row.dateLabel ? "var(--ink)" : "var(--faint)" }}>{row.dateLabel ?? "—"}</td>
        <td style={td}><ReasonChip reason={row.reason} /> {row.mode === "replace" && row.reqKind === "temp" && <span style={{ fontSize: 10.5, color: "var(--faint)", marginLeft: 4 }}>대체</span>}</td>
        <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{row.timeLabel}</td>
        <td style={{ ...td, color: "var(--sub)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.title || "–"}</td>
        <td style={td}><StatusChip status={row.status} /></td>
        <td style={{ ...td, fontVariantNumeric: "tabular-nums", color: "var(--faint)", whiteSpace: "nowrap" }}>{row.createdLabel}</td>
        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
          {row.status === "pending" && !rejecting && (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <ActionBtn label="승인" kind="accent" busy={busy} onClick={doApprove} />
              <ActionBtn label="반려" kind="plain" busy={busy} onClick={() => setRejecting(true)} />
            </div>
          )}
          {row.status === "approved" && <ActionBtn label="되돌리기" kind="plain" busy={busy} onClick={doRevert} />}
        </td>
      </tr>
      {rejecting && (
        <tr>
          <td colSpan={10} style={{ ...td, background: "var(--panel2)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input className="input" style={{ height: 34, flex: "1 1 220px", fontSize: 12.5 }} placeholder="반려 사유(선택)" value={note} onChange={(e) => setNote(e.target.value)} />
              <ActionBtn label="반려 확정" kind="danger" busy={busy} onClick={doReject} />
              <button type="button" onClick={() => { setRejecting(false); setNote(""); }} style={{ height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--sub)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                취소
              </button>
            </div>
          </td>
        </tr>
      )}
      {err && (
        <tr>
          <td colSpan={10} style={{ ...td, color: "var(--danger)", fontWeight: 600, fontSize: 12 }}>{err}</td>
        </tr>
      )}
      {open && (
        <tr>
          <td colSpan={10} style={{ ...td, background: "var(--panel2)" }}>
            <DetailPanel row={row} detail={detail} />
          </td>
        </tr>
      )}
    </>
  );
}

function ActionBtn({ label, kind, busy, onClick }: { label: string; kind: "accent" | "plain" | "danger"; busy: boolean; onClick: () => void }) {
  const palette =
    kind === "accent"
      ? { bg: "var(--accent)", fg: "#fff", bd: "var(--accent)" }
      : kind === "danger"
        ? { bg: "var(--danger)", fg: "#fff", bd: "var(--danger)" }
        : { bg: "var(--card)", fg: "var(--sub)", bd: "var(--line)" };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      style={{ height: 30, padding: "0 12px", borderRadius: 8, border: `1px solid ${palette.bd}`, background: palette.bg, color: palette.fg, fontSize: 12, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
    >
      {label}
    </button>
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");
function fmtClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}
function fmtLeave(min: number): string {
  return min >= 1440 ? `다음날 ${fmtClock(min)}` : fmtClock(min);
}

function RuleCompareLine({ row }: { row: RuleCompareRow }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, flexWrap: "wrap" }}>
      <ReasonChip reason={row.reason} />
      <span style={{ color: "var(--sub)", fontWeight: 700 }}>{row.daysLabel || "요일 없음"}</span>
      <span style={{ color: "var(--sub)", fontVariantNumeric: "tabular-nums" }}>{fmtClock(row.start)}–{fmtLeave(row.end)}</span>
      {row.title && <span style={{ color: "var(--faint)" }}>{row.title}</span>}
    </div>
  );
}

function DetailPanel({ row, detail }: { row: RequestRow; detail: RequestDetail | null }) {
  if (!detail) return <div style={{ fontSize: 12, color: "var(--faint)" }}>불러오는 중…</div>;

  if (detail.reqKind === "rule_edit") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 2px" }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)" }}>{row.studentName} 학생의 정기 일정 수정 신청</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--faint)" }}>현재</span>
            {detail.current ? <RuleCompareLine row={detail.current} /> : <span style={{ fontSize: 12, color: "var(--faint)" }}>대상 정기 일정을 찾을 수 없어요(삭제됨).</span>}
          </div>
          <IconArrowRight />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--faint)" }}>신청</span>
            {detail.proposed && <RuleCompareLine row={detail.proposed} />}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>
          신청 {row.createdLabel}
          {row.decidedLabel && ` · 처리 ${row.decidedLabel}${row.decidedByName ? ` (${row.decidedByName})` : " (자동)"}`}
        </div>
      </div>
    );
  }

  if (detail.reqKind === "rule_delete") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 2px" }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)" }}>{row.studentName} 학생의 정기 일정 삭제 신청</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--danger)" }}>삭제될 일정</span>
          {detail.current ? <RuleCompareLine row={detail.current} /> : <span style={{ fontSize: 12, color: "var(--faint)" }}>대상 정기 일정을 찾을 수 없어요(이미 삭제됨).</span>}
        </div>
        <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>
          신청 {row.createdLabel}
          {row.decidedLabel && ` · 처리 ${row.decidedLabel}${row.decidedByName ? ` (${row.decidedByName})` : " (자동)"}`}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 2px" }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)" }}>{row.dateLabel} · {row.studentName} 학생의 정기 일정</div>
      {detail.hours && (
        <div style={{ fontSize: 12.5, color: "var(--sub)" }}>등원~하원 {fmtClock(detail.hours.arrive)}–{fmtLeave(detail.hours.leave)}</div>
      )}
      {detail.rules.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--faint)" }}>그 요일에 걸려 있는 정기 일정이 없어요.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {detail.rules.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <ReasonChip reason={r.reason} />
              <span style={{ color: "var(--sub)", fontVariantNumeric: "tabular-nums" }}>{fmtClock(r.start)}–{fmtLeave(r.end)}</span>
              {r.title && <span style={{ color: "var(--faint)" }}>{r.title}</span>}
            </div>
          ))}
        </div>
      )}
      {detail.existingExceptions.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)", marginBottom: 4 }}>이미 확정된 예외</div>
          {detail.existingExceptions.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <ReasonChip reason={r.reason} />
              <span style={{ color: "var(--sub)", fontVariantNumeric: "tabular-nums" }}>{fmtClock(r.start)}–{fmtLeave(r.end)}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>
        신청 {row.createdLabel}
        {row.decidedLabel && ` · 처리 ${row.decidedLabel}${row.decidedByName ? ` (${row.decidedByName})` : " (자동)"}`}
      </div>
    </div>
  );
}
