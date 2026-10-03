// 일정·플래너 진짜 데이터: 브라우저 supabase-js + 로그인한 사람의 세션. RLS(owner = auth.uid())가 남의 것을 막는다.
// 규칙(칸 검사·바깥 일정 거절·집 하나·할 일 하나에 일정 하나·버전 +1·딸린 마감·반복 규칙 굴리기·역할)은 DB(0006·0007·0008)가 지킨다. 여기서는 버전 확인만
// .eq('version', base) 로 하고, 0행이면 왜 0행인지 다시 읽어 [EZ_VERSION] / [EZ_NOT_FOUND] / [EZ_EXTERNAL] 로 바꾼다.

import { DbError } from "../../lib/errors";
import {
  addDays,
  DEFAULT_SETTINGS,
  type DateStr,
  type EventException,
  type EventRow,
  type ExceptionPatch,
  type Place,
  type Role,
  type Settings,
  type TaskRow,
  type TaskRule,
  type Travel,
} from "../../lib/schedule";
import { run, sb } from "./supabase";
import type {
  EventDeps,
  EventInput,
  EventRows,
  PlaceInput,
  PlannerData,
  RoleDeps,
  RoleInput,
  RuleInput,
  ScheduleData,
  SourceInfo,
  SplitPatch,
  TaskInput,
  TaskLink,
} from "./types";

const PAGE = 1000;
const EVENT_COLS =
  "id, title, date, start_min, end_min, place_id, where_text, travel_min, note, repeat, source, external_id, task_id, origin_kind, origin_id, version, updated_at";
const PLACE_COLS = "id, name, role, symbol, color, sort, deleted_at";
const TASK_COLS =
  "id, title, note, due, est_min, sort, done_at, origin_kind, origin_id, place_id, due_event_id, checklist, rule_id, rule_date, role_id, bench_at, version, created_at, updated_at";
const RULE_COLS = "id, kind, title, note, est_min, place_id, checklist, repeat, start, event_id, due_after, last_made, role_id, version";
const ROLE_COLS = "id, name, from_place, sort, version";
const SETTINGS_COLS = "prep_first, prep_again, home_stay, meal_min, lunch, dinner, tz, my_name";
/** in(...) 한 번에 넣을 id 수 (주소 길이) */
const IN_CHUNK = 100;

const ez = (code: string, message: string) => new DbError(`[${code}] ${message}`, "P0001");

type PlaceDb = Omit<Place, "deleted"> & { deleted_at: string | null };
const toPlace = ({ deleted_at, ...p }: PlaceDb): Place => ({ ...p, deleted: deleted_at !== null });

async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await run<T[]>(page(from, from + PAGE - 1));
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export class SupabaseSchedule implements ScheduleData, PlannerData {
  private t(name: string) {
    return sb().from(name);
  }

  // ------------------------------------------------------------ 읽기

  async places(): Promise<Place[]> {
    const rows = await run<PlaceDb[]>(this.t("ez_places").select(PLACE_COLS).order("sort").order("name"));
    return rows.map(toPlace);
  }

  async travel(): Promise<Travel[]> {
    return run<Travel[]>(this.t("ez_travel").select("a, b, minutes"));
  }

  async settings(): Promise<Settings> {
    const row = await run<Settings | null>(this.t("ez_schedule_settings").select(SETTINGS_COLS).maybeSingle());
    return row ?? { ...DEFAULT_SETTINGS };
  }

  async sources(): Promise<SourceInfo[]> {
    return run<SourceInfo[]>(this.t("ez_sources").select("source, label, synced_at"));
  }

  async events(from: DateStr, to: DateStr): Promise<EventRows> {
    const lo = addDays(from, -2);
    // 예외는 일정에 끼워 한 요청으로 읽는다 (예전에는 일정 → 예외 두 차례였다). FK: ez_event_exceptions.event_id → ez_events.id
    const rows = await all<EventRow & { exceptions: EventException[] | null }>((a, b) =>
      this.t("ez_events")
        .select(`${EVENT_COLS}, exceptions:ez_event_exceptions(event_id, on_date, skip, patch)`)
        .is("deleted_at", null)
        .or(`repeat.not.is.null,and(date.gte.${lo},date.lte.${to})`)
        .order("id")
        .range(a, b),
    );
    const events: EventRow[] = [];
    const exceptions: EventException[] = [];
    for (const { exceptions: ex, ...e } of rows) {
      events.push(e);
      // 반복 일정의 예외만 (반복을 푼 일정에 남은 것은 싣지 않는다 — 예전과 같다)
      if (e.repeat !== null && ex) exceptions.push(...ex);
    }
    return { events, exceptions };
  }

  // ------------------------------------------------------------ 일정 쓰기

  /** 버전을 걸고 고쳤는데 0행일 때: 왜 안 됐는지 */
  private async whyNot(id: string): Promise<never> {
    const r = await run<{ version: number; source: string | null; deleted_at: string | null } | null>(
      this.t("ez_events").select("version, source, deleted_at").eq("id", id).maybeSingle(),
    );
    if (!r || r.deleted_at !== null) throw ez("EZ_NOT_FOUND", "고칠 일정이 없습니다");
    if (r.source !== null) throw ez("EZ_EXTERNAL", `바깥 일정(${r.source})은 여기서 고칠 수 없습니다`);
    throw ez("EZ_VERSION", `그 사이 다른 곳에서 이 일정을 고쳤습니다. 새로 불러오세요 (지금 버전 ${r.version})`);
  }

  async createEvent(input: EventInput): Promise<EventRow> {
    return run<EventRow>(this.t("ez_events").insert(input).select(EVENT_COLS).single());
  }

  async updateEvent(id: string, baseVersion: number, patch: Partial<EventInput>): Promise<EventRow> {
    const rows = await run<EventRow[]>(
      this.t("ez_events").update(patch).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select(EVENT_COLS),
    );
    return rows[0] ?? this.whyNot(id);
  }

  async dependents(id: string): Promise<EventDeps> {
    const [tasks, rules] = await Promise.all([
      run<{ id: string }[]>(this.t("ez_tasks").select("id").eq("due_event_id", id)),
      run<{ id: string }[]>(this.t("ez_task_rules").select("id").eq("event_id", id).is("deleted_at", null)),
    ]);
    return { tasks: tasks.map((r) => r.id), rules: rules.map((r) => r.id) };
  }

  async deleteEvent(id: string, baseVersion: number): Promise<void> {
    const rows = await run<{ id: string }[]>(
      this.t("ez_events").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select("id"),
    );
    if (rows.length === 0) await this.whyNot(id);
  }

  async restoreEvent(id: string, deps?: EventDeps): Promise<EventRow> {
    const rows = await run<EventRow[]>(this.t("ez_events").update({ deleted_at: null }).eq("id", id).select(EVENT_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "되돌릴 일정이 없습니다");
    // 끊긴 마감 연결 · 멈춘 규칙을 다시 잇는다. 일정은 이미 되돌아왔으니 여기서 실패해도 되돌리기는 된 것으로 둔다
    // (그 사이 달라진 할 일 — 다른 일정에 걺 · 회차가 아닌 날짜 — 은 DB 가 거절한다)
    for (const tid of deps?.tasks ?? []) {
      try {
        await run(this.t("ez_tasks").update({ due_event_id: id }).eq("id", tid).is("due_event_id", null).is("deleted_at", null));
      } catch {
        // 이 할 일만 끊긴 채로 둔다
      }
    }
    try {
      if (deps && deps.rules.length > 0 && rows[0].repeat !== null) {
        await run(this.t("ez_task_rules").update({ deleted_at: null }).in("id", deps.rules).eq("event_id", id));
      }
    } catch {
      // 일정만 되돌린 채로 둔다
    }
    return rows[0];
  }

  async setException(eventId: string, onDate: DateStr, patch: ExceptionPatch | null): Promise<void> {
    await run(
      this.t("ez_event_exceptions").upsert({ event_id: eventId, on_date: onDate, skip: patch === null, patch }, { onConflict: "event_id,on_date" }),
    );
  }

  async clearException(eventId: string, onDate: DateStr): Promise<void> {
    await run(this.t("ez_event_exceptions").delete().eq("event_id", eventId).eq("on_date", onDate));
  }

  async split(id: string, baseVersion: number, onDate: DateStr, patch: SplitPatch): Promise<EventRow> {
    const row = pick(await run<EventRow>(sb().rpc("ez_event_split", { id, base_version: baseVersion, on_date: onDate, patch })));
    // 새 일정이 생겼으면 딸린 규칙(끝나면 할 일)을 새 일정으로 옮긴다. 새 일정이 반복이 아니면 DB 가 거절하니 그대로 둔다
    if (row.id !== id && row.repeat !== null) {
      try {
        await run(this.t("ez_task_rules").update({ event_id: row.id }).eq("event_id", id).is("deleted_at", null));
      } catch {
        // 나누기는 이미 됐다. 규칙은 원래 일정에 남는다
      }
    }
    return row;
  }

  async cut(id: string, baseVersion: number, onDate: DateStr): Promise<EventRow> {
    const row = await run<EventRow>(sb().rpc("ez_event_cut", { id, base_version: baseVersion, on_date: onDate }));
    return pick(row);
  }

  // ------------------------------------------------------------ 지점 · 이동시간 · 설정

  async createPlace(input: PlaceInput): Promise<Place> {
    return toPlace(await run<PlaceDb>(this.t("ez_places").insert(input).select(PLACE_COLS).single()));
  }

  async updatePlace(id: string, patch: Partial<PlaceInput>): Promise<Place> {
    const rows = await run<PlaceDb[]>(this.t("ez_places").update(patch).eq("id", id).is("deleted_at", null).select(PLACE_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "지점이 없습니다");
    return toPlace(rows[0]);
  }

  async deletePlace(id: string): Promise<void> {
    await run(this.t("ez_places").update({ deleted_at: new Date().toISOString() }).eq("id", id).is("deleted_at", null));
  }

  async setTravel(a: string, b: string, minutes: number | null): Promise<void> {
    const [x, y] = a < b ? [a, b] : [b, a];
    if (x === y) return;
    if (minutes === null) {
      await run(this.t("ez_travel").delete().eq("a", x).eq("b", y));
      return;
    }
    const rows = await run<{ a: string }[]>(this.t("ez_travel").update({ minutes }).eq("a", x).eq("b", y).select("a"));
    if (rows.length === 0) await run(this.t("ez_travel").insert({ a: x, b: y, minutes }));
  }

  async saveSettings(patch: Partial<Omit<Settings, "tz">>): Promise<Settings> {
    const rows = await run<Settings[]>(this.t("ez_schedule_settings").update(patch).not("owner", "is", null).select(SETTINGS_COLS));
    if (rows[0]) return rows[0];
    return run<Settings>(this.t("ez_schedule_settings").insert(patch).select(SETTINGS_COLS).single());
  }

  // ------------------------------------------------------------ 플래너

  private async whyNotTask(id: string): Promise<never> {
    const r = await run<{ version: number; deleted_at: string | null } | null>(
      this.t("ez_tasks").select("version, deleted_at").eq("id", id).maybeSingle(),
    );
    if (!r || r.deleted_at !== null) throw ez("EZ_NOT_FOUND", "할 일이 없습니다");
    throw ez("EZ_VERSION", `그 사이 다른 곳에서 이 할 일을 고쳤습니다. 새로 불러오세요 (지금 버전 ${r.version})`);
  }

  private async patchTask(id: string, baseVersion: number, patch: Record<string, unknown>): Promise<TaskRow> {
    const rows = await run<TaskRow[]>(
      this.t("ez_tasks").update(patch).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select(TASK_COLS),
    );
    return rows[0] ?? this.whyNotTask(id);
  }

  async tasks(): Promise<TaskRow[]> {
    return all<TaskRow>((a, b) => this.t("ez_tasks").select(TASK_COLS).is("deleted_at", null).order("sort").order("id").range(a, b));
  }

  async links(): Promise<TaskLink[]> {
    const rows = await all<{ id: string; task_id: string; date: string; start_min: number | null; end_min: number | null; repeat: unknown }>((a, b) =>
      this.t("ez_events")
        .select("id, task_id, date, start_min, end_min, repeat")
        .is("deleted_at", null)
        .not("task_id", "is", null)
        .order("id")
        .range(a, b),
    );
    return rows.map((r) => ({ task_id: r.task_id, event_id: r.id, date: r.date, start_min: r.start_min, end_min: r.end_min, repeating: r.repeat !== null }));
  }

  async rules(): Promise<TaskRule[]> {
    return all<TaskRule>((a, b) => this.t("ez_task_rules").select(RULE_COLS).is("deleted_at", null).order("created_at").order("id").range(a, b));
  }

  async eventTitles(ids: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += IN_CHUNK) {
      const rows = await run<{ id: string; title: string }[]>(
        this.t("ez_events").select("id, title").in("id", uniq.slice(i, i + IN_CHUNK)).is("deleted_at", null),
      );
      for (const r of rows) out[r.id] = r.title;
    }
    return out;
  }

  async roll(today: DateStr, nowMin: number): Promise<number> {
    return run<number>(sb().rpc("ez_tasks_roll", { p_today: today, p_now_min: nowMin }));
  }

  async createTask(input: TaskInput): Promise<TaskRow> {
    const top = await run<{ sort: number }[]>(this.t("ez_tasks").select("sort").is("deleted_at", null).order("sort").limit(1));
    const sort = Math.min(0, top[0]?.sort ?? 0) - 1;
    return run<TaskRow>(this.t("ez_tasks").insert({ ...input, title: input.title.trim(), sort }).select(TASK_COLS).single());
  }

  async updateTask(id: string, baseVersion: number, patch: Partial<TaskInput>): Promise<TaskRow> {
    return this.patchTask(id, baseVersion, patch);
  }

  async setDone(id: string, baseVersion: number, done: boolean): Promise<TaskRow> {
    return this.patchTask(id, baseVersion, { done_at: done ? new Date().toISOString() : null });
  }

  async deleteTask(id: string, baseVersion: number): Promise<void> {
    await this.patchTask(id, baseVersion, { deleted_at: new Date().toISOString() });
  }

  async restoreTask(id: string): Promise<TaskRow> {
    const rows = await run<TaskRow[]>(this.t("ez_tasks").update({ deleted_at: null }).eq("id", id).select(TASK_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "되돌릴 할 일이 없습니다");
    return rows[0];
  }

  async reorder(id: string, sort: number): Promise<TaskRow> {
    const rows = await run<TaskRow[]>(this.t("ez_tasks").update({ sort }).eq("id", id).is("deleted_at", null).select(TASK_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "할 일이 없습니다");
    return rows[0];
  }

  async bench(id: string, on: boolean): Promise<TaskRow> {
    const row = await run<Record<string, unknown>>(sb().rpc("ez_task_bench", { id, p_on: on }));
    return pickTask(row);
  }

  // ------------------------------------------------------------ 반복 규칙

  async createRule(input: RuleInput): Promise<TaskRule> {
    return run<TaskRule>(this.t("ez_task_rules").insert(input).select(RULE_COLS).single());
  }

  async updateRule(id: string, patch: Partial<RuleInput>): Promise<TaskRule> {
    const rows = await run<TaskRule[]>(this.t("ez_task_rules").update(patch).eq("id", id).is("deleted_at", null).select(RULE_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "반복 규칙이 없습니다");
    return rows[0];
  }

  async stopRule(id: string): Promise<void> {
    await run(this.t("ez_task_rules").update({ deleted_at: new Date().toISOString() }).eq("id", id).is("deleted_at", null));
  }

  // ------------------------------------------------------------ 역할 (0008)

  async roles(): Promise<Role[]> {
    return run<Role[]>(this.t("ez_roles").select(ROLE_COLS).is("deleted_at", null).order("sort").order("name"));
  }

  async seedRoles(): Promise<number> {
    return run<number>(sb().rpc("ez_roles_seed"));
  }

  async createRole(input: RoleInput): Promise<Role> {
    let sort = input.sort;
    if (sort === undefined) {
      const last = await run<{ sort: number }[]>(this.t("ez_roles").select("sort").is("deleted_at", null).order("sort", { ascending: false }).limit(1));
      sort = Math.max(0, last[0]?.sort ?? 0) + 1;
    }
    return run<Role>(this.t("ez_roles").insert({ name: input.name, from_place: input.from_place ?? null, sort }).select(ROLE_COLS).single());
  }

  async updateRole(id: string, patch: Partial<RoleInput>): Promise<Role> {
    const rows = await run<Role[]>(this.t("ez_roles").update(patch).eq("id", id).is("deleted_at", null).select(ROLE_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "역할이 없습니다");
    return rows[0];
  }

  async deleteRole(id: string): Promise<RoleDeps> {
    // 지우면 DB 가 그 역할의 할 일 · 규칙을 역할 없음으로 만든다. 되돌릴 수 있게 먼저 읽어 둔다
    const [tasks, rules] = await Promise.all([
      all<{ id: string }>((a, b) => this.t("ez_tasks").select("id").eq("role_id", id).order("id").range(a, b)),
      run<{ id: string }[]>(this.t("ez_task_rules").select("id").eq("role_id", id)),
    ]);
    await run(this.t("ez_roles").update({ deleted_at: new Date().toISOString() }).eq("id", id).is("deleted_at", null));
    return { tasks: tasks.map((r) => r.id), rules: rules.map((r) => r.id) };
  }

  async restoreRole(id: string, deps?: RoleDeps): Promise<Role> {
    const rows = await run<Role[]>(this.t("ez_roles").update({ deleted_at: null }).eq("id", id).select(ROLE_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "되돌릴 역할이 없습니다");
    // 역할은 이미 되돌아왔으니 여기서 실패해도 되돌리기는 된 것으로 둔다. 그 사이 다른 역할을 고른 것(role_id 가 null 이 아님)은 건너뛴다
    try {
      const tasks = deps?.tasks ?? [];
      for (let i = 0; i < tasks.length; i += IN_CHUNK) {
        await run(this.t("ez_tasks").update({ role_id: id }).in("id", tasks.slice(i, i + IN_CHUNK)).is("role_id", null));
      }
      if (deps && deps.rules.length > 0) await run(this.t("ez_task_rules").update({ role_id: id }).in("id", deps.rules).is("role_id", null));
    } catch {
      // 역할만 되돌린 채로 둔다
    }
    return rows[0];
  }
}

/** rpc 가 돌려준 ez_events 행에서 화면이 쓰는 칸만 */
function pick(r: EventRow & Record<string, unknown>): EventRow {
  const {
    id, title, date, start_min, end_min, place_id, where_text, travel_min, note, repeat, source, external_id, task_id, origin_kind, origin_id, version, updated_at,
  } = r;
  return { id, title, date, start_min, end_min, place_id, where_text, travel_min, note, repeat, source, external_id, task_id, origin_kind, origin_id, version, updated_at };
}

/** ez_task_bench 가 돌려주는 행(테이블 전체 칸)에서 TaskRow 칸만 */
function pickTask(r: Record<string, unknown>): TaskRow {
  const out: Record<string, unknown> = {};
  for (const k of TASK_COLS.split(", ")) out[k] = r[k];
  return out as TaskRow;
}
