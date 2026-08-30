// 학생 상세 화면 본문 — "벤또 대시보드": 12열 그리드에 헤더 1 + 지표 4 + 출결·순찰·시간표 3 +
// 사유 1 + 벌점 시간대 1(막대 그래프), 총 10개 카드를 빈 칸 없이 채운다. 서버 컴포넌트("use client"
// 아님): page.tsx 가 시각·날짜·라벨까지 전부 포맷해 내려주므로 여기선 그대로 렌더만 한다(하이드레이션
// 미스매치 원천 차단). 데이터 조회·집계는 전부 util.ts/page.tsx 그대로 — 이 파일은 표현(레이아웃·
// 타이포·색)만.
//
// 서술형 텍스트(한 줄 요약·안내 문장·축 설명문)는 전부 제거하고 숫자·라벨·범례만 남긴다 — 지운 정보는
// 없어지지 않고 해당 시각화 요소의 title 툴팁으로 옮겼다(각 카드 제목 span 의 title, 달력 셀의 title,
// 막대·범례 점의 title). 달력 셀 크기는 직접 캡하지 않고 카드 폭(sd-att/sd-patrol span)으로만
// 조절한다. 폭 1100px 아래는 2열, 700px 아래는 1열로 카드 span 이 자연스럽게 무너진다.
import { solid, type SemanticKey } from "@/lib/semantic-color";
import { DAY_LABELS } from "./util";
import type {
  AttendanceDay, AttendanceSummary, CalendarHeatmap, PatrolStateCount,
  PenaltyWeekSummary, PenaltyHourly, PenaltyReasonBar,
  ScheduleMiniature, MiniDay,
} from "./util";

// ================= 벤또 그리드(12열) + 반응형 span =================
const BENTO_CSS = `
.sd-bento{display:grid;grid-template-columns:repeat(12,1fr);gap:10px;}
.sd-header{grid-column:span 12;}
.sd-stat{grid-column:span 3;}
.sd-att{grid-column:span 4;}
.sd-patrol{grid-column:span 4;}
.sd-sched{grid-column:span 4;}
.sd-reason{grid-column:span 4;}
.sd-pen{grid-column:span 8;}
@media (max-width:1100px){
  .sd-bento{grid-template-columns:repeat(2,1fr);}
  .sd-header,.sd-att,.sd-patrol,.sd-sched,.sd-reason,.sd-pen{grid-column:span 2;}
  .sd-stat{grid-column:span 1;}
}
@media (max-width:700px){
  .sd-bento{grid-template-columns:1fr;}
  .sd-header,.sd-stat,.sd-att,.sd-patrol,.sd-sched,.sd-reason,.sd-pen{grid-column:span 1;}
}
`;

const CARD: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 14px", minWidth: 0, display: "flex", flexDirection: "column" };
const CARD_TITLE: React.CSSProperties = { fontSize: 11.5, color: "var(--dim)", fontWeight: 700, marginBottom: 8, lineHeight: 1, cursor: "default" };
// 카드 제목 옆 집계 기간 라벨(예: "30일" · "4주 누적" · "이번 주") — 서술형 문장 없이 짧게.
const CARD_TITLE_ROW: React.CSSProperties = { ...CARD_TITLE, display: "flex", alignItems: "baseline", gap: 5 };
const PERIOD_LABEL: React.CSSProperties = { fontSize: 11, color: "var(--faint)", fontWeight: 500 };
const STAT_LABEL: React.CSSProperties = { fontSize: 10.5, color: "var(--faint)", fontWeight: 700 };
const STAT_VALUE: React.CSSProperties = { fontSize: 23, fontWeight: 800, marginTop: 4, fontVariantNumeric: "tabular-nums" };
const STAT_SUB: React.CSSProperties = { fontSize: 10.5, color: "var(--dim)", marginTop: 2, fontVariantNumeric: "tabular-nums" };
const EMPTY: React.CSSProperties = { color: "var(--faint)", fontSize: 12.5, padding: "10px 2px", textAlign: "center", margin: "auto 0" };

type StudentHead = { id: string; name: string; seatLabel: string; statusLabel: string; isLeave: boolean };

// 통계 신뢰도 배지 — page.tsx(buildReliabilityFlags + reliabilityTooltip)가 이미 완성한 title 문자열을
// 그대로 받는다(계산 없음, 이 파일은 표현만). null 이면 그 카드는 깨끗함(문제 없음).
export type ReliabilityInfo = { attendance: string | null; late: string | null; patrol: string | null };

export default function StudentDetail({
  student, attendanceDays, attendanceSummary, attendanceHeatmap,
  patrolCounts, patrolHeatmap, patrolTotal,
  penaltyWeek, penaltyHourly, penaltyReasonBars, penaltyTotal30,
  scheduleMiniature, ruleCount, hasSchedule, canEditSchedule, reliability,
}: {
  student: StudentHead;
  attendanceDays: AttendanceDay[];
  attendanceSummary: AttendanceSummary;
  attendanceHeatmap: CalendarHeatmap;
  patrolCounts: PatrolStateCount[];
  patrolHeatmap: CalendarHeatmap;
  patrolTotal: number;
  penaltyWeek: PenaltyWeekSummary;
  penaltyHourly: PenaltyHourly;
  penaltyReasonBars: PenaltyReasonBar[];
  penaltyTotal30: number;
  scheduleMiniature: ScheduleMiniature;
  ruleCount: number;
  hasSchedule: boolean;
  canEditSchedule: boolean;
  reliability: ReliabilityInfo;
}) {
  return (
    <div>
      <style>{BENTO_CSS}</style>
      <div className="sd-bento">
        <HeaderCard student={student} canEditSchedule={canEditSchedule} />

        <StatCard label="등원일" value={`${attendanceSummary.attendedDays}일`} reliabilityTip={reliability.attendance} />
        <StatCard label="평균 등원 시각" value={attendanceSummary.avgIn ?? "—"} reliabilityTip={reliability.attendance} />
        <StatCard
          label="지각"
          value={attendanceSummary.hasSchedule ? `${attendanceSummary.lateCount}회` : "미설정"}
          dim={!attendanceSummary.hasSchedule}
          reliabilityTip={reliability.late}
        />
        <StatCard
          label="이번 주 위반"
          period="이번 주"
          value={`${penaltyWeek.thisWeekCount}건`}
          color={penaltyWeek.thisWeekCount > 0 ? "var(--danger)" : undefined}
          title={`${penaltyWeek.diffLabel} · 벌점 ${penaltyWeek.thisWeekPoints}점`}
          sub={`벌점 ${penaltyWeek.thisWeekPoints}점`}
          reliabilityTip={reliability.patrol}
        />

        <AttendanceCard days={attendanceDays} summary={attendanceSummary} heatmap={attendanceHeatmap} reliabilityTip={reliability.attendance} />
        <PatrolCard counts={patrolCounts} heatmap={patrolHeatmap} total={patrolTotal} reliabilityTip={reliability.patrol} />
        <ScheduleCard studentId={student.id} miniature={scheduleMiniature} ruleCount={ruleCount} hasSchedule={hasSchedule} canEditSchedule={canEditSchedule} />

        <PenaltyReasonCard bars={penaltyReasonBars} total30={penaltyTotal30} reliabilityTip={reliability.patrol} />
        <PenaltyHourlyCard hourly={penaltyHourly} reliabilityTip={reliability.patrol} />
      </div>
    </div>
  );
}

// 카드 제목 옆 물음표 배지 — 문제 있을 때만(tip!=null) 그린다(깨끗한 카드엔 아무것도 안 그림).
// title 툴팁에 이미 줄바꿈 포함 항목 목록 + 안내 문구가 들어있다(page.tsx 가 완성해 내려준 문자열).
function ReliabilityBadge({ tip }: { tip: string | null }) {
  if (!tip) return null;
  return (
    <span title={tip} style={{ display: "inline-flex", color: "var(--warn)", cursor: "help", flexShrink: 0 }}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.3 9.6a2.7 2.7 0 1 1 4.3 2.2c-.8.55-1.6 1.1-1.6 2.3" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}

// ================= 헤더 =================
function HeaderCard({ student, canEditSchedule }: { student: StudentHead; canEditSchedule: boolean }) {
  return (
    <section className="sd-header" style={{ ...CARD, flexDirection: "row", alignItems: "center", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 24, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {student.name}
        </span>
        <span style={{ fontSize: 12.5, color: "var(--dim)", flexShrink: 0 }}>{student.seatLabel}</span>
        <span
          style={{
            fontSize: 11.5, fontWeight: 700, padding: "3px 9px", borderRadius: 999, flexShrink: 0,
            color: student.isLeave ? "var(--faint)" : "var(--ok)",
            background: student.isLeave ? "var(--panel2)" : "var(--ok-soft)",
          }}
        >
          {student.statusLabel}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        {canEditSchedule && (
          <a href={`/m/schedule?student=${student.id}`} className="btn btn-accent" style={{ height: 32, padding: "0 12px", fontSize: 12.5 }}>
            스케쥴
          </a>
        )}
        <a href="/m/student" className="chip" style={{ cursor: "pointer" }}>목록</a>
      </div>
    </section>
  );
}

// ================= 지표 4개 =================
function StatCard({ label, value, color, dim, title, sub, period, reliabilityTip }: { label: string; value: string; color?: string; dim?: boolean; title?: string; sub?: string; period?: string; reliabilityTip?: string | null }) {
  return (
    <div className="sd-stat" style={CARD} title={title}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        <span style={STAT_LABEL}>{label}</span>
        {period && <span style={PERIOD_LABEL}>{period}</span>}
        <ReliabilityBadge tip={reliabilityTip ?? null} />
      </div>
      <span style={{ ...STAT_VALUE, color: dim ? "var(--faint)" : color ?? "var(--ink)" }}>{value}</span>
      {sub && <span style={STAT_SUB}>{sub}</span>}
    </div>
  );
}

// ================= 공통: 달력 히트맵 그리드(미니어처) =================
// 출결(입실 시각)·순찰(벌점) 히트맵이 공유하는 모양 — 월~일 7칸, 세로로 최근 30일. 색·title 은
// util.ts(CalendarHeatmap)가 이미 다 계산해 내려준 값을 그대로 꽂아 넣기만 한다(여기선 레이아웃만).
// 이 화면에서 달력은 카드 폭에 맞춰 셀이 늘어나는 정방형 그리드다 — 셀 크기를 직접 캡하지 않고,
// 대신 카드 자체의 폭(레이아웃의 sd-att/sd-patrol span)으로 셀 크기를 간접 조절한다(대략 28~32px).
// 날짜 숫자를 셀 좌상단에 작게 남긴다(자세한 값은 title 툴팁에 monthDayLabel 로 이미 들어있음). 월
// 구분은 텍스트 라벨 없이, 그 달 1일이 속한 주 행 "위"에만 전폭 구분선을 긋는다.
const CAL_GAP = 4;
const calGridCols: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(7, minmax(0,1fr))", gap: CAL_GAP };

function CalendarHeatmapGrid({ heatmap, leftLabel, rightLabel }: { heatmap: CalendarHeatmap; leftLabel: string; rightLabel: string }) {
  // leading 빈 칸 + 실제 셀을 한 줄로 이어붙인 뒤 7개씩 주 단위로 다시 묶는다 — 월 구분선을
  // "그 주 행 전체"에 걸쳐 그리려면 셀을 주 단위 블록으로 갖고 있어야 해서다(util.ts 는 평평한
  // cells 배열만 내려주므로 여기서 조립만, 날짜 계산은 없음).
  type Cell = CalendarHeatmap["cells"][number];
  const slots: (Cell | null)[] = [...Array.from({ length: heatmap.leading }, () => null), ...heatmap.cells];
  const weeks: (Cell | null)[][] = [];
  for (let i = 0; i < slots.length; i += 7) weeks.push(slots.slice(i, i + 7));

  return (
    <div style={{ overflowX: "auto", paddingBottom: 2, flex: 1, display: "flex", flexDirection: "column" }}>
      <div>
        {/* 요일 머리글 */}
        <div style={{ ...calGridCols, marginBottom: 4 }}>
          {DAY_LABELS.map((wd) => (
            <div key={wd} style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)", textAlign: "center" }}>{wd}</div>
          ))}
        </div>

        {/* 주 단위 행 */}
        <div style={{ display: "flex", flexDirection: "column", gap: CAL_GAP }}>
          {weeks.map((week, wi) => {
            const monthStarts = wi > 0 && week.some((c) => c != null && c.monthLabel != null);
            return (
              <div key={wi}>
                {monthStarts && <div style={{ borderTop: "1px solid var(--line)", margin: "3px 0" }} />}
                <div style={calGridCols}>
                  {week.map((cell, ci) =>
                    cell == null ? (
                      <div key={`blank-${wi}-${ci}`} style={{ aspectRatio: "1 / 1" }} />
                    ) : (
                      <div key={cell.date} style={{ position: "relative", aspectRatio: "1 / 1" }}>
                        <div
                          title={cell.title ?? undefined}
                          style={{
                            position: "absolute", inset: 0, borderRadius: 5, padding: "3px 0 0 4px",
                            background: cell.hasData ? cell.color! : "transparent",
                            border: cell.isToday ? "1.5px solid var(--accent)" : cell.hasData ? "1px solid transparent" : "1px solid var(--line)",
                          }}
                        >
                          <span style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1, pointerEvents: "none" }}>{cell.dayNum}</span>
                        </div>
                        {cell.dot != null && (
                          <span style={{ position: "absolute", right: 2, top: 2, width: 3, height: 3, borderRadius: "50%", background: cell.dot, pointerEvents: "none" }} />
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 범례 */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 5, marginTop: 8, fontSize: 10.5, color: "var(--dim)" }}>
        <span>{leftLabel}</span>
        {heatmap.legend.map((l) => (
          <span key={l.label} title={l.label} style={{ width: 10, height: 10, borderRadius: 3, background: l.color, display: "inline-block" }} />
        ))}
        <span>{rightLabel}</span>
      </div>
    </div>
  );
}

// ================= 출결 달력 =================
function AttendanceCard({ days, summary, heatmap, reliabilityTip }: { days: AttendanceDay[]; summary: AttendanceSummary; heatmap: CalendarHeatmap; reliabilityTip: string | null }) {
  const attended = days.filter((d) => d.firstIn);
  const tip = attended.length === 0
    ? "최근 30일간 등원 기록 없음"
    : `등원 ${summary.attendedDays}일 · 평균 등원 ${summary.avgIn ?? "—"} · 평균 하원 ${summary.avgOut ?? "—"} · ${summary.hasSchedule ? `지각 ${summary.lateCount}회` : "지각 비교 미설정"} · 진하기=그날 재실 시간(많을수록 진함), 점=지각`;
  return (
    <section className="sd-att" style={CARD}>
      <div style={CARD_TITLE_ROW} title={tip}>
        <span>출결</span>
        <span style={PERIOD_LABEL}>30일</span>
        <ReliabilityBadge tip={reliabilityTip} />
      </div>
      {attended.length === 0 ? <div style={EMPTY}>기록 없음</div> : <CalendarHeatmapGrid heatmap={heatmap} leftLabel="자습 시간 적음" rightLabel="자습 시간 많음" />}
    </section>
  );
}

// ================= 순찰 달력 =================
function PatrolCard({ counts, heatmap, total, reliabilityTip }: { counts: PatrolStateCount[]; heatmap: CalendarHeatmap; total: number; reliabilityTip: string | null }) {
  const tip = total === 0
    ? "최근 30일간 순찰 기록 없음"
    : `순찰 ${total}회 · ${counts.map((c) => `${c.label} ${c.count}`).join(" · ")} · 진하기=그날 위반 횟수`;
  return (
    <section className="sd-patrol" style={CARD}>
      <div style={CARD_TITLE_ROW} title={tip}>
        <span>순찰</span>
        <span style={PERIOD_LABEL}>30일</span>
        <ReliabilityBadge tip={reliabilityTip} />
      </div>
      {total === 0 ? <div style={EMPTY}>기록 없음</div> : <CalendarHeatmapGrid heatmap={heatmap} leftLabel="양호" rightLabel="주의" />}
    </section>
  );
}

// ================= 벌점 시간대(막대 그래프 + 사유별 스택 바 + 범례) =================
// PATROL_STATES 라벨과 겹치는 사유는 같은 semantic key(같은 hue)를 그대로 쓰고, 나머지 벌점 전용 사유는
// 팔레트 안에서 순환 배정한다 — 새 헥스 없이 semantic-color.ts 만 참조.
const REASON_KEY_BY_LABEL: Record<string, SemanticKey> = {
  "지각": "late", "수면": "sleep", "딴짓": "distract", "자리비움": "away",
  "학원": "academy", "원내 수업": "inClass", "주간 상담": "counsel",
};
const REASON_FALLBACK_KEYS: SemanticKey[] = ["distract", "away", "late", "counsel", "academy", "inClass", "present", "leaveHome", "sleep"];
function reasonColor(label: string, idx: number): string {
  const key = REASON_KEY_BY_LABEL[label] ?? REASON_FALLBACK_KEYS[idx % REASON_FALLBACK_KEYS.length];
  return solid(key);
}

// ================= 사유(벌점 사유별 구성 — 세로 목록형) =================
// 벌점 시간대 카드와 나란히 두는 좁은 카드라서, 100% 가로 스택 바 대신 사유마다 한 줄(점+라벨+점수+
// 비율 바)로 세로 나열한다 — 좁은 폭에서 더 읽기 쉽다.
function PenaltyReasonCard({ bars, total30, reliabilityTip }: { bars: PenaltyReasonBar[]; total30: number; reliabilityTip: string | null }) {
  const totalCount = bars.reduce((a, r) => a + r.count, 0);
  const tip = totalCount > 0 ? `최근 30일 위반 ${totalCount}건 · 벌점 ${total30}점 · 사유별 구성` : "최근 30일간 위반 기록 없음";
  return (
    <section className="sd-reason" style={CARD}>
      <div style={CARD_TITLE_ROW} title={tip}>
        <span>사유</span>
        <span style={PERIOD_LABEL}>30일</span>
        <ReliabilityBadge tip={reliabilityTip} />
      </div>
      {totalCount === 0 ? (
        <div style={EMPTY}>기록 없음</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {bars.map((r, i) => (
            <div key={r.label} title={`${r.label} ${r.count}회 · ${r.points}점 (${r.pct}%)`}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: reasonColor(r.label, i), display: "inline-block", flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: "var(--dim)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
                <span style={{ fontSize: 12, color: "var(--faint)", fontWeight: 700, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{r.count}회</span>
                <span style={{ fontSize: 10.5, color: "var(--dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{r.points}점</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: "var(--panel2)", overflow: "hidden" }}>
                <div style={{ width: `${r.pct}%`, height: "100%", background: reasonColor(r.label, i) }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ================= 벌점 시간대(연속 곡선 + 에어리어) =================
// 막대 그래프를 부드러운 곡선(스플라인) + 아래 면적 채움으로 바꿨다 — 데이터 조회·집계(PenaltyHourly,
// util.ts buildPenaltyHourly)는 그대로, 표현만 바꾼다. 각 시간대의 title(옛 막대 툴팁 내용 그대로)은
// 곡선 위에 깔린 투명 히트 rect 로 그대로 옮겼다.
//
// 스무딩: Catmull-Rom 스플라인 → 3차 베지어 변환(catmullRomToBezierPath, 순수 함수). 점 0개는 빈 문자열,
// 1개는 그 점 하나(M만), 2개는 직선(L) — 3개 이상부터 실제 곡선을 그린다. 좌표는 항상 이 함수 밖(호출부)
// 에서 이미 계산된 x,y 숫자만 받는다(날짜·시간 계산 없음, DOM 의존 없음).
function catmullRomToBezierPath(points: { x: number; y: number }[]): string {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M ${points[0].x} ${points[0].y}`;
  if (n === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

// viewBox 내부 좌표계(고정) — 실제 렌더 크기는 컨테이너가 width:100%/height:PEN_H(px)로 정하고, SVG는
// preserveAspectRatio="none"으로 가로만 그 폭에 맞춰 늘어난다(세로는 PEN_H 그대로 고정). 텍스트는 이
// 비균등 스케일 아래서 찌그러지므로 SVG 안에 두지 않고 전부 이 컨테이너 위 HTML로 겹쳐 그린다(라벨
// 위치는 같은 x좌표계를 %로 환산해 정렬만 맞춘다).
const PEN_W = 700;
const PEN_H = 130;
const PEN_PAD_X = 6;
const PEN_AXIS_Y = 96; // 기준선(바닥) y좌표
const PEN_TOP_Y = 20;  // 최고점이 닿을 수 있는 최상단 y좌표

function PenaltyHourlyCard({ hourly, reliabilityTip }: { hourly: PenaltyHourly; reliabilityTip: string | null }) {
  const buckets = hourly.buckets;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const tip = hourly.hasData ? `${hourly.peakLabel ?? ""} · 시간대별 위반(최근 4주, 07~23시)`.replace(/^ · /, "") : "최근 4주간 시간대별 위반 기록 없음";

  const n = buckets.length;
  const innerW = PEN_W - PEN_PAD_X * 2;
  const stepX = n > 1 ? innerW / (n - 1) : 0;
  const xOf = (i: number) => PEN_PAD_X + stepX * i;
  const yOf = (count: number) => PEN_AXIS_Y - (count / maxCount) * (PEN_AXIS_Y - PEN_TOP_Y);

  const nodes = buckets.map((b, i) => ({ x: xOf(i), y: hourly.hasData ? yOf(b.count) : PEN_AXIS_Y, b }));
  const linePath = hourly.hasData ? catmullRomToBezierPath(nodes.map((p) => ({ x: p.x, y: p.y }))) : "";
  const areaPath = hourly.hasData && n > 0
    ? `${linePath} L ${nodes[n - 1].x} ${PEN_AXIS_Y} L ${nodes[0].x} ${PEN_AXIS_Y} Z`
    : "";

  let peakIdx = -1;
  if (hourly.hasData) {
    for (let i = 0; i < n; i++) if (peakIdx === -1 || nodes[i].b.count > nodes[peakIdx].b.count) peakIdx = i;
  }
  const peak = peakIdx >= 0 ? nodes[peakIdx] : null;
  const gradId = "sd-pen-hourly-grad";

  return (
    <section className="sd-pen" style={CARD}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={CARD_TITLE_ROW} title={tip}>
          <span>위반 집중 시간대</span>
          <span style={PERIOD_LABEL}>4주 누적</span>
          <ReliabilityBadge tip={reliabilityTip} />
        </div>
        {hourly.hasData && <span style={{ fontSize: 10, color: "var(--faint)", fontWeight: 700, marginBottom: 8 }}>최고 {maxCount}건</span>}
      </div>
      {!hourly.hasData ? (
        <div style={{ position: "relative", width: "100%", height: PEN_H }}>
          <svg viewBox={`0 0 ${PEN_W} ${PEN_H}`} preserveAspectRatio="none" style={{ width: "100%", height: PEN_H, display: "block" }}>
            <line x1={PEN_PAD_X} y1={PEN_AXIS_Y} x2={PEN_W - PEN_PAD_X} y2={PEN_AXIS_Y} stroke="var(--line)" strokeWidth={1.5} strokeDasharray="3 4" />
          </svg>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ position: "relative", width: "100%", height: PEN_H }}>
            <svg viewBox={`0 0 ${PEN_W} ${PEN_H}`} preserveAspectRatio="none" style={{ width: "100%", height: PEN_H, display: "block" }}>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={solid("distract")} stopOpacity="0.35" />
                  <stop offset="100%" stopColor={solid("distract")} stopOpacity="0" />
                </linearGradient>
              </defs>

              <line x1={PEN_PAD_X} y1={PEN_AXIS_Y} x2={PEN_W - PEN_PAD_X} y2={PEN_AXIS_Y} stroke="color-mix(in srgb, var(--line) 55%, transparent)" strokeWidth={1} />

              {areaPath && <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />}
              <path d={linePath} fill="none" stroke={solid("distract")} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

              {peak && (
                <>
                  <line x1={peak.x} y1={peak.y} x2={peak.x} y2={PEN_AXIS_Y} stroke="var(--line)" strokeWidth={1} strokeDasharray="2 3" />
                  <circle cx={peak.x} cy={peak.y} r={3.2} fill={solid("distract")} stroke="var(--card)" strokeWidth={1.5} />
                </>
              )}

              {nodes.map((p, i) => (
                <rect
                  key={p.b.hour}
                  x={stepX > 0 ? Math.max(0, xOf(i) - stepX / 2) : 0}
                  y={0}
                  width={stepX > 0 ? stepX : PEN_W}
                  height={PEN_H}
                  fill="transparent"
                >
                  <title>{p.b.title}</title>
                </rect>
              ))}
            </svg>

            {/* 최고점 값 라벨 — 비균등 스케일 아래 SVG 텍스트가 찌그러지지 않도록 HTML로 겹쳐 그린다 */}
            {peak && (
              <span
                style={{
                  position: "absolute", left: `${(peak.x / PEN_W) * 100}%`, top: `${(peak.y / PEN_H) * 100}%`,
                  transform: "translate(-50%, calc(-100% - 3px))",
                  fontSize: 10, fontWeight: 800, color: solid("distract"), whiteSpace: "nowrap", pointerEvents: "none",
                }}
              >
                {maxCount}건
              </span>
            )}
          </div>

          {/* 가로축: 3시간 간격 시각 라벨만(세로축 라벨 없음) */}
          <div style={{ position: "relative", height: 12, marginTop: 2 }}>
            {nodes.map((p, i) =>
              p.b.hour % 3 !== 1 ? null : (
                <span
                  key={p.b.hour}
                  style={{
                    position: "absolute", left: `${(p.x / PEN_W) * 100}%`, top: 0,
                    transform: "translateX(-50%)", fontSize: 9, color: "var(--faint)", whiteSpace: "nowrap",
                  }}
                >
                  {String(p.b.hour).padStart(2, "0")}
                </span>
              )
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ================= 시간표(스케쥴 미니어처) =================
// 카드 span 이 4(출결·순찰과 같은 줄)로 좁아진 만큼, 높이는 고정 px 가 아니라 부모 카드(CARD, flex
// column)가 그리드 행 stretch 로 정해주는 만큼을 그대로 채운다(flex:1) — 출결·순찰 달력과 세로 정렬이
// 크게 어긋나지 않도록. 미설정 상태의 최소 높이만 아래 상수로 보장한다.
const MINI_MIN_HEIGHT = 100;

function MiniTimetable({ days }: { days: MiniDay[] }) {
  return (
    <div style={{ flex: 1, minHeight: MINI_MIN_HEIGHT, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, marginBottom: 3 }}>
        {days.map((d) => (
          <div key={d.day} style={{ fontSize: 9.5, fontWeight: 700, color: "var(--faint)", textAlign: "center" }}>{d.label}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, flex: 1 }}>
        {days.map((d) => (
          <div key={d.day} style={{ position: "relative", height: "100%", borderRadius: 5, overflow: "hidden", background: "var(--panel2)" }}>
            {/* 등원~하원 사이만 밝게, 그 바깥은 배경(panel2)이 그대로 비쳐 흐리게 보인다 */}
            {d.hasHours && d.arrivePct != null && d.leavePct != null && (
              <div
                style={{
                  position: "absolute", left: 0, right: 0,
                  top: `${d.arrivePct}%`, height: `${Math.max(0, d.leavePct - d.arrivePct)}%`,
                  background: "var(--card)",
                }}
              />
            )}
            {/* 블록 — 글자 없이 색만(사유 팔레트=blockStyleOf). 임시 일정은 점선 테두리로 구분 */}
            {d.blocks.map((b) => (
              <div
                key={b.id}
                title={b.title}
                style={{
                  position: "absolute", left: 1, right: 1, top: `${b.top}%`, height: `${b.height}%`,
                  borderRadius: 3, background: b.bg,
                  borderStyle: b.dashed ? "dashed" : "solid", borderWidth: 1, borderColor: b.bd,
                }}
              />
            ))}
            {/* 등원선·하원선 — 얇은 선만 */}
            {d.hasHours && d.arrivePct != null && (
              <div style={{ position: "absolute", left: 0, right: 0, top: `${d.arrivePct}%`, height: 1, background: "var(--line)" }} />
            )}
            {d.hasHours && d.leavePct != null && (
              <div style={{ position: "absolute", left: 0, right: 0, top: `${d.leavePct}%`, height: 1, background: "var(--line)" }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ScheduleCard({
  studentId, miniature, ruleCount, hasSchedule, canEditSchedule,
}: {
  studentId: string; miniature: ScheduleMiniature; ruleCount: number; hasSchedule: boolean; canEditSchedule: boolean;
}) {
  const tip = hasSchedule ? `${miniature.summaryLine}${ruleCount ? ` · 정기 일정 ${ruleCount}건` : ""}` : "등·하원 시각 미설정";
  return (
    <section className="sd-sched" style={CARD}>
      <div style={CARD_TITLE} title={tip}>시간표</div>
      {!hasSchedule ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, flex: 1, minHeight: MINI_MIN_HEIGHT }} title={tip}>
          <span style={{ fontSize: 12.5, color: "var(--faint)", fontWeight: 700 }}>미설정</span>
          {canEditSchedule && (
            <a href={`/m/schedule?student=${studentId}`} style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", textDecoration: "none" }}>편집 →</a>
          )}
        </div>
      ) : (
        <MiniTimetable days={miniature.days} />
      )}
    </section>
  );
}
