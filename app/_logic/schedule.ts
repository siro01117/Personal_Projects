// 일정 화면 계산 (docs/일정.md 6장). DOM 없이 시험할 수 있는 것만: 날짜·시각 글자, 시간 범위, 겹침 칸 나누기,
// 자정 넘김 나누기, 블록 높이에 맞춘 줄 수, 끌기 좌표 → 분. 동선·식사 계산은 lib/schedule 의 planRange 가 한다.

import { toKorean, type KoreanError } from "../../lib/errors";
import {
  addDays,
  daysBetween,
  occursOn,
  weekday,
  type DateStr,
  type DayPlan,
  type EventRow,
  type ExceptionPatch,
  type Occurrence,
  type Place,
  type Repeat,
  type Segment,
} from "../../lib/schedule";
import type { EventInput, EventRows, SplitPatch } from "../_data/types";

/** 1분 = 0.8px (1시간 48px) */
export const PX_PER_MIN = 0.8;
/** 끌어 옮기기·늘리기·할 일 놓기 단위 */
export const SNAP = 15;
/** 빈 칸 두 번 누르기로 만드는 새 일정의 시작 단위 */
export const NEW_SNAP = 30;
export const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;

// ------------------------------------------------------------ 지금 · 주

/** 그 시간대의 오늘 날짜와 0시부터 센 분 */
export function nowIn(tz: string, now: Date = new Date()): { date: DateStr; min: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, min: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** 그 주 월요일 */
export function mondayOf(d: DateStr): DateStr {
  return addDays(d, 1 - weekday(d));
}

export function weekDates(monday: DateStr): DateStr[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

// ------------------------------------------------------------ 글자

const md = (d: DateStr) => {
  const [, m, day] = d.split("-").map(Number) as [number, number, number];
  return { m, day };
};

/** 분 → "13:05". 1440 이상이면 다음 날 시각 */
export function hm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "19:00–21:00", 자정을 넘기면 "23:00–다음 날 01:00" */
export function timeRange(start: number, end: number): string {
  return `${hm(start)}–${end > 1440 ? "다음 날 " : ""}${hm(end)}`;
}

/** "10월 1일 목" */
export function dayLabel(d: DateStr, withWeekday = true): string {
  const { m, day } = md(d);
  return `${m}월 ${day}일${withWeekday ? ` ${WEEKDAYS[weekday(d) - 1]}` : ""}`;
}

/** "9월 28일 – 10월 4일", 같은 달이면 "10월 5일 – 11일" */
export function weekTitle(monday: DateStr): string {
  const a = md(monday);
  const b = md(addDays(monday, 6));
  return a.m === b.m ? `${a.m}월 ${a.day}일 – ${b.day}일` : `${a.m}월 ${a.day}일 – ${b.m}월 ${b.day}일`;
}

/** 폰 주 보기 제목 "9.28 – 10.4" */
export function shortWeekTitle(monday: DateStr): string {
  const a = md(monday);
  const b = md(addDays(monday, 6));
  return `${a.m}.${a.day} – ${b.m}.${b.day}`;
}

/** "매주 화" · "매주 월·수" · "매일" (+ " · 12월 20일까지"). 반복 아니면 null */
export function repeatLabel(r: Repeat): string | null {
  if (!r) return null;
  let s: string;
  if (r.freq === "daily") s = "매일";
  else {
    const days = [...r.days].sort((a, b) => a - b);
    s = days.length === 7 ? "매일" : days.join() === "1,2,3,4,5" ? "매주 평일" : `매주 ${days.map((d) => WEEKDAYS[d - 1]).join("·")}`;
  }
  return r.until ? `${s} · ${dayLabel(r.until, false)}까지` : s;
}

/** 걸린 시간 "1시간 30분" · "40분" */
export function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h === 0 ? `${m}분` : m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

// ------------------------------------------------------------ 자정 넘김 · 시간 범위

/** 한 날짜 열에 그리는 조각. cutTop = 전날에서 이어짐, cutBottom = 다음 날로 이어짐 */
export type Piece = { date: DateStr; start: number; end: number; cutTop: boolean; cutBottom: boolean };

/** date 기준 분 [start, end) 를 날짜별 조각으로. start 가 1440 이상이면 통째로 다음 날 */
export function splitAtMidnight(date: DateStr, start: number, end: number): Piece[] {
  const out: Piece[] = [];
  for (let k = Math.floor(start / 1440); k * 1440 < end; k++) {
    const s = Math.max(start, k * 1440) - k * 1440;
    const e = Math.min(end, (k + 1) * 1440) - k * 1440;
    if (e > s) out.push({ date: addDays(date, k), start: s, end: e, cutTop: start < k * 1440, cutBottom: end > (k + 1) * 1440 });
  }
  return out;
}

/**
 * 격자에 보일 시간 범위: 걸친 범위 ±1시간을 시간 단위로, 최소 8시간, 0~24시 안.
 * 아무것도 없으면 8~20시.
 */
export function hourRange(spans: readonly { start: number; end: number }[], pad = 60, minSpan = 480): { from: number; to: number } {
  if (spans.length === 0) return { from: 480, to: 1200 };
  let from = Math.floor((Math.min(...spans.map((s) => s.start)) - pad) / 60) * 60;
  let to = Math.ceil((Math.max(...spans.map((s) => s.end)) + pad) / 60) * 60;
  from = Math.max(0, from);
  to = Math.min(1440, to);
  if (to - from < minSpan) {
    const need = minSpan - (to - from);
    const up = Math.min(from, Math.floor(need / 120) * 60);
    from -= up;
    to = Math.min(1440, to + need - up);
    if (to - from < minSpan) from = Math.max(0, to - minSpan);
  }
  return { from, to };
}

// ------------------------------------------------------------ 겹침 칸 나누기

export type Laid<T> = {
  item: T;
  lane: number;
  lanes: number;
  /** 열 폭 대비 왼쪽 위치와 폭 (0~1) */
  left: number;
  width: number;
};

/**
 * 겹치는 것끼리 칸을 나눈다 (Google Calendar 와 같이). 서로 이어 겹치는 무리마다 칸 수가 같고,
 * 각 항목은 비어 있는 가장 왼쪽 칸에 선다. 겹치지 않는 항목은 lanes = 1.
 * weight 를 주면 칸 폭을 그 칸 항목들의 가장 큰 무게에 비례해 나눈다 (이동 띠는 일정보다 좁게)
 */
export function layoutLanes<T extends { start: number; end: number }>(items: readonly T[], weight: (t: T) => number = () => 1): Laid<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Laid<T>[] = [];
  let group: Laid<T>[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const close = () => {
    const w = laneEnds.map((_, i) => Math.max(...group.filter((g) => g.lane === i).map((g) => weight(g.item))));
    const total = w.reduce((a, b) => a + b, 0);
    for (const g of group) {
      g.lanes = laneEnds.length;
      g.left = w.slice(0, g.lane).reduce((a, b) => a + b, 0) / total;
      g.width = w[g.lane]! / total;
    }
    group = [];
    laneEnds = [];
  };
  for (const it of sorted) {
    if (it.start >= groupEnd) {
      if (group.length) close();
      groupEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((e) => e <= it.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(it.end);
    } else laneEnds[lane] = it.end;
    const laid = { item: it, lane, lanes: 1, left: 0, width: 1 };
    group.push(laid);
    out.push(laid);
    groupEnd = Math.max(groupEnd, it.end);
  }
  if (group.length) close();
  return out;
}

// ------------------------------------------------------------ 블록 줄 수

/** 제목 한 줄 높이 (12px × 1.3) */
const TITLE_LINE = 15.6;

/**
 * 블록 높이에 맞춘 제목 줄 수. 두 줄이 안 나오면 시간을 빼고 제목에 준다.
 * short = 34px 미만이라 위아래 여백을 줄인다(6 → 3)
 */
export function blockFit(heightPx: number, padY = 12): { short: boolean; showTime: boolean; lines: number } {
  const short = heightPx < 34;
  const usable = heightPx - (short ? 6 : padY);
  const lines = Math.max(1, Math.floor(usable / TITLE_LINE));
  return lines < 2 ? { short, showTime: false, lines } : { short, showTime: true, lines: lines - 1 };
}

// ------------------------------------------------------------ 끌기

export function snap(min: number, step = SNAP): number {
  return Math.round(min / step) * step;
}

/** 격자 위 y(px) → 그날 분 (range.from 기준, 스냅 안 함) */
export function yToMin(y: number, from: number, pxPerMin = PX_PER_MIN): number {
  return from + y / pxPerMin;
}

/** 옮기기: 길이를 지키고 시작을 0~1439 안으로 */
export function moveTo(start: number, end: number, newStart: number): { start: number; end: number } {
  const len = end - start;
  const s = Math.min(1439, Math.max(0, snap(newStart)));
  return { start: s, end: s + len };
}

/** 아래 끝 늘리기: 최소 15분, 최대 24시간 */
export function resizeTo(start: number, newEnd: number): number {
  return Math.min(start + 1440, Math.max(start + SNAP, snap(newEnd)));
}

/** 빈 칸 두 번 누른 자리 → 새 일정 시작·끝 (30분 단위, 끝 +60) */
export function newAt(min: number): { start: number; end: number } {
  const s = Math.min(1410, Math.max(0, Math.floor(min / NEW_SNAP) * NEW_SNAP));
  return { start: s, end: s + 60 };
}

/** 매주 반복의 요일을 delta 일만큼 민다 (1=월 … 7=일) */
export function shiftDays(days: readonly number[], delta: number): number[] {
  return [...new Set(days.map((d) => ((((d - 1 + delta) % 7) + 7) % 7) + 1))].sort((a, b) => a - b);
}

// ------------------------------------------------------------ 나갈 시각

export type Departure = { at: number; from: string | null; minutes: number; late: number };

/** 그 회차로 들어가는 이동 띠 → 몇 시에 어디서 출발 · 이동 몇 분 · 늦음. 늦으면 앞 일정이 끝나는 때 출발. 없으면 null */
export function departureFor(key: string, segments: readonly Segment[]): Departure | null {
  for (const s of segments) {
    if (s.kind === "travel" && s.for_key === key) return { at: s.start + s.late, from: s.from, minutes: s.end - s.start, late: s.late };
  }
  return null;
}

/** "18:50 학교에서 출발 · 20분" */
export function departureText(d: Departure, places: readonly Place[]): string {
  const name = d.from ? places.find((p) => p.id === d.from)?.name : null;
  return `${hm(d.at)} ${name ? `${name}에서 ` : ""}출발 · ${duration(d.minutes)}`;
}

// ------------------------------------------------------------ 열 만들기

type Band = Extract<Segment, { kind: "prep" | "travel" }>;

/** 일정과 칸을 나눌 때 이동 띠 칸의 폭 무게 (일정 1). 목업의 늦음 띠 42% : 일정 58% */
const BAND_WEIGHT = 0.72;
type Meal = Extract<Segment, { kind: "meal" }>;

/** 한 열에 그리는 것. start/end 는 그 열 날짜 기준 분(0~1440) */
export type GridItem =
  | { kind: "ev"; id: string; occ: Occurrence; start: number; end: number; cutTop: boolean; cutBottom: boolean }
  | { kind: "band"; id: string; seg: Band; start: number; end: number; cutTop: boolean; cutBottom: boolean }
  | { kind: "meal"; id: string; seg: Meal; start: number; end: number };

export type DayColumn = {
  date: DateStr;
  /** 일정·준비·이동은 겹치면 칸을 나눈다. 식사는 늘 한 칸 */
  items: Laid<GridItem>[];
  allDay: Occurrence[];
  missing: ("lunch" | "dinner")[];
};

/** 기간의 회차 + 하루 계산 → 날짜 열. 자정을 넘는 것은 두 열로 나눈다 */
export function buildColumns(dates: readonly DateStr[], occs: readonly Occurrence[], days: readonly DayPlan[]): DayColumn[] {
  const cols = new Map<DateStr, { lane: GridItem[]; meals: GridItem[]; allDay: Occurrence[]; missing: ("lunch" | "dinner")[] }>();
  for (const d of dates) cols.set(d, { lane: [], meals: [], allDay: [], missing: [] });

  for (const o of occs) {
    if (o.all_day || o.start_min === null || o.end_min === null) {
      cols.get(o.date)?.allDay.push(o);
      continue;
    }
    for (const p of splitAtMidnight(o.date, o.start_min, o.end_min)) {
      cols.get(p.date)?.lane.push({ kind: "ev", id: `${o.key}@${p.date}`, occ: o, start: p.start, end: p.end, cutTop: p.cutTop, cutBottom: p.cutBottom });
    }
  }
  for (const day of days) {
    for (const s of day.segments) {
      if (s.kind === "meal_missing") {
        cols.get(s.date)?.missing.push(s.meal);
      } else if (s.kind === "meal") {
        cols.get(s.date)?.meals.push({ kind: "meal", id: `meal:${s.date}:${s.meal}`, seg: s, start: s.start, end: s.end });
      } else {
        // 늦는 이동은 앞 일정이 끝난 뒤 출발한 모양으로 그린다 (도착이 늦은 만큼 다음 일정과 겹친다)
        const late = s.kind === "travel" ? s.late : 0;
        for (const p of splitAtMidnight(s.date, s.start + late, s.end + late)) {
          const id = `${s.kind}:${s.date}:${s.start}@${p.date}`;
          cols.get(p.date)?.lane.push({ kind: "band", id, seg: s, start: p.start, end: p.end, cutTop: p.cutTop, cutBottom: p.cutBottom });
        }
      }
    }
  }
  return dates.map((date) => {
    const c = cols.get(date)!;
    return {
      date,
      items: [...c.meals.map((item) => ({ item, lane: 0, lanes: 1, left: 0, width: 1 })), ...layoutLanes(c.lane, (t) => (t.kind === "band" ? BAND_WEIGHT : 1))],
      allDay: c.allDay,
      missing: c.missing,
    };
  });
}

/** 열들에 그리는 것의 시간 조각 (시간 범위 계산용) */
export function spansOf(cols: readonly DayColumn[]): { start: number; end: number }[] {
  return cols.flatMap((c) => c.items.map((l) => ({ start: l.item.start, end: l.item.end })));
}

// ------------------------------------------------------------ 오류 문구

/** 일정·지점 쪽 DB 오류를 화면 문구로. 나머지는 toKorean */
export function scheduleKorean(err: unknown, authMessage?: string): KoreanError {
  const o = typeof err === "object" && err !== null ? (err as { message?: unknown; details?: unknown }) : null;
  const text = o ? `${String(o.message ?? "")} ${String(o.details ?? "")}` : String(err);
  if (text.includes("ez_places_home_unique")) return { code: "HOME_TAKEN", message: "집은 하나만 둘 수 있습니다. 다른 지점의 역할을 먼저 바꾸세요" };
  if (text.includes("ez_places_name_unique")) return { code: "NAME_TAKEN", message: "같은 이름의 지점이 있습니다" };
  if (text.includes("ez_places_name_check")) return { code: "BAD_NAME", message: "지점 이름은 앞뒤 공백 없이 1~30자입니다" };
  if (text.includes("ez_events_task_unique")) return { code: "TASK_TAKEN", message: "이 할 일은 이미 일정이 있습니다" };
  if (text.includes("ez_travel_minutes_check")) return { code: "BAD_TRAVEL", message: "이동시간은 1~600분입니다" };
  if (text.includes("ez_schedule_settings_")) return { code: "BAD_SETTINGS", message: "설정 값이 범위를 벗어났습니다 (준비·식사 0~120분, 집 들르기 0~600분)" };
  const k = toKorean(err, { authMessage });
  if (k.code === "EZ_VERSION") return { code: k.code, message: "방금 다른 곳에서 이 일정을 고쳤습니다" };
  return k;
}

// ------------------------------------------------------------ 고치기 (수정 칸 · 미리보기 · 저장 방법)

/** 수정 칸의 값. 시간은 분(끝은 1440 을 넘을 수 있음), 글 칸은 빈 글자 = 없음 */
export type Draft = {
  title: string;
  date: DateStr;
  allDay: boolean;
  start: number;
  end: number;
  place_id: string | null;
  repeat: Repeat;
  note: string;
  where_text: string;
  /** 이동시간 직접 입력 (빈 글자 = 표를 따름) */
  travel: string;
};

/** 새 일정 미리보기 줄의 id */
export const DRAFT_ID = "draft";

export function newDraft(date: DateStr, start: number, end: number): Draft {
  return { title: "", date, allDay: false, start, end, place_id: null, repeat: null, note: "", where_text: "", travel: "" };
}

export function draftOf(o: Occurrence, ev: EventRow): Draft {
  return {
    title: o.title,
    date: o.date,
    allDay: o.all_day,
    start: o.start_min ?? 540,
    end: o.end_min ?? 600,
    place_id: o.place_id,
    repeat: ev.repeat,
    note: o.note ?? "",
    where_text: o.where_text ?? "",
    travel: o.travel_min === null ? "" : String(o.travel_min),
  };
}

const orNull = (s: string) => (s.trim() === "" ? null : s);

/** 수정 칸 → 일정 칸 (할 일 연결은 따로) */
export function draftInput(d: Draft): Omit<EventInput, "task_id"> {
  const t = d.travel.trim();
  return {
    title: d.title.trim(),
    date: d.date,
    start_min: d.allDay ? null : d.start,
    end_min: d.allDay ? null : d.end,
    place_id: d.place_id,
    where_text: orNull(d.where_text),
    travel_min: t === "" ? null : Number(t),
    note: orNull(d.note),
    repeat: d.repeat,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** base 에서 바뀐 칸만. 시작·끝은 같이 */
export function draftChanges(d: Draft, base: Draft): Partial<Omit<EventInput, "task_id">> {
  const a = draftInput(d);
  const b = draftInput(base);
  const out: Partial<Omit<EventInput, "task_id">> = {};
  for (const k of Object.keys(a) as (keyof typeof a)[]) {
    if (!same(a[k], b[k])) (out as Record<string, unknown>)[k] = a[k];
  }
  if ("start_min" in out || "end_min" in out) {
    out.start_min = a.start_min;
    out.end_min = a.end_min;
  }
  return out;
}

export function ruleChanged(d: Draft, base: Draft): boolean {
  return !same(d.repeat, base.repeat);
}

export type Scope = "once" | "following";

/** 저장할 때 고를 수 있는 범위. 반복이 아니면 빈 목록(그냥 저장). 반복 규칙을 바꾸면 '이후 모두' 만 */
export function scopesFor(d: Draft, base: Draft, ev: EventRow | null): Scope[] {
  if (!ev || ev.repeat === null) return [];
  return ruleChanged(d, base) ? ["following"] : ["once", "following"];
}

export type SavePlan =
  | { kind: "none" }
  | { kind: "create"; input: Omit<EventInput, "task_id"> }
  | { kind: "update"; patch: Partial<EventInput> }
  | { kind: "once"; patch: ExceptionPatch }
  | { kind: "following"; patch: SplitPatch };

const EXCEPTION_KEYS = ["date", "start_min", "end_min", "title", "place_id", "where_text", "travel_min", "note"] as const;

/**
 * 어떻게 저장할지. ev = 고치는 일정 줄(새 일정이면 null), prev = 그 회차에 이미 있던 '이번만' patch.
 * '이후 모두' 로 날짜를 옮기면 매주 반복의 요일도 같이 민다(규칙을 직접 바꾸지 않았을 때)
 */
export function savePlan(d: Draft, base: Draft, ev: EventRow | null, scope: Scope | null, prev: ExceptionPatch | null = null): SavePlan {
  if (!ev) return { kind: "create", input: draftInput(d) };
  const ch = draftChanges(d, base);
  if (Object.keys(ch).length === 0) return { kind: "none" };
  if (ev.repeat === null) return { kind: "update", patch: ch };
  if (scope === "once" && !ruleChanged(d, base)) {
    const patch: ExceptionPatch = { ...(prev ?? {}) };
    for (const k of EXCEPTION_KEYS) if (k in ch) (patch as Record<string, unknown>)[k] = ch[k];
    return { kind: "once", patch };
  }
  const patch: SplitPatch = {};
  for (const k of EXCEPTION_KEYS) if (k in ch) (patch as Record<string, unknown>)[k] = ch[k];
  if (ruleChanged(d, base)) patch.repeat = d.repeat;
  else if (ch.date && ev.repeat.freq === "weekly") {
    patch.repeat = { ...ev.repeat, days: shiftDays(ev.repeat.days, daysBetween(base.date, ch.date)) };
  }
  return { kind: "following", patch };
}

/**
 * 고치는 중인 값을 줄에 얹은 미리보기 (동선·식사가 같이 따라 움직인다).
 * target 이 null 이면 새 일정 줄(DRAFT_ID)을 더한다. 반복 회차는 '이번만' 처럼 예외로 얹는다(규칙 변경은 저장 뒤에 보인다)
 */
export function withDraft(rows: EventRows, target: { event_id: string; on_date: DateStr } | null, d: Draft, taskId: string | null = null): EventRows {
  const input = draftInput(d);
  const title = input.title || "(제목 없음)";
  if (!target) {
    const row: EventRow = {
      id: DRAFT_ID,
      ...input,
      title,
      source: null,
      external_id: null,
      task_id: taskId,
      origin_kind: null,
      origin_id: null,
      version: 0,
      updated_at: "",
    };
    return { events: [...rows.events, row], exceptions: rows.exceptions };
  }
  const ev = rows.events.find((e) => e.id === target.event_id);
  if (!ev) return rows;
  if (ev.repeat === null) {
    return { events: rows.events.map((e) => (e.id === ev.id ? { ...e, ...input, title } : e)), exceptions: rows.exceptions };
  }
  const old = rows.exceptions.find((x) => x.event_id === ev.id && x.on_date === target.on_date);
  const patch: ExceptionPatch = { ...(old?.patch ?? {}) };
  for (const k of EXCEPTION_KEYS) (patch as Record<string, unknown>)[k] = k === "title" ? title : input[k];
  return {
    events: rows.events,
    exceptions: [...rows.exceptions.filter((x) => x !== old), { event_id: ev.id, on_date: target.on_date, skip: false, patch }],
  };
}

/** 반복 일정의 첫 회차 (매주는 시작 날짜 요일이 days 에 없을 수 있다). ez_first_on 과 같다 */
export function firstOccurrence(ev: EventRow): DateStr {
  for (let k = 0; k < 7; k++) {
    const d = addDays(ev.date, k);
    if (occursOn(ev, d)) return d;
  }
  return ev.date;
}
