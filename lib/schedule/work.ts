// 시간 기록 계산 (docs/플래너.md 7-16). 순수 함수 — 웹(집중 화면의 시계 · 기록 표 · 메모리 저장소)과 MCP(work_log)가 같이 쓴다.
// 날짜는 Asia/Seoul (서머타임이 없어 +9시간 고정 — mcp/schedule.ts 의 seoul 과 같다). 같은 계산을 DB(0018 ez_work_sum · ez_work_week)도 한다.

import { WORK_SPAN_MAX_SEC, type DateStr, type TaskWork, type WorkDay, type WorkSpan } from "./types";

const KST_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

/** 그 순간의 Asia/Seoul 날짜 */
export function seoulDay(ms: number): DateStr {
  return new Date(ms + KST_MS).toISOString().slice(0, 10);
}

/** 그 날짜(Asia/Seoul) 0시의 시각(ms) */
export function seoulMidnight(day: DateStr): number {
  return Date.parse(`${day}T00:00:00Z`) - KST_MS;
}

/** 구간의 끝(ms): 닫혔으면 그 시각, 열려 있으면 지금 — 시작 + 24시간을 넘지 않는다 (0018 ez_work_end) */
export function spanEnd(startedAt: string, endedAt: string | null, nowMs: number): number {
  const start = Date.parse(startedAt);
  return Math.min(endedAt === null ? nowMs : Date.parse(endedAt), start + WORK_SPAN_MAX_SEC * 1000);
}

/** 열린 구간이 아직 돌고 있나 (24시간이 넘었으면 잊은 것 — 돌지 않는 것으로 친다) */
export function spanRunning(startedAt: string, endedAt: string | null, nowMs: number): boolean {
  return endedAt === null && Date.parse(startedAt) + WORK_SPAN_MAX_SEC * 1000 > nowMs;
}

/** 한 구간을 날짜(Asia/Seoul)별 초로 나눈다. 자정을 넘으면 여러 날 */
export function splitByDay(startMs: number, endMs: number): { day: DateStr; seconds: number }[] {
  const out: { day: DateStr; seconds: number }[] = [];
  let at = startMs;
  while (at < endMs) {
    const day = seoulDay(at);
    const next = Math.min(endMs, seoulMidnight(day) + DAY_MS);
    out.push({ day, seconds: Math.round((next - at) / 1000) });
    at = next;
  }
  return out;
}

type RawSpan = { task_id: string; started_at: string; ended_at: string | null };

/** 구간들 → 할 일별 합 (ez_work_sum 과 같다). 기록이 있는 할 일만 */
export function workSums(spans: readonly RawSpan[], now: Date): Map<string, TaskWork> {
  const nowMs = now.getTime();
  const today = seoulMidnight(seoulDay(nowMs));
  const out = new Map<string, TaskWork>();
  for (const s of spans) {
    const start = Date.parse(s.started_at);
    const end = spanEnd(s.started_at, s.ended_at, nowMs);
    const w = out.get(s.task_id) ?? { today_sec: 0, total_sec: 0, running: false, started_at: null, at: now.toISOString() };
    w.total_sec += Math.round((end - start) / 1000);
    w.today_sec += Math.max(0, Math.round((end - Math.max(start, today)) / 1000));
    if (spanRunning(s.started_at, s.ended_at, nowMs)) {
      w.running = true;
      w.started_at = s.started_at;
    }
    out.set(s.task_id, w);
  }
  return out;
}

/** 구간들 → 그 주(월요일 weekStart 부터 7일)의 할 일 × 날짜 초 (ez_work_week 와 같다) */
export function workWeek(spans: readonly RawSpan[], weekStart: DateStr, now: Date): WorkDay[] {
  const lo = seoulMidnight(weekStart);
  const hi = lo + 7 * DAY_MS;
  const sum = new Map<string, WorkDay>();
  for (const s of spans) {
    const start = Math.max(lo, Date.parse(s.started_at));
    const end = Math.min(hi, spanEnd(s.started_at, s.ended_at, now.getTime()));
    for (const p of splitByDay(start, end)) {
      const key = `${s.task_id}:${p.day}`;
      const row = sum.get(key) ?? { task_id: s.task_id, day: p.day, seconds: 0 };
      row.seconds += p.seconds;
      sum.set(key, row);
    }
  }
  return [...sum.values()].sort((a, b) => a.day.localeCompare(b.day) || a.task_id.localeCompare(b.task_id));
}

/** 구간들 → 기간(from ~ to, 그날 포함)에 걸친 원 구간 (ez_work_list 와 같다) */
export function workList(spans: readonly (RawSpan & { id: string })[], from: DateStr, to: DateStr, now: Date): WorkSpan[] {
  const lo = seoulMidnight(from);
  const hi = seoulMidnight(to) + DAY_MS;
  const nowMs = now.getTime();
  return spans
    .filter((s) => Date.parse(s.started_at) < hi && spanEnd(s.started_at, s.ended_at, nowMs) > lo)
    .map((s) => ({
      id: s.id,
      task_id: s.task_id,
      started_at: s.started_at,
      ended_at: new Date(spanEnd(s.started_at, s.ended_at, nowMs)).toISOString(),
      running: spanRunning(s.started_at, s.ended_at, nowMs),
    }))
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}

/**
 * 지금의 합: 읽은 때(at) 뒤로 흐른 만큼을 돌고 있는 것에 더한다.
 * clock = 돌고 있는 구간이 지금까지 간 초(안 돌면 null) — 집중 화면의 "12:34"
 */
export function liveWork(w: TaskWork | undefined | null, nowMs: number): { today: number; total: number; clock: number | null } {
  if (!w) return { today: 0, total: 0, clock: null };
  if (!w.running || !w.started_at) return { today: w.today_sec, total: w.total_sec, clock: null };
  const start = Date.parse(w.started_at);
  // 24시간이 넘으면 멈춘 것으로 본다 (다음에 읽으면 running 이 꺼져서 온다)
  const cap = start + WORK_SPAN_MAX_SEC * 1000;
  const drift = Math.max(0, Math.round((Math.min(nowMs, cap) - Date.parse(w.at)) / 1000));
  return { today: w.today_sec + drift, total: w.total_sec + drift, clock: Math.max(0, Math.round((Math.min(nowMs, cap) - start) / 1000)) };
}

/** 초 → 분 (기록 표 · "오늘 40분"). 1분이 안 돼도 기록이 있으면 1 */
export function secToMin(sec: number): number {
  return sec <= 0 ? 0 : Math.max(1, Math.round(sec / 60));
}

/** 흐르는 시계 "12:34" · 한 시간이 넘으면 "1:02:03" */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
