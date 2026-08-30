// 학생 상세 화면(/m/student/[id]) 전용 순수 계산 헬퍼.
// page.tsx(서버)에서만 호출한다 — 시각·날짜 문자열은 여기서 최종 표시 포맷까지 끝내서
// StudentDetail.tsx(서버 컴포넌트, 클라 아님)로 내려간다. 이 파일은 DOM·DB 의존 없는 순수 함수만.
import { addDays, weekdayOf, timeLabel, weekStartKey, minuteOfKST, todayKey } from "@/lib/date";
import { PATROL_BY_KEY, PATROL_STATES } from "@/lib/patrol";
import { PENALTY_BY_KEY, PENALTY_REASONS } from "@/lib/penalty";
import { blockStyleOf } from "@/lib/schedule";
import { tint, solid } from "@/lib/semantic-color";

export const RECENT_DAYS = 30;

/** 분(자정 넘김도 그대로 받음, 예: 1500=익일 01:00) → "HH:MM" 랩어라운드 표기. */
export function fmtMin(m: number): string {
  const t = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** "HH:MM" → 자정 이후 경과분(0..1439). */
function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** DB 요일값(1=월..7=일, schedule_hours/schedule_rule 저장 규약) ← date.ts weekdayOf(0=일..6=토) 변환. */
export function dbDayOf(dateKey: string): number {
  const wd = weekdayOf(dateKey);
  return wd === 0 ? 7 : wd;
}

const WD_LABEL = ["일", "월", "화", "수", "목", "금", "토"]; // weekdayOf 인덱스(0=일)용
export const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"]; // DB day(1..7)용

export function weekdayLabel(dateKey: string): string {
  return WD_LABEL[weekdayOf(dateKey)];
}

/** "M/D" 짧은 날짜 라벨. */
export function shortDateLabel(dateKey: string): string {
  const [, m, d] = dateKey.split("-").map(Number);
  return `${m}/${d}`;
}

export type HoursByDay = Record<number, { arrive_min: number; leave_min: number }>;

export function hoursByDayOf(rows: { day: number; arrive_min: number; leave_min: number }[]): HoursByDay {
  const map: HoursByDay = {};
  for (const r of rows) map[r.day] = { arrive_min: r.arrive_min, leave_min: r.leave_min };
  return map;
}

// ================= 공통: 달력 히트맵 =================
// 출결(입실 시각)·순찰(벌점) 두 히트맵이 같은 모양(월~일 7칸, 최근 30일 세로)을 쓰므로
// 뼈대(날짜·요일·오늘·월 구분 라벨)를 여기서 한 번만 만들고, 각 히트맵 빌더는 색(color)·점(dot)·
// title 만 채워 넣는다. 클라 컴포넌트는 이 배열을 그대로 그리기만 한다(날짜 계산 없음).
export type CalendarCell = {
  date: string; dayNum: number; isWeekend: boolean; isToday: boolean;
  monthLabel: string | null; // 그 달 1일 셀에만 채워짐(월 구분선·라벨용) — 그 외 null
  hasData: boolean;
  color: string | null; // hasData=false 면 null(빈 셀 — 옅은 테두리만 그린다)
  dot: string | null;   // 우상단 보조 표시(지각 등) 색. 없으면 null.
  title: string | null; // hasData=false 면 null(빈 셀엔 title 없음)
};
export type CalendarHeatmap = {
  leading: number;       // 첫 주 앞쪽에 넣을 빈 칸 수(요일 정렬용, 월요일=0)
  cells: CalendarCell[]; // 오래된 날짜 → 오늘 순, days 개
  legend: { color: string; label: string }[];
};

type CalendarSkeletonDay = {
  date: string; dayNum: number; isWeekend: boolean; isToday: boolean; monthLabel: string | null;
};

function calendarSkeleton(today: string, days: number): { leading: number; days: CalendarSkeletonDay[] } {
  const start = addDays(today, -(days - 1));
  const leading = dbDayOf(start) - 1; // dbDayOf: 월=1..일=7 → 0..6 빈 칸 수
  const list: CalendarSkeletonDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    list.push({
      date, dayNum: d, isWeekend: isWeekendOf(date), isToday: date === today,
      monthLabel: d === 1 ? `${m}월` : null, // 그 날짜가 그 달의 1일일 때만(진짜 "달이 바뀌는 첫 날")
    });
  }
  return { leading, days: list };
}

/** 분(0..) → "H시간 M분" 표기(히트맵 셀 title 용). */
function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

// ================= A. 출결 이력·패턴 =================
// 막대 시각화 스케일 — 학생 스케쥴러(ScheduleDemo)와 같은 07:00~익일01:00 범위를 공유.
const BAR_START = 7 * 60;
const BAR_END = 25 * 60;
const BAR_RANGE = BAR_END - BAR_START;
export const pct = (min: number) => Math.min(100, Math.max(0, ((min - BAR_START) / BAR_RANGE) * 100));

export type AttendanceDay = {
  date: string; wd: string; short: string;
  firstIn: string | null;  // "HH:MM"
  lastOut: string | null;  // "HH:MM"
  totalMin: number | null; // firstIn~lastOut 경과분(자정 넘김 보정)
  late: boolean;
  lateBy: number | null;   // 분
  scheduled: boolean;      // 그 요일 등하원 설정 존재
  barStartPct: number | null;
  barEndPct: number | null;
  lastOutNote: string | null; // 그 날 마지막 퇴실 이벤트의 사유(퇴실 확인창에서 저장된 attendance_event.note)
};

// attendance_event 원본 행. 쿼리 A 가 이제 day 단위 집계 대신 이벤트별로 그대로 내려준다 —
// 히트맵(재실 구간)엔 이벤트 시각 하나하나가 필요해서다. rows 는 at 오름차순(SQL order by at asc)이어야 한다.
export type AttendanceEventRow = { at: string; kind: string; note: string | null };

/** "세션일"(하루=06:00~익일06:00, KST) 판정 — 예전엔 SQL 의
 * (at at time zone 'Asia/Seoul' - interval 6 hours)::date 가 하던 걸 여기서 재현한다.
 * 06:00 이전 이벤트(자정 넘김 하원 포함)는 전날 세션으로 묶인다. */
function sessionDayOf(at: string): string {
  const raw = minuteOfKST(at);
  const kstDate = todayKey(new Date(at));
  return raw < 360 ? addDays(kstDate, -1) : kstDate; // 360분 = 06:00
}

/** attendance_event 원본 행을 세션일별로 묶는다. 입력이 at 오름차순이면 그룹 내 순서도 그대로 유지된다
 * (buildAttendanceDays 의 첫 입실/마지막 퇴실 탐색과 buildAttendanceHeatmap 의 in→out 짝짓기가 이 순서에 의존). */
function groupBySessionDay(rows: AttendanceEventRow[]): Map<string, AttendanceEventRow[]> {
  const map = new Map<string, AttendanceEventRow[]>();
  for (const r of rows) {
    const day = sessionDayOf(r.at);
    const list = map.get(day);
    if (list) list.push(r); else map.set(day, [r]);
  }
  return map;
}

/** attendance_event 원본 행(세션일별로 여기서 묶음)을 받아 최근 30일 표를 만든다. 날짜 루프는
 * 여기 30번뿐(고정, DB 왕복 아님). */
export function buildAttendanceDays(
  rows: AttendanceEventRow[],
  hoursByDay: HoursByDay,
  today: string,
): AttendanceDay[] {
  const byDate = groupBySessionDay(rows);
  const days: AttendanceDay[] = [];
  for (let i = RECENT_DAYS - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const events = byDate.get(date) ?? [];
    const firstInRow = events.find((e) => e.kind === "in") ?? null;
    let lastOutRow: AttendanceEventRow | null = null;
    for (let j = events.length - 1; j >= 0; j--) {
      if (events[j].kind === "out") { lastOutRow = events[j]; break; }
    }
    const firstIn = firstInRow ? timeLabel(firstInRow.at) : null;
    const lastOut = lastOutRow ? timeLabel(lastOutRow.at) : null;
    let totalMin: number | null = null;
    let barStartPct: number | null = null;
    let barEndPct: number | null = null;
    if (firstIn) {
      const a = parseHHMM(firstIn);
      barStartPct = pct(a);
      if (lastOut) {
        const b0 = parseHHMM(lastOut);
        const b = b0 <= a ? b0 + 1440 : b0; // 자정 넘김
        totalMin = b - a;
        barEndPct = pct(b);
      }
    }
    const hrs = hoursByDay[dbDayOf(date)];
    let late = false;
    let lateBy: number | null = null;
    if (hrs && firstIn) {
      const inMin = parseHHMM(firstIn);
      if (inMin > hrs.arrive_min) { late = true; lateBy = inMin - hrs.arrive_min; }
    }
    days.push({
      date, wd: weekdayLabel(date), short: shortDateLabel(date),
      firstIn, lastOut, totalMin, late, lateBy, scheduled: !!hrs, barStartPct, barEndPct,
      lastOutNote: lastOutRow?.note ?? null,
    });
  }
  return days;
}

// ================= A-2. 출결 히트맵(달력, 입실 시각) =================
/** "M월 D일" 라벨(히트맵 셀 title 용). shortDateLabel("M/D")과 별도로 사람이 읽기 좋은 전체 표기. */
function monthDayLabel(dateKey: string): string {
  const [, m, d] = dateKey.split("-").map(Number);
  return `${m}월 ${d}일`;
}

function isWeekendOf(dateKey: string): boolean {
  const wd = weekdayOf(dateKey);
  return wd === 0 || wd === 6;
}

// 그날 총 재실 시간(첫 입실~마지막 퇴실, buildAttendanceDays.totalMin) → 진하기 5단계.
// 재실 시간이 많을수록 진하게(pct 높음). tint()가 SEMANTIC.present 기준색을 var(--card)에
// pct% 섞어 색을 만든다(하드코딩 헥스 없음).
const STAY_TIERS: { max: number; pct: number; label: string }[] = [
  { max: 2 * 60, pct: 14, label: "~2시간" },
  { max: 5 * 60, pct: 30, label: "2~5시간" },
  { max: 8 * 60, pct: 50, label: "5~8시간" },
  { max: 11 * 60, pct: 72, label: "8~11시간" },
  { max: Infinity, pct: 95, label: "11시간~" },
];
function stayTierOf(min: number) {
  return STAY_TIERS.find((t) => min < t.max) ?? STAY_TIERS[STAY_TIERS.length - 1];
}

/** 최근 30일 입실 시각 달력 히트맵. buildAttendanceDays 가 이미 만든 결과(day 배열, attRows 1회 쿼리분)를
 * 그대로 재사용한다 — 원본 이벤트를 다시 훑거나 DB를 다시 왕복하지 않는다. days 는 오래된 날짜 → 오늘
 * 순(buildAttendanceDays 의 출력 그대로)이라 calendarSkeleton 의 순서와 그대로 맞아떨어진다. */
export function buildAttendanceCalendar(
  days: AttendanceDay[],
  hoursByDay: HoursByDay,
  today: string,
): CalendarHeatmap {
  const skeleton = calendarSkeleton(today, days.length);
  const cells: CalendarCell[] = skeleton.days.map((sk, i) => {
    const d = days[i];
    if (!d || !d.firstIn) {
      return { ...sk, hasData: false, color: null, dot: null, title: null };
    }
    // totalMin 은 lastOut 이 아직 기록 안 된 날(재실 중)엔 null — 그 경우 임시로 0분 취급(최저 단계).
    const tier = stayTierOf(d.totalMin ?? 0);
    const hrs = hoursByDay[dbDayOf(d.date)];
    const scheduleLabel = hrs ? ` · 예정 ${fmtMin(hrs.arrive_min)}` : "";
    const outLabel = d.lastOut ? `하원 ${d.lastOut}` : "하원 미기록";
    const durLabel = d.totalMin != null ? ` · 재실 ${fmtDuration(d.totalMin)}` : "";
    return {
      ...sk, hasData: true, color: tint("present", tier.pct),
      dot: d.late ? solid("late") : null, // 스케쥴 있는 날만 late 가 true(buildAttendanceDays 규칙 그대로). semantic-color.ts 의 late 기준색.
      title: `${monthDayLabel(d.date)} · 입실 ${d.firstIn} · ${outLabel}${durLabel}${scheduleLabel}`,
    };
  });
  const legend = STAY_TIERS.map((t) => ({ color: tint("present", t.pct), label: t.label }));
  return { leading: skeleton.leading, cells, legend };
}

export type AttendanceSummary = {
  attendedDays: number;
  avgIn: string | null;
  avgOut: string | null;
  lateCount: number;
  hasSchedule: boolean; // 등하원 설정 자체가 하나라도 있는지(없으면 지각 비교 전체 생략)
};

export function summarizeAttendance(days: AttendanceDay[], hasSchedule: boolean): AttendanceSummary {
  const withIn = days.filter((d) => d.firstIn);
  const withOut = days.filter((d) => d.lastOut);
  const avgOf = (list: AttendanceDay[], pick: (d: AttendanceDay) => string | null) => {
    if (!list.length) return null;
    const mins = list.map((d) => parseHHMM(pick(d)!));
    return fmtMin(Math.round(mins.reduce((a, b) => a + b, 0) / mins.length));
  };
  return {
    attendedDays: withIn.length,
    avgIn: avgOf(withIn, (d) => d.firstIn),
    avgOut: avgOf(withOut, (d) => d.lastOut),
    lateCount: hasSchedule ? days.filter((d) => d.late).length : 0,
    hasSchedule,
  };
}

// ================= B. 순찰 기록 =================
export type PatrolRow = { date: string; at: string; state: string; points: number; note: string | null; hour: number };
export type PatrolListItem = { date: string; time: string; label: string; dot: string; points: number; note: string | null };

// 이 화면(학생 인사이트)의 "위반" 판정 단일 기준 — 점수(points)가 0보다 큰 순찰 기록만 위반으로 센다.
// 입석·학원·원내 수업·주간 상담(points=0)은 위반이 아니다(lib/patrol.ts PATROL_STATES 정의 그대로).
// 순찰 히트맵(buildPatrolCalendar)·시간대 이벤트 합산(combinePointEvents) 양쪽이 이 함수 하나만 참조한다.
export function isPatrolViolation(row: Pick<PatrolRow, "points">): boolean {
  return row.points > 0;
}

export function buildPatrolList(rows: PatrolRow[]): PatrolListItem[] {
  return rows.map((r) => {
    const cfg = PATROL_BY_KEY[r.state];
    return {
      date: shortDateLabel(r.date), time: timeLabel(r.at),
      label: cfg?.label ?? r.state, dot: cfg?.dot ?? "var(--faint)",
      points: r.points, note: r.note,
    };
  });
}

export type PatrolStateCount = { key: string; label: string; dot: string; count: number };
export function patrolStateCounts(rows: PatrolRow[]): PatrolStateCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  return PATROL_STATES
    .filter((st) => counts.has(st.key))
    .map((st) => ({ key: st.key, label: st.label, dot: st.dot, count: counts.get(st.key)! }))
    .sort((a, b) => b.count - a.count);
}

// 자리 문제(수면·딴짓·자리비움)가 잦은 시간대 히스토그램. 07~익일02시(순찰 활동 범위)를 1시간 단위로.
const PROBLEM_STATES = new Set(["sleep", "distract", "away"]);
export type HourBucket = { label: string; count: number };
export function problemHourHistogram(rows: PatrolRow[]): HourBucket[] {
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (!PROBLEM_STATES.has(r.state)) continue;
    const h = r.hour < 6 ? r.hour + 24 : r.hour; // 새벽 0~5시는 전날 연장으로 취급
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const buckets: HourBucket[] = [];
  for (let h = 7; h <= 26; h++) buckets.push({ label: `${h % 24}시`, count: counts.get(h) ?? 0 });
  return buckets;
}

// ================= B-2. 순찰 히트맵(달력, 학습 태도) =================
// 그 날 위반 횟수(isPatrolViolation 기준) → 진하기 5단계. 0건(순찰은 있었지만 위반 없음 — 예: 입석만
// 찍힌 날)만 무채색(panel2), 나머지는 distract 기준색(danger 계열)을 tint() 로 섞어 진하기를 낸다.
// 점수는 보조 정보로 title 에만 남긴다.
const PATROL_VIOLATION_TIERS: { max: number; pct: number; label: string }[] = [
  { max: 0, pct: 0, label: "0건" },
  { max: 1, pct: 32, label: "1건" },
  { max: 2, pct: 56, label: "2건" },
  { max: 4, pct: 80, label: "3~4건" },
  { max: Infinity, pct: 100, label: "5건~" },
];
function patrolViolationTierOf(count: number) {
  if (count <= 0) return PATROL_VIOLATION_TIERS[0];
  return PATROL_VIOLATION_TIERS.find((t) => count <= t.max) ?? PATROL_VIOLATION_TIERS[PATROL_VIOLATION_TIERS.length - 1];
}
function patrolViolationTierColor(count: number): string {
  const tier = patrolViolationTierOf(count);
  return tier.pct === 0 ? "var(--panel2)" : tint("distract", tier.pct);
}

/** 최근 30일 순찰 달력 히트맵. patrolRows(page.tsx 가 이미 쿼리해 온 원본, RECENT_DAYS 만큼)를
 * 재사용한다 — 추가 쿼리 없음. 순찰 기록 자체가 없는 날은 hasData=false(빈 셀), 순찰은 있었으나
 * 위반이 0건인 날(입석·학원·원내 수업·주간 상담만)은 hasData=true·무채색으로 서로 구분한다.
 * 셀 진하기는 위반 횟수 기준 — 벌점 합계는 title 에만 보조로 남긴다. */
export function buildPatrolCalendar(rows: PatrolRow[], today: string): CalendarHeatmap {
  const skeleton = calendarSkeleton(today, RECENT_DAYS);
  const byDate = new Map<string, PatrolRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.date);
    if (list) list.push(r); else byDate.set(r.date, [r]);
  }
  const cells: CalendarCell[] = skeleton.days.map((sk) => {
    const list = byDate.get(sk.date);
    if (!list || list.length === 0) {
      return { ...sk, hasData: false, color: null, dot: null, title: null };
    }
    const violationCount = list.filter(isPatrolViolation).length;
    const points = list.reduce((a, r) => a + r.points, 0);
    const counts = new Map<string, number>();
    for (const r of list) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
    const breakdown = PATROL_STATES
      .filter((st) => st.points > 0 && counts.has(st.key))
      .map((st) => `${st.label} ${counts.get(st.key)}`)
      .join(" · ");
    return {
      ...sk, hasData: true, color: patrolViolationTierColor(violationCount), dot: null,
      title: `${monthDayLabel(sk.date)} · 순찰 ${list.length}회 · 위반 ${violationCount}건${breakdown ? ` · ${breakdown}` : ""} · 벌점 ${points}점`,
    };
  });
  const legend = PATROL_VIOLATION_TIERS.map((t) => ({ color: t.pct === 0 ? "var(--panel2)" : tint("distract", t.pct), label: t.label }));
  return { leading: skeleton.leading, cells, legend };
}

// ================= C. 벌점 내역·추이 =================
// 이 원은 벌점을 주 단위(월요일 시작)로 운영한다. m/penalty 대시보드와 같은 원칙으로 순찰(patrol_event,
// points>0 인 것만)과 수동(penalty_event) 두 출처를 합쳐야 실제 "벌점" 숫자가 된다.
export type PenaltyRow = { date: string; at: string; reason: string; points: number; note: string | null };

export type ReasonTotal = { key: string; label: string; points: number };
function byReason(rows: PenaltyRow[]): ReasonTotal[] {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.reason, (sums.get(r.reason) ?? 0) + r.points);
  return PENALTY_REASONS
    .filter((p) => sums.has(p.key))
    .map((p) => ({ key: p.key, label: p.label, points: sums.get(p.key)! }))
    .sort((a, b) => b.points - a.points);
}

export type PenaltySummary = {
  total30: number; totalMonth: number;
  byReason30: ReasonTotal[]; byReasonMonth: ReasonTotal[];
};

export function summarizePenalty(rows: PenaltyRow[], today: string): PenaltySummary {
  const monthPrefix = today.slice(0, 7); // "YYYY-MM"
  const thisMonth = rows.filter((r) => r.date.startsWith(monthPrefix));
  return {
    total30: rows.reduce((a, r) => a + r.points, 0),
    totalMonth: thisMonth.reduce((a, r) => a + r.points, 0),
    byReason30: byReason(rows),
    byReasonMonth: byReason(thisMonth),
  };
}

// 순찰(points>0 인 것만) + 수동 벌점을 한 이벤트 축으로 합친다. label 은 사람이 읽는 사유 문구
// (순찰 상태·벌점 사유 라벨 그대로) — "지각"처럼 두 출처에 같은 문구가 있으면 같은 사유로 자연스럽게
// 합산된다(관리자 화면처럼 출처를 접두어로 구분하지 않음 — 이 카드는 "무엇 때문에" 관점).
export type PointEvent = { date: string; at: string; hour: number; points: number; label: string; note: string | null; dot: string };

export function combinePointEvents(patrolRows: PatrolRow[], penaltyRows: PenaltyRow[]): PointEvent[] {
  const events: PointEvent[] = [];
  for (const r of patrolRows) {
    if (!isPatrolViolation(r)) continue; // 위반 아닌 순찰(입석 등, points=0)은 제외
    const cfg = PATROL_BY_KEY[r.state];
    events.push({ date: r.date, at: r.at, hour: r.hour, points: r.points, label: cfg?.label ?? r.state, note: r.note, dot: cfg?.dot ?? solid("distract") });
  }
  for (const r of penaltyRows) {
    const cfg = PENALTY_BY_KEY[r.reason];
    // patrolRows.hour 는 SQL 에서 이미 KST 시간대로 뽑아왔다(쿼리 재사용) — 수동 벌점은 at 을 여기서
    // minuteOfKST 로 변환해 같은 좌표계(0..23)를 맞춘다(서버가 UTC 이므로 클라 변환 없이 여기서 끝낸다).
    events.push({ date: r.date, at: r.at, hour: Math.floor(minuteOfKST(r.at) / 60), points: r.points, label: cfg?.label ?? r.reason, note: r.note, dot: solid("distract") });
  }
  return events;
}

// ---- C-1. 주간 헤더: 이번 주 누적 + 지난주 대비 ----
// 주 지표는 위반 "건수"(thisWeekCount) — 점수(thisWeekPoints)는 보조로만 남긴다. diffLabel 도
// 건수 기준으로 문구를 만든다.
export type PenaltyWeekSummary = { thisWeekCount: number; thisWeekPoints: number; diffLabel: string };

/** weekStartKey 는 Date 를 받으므로 항상 "정오 UTC"로 만든 날짜만 넘긴다(무인자 new Date() 금지 원칙 —
 * 서버 UTC 와 KST 날짜가 어긋나는 걸 방지). events 는 이미 30일 컷오프가 걸린 쿼리 결과라 이번 주·
 * 지난주(최대 14일) 를 덮기에 충분하다 — 추가 쿼리 없음. events 자체가 combinePointEvents 에서 이미
 * isPatrolViolation(points>0) 기준으로 걸러진 위반만이라 여기선 개수만 세면 된다. */
export function buildPenaltyWeekSummary(events: PointEvent[], today: string): PenaltyWeekSummary {
  const noon = (dateKey: string) => new Date(`${dateKey}T12:00:00Z`);
  const thisWeekStart = weekStartKey(noon(today));
  const thisWeekEnd = addDays(thisWeekStart, 6);
  const lastWeekStart = addDays(thisWeekStart, -7);
  const lastWeekEnd = addDays(thisWeekStart, -1);
  let thisWeekCount = 0;
  let thisWeekPoints = 0;
  let lastWeekCount = 0;
  for (const e of events) {
    if (e.date >= thisWeekStart && e.date <= thisWeekEnd) { thisWeekCount += 1; thisWeekPoints += e.points; }
    else if (e.date >= lastWeekStart && e.date <= lastWeekEnd) { lastWeekCount += 1; }
  }
  const diff = thisWeekCount - lastWeekCount;
  const diffLabel = diff === 0 ? "지난주와 동일" : diff > 0 ? `지난주보다 ${diff}건 많음` : `지난주보다 ${-diff}건 적음`;
  return { thisWeekCount, thisWeekPoints, diffLabel };
}

// ---- C-2. 시간대별 누적(최근 4주, 07~24시 1시간 단위) ----
const PENALTY_HOUR_START = 7;
const PENALTY_HOUR_END = 23; // 07~24시(반개구간) 요구사항 그대로 — 자정 넘김 새벽 시간대는 이 그래프 범위 밖(운영 시간 위주 판독용)
const PENALTY_HOUR_WEEKS = 4;

// count = 그 시간대 위반 건수(주 지표) — points 는 벌점 합계(보조). events 는 이미 위반만(points>0) 걸러진
// 값이라 건수는 그냥 이벤트 수를 세면 된다.
export type PenaltyHourBucket = { hour: number; label: string; count: number; points: number; title: string };
export type PenaltyHourly = { buckets: PenaltyHourBucket[]; hasData: boolean; peakLabel: string | null };

export function buildPenaltyHourly(events: PointEvent[], today: string): PenaltyHourly {
  const windowStart = addDays(today, -(PENALTY_HOUR_WEEKS * 7 - 1));
  const counts = new Map<number, number>();
  const points = new Map<number, number>();
  const breakdown = new Map<number, Map<string, number>>();
  for (const e of events) {
    if (e.date < windowStart || e.date > today) continue;
    if (e.hour < PENALTY_HOUR_START || e.hour > PENALTY_HOUR_END) continue;
    counts.set(e.hour, (counts.get(e.hour) ?? 0) + 1);
    points.set(e.hour, (points.get(e.hour) ?? 0) + e.points);
    const m = breakdown.get(e.hour) ?? new Map<string, number>();
    m.set(e.label, (m.get(e.label) ?? 0) + 1);
    breakdown.set(e.hour, m);
  }
  let peakHour: number | null = null;
  let peakCount = 0;
  const buckets: PenaltyHourBucket[] = [];
  for (let h = PENALTY_HOUR_START; h <= PENALTY_HOUR_END; h++) {
    const count = counts.get(h) ?? 0;
    const pts = points.get(h) ?? 0;
    if (count > peakCount) { peakCount = count; peakHour = h; }
    const parts = Array.from(breakdown.get(h) ?? new Map<string, number>())
      .sort((a, b) => b[1] - a[1])
      .map(([label, cnt]) => `${label} ${cnt}`);
    const title = `${h}시 · 위반 ${count}건${parts.length ? ` · ${parts.join(" · ")}` : ""}${pts > 0 ? ` · (벌점 ${pts}점)` : ""}`;
    buckets.push({ hour: h, label: `${h}시`, count, points: pts, title });
  }
  const hasData = peakCount > 0;
  return { buckets, hasData, peakLabel: hasData && peakHour != null ? `${peakHour}시대에 가장 많음` : null };
}

// ---- C-3. 사유별 집계(그래프 아래 가로 막대 목록) ----
// count = 그 사유로 찍힌 위반 건수(순찰+수동 벌점 합산) — 정렬·비율 바 모두 이 건수 기준.
// points 는 "10회 · 20점"처럼 건수 뒤에 보조로만 병기한다. 새 쿼리 없이 이미 combinePointEvents 가
// 만든 events(위반만, points>0)를 그대로 다시 훑어서 집계한다.
export type PenaltyReasonBar = { label: string; points: number; count: number; pct: number };
export function buildPenaltyReasonBars(events: PointEvent[]): PenaltyReasonBar[] {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const e of events) {
    sums.set(e.label, (sums.get(e.label) ?? 0) + e.points);
    counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
  }
  const list = Array.from(counts, ([label, count]) => ({ label, count, points: sums.get(label) ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  const max = list.length ? list[0].count : 1;
  return list.map((r) => ({ ...r, pct: Math.round((r.count / max) * 100) }));
}

// ---- C-4. 최근 내역(최근 10건만) ----
export type PenaltyRecentItem = { date: string; time: string; label: string; points: number; note: string | null; dot: string };
export function buildPenaltyRecent(events: PointEvent[]): PenaltyRecentItem[] {
  return events
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, 10)
    .map((e) => ({ date: shortDateLabel(e.date), time: timeLabel(e.at), label: e.label, points: e.points, note: e.note, dot: e.dot }));
}

// ================= D. 통계 신뢰도(카드 제목 옆 물음표 배지) =================
// 집계 원자료(attendanceDays·patrolRows)에 결손·이상치가 있으면 그 카드의 숫자를 곧이곧대로 읽으면 안
// 된다 — 새 쿼리 없이 이미 계산된 attendanceDays(A절)와 이미 쿼리된 patrolRows(B절)만 다시 훑어서
// 판정한다. 카드별로 원인이 다르므로 세 그룹으로 나눈다(StudentDetail.tsx 가 그룹별로 관련 카드에만
// 붙인다): 출결(하원 미기록·비정상 재실·비정상 입실) / 지각(스케쥴 미설정) / 순찰(순찰 공백).
// 각 배열은 "문제 있는 항목 문구" 리스트 — 비어 있으면 그 카드는 깨끗하다(물음표 자체를 그리지 않음).
export type ReliabilityFlags = {
  attendance: string[]; // 출결 카드 · 평균 등원 · 등원일 지표
  late: string[];       // 지각 지표
  patrol: string[];     // 순찰 카드 · 이번 주 위반 지표 · 위반 집중 시간대 · 사유 카드
};

const STAY_MAX_MIN = 16 * 60; // 재실 16시간 초과
const STAY_MIN_MIN = 10;      // 재실 10분 미만
const PATROL_MIN_DAYS = 3;    // 순찰 기록이 이 일수 미만이면 근거 빈약

export function buildReliabilityFlags(
  attendanceDays: AttendanceDay[],
  patrolRows: PatrolRow[],
  hasSchedule: boolean,
): ReliabilityFlags {
  let noOutDays = 0, longStayDays = 0, shortStayDays = 0, earlyInDays = 0;
  for (const d of attendanceDays) {
    if (!d.firstIn) continue; // 그날 등원 자체가 없으면 결손 판정 대상이 아님
    if (d.firstIn < "05:00") earlyInDays += 1;
    if (!d.lastOut) { noOutDays += 1; continue; } // 하원 미기록인 날은 재실시간 판정 대상 밖(totalMin=null)
    if (d.totalMin != null) {
      if (d.totalMin > STAY_MAX_MIN) longStayDays += 1;
      else if (d.totalMin < STAY_MIN_MIN) shortStayDays += 1;
    }
  }
  const attendance: string[] = [];
  if (noOutDays > 0) attendance.push(`하원 미기록 ${noOutDays}일`);
  if (longStayDays > 0) attendance.push(`재실 16시간 초과 ${longStayDays}일`);
  if (shortStayDays > 0) attendance.push(`재실 10분 미만 ${shortStayDays}일`);
  if (earlyInDays > 0) attendance.push(`입실 05시 이전 ${earlyInDays}일`);

  const late: string[] = [];
  if (!hasSchedule) late.push("등하원 스케쥴 미설정");

  const patrolDayCount = new Set(patrolRows.map((r) => r.date)).size;
  const patrol: string[] = [];
  if (patrolDayCount < PATROL_MIN_DAYS) {
    patrol.push(patrolDayCount === 0 ? "순찰 기록 없음" : `순찰 기록 ${patrolDayCount}일뿐`);
  }

  return { attendance, late, patrol };
}

/** 물음표 배지 title 툴팁 — 항목을 줄바꿈으로 나열하고 마지막 줄에 안내 문구를 덧붙인다.
 * issues 가 비어 있으면 null(호출부가 배지 자체를 그리지 않아야 함을 알리는 신호). */
export function reliabilityTooltip(issues: string[]): string | null {
  if (issues.length === 0) return null;
  return [...issues, "일부 통계가 실제와 다를 수 있습니다"].join("\n");
}

// ================= E. 스케쥴 요약(미니어처) =================
export type RuleRow = { id: string; reason: string; kind: string; title: string; start_min: number; end_min: number; days: string };
export type ExceptionRow = { id: string; reason: string; title: string; start_min: number; end_min: number; date: string; skip_rule_id: string | null };

export type MiniBlock = { id: string; top: number; height: number; bg: string; bd: string; dashed: boolean; title: string };
export type MiniDay = { day: number; label: string; hasHours: boolean; arrivePct: number | null; leavePct: number | null; blocks: MiniBlock[] };
export type ScheduleMiniature = { days: MiniDay[]; summaryLine: string };

/** 요일별 등·하원 시각을 표 대신 한 줄로 요약한다. 같은 (등원,하원) 조합이 연속된 요일은 묶고
 * (월~금이 전부 같으면 "평일"), 미설정 요일도 같은 방식으로 묶어 "토 미설정"처럼 표기한다. */
function scheduleSummaryLine(hoursByDay: HoursByDay): string {
  type Seg = { key: string; days: number[] };
  const keyOf = (d: number) => {
    const h = hoursByDay[d];
    return h ? `${h.arrive_min}-${h.leave_min}` : "none";
  };
  const segs: Seg[] = [];
  for (let d = 1; d <= 7; d++) {
    const k = keyOf(d);
    const last = segs[segs.length - 1];
    if (last && last.key === k) last.days.push(d);
    else segs.push({ key: k, days: [d] });
  }
  const rangeLabel = (days: number[]): string => {
    if (days.length === 1) return DAY_LABELS[days[0] - 1];
    const consecutive = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
    if (consecutive && days[0] === 1 && days[days.length - 1] === 5) return "평일";
    if (consecutive) return `${DAY_LABELS[days[0] - 1]}~${DAY_LABELS[days[days.length - 1] - 1]}`;
    return days.map((d) => DAY_LABELS[d - 1]).join("·");
  };
  return segs
    .map((seg) => {
      const label = rangeLabel(seg.days);
      if (seg.key === "none") return `${label} 미설정`;
      const [arrive, leave] = seg.key.split("-").map(Number);
      return `${label} ${fmtMin(arrive)} 등원 · ${fmtMin(leave)} 하원`;
    })
    .join(", ");
}

/** 이번 주(월~일) 스케쥴 미니어처 — 정기 규칙(schedule_rule) + 이번 주 임시 일정(schedule_exception)을
 * 07:00~익일01:00 세로축(pct, A절 attendance 막대와 같은 스케일) 위 블록으로 배치한다. 색은 스케쥴러
 * 화면과 같은 blockStyleOf(사유 팔레트)를 그대로 쓴다 — 여기서 새 헥스 색을 만들지 않는다.
 * skip_rule_id 로 그 날의 정기 규칙을 대체하는 임시 일정이 있으면 그 요일의 정기 블록은 뺀다. */
export function buildScheduleMiniature(
  rules: RuleRow[],
  exceptions: ExceptionRow[],
  hoursByDay: HoursByDay,
  today: string,
): ScheduleMiniature {
  const thisWeekStart = weekStartKey(new Date(`${today}T12:00:00Z`));
  const dateOfDay = (d: number) => addDays(thisWeekStart, d - 1); // d: 1=월..7=일

  const suppressed = new Set<string>(); // `${ruleId}:${day}`
  for (const ex of exceptions) {
    if (!ex.skip_rule_id) continue;
    suppressed.add(`${ex.skip_rule_id}:${dbDayOf(ex.date)}`);
  }

  const days: MiniDay[] = [];
  for (let d = 1; d <= 7; d++) {
    const hrs = hoursByDay[d];
    const arrivePct = hrs ? pct(hrs.arrive_min) : null;
    const leavePct = hrs ? pct(hrs.leave_min) : null;
    const dayDate = dateOfDay(d);
    const wd = weekdayLabel(dayDate);
    const blocks: MiniBlock[] = [];

    for (const r of rules) {
      const ruleDays = r.days ? r.days.split(",").map(Number) : [];
      if (!ruleDays.includes(d) || suppressed.has(`${r.id}:${d}`)) continue;
      const style = blockStyleOf(r.reason);
      const top = pct(r.start_min);
      blocks.push({
        id: `rule-${r.id}-${d}`, top, height: Math.max(1.5, pct(r.end_min) - top),
        bg: style.bg, bd: style.bd, dashed: false,
        title: `${wd} · ${r.reason} · ${fmtMin(r.start_min)}–${fmtMin(r.end_min)} · 정기`,
      });
    }

    for (const ex of exceptions) {
      if (ex.date !== dayDate) continue;
      const style = blockStyleOf(ex.reason);
      const top = pct(ex.start_min);
      blocks.push({
        id: `exc-${ex.id}`, top, height: Math.max(1.5, pct(ex.end_min) - top),
        bg: style.bg, bd: style.bd, dashed: true,
        title: `${wd} · ${ex.reason} · ${fmtMin(ex.start_min)}–${fmtMin(ex.end_min)} · ${monthDayLabel(dayDate)} 임시`,
      });
    }

    days.push({ day: d, label: DAY_LABELS[d - 1], hasHours: !!hrs, arrivePct, leavePct, blocks });
  }

  return { days, summaryLine: scheduleSummaryLine(hoursByDay) };
}
