// 실제 ScheduleStore: supabase-js + service_role 키. RLS 를 우회하므로 모든 쿼리에 owner = EZ_OWNER_ID 를 직접 걸고,
// 넣을 때 owner 를 명시하고, DB 함수에는 p_as 를 준다. ez_ 일정·플래너 표 밖은 건드리지 않는다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SETTINGS,
  type DateStr,
  type EventException,
  type EventRow,
  type Place,
  type Role,
  type Settings,
  type TaskRow,
  type TaskRule,
  type Travel,
} from "../lib/schedule";
import { DbError } from "./errors";
import {
  EVENT_COLS,
  PLACE_COLS,
  ROLE_COLS,
  RULE_COLS,
  TASK_COLS,
  type EventPatch,
  type MeetRef,
  type NewEvent,
  type NewPlace,
  type NewRule,
  type NewTask,
  type RulePatch,
  type ScheduleStore,
  type SplitPatch,
  type SyncEvent,
  type SyncResult,
  type TaskPatch,
  toEvent,
  toException,
  toPlace,
  toRole,
  toRule,
  toSettings,
  toTask,
} from "./schedule-store";

const PAGE = 1000; // PostgREST 기본 최대 행 수
const IN_CHUNK = 100; // in.(…) 목록을 URL 길이 안으로

type Row = Record<string, unknown>;
type Res<T> = { data: T | null; error: { message: string; code?: string; details?: string | null } | null };

async function run<T>(p: PromiseLike<Res<T>>): Promise<T> {
  const res = await p;
  if (res.error) throw new DbError(res.error.message, res.error.code ?? "", res.error.details ?? undefined);
  return res.data as T;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export class SupabaseScheduleStore implements ScheduleStore {
  private readonly sb: SupabaseClient;

  constructor(
    url: string,
    serviceRoleKey: string,
    readonly owner: string,
  ) {
    this.sb = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  /** 페이지를 넘겨 가며 전부 */
  private async all(build: (from: number, to: number) => PromiseLike<Res<Row[]>>): Promise<Row[]> {
    const out: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await run(build(from, from + PAGE - 1));
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  private events() {
    return this.sb.from("ez_events");
  }

  private taskTable() {
    return this.sb.from("ez_tasks");
  }

  private ruleTable() {
    return this.sb.from("ez_task_rules");
  }

  async places(): Promise<Place[]> {
    const rows = await run<Row[]>(this.sb.from("ez_places").select(PLACE_COLS).eq("owner", this.owner).order("sort").order("created_at"));
    return rows.map(toPlace);
  }

  async travel(): Promise<Travel[]> {
    return run<Travel[]>(this.sb.from("ez_travel").select("a, b, minutes").eq("owner", this.owner));
  }

  async settings(): Promise<Settings> {
    const row = await run<Row | null>(this.sb.from("ez_schedule_settings").select("*").eq("owner", this.owner).maybeSingle());
    return toSettings(row, DEFAULT_SETTINGS);
  }

  async eventsBetween(from: DateStr, to: DateStr): Promise<EventRow[]> {
    const rows = await this.all((a, b) =>
      this.events()
        .select(EVENT_COLS)
        .eq("owner", this.owner)
        .is("deleted_at", null)
        .lte("date", to)
        .or(`repeat.not.is.null,date.gte.${from}`)
        .order("id")
        .range(a, b),
    );
    return rows.map(toEvent);
  }

  async getEvent(id: string): Promise<EventRow | null> {
    const row = await run<Row | null>(this.events().select(EVENT_COLS).eq("owner", this.owner).eq("id", id).is("deleted_at", null).maybeSingle());
    return row ? toEvent(row) : null;
  }

  async eventsByIds(ids: string[]): Promise<EventRow[]> {
    const out: EventRow[] = [];
    for (const part of chunks(ids, IN_CHUNK)) {
      const rows = await run<Row[]>(this.events().select(EVENT_COLS).eq("owner", this.owner).is("deleted_at", null).in("id", part));
      out.push(...rows.map(toEvent));
    }
    return out;
  }

  async eventsForTasks(taskIds: string[]): Promise<EventRow[]> {
    const out: EventRow[] = [];
    for (const ids of chunks(taskIds, IN_CHUNK)) {
      const rows = await run<Row[]>(this.events().select(EVENT_COLS).eq("owner", this.owner).is("deleted_at", null).in("task_id", ids));
      out.push(...rows.map(toEvent));
    }
    return out;
  }

  async exceptions(eventIds: string[]): Promise<EventException[]> {
    // 부르는 쪽이 owner 로 걸러 받은 일정 id 만 준다. 그래도 남의 일정 예외가 섞이지 않게 내 일정 id 와 맞춰 본다
    const out: EventException[] = [];
    for (const ids of chunks(eventIds, IN_CHUNK)) {
      const mine = await run<Row[]>(this.events().select("id").eq("owner", this.owner).in("id", ids));
      const ok = mine.map((r) => r.id as string);
      if (ok.length === 0) continue;
      const rows = await run<Row[]>(this.sb.from("ez_event_exceptions").select("event_id, on_date, skip, patch").in("event_id", ok));
      out.push(...rows.map(toException));
    }
    return out;
  }

  async insertEvent(e: NewEvent): Promise<EventRow> {
    return toEvent(await run<Row>(this.events().insert({ ...e, owner: this.owner }).select(EVENT_COLS).single()));
  }

  async updateEvent(id: string, patch: EventPatch, baseVersion: number): Promise<EventRow | null> {
    const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(body).length === 0) {
      const cur = await this.getEvent(id);
      return cur && cur.version === baseVersion ? cur : null;
    }
    const rows = await run<Row[]>(
      this.events().update(body).eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select(EVENT_COLS),
    );
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async deleteEvent(id: string, baseVersion: number): Promise<boolean> {
    const rows = await run<Row[]>(
      this.events()
        .update({ deleted_at: new Date().toISOString() })
        .eq("owner", this.owner)
        .eq("id", id)
        .eq("version", baseVersion)
        .is("deleted_at", null)
        .select("id"),
    );
    return rows.length > 0;
  }

  private async mine(eventId: string): Promise<void> {
    const row = await run<Row | null>(this.events().select("id").eq("owner", this.owner).eq("id", eventId).maybeSingle());
    if (!row) throw new DbError("[EZ_NOT_FOUND] 일정이 없습니다", "P0001");
  }

  async putException(x: EventException): Promise<void> {
    await this.mine(x.event_id);
    await run(
      this.sb
        .from("ez_event_exceptions")
        .upsert({ event_id: x.event_id, on_date: x.on_date, skip: x.skip, patch: x.patch }, { onConflict: "event_id,on_date" }),
    );
  }

  async dropException(eventId: string, onDate: DateStr): Promise<void> {
    await this.mine(eventId);
    await run(this.sb.from("ez_event_exceptions").delete().eq("event_id", eventId).eq("on_date", onDate));
  }

  async splitEvent(id: string, baseVersion: number, onDate: DateStr, patch: SplitPatch): Promise<EventRow> {
    const row = await run<Row>(
      this.sb.rpc("ez_event_split", { id, base_version: baseVersion, on_date: onDate, patch, p_as: this.owner }).single(),
    );
    return toEvent(row);
  }

  async cutEvent(id: string, baseVersion: number, onDate: DateStr): Promise<EventRow> {
    const row = await run<Row>(this.sb.rpc("ez_event_cut", { id, base_version: baseVersion, on_date: onDate, p_as: this.owner }).single());
    return toEvent(row);
  }

  async sync(source: string, from: DateStr, to: DateStr, events: SyncEvent[], label: string | null): Promise<SyncResult> {
    return run<SyncResult>(
      this.sb.rpc("ez_schedule_sync", { source, p_from: from, p_to: to, events, p_label: label, p_as: this.owner }),
    );
  }

  async tasks(): Promise<TaskRow[]> {
    const rows = await this.all((a, b) =>
      this.taskTable().select(TASK_COLS).eq("owner", this.owner).is("deleted_at", null).order("id").range(a, b),
    );
    return rows.map(toTask);
  }

  async getTask(id: string): Promise<TaskRow | null> {
    const row = await run<Row | null>(this.taskTable().select(TASK_COLS).eq("owner", this.owner).eq("id", id).is("deleted_at", null).maybeSingle());
    return row ? toTask(row) : null;
  }

  async insertTask(t: NewTask): Promise<TaskRow> {
    return toTask(await run<Row>(this.taskTable().insert({ ...t, owner: this.owner }).select(TASK_COLS).single()));
  }

  async updateTask(id: string, patch: TaskPatch, baseVersion: number): Promise<TaskRow | null> {
    const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(body).length === 0) {
      const cur = await this.getTask(id);
      return cur && cur.version === baseVersion ? cur : null;
    }
    const rows = await run<Row[]>(
      this.taskTable().update(body).eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select(TASK_COLS),
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  async deleteTask(id: string, baseVersion: number): Promise<boolean> {
    const rows = await run<Row[]>(
      this.taskTable()
        .update({ deleted_at: new Date().toISOString() })
        .eq("owner", this.owner)
        .eq("id", id)
        .eq("version", baseVersion)
        .is("deleted_at", null)
        .select("id"),
    );
    return rows.length > 0;
  }

  async benchTask(id: string, on: boolean): Promise<TaskRow | null> {
    try {
      return toTask(await run<Row>(this.sb.rpc("ez_task_bench", { id, p_on: on, p_as: this.owner }).single()));
    } catch (e) {
      if (e instanceof DbError && e.message.startsWith("[EZ_NOT_FOUND]")) return null;
      throw e;
    }
  }

  async meetRef(id: string): Promise<MeetRef | null> {
    const m = await run<Row | null>(
      this.sb.from("ez_meets").select("id, title, place_id, circle_id").eq("owner", this.owner).eq("id", id).is("deleted_at", null).maybeSingle(),
    );
    if (!m) return null;
    let role_id: string | null = null;
    if (m.circle_id) {
      const c = await run<Row | null>(
        this.sb.from("ez_circles").select("role_id").eq("owner", this.owner).eq("id", m.circle_id as string).is("deleted_at", null).maybeSingle(),
      );
      if (c?.role_id) {
        const r = await run<Row | null>(
          this.sb.from("ez_roles").select("id").eq("owner", this.owner).eq("id", c.role_id as string).is("deleted_at", null).maybeSingle(),
        );
        role_id = r ? (r.id as string) : null;
      }
    }
    return { id: m.id as string, title: m.title as string, place_id: (m.place_id as string | null) ?? null, role_id };
  }

  async rules(): Promise<TaskRule[]> {
    const rows = await this.all((a, b) =>
      this.ruleTable().select(RULE_COLS).eq("owner", this.owner).is("deleted_at", null).order("created_at").order("id").range(a, b),
    );
    return rows.map(toRule);
  }

  async getRule(id: string): Promise<TaskRule | null> {
    const row = await run<Row | null>(this.ruleTable().select(RULE_COLS).eq("owner", this.owner).eq("id", id).is("deleted_at", null).maybeSingle());
    return row ? toRule(row) : null;
  }

  async insertRule(r: NewRule): Promise<TaskRule> {
    return toRule(await run<Row>(this.ruleTable().insert({ ...r, owner: this.owner }).select(RULE_COLS).single()));
  }

  async updateRule(id: string, patch: RulePatch, baseVersion: number): Promise<TaskRule | null> {
    const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(body).length === 0) {
      const cur = await this.getRule(id);
      return cur && cur.version === baseVersion ? cur : null;
    }
    const rows = await run<Row[]>(
      this.ruleTable().update(body).eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select(RULE_COLS),
    );
    return rows[0] ? toRule(rows[0]) : null;
  }

  async stopRule(id: string): Promise<boolean> {
    const rows = await run<Row[]>(
      this.ruleTable().update({ deleted_at: new Date().toISOString() }).eq("owner", this.owner).eq("id", id).is("deleted_at", null).select("id"),
    );
    return rows.length > 0;
  }

  async moveRules(fromEventId: string, toEventId: string): Promise<number> {
    const rows = await run<Row[]>(
      this.ruleTable().update({ event_id: toEventId }).eq("owner", this.owner).eq("event_id", fromEventId).is("deleted_at", null).select("id"),
    );
    return rows.length;
  }

  async roll(today: DateStr, nowMin: number): Promise<number> {
    return Number(await run<number>(this.sb.rpc("ez_tasks_roll", { p_today: today, p_now_min: nowMin, p_as: this.owner })));
  }

  async roles(): Promise<Role[]> {
    const rows = await run<Row[]>(
      this.sb.from("ez_roles").select(ROLE_COLS).eq("owner", this.owner).is("deleted_at", null).order("sort").order("created_at").order("id"),
    );
    return rows.map(toRole);
  }

  async seedRoles(): Promise<number> {
    return Number(await run<number>(this.sb.rpc("ez_roles_seed", { p_as: this.owner })));
  }

  async insertPlace(p: NewPlace): Promise<Place> {
    return toPlace(await run<Row>(this.sb.from("ez_places").insert({ owner: this.owner, name: p.name, role: p.role ?? null }).select(PLACE_COLS).single()));
  }

  async setTravel(a: string, b: string, minutes: number): Promise<void> {
    const [x, y] = a < b ? [a, b] : [b, a];
    await run(this.sb.from("ez_travel").upsert({ owner: this.owner, a: x, b: y, minutes }, { onConflict: "owner,a,b" }));
  }
}
