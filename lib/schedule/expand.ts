// 반복 + 예외 → 보는 기간의 회차 목록 (docs/일정.md 3장 '회차 펼치기').

import { addDays, dateRange, maxDate, minDate, weekday } from "./dates";
import type { DateStr, EventException, EventRow, ExceptionPatch, Occurrence } from "./types";

/** 그날이 이 일정의 회차가 생기는 날인지 (예외는 안 본다) */
export function occursOn(ev: EventRow, d: DateStr): boolean {
  if (d < ev.date) return false;
  const r = ev.repeat;
  if (!r) return d === ev.date;
  if (r.until && d > r.until) return false;
  if (r.freq === "daily") return true;
  return r.days.includes(weekday(d));
}

function build(ev: EventRow, onDate: DateStr, patch: ExceptionPatch | null): Occurrence {
  const p = patch ?? {};
  const start = "start_min" in p ? (p.start_min ?? null) : ev.start_min;
  const end = "end_min" in p ? (p.end_min ?? null) : ev.end_min;
  return {
    key: `${ev.id}:${onDate}`,
    event_id: ev.id,
    on_date: onDate,
    date: p.date ?? onDate,
    start_min: start,
    end_min: end,
    all_day: start === null || end === null,
    title: p.title ?? ev.title,
    place_id: "place_id" in p ? (p.place_id ?? null) : ev.place_id,
    where_text: "where_text" in p ? (p.where_text ?? null) : ev.where_text,
    travel_min: "travel_min" in p ? (p.travel_min ?? null) : ev.travel_min,
    note: "note" in p ? (p.note ?? null) : ev.note,
    source: ev.source,
    task_id: ev.task_id,
    repeating: ev.repeat !== null,
    changed: patch !== null,
    version: ev.version,
  };
}

/** 자정을 넘겨 다음 날까지 이어지는 회차 */
export function spillsOver(o: Occurrence): boolean {
  return !o.all_day && (o.end_min ?? 0) > 1440;
}

/** 정렬: 날짜, 종일 먼저, 시작, 제목 */
export function compareOccurrences(a: Occurrence, b: Occurrence): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
  const sa = a.start_min ?? 0;
  const sb = b.start_min ?? 0;
  if (sa !== sb) return sa - sb;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * from~to 에 그릴 회차. from 전날 시작해 자정을 넘어오는 회차도 넣는다(화면이 둘째 날에 그린다).
 * 예외는 반복 일정에만 적용하고, on_date 가 실제 회차 날이 아니면 무시한다.
 * 다른 날로 옮긴 회차는 원래 날짜가 기간 밖이어도 옮긴 날이 기간 안이면 나온다.
 */
export function expand(events: EventRow[], exceptions: EventException[], from: DateStr, to: DateStr): Occurrence[] {
  const scanFrom = addDays(from, -1);
  const exByKey = new Map<string, EventException>();
  for (const x of exceptions) exByKey.set(`${x.event_id}:${x.on_date}`, x);

  const inRange = (o: Occurrence) => (o.date >= from && o.date <= to) || (o.date === scanFrom && spillsOver(o));
  const out: Occurrence[] = [];

  for (const ev of events) {
    const last = ev.repeat?.until ? minDate(to, ev.repeat.until) : to;
    const first = maxDate(scanFrom, ev.date);
    const days = ev.repeat ? (first <= last ? dateRange(first, last) : []) : [ev.date];
    for (const d of days) {
      if (!occursOn(ev, d)) continue;
      const x = ev.repeat ? exByKey.get(`${ev.id}:${d}`) : undefined;
      if (x?.skip) continue;
      const patch = x?.patch ?? null;
      if (patch?.date && patch.date !== d) continue; // 옮긴 회차는 아래에서
      const o = build(ev, d, patch);
      if (inRange(o)) out.push(o);
    }
  }

  // 다른 날로 옮긴 회차
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const x of exceptions) {
    if (x.skip || !x.patch?.date || x.patch.date === x.on_date) continue;
    const ev = byId.get(x.event_id);
    if (!ev?.repeat || !occursOn(ev, x.on_date)) continue;
    const o = build(ev, x.on_date, x.patch);
    if (inRange(o)) out.push(o);
  }

  return out.sort(compareOccurrences);
}
