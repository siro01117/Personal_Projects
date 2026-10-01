// 시험용 ScheduleStore: PGlite(마이그레이션 전부)에서 service_role 로 SQL 을 실행한다. store-pglite.ts 와 같은 방식.
// 테이블 만들기는 createTestDb (store-pglite.ts) 를 같이 쓴다.

import type { PGlite } from "@electric-sql/pglite";
import {
  DEFAULT_SETTINGS,
  type DateStr,
  type EventException,
  type EventRow,
  type Place,
  type Settings,
  type TaskRow,
  type TaskRule,
  type Travel,
} from "../lib/schedule";
import { DbError } from "./errors";
import {
  type EventPatch,
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
  toRule,
  toSettings,
  toTask,
} from "./schedule-store";

type Row = Record<string, unknown>;

// date 열은 ::text 로 받아 시간대 영향을 없앤다
const EV = `id, title, date::text as date, start_min, end_min, place_id, where_text, travel_min, note, repeat, source, external_id,
  task_id, origin_kind, origin_id, version, updated_at`;
const TASK = `id, title, note, due::text as due, est_min, sort, done_at, origin_kind, origin_id, place_id, due_event_id, checklist,
  rule_id, rule_date::text as rule_date, version, created_at, updated_at`;
const RULE = `id, kind, title, note, est_min, place_id, checklist, repeat, start::text as start, event_id, due_after,
  last_made::text as last_made, version`;

/** jsonb 칸: SQL null 과 JSON null 을 헷갈리지 않게 */
const js = (v: unknown) => (v == null ? null : JSON.stringify(v));
const JSONB = new Set(["repeat", "patch", "checklist"]);

export class PgliteScheduleStore implements ScheduleStore {
  constructor(
    readonly db: PGlite,
    readonly owner: string,
  ) {}

  /** service_role 로 한 문장 */
  private async q(text: string, params: unknown[] = []): Promise<Row[]> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.exec("set local role service_role");
        return (await tx.query<Row>(text, params)).rows;
      });
    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string; constraint?: string };
      throw new DbError(
        `${err.message ?? String(e)}${err.constraint ? ` (constraint "${err.constraint}")` : ""}`,
        err.code ?? "",
        err.detail,
      );
    }
  }

  /** patch → "a = $3, b = $4" (params 에 덧붙임) */
  private sets(patch: Record<string, unknown>, params: unknown[]): string {
    const out: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      params.push(JSONB.has(k) ? js(v) : v);
      out.push(`${k} = $${params.length}${JSONB.has(k) ? "::jsonb" : ""}`);
    }
    return out.join(", ");
  }

  async places(): Promise<Place[]> {
    return (await this.q("select * from ez_places where owner = $1 order by sort, created_at", [this.owner])).map(toPlace);
  }

  async travel(): Promise<Travel[]> {
    const rows = await this.q("select a, b, minutes from ez_travel where owner = $1", [this.owner]);
    return rows.map((r) => ({ a: r.a as string, b: r.b as string, minutes: r.minutes as number }));
  }

  async settings(): Promise<Settings> {
    const rows = await this.q("select * from ez_schedule_settings where owner = $1", [this.owner]);
    return toSettings(rows[0], DEFAULT_SETTINGS);
  }

  async eventsBetween(from: DateStr, to: DateStr): Promise<EventRow[]> {
    const rows = await this.q(
      `select ${EV} from ez_events where owner = $1 and deleted_at is null
         and date <= $3::date and (repeat is not null or date >= $2::date)`,
      [this.owner, from, to],
    );
    return rows.map(toEvent);
  }

  async getEvent(id: string): Promise<EventRow | null> {
    const rows = await this.q(`select ${EV} from ez_events where owner = $1 and id = $2 and deleted_at is null`, [this.owner, id]);
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async eventsByIds(ids: string[]): Promise<EventRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.q(`select ${EV} from ez_events where owner = $1 and deleted_at is null and id = any($2::uuid[])`, [this.owner, ids]);
    return rows.map(toEvent);
  }

  async eventsForTasks(taskIds: string[]): Promise<EventRow[]> {
    if (taskIds.length === 0) return [];
    const rows = await this.q(`select ${EV} from ez_events where owner = $1 and deleted_at is null and task_id = any($2::uuid[])`, [
      this.owner,
      taskIds,
    ]);
    return rows.map(toEvent);
  }

  async exceptions(eventIds: string[]): Promise<EventException[]> {
    if (eventIds.length === 0) return [];
    const rows = await this.q(
      `select x.event_id, x.on_date::text as on_date, x.skip, x.patch from ez_event_exceptions x
         join ez_events e on e.id = x.event_id where e.owner = $1 and x.event_id = any($2::uuid[])`,
      [this.owner, eventIds],
    );
    return rows.map(toException);
  }

  async insertEvent(e: NewEvent): Promise<EventRow> {
    const rows = await this.q(
      `insert into ez_events (owner, title, date, start_min, end_min, place_id, where_text, travel_min, note, repeat, task_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) returning ${EV}`,
      [this.owner, e.title, e.date, e.start_min, e.end_min, e.place_id, e.where_text, e.travel_min, e.note, js(e.repeat), e.task_id],
    );
    return toEvent(rows[0]!);
  }

  async updateEvent(id: string, patch: EventPatch, baseVersion: number): Promise<EventRow | null> {
    const params: unknown[] = [this.owner, id, baseVersion];
    const set = this.sets(patch, params);
    if (!set) {
      const cur = await this.getEvent(id);
      return cur && cur.version === baseVersion ? cur : null;
    }
    const rows = await this.q(
      `update ez_events set ${set} where owner = $1 and id = $2 and version = $3 and deleted_at is null returning ${EV}`,
      params,
    );
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async deleteEvent(id: string, baseVersion: number): Promise<boolean> {
    const rows = await this.q(
      "update ez_events set deleted_at = now() where owner = $1 and id = $2 and version = $3 and deleted_at is null returning id",
      [this.owner, id, baseVersion],
    );
    return rows.length > 0;
  }

  async putException(x: EventException): Promise<void> {
    // 주인 확인: 내 일정의 예외만
    await this.q(
      `insert into ez_event_exceptions (event_id, on_date, skip, patch)
       select e.id, $3::date, $4, $5::jsonb from ez_events e where e.id = $2 and e.owner = $1
       on conflict (event_id, on_date) do update set skip = excluded.skip, patch = excluded.patch`,
      [this.owner, x.event_id, x.on_date, x.skip, js(x.patch)],
    );
  }

  async dropException(eventId: string, onDate: DateStr): Promise<void> {
    await this.q(
      `delete from ez_event_exceptions x using ez_events e
        where e.id = x.event_id and e.owner = $1 and x.event_id = $2 and x.on_date = $3::date`,
      [this.owner, eventId, onDate],
    );
  }

  async splitEvent(id: string, baseVersion: number, onDate: DateStr, patch: SplitPatch): Promise<EventRow> {
    const rows = await this.q(`select ${EV} from ez_event_split($1::uuid, $2::int, $3::date, $4::jsonb, $5::uuid)`, [
      id,
      baseVersion,
      onDate,
      JSON.stringify(patch),
      this.owner,
    ]);
    return toEvent(rows[0]!);
  }

  async cutEvent(id: string, baseVersion: number, onDate: DateStr): Promise<EventRow> {
    const rows = await this.q(`select ${EV} from ez_event_cut($1::uuid, $2::int, $3::date, $4::uuid)`, [id, baseVersion, onDate, this.owner]);
    return toEvent(rows[0]!);
  }

  async sync(source: string, from: DateStr, to: DateStr, events: SyncEvent[], label: string | null): Promise<SyncResult> {
    const rows = await this.q("select ez_schedule_sync($1, $2::date, $3::date, $4::jsonb, $5, $6::uuid) as r", [
      source,
      from,
      to,
      JSON.stringify(events),
      label,
      this.owner,
    ]);
    return rows[0]!.r as SyncResult;
  }

  async tasks(): Promise<TaskRow[]> {
    return (await this.q(`select ${TASK} from ez_tasks where owner = $1 and deleted_at is null`, [this.owner])).map(toTask);
  }

  async getTask(id: string): Promise<TaskRow | null> {
    const rows = await this.q(`select ${TASK} from ez_tasks where owner = $1 and id = $2 and deleted_at is null`, [this.owner, id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  async insertTask(t: NewTask): Promise<TaskRow> {
    const rows = await this.q(
      `insert into ez_tasks (owner, title, note, due, est_min, sort, done_at, place_id, due_event_id, checklist, rule_id, rule_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12) returning ${TASK}`,
      [
        this.owner,
        t.title,
        t.note,
        t.due,
        t.est_min,
        t.sort,
        t.done_at,
        t.place_id ?? null,
        t.due_event_id ?? null,
        JSON.stringify(t.checklist ?? []),
        t.rule_id ?? null,
        t.rule_date ?? null,
      ],
    );
    return toTask(rows[0]!);
  }

  async updateTask(id: string, patch: TaskPatch, baseVersion: number): Promise<TaskRow | null> {
    const params: unknown[] = [this.owner, id, baseVersion];
    const set = this.sets(patch, params);
    if (!set) {
      const cur = await this.getTask(id);
      return cur && cur.version === baseVersion ? cur : null;
    }
    const rows = await this.q(
      `update ez_tasks set ${set} where owner = $1 and id = $2 and version = $3 and deleted_at is null returning ${TASK}`,
      params,
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  async deleteTask(id: string, baseVersion: number): Promise<boolean> {
    const rows = await this.q(
      "update ez_tasks set deleted_at = now() where owner = $1 and id = $2 and version = $3 and deleted_at is null returning id",
      [this.owner, id, baseVersion],
    );
    return rows.length > 0;
  }

  async rules(): Promise<TaskRule[]> {
    const rows = await this.q(`select ${RULE} from ez_task_rules where owner = $1 and deleted_at is null order by created_at, id`, [this.owner]);
    return rows.map(toRule);
  }

  async getRule(id: string): Promise<TaskRule | null> {
    const rows = await this.q(`select ${RULE} from ez_task_rules where owner = $1 and id = $2 and deleted_at is null`, [this.owner, id]);
    return rows[0] ? toRule(rows[0]) : null;
  }

  async insertRule(r: NewRule): Promise<TaskRule> {
    const rows = await this.q(
      `insert into ez_task_rules (owner, kind, title, note, est_min, place_id, checklist, repeat, start, event_id, due_after, last_made)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12) returning ${RULE}`,
      [this.owner, r.kind, r.title, r.note, r.est_min, r.place_id, JSON.stringify(r.checklist), js(r.repeat), r.start, r.event_id, r.due_after, r.last_made],
    );
    return toRule(rows[0]!);
  }

  async updateRule(id: string, patch: RulePatch, baseVersion: number): Promise<TaskRule | null> {
    const params: unknown[] = [this.owner, id, baseVersion];
    const set = this.sets(patch, params);
    if (!set) {
      const cur = await this.getRule(id);
      return cur && cur.version === baseVersion ? cur : null;
    }
    const rows = await this.q(
      `update ez_task_rules set ${set} where owner = $1 and id = $2 and version = $3 and deleted_at is null returning ${RULE}`,
      params,
    );
    return rows[0] ? toRule(rows[0]) : null;
  }

  async stopRule(id: string): Promise<boolean> {
    const rows = await this.q("update ez_task_rules set deleted_at = now() where owner = $1 and id = $2 and deleted_at is null returning id", [
      this.owner,
      id,
    ]);
    return rows.length > 0;
  }

  async moveRules(fromEventId: string, toEventId: string): Promise<number> {
    const rows = await this.q(
      "update ez_task_rules set event_id = $3 where owner = $1 and event_id = $2 and deleted_at is null returning id",
      [this.owner, fromEventId, toEventId],
    );
    return rows.length;
  }

  async roll(today: DateStr, nowMin: number): Promise<number> {
    const rows = await this.q("select ez_tasks_roll($1::date, $2::int, $3::uuid) as n", [today, nowMin, this.owner]);
    return Number(rows[0]!.n);
  }

  async insertPlace(p: NewPlace): Promise<Place> {
    const rows = await this.q("insert into ez_places (owner, name, role) values ($1, $2, $3) returning *", [this.owner, p.name, p.role ?? null]);
    return toPlace(rows[0]!);
  }

  async setTravel(a: string, b: string, minutes: number): Promise<void> {
    const [x, y] = a < b ? [a, b] : [b, a];
    await this.q(
      `insert into ez_travel (owner, a, b, minutes) values ($1, $2, $3, $4)
       on conflict (owner, a, b) do update set minutes = excluded.minutes`,
      [this.owner, x, y, minutes],
    );
  }
}
