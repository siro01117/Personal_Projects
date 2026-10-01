// 'YYYY-MM-DD' 날짜 문자열 연산. 시간대 영향이 없게 UTC 로만 계산한다.

import type { DateStr } from "./types";

const DAY_MS = 86_400_000;
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' 이고 달력에 있는 날짜인지 (2026-02-30 은 아님) */
export function isDateStr(s: unknown): s is DateStr {
  if (typeof s !== "string") return false;
  const m = SHAPE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function toMs(d: DateStr): number {
  if (!isDateStr(d)) throw new Error(`날짜 형식이 아닙니다 (YYYY-MM-DD): ${String(d)}`);
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day);
}

function fromMs(ms: number): DateStr {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: DateStr, n: number): DateStr {
  return fromMs(toMs(d) + n * DAY_MS);
}

/** 요일. 1=월 … 7=일 */
export function weekday(d: DateStr): number {
  const w = new Date(toMs(d)).getUTCDay(); // 0=일
  return w === 0 ? 7 : w;
}

/** b − a (일) */
export function daysBetween(a: DateStr, b: DateStr): number {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

/** from 부터 to 까지 (둘 다 포함). from > to 면 빈 목록 */
export function dateRange(from: DateStr, to: DateStr): DateStr[] {
  const out: DateStr[] = [];
  const end = toMs(to);
  for (let t = toMs(from); t <= end; t += DAY_MS) out.push(fromMs(t));
  return out;
}

/** a < b → -1, 같으면 0, a > b → 1 */
export function compareDates(a: DateStr, b: DateStr): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: DateStr, b: DateStr): DateStr {
  return a <= b ? a : b;
}

export function maxDate(a: DateStr, b: DateStr): DateStr {
  return a >= b ? a : b;
}
