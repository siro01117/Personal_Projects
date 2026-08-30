"use client";

// 학생 정기 스케쥴 제출(submission, type='schedule') 검토·반영 — ScheduleDemo.tsx 사이드바
// "제출 반영" 항목에서 진입하는 독립 뷰. 대기 중 제출을 위에, 처리된 제출을 아래에 보여준다.
// 비교(diff)는 src/lib/schedule-import.ts(JSON 일괄 반영과 동일 로직)를 그대로 쓰고, payload를
// 그 로직이 받는 모양으로 감싸는 어댑터만 src/lib/schedule-submission.ts 에 따로 뒀다(재사용 원칙).
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  loadSubmissionsBase, applySubmissions, rejectSubmission, deleteSubmissions, setAutoApply,
  type SubmissionRow, type SubmissionsBase, type SubStatus,
} from "./submissionActions";
import type { ApplySubmissionsResult } from "@/lib/schedule-submission-apply";
import { diffAgainstExisting, academyToDbFields, type DiffStatus, type ImportHours, type DbAcademy } from "@/lib/schedule-import";
import { adaptSubmissionPayload } from "@/lib/schedule-submission";
import { blockStyleOf } from "@/lib/schedule";
import { asJsonObject } from "@/lib/jsonb";
import { useSort, SortHeader, type SortColumn } from "../_shared/sort";

// ---------------- 아이콘(라인 스트로크, 이모지 금지) ----------------
function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5l3.2 3.2L13 4.5" />
    </svg>
  );
}
function IconAlertCircle() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.3" /><path d="M8 5.2v3.4" /><circle cx="8" cy="10.9" r="0.15" fill="currentColor" />
    </svg>
  );
}
function IconSpinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="sc-sub-spin">
      <path d="M8 2a6 6 0 016 6" />
    </svg>
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

const th: React.CSSProperties = { textAlign: "left", padding: "7px 10px", fontSize: 11.5, fontWeight: 700, color: "var(--faint)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "9px 10px", fontSize: 13, borderBottom: "1px solid var(--line)", verticalAlign: "middle" };

const DAY_LABEL = ["", "월", "화", "수", "목", "금", "토", "일"];

const statusChip: Record<SubStatus, { label: string; fg: string; bg: string }> = {
  pending: { label: "대기", fg: "var(--warn)", bg: "var(--warn-soft)" },
  done: { label: "반영됨", fg: "var(--ok)", bg: "var(--ok-soft)" },
  rejected: { label: "반려", fg: "var(--danger)", bg: "color-mix(in srgb, var(--danger) 12%, transparent)" },
};
const diffChip: Record<DiffStatus | "n/a", { label: string; fg: string; bg: string }> = {
  same: { label: "변경 없음", fg: "var(--faint)", bg: "var(--panel2)" },
  new: { label: "새로 등록", fg: "var(--accent)", bg: "var(--accent-soft)" },
  changed: { label: "수정", fg: "var(--accent)", bg: "var(--accent-soft)" },
  "n/a": { label: "-", fg: "var(--faint)", bg: "transparent" },
};
// 무채색 — 형식 오류(danger)·상태(warn/ok)와 헷갈리지 않도록 테스트 제출은 색을 아예 안 쓴다.
const testChip = { label: "테스트", fg: "var(--faint)", bg: "var(--panel2)" };
const unlinkedChip = { label: "학생 미연결", fg: "var(--warn)", bg: "var(--warn-soft)" };

/** submission.payload._test === true 인지 — f/actions.ts 의 개발용 "테스트로 건너뛰기" 우회로 만들어진
 *  제출의 표식. 이 판정은 서버(submissionActions.ts deleteSubmissions)에도 동일하게 있다(단일 출처는
 *  아니지만, 클라는 UI 판단용이고 서버는 삭제 허용 여부의 최종 방어선이라 각자 필요 — 재계산 비용도 없다). */
function isTestPayload(payload: unknown): boolean {
  // 운영에서는 jsonb 가 문자열로 온다(lib/jsonb.ts 주석 참고) — asJsonObject 로 먼저 정규화한다.
  return asJsonObject(payload)?._test === true;
}

function Chip({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, color: fg, background: bg }}>
      {label}
    </span>
  );
}

function summaryOf(hours: ImportHours[], academies: DbAcademy[], restDays: number[]): string {
  const parts: string[] = [];
  if (hours.length) parts.push(`등하원 ${hours.length}일`);
  if (academies.length) parts.push(`학원 ${academies.length}건`);
  if (restDays.length) parts.push(`휴무 ${restDays.map((d) => DAY_LABEL[d]).join("")}`);
  if (parts.length === 0) parts.push("반영할 내용 없음");
  return parts.join(" · ");
}

type Row = {
  submission: SubmissionRow;
  parseOk: boolean;
  parseError?: string;
  hours: ImportHours[];
  restDays: number[];
  academies: DbAcademy[];
  diffStatus: DiffStatus | "n/a";
  diffDetail: string;
  existingHours: ImportHours[];
  existingAcademies: DbAcademy[];
  // 테스트 신원(개발용 "테스트로 건너뛰기")으로 낸 제출 — 반영 대상이 아니라 형식 오류와는 다른 사유로
  // 구분해서 보여준다(그렇지 않으면 "형식 오류"라는 엉뚱한 메시지로 보인다).
  isTest: boolean;
  // 진짜 신원이 있었는데(student_id 있음) 조인된 학생 행을 못 찾은 경우 — isTest 와는 다른 문제라
  // 별도로 표시한다(학생이 지워졌거나 하는 드문 경우).
  isUnlinked: boolean;
  // 삭제 가능 여부 — 테스트 제출은 언제나, 실제 제출은 처리(반영·반려)가 끝난 뒤에만(서버
  // deleteSubmissions 의 판정과 동일 규칙). 대기 중인 진짜 제출은 반려부터 하도록 유도한다.
  deletable: boolean;
};

function buildRows(base: SubmissionsBase): Row[] {
  const hoursByStudent = new Map<string, ImportHours[]>();
  for (const h of base.hours) {
    const list = hoursByStudent.get(h.studentId) ?? [];
    list.push({ day: h.day, arrive: h.arrive, leave: h.leave });
    hoursByStudent.set(h.studentId, list);
  }
  const acadByStudent = new Map<string, DbAcademy[]>();
  for (const a of base.academies) {
    const list = acadByStudent.get(a.studentId) ?? [];
    list.push({ reason: a.reason, title: a.title, days: a.days, start: a.start, end: a.end });
    acadByStudent.set(a.studentId, list);
  }

  return base.submissions.map((sub): Row => {
    const result = adaptSubmissionPayload(sub.payload, sub.studentName, sub.seatNumber, 0);
    const existingHours = sub.studentId ? (hoursByStudent.get(sub.studentId) ?? []) : [];
    const existingAcademies = sub.studentId ? (acadByStudent.get(sub.studentId) ?? []) : [];
    const isTest = isTestPayload(sub.payload) || sub.studentId == null;
    const isUnlinked = !isTest && !sub.studentMatched;
    const deletable = isTest || sub.status !== "pending";
    if (result.ok === false) {
      return {
        submission: sub, parseOk: false, parseError: result.error,
        hours: [], restDays: [], academies: [], diffStatus: "n/a", diffDetail: "",
        existingHours, existingAcademies, isTest, isUnlinked, deletable,
      };
    }
    const st = result.student;
    const dbAcademies = st.academies.map(academyToDbFields);
    let diffStatus: DiffStatus | "n/a" = "n/a";
    let diffDetail = "";
    if (sub.studentId) {
      const diff = diffAgainstExisting(st.hours, dbAcademies, existingHours, existingAcademies);
      diffStatus = diff.status;
      diffDetail = diff.detail;
    }
    return {
      submission: sub, parseOk: true,
      hours: st.hours, restDays: st.restDays, academies: dbAcademies,
      diffStatus, diffDetail, existingHours, existingAcademies, isTest, isUnlinked, deletable,
    };
  });
}

// 정렬 가능한 속성: 학생(좌석·이름) / 제출 시각 / 최초 제출 / 상태 / 변경 여부.
const SORT_COLUMNS: SortColumn<Row>[] = [
  { key: "student", label: "학생", sortValue: (r) => r.submission.studentName },
  { key: "createdAt", label: "제출 시각", sortValue: (r) => r.submission.createdAt },
  { key: "firstSubmittedAt", label: "최초 제출", sortValue: (r) => r.submission.firstSubmittedAt },
  { key: "status", label: "상태", sortValue: (r) => statusChip[r.submission.status].label },
  { key: "diff", label: "변경", sortValue: (r) => diffChip[r.diffStatus].label },
];

export default function SubmissionsView() {
  const [base, setBase] = useState<SubmissionsBase | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplySubmissionsResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<{ id: string; msg: string } | null>(null);
  const [showTestRows, setShowTestRows] = useState(false); // 테스트 제출 — 기본은 숨김
  const [delSelected, setDelSelected] = useState<Set<string>>(new Set()); // 삭제 대상(처리 끝난 제출·테스트 제출)으로 고른 행
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);

  const reload = () => {
    loadSubmissionsBase()
      .then((b) => {
        setBase(b);
        setLoadErr(null);
        // 기본 선택: 대기 중이고 형식이 정상이며 변경 사항이 있는 제출만.
        const rows = buildRows(b);
        const def = new Set<string>();
        for (const r of rows) {
          if (r.submission.status === "pending" && r.parseOk && r.submission.studentId && !r.isTest && (r.diffStatus === "new" || r.diffStatus === "changed")) {
            def.add(r.submission.id);
          }
        }
        setSelected(def);
        // 삭제 선택도 새로 불러온 목록에 없는(또는 더 이상 삭제 가능하지 않은) id 는 정리한다.
        const stillDeletable = new Set(rows.filter((r) => r.deletable).map((r) => r.submission.id));
        setDelSelected((prev) => new Set([...prev].filter((id) => stillDeletable.has(id))));
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : "불러오기에 실패했습니다"));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, []);

  const rows = useMemo(() => (base ? buildRows(base) : []), [base]);
  const visibleRowsUnsorted = useMemo(() => (showTestRows ? rows : rows.filter((r) => !r.isTest)), [rows, showTestRows]);
  // 정렬 상태는 화면(schedule-submissions)별로 localStorage 에 유지 — 기본값은 정렬 미적용(서버가 내려준 순서 그대로).
  const { sorted: visibleRows, sortKey, sortDir, requestSort } = useSort(visibleRowsUnsorted, SORT_COLUMNS, "__original__", "schedule-submissions");
  const testCount = useMemo(() => rows.filter((r) => r.isTest).length, [rows]);
  const selectableRows = useMemo(
    () => rows.filter((r) => r.submission.status === "pending" && r.parseOk && r.submission.studentId && !r.isTest),
    [rows],
  );
  const allSelectableChecked = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.submission.id));

  const toggleAll = (on: boolean) => setSelected(on ? new Set(selectableRows.map((r) => r.submission.id)) : new Set());
  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });

  const doApply = async () => {
    if (applying || selected.size === 0) return;
    setApplying(true);
    setApplyResult(null);
    setApplyError(null);
    try {
      const result = await applySubmissions(JSON.stringify([...selected]));
      setApplyResult(result);
      if (result.appliedIds.length > 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of result.appliedIds) next.delete(id);
          return next;
        });
      }
      reload();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : "반영에 실패했습니다");
    } finally {
      setApplying(false);
    }
  };

  const doReject = async (id: string) => {
    setRowBusy(id);
    setRowErr(null);
    const fd = new FormData();
    fd.set("id", id);
    fd.set("note", rejectNote);
    try {
      await rejectSubmission(fd);
      setRejectingId(null);
      setRejectNote("");
      reload();
    } catch (e) {
      setRowErr({ id, msg: e instanceof Error ? e.message : "반려에 실패했습니다" });
    } finally {
      setRowBusy(null);
    }
  };

  const toggleDelOne = (id: string, on: boolean) =>
    setDelSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });

  const doDeleteOne = async (id: string) => {
    if (!window.confirm("이 제출을 삭제할까요? 되돌릴 수 없습니다.")) return;
    setRowBusy(id);
    setRowErr(null);
    try {
      const r = await deleteSubmissions(JSON.stringify([id]));
      if (r.failed.length > 0) throw new Error(r.failed[0].error);
      setDelSelected((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      reload();
    } catch (e) {
      setRowErr({ id, msg: e instanceof Error ? e.message : "삭제에 실패했습니다" });
    } finally {
      setRowBusy(null);
    }
  };

  const doDeleteSelected = async () => {
    if (deleting || delSelected.size === 0) return;
    if (!window.confirm(`선택한 제출 ${delSelected.size}건을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      const r = await deleteSubmissions(JSON.stringify([...delSelected]));
      if (r.failed.length > 0) {
        setDeleteErr(`${r.deleted}건 삭제됨 · ${r.failed.length}건 실패: ${r.failed[0].error}`);
      }
      setDelSelected(new Set());
      reload();
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : "삭제에 실패했습니다");
    } finally {
      setDeleting(false);
    }
  };

  const toggleAuto = async () => {
    if (!base || autoBusy) return;
    const next = !base.autoApply;
    setAutoBusy(true);
    setBase({ ...base, autoApply: next });
    try {
      await setAutoApply(next);
    } catch {
      setBase((cur) => (cur ? { ...cur, autoApply: !next } : cur));
    } finally {
      setAutoBusy(false);
    }
  };

  // 테스트 제출은 실제로는 처리할 수 없는 상태라 "대기 N건" 배지에 섞이면 마치 처리할 일이 남은
  // 것처럼 보인다 — 실제 처리 대상만 센다. 테스트 건수는 아래 토글 옆에 별도로 보여준다.
  const pendingCount = rows.filter((r) => r.submission.status === "pending" && !r.isTest).length;

  return (
    <>
      <style>{`
        @keyframes sc-sub-spin { to { transform: rotate(360deg); } }
        .sc-sub-spin { animation: sc-sub-spin 0.8s linear infinite; transform-origin: 50% 50%; }
        @media (prefers-reduced-motion: reduce) { .sc-sub-spin { animation: none; } }
      `}</style>
      <div className="card" style={{ flex: "none", display: "flex", flexDirection: "column", gap: 4, padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 20, fontWeight: 700 }}>제출 반영</span>
          <span style={{ fontSize: 12, color: "var(--faint)" }}>학생이 공개 폼으로 낸 정기 스케쥴을 검토해 실제 시간표에 반영합니다</span>
          {pendingCount > 0 && (
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--warn)", background: "var(--warn-soft)", borderRadius: 999, padding: "2px 10px" }}>
              대기 {pendingCount}건
            </span>
          )}
          <button
            type="button"
            onClick={toggleAuto}
            disabled={!base || autoBusy}
            style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, border: "none", background: "none", cursor: base ? "pointer" : "default", padding: 0 }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--sub)" }}>자동 반영</span>
            {base?.autoApply ? <IconToggleOn /> : <IconToggleOff />}
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--faint)" }}>
          {base?.autoApply
            ? "제출 즉시 시간표에 반영됩니다 — 형식 오류·학생 미연결 등으로 실패하면 대기 상태로 남고 사유가 표시됩니다."
            : "학생 제출이 대기 상태로 쌓입니다 — 아래에서 검토 후 직접 반영하세요."}
        </div>
        <div style={{ fontSize: 11, color: "var(--faint)" }}>
          실제 반영을 테스트하려면 학생 관리에서 코드를 발급한 뒤 그 이름+코드로 로그인해 제출하세요.
        </div>
      </div>

      <div className="card" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px 18px" }}>
        {loadErr ? (
          <div style={{ fontSize: 12.5, color: "var(--danger)", fontWeight: 600, padding: "14px 4px", display: "flex", alignItems: "center", gap: 6 }}>
            <IconAlertCircle />{loadErr}
          </div>
        ) : base == null ? (
          <div style={{ fontSize: 12.5, color: "var(--faint)", padding: "14px 4px" }}>불러오는 중…</div>
        ) : rows.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--faint)", padding: "14px 4px" }}>스케쥴 제출이 없습니다.</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
                  전체 {visibleRows.length}건 · 대기 {pendingCount}건 · 선택됨 {selected.size}건
                </span>
                {testCount > 0 && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--faint)", cursor: "pointer" }}>
                    <input type="checkbox" checked={showTestRows} onChange={(e) => setShowTestRows(e.target.checked)} />
                    테스트 {testCount}건 {showTestRows ? "표시 중" : "숨김"}
                  </label>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn" style={{ height: 30, padding: "0 10px", fontSize: 11.5 }}
                  disabled={applying || selectableRows.length === 0} onClick={() => toggleAll(!allSelectableChecked)}>
                  {allSelectableChecked ? "전체 해제" : "전체 선택"}
                </button>
                {applying ? (
                  <button type="button" className="btn btn-accent" disabled
                    style={{ height: 30, padding: "0 12px", fontSize: 11.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <IconSpinner />반영 중…
                  </button>
                ) : (
                  <button type="button" className="btn btn-accent" style={{ height: 30, padding: "0 12px", fontSize: 11.5 }}
                    disabled={selected.size === 0} onClick={doApply}>
                    {`선택 ${selected.size}건 반영`}
                  </button>
                )}
                <button type="button"
                  style={{ height: 30, padding: "0 12px", borderRadius: 8, border: "1px solid var(--danger)", background: "var(--card)", color: "var(--danger)", fontSize: 11.5, fontWeight: 700, cursor: deleting || delSelected.size === 0 ? "default" : "pointer", opacity: deleting || delSelected.size === 0 ? 0.5 : 1 }}
                  disabled={deleting || delSelected.size === 0} onClick={doDeleteSelected}>
                  {deleting ? "삭제 중…" : `선택 ${delSelected.size}건 삭제`}
                </button>
              </div>
            </div>

            {deleteErr && (
              <div role="alert" style={{ padding: "10px 12px", borderRadius: 9, border: "1px solid var(--danger)", background: "var(--panel2)", fontSize: 12.5, color: "var(--danger)", display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <IconAlertCircle />{deleteErr}
              </div>
            )}
            {applyError && (
              <div role="alert" style={{ padding: "10px 12px", borderRadius: 9, border: "1px solid var(--danger)", background: "var(--panel2)", fontSize: 12.5, color: "var(--danger)", display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <IconAlertCircle />{applyError}
              </div>
            )}
            {!applyError && applyResult && (
              <div role="status" style={{
                padding: "10px 12px", borderRadius: 9, fontSize: 12.5, marginBottom: 10,
                border: applyResult.failed.length > 0 ? "1px solid var(--danger)" : "1px solid var(--ok)",
                background: applyResult.failed.length > 0 ? "var(--panel2)" : "var(--ok-soft)",
              }}>
                <div style={{ fontWeight: 700, marginBottom: applyResult.failed.length > 0 ? 4 : 0, display: "flex", alignItems: "center", gap: 6 }}>
                  {applyResult.failed.length === 0 ? <IconCheck /> : <IconAlertCircle />}
                  {applyResult.applied}명 반영 · {applyResult.failed.length}명 실패
                </div>
                {applyResult.failed.length > 0 && (
                  <div style={{ color: "var(--danger)" }}>
                    {applyResult.failed.map((f) => (
                      <div key={f.id}>{f.name}: {f.error}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {visibleRows.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--faint)", padding: "14px 4px" }}>
                표시할 제출이 없습니다. 테스트 제출 {testCount}건은 위 체크박스로 볼 수 있습니다.
              </div>
            ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 26 }} />
                    <th style={{ ...th, width: 26 }} />
                    <SortHeader label="학생" sortKey="student" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                    <SortHeader label="제출 시각" sortKey="createdAt" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                    <SortHeader label="최초 제출" sortKey="firstSubmittedAt" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                    <th style={th}>내용</th>
                    <SortHeader label="변경" sortKey="diff" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                    <SortHeader label="상태" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={requestSort} thStyle={th} />
                    <th style={{ ...th, width: 26 }} title="삭제 선택" />
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const sub = row.submission;
                    const selectable = sub.status === "pending" && row.parseOk && !!sub.studentId && !row.isTest;
                    const open = openId === sub.id;
                    return (
                      <Fragment key={sub.id}>
                        <tr style={{ opacity: row.parseOk ? 1 : 0.6 }}>
                          <td style={{ ...td, textAlign: "center" }}>
                            <button type="button" onClick={() => setOpenId(open ? null : sub.id)} aria-label="펼치기"
                              style={{ width: 24, height: 24, borderRadius: 6, display: "inline-grid", placeItems: "center", border: "1px solid var(--line)", background: "var(--card)", color: "var(--sub)", cursor: "pointer" }}>
                              <IconChevron open={open} />
                            </button>
                          </td>
                          <td style={td}>
                            <input type="checkbox" disabled={!selectable || applying} checked={selected.has(sub.id)}
                              onChange={(e) => toggleOne(sub.id, e.target.checked)} />
                          </td>
                          <td style={{ ...td, fontWeight: 700 }}>
                            {sub.studentName}
                            {sub.seatNumber != null && <span style={{ marginLeft: 6, fontSize: 11.5, fontWeight: 600, color: "var(--faint)" }}>{sub.seatNumber}번</span>}
                          </td>
                          <td style={{ ...td, fontVariantNumeric: "tabular-nums", color: "var(--sub)" }}>{sub.createdLabel}</td>
                          <td style={{ ...td, fontVariantNumeric: "tabular-nums", color: "var(--faint)" }}>{sub.firstSubmittedLabel ?? "-"}</td>
                          <td style={td}>
                            {/* 판정 순서가 중요하다 — 테스트·미연결 제출은 학생이 붙지 않아 파싱 단계에서도
                                실패하므로, parseOk 를 먼저 보면 전부 "형식 오류"로 뭉뚱그려진다.
                                그래서 사유가 분명한 쪽(테스트 → 미연결)을 먼저 판정하고, 형식 오류는 마지막에 둔다. */}
                            {row.isTest ? (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--faint)" }}>
                                <Chip {...testChip} />
                                <span>테스트 신원으로 낸 제출이라 반영할 수 없어요</span>
                              </span>
                            ) : row.isUnlinked ? (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--warn)" }}>
                                <Chip {...unlinkedChip} />
                                <span>학생 정보와 연결되지 않아 반영할 수 없어요</span>
                              </span>
                            ) : !row.parseOk ? (
                              // 사유를 title(호버 툴팁)에만 두지 않고 바로 옆에 텍스트로 보여준다 — 안 그러면
                              // "형식 오류"만 보이고 왜 안 되는지 알려면 마우스를 올려야 해서 놓치기 쉽다.
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--danger)" }}>
                                <IconAlertCircle />
                                <span>형식 오류{row.parseError ? `: ${row.parseError}` : ""}</span>
                              </span>
                            ) : (
                              summaryOf(row.hours, row.academies, row.restDays)
                            )}
                          </td>
                          <td style={td}><Chip {...diffChip[row.diffStatus]} /></td>
                          <td style={td}><Chip {...statusChip[sub.status]} /></td>
                          <td style={{ ...td, textAlign: "center" }}>
                            <input type="checkbox" disabled={!row.deletable || deleting} checked={delSelected.has(sub.id)}
                              title={row.deletable ? undefined : "대기 중인 제출은 반려한 뒤 삭제할 수 있어요"}
                              onChange={(e) => toggleDelOne(sub.id, e.target.checked)} />
                          </td>
                          <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                              {sub.status === "pending" && rejectingId !== sub.id && (
                                <button type="button" disabled={rowBusy === sub.id} onClick={() => { setRejectingId(sub.id); setRejectNote(""); setRowErr(null); }}
                                  style={{ height: 28, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--sub)", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                                  반려
                                </button>
                              )}
                              {row.deletable ? (
                                <button type="button" disabled={rowBusy === sub.id} onClick={() => doDeleteOne(sub.id)}
                                  style={{ height: 28, padding: "0 10px", borderRadius: 8, border: "1px solid var(--danger)", background: "var(--card)", color: "var(--danger)", fontSize: 11.5, fontWeight: 700, cursor: rowBusy === sub.id ? "default" : "pointer", opacity: rowBusy === sub.id ? 0.6 : 1 }}>
                                  삭제
                                </button>
                              ) : (
                                <button type="button" disabled title="대기 중인 제출은 반려한 뒤 삭제할 수 있어요"
                                  style={{ height: 28, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--faint)", fontSize: 11.5, fontWeight: 700, cursor: "not-allowed", opacity: 0.6 }}>
                                  삭제
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {rejectingId === sub.id && (
                          <tr>
                            <td colSpan={10} style={{ ...td, background: "var(--panel2)" }}>
                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <input className="input" style={{ height: 34, flex: "1 1 220px", fontSize: 12.5 }} placeholder="반려 사유(선택)"
                                  value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
                                <button type="button" disabled={rowBusy === sub.id} onClick={() => doReject(sub.id)}
                                  style={{ height: 30, padding: "0 12px", borderRadius: 8, border: "1px solid var(--danger)", background: "var(--danger)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: rowBusy === sub.id ? "default" : "pointer", opacity: rowBusy === sub.id ? 0.6 : 1 }}>
                                  반려 확정
                                </button>
                                <button type="button" onClick={() => { setRejectingId(null); setRejectNote(""); }}
                                  style={{ height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--sub)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                                  취소
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                        {rowErr?.id === sub.id && (
                          <tr><td colSpan={10} style={{ ...td, color: "var(--danger)", fontSize: 12 }}>{rowErr.msg}</td></tr>
                        )}
                        {open && (
                          <tr>
                            <td colSpan={10} style={{ ...td, background: "var(--panel2)" }}>
                              {sub.status === "rejected" && sub.note && (
                                <div style={{ fontSize: 12.5, color: "var(--danger)", marginBottom: 10 }}>반려 사유: {sub.note}</div>
                              )}
                              {sub.processedLabel && (
                                <div style={{ fontSize: 11.5, color: "var(--faint)", marginBottom: 10 }}>
                                  처리 {sub.processedLabel}{sub.processedByName ? ` (${sub.processedByName})` : ""}
                                </div>
                              )}
                              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                                <div style={{ flex: "1 1 260px", minWidth: 220 }}>
                                  <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)", marginBottom: 6 }}>제출 내용</div>
                                  {row.parseOk ? (
                                    <MiniTimetable hours={row.hours} restDays={row.restDays} academies={row.academies} />
                                  ) : (
                                    <div style={{ fontSize: 12.5, color: "var(--danger)" }}>{row.parseError}</div>
                                  )}
                                </div>
                                <div style={{ flex: "1 1 260px", minWidth: 220 }}>
                                  <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)", marginBottom: 6 }}>현재 시간표</div>
                                  {sub.studentId ? (
                                    <MiniTimetable hours={row.existingHours} restDays={[]} academies={row.existingAcademies} />
                                  ) : (
                                    <div style={{ fontSize: 12.5, color: "var(--faint)" }}>학생과 매칭되지 않아 비교할 수 없습니다.</div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---------------- 주간 미니 타임테이블(읽기 전용) ----------------
// f/[slug]/forms/sch9m2vt.tsx 의 MiniTimetable 과 같은 개념(등하원 선 + 학원 블록)을 관리자 화면
// 크기에 맞춰 더 작게 그린다. 색은 blockStyleOf() 그대로(단일 출처).
const TT_START = 7 * 60;
const TT_END = 25 * 60;
const TT_SPAN = TT_END - TT_START;
const TT_HEIGHT = 160;
const TT_GUTTER = 24;
const AXIS_LINE = "color-mix(in srgb, var(--line) 55%, transparent)";
const MUTE_OVERLAY = "color-mix(in srgb, var(--panel2) 80%, transparent)";
const REST_OVERLAY = "color-mix(in srgb, var(--panel2) 88%, transparent)";
const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function academyLabel(a: DbAcademy): string {
  return a.title.trim() ? a.title.trim() : a.reason;
}

function MiniTimetable({ hours, restDays, academies }: { hours: ImportHours[]; restDays: number[]; academies: DbAcademy[] }) {
  const hoursByDay = new Map(hours.map((h) => [h.day, { arrive: h.arrive, leave: h.leave }]));
  const restSet = new Set(restDays);
  const yOf = (min: number) => clampInt(Math.round(((min - TT_START) / TT_SPAN) * TT_HEIGHT), 0, TT_HEIGHT);
  const academyStyle = blockStyleOf("외부 학원");

  if (hoursByDay.size === 0 && academies.length === 0) {
    return <div style={{ fontSize: 12.5, color: "var(--faint)", padding: "8px 0" }}>내용 없음</div>;
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", background: "var(--card)" }}>
      <div style={{ display: "flex" }}>
        <div style={{ width: TT_GUTTER, flex: "none" }} />
        {DAY_LABEL.slice(1).map((label, i) => {
          const d = i + 1;
          const rest = restSet.has(d);
          return (
            <div key={d} style={{ flex: 1, textAlign: "center", fontSize: 10, fontWeight: 700, padding: "4px 0", color: rest ? "var(--faint)" : "var(--sub)", borderBottom: "1px solid var(--line)" }}>
              {label}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", height: TT_HEIGHT }}>
        <div style={{ width: TT_GUTTER, flex: "none", position: "relative" }}>
          {[7, 12, 18, 23].map((h) => (
            <span key={h} style={{ position: "absolute", right: 4, top: yOf(h * 60) - 5, fontSize: 8.5, color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
              {String(h).padStart(2, "0")}
            </span>
          ))}
        </div>
        {DAY_LABEL.slice(1).map((_, i) => {
          const d = i + 1;
          const rest = restSet.has(d);
          const hm = hoursByDay.get(d);
          const items = academies.filter((a) => a.days.includes(d));
          return (
            <div key={d} style={{ flex: 1, position: "relative", borderLeft: "1px solid var(--line)" }}>
              {[7, 12, 18, 23].map((h) => (
                <div key={h} style={{ position: "absolute", left: 0, right: 0, top: yOf(h * 60), height: 1, background: AXIS_LINE }} />
              ))}
              {rest && <div style={{ position: "absolute", inset: 0, background: REST_OVERLAY }} />}
              {!rest && hm && (
                <>
                  <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: yOf(hm.arrive), background: MUTE_OVERLAY }} />
                  <div style={{ position: "absolute", left: 0, right: 0, top: yOf(hm.leave), bottom: 0, background: MUTE_OVERLAY }} />
                  <div style={{ position: "absolute", left: 0, right: 0, top: yOf(hm.arrive) - 0.75, height: 1.5, background: "var(--sub)" }} />
                  <div style={{ position: "absolute", left: 0, right: 0, top: yOf(hm.leave) - 0.75, height: 1.5, background: "var(--sub)" }} />
                </>
              )}
              {!rest && items.map((a, ai) => {
                const top = yOf(a.start);
                const height = Math.max(3, yOf(a.end) - top);
                return (
                  <div key={ai} title={`${academyLabel(a)}`} style={{
                    position: "absolute", left: 1, right: 1, top, height,
                    background: academyStyle.bg, border: `1px solid ${academyStyle.bd}`, borderRadius: 3,
                    color: academyStyle.fg, fontSize: 8.5, fontWeight: 700, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
                  }} />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
