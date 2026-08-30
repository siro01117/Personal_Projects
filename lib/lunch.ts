// 도시락(월 단위 선신청) 공용 — 서버·클라 공용. 일렉트론 도시락앱의 신청서 체계를 그대로 이식.
// 신청서 = 주차 × 월~토 그리드, 각 날짜에 중식/석식 행. 일요일은 폼에서 제외.
import { holidayLabel } from "./holidays";

export type MealType = "lunch" | "dinner";

export type LunchMonth = {
  id: string; year: number; month: number;
  lunch_label: string; lunch_price: number;
  dinner_label: string; dinner_price: number;
  notice: string | null;
};

// 휴무 정보(오버라이드 행). null = 기본값(영업/자동휴무) 그대로.
export type Closure = { date: string; lunch_closed: boolean; dinner_closed: boolean; label: string | null };
export type EffClosure = { lunch_closed: boolean; dinner_closed: boolean; label: string };

export type GridDay = {
  iso: string;      // YYYY-MM-DD
  day: number;      // 1..31
  dow: number;      // 0=일 … 6=토
  isSat: boolean;
  isSun: boolean;
} | null;

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();

/** 월~일 7열 주(週) 그리드. 폼은 앞 6열(월~토)만 사용, 일요일 열은 렌더에서 버린다. */
export function monthGrid(year: number, month: number): GridDay[][] {
  const firstDow = new Date(year, month - 1, 1).getDay(); // 0=일..6=토
  const monIndex = (firstDow + 6) % 7;                    // 0=월..6=일
  const dim = daysInMonth(year, month);
  const cells: GridDay[] = [];
  for (let i = 0; i < monIndex; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    cells.push({ iso: isoDate(year, month, d), day: d, dow, isSat: dow === 6, isSun: dow === 0 });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: GridDay[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

/** 기본 휴무: 일요일=전체휴무, 공휴일=전체휴무, 토요일=석식만 휴무, 그 외=영업(null). */
export function defaultClosure(iso: string, dow: number): EffClosure | null {
  if (dow === 0) return { lunch_closed: true, dinner_closed: true, label: "" };
  const h = holidayLabel(iso);
  if (h) return { lunch_closed: true, dinner_closed: true, label: h };
  if (dow === 6) return { lunch_closed: false, dinner_closed: true, label: "" };
  return null;
}

/** iso로부터 요일 계산(UTC 기준, TZ 무관). */
export const dowOf = (iso: string) => new Date(iso + "T00:00:00Z").getUTCDay();

/** 오버라이드 우선, 없으면 기본값. 라벨은 오버라이드에 없으면 공휴일명 승계. */
export function effectiveClosure(iso: string, dow: number, overrides: Map<string, Closure>): EffClosure | null {
  const ov = overrides.get(iso);
  if (ov) {
    const def = defaultClosure(iso, dow);
    return { lunch_closed: ov.lunch_closed, dinner_closed: ov.dinner_closed, label: ov.label || def?.label || "" };
  }
  return defaultClosure(iso, dow);
}

/** 그 날 그 끼니가 신청 가능(영업)한가. */
export function mealAvailable(iso: string, dow: number, meal: MealType, overrides: Map<string, Closure>): boolean {
  const eff = effectiveClosure(iso, dow, overrides);
  if (!eff) return true;
  return meal === "lunch" ? !eff.lunch_closed : !eff.dinner_closed;
}

// ---- 신청 마감 판정(순수 함수 — 클라·서버 공용, 반드시 같은 결과를 내야 한다) ----
// 규칙: 그 날짜의 중식/석식은 그 날 오전 8시(KST) 이후로는 신청도 취소도 불가(지난 날짜 포함).
// 오늘이고 8시 전이면 아직 편집 가능. meal 파라미터는 지금은 결과에 영향 없음(중/석식 같은 컷오프)
// 이지만, 끼니별로 다른 컷오프가 생길 수 있어 시그니처에 남겨둔다.
export const MEAL_LOCK_HOUR_MIN = 8 * 60; // 오전 8시(분)
export function mealLocked(iso: string, _meal: MealType, todayIso: string, nowKstMin: number): boolean {
  if (iso < todayIso) return true;
  if (iso === todayIso) return nowKstMin >= MEAL_LOCK_HOUR_MIN;
  return false;
}

// ---- 다음 달 신청 개방 판정(순수 함수) ----
// 매월 25일(KST) 0시부터 다음 달 탭이 열린다. todayIso = "YYYY-MM-DD".
export function nextMonthOpenDay(todayIso: string): boolean {
  return Number(todayIso.slice(8, 10)) >= 25;
}

/** 연·월의 다음 달(연도 넘어감 처리 포함). */
export function nextYm(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export const monthLabel = (y: number, m: number) => `${y}년 ${m}월`;
export const won = (n: number) => n.toLocaleString("ko-KR") + "원";
export const noticeLines = (notice: string | null | undefined): string[] =>
  (notice ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

// 첫 달 생성 시 기본 주의사항 (도시락앱 DEFAULT_NOTICE 이식).
export const DEFAULT_NOTICE = `도시락은 완전 신청제로 운영되며 당일 신청은 불가합니다.
결제는 선불입니다.
신청한 도시락을 먹지 않았더라도 환불이 되지 않습니다.
도시락 취소는 일주일 전 까지 가능합니다.
결제는 카운터에 문의 해주세요.`;
