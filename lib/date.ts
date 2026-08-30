// 날짜 키(YYYY-MM-DD)는 항상 한국시간(KST) 기준으로 계산한다.
// 서버는 Vercel에서 UTC로 도는데, 그냥 new Date().getDate() 를 쓰면
// KST 자정~오전 9시 사이엔 UTC가 아직 '어제'라 하루가 어긋난다
// (출결·순찰·벌점이 잘못된 날짜에 기록되고, 요일 탭도 밀린다).
// Intl 로 KST 날짜 부품을 직접 뽑으면 서버 TZ와 무관하게 정확하다.

const KST = "Asia/Seoul";

/** KST 기준 오늘 "YYYY-MM-DD" (en-CA 로케일이 이 포맷을 준다) */
export function todayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: KST }).format(now);
}

/** "YYYY-MM-DD" 문자열의 요일 (0=일 … 6=토). 날짜만 다루므로 TZ 무관. */
export function weekdayOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** KST 기준 이번 주 월요일 "YYYY-MM-DD" — 벌점은 매주 월요일 리셋. */
export function weekStartKey(now: Date = new Date()): string {
  const today = todayKey(now);
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();            // 0=일 … 6=토
  const diff = day === 0 ? 6 : day - 1;  // 월요일까지 되돌릴 일수
  dt.setUTCDate(dt.getUTCDate() - diff);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** weekStart(월) 기준 이번 주 7일. wd = 요일 라벨, dayNum = 날짜. */
const WD = ["일", "월", "화", "수", "목", "금", "토"];
export function weekDays(weekStart: string): { key: string; wd: string; dayNum: number }[] {
  const [y, m, d] = weekStart.split("-").map(Number);
  return Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    return {
      key: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`,
      wd: WD[dt.getUTCDay()],
      dayNum: dt.getUTCDate(),
    };
  });
}

/** timestamptz 문자열 → KST 기준 "HH:MM"(24시간제). 서버에서 미리 포맷해 클라로 내려주기 위함
 * (클라 렌더에서 new Date()/toLocale* 호출 금지 — 좌석 배치도의 "순찰 20:12 · 자리비움" 같은 title 용). */
export function timeLabel(at: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: KST, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(at));
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

/** timestamptz 문자열 → KST 기준 "M월 D일 HH:MM"(제출 목록 등에서 날짜+시각을 함께 보일 때).
 *  클라 렌더에서 new Date()/toLocale* 호출 금지 원칙 — 서버에서 미리 문자열로 내려준다. */
export function dateTimeLabel(at: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: KST, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}월 ${get("day")}일 ${get("hour")}:${get("minute")}`;
}

/** timestamptz 문자열 → KST 기준 "M월 D일"(시각 없이 날짜만). 스케쥴 입력 기간의 "다음 입력 기간:
 *  8월 20일부터" 처럼 날짜만 필요할 때(src/lib/schedule-window.ts). 클라 렌더에서 new Date() 호출 금지
 *  원칙 — 반드시 서버에서만 호출. */
export function dateOnlyLabel(at: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: KST, month: "numeric", day: "numeric" }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}월 ${get("day")}일`;
}

/** timestamptz 문자열 → KST 기준 자정부터의 경과분(0..1439). schedule.ts statusAt() 에 실제 출결
 * (firstInMin/lastOutMin)을 넘기기 전 서버에서 변환하는 용도(클라 렌더에서 new Date() 호출 금지 원칙 —
 * 이 값은 반드시 서버 컴포넌트/서버 액션에서만 계산해 내려준다). */
export function minuteOfKST(at: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: KST, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(at));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/** "YYYY-MM-DD" 에 일수를 더/빼기(음수 가능). 날짜 문자열만 다루므로 TZ 무관. */
export function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** 날짜 이동 UI용 짧은 라벨 — 오늘이면 "오늘", 아니면 "8월 11일". */
export function dayLabel(key: string, today: string): string {
  if (key === today) return "오늘";
  const [, m, d] = key.split("-").map(Number);
  return `${m}월 ${d}일`;
}

/** Date → KST 기준 datetime-local 입력값("YYYY-MM-DDTHH:mm", 초 없음). 관리 화면의 시작·종료 일시
 *  입력에 "오늘"을 기본값으로 채워줄 때 쓴다 — 클라에서 new Date()(무인자)로 만들면 서버가 KST 가
 *  아닌 환경(UTC 등)에서 날짜가 하루 밀릴 수 있으므로 반드시 서버에서 계산해 문자열로 내려준다. */
export function kstDateTimeLocal(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** 주 시작 라벨 "7월 20일 (월)" — KST 날짜 문자열 기준. */
export function weekStartLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  // 정오 UTC 로 만들어 로케일 변환 시 날짜가 밀리지 않게 한다.
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("ko-KR", {
    timeZone: KST, month: "long", day: "numeric", weekday: "short",
  });
}
