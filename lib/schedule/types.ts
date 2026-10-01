// 일정·플래너가 같이 쓰는 모양 (docs/일정.md 2·3장, docs/플래너.md 2장).
// lib/schedule 의 계산 함수, DB 행, MCP, 웹이 모두 이 타입을 쓴다. 바꾸면 네 곳이 같이 바뀐다.
//
// 시간 표기: 날짜는 'YYYY-MM-DD'(Asia/Seoul 현지 날짜), 시각은 그 날짜 0시부터 센 분.
// 한 일정의 end_min 은 1440 을 넘을 수 있다(다음 날 끝남, 최대 start_min + 1440).
// 계산 결과(Segment)의 start/end 도 그 날짜 기준 분이라 1440 을 넘을 수 있다. 화면이 두 열로 나눠 그린다.

export type DateStr = string;

export const PLACE_ROLES = ["home", "work", "school"] as const;
export type PlaceRole = (typeof PLACE_ROLES)[number];

/** 지점 심볼 — 정해진 12개. 기본은 역할에서 (home→home, school→school, work→work, 없음→pin) */
export const PLACE_SYMBOLS = ["home", "school", "work", "cafe", "book", "gym", "hospital", "cart", "people", "building", "tree", "pin"] as const;
export type PlaceSymbol = (typeof PLACE_SYMBOLS)[number];

/** 지점 색 — 옅은 8색. 만들 때 아직 안 쓴 색부터 */
export const PLACE_COLORS = ["sky", "violet", "peach", "sand", "mint", "pink", "teal", "yellow"] as const;
export type PlaceColor = (typeof PLACE_COLORS)[number];

export type Place = {
  id: string;
  name: string;
  role: PlaceRole | null;
  symbol: PlaceSymbol;
  color: PlaceColor;
  sort: number;
  /** 지운 지점. 이름은 남고 동선에서만 빠진다 */
  deleted: boolean;
};

/** 두 지점 사이 이동시간. a < b (문자열 비교)로 저장, 방향 없음 */
export type Travel = { a: string; b: string; minutes: number };

/** days: 1=월 … 7=일. until 은 그날 포함 */
export type Repeat = null | { freq: "daily"; until?: DateStr | null } | { freq: "weekly"; days: number[]; until?: DateStr | null };

export const ORIGIN_KINDS = ["project", "meet"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/** ez_events 한 줄 */
export type EventRow = {
  id: string;
  title: string;
  date: DateStr;
  /** 종일이면 둘 다 null */
  start_min: number | null;
  end_min: number | null;
  place_id: string | null;
  where_text: string | null;
  travel_min: number | null;
  note: string | null;
  repeat: Repeat;
  /** 바깥 일정 출처. null 이면 내가 만든 것 */
  source: string | null;
  external_id: string | null;
  task_id: string | null;
  origin_kind: OriginKind | null;
  origin_id: string | null;
  version: number;
  updated_at: string;
};

export type ExceptionPatch = Partial<Pick<EventRow, "date" | "start_min" | "end_min" | "title" | "place_id" | "where_text" | "travel_min" | "note">>;

/** ez_event_exceptions 한 줄 — 반복 일정의 '이번만' */
export type EventException = { event_id: string; on_date: DateStr; skip: boolean; patch: ExceptionPatch | null };

export type MealWindow = { from: number; to: number; prefer: number };

/** ez_schedule_settings */
export type Settings = {
  prep_first: number;
  prep_again: number;
  home_stay: number;
  /** 0 이면 식사 추천 끔 */
  meal_min: number;
  lunch: MealWindow;
  dinner: MealWindow;
  tz: string;
};

export const DEFAULT_SETTINGS: Settings = {
  prep_first: 35,
  prep_again: 10,
  home_stay: 50,
  meal_min: 40,
  lunch: { from: 660, to: 840, prefer: 720 },
  dinner: { from: 1020, to: 1230, prefer: 1080 },
  tz: "Asia/Seoul",
};

/** 펼친 회차 하나. 반복이 아니면 on_date = 일정의 date */
export type Occurrence = {
  /** `${event_id}:${on_date}` */
  key: string;
  event_id: string;
  /** 반복 규칙상 원래 날짜 (예외의 열쇠) */
  on_date: DateStr;
  /** 실제로 그리는 날짜 (예외로 옮겼으면 옮긴 날) */
  date: DateStr;
  start_min: number | null;
  end_min: number | null;
  all_day: boolean;
  title: string;
  place_id: string | null;
  where_text: string | null;
  travel_min: number | null;
  note: string | null;
  source: string | null;
  task_id: string | null;
  repeating: boolean;
  /** 예외로 바뀐 회차 */
  changed: boolean;
  version: number;
};

export type TravelLabel = "출근" | "등교" | "귀가" | "이동";

/** 계산된 띠. start/end 는 date 기준 분 (1440 을 넘을 수 있음) */
export type Segment =
  | { kind: "prep"; date: DateStr; start: number; end: number }
  | {
      kind: "travel";
      date: DateStr;
      start: number;
      end: number;
      label: TravelLabel;
      from: string | null;
      to: string | null;
      /** 도착할 회차 key (귀가면 null) */
      for_key: string | null;
      /** 앞 일정 끝보다 일찍 출발해야 하는 분. 0 이면 늦지 않음 */
      late: number;
    }
  | { kind: "meal"; date: DateStr; meal: "lunch" | "dinner"; start: number; end: number; short: boolean }
  | { kind: "meal_missing"; date: DateStr; meal: "lunch" | "dinner" };

/** 하루 계산이 다음 날로 넘기는 것 (자정 넘김) */
export type Carry = {
  /** 다음 날 0시 기준, 이 시각 전에는 집에서 나갈 수 없다(전날 귀가가 이때 끝남). 0 이면 제약 없음 */
  home_from: number;
} | null;

export type DayPlan = { date: DateStr; segments: Segment[]; carry: Carry };

/** ez_tasks 한 줄 (플래너) */
export type TaskRow = {
  id: string;
  title: string;
  note: string | null;
  due: DateStr | null;
  est_min: number | null;
  sort: number;
  done_at: string | null;
  origin_kind: OriginKind | null;
  origin_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export const TITLE_MAX = 100;
export const TASK_TITLE_MAX = 200;
export const NOTE_MAX = 2000;
export const PLACE_NAME_MAX = 30;
export const PLACES_MAX = 12;
