// 일정·플래너 데이터 접근 (docs/일정.md 2·5장, docs/플래너.md 2장). 구현: schedule-store-supabase(실제), schedule-store-pglite(시험).
// 서랍 Store 와 따로 둔다. 모든 구현은 자기 owner 의 것만 보고 고친다. 일정·할 일은 살아 있는(deleted_at is null) 것만.
// 규칙(칸 범위·바깥 일정·버전·예외 날짜)은 DB 트리거·함수가 막는다. 실패하면 DbError 를 던진다.

import type { DateStr, EventException, EventRow, ExceptionPatch, Place, PlaceRole, Repeat, Settings, TaskRow, Travel } from "../lib/schedule";

/** 새 일정 — 사람이 만드는 것 (바깥 일정은 sync 로만) */
export type NewEvent = Pick<
  EventRow,
  "title" | "date" | "start_min" | "end_min" | "place_id" | "where_text" | "travel_min" | "note" | "repeat" | "task_id"
>;
export type EventPatch = Partial<NewEvent>;

/** split 의 patch: 예외 칸 + repeat */
export type SplitPatch = ExceptionPatch & { repeat?: Repeat };

/** ez_schedule_sync 한 건 */
export type SyncEvent = {
  external_id: string;
  title: string;
  date: DateStr;
  start_min: number | null;
  end_min: number | null;
  place_id: string | null;
  where_text: string | null;
  travel_min: number | null;
  note: string | null;
  repeat: Repeat;
};
export type SyncResult = { inserted: number; updated: number; deleted: number };

export type NewTask = Pick<TaskRow, "title" | "note" | "due" | "est_min" | "sort" | "done_at">;
export type TaskPatch = Partial<NewTask>;

export type NewPlace = { name: string; role?: PlaceRole | null };

export interface ScheduleStore {
  readonly owner: string;

  /** 지점 전부 (지운 것도 — 이름은 남는다) */
  places(): Promise<Place[]>;
  travel(): Promise<Travel[]>;
  /** 줄이 없으면 기본값 */
  settings(): Promise<Settings>;

  /** 회차가 from~to 에 생길 수 있는 일정: 반복이 아니면 date 가 그 안, 반복이면 시작이 to 이전인 것 전부 */
  eventsBetween(from: DateStr, to: DateStr): Promise<EventRow[]>;
  getEvent(id: string): Promise<EventRow | null>;
  /** 이 할 일들과 이어진 일정 */
  eventsForTasks(taskIds: string[]): Promise<EventRow[]>;
  exceptions(eventIds: string[]): Promise<EventException[]>;
  insertEvent(e: NewEvent): Promise<EventRow>;
  /** version 이 같을 때만. 고친 행이 없으면 null */
  updateEvent(id: string, patch: EventPatch, baseVersion: number): Promise<EventRow | null>;
  /** soft delete. version 이 같을 때만. 지웠으면 true */
  deleteEvent(id: string, baseVersion: number): Promise<boolean>;
  /** '이번만' 넣기·고치기 (있으면 갈아끼움) */
  putException(x: EventException): Promise<void>;
  dropException(eventId: string, onDate: DateStr): Promise<void>;
  /** ez_event_split — '이후 모두' 고치기. 새(또는 첫 회차면 고친) 일정 */
  splitEvent(id: string, baseVersion: number, onDate: DateStr, patch: SplitPatch): Promise<EventRow>;
  /** ez_event_cut — '이후 모두' 지우기 */
  cutEvent(id: string, baseVersion: number, onDate: DateStr): Promise<EventRow>;
  /** ez_schedule_sync — 바깥 일정 갈아끼우기 */
  sync(source: string, from: DateStr, to: DateStr, events: SyncEvent[], label: string | null): Promise<SyncResult>;

  /** 살아 있는 할 일 전부 */
  tasks(): Promise<TaskRow[]>;
  getTask(id: string): Promise<TaskRow | null>;
  insertTask(t: NewTask): Promise<TaskRow>;
  updateTask(id: string, patch: TaskPatch, baseVersion: number): Promise<TaskRow | null>;
  deleteTask(id: string, baseVersion: number): Promise<boolean>;

  // 지점·이동시간은 화면 설정 몫. 시험·스모크 준비용으로만 쓴다
  insertPlace(p: NewPlace): Promise<Place>;
  /** 방향 없음 — a·b 순서는 알아서 맞춘다 */
  setTravel(a: string, b: string, minutes: number): Promise<void>;
}

export const EVENT_COLS =
  "id, title, date, start_min, end_min, place_id, where_text, travel_min, note, repeat, source, external_id, task_id, origin_kind, origin_id, version, updated_at";
export const TASK_COLS = "id, title, note, due, est_min, sort, done_at, origin_kind, origin_id, version, created_at, updated_at";
export const PLACE_COLS = "id, name, role, symbol, color, sort, deleted_at";

type Row = Record<string, unknown>;

/** Date · 문자열 시각 → ISO */
export const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
/** date 열 → 'YYYY-MM-DD' (PGlite 는 ::text 로 받고, PostgREST 는 원래 문자열) */
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export function toEvent(r: Row): EventRow {
  return {
    id: r.id as string,
    title: r.title as string,
    date: day(r.date)!,
    start_min: (r.start_min as number | null) ?? null,
    end_min: (r.end_min as number | null) ?? null,
    place_id: (r.place_id as string | null) ?? null,
    where_text: (r.where_text as string | null) ?? null,
    travel_min: (r.travel_min as number | null) ?? null,
    note: (r.note as string | null) ?? null,
    repeat: (r.repeat as Repeat) ?? null,
    source: (r.source as string | null) ?? null,
    external_id: (r.external_id as string | null) ?? null,
    task_id: (r.task_id as string | null) ?? null,
    origin_kind: (r.origin_kind as EventRow["origin_kind"]) ?? null,
    origin_id: (r.origin_id as string | null) ?? null,
    version: r.version as number,
    updated_at: iso(r.updated_at)!,
  };
}

export function toTask(r: Row): TaskRow {
  return {
    id: r.id as string,
    title: r.title as string,
    note: (r.note as string | null) ?? null,
    due: day(r.due),
    est_min: (r.est_min as number | null) ?? null,
    sort: Number(r.sort),
    done_at: iso(r.done_at),
    origin_kind: (r.origin_kind as TaskRow["origin_kind"]) ?? null,
    origin_id: (r.origin_id as string | null) ?? null,
    version: r.version as number,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

export function toPlace(r: Row): Place {
  return {
    id: r.id as string,
    name: r.name as string,
    role: (r.role as Place["role"]) ?? null,
    symbol: r.symbol as Place["symbol"],
    color: r.color as Place["color"],
    sort: Number(r.sort),
    deleted: r.deleted_at != null,
  };
}

export function toException(r: Row): EventException {
  return {
    event_id: r.event_id as string,
    on_date: day(r.on_date)!,
    skip: r.skip === true,
    patch: (r.patch as ExceptionPatch | null) ?? null,
  };
}

/** 설정 한 줄 → Settings (없으면 기본값) */
export function toSettings(r: Row | null | undefined, fallback: Settings): Settings {
  if (!r) return fallback;
  return {
    prep_first: r.prep_first as number,
    prep_again: r.prep_again as number,
    home_stay: r.home_stay as number,
    meal_min: r.meal_min as number,
    lunch: r.lunch as Settings["lunch"],
    dinner: r.dinner as Settings["dinner"],
    tz: r.tz as string,
  };
}
