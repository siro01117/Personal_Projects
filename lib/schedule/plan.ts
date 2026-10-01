// 하루 동선·외출 준비·식사 계산 (docs/일정.md 3장). 라칸에서 쓰던 동작과 같게 맞춘다.

import { addDays, dateRange } from "./dates";
import { compareOccurrences, expand, spillsOver } from "./expand";
import { busyOf, gaps, type Slot } from "./free";
import type {
  Carry,
  DateStr,
  DayPlan,
  EventException,
  EventRow,
  MealWindow,
  Occurrence,
  Place,
  Segment,
  Settings,
  Travel,
  TravelLabel,
} from "./types";

/** 이 말이 제목에 있는 회차가 창에 걸치면 그 끼니는 채운 것으로 본다 */
export const MEAL_WORDS = /밥|식사|회식|점심|저녁|브런치|런치|디너|맛집|뒤풀이/;
/** 이보다 짧은 빈 조각에는 식사를 넣지 않는다 */
export const MEAL_MIN_PIECE = 20;
/** 비키기 되풀이 상한 */
const DODGE_TRIES = 20;

function travelTable(travel: Travel[]): (a: string | null, b: string | null) => number {
  const m = new Map<string, number>();
  for (const t of travel) m.set(t.a < t.b ? `${t.a}\n${t.b}` : `${t.b}\n${t.a}`, t.minutes);
  return (a, b) => {
    if (!a || !b || a === b) return 0;
    return m.get(a < b ? `${a}\n${b}` : `${b}\n${a}`) ?? 0; // 표에 없으면 0 (지어내지 않음)
  };
}

function labelFor(p: Place | null): TravelLabel {
  if (p?.role === "work") return "출근";
  if (p?.role === "school") return "등교";
  if (p?.role === "home") return "귀가";
  return "이동";
}

/** 나오는 이동: 출발 뒤 시작해 겹치는 떠 있는 일정이 있으면 그 끝으로 미룬다. 상한을 넘으면 원래 자리 */
function dodgeOut(dep0: number, mins: number, limit: number, floating: Slot[]): Slot {
  let dep = dep0;
  for (let i = 0; i < DODGE_TRIES; i++) {
    const hit = floating.filter((f) => f.start >= dep && f.start < dep + mins);
    if (hit.length === 0) break;
    dep = Math.max(...hit.map((f) => f.end));
  }
  if (dep + mins > limit) dep = dep0;
  return { start: dep, end: dep + mins };
}

/** 들어가는 이동: [도착−이동−준비, 도착) 과 겹치고 도착 전에 끝나는 떠 있는 일정이 있으면 도착을 그 시작으로 당긴다 */
function dodgeIn(arrive0: number, lead: number, floor: number, floating: Slot[]): number {
  let arrive = arrive0;
  for (let i = 0; i < DODGE_TRIES; i++) {
    const lo = arrive - lead;
    const hit = floating.filter((f) => f.start < arrive && f.end > lo && f.end <= arrive);
    if (hit.length === 0) break;
    arrive = Math.min(...hit.map((f) => f.start));
  }
  return arrive !== arrive0 && arrive - lead < floor ? arrive0 : arrive;
}

function pickMeal(w: MealWindow, busy: Slot[], mealMin: number): Slot | null {
  let best: { slot: Slot; cost: number } | null = null;
  for (const g of gaps(w.from, w.to, busy)) {
    const len = Math.min(mealMin, g.end - g.start);
    if (len < MEAL_MIN_PIECE) continue;
    const clamp = (x: number) => Math.min(Math.max(x, g.start), g.end - len);
    const start = clamp(Math.round(clamp(w.prefer) / 5) * 5);
    const cost = (len < mealMin ? 1000 : 0) + Math.abs(start - w.prefer);
    if (!best || cost < best.cost) best = { slot: { start, end: start + len }, cost };
  }
  return best?.slot ?? null;
}

/**
 * 하루 계산. occs 는 그날 회차들 (전날 자정을 넘긴 회차를 섞어 줘도 된다 — date 로 가려 바쁜 구간으로만 쓴다).
 * carryIn 은 전날 계산의 carry. 첫날이면 null.
 */
export function planDay(
  date: DateStr,
  occs: Occurrence[],
  places: Place[],
  travel: Travel[],
  settings: Settings,
  carryIn: Carry,
): DayPlan {
  const live = new Map(places.filter((p) => !p.deleted).map((p) => [p.id, p]));
  const home = [...live.values()].find((p) => p.role === "home") ?? null;
  const tmin = travelTable(travel);

  const timed = occs
    .filter((o) => o.date === date && !o.all_day && o.start_min !== null && o.end_min !== null)
    .sort(compareOccurrences);
  const placeOf = (o: Occurrence) => (o.place_id ? (live.get(o.place_id) ?? null) : null);
  const routed = (o: Occurrence) => placeOf(o) !== null || (o.travel_min ?? 0) > 0;
  const floating: Slot[] = timed.filter((o) => !routed(o)).map((o) => ({ start: o.start_min!, end: o.end_min! }));

  const prepOn = settings.prep_first > 0;
  const prepAgain = prepOn ? settings.prep_again : 0;
  const homeFrom = carryIn?.home_from ?? 0;
  const segs: Segment[] = [];

  let loc: string | null = home?.id ?? null;
  let wentOut = false;
  /** 앞 지점 있는 일정의 끝 */
  let prevEnd: number | null = null;
  /** 들어가는 이동을 당길 수 있는 가장 이른 시각 (앞 일정 끝, 집 들렀으면 귀가 끝, 첫이면 전날 귀가) */
  let floor = homeFrom;

  for (const o of timed) {
    if (!routed(o)) continue;
    const start = o.start_min!;
    const dest = placeOf(o);

    // 집 들르기
    if (home && loc !== home.id && dest && dest.id !== home.id && prevEnd !== null) {
      const back = tmin(loc, home.id);
      const again = tmin(home.id, dest.id);
      if (back > 0 && again > 0 && start - prevEnd - (back + prepAgain + again) >= settings.home_stay) {
        const r = dodgeOut(prevEnd, back, start - again - prepAgain, floating);
        segs.push({ kind: "travel", date, ...r, label: "귀가", from: loc, to: home.id, for_key: null, late: 0 });
        loc = home.id;
        floor = r.end;
      }
    }

    // 들어가는 이동 (+ 준비)
    const mins = (o.travel_min ?? 0) > 0 ? o.travel_min! : tmin(loc, dest?.id ?? null);
    // 집에서 하는 일정으로 가는 귀가는 앞 일정이 끝나자마자 출발한다 (밖에서 기다렸다 가지 않는다)
    if (home && dest?.id === home.id && loc !== home.id && prevEnd !== null && mins > 0) {
      const r = dodgeOut(prevEnd, mins, start, floating);
      segs.push({ kind: "travel", date, ...r, label: "귀가", from: loc, to: home.id, for_key: o.key, late: Math.max(0, r.end - start) });
      loc = home.id;
      prevEnd = o.end_min!;
      floor = prevEnd;
      continue;
    }

    let prep = 0;
    if (home && loc === home.id && (!dest || dest.id !== home.id)) {
      prep = prepOn ? (wentOut ? prepAgain : settings.prep_first) : 0;
      wentOut = true;
    }
    if (mins > 0 || prep > 0) {
      const arrive = dodgeIn(start, mins + prep, floor, floating);
      const go = arrive - mins;
      let late = 0;
      if (prevEnd !== null) late = Math.max(0, prevEnd - go);
      else if (homeFrom > 0) late = Math.max(0, homeFrom - (go - prep));
      if (prep > 0) segs.push({ kind: "prep", date, start: go - prep, end: go });
      if (mins > 0) {
        segs.push({ kind: "travel", date, start: go, end: arrive, label: labelFor(dest), from: loc, to: dest?.id ?? null, for_key: o.key, late });
      }
    }

    if (dest) loc = dest.id; // travel_min 만 있는 일정은 위치를 안 바꾼다
    prevEnd = o.end_min!;
    floor = prevEnd;
  }

  // 마지막 귀가 (자정을 넘어도 그대로 두고 다음 날로 넘긴다)
  let homeFromNext = 0;
  if (home && loc !== home.id && prevEnd !== null) {
    const r = dodgeOut(prevEnd, tmin(loc, home.id), 2880, floating);
    if (r.end > r.start) segs.push({ kind: "travel", date, ...r, label: "귀가", from: loc, to: home.id, for_key: null, late: 0 });
    homeFromNext = Math.max(0, r.end - 1440);
  }

  // 식사: 점심 먼저, 그 자리를 막고 저녁
  if (settings.meal_min > 0 && timed.length > 0) {
    const busy = busyOf({ date, segments: segs, carry: null }, occs);
    for (const meal of ["lunch", "dinner"] as const) {
      const w = settings[meal];
      if (timed.some((o) => MEAL_WORDS.test(o.title) && o.start_min! < w.to && o.end_min! > w.from)) continue;
      const slot = pickMeal(w, busy, settings.meal_min);
      if (slot) {
        segs.push({ kind: "meal", date, meal, ...slot, short: slot.end - slot.start < settings.meal_min });
        busy.push(slot);
      } else {
        segs.push({ kind: "meal_missing", date, meal });
      }
    }
  }

  const at = (s: Segment) => (s.kind === "meal_missing" ? Infinity : s.start);
  const segments = segs.filter((s) => s.kind === "meal_missing" || s.end > s.start).sort((a, b) => at(a) - at(b));
  return { date, segments, carry: { home_from: homeFromNext } };
}

/**
 * 기간 계산. 범위 앞 하루를 더 계산해 자정 넘김 상태를 이어받는다.
 * occurrences 는 expand(from, to) 와 같다 (from 전날 자정을 넘어오는 회차 포함).
 */
export function planRange(
  from: DateStr,
  to: DateStr,
  events: EventRow[],
  exceptions: EventException[],
  places: Place[],
  travel: Travel[],
  settings: Settings,
): { occurrences: Occurrence[]; days: DayPlan[] } {
  const before = addDays(from, -1);
  const all = expand(events, exceptions, before, to);
  const days: DayPlan[] = [];
  let carry: Carry = null;
  for (const d of dateRange(before, to)) {
    const prev = addDays(d, -1);
    const day = planDay(d, all.filter((o) => o.date === d || o.date === prev), places, travel, settings, carry);
    carry = day.carry;
    if (d >= from) days.push(day);
  }
  const occurrences = all.filter((o) => o.date >= from || (o.date === before && spillsOver(o)));
  return { occurrences, days };
}
