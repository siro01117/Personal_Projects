"use client";

// 학생 스케쥴러 — 정기(매주 반복) + 예외(1회성) 입력. DB 저장(낙관적 갱신 — 로컬 즉시 반영 후 서버액션, 실패 시 롤백).
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import {
  listSchedule, upsertRule, deleteRule, removeRuleDay as removeRuleDayAction,
  upsertException, deleteException, savePeriods, setHours, clearHours,
  type Period, type Rule, type Exc, type Kind, type Hours,
} from "./actions";
import { blockStyleOf, SCHEDULE_REASONS, reasonOf } from "@/lib/schedule";
import WindowView from "./WindowView";
import RequestsView from "./RequestsView";
import SubmissionsView from "./SubmissionsView";

// hoursCount: 등하원(schedule_hours) 행 개수 — page.tsx 에서 지점 전체를 한 번에 집계해 내려준다.
export type SStudent = { id: string; name: string; seat_number: number | null; hoursCount: number };

const DAYS = ["월", "화", "수", "목", "금", "토", "일"];
const START = 7 * 60, END = 25 * 60, STEP = 30, ROW = 28;
const SLOTS = (END - START) / STEP;
const SCROLL_TO_HOUR = 14; // 최초 진입 시 스크롤 기준 시각

// 행 종류(kind)별 색은 더 이상 여기서 따로 정의하지 않는다 — kind 는 "외부 학원"과 "원내 수업"을
// 둘 다 academy 로 묶어버려 구분이 안 됐던 원인이라, 테이블·팝오버 칩 색도 실제 사유(reason) 기준인
// blockStyleOf() 를 그대로 쓴다(위 타임테이블 블록과 같은 계산 — 화면 전체가 한 색 체계로 통일됨).
const fmt = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
/** 24:00 이상(익일 표시 범위)을 00:00/01:00 처럼 실제 시계 표기로 감싼다. */
const fmtClock = (m: number) => fmt(((m % 1440) + 1440) % 1440);
/** 종료시각이 시작시각 이하이면 자정을 넘긴 것으로 보고 end += 1440. */
const normOvernight = (start: number, end: number) => (end <= start ? end + 1440 : end);
let seq = 0;
const uid = () => "lb" + ++seq;

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso: string) => {
  const dow = new Date(iso + "T00:00:00Z").getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
};
const dayNum = (iso: string) => +iso.slice(8, 10);
const monNum = (iso: string) => +iso.slice(5, 7);
const yearOf = (iso: string) => +iso.slice(0, 4);
const weekLabel = (ws: string) => {
  const we = addDays(ws, 6);
  return monNum(ws) === monNum(we)
    ? `${yearOf(ws)}년 ${monNum(ws)}월`
    : `${yearOf(ws)}년 ${monNum(ws)}월–${monNum(we)}월`;
};

const thtd: React.CSSProperties = { border: "1px solid var(--line)", padding: "6px 8px", fontSize: 14 };

// ── 폼 컨트롤 공통 스타일(윈도우 기본 룩 탈피) — Inp/Sel 래퍼가 focus/error 상태를 관리한다 ──
const formBase: React.CSSProperties = {
  appearance: "none", background: "var(--card)", borderWidth: 1, borderStyle: "solid", borderColor: "var(--line)", borderRadius: 8,
  padding: "0 10px", height: 38, fontSize: 14, color: "var(--ink)", outline: "none",
  transition: "border-color .12s, box-shadow .12s", fontFamily: "inherit",
};
const formFocus: React.CSSProperties = { borderColor: "var(--accent)", boxShadow: "0 0 0 3px var(--accent-soft)" };
const formError: React.CSSProperties = { borderColor: "var(--danger)" };
const formErrorFocus: React.CSSProperties = { borderColor: "var(--danger)", boxShadow: "0 0 0 3px rgba(215,85,144,.22)" };

// 숫자 입력 원칙: onChange 는 필터+뒤 2자리만, 정규화(0패딩/범위검증)는 blur 에서. 포커스 시 전체선택.
// blur 핸들러는 state 가 아니라 e.currentTarget.value 를 읽는다(포커스 이동이 리렌더보다 먼저 일어날 수 있음).
type InpProps = React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean };
const Inp = forwardRef<HTMLInputElement, InpProps>(function Inp({ error, style, onFocus, onBlur, ...rest }, ref) {
  const [focused, setFocused] = useState(false);
  const stateStyle = focused ? (error ? formErrorFocus : formFocus) : error ? formError : undefined;
  return (
    <input
      {...rest}
      ref={ref}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      style={{ ...formBase, ...stateStyle, ...style }}
    />
  );
});

type SelProps = React.SelectHTMLAttributes<HTMLSelectElement> & { wrapStyle?: React.CSSProperties };
function Sel({ style, wrapStyle, onFocus, onBlur, children, ...rest }: SelProps) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-flex", ...wrapStyle }}>
      <select
        {...rest}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        style={{ ...formBase, ...(focused ? formFocus : undefined), paddingRight: 30, width: "100%", cursor: "pointer", ...style }}
      >
        {children}
      </select>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--sub)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
        style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
        <path d="M2.5 4.5L6 8l3.5-3.5" />
      </svg>
    </div>
  );
}
// ══════════════════════════════ 정기/예외 스케줄 입력 ══════════════════════════════
// 정기 규칙(매주 반복) + 예외(1회성, 정기 규칙을 그 날만 대체 가능)를 분리해서 다룬다.
// 하단 슬롯형 입력 바로 자유 텍스트 파싱 없이 넣고, 겹침은 모달로 명시적으로 처리한다.

type Sched = { rules: Rule[]; excs: Exc[]; hours: Hours[] };
type DBlock = { id: string; day: number; start: number; end: number; kind: Kind; reason: string; title: string; ruleId?: string; excId?: string; isExc?: boolean };

// 자리 비움 사유 처리용 — 자습을 제외한 고정 5종만 둔다(자습은 등하원에서 파생되는 상태라 더 이상 블록으로 저장하지 않음).
// 각 사유는 색상 계열(Kind)에 매핑된다. 목록·매핑 자체는 src/lib/schedule.ts 의 SCHEDULE_REASONS 가
// 단일 출처(학생용 일정 변경 신청 폼·관리 화면도 같은 걸 쓴다) — 여기서는 별칭만 둔다.
const REASONS = SCHEDULE_REASONS;
/** 제목 있으면 제목, 없으면 사유 라벨을 표시용 텍스트로 쓴다. */
const dispTitle = (title: string, reason: string) => (title.trim() ? title.trim() : reason);

const emptySched: Sched = { rules: [], excs: [], hours: [] };

/** 시간 문자열 → 분. "1830"/"18:30"/"18" 모두 허용. 엄격한 24시간제(오후 자동 추론 없음): "11"은 11:00, "23"은 23:00. */
function normTime(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  let h: number, m = 0;
  if (/^\d{3,4}$/.test(t)) { h = +t.slice(0, t.length - 2); m = +t.slice(-2); }
  else if (/^\d{1,2}:\d{2}$/.test(t)) { const [a, b] = t.split(":"); h = +a; m = +b; }
  else if (/^\d{1,2}$/.test(t)) { h = +t; }
  else return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

const dateToDayIdx = (iso: string, weekStart: string): number | null => {
  for (let d = 0; d < 7; d++) if (addDays(weekStart, d) === iso) return d;
  return null;
};

/** 정기 규칙 + 그 주 예외를 그 주 날짜에 전개한다. 자습 배경 카빙이 없으므로 겹침은 그대로 공존시키고(레이아웃에서 나란히 표시),
 *  겹침 여부는 추가 시점에 충돌 모달로 명시적으로 처리한다. */
function expandWeek(sched: Sched, weekStart: string): DBlock[] {
  const out: DBlock[] = [];
  for (let d = 0; d < 7; d++) {
    const iso = addDays(weekStart, d);
    const dnum = d + 1;
    for (const r of sched.rules) {
      if (!r.days.includes(dnum)) continue;
      if (sched.excs.some((e) => e.skipRuleId === r.id && e.date === iso)) continue;
      out.push({ id: uid(), day: d, start: r.start, end: r.end, kind: r.kind, reason: r.reason, title: dispTitle(r.title, r.reason), ruleId: r.id });
    }
  }
  for (const e of sched.excs) {
    // "이번 주만 삭제"가 남기는 순수 스킵 마커(제목 없는 자습/자습 사유 + skipRuleId) — 대체할 실제 내용이 없으므로 블록을 그리지 않는다.
    if (e.skipRuleId && e.kind === "study" && e.reason === "자습" && !e.title.trim()) continue;
    const d = dateToDayIdx(e.date, weekStart);
    if (d == null) continue;
    out.push({ id: uid(), day: d, start: e.start, end: e.end, kind: e.kind, reason: e.reason, title: dispTitle(e.title, e.reason), excId: e.id, isExc: true });
  }
  return out;
}

/** 같은 요일에서 겹치는 블록끼리 클러스터를 묶어 나란히(half-width 등) 배치한다. */
function layoutDay(blocks: DBlock[]): (DBlock & { col: number; cols: number })[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const out: (DBlock & { col: number; cols: number })[] = [];
  let cluster: DBlock[] = [];
  let clusterEnd = -1;
  const clusters: DBlock[][] = [];
  for (const b of sorted) {
    if (cluster.length && b.start < clusterEnd) { cluster.push(b); clusterEnd = Math.max(clusterEnd, b.end); }
    else { if (cluster.length) clusters.push(cluster); cluster = [b]; clusterEnd = b.end; }
  }
  if (cluster.length) clusters.push(cluster);
  for (const c of clusters) c.forEach((b, i) => out.push({ ...b, col: i, cols: c.length }));
  return out;
}

// ── 원 자체 운영 시간표(교시) — DB(schedule_period) 에서 로드, 지점 단위 ──
/** 요일별 분기가 사라져 항상 동일한 단일 시간표를 반환한다(호출부 시그니처 유지용). */
const periodsForDay = (periods: Period[], _d: number): Period[] => periods;

type Conflict = { date: string; block: DBlock };
type ConflictModal =
  | { type: "rule"; candidate: Rule; conflicts: Conflict[] }
  | { type: "exc"; candidate: Exc; conflicts: Conflict[] };

const dBtn = (active: boolean): React.CSSProperties => ({
  height: 36, minWidth: 34, padding: "0 9px", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer",
  border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`, background: active ? "var(--accent)" : "var(--card)", color: active ? "#fff" : "var(--sub)",
});
const btn = (disabled: boolean): React.CSSProperties => ({
  padding: "6px 12px", borderRadius: 10, borderWidth: 1, borderStyle: "solid", borderColor: "var(--line)", background: "var(--card)",
  fontSize: 12, fontWeight: 700, color: "var(--sub)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
});
const navBtn: React.CSSProperties = {
  width: 34, height: 34, borderRadius: 10, border: "1px solid var(--line)", background: "var(--card)",
  fontSize: 17, fontWeight: 700, color: "var(--sub)", cursor: "pointer", lineHeight: 1,
};
const kbtn: React.CSSProperties = {
  flex: 1, minWidth: 62, height: 44, padding: "0 8px", borderRadius: 12,
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--line)", background: "var(--card)", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--ink)",
};
// ── 하단 입력 바(2줄, 확대판) 전용 스타일 ──
const barDayBtn = (active: boolean): React.CSSProperties => ({
  minWidth: 44, height: 40, padding: "0 6px", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer",
  border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`, background: active ? "var(--accent)" : "var(--card)", color: active ? "#fff" : "var(--sub)",
});
const caption: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--faint)", marginBottom: 4 };
const field: React.CSSProperties = { display: "flex", flexDirection: "column" };

// ── 좌표계 헬퍼 — 학생 타임테이블과 운영 시간표 미리보기가 같은 계산을 공유한다 ──
/** 분 단위 시각 → 타임테이블 컨테이너 내부의 top px. */
const yPx = (min: number, rowH: number) => ((min - START) / STEP) * rowH;
/** 두 시각 사이 구간의 높이 px. */
const hPx = (a: number, b: number, rowH: number) => ((b - a) / STEP) * rowH;

// ── 인라인 라인 아이콘(이모지 금지) ──
const iconBase = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};
function IconCalendar() {
  return (
    <svg {...iconBase}>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12" />
      <path d="M5 1.5v3M11 1.5v3" />
    </svg>
  );
}
function IconPlus() {
  return <svg {...iconBase}><path d="M8 3v10M3 8h10" /></svg>;
}
function IconClock() {
  return (
    <svg {...iconBase}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.6 1.6" />
    </svg>
  );
}
function IconSwap() {
  // 하루짜리 일정 교체(신청) — 위아래 화살표로 "정기 대신 오늘만" 을 상징.
  return (
    <svg {...iconBase}>
      <path d="M3.5 5.5h7L8.5 3" />
      <path d="M12.5 10.5h-7L7.5 13" />
    </svg>
  );
}
function IconInbox() {
  // 학생 제출을 받아서 검토·반영하는 뷰 — 받은함 트레이 모양.
  return (
    <svg {...iconBase}>
      <path d="M2 9.5L4 3h8l2 6.5" />
      <path d="M2 9.5v3a1 1 0 001 1h10a1 1 0 001-1v-3" />
      <path d="M2 9.5h3.2l.9 1.6h3.8l.9-1.6H14" />
    </svg>
  );
}
function IconChevronLeft() {
  return <svg {...iconBase}><path d="M10 3l-5 5 5 5" /></svg>;
}
function IconChevronRight() {
  return <svg {...iconBase}><path d="M6 3l5 5-5 5" /></svg>;
}
function IconGrid() {
  return (
    <svg {...iconBase}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}
function IconList() {
  return <svg {...iconBase}><path d="M3 4h10M3 8h10M3 12h10" /></svg>;
}
function IconPencil() {
  return <svg {...iconBase}><path d="M10.5 2.5l3 3L5 14H2v-3z" /></svg>;
}
function IconCheck() {
  return <svg {...iconBase}><path d="M3 8.5l3.2 3.2L13 4.5" /></svg>;
}
function IconTrash() {
  return (
    <svg {...iconBase}>
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5" />
      <path d="M4.5 4.5l.6 8a1.5 1.5 0 001.5 1.4h2.8a1.5 1.5 0 001.5-1.4l.6-8" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg {...iconBase}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M13.5 13.5l-3-3" />
    </svg>
  );
}
/** 등하원 시간 미설정 경고 — 원 안 느낌표, 14px 고정(iconBase 의 16px 과 별도). */
function IconWarn() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--warn)" }}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5.2v3.4" />
      <circle cx="8" cy="10.8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
/** 아이콘 + 라벨 버튼 내부 콘텐츠를 텍스트 중앙 정렬로 배치한다. */
const iconRow: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 };

export default function ScheduleDemo({
  students, today, initialPeriods, initialStudentId,
}: {
  students: SStudent[]; today: string; initialPeriods: Period[];
  initialStudentId?: string | null; // 좌석 배치도·학생 상세에서 ?student=<id> 로 진입 시 미리 선택
}) {
  const thisMon = useMemo(() => mondayOf(today), [today]);
  const [weekStart, setWeekStart] = useState(thisMon);
  const [view, setView] = useState<"table" | "sheet">("table");
  const [dsid, setDsid] = useState(initialStudentId ?? students[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [schedByStudent, setSchedByStudent] = useState<Record<string, Sched>>({});
  const [loading, setLoading] = useState(true); // 학생 전환·주 이동 시 서버에서 로드 중
  const [showInputBar, setShowInputBar] = useState(false); // 기본은 보기 모드 — 입력 바는 토글로만 노출
  const [showOpsView, setShowOpsView] = useState(false); // 운영 시간표 뷰(학생 선택과 배타적)
  const [opsBtnHover, setOpsBtnHover] = useState(false); // 사이드바 "운영 시간표" 버튼 hover(인라인 스타일이라 직접 추적)
  const [showWindowView, setShowWindowView] = useState(false); // 입력 활성화 관리 뷰(학생 선택·운영 시간표와 배타적)
  const [winBtnHover, setWinBtnHover] = useState(false); // 사이드바 "입력 활성화" 버튼 hover
  const [showRequestsView, setShowRequestsView] = useState(false); // 변경 신청 관리 뷰(학생 선택·다른 독립 뷰와 배타적)
  const [reqBtnHover, setReqBtnHover] = useState(false); // 사이드바 "변경 신청" 버튼 hover
  const [showSubmissionsView, setShowSubmissionsView] = useState(false); // 제출 반영 뷰(학생 선택·다른 독립 뷰와 배타적)
  const [subBtnHover, setSubBtnHover] = useState(false); // 사이드바 "제출 반영" 버튼 hover

  // ── 입력 바 상태 ──
  const [reasonVal, setReasonVal] = useState<string>("academy_out");
  const [title, setTitle] = useState("");
  const [startRaw, setStartRaw] = useState("");
  const [endRaw, setEndRaw] = useState("");
  const [startErr, setStartErr] = useState(false);
  const [endErr, setEndErr] = useState(false);
  const [selDays, setSelDays] = useState<number[]>([]);
  const [excMode, setExcMode] = useState(false);
  const [dateVal, setDateVal] = useState(today);
  const [conflictModal, setConflictModal] = useState<ConflictModal | null>(null);
  const [pop, setPop] = useState<null | { x: number; y: number; block: DBlock }>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editRuleId, setEditRuleId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; startRaw: string; endRaw: string; days: number[] } | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const viewScrollRef = useRef<HTMLDivElement | null>(null);
  const [hoverRuleId, setHoverRuleId] = useState<string | null>(null);

  // ── 타임테이블 행 높이(30분 슬롯 픽셀 높이). 화면 안에 다 들어오도록 기본값을 작게 잡고, 휠로 조절한다.
  const [rowH, setRowH] = useState(24);
  const clampRowH = (h: number) => Math.min(44, Math.max(12, h));

  // ── 원 운영 시간표(교시/쉬는시간) ──
  const [periods, setPeriods] = useState<Period[]>(initialPeriods);
  const [editPeriod, setEditPeriod] = useState<{ id: string; label: string; startRaw: string; endRaw: string } | null>(null);

  // ── 등·하원 시간 적용(선택 학생·요일의 등원/하원 시각을 upsert) — 입력 카드 내 구역에 상시 노출 ──
  const [hoursDays, setHoursDays] = useState<number[]>([]);
  const [arrH, setArrH] = useState("");
  const [arrM, setArrM] = useState("");
  const [lvH, setLvH] = useState("");
  const [lvM, setLvM] = useState("");
  const [arrHErr, setArrHErr] = useState(false);
  const [arrMErr, setArrMErr] = useState(false);
  const [lvHErr, setLvHErr] = useState(false);
  const [lvMErr, setLvMErr] = useState(false);
  const [hoursResult, setHoursResult] = useState<string | null>(null);
  // 시 칸이 2자리 다 찼을 때, 커밋(리렌더) 이후에 분 칸으로 포커스를 옮기기 위한 플래그.
  const [jumpTo, setJumpTo] = useState<null | "arrMin" | "lvMin">(null);
  const arrHRef = useRef<HTMLInputElement | null>(null);
  const arrMRef = useRef<HTMLInputElement | null>(null);
  const lvHRef = useRef<HTMLInputElement | null>(null);
  const lvMRef = useRef<HTMLInputElement | null>(null);
  // 타임테이블 요일 열 폭이 좁을 때 등원/하원 라인 라벨을 시각만 표시하기 위한 측정값(마운트 후 ResizeObserver).
  const [narrowCols, setNarrowCols] = useState(false);
  const gridWrapRef = useRef<HTMLDivElement | null>(null);

  // ── 현재 시각(KST, 실시간) ── 서버 렌더 시점엔 알 수 없으므로 null로 시작해 하이드레이션 미스매치를 피하고,
  // 마운트 이펙트에서 1회 계산 후 30초마다 갱신한다. 렌더 경로에서는 new Date()를 직접 부르지 않는다.
  const [nowMin, setNowMin] = useState<number | null>(null); // KST 기준 자정부터의 분(0~1439)
  const [kstDate, setKstDate] = useState<string | null>(null); // KST 기준 오늘 날짜 "YYYY-MM-DD"
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNowMin((d.getUTCHours() * 60 + d.getUTCMinutes() + 540) % 1440);
      const kd = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      const y = kd.getUTCFullYear();
      const mo = String(kd.getUTCMonth() + 1).padStart(2, "0");
      const da = String(kd.getUTCDate()).padStart(2, "0");
      setKstDate(`${y}-${mo}-${da}`);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);
  // 그리드 좌표계로 변환한 "지금" 위치. 00:00~01:00대는 그리드가 전날 열의 익일 01:00까지 이어지므로 +1440 하고,
  // 그 결과가 END를 넘으면(01:00 이후) 선을 그리지 않는다.
  const nowGridMin = nowMin == null ? null : nowMin < START ? (nowMin + 1440 <= END ? nowMin + 1440 : null) : nowMin;
  // "지금" 위치가 속한 그리드상의 날짜(요일 판정용). 00:00~01:00대는 그 시간을 익일 01:00까지로 보여주는 전날 열 소속.
  const ownerToday = kstDate == null || nowMin == null ? null : nowMin < START ? addDays(kstDate, -1) : kstDate;

  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); };

  const sched: Sched = schedByStudent[dsid] ?? emptySched;
  const updateSched = (fn: (s: Sched) => Sched) => setSchedByStudent((d) => ({ ...d, [dsid]: fn(d[dsid] ?? emptySched) }));
  const rollbackSched = (prev: Sched) => setSchedByStudent((d) => ({ ...d, [dsid]: prev }));
  const selStudent = students.find((s) => s.id === dsid);

  // 학생 전환·주 이동 시 서버에서 그 학생 데이터를 로드. 이전 요청이 늦게 와도 언마운트/전환 후엔 반영하지 않는다.
  useEffect(() => {
    if (!dsid) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    listSchedule(dsid, weekStart, addDays(weekStart, 6))
      .then(({ periods: p, rules, exceptions, hours }) => {
        if (!alive) return;
        setPeriods(p);
        setSchedByStudent((d) => ({ ...d, [dsid]: { rules, excs: exceptions, hours } }));
      })
      .catch(() => { if (alive) say("불러오기에 실패했습니다"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsid, weekStart]);

  const toggleHoursDay = (n: number) => setHoursDays((ds) => (ds.includes(n) ? ds.filter((x) => x !== n) : [...ds, n].sort()));
  /** 서버가 반환한 요일들의 등하원을 로컬 목록에 병합(그 외 요일은 그대로 둔다). */
  const mergeHours = (existing: Hours[], saved: Hours[]): Hours[] => {
    const byDay = new Map(existing.map((h) => [h.day, h]));
    for (const h of saved) byDay.set(h.day, h);
    return [...byDay.values()].sort((a, b) => a.day - b.day);
  };
  const applyHoursNow = () => {
    const ah = arrH === "" ? null : +arrH;
    const am = arrM === "" ? null : +arrM;
    const lh = lvH === "" ? null : +lvH;
    const lm = lvM === "" ? null : +lvM;
    const ahOk = ah != null && ah >= 0 && ah <= 23;
    const amOk = am != null && am >= 0 && am <= 59;
    const lhOk = lh != null && lh >= 0 && lh <= 23;
    const lmOk = lm != null && lm >= 0 && lm <= 59;
    setArrHErr(!ahOk); setArrMErr(!amOk); setLvHErr(!lhOk); setLvMErr(!lmOk);
    if (!hoursDays.length || !ahOk || !amOk || !lhOk || !lmOk) { setHoursResult("요일과 시간을 확인하세요"); return; }
    const arrive = ah! * 60 + am!;
    const leave = normOvernight(arrive, lh! * 60 + lm!);
    const prev = sched;
    const days = [...hoursDays];
    updateSched((s) => {
      const rest = s.hours.filter((h) => !days.includes(h.day));
      const next = [...rest, ...days.map((d) => ({ day: d, arrive_min: arrive, leave_min: leave }))].sort((a, b) => a.day - b.day);
      return { ...s, hours: next };
    });
    setHoursResult(`${days.length}개 요일 적용됨`);
    const fd = new FormData();
    fd.set("studentId", dsid);
    fd.set("days", days.join(","));
    fd.set("arrive", String(arrive));
    fd.set("leave", String(leave));
    setHours(fd)
      .then((saved) => updateSched((s) => ({ ...s, hours: mergeHours(s.hours, saved) })))
      .catch((err) => {
        rollbackSched(prev);
        setHoursResult(null);
        say(err instanceof Error ? err.message : "저장에 실패했습니다");
      });
  };
  const clearHoursNow = () => {
    if (!hoursDays.length) { setHoursResult("요일을 선택하세요"); return; }
    const prev = sched;
    const days = [...hoursDays];
    updateSched((s) => ({ ...s, hours: s.hours.filter((h) => !days.includes(h.day)) }));
    setHoursResult(`${days.length}개 요일 해제됨`);
    const fd = new FormData();
    fd.set("studentId", dsid);
    fd.set("days", days.join(","));
    clearHours(fd).catch((err) => {
      rollbackSched(prev);
      setHoursResult(null);
      say(err instanceof Error ? err.message : "삭제에 실패했습니다");
    });
  };

  // ── 원 운영 시간표 편집 (지점 단위 전체 교체 — 바뀔 때마다 서버에 delete+insert 로 반영) ──
  const persistPeriods = async (next: Period[]) => {
    const prev = periods;
    const prevEditId = editPeriod?.id ?? null;
    setPeriods(next);
    const fd = new FormData();
    fd.set("periods", JSON.stringify(next.map((p) => ({ label: p.label, start: p.start, end: p.end }))));
    try {
      const { periods: saved } = await savePeriods(fd);
      setPeriods(saved);
      if (prevEditId) {
        const wasEditing = next.find((p) => p.id === prevEditId);
        const match = wasEditing ? saved.find((p) => p.label === wasEditing.label && p.start === wasEditing.start && p.end === wasEditing.end) : null;
        if (match) setEditPeriod((cur) => (cur ? { ...cur, id: match.id } : cur));
      }
    } catch (err) {
      setPeriods(prev);
      say(err instanceof Error ? err.message : "저장에 실패했습니다");
    }
  };
  const currentPeriods = periods;
  const updatePeriods = (fn: (list: Period[]) => Period[]) => { void persistPeriods(fn(periods)); };
  const startEditPeriod = (p: Period) => setEditPeriod({ id: p.id, label: p.label, startRaw: fmt(p.start), endRaw: fmt(p.end) });
  const savePeriod = () => {
    if (!editPeriod) return;
    const s = normTime(editPeriod.startRaw), e = normTime(editPeriod.endRaw);
    if (!editPeriod.label.trim() || s == null || e == null || e <= s) { say("입력값을 확인하세요"); return; }
    updatePeriods((list) => list.map((p) => (p.id === editPeriod.id ? { ...p, label: editPeriod.label.trim(), start: s, end: e } : p)).sort((a, b) => a.start - b.start));
    setEditPeriod(null);
  };
  const addPeriodRow = () => {
    const last = currentPeriods[currentPeriods.length - 1];
    const start = last ? last.end : 15 * 60;
    const np: Period = { id: uid(), label: "새 교시", start, end: start + 60 };
    updatePeriods((l) => [...l, np]);
    startEditPeriod(np);
  };
  const deletePeriod = (id: string) => { updatePeriods((l) => l.filter((p) => p.id !== id)); if (editPeriod?.id === id) setEditPeriod(null); };

  const shown = useMemo(() => {
    const t = q.trim();
    return t ? students.filter((s) => s.name.includes(t) || String(s.seat_number ?? "").includes(t)) : students;
  }, [students, q]);

  // 등하원 미설정 판정 — page.tsx 가 내려준 서버 집계(hoursCount)를 기본값으로 쓰되, 이미 이 세션에서
  // listSchedule 로 로드했거나(선택/이전 선택 학생) 낙관적으로 갱신한 학생은 실제 hours 배열 길이를 우선한다
  // (등하원 저장·해제·엑셀 임포트 직후 목록이 서버 재조회 없이 즉시 갱신되도록).
  const baseHoursCount = useMemo(() => new Map(students.map((s) => [s.id, s.hoursCount])), [students]);
  const hoursCountFor = (id: string) => schedByStudent[id]?.hours.length ?? baseHoursCount.get(id) ?? 0;
  const unsetCount = useMemo(
    () => students.reduce((acc, s) => acc + (hoursCountFor(s.id) === 0 ? 1 : 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [students, schedByStudent, baseHoursCount],
  );

  const startMin = useMemo(() => normTime(startRaw), [startRaw]);
  const endMinRaw = useMemo(() => normTime(endRaw), [endRaw]);
  const endMin = useMemo(() => (startMin != null && endMinRaw != null ? normOvernight(startMin, endMinRaw) : endMinRaw), [startMin, endMinRaw]);
  const timeOk = startMin != null && endMin != null && endMin > startMin;
  const excDayIdx = excMode && dateVal ? dateToDayIdx(dateVal, mondayOf(dateVal)) : null;
  const dateOk = !excMode || (!!dateVal && excDayIdx != null);
  const daysOk = excMode ? dateOk : selDays.length > 0;
  const canAdd = timeOk && daysOk;
  const reasonForTooltip = !timeOk ? "시작·종료 시간을 확인하세요" : !daysOk ? (excMode ? "날짜를 확인하세요" : "요일을 선택하세요") : "";

  const toggleDay = (n: number) => setSelDays((ds) => (ds.includes(n) ? ds.filter((x) => x !== n) : [...ds, n].sort()));

  const persistNewRule = async (r: Rule) => {
    const prev = sched;
    updateSched((s) => ({ ...s, rules: [...s.rules, r] }));
    const fd = new FormData();
    fd.set("studentId", dsid);
    fd.set("reason", r.reason);
    fd.set("kind", r.kind);
    fd.set("title", r.title);
    fd.set("start", String(r.start));
    fd.set("end", String(r.end));
    fd.set("days", r.days.join(","));
    try {
      const saved = await upsertRule(fd);
      updateSched((s) => ({ ...s, rules: s.rules.map((x) => (x.id === r.id ? saved : x)) }));
    } catch (err) {
      rollbackSched(prev);
      say(err instanceof Error ? err.message : "저장에 실패했습니다");
    }
  };
  const persistNewException = async (e: Exc) => {
    const prev = sched;
    updateSched((s) => ({ ...s, excs: [...s.excs, e] }));
    const fd = new FormData();
    fd.set("studentId", dsid);
    fd.set("reason", e.reason);
    fd.set("kind", e.kind);
    fd.set("title", e.title);
    fd.set("start", String(e.start));
    fd.set("end", String(e.end));
    fd.set("date", e.date);
    if (e.skipRuleId) fd.set("skipRuleId", e.skipRuleId);
    try {
      const saved = await upsertException(fd);
      updateSched((s) => ({ ...s, excs: s.excs.map((x) => (x.id === e.id ? saved : x)) }));
    } catch (err) {
      rollbackSched(prev);
      say(err instanceof Error ? err.message : "저장에 실패했습니다");
    }
  };
  const commitRule = (r: Rule) => { void persistNewRule(r); afterAdd(); };
  const commitExc = (e: Exc) => { void persistNewException(e); afterAdd(); };
  const afterAdd = () => {
    setTitle("");
    setTimeout(() => titleRef.current?.focus(), 0);
  };

  const findConflictsForRule = (candidate: Rule): Conflict[] => {
    const expanded = expandWeek(sched, weekStart);
    const out: Conflict[] = [];
    for (const dnum of candidate.days) {
      const idx = dnum - 1;
      const iso = addDays(weekStart, idx);
      for (const b of expanded) if (b.day === idx && b.start < candidate.end && b.end > candidate.start) out.push({ date: iso, block: b });
    }
    return out;
  };
  const findConflictsForExc = (candidate: Exc): Conflict[] => {
    const week = mondayOf(candidate.date);
    const idx = dateToDayIdx(candidate.date, week);
    if (idx == null) return [];
    const expanded = expandWeek(sched, week);
    return expanded.filter((b) => b.day === idx && b.start < candidate.end && b.end > candidate.start).map((b) => ({ date: candidate.date, block: b }));
  };

  const tryAdd = () => {
    if (!canAdd || startMin == null || endMin == null) return;
    const { kind, label: reason } = reasonOf(reasonVal);
    if (excMode) {
      const candidate: Exc = { id: uid(), kind, reason, title: title.trim(), start: startMin, end: endMin, date: dateVal };
      const conflicts = findConflictsForExc(candidate);
      if (conflicts.length) setConflictModal({ type: "exc", candidate, conflicts });
      else commitExc(candidate);
    } else {
      const candidate: Rule = { id: uid(), kind, reason, title: title.trim(), start: startMin, end: endMin, days: [...selDays] };
      const conflicts = findConflictsForRule(candidate);
      if (conflicts.length) setConflictModal({ type: "rule", candidate, conflicts });
      else commitRule(candidate);
    }
  };

  const conflictReplaceTarget = conflictModal?.conflicts.find((c) => c.block.ruleId)?.block.ruleId;
  const applyReplace = () => {
    if (!conflictModal || conflictModal.type !== "exc" || !conflictReplaceTarget) return;
    commitExc({ ...conflictModal.candidate, skipRuleId: conflictReplaceTarget });
    setConflictModal(null);
  };
  const applyOverlap = () => {
    if (!conflictModal) return;
    if (conflictModal.type === "rule") commitRule(conflictModal.candidate);
    else commitExc(conflictModal.candidate);
    setConflictModal(null);
  };

  const deleteBlock = (b: DBlock) => {
    const prev = sched;
    if (b.excId) {
      const excId = b.excId;
      updateSched((s) => ({ ...s, excs: s.excs.filter((e) => e.id !== excId) }));
      say("삭제했습니다");
      deleteException(excId).catch((err) => { rollbackSched(prev); say(err instanceof Error ? err.message : "삭제에 실패했습니다"); });
    } else if (b.ruleId) {
      const ruleId = b.ruleId;
      updateSched((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== ruleId) }));
      say("정기 일정을 삭제했습니다(모든 주)");
      deleteRule(ruleId).catch((err) => { rollbackSched(prev); say(err instanceof Error ? err.message : "삭제에 실패했습니다"); });
    }
    setPop(null);
  };
  /** 정기 일정의 이번 주 발생만 제거. 대체할 실제 내용은 없으므로 제목 없는 skipRuleId 마커 예외를 남긴다
   *  (expandWeek 이 이를 블록으로 그리지 않음 — 그 시간은 등하원 파생 판정에 맡겨진다). */
  const deleteThisWeekOnly = (b: DBlock) => {
    if (!b.ruleId) return;
    const iso = addDays(weekStart, b.day);
    void persistNewException({ id: uid(), kind: "study", reason: "자습", title: "", start: b.start, end: b.end, date: iso, skipRuleId: b.ruleId });
    say("이번 주만 삭제했습니다");
    setPop(null);
  };
  /** 이 요일만 규칙에서 제거. 마지막 요일이면 규칙 자체가 사라진다. */
  const removeRuleDay = (b: DBlock) => {
    if (!b.ruleId) return;
    const ruleId = b.ruleId;
    const dnum = b.day + 1;
    const prev = sched;
    updateSched((s) => ({
      ...s,
      rules: s.rules.flatMap((r) => {
        if (r.id !== ruleId) return [r];
        const days = r.days.filter((d) => d !== dnum);
        return days.length ? [{ ...r, days }] : [];
      }),
    }));
    say("이 요일만 제거했습니다");
    setPop(null);
    removeRuleDayAction(ruleId, dnum).catch((err) => { rollbackSched(prev); say(err instanceof Error ? err.message : "저장에 실패했습니다"); });
  };

  // 표시 주가 이번 주일 때만 현재 시각선을 그린다. effToday(KST, 자정 넘김 보정)가 없으면(마운트 전) 서버 today로 폴백.
  const effToday = ownerToday ?? today;
  const isCurrentWeek = weekStart === mondayOf(effToday);
  const nowTop = nowGridMin != null ? yPx(nowGridMin, rowH) : 0;

  const weekBlocks = useMemo(() => expandWeek(sched, weekStart), [sched, weekStart]);
  const popRule = pop?.block.ruleId ? sched.rules.find((r) => r.id === pop.block.ruleId) : undefined;
  const popExc = pop?.block.excId ? sched.excs.find((e) => e.id === pop.block.excId) : undefined;
  const popReplaceTarget = popExc?.skipRuleId ? sched.rules.find((r) => r.id === popExc.skipRuleId) : undefined;
  const activeRuleId = pop?.block.ruleId ?? hoverRuleId;

  // 등원/하원 "시" 칸이 2자리 다 찼을 때 "분" 칸으로 포커스를 옮긴다. onChange 안에서 동기 focus()를 호출하면
  // blur 핸들러가 리렌더 전(옛 state)의 클로저를 읽는 문제가 생기므로, 커밋(리렌더) 이후인 이펙트에서 옮긴다.
  useEffect(() => {
    if (jumpTo === "arrMin") arrMRef.current?.focus();
    else if (jumpTo === "lvMin") lvMRef.current?.focus();
    if (jumpTo) setJumpTo(null);
  }, [jumpTo]);

  // 타임테이블 요일 열 폭 측정(등원/하원 라벨을 "등원 08:00" vs "08:00"으로 표시할지 판단). 렌더 중 DOM 읽기를 피하려 이펙트에서만 갱신.
  useEffect(() => {
    const el = gridWrapRef.current;
    if (!el) return;
    const measure = () => setNarrowCols(el.clientWidth / 7 < 70);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 최초 진입 시 14:00 근처로 스크롤(렌더 중 DOM 접근 금지 — 마운트 이펙트에서 1회만).
  useEffect(() => {
    const el = viewScrollRef.current;
    if (!el) return;
    el.scrollTop = yPx(SCROLL_TO_HOUR * 60, rowH) - 40;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 타임테이블은 평소엔 그냥 세로 스크롤된다. Ctrl(또는 Cmd)+휠일 때만 행 높이를 조절하며 브라우저 확대를 막는다.
  // React onWheel은 passive라 preventDefault가 안 먹으므로 직접 등록한다.
  useEffect(() => {
    const el = viewScrollRef.current;
    if (!el || view !== "table") return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // 일반 휠은 브라우저 기본 스크롤에 맡긴다.
      e.preventDefault();
      setRowH((h) => clampRowH(h + (e.deltaY < 0 ? 2 : -2)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view]);

  return (
    <div
      style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
        if (e.key >= "1" && e.key <= "7") toggleDay(+e.key);
      }}
    >
      <div style={{ flex: 1, minHeight: 0, width: "100%", maxWidth: 1400, margin: "0 auto", padding: "16px 20px", boxSizing: "border-box", background: "var(--bg)", display: "flex", gap: 12 }}>
        {/* 학생 목록 — 독립 카드 */}
        <div className="card" style={{ flex: "none", width: 220, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          <div style={{ flex: "none", padding: "9px 7px 0" }}>
            <button onClick={() => { setShowOpsView(true); setShowWindowView(false); setShowRequestsView(false); setShowSubmissionsView(false); }}
              onMouseEnter={() => setOpsBtnHover(true)} onMouseLeave={() => setOpsBtnHover(false)}
              style={{ width: "100%", padding: "8px 9px", borderRadius: 8, cursor: "pointer", textAlign: "left",
                border: `1px solid ${showOpsView ? "var(--accent)" : "var(--line)"}`,
                background: showOpsView ? "var(--accent-soft)" : opsBtnHover ? "var(--panel2)" : "var(--card)" }}>
              <span style={{ ...iconRow, fontSize: 12.5, fontWeight: showOpsView ? 800 : 700, color: showOpsView ? "var(--accent)" : "var(--ink)" }}>
                <IconCalendar />운영 시간표
              </span>
            </button>
            <button onClick={() => { setShowWindowView(true); setShowOpsView(false); setShowRequestsView(false); setShowSubmissionsView(false); }}
              onMouseEnter={() => setWinBtnHover(true)} onMouseLeave={() => setWinBtnHover(false)}
              style={{ width: "100%", padding: "8px 9px", borderRadius: 8, cursor: "pointer", textAlign: "left", marginTop: 6,
                border: `1px solid ${showWindowView ? "var(--accent)" : "var(--line)"}`,
                background: showWindowView ? "var(--accent-soft)" : winBtnHover ? "var(--panel2)" : "var(--card)" }}>
              <span style={{ ...iconRow, fontSize: 12.5, fontWeight: showWindowView ? 800 : 700, color: showWindowView ? "var(--accent)" : "var(--ink)" }}>
                <IconClock />입력 활성화
              </span>
            </button>
            <button onClick={() => { setShowRequestsView(true); setShowOpsView(false); setShowWindowView(false); setShowSubmissionsView(false); }}
              onMouseEnter={() => setReqBtnHover(true)} onMouseLeave={() => setReqBtnHover(false)}
              style={{ width: "100%", padding: "8px 9px", borderRadius: 8, cursor: "pointer", textAlign: "left", marginTop: 6,
                border: `1px solid ${showRequestsView ? "var(--accent)" : "var(--line)"}`,
                background: showRequestsView ? "var(--accent-soft)" : reqBtnHover ? "var(--panel2)" : "var(--card)" }}>
              <span style={{ ...iconRow, fontSize: 12.5, fontWeight: showRequestsView ? 800 : 700, color: showRequestsView ? "var(--accent)" : "var(--ink)" }}>
                <IconSwap />변경 신청
              </span>
            </button>
            <button onClick={() => { setShowSubmissionsView(true); setShowOpsView(false); setShowWindowView(false); setShowRequestsView(false); }}
              onMouseEnter={() => setSubBtnHover(true)} onMouseLeave={() => setSubBtnHover(false)}
              style={{ width: "100%", padding: "8px 9px", borderRadius: 8, cursor: "pointer", textAlign: "left", marginTop: 6,
                border: `1px solid ${showSubmissionsView ? "var(--accent)" : "var(--line)"}`,
                background: showSubmissionsView ? "var(--accent-soft)" : subBtnHover ? "var(--panel2)" : "var(--card)" }}>
              <span style={{ ...iconRow, fontSize: 12.5, fontWeight: showSubmissionsView ? 800 : 700, color: showSubmissionsView ? "var(--accent)" : "var(--ink)" }}>
                <IconInbox />제출 반영
              </span>
            </button>
            <div style={{ borderTop: "1px solid var(--line)", margin: "8px 2px" }} />
          </div>
          <div style={{ flex: "none", padding: "0 9px 9px" }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--dim)" }}><IconSearch /></span>
              <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 · 좌석" style={{ height: 36, fontSize: 12.5, paddingLeft: 32, width: "100%" }} />
            </div>
            {unsetCount > 0 && (
              <div style={{ fontSize: 11, color: "var(--warn)", fontWeight: 700, marginTop: 5, padding: "0 2px" }}>미설정 {unsetCount}명</div>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 7px 9px", display: "flex", flexDirection: "column", gap: 2 }}>
            {shown.map((s) => {
              const on = !showOpsView && !showWindowView && !showRequestsView && !showSubmissionsView && s.id === dsid;
              const n = schedByStudent[s.id]?.rules.length ?? 0;
              const hoursUnset = hoursCountFor(s.id) === 0;
              return (
                <button key={s.id} onClick={() => { setDsid(s.id); setShowOpsView(false); setShowWindowView(false); setShowRequestsView(false); setShowSubmissionsView(false); }}
                  style={{ display: "grid", gridTemplateColumns: "44px 1fr", alignItems: "center", columnGap: 10, padding: "7px 9px", borderRadius: 9, cursor: "pointer", textAlign: "left",
                    border: `1px solid ${on ? "var(--accent)" : "transparent"}`, background: on ? "var(--accent-soft)" : "transparent" }}>
                  <span style={{ fontSize: 12.5, color: "var(--sub)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{s.seat_number != null ? s.seat_number : "–"}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: on ? 800 : 600, color: on ? "var(--accent)" : "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                    <span style={{ flex: "none", display: "flex", alignItems: "center", gap: 4 }}>
                      {hoursUnset && <span title="등하원 시간 미설정" style={{ display: "inline-flex" }}><IconWarn /></span>}
                      {n > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sub)", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 999, padding: "1px 6px" }}>{n}</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 우측 컬럼 — 헤더 카드 + 타임테이블 카드 + (토글 시) 입력 바 카드 */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {showOpsView ? (
          <>
            {/* 헤더 카드 */}
            <div className="card" style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", flexWrap: "wrap" }}>
              <span style={{ fontSize: 20, fontWeight: 700 }}>운영 시간표</span>
              <span style={{ fontSize: 12, color: "var(--faint)" }}>표를 고치면 미리보기가 바로 갱신됩니다</span>
            </div>
            {/* 타임테이블 카드 */}
            <div className="card" style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden", padding: 0 }}>
              <OpsView
                periods={periods}
                editPeriod={editPeriod}
                setEditPeriod={setEditPeriod}
                startEditPeriod={startEditPeriod}
                savePeriod={savePeriod}
                addPeriodRow={addPeriodRow}
                deletePeriod={deletePeriod}
              />
            </div>
          </>
        ) : showWindowView ? (
          <WindowView students={students} />
        ) : showRequestsView ? (
          <RequestsView />
        ) : showSubmissionsView ? (
          <SubmissionsView />
        ) : (
        <>
          {/* 헤더 카드: 학생 이름/칩 · 주 이동 · 뷰 세그먼트 · 입력 토글 */}
          <div className="card" style={{ flex: "none", display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", flexWrap: "wrap" }}>
            {selStudent && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--sub)", fontVariantNumeric: "tabular-nums" }}>{selStudent.seat_number != null ? `${selStudent.seat_number}번` : "미배정"}</span>
                  <span style={{ fontSize: 20, fontWeight: 700 }}>{selStudent.name}</span>
                </span>
                <span style={{ ...kchip, background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--sub)" }}>정기 일정 {sched.rules.length}건</span>
                <span style={{ ...kchip, background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--sub)" }}>임시 일정 {sched.excs.length}건</span>
                <span style={{ ...kchip, background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--sub)" }}>등하원 {sched.hours.length}일</span>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 auto" }}>
              <button onClick={() => setWeekStart(addDays(weekStart, -7))} style={{ ...navBtn, ...iconRow }} aria-label="이전 주"><IconChevronLeft /></button>
              <button onClick={() => setWeekStart(thisMon)} disabled={weekStart === thisMon} style={{ ...btn(weekStart === thisMon), padding: "6px 13px" }}>오늘</button>
              <button onClick={() => setWeekStart(addDays(weekStart, 7))} style={{ ...navBtn, ...iconRow }} aria-label="다음 주"><IconChevronRight /></button>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{weekLabel(weekStart)}</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
                {(["table", "sheet"] as const).map((v) => (
                  <button key={v} onClick={() => setView(v)}
                    style={{ ...iconRow, padding: "7px 13px", border: "none", fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                      background: view === v ? "var(--accent)" : "var(--card)", color: view === v ? "#fff" : "var(--sub)" }}>
                    {v === "table" ? <IconGrid /> : <IconList />}{v === "table" ? "타임테이블" : "시트"}
                  </button>
                ))}
              </div>
              <button onClick={() => setShowInputBar((v) => !v)} style={{ ...btn(false), ...iconRow, padding: "6px 13px", borderColor: showInputBar ? "var(--accent)" : "var(--line)", color: showInputBar ? "var(--accent)" : "var(--sub)" }}>{showInputBar ? <IconCheck /> : <IconPencil />}{showInputBar ? "저장" : "일정 입력"}</button>
            </div>
          </div>

          {/* 타임테이블 카드 */}
          <div className="card" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", padding: 0, opacity: loading ? 0.5 : 1, transition: "opacity .15s", pointerEvents: loading ? "none" : undefined }}>
            <div ref={viewScrollRef} style={{ flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain" }}>
            {view === "table" ? (
              <div style={{ padding: "0 13px 14px" }}>
                <div style={{ position: "sticky", top: 0, zIndex: 3, background: "var(--card)", padding: "10px 0 4px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: `46px repeat(7,1fr)`, gap: 4 }}>
                    <div />
                    {DAYS.map((d, i) => {
                      const iso = addDays(weekStart, i);
                      const isToday = iso === effToday;
                      return (
                        <div key={d} style={{ textAlign: "center", padding: "3px 0" }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: i === 5 ? "#2563eb" : "var(--faint)" }}>{d}</div>
                          <div style={{ fontSize: 15, fontWeight: isToday ? 800 : 600, fontVariantNumeric: "tabular-nums",
                            color: isToday ? "#fff" : "var(--ink)", background: isToday ? "var(--accent)" : "transparent",
                            borderRadius: 999, width: 26, height: 24, lineHeight: "24px", margin: "1px auto 0" }}>{dayNum(iso)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div ref={gridWrapRef} style={{ position: "relative", display: "grid", gridTemplateColumns: `46px repeat(7,1fr)`, gap: 4 }}>
                  <div style={{ position: "relative", height: SLOTS * rowH }}>
                    {Array.from({ length: (END - START) / 60 + 1 }, (_, i) => START + i * 60).map((m) => (
                      <span key={m} style={{ position: "absolute", right: 6, top: yPx(m, rowH), transform: "translateY(-6px)", fontSize: 12.5, color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>{fmtClock(m)}</span>
                    ))}
                    {isCurrentWeek && nowGridMin != null && (
                      <span style={{ position: "absolute", right: 2, top: nowTop, transform: "translateY(-50%)", fontSize: 10, fontWeight: 800, color: "#fff", background: "var(--accent)", borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
                        {fmtClock(nowGridMin)}
                      </span>
                    )}
                  </div>
                  {DAYS.map((_, d) => {
                    const dayBlocks = layoutDay(weekBlocks.filter((b) => b.day === d));
                    const isToday = addDays(weekStart, d) === effToday;
                    const dh = sched.hours.find((x) => x.day === d + 1);
                    const colH = SLOTS * rowH;
                    const arrTop = dh ? yPx(Math.max(dh.arrive_min, START), rowH) : 0;
                    const lvTop = dh ? yPx(Math.min(dh.leave_min, END), rowH) : colH;
                    return (
                      <div key={d} style={{ position: "relative", height: colH, border: `1px solid ${isToday ? "var(--accent)" : "var(--line)"}`, borderRadius: 9, background: "var(--panel2)", overflow: "hidden" }}>
                        <div style={{ position: "absolute", inset: 0, background: `repeating-linear-gradient(to bottom,rgba(23,26,34,.06) 0 1px,transparent 1px ${rowH * 2}px)`, pointerEvents: "none" }} />
                        {periodsForDay(periods, d).map((p) => {
                          const top = yPx(Math.max(p.start, START), rowH);
                          const height = hPx(Math.max(p.start, START), Math.min(p.end, END), rowH);
                          if (height <= 0) return null;
                          return (
                            <div key={p.id} title={p.label} style={{ position: "absolute", left: 0, right: 0, top, height,
                              background: "var(--accent-soft)", opacity: 0.35, pointerEvents: "none" }} />
                          );
                        })}
                        {/* 등하원 재실 구간 표시 — 등원선 위쪽·하원선 아래쪽(또는 등하원 자체가 없으면 열 전체)을 흐리게 처리. */}
                        {!dh ? (
                          <div style={{ position: "absolute", inset: 0, background: "var(--panel2)", opacity: 0.6, pointerEvents: "none" }} />
                        ) : (
                          <>
                            {arrTop > 0 && <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: arrTop, background: "var(--panel2)", opacity: 0.6, pointerEvents: "none" }} />}
                            {lvTop < colH && <div style={{ position: "absolute", left: 0, right: 0, top: lvTop, bottom: 0, background: "var(--panel2)", opacity: 0.6, pointerEvents: "none" }} />}
                            <div style={{ position: "absolute", left: 0, right: 0, top: arrTop, height: 0, borderTop: "1.5px solid var(--sub)", pointerEvents: "none" }} />
                            <span style={{ position: "absolute", left: 3, top: arrTop, transform: "translateY(2px)", fontSize: 9.5, fontWeight: 700, color: "var(--sub)", whiteSpace: "nowrap", pointerEvents: "none",
                              zIndex: 3, background: "var(--panel2)", borderRadius: 4, padding: "0 3px" }}>
                              {narrowCols ? fmtClock(dh.arrive_min) : `등원 ${fmtClock(dh.arrive_min)}`}
                            </span>
                            <div style={{ position: "absolute", left: 0, right: 0, top: lvTop, height: 0, borderTop: "1.5px solid var(--sub)", pointerEvents: "none" }} />
                            <span style={{ position: "absolute", left: 3, top: lvTop, transform: "translateY(-100%)", fontSize: 9.5, fontWeight: 700, color: "var(--sub)", whiteSpace: "nowrap", pointerEvents: "none",
                              zIndex: 3, background: "var(--panel2)", borderRadius: 4, padding: "0 3px" }}>
                              {narrowCols ? fmtClock(dh.leave_min) : `하원 ${fmtClock(dh.leave_min)}`}
                            </span>
                          </>
                        )}
                        {dayBlocks.map((b) => {
                          const c = blockStyleOf(b.reason);
                          const w = 100 / b.cols;
                          const blockH = hPx(b.start, b.end, rowH) - 3;
                          const showTitle = blockH >= 30;
                          const showTime = blockH >= 50;
                          const isNow = isCurrentWeek && isToday && nowGridMin != null && nowGridMin >= b.start && nowGridMin < b.end;
                          const isSibling = !isNow && !!(b.ruleId && activeRuleId && b.ruleId === activeRuleId);
                          const emph = isNow || isSibling; // 지금 > 형제 강조. 오늘 열 테두리(위 border)는 별도로 항상 유지.
                          const titleAttr = `${b.title} ${fmtClock(b.start)}–${fmtClock(b.end)}`;
                          return (
                            <div key={b.id}
                              title={titleAttr}
                              onClick={(e) => { e.stopPropagation(); setPop({ x: e.clientX, y: e.clientY, block: b }); }}
                              onMouseEnter={() => b.ruleId && setHoverRuleId(b.ruleId)}
                              onMouseLeave={() => setHoverRuleId((cur) => (cur === b.ruleId ? null : cur))}
                              style={{ position: "absolute", left: `calc(${b.col * w}% + 2px)`, width: `calc(${w}% - 4px)`,
                                top: yPx(b.start, rowH), height: blockH, zIndex: isNow ? 4 : 2, boxSizing: "border-box",
                                borderRadius: 7, padding: "4px 6px", overflow: "hidden", lineHeight: 1.4,
                                cursor: "pointer",
                                background: emph ? "var(--accent-soft)" : c.bg,
                                border: `${emph ? 1.5 : 1}px ${b.isExc ? "dashed" : "solid"} ${emph ? "color-mix(in srgb, var(--accent) 65%, transparent)" : c.bd}`,
                                color: c.fg, boxShadow: isNow ? "0 0 0 1px var(--accent), var(--shadow)" : "var(--shadow)" }}>
                              {b.isExc && <span style={{ position: "absolute", top: 1, right: 3, fontSize: 8.5, fontWeight: 800, opacity: 0.75 }}>임시 일정</span>}
                              {isNow && showTitle && <span style={{ position: "absolute", top: 1, left: 4, fontSize: 8.5, fontWeight: 800, color: "#fff", background: "var(--accent)", borderRadius: 3, padding: "0 4px" }}>지금</span>}
                              {showTitle && (
                                <>
                                  <div style={{ paddingRight: b.isExc ? 20 : 0, paddingTop: isNow ? 12 : 0, fontSize: 14.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</div>
                                  {showTime && <div style={{ marginTop: 4, fontSize: 12, fontWeight: 600, opacity: 0.75, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmtClock(b.start)}–{fmtClock(b.end)}</div>}
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                  {isCurrentWeek && nowGridMin != null && (
                    <div style={{ position: "absolute", left: 50, right: 0, top: nowTop, height: 0, borderTop: "1.5px solid var(--accent)", zIndex: 3, pointerEvents: "none" }} />
                  )}
                </div>
              </div>
            ) : (
              <div style={{ padding: "14px 16px 24px" }}>
                <h4 style={{ fontSize: 13, fontWeight: 800, margin: "0 0 8px" }}>등·하원</h4>
                {sched.hours.length === 0 ? (
                  <p style={{ fontSize: 12.5, color: "var(--faint)", margin: "0 0 18px" }}>등록된 등하원 시각이 없습니다.</p>
                ) : (
                  <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 20 }}>
                    <thead>
                      <tr>{["요일", "등원", "하원", ""].map((h) => <th key={h} style={{ ...thtd, background: "var(--panel2)", fontSize: 13, color: "var(--sub)", textAlign: "left" }}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {[...sched.hours].sort((a, b) => a.day - b.day).map((h) => (
                        <tr key={h.day}>
                          <td style={thtd}>{DAYS[h.day - 1]}</td>
                          <td style={{ ...thtd, fontVariantNumeric: "tabular-nums" }}>{fmtClock(h.arrive_min)}</td>
                          <td style={{ ...thtd, fontVariantNumeric: "tabular-nums" }}>{fmtClock(h.leave_min)}</td>
                          <td style={thtd}>
                            <button onClick={() => {
                                const prev = sched;
                                const day = h.day;
                                updateSched((sc) => ({ ...sc, hours: sc.hours.filter((x) => x.day !== day) }));
                                say("삭제했습니다");
                                const fd = new FormData();
                                fd.set("studentId", dsid);
                                fd.set("days", String(day));
                                clearHours(fd).catch((err) => { rollbackSched(prev); say(err instanceof Error ? err.message : "삭제에 실패했습니다"); });
                              }}
                              style={{ ...iconRow, border: "none", background: "transparent", color: "var(--danger)", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}><IconTrash />삭제</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <h4 style={{ fontSize: 13, fontWeight: 800, margin: "0 0 8px" }}>정기 일정</h4>
                {sched.rules.length === 0 ? (
                  <p style={{ fontSize: 12.5, color: "var(--faint)", margin: "0 0 18px" }}>등록된 정기 일정이 없습니다.</p>
                ) : (
                  <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 20 }}>
                    <thead>
                      <tr>{["사유", "제목", "시간", "요일", ""].map((h) => <th key={h} style={{ ...thtd, background: "var(--panel2)", fontSize: 13, color: "var(--sub)", textAlign: "left" }}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {sched.rules.map((r) => {
                        const editing = editRuleId === r.id;
                        const k = blockStyleOf(r.reason);
                        return editing && editDraft ? (
                          <tr key={r.id}>
                            <td style={thtd}><span style={{ ...kchip, background: k.bg, border: `1px solid ${k.bd}`, color: k.fg }}>{r.reason}</span></td>
                            <td style={thtd}><Inp value={editDraft.title} autoFocus onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Escape") setEditRuleId(null); }} style={{ height: 32, fontSize: 12 }} /></td>
                            <td style={thtd}>
                              <div style={{ display: "flex", gap: 4 }}>
                                <Inp style={{ height: 32, width: 62, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }} value={editDraft.startRaw} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setEditDraft({ ...editDraft, startRaw: e.target.value })} />
                                <Inp style={{ height: 32, width: 62, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }} value={editDraft.endRaw} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setEditDraft({ ...editDraft, endRaw: e.target.value })} />
                              </div>
                            </td>
                            <td style={thtd}>
                              <div style={{ display: "flex", gap: 3 }}>
                                {DAYS.map((d, i) => (
                                  <button key={d} onClick={() => setEditDraft({ ...editDraft, days: editDraft.days.includes(i + 1) ? editDraft.days.filter((x) => x !== i + 1) : [...editDraft.days, i + 1] })}
                                    style={{ ...dBtn(editDraft.days.includes(i + 1)), minWidth: 26, padding: 0, height: 28, fontSize: 11 }}>{d}</button>
                                ))}
                              </div>
                            </td>
                            <td style={thtd}>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button className="btn btn-accent" style={{ height: 30, padding: "0 10px", fontSize: 11.5 }}
                                  onClick={() => {
                                    const st = normTime(editDraft.startRaw), e0 = normTime(editDraft.endRaw);
                                    const en = st != null && e0 != null ? normOvernight(st, e0) : e0;
                                    if (!editDraft.title.trim() || !editDraft.days.length || st == null || en == null || en <= st) { say("입력값을 확인하세요"); return; }
                                    const nextTitle = editDraft.title.trim();
                                    const days = [...editDraft.days].sort((a, b) => a - b);
                                    const prev = sched;
                                    updateSched((sc) => ({ ...sc, rules: sc.rules.map((x) => (x.id === r.id ? { ...x, title: nextTitle, start: st, end: en, days } : x)) }));
                                    setEditRuleId(null);
                                    const fd = new FormData();
                                    fd.set("id", r.id);
                                    fd.set("studentId", dsid);
                                    fd.set("reason", r.reason);
                                    fd.set("kind", r.kind);
                                    fd.set("title", nextTitle);
                                    fd.set("start", String(st));
                                    fd.set("end", String(en));
                                    fd.set("days", days.join(","));
                                    upsertRule(fd)
                                      .then((saved) => updateSched((sc) => ({ ...sc, rules: sc.rules.map((x) => (x.id === r.id ? saved : x)) })))
                                      .catch((err) => { rollbackSched(prev); say(err instanceof Error ? err.message : "저장에 실패했습니다"); });
                                  }}>저장</button>
                                <button className="btn" style={{ height: 30, padding: "0 10px", fontSize: 11.5 }} onClick={() => setEditRuleId(null)}>취소</button>
                              </div>
                            </td>
                          </tr>
                        ) : (
                          <tr key={r.id} onClick={() => { setEditRuleId(r.id); setEditDraft({ title: r.title, startRaw: fmt(r.start), endRaw: fmt(r.end), days: [...r.days] }); }} style={{ cursor: "pointer" }}>
                            <td style={thtd}><span style={{ ...kchip, background: k.bg, border: `1px solid ${k.bd}`, color: k.fg }}>{r.reason}</span></td>
                            <td style={{ ...thtd, fontWeight: 700 }}>{dispTitle(r.title, r.reason)}</td>
                            <td style={{ ...thtd, fontVariantNumeric: "tabular-nums" }}>{fmtClock(r.start)}–{fmtClock(r.end)}</td>
                            <td style={thtd}>{r.days.map((d) => DAYS[d - 1]).join("·")}</td>
                            <td style={thtd} onClick={(e) => e.stopPropagation()}>
                              <button onClick={() => {
                                  const prev = sched;
                                  updateSched((sc) => ({ ...sc, rules: sc.rules.filter((x) => x.id !== r.id) }));
                                  say("삭제했습니다");
                                  deleteRule(r.id).catch((err) => { rollbackSched(prev); say(err instanceof Error ? err.message : "삭제에 실패했습니다"); });
                                }}
                                style={{ ...iconRow, border: "none", background: "transparent", color: "var(--danger)", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}><IconTrash />삭제</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                <h4 style={{ fontSize: 13, fontWeight: 800, margin: "0 0 8px" }}>임시 일정</h4>
                {sched.excs.length === 0 ? (
                  <p style={{ fontSize: 12.5, color: "var(--faint)" }}>등록된 임시 일정이 없습니다.</p>
                ) : (
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead>
                      <tr>{["날짜", "사유", "제목", "시간", "대체대상", ""].map((h) => <th key={h} style={{ ...thtd, background: "var(--panel2)", fontSize: 13, color: "var(--sub)", textAlign: "left" }}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {[...sched.excs].sort((a, b) => a.date.localeCompare(b.date)).map((e) => {
                        const k = blockStyleOf(e.reason);
                        const past = e.date < today;
                        const target = e.skipRuleId ? sched.rules.find((r) => r.id === e.skipRuleId) : undefined;
                        return (
                          <tr key={e.id} style={{ opacity: past ? 0.5 : 1 }}>
                            <td style={{ ...thtd, fontVariantNumeric: "tabular-nums" }}>{e.date}</td>
                            <td style={thtd}><span style={{ ...kchip, background: k.bg, border: `1px solid ${k.bd}`, color: k.fg }}>{e.reason}</span></td>
                            <td style={{ ...thtd, fontWeight: 700 }}>{dispTitle(e.title, e.reason)}</td>
                            <td style={{ ...thtd, fontVariantNumeric: "tabular-nums" }}>{fmtClock(e.start)}–{fmtClock(e.end)}</td>
                            <td style={{ ...thtd, color: "var(--faint)" }}>{target ? `${target.title} 대체` : "—"}</td>
                            <td style={thtd}>
                              <button onClick={() => {
                                  const prev = sched;
                                  updateSched((sc) => ({ ...sc, excs: sc.excs.filter((x) => x.id !== e.id) }));
                                  say("삭제했습니다");
                                  deleteException(e.id).catch((err) => { rollbackSched(prev); say(err instanceof Error ? err.message : "삭제에 실패했습니다"); });
                                }}
                                style={{ ...iconRow, border: "none", background: "transparent", color: "var(--danger)", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}><IconTrash />삭제</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            </div>
          </div>

          {/* 입력 카드 — 토글 켰을 때만 타임테이블 카드 아래 별도 카드로 노출. 본문보다 진한 배경으로 편집 영역임을 구분한다. */}
          {showInputBar && (
          <div className="card" style={{ flex: "none", padding: 0, overflow: "hidden", background: "var(--panel2)", borderTop: "2px solid var(--accent)" }}>
            {/* 캡션 행 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 13px", borderBottom: "1px solid var(--line)" }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: "var(--sub)" }}>일정 입력</span>
              <button onClick={() => setShowInputBar(false)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--faint)", fontSize: 12, fontWeight: 600, padding: 2 }}>저장</button>
            </div>

            {/* 벤또형 2구역: 일정 추가(flex:1) + 등·하원 시간(고정 320px) */}
            <div style={{ display: "flex", gap: 12, padding: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              {/* 구역 1: 일정 추가 */}
              <div style={{ flex: "1 1 380px", minWidth: 320, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sub)" }}>일정 추가</span>

                {/* 1줄: 정기/예외 + 사유 + 메모 */}
                <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={field}>
                    <span style={caption}>모드</span>
                    <div style={{ display: "flex", gap: 12, height: 36, alignItems: "center" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--ink)" }}>
                        <input type="radio" name="mode" checked={!excMode} onChange={() => setExcMode(false)} style={{ width: 14, height: 14 }} />
                        정기
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--ink)" }}>
                        <input type="radio" name="mode" checked={excMode} onChange={() => setExcMode(true)} style={{ width: 14, height: 14 }} />
                        임시 일정
                      </label>
                    </div>
                  </div>

                  <div style={field}>
                    <span style={caption}>사유</span>
                    <Sel value={reasonVal} onChange={(e) => setReasonVal(e.target.value)} wrapStyle={{ width: 118, maxWidth: 118 }} style={{ height: 36, fontSize: 13 }}>
                      {REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </Sel>
                  </div>

                  <div style={{ ...field, flex: "1 1 120px", minWidth: 100, maxWidth: 220 }}>
                    <span style={caption}>메모</span>
                    <Inp ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && canAdd) { e.preventDefault(); tryAdd(); } }}
                      placeholder="메모 (선택)" style={{ height: 36, width: "100%", fontSize: 14 }} />
                  </div>
                </div>

                {/* 2줄: 시간 + 요일/날짜 + 추가 */}
                <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={field}>
                    <span style={caption}>시간</span>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <Inp value={startRaw} error={startErr}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => { setStartRaw(e.target.value); setStartErr(false); }}
                        onBlur={(e) => { const raw = e.currentTarget.value; const v = normTime(raw); if (raw && v == null) setStartErr(true); else if (v != null) setStartRaw(fmt(v)); }}
                        onKeyDown={(e) => { if (e.key === "Enter" && canAdd) { e.preventDefault(); tryAdd(); } }}
                        placeholder="" style={{ height: 36, width: 88, maxWidth: 88, fontSize: 15, fontVariantNumeric: "tabular-nums" }} inputMode="numeric" />
                      <span style={{ color: "var(--faint)" }}>–</span>
                      <Inp value={endRaw} error={endErr}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => { setEndRaw(e.target.value); setEndErr(false); }}
                        onBlur={(e) => { const raw = e.currentTarget.value; const v = normTime(raw); if (raw && v == null) setEndErr(true); else if (v != null) setEndRaw(fmt(v)); }}
                        onKeyDown={(e) => { if (e.key === "Enter" && canAdd) { e.preventDefault(); tryAdd(); } }}
                        placeholder="" style={{ height: 36, width: 88, maxWidth: 88, fontSize: 15, fontVariantNumeric: "tabular-nums" }} inputMode="numeric" />
                    </div>
                  </div>

                  <div style={{ ...field, flex: "1 1 180px", minWidth: 160 }}>
                    <span style={caption}>요일</span>
                    {excMode ? (
                      <Inp type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)} style={{ height: 36, width: 150, maxWidth: 150, fontSize: 14 }} />
                    ) : (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {DAYS.map((d, i) => (
                          <button key={d} onClick={() => toggleDay(i + 1)} style={{ ...barDayBtn(selDays.includes(i + 1)), height: 36, minWidth: 36 }}>{d}</button>
                        ))}
                      </div>
                    )}
                  </div>

                  <button disabled={!canAdd} onClick={tryAdd} title={canAdd ? undefined : reasonForTooltip}
                    className="btn btn-accent" style={{ ...iconRow, height: 36, padding: "0 16px", fontSize: 13, fontWeight: 800, opacity: canAdd ? 1 : 0.45, cursor: canAdd ? "pointer" : "not-allowed" }}><IconPlus />추가</button>
                </div>

                <div style={{ fontSize: 11, minHeight: 14 }}>
                  {(startErr || endErr) && <span style={{ color: "var(--danger)" }}>시간 형식을 확인하세요 (예: 9, 1830, 18:30)</span>}
                  {excMode && dateVal && excDayIdx == null && !startErr && !endErr && <span style={{ color: "var(--danger)" }}>날짜를 확인하세요</span>}
                  {!startErr && !endErr && !(excMode && dateVal && excDayIdx == null) && (
                    <span style={{ color: "var(--faint)" }}>숫자키 1~6 으로 요일 토글 · Enter로 추가 · 24시간제(예: 11 → 11:00)</span>
                  )}
                </div>
              </div>

              {/* 구역 2: 등·하원 시간 */}
              <div style={{ flex: "none", width: 320, background: "var(--card)", borderWidth: 1, borderStyle: "solid", borderColor: "var(--line)", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sub)" }}>등·하원 시간</span>

                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {DAYS.map((d, i) => (
                    <button key={d} onClick={() => toggleHoursDay(i + 1)} style={{ ...dBtn(hoursDays.includes(i + 1)), minWidth: 30, height: 32, padding: 0, fontSize: 11 }}>{d}</button>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--faint)", width: 30 }}>등원</span>
                  <Inp ref={arrHRef} value={arrH} error={arrHErr}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, "").slice(-2);
                      setArrH(v); setArrHErr(false); setHoursResult(null);
                      if (v.length === 2) setJumpTo("arrMin");
                    }}
                    onBlur={(e) => {
                      const raw = e.currentTarget.value;
                      if (raw === "") return;
                      const h = +raw;
                      if (h < 0 || h > 23) { setArrHErr(true); return; }
                      setArrH(String(h).padStart(2, "0"));
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") applyHoursNow(); }}
                    inputMode="numeric" maxLength={2}
                    style={{ width: 42, height: 34, fontSize: 15, textAlign: "center", fontVariantNumeric: "tabular-nums" }} />
                  <span style={{ fontSize: 14, color: "var(--sub)" }}>:</span>
                  <Inp ref={arrMRef} value={arrM} error={arrMErr}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, "").slice(-2);
                      setArrM(v); setArrMErr(false); setHoursResult(null);
                    }}
                    onBlur={(e) => {
                      const raw = e.currentTarget.value;
                      if (raw === "") return;
                      const m = +raw;
                      if (m < 0 || m > 59) { setArrMErr(true); return; }
                      setArrM(String(m).padStart(2, "0"));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Backspace" && arrM === "") { e.preventDefault(); arrHRef.current?.focus(); }
                      if (e.key === "Enter") applyHoursNow();
                    }}
                    inputMode="numeric" maxLength={2}
                    style={{ width: 42, height: 34, fontSize: 15, textAlign: "center", fontVariantNumeric: "tabular-nums" }} />
                </div>

                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--faint)", width: 30 }}>하원</span>
                  <Inp ref={lvHRef} value={lvH} error={lvHErr}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, "").slice(-2);
                      setLvH(v); setLvHErr(false); setHoursResult(null);
                      if (v.length === 2) setJumpTo("lvMin");
                    }}
                    onBlur={(e) => {
                      const raw = e.currentTarget.value;
                      if (raw === "") return;
                      const h = +raw;
                      if (h < 0 || h > 23) { setLvHErr(true); return; }
                      setLvH(String(h).padStart(2, "0"));
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") applyHoursNow(); }}
                    inputMode="numeric" maxLength={2}
                    style={{ width: 42, height: 34, fontSize: 15, textAlign: "center", fontVariantNumeric: "tabular-nums" }} />
                  <span style={{ fontSize: 14, color: "var(--sub)" }}>:</span>
                  <Inp ref={lvMRef} value={lvM} error={lvMErr}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, "").slice(-2);
                      setLvM(v); setLvMErr(false); setHoursResult(null);
                    }}
                    onBlur={(e) => {
                      const raw = e.currentTarget.value;
                      if (raw === "") return;
                      const m = +raw;
                      if (m < 0 || m > 59) { setLvMErr(true); return; }
                      setLvM(String(m).padStart(2, "0"));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Backspace" && lvM === "") { e.preventDefault(); lvHRef.current?.focus(); }
                      if (e.key === "Enter") applyHoursNow();
                    }}
                    inputMode="numeric" maxLength={2}
                    style={{ width: 42, height: 34, fontSize: 15, textAlign: "center", fontVariantNumeric: "tabular-nums" }} />
                  <button onClick={applyHoursNow} className="btn btn-accent"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, height: 32, padding: "0 10px", fontSize: 12.5, fontWeight: 700 }}><IconClock />적용</button>
                  <button onClick={clearHoursNow} className="btn"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, height: 32, padding: "0 10px", fontSize: 12.5, fontWeight: 700 }}><IconTrash />해제</button>
                </div>

                {hoursResult && <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--accent)" }}>{hoursResult}</div>}

                <div style={{ fontSize: 12, color: "var(--dim)", lineHeight: 1.4 }}>선택한 요일에 등원~하원 시각을 적용합니다. 다른 일정이 없는 시간은 자습으로 간주됩니다.</div>
              </div>
            </div>
          </div>
          )}
        </>
        )}
        </div>
      </div>

      {/* 겹침 모달 */}
      {conflictModal && (
        <>
          <div onClick={() => setConflictModal(null)} style={{ position: "fixed", inset: 0, background: "rgba(10,12,18,.4)", zIndex: 55 }} />
          <div style={{ position: "fixed", zIndex: 56, left: "50%", top: "50%", transform: "translate(-50%,-50%)", width: 440, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 16, boxShadow: "var(--shadow-lg)", padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>겹치는 일정이 있습니다</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16, maxHeight: 220, overflowY: "auto" }}>
              {conflictModal.conflicts.map((c, i) => {
                const label = `${monNum(c.date)}/${dayNum(c.date)}(${DAYS[c.block.day]})`;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "6px 9px", borderRadius: 8, background: "var(--panel2)" }}>
                    <b style={{ minWidth: 66 }}>{label}</b>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--sub)" }}>{fmtClock(c.block.start)}–{fmtClock(c.block.end)}</span>
                    <span style={{ fontWeight: 700 }}>{c.block.title}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>{c.block.ruleId ? "정기" : "임시"}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {conflictModal.type === "exc" && (
                <button className="btn" disabled={!conflictReplaceTarget} onClick={applyReplace}
                  style={{ flex: 1, height: 42, fontSize: 12.5, opacity: conflictReplaceTarget ? 1 : 0.4 }}>이 날만 대체</button>
              )}
              <button className="btn" onClick={applyOverlap} style={{ flex: 1, height: 42, fontSize: 12.5 }}>겹쳐서 추가</button>
              <button className="btn" onClick={() => setConflictModal(null)} style={{ flex: 1, height: 42, fontSize: 12.5 }}>취소</button>
            </div>
          </div>
        </>
      )}

      {/* 블록 팝오버 */}
      {pop && (() => {
        const reason = popRule?.reason ?? popExc?.reason ?? pop.block.kind;
        const k = blockStyleOf(reason);
        const memo = (popRule?.title ?? popExc?.title ?? "").trim();
        const excDow = popExc ? DAYS[dateToDayIdx(popExc.date, mondayOf(popExc.date)) ?? pop.block.day] : null;
        const daysLabel = popRule ? popRule.days.map((d) => DAYS[d - 1]).join("·") : popExc ? `${popExc.date} (${excDow})` : "";
        return (
          <>
            <div onClick={() => setPop(null)} style={{ position: "fixed", inset: 0, zIndex: 49 }} />
            <div style={{ position: "fixed", zIndex: 50, left: Math.min(pop.x, 1060), top: Math.min(pop.y, 600), background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14, boxShadow: "var(--shadow-lg)", padding: 14, width: 240 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ ...kchip, background: k.bg, border: `1px solid ${k.bd}`, color: k.fg }}>{reason}</span>
                <span style={{ ...kchip, background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--sub)" }}>{pop.block.isExc ? "임시 일정" : "정기"}</span>
              </div>
              {memo && <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)", whiteSpace: "pre-wrap", wordBreak: "break-word", marginBottom: 6 }}>{memo}</div>}
              <div style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--sub)", marginBottom: 4 }}>{fmtClock(pop.block.start)}–{fmtClock(pop.block.end)}</div>
              <div style={{ fontSize: 11.5, color: "var(--faint)", marginBottom: 6 }}>{daysLabel}</div>
              {popReplaceTarget && (
                <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 8 }}>{dispTitle(popReplaceTarget.title, popReplaceTarget.reason)} 대체</div>
              )}
              {popRule && popRule.days.length > 1 && (
                <div style={{ fontSize: 11, color: "var(--faint)", marginBottom: 10 }}>이 정기 일정은 {daysLabel} {popRule.days.length}일에 적용됩니다</div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 4 }}>
                {pop.block.ruleId ? (
                  <>
                    <button onClick={() => deleteThisWeekOnly(pop.block)} style={{ ...kbtn, ...iconRow, width: "100%", height: 36 }}><IconTrash />이번 주만 삭제</button>
                    <button onClick={() => removeRuleDay(pop.block)} style={{ ...kbtn, ...iconRow, width: "100%", height: 36 }}><IconTrash />이 요일만 제거</button>
                    <button onClick={() => deleteBlock(pop.block)} style={{ ...kbtn, ...iconRow, width: "100%", height: 36, color: "var(--danger)", borderColor: "rgba(215,85,144,.4)" }}><IconTrash />정기 일정 전체 삭제</button>
                  </>
                ) : (
                  <button onClick={() => deleteBlock(pop.block)} style={{ ...kbtn, ...iconRow, width: "100%", height: 36, color: "var(--danger)", borderColor: "rgba(215,85,144,.4)" }}><IconTrash />삭제</button>
                )}
              </div>
            </div>
          </>
        );
      })()}

      {toast && (
        <div style={{ position: "fixed", left: "50%", bottom: 26, transform: "translateX(-50%)", zIndex: 60, background: "var(--ink)", color: "#fff", fontSize: 13, fontWeight: 600, borderRadius: 999, padding: "10px 18px", boxShadow: "var(--shadow-lg)" }}>{toast}</div>
      )}
    </div>
  );
}

// ── 운영 시간표 독립 뷰(사이드바에서 진입, 학생 선택과 배타적) ──
// 좌측 편집표(고정폭) / 우측 미리보기(flex)를 같은 카드 안 독립 블록으로 배치하고,
// 미리보기는 학생 타임테이블과 동일한 START/END/rowH 좌표계(yPx/hPx)를 공유한다.
type EditPeriodDraft = { id: string; label: string; startRaw: string; endRaw: string };
function OpsView({
  periods, editPeriod, setEditPeriod, startEditPeriod, savePeriod, addPeriodRow, deletePeriod,
}: {
  periods: Period[];
  editPeriod: EditPeriodDraft | null;
  setEditPeriod: (v: EditPeriodDraft | null) => void;
  startEditPeriod: (p: Period) => void;
  savePeriod: () => void;
  addPeriodRow: () => void;
  deletePeriod: (id: string) => void;
}) {
  // 교시끼리 겹치는지(경고 표시용). 추가 자체는 막지 않는다.
  const overlapIds = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i < periods.length; i++) {
      for (let j = i + 1; j < periods.length; j++) {
        const a = periods[i], b = periods[j];
        if (a.start < b.end && a.end > b.start) { s.add(a.id); s.add(b.id); }
      }
    }
    return s;
  }, [periods]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16, overflow: "hidden", padding: 16 }}>
      {/* 좌측: 편집표(고정 380px) */}
      <div style={{ flex: "none", width: 380, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>{["라벨", "시작", "종료", ""].map((h) => <th key={h} style={{ ...thtd, background: "var(--panel2)", fontSize: 13, color: "var(--sub)", textAlign: "left" }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {periods.map((p) => {
                const editing = editPeriod?.id === p.id;
                const overlapped = overlapIds.has(p.id);
                return editing && editPeriod ? (
                  <tr key={p.id}>
                    <td style={thtd}><Inp value={editPeriod.label} autoFocus onChange={(e) => setEditPeriod({ ...editPeriod, label: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Escape") setEditPeriod(null); }} style={{ height: 32, fontSize: 13, width: 88 }} /></td>
                    <td style={thtd}><Inp style={{ width: 64, height: 32, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }} value={editPeriod.startRaw} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setEditPeriod({ ...editPeriod, startRaw: e.target.value })} /></td>
                    <td style={thtd}><Inp style={{ width: 64, height: 32, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }} value={editPeriod.endRaw} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setEditPeriod({ ...editPeriod, endRaw: e.target.value })} /></td>
                    <td style={thtd}>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="btn btn-accent" style={{ height: 30, padding: "0 10px", fontSize: 12 }} onClick={savePeriod}>저장</button>
                        <button className="btn" style={{ height: 30, padding: "0 10px", fontSize: 12 }} onClick={() => setEditPeriod(null)}>취소</button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id} onClick={() => startEditPeriod(p)} style={{ cursor: "pointer" }}>
                    <td style={{ ...thtd, fontWeight: 700 }}>
                      {p.label}
                      {overlapped && <span title="다른 교시와 시간이 겹칩니다" style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 800, color: "var(--danger)" }}>겹침</span>}
                    </td>
                    <td style={{ ...thtd, fontVariantNumeric: "tabular-nums" }}>{fmt(p.start)}</td>
                    <td style={{ ...thtd, fontVariantNumeric: "tabular-nums" }}>{fmt(p.end)}</td>
                    <td style={thtd} onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => deletePeriod(p.id)} style={{ ...iconRow, border: "none", background: "transparent", color: "var(--danger)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}><IconTrash /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* 표 하단: 행 추가 */}
        <div style={{ flex: "none", display: "flex", gap: 8, paddingTop: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={addPeriodRow} style={{ ...iconRow, height: 34, padding: "0 14px", fontSize: 12.5 }}><IconPlus />행 추가</button>
        </div>
      </div>

      {/* 우측: 타임테이블 미리보기 (07:00~익일 01:00, 학생 타임테이블과 동일 좌표계) */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ flex: "none", fontSize: 12.5, fontWeight: 700, color: "var(--sub)", marginBottom: 8 }}>미리보기</div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "46px 1fr", gap: 4, maxWidth: 520 }}>
            <div style={{ position: "relative", height: SLOTS * ROW }}>
              {Array.from({ length: (END - START) / 60 + 1 }, (_, i) => START + i * 60).map((m) => (
                <span key={m} style={{ position: "absolute", right: 6, top: yPx(m, ROW), transform: "translateY(-6px)", fontSize: 12.5, color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>{fmtClock(m)}</span>
              ))}
            </div>
            <div style={{ position: "relative", height: SLOTS * ROW, border: "1px solid var(--line)", borderRadius: 9, background: "var(--panel2)", overflow: "hidden" }}>
              {/* 30분마다 연한 눈금선, 정시는 조금 진하게 */}
              <div style={{ position: "absolute", inset: 0, background: `repeating-linear-gradient(to bottom,rgba(23,26,34,.09) 0 1px,transparent 1px ${ROW * 2}px), repeating-linear-gradient(to bottom,rgba(23,26,34,.045) 0 1px,transparent 1px ${ROW}px)`, pointerEvents: "none" }} />
              {periods.map((p) => {
                const top = yPx(Math.max(p.start, START), ROW);
                const height = hPx(Math.max(p.start, START), Math.min(p.end, END), ROW);
                if (height <= 0) return null;
                const showText = height >= 22;
                return (
                  <div key={p.id} title={`${p.label} ${fmt(p.start)}–${fmt(p.end)}`} style={{ position: "absolute", top, height, left: 3, right: 3,
                    display: "flex", flexDirection: "column", justifyContent: "center", padding: showText ? "2px 8px" : 0, overflow: "hidden", borderRadius: 5,
                    background: "var(--accent-soft)", border: "1px solid var(--accent)" }}>
                    {showText && (
                      <>
                        <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent)" }}>{p.label}</span>
                        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)", opacity: 0.8, fontVariantNumeric: "tabular-nums" }}>{fmt(p.start)}–{fmt(p.end)}</span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const kchip: React.CSSProperties = { padding: "2px 8px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 };
