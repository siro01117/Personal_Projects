"use client";

// 신청·설문 응답 조회 — 설문마다 payload 구조가 다르므로 키·값 표로 범용 렌더.
import { useState, useTransition } from "react";
import { setSubmissionStatus } from "./actions";
import { asJsonObject } from "@/lib/jsonb";
import { useSort, SortPicker, type SortColumn } from "../_shared/sort";

export type SubmissionRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  note: string | null;
  submitter_name: string | null;
  submitter_phone: string | null;
  student_name: string | null;
  seat_number: number | null;
  created_at_raw: string; // 원시 timestamptz(ISO) — 정렬 비교용. 표시는 created_at_label 만 쓴다.
  created_at_label: string;
};

const STATUS_LABEL: Record<string, string> = { pending: "대기", done: "처리완료", rejected: "반려" };
const STATUS_COLOR: Record<string, string> = { pending: "var(--warn)", done: "var(--ok)", rejected: "var(--danger)" };

// 정렬 가능한 속성: 설문 유형 / 제출자 / 제출 시각 / 상태.
const SORT_COLUMNS: SortColumn<SubmissionRow>[] = [
  { key: "type", label: "설문 유형", sortValue: (r) => r.type },
  { key: "submitter", label: "제출자", sortValue: (r) => r.student_name ?? r.submitter_name },
  { key: "createdAt", label: "제출 시각", sortValue: (r) => r.created_at_raw },
  { key: "status", label: "상태", sortValue: (r) => STATUS_LABEL[r.status] ?? r.status },
];

export default function SubmissionList({
  rows,
  types,
  typeFilter,
  dateFilter,
  today,
  canManage,
}: {
  rows: SubmissionRow[];
  types: string[];
  typeFilter: string;
  dateFilter: string;
  today: string;
  canManage: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // 정렬 상태는 화면(submission-list)별로 localStorage 에 유지 — 기본값은 기존 쿼리 순서(제출 시각 내림차순,
  // page.tsx `order by sub.created_at desc`)와 동일하게 둔다.
  const { sorted: sortedRows, sortKey, sortDir, requestSort } = useSort(rows, SORT_COLUMNS, "createdAt", "submission-list", "desc");

  return (
    <div>
      {/* 날짜·설문(type) 필터 — GET 폼이라 서버 컴포넌트가 searchParams 로 그대로 재조회 */}
      <form method="get" className="card" style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 12, padding: 14, marginBottom: 16 }}>
        <label>
          <span className="label">설문 유형</span>
          <select name="type" defaultValue={typeFilter} className="input" style={{ height: 40, minWidth: 140 }}>
            <option value="">전체</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>
          <span className="label">날짜</span>
          <input type="date" name="date" defaultValue={dateFilter} max={today} className="input" style={{ height: 40, width: 160 }} />
        </label>
        <button type="submit" className="btn" style={{ height: 40 }}>필터 적용</button>
        {(typeFilter || dateFilter) && <a href="/m/submission" className="chip" style={{ height: 40, alignItems: "center" }}>초기화</a>}
      </form>

      {rows.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--faint)", fontSize: 13.5 }}>조건에 맞는 응답이 없습니다.</div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
            <SortPicker columns={SORT_COLUMNS} activeKey={sortKey} dir={sortDir} onSort={requestSort} ariaLabel="응답 목록 정렬 기준" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sortedRows.map((r) => (
              <SubmissionCard key={r.id} row={r} isOpen={open.has(r.id)} onToggle={() => toggle(r.id)} canManage={canManage} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SubmissionCard({ row, isOpen, onToggle, canManage }: { row: SubmissionRow; isOpen: boolean; onToggle: () => void; canManage: boolean }) {
  const [pending, start] = useTransition();
  // 운영에서는 jsonb 가 문자열로 온다(lib/jsonb.ts) — 정규화한 뒤 읽는다.
  const payload = asJsonObject(row.payload) ?? {};
  const slug = typeof payload._slug === "string" ? payload._slug : null;
  const isTest = payload._test === true; // 허브 "테스트로 건너뛰기"(개발 전용)로 만들어진 제출
  const entries = Object.entries(payload).filter(([k]) => k !== "_slug" && k !== "_test");
  const who = row.student_name ?? row.submitter_name ?? "익명";

  const setStatus = (status: string) => {
    const fd = new FormData();
    fd.set("id", row.id);
    fd.set("status", status);
    start(() => setSubmissionStatus(fd));
  };

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <ChevronIcon open={isOpen} />
        <span className="chip" style={{ background: "var(--panel2)", fontWeight: 700 }}>{row.type}</span>
        {isTest && <span className="chip" style={{ background: "var(--warn)", color: "#fff", fontWeight: 700 }}>테스트</span>}
        {slug && <span style={{ fontSize: 11, color: "var(--faint)" }}>{slug}</span>}
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>
          {who}
          {row.seat_number != null && <span style={{ color: "var(--faint)", fontWeight: 500 }}> · {row.seat_number}번</span>}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{row.created_at_label}</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: STATUS_COLOR[row.status] ?? "var(--faint)" }}>{STATUS_LABEL[row.status] ?? row.status}</span>
      </button>

      {isOpen && (
        <div style={{ borderTop: "1px solid var(--line)", padding: 14 }}>
          {row.submitter_phone && <div style={{ fontSize: 12.5, color: "var(--sub)", marginBottom: 10 }}>연락처 {row.submitter_phone}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(90px, 160px) 1fr", gap: "6px 12px", fontSize: 13 }}>
            {entries.length === 0 && <div style={{ color: "var(--faint)" }}>내용 없음</div>}
            {entries.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <div style={{ color: "var(--faint)", fontWeight: 600 }}>{k}</div>
                <div style={{ color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{formatValue(v)}</div>
              </div>
            ))}
          </div>
          {row.note && <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--sub)" }}>메모: {row.note}</div>}

          {canManage && (
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              {(["pending", "done", "rejected"] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  disabled={pending || row.status === st}
                  onClick={() => setStatus(st)}
                  className="chip"
                  style={{
                    cursor: pending || row.status === st ? "default" : "pointer",
                    background: row.status === st ? STATUS_COLOR[st] : "var(--panel2)",
                    color: row.status === st ? "#fff" : "var(--sub)",
                    fontWeight: row.status === st ? 800 : 500,
                  }}
                >
                  {STATUS_LABEL[st]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v == null) return "-";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s", flex: "none", color: "var(--faint)" }}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}
