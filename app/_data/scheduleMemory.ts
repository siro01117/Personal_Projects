// 개발 확인용 일정·플래너 메모리 저장소 (`?demo=1`, NODE_ENV=development 에서만 쓰인다).
//
// !! 진짜 규칙의 출처는 DB 다 (db/migrations/0006_ez_schedule.sql).
// 여기서는 화면이 의지하는 것만 흉내 낸다: 버전 확인 · 바깥 일정 거절 · 집 하나 · 할 일 하나에 일정 하나 ·
// 지점 이름 겹침 · 지점 12개 · 반복 회차 검사 · split/cut. 칸 검사는 lib/schedule 의 validateEvent 를 그대로 쓰고,
// 오류는 DB 와 같은 모양(SQLSTATE · '[EZ_*] 설명')으로 던진다.

import { DbError } from "../../lib/errors";
import {
  addDays,
  DEFAULT_SETTINGS,
  occursOn,
  PLACE_COLORS,
  PLACES_MAX,
  validateEvent,
  validateTask,
  type DateStr,
  type EventException,
  type EventRow,
  type ExceptionPatch,
  type Place,
  type PlaceSymbol,
  type Settings,
  type TaskRow,
  type Travel,
} from "../../lib/schedule";
import type {
  EventInput,
  EventRows,
  PlaceInput,
  PlannerData,
  ScheduleData,
  SourceInfo,
  SplitPatch,
  TaskInput,
  TaskLink,
} from "./types";

const ez = (code: string, message: string) => new DbError(`[${code}] ${message}`, "P0001");
const unique = (name: string) => new DbError(`duplicate key value violates unique constraint "${name}"`, "23505");
const clone = <T>(x: T): T => structuredClone(x);

type EvRow = EventRow & { deleted_at: string | null };
type PlRow = Place & { deleted_at: string | null };
type TkRow = TaskRow & { deleted_at: string | null };

export type ScheduleSeed = {
  places?: Place[];
  travel?: Travel[];
  settings?: Partial<Settings>;
  sources?: SourceInfo[];
  events?: (Partial<EventRow> & Pick<EventRow, "id" | "title" | "date">)[];
  exceptions?: EventException[];
  tasks?: (Partial<TaskRow> & Pick<TaskRow, "id" | "title">)[];
};

const EVENT_KEYS = ["title", "date", "start_min", "end_min", "place_id", "where_text", "travel_min", "note", "repeat", "task_id"] as const;
const PATCH_KEYS = ["date", "start_min", "end_min", "title", "place_id", "where_text", "travel_min", "note"] as const;

function defaultSymbol(role: PlaceInput["role"]): PlaceSymbol {
  return role === "home" ? "home" : role === "school" ? "school" : role === "work" ? "work" : "pin";
}

/** 첫 회차 (weekly 는 시작 날짜 요일이 days 에 없을 수 있다) — ez_first_on */
function firstOn(ev: EventRow): DateStr {
  for (let k = 0; k < 7; k++) {
    const d = addDays(ev.date, k);
    if (occursOn(ev, d)) return d;
  }
  return ev.date;
}

export class MemorySchedule implements ScheduleData, PlannerData {
  private readonly ev = new Map<string, EvRow>();
  private readonly pl = new Map<string, PlRow>();
  private readonly tk = new Map<string, TkRow>();
  private ex: EventException[] = [];
  private tr: Travel[] = [];
  private st: Settings;
  private src: SourceInfo[];
  private readonly latency: number;

  constructor(seed: ScheduleSeed = {}, opts: { latency?: number } = {}) {
    this.latency = opts.latency ?? 0;
    const at = new Date().toISOString();
    for (const p of seed.places ?? []) this.pl.set(p.id, { ...p, deleted_at: p.deleted ? at : null });
    this.tr = clone(seed.travel ?? []);
    this.st = { ...DEFAULT_SETTINGS, ...seed.settings };
    this.src = clone(seed.sources ?? []);
    for (const e of seed.events ?? []) {
      this.ev.set(e.id, {
        start_min: null,
        end_min: null,
        place_id: null,
        where_text: null,
        travel_min: null,
        note: null,
        repeat: null,
        source: null,
        external_id: null,
        task_id: null,
        origin_kind: null,
        origin_id: null,
        version: 1,
        updated_at: at,
        deleted_at: null,
        ...e,
      });
    }
    this.ex = clone(seed.exceptions ?? []);
    for (const t of seed.tasks ?? []) {
      this.tk.set(t.id, {
        note: null,
        due: null,
        est_min: null,
        sort: 0,
        done_at: null,
        origin_kind: null,
        origin_id: null,
        version: 1,
        created_at: at,
        updated_at: at,
        deleted_at: null,
        ...t,
      });
    }
  }

  private async wait(): Promise<void> {
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
  }

  // ------------------------------------------------------------ 바깥에서 바뀐 것 흉내 (확인 모드 콘솔)

  /** 에이전트·다른 창이 그 사이 고친 것처럼 버전만 올린다 */
  bump(id: string): void {
    const r = this.ev.get(id);
    if (r) {
      r.version += 1;
      r.updated_at = new Date().toISOString();
    }
  }

  // ------------------------------------------------------------ 읽기

  async places(): Promise<Place[]> {
    await this.wait();
    return [...this.pl.values()]
      .map(({ deleted_at, ...p }) => ({ ...clone(p), deleted: deleted_at !== null }))
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  }

  async travel(): Promise<Travel[]> {
    await this.wait();
    return clone(this.tr);
  }

  async settings(): Promise<Settings> {
    await this.wait();
    return clone(this.st);
  }

  async sources(): Promise<SourceInfo[]> {
    await this.wait();
    return clone(this.src);
  }

  async events(from: DateStr, to: DateStr): Promise<EventRows> {
    await this.wait();
    const lo = addDays(from, -2);
    const events = [...this.ev.values()]
      .filter((e) => e.deleted_at === null && (e.repeat !== null || (e.date >= lo && e.date <= to)))
      .map(({ deleted_at: _, ...e }) => clone(e));
    const ids = new Set(events.filter((e) => e.repeat !== null).map((e) => e.id));
    return { events, exceptions: clone(this.ex.filter((x) => ids.has(x.event_id))) };
  }

  // ------------------------------------------------------------ 일정 쓰기

  private row(id: string): EvRow {
    const r = this.ev.get(id);
    if (!r || r.deleted_at !== null) throw ez("EZ_NOT_FOUND", "고칠 일정이 없습니다");
    return r;
  }

  private notExternal(r: EvRow): void {
    if (r.source !== null) throw ez("EZ_EXTERNAL", `바깥 일정(${r.source})은 여기서 고칠 수 없습니다. 출처에서 바꾼 뒤 ez_schedule_sync 로 맞추세요`);
  }

  private version(r: EvRow, base: number): void {
    if (r.version !== base) throw ez("EZ_VERSION", `그 사이 다른 곳에서 이 일정을 고쳤습니다. 새로 불러오세요 (지금 버전 ${r.version})`);
  }

  private check(e: EvRow): void {
    const issues = validateEvent(e);
    if (issues.length > 0) throw ez("EZ_VALUE", issues[0]!.reason);
    if (e.place_id !== null && !this.pl.has(e.place_id)) throw ez("EZ_PLACE", "없는 지점입니다");
    if (e.task_id !== null && e.deleted_at === null) {
      const t = this.tk.get(e.task_id);
      // DB 는 넣거나 task_id 를 바꿀 때만 본다
      if (t?.deleted_at && this.ev.get(e.id)?.task_id !== e.task_id) throw ez("EZ_TASK", "지운 할 일에는 일정을 이을 수 없습니다");
      for (const o of this.ev.values()) {
        if (o.id !== e.id && o.deleted_at === null && o.task_id === e.task_id) throw unique("ez_events_task_unique");
      }
    }
  }

  private touch(r: EvRow): void {
    r.version += 1;
    r.updated_at = new Date().toISOString();
  }

  /** 반복 규칙·시작 날짜가 바뀌면 더는 회차가 아닌 날의 예외를 지운다 (ez_events_after) */
  private pruneExceptions(r: EvRow): void {
    this.ex = this.ex.filter((x) => x.event_id !== r.id || (r.repeat !== null && occursOn(r, x.on_date)));
  }

  async createEvent(input: EventInput): Promise<EventRow> {
    await this.wait();
    const r: EvRow = {
      id: globalThis.crypto.randomUUID(),
      ...input,
      source: null,
      external_id: null,
      origin_kind: null,
      origin_id: null,
      version: 1,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    this.check(r);
    this.ev.set(r.id, r);
    const { deleted_at: _, ...out } = r;
    return clone(out);
  }

  async updateEvent(id: string, baseVersion: number, patch: Partial<EventInput>): Promise<EventRow> {
    await this.wait();
    const r = this.row(id);
    this.notExternal(r);
    this.version(r, baseVersion);
    const next: EvRow = { ...r };
    for (const k of EVENT_KEYS) if (k in patch) (next as Record<string, unknown>)[k] = patch[k];
    this.check(next);
    const changed = EVENT_KEYS.some((k) => JSON.stringify(next[k]) !== JSON.stringify(r[k]));
    Object.assign(r, next);
    if (changed) this.touch(r);
    this.pruneExceptions(r);
    const { deleted_at: _, ...out } = r;
    return clone(out);
  }

  async deleteEvent(id: string, baseVersion: number): Promise<void> {
    await this.wait();
    const r = this.row(id);
    this.notExternal(r);
    this.version(r, baseVersion);
    r.deleted_at = new Date().toISOString();
    this.touch(r);
  }

  async restoreEvent(id: string): Promise<EventRow> {
    await this.wait();
    const r = this.ev.get(id);
    if (!r) throw ez("EZ_NOT_FOUND", "되돌릴 일정이 없습니다");
    this.notExternal(r);
    const next = { ...r, deleted_at: null };
    this.check(next);
    r.deleted_at = null;
    this.touch(r);
    const { deleted_at: _, ...out } = r;
    return clone(out);
  }

  async setException(eventId: string, onDate: DateStr, patch: ExceptionPatch | null): Promise<void> {
    await this.wait();
    const r = this.ev.get(eventId);
    if (!r) throw new DbError('insert or update on table "ez_event_exceptions" violates foreign key constraint', "23503");
    if (r.source !== null) throw ez("EZ_EXTERNAL", "바깥 일정의 회차는 따로 바꿀 수 없습니다");
    if (r.deleted_at !== null) throw ez("EZ_NOT_FOUND", "지운 일정입니다");
    if (r.repeat === null) throw ez("EZ_REPEAT", "반복 일정이 아니라 회차를 따로 바꿀 수 없습니다. 일정을 직접 고치세요");
    if (!occursOn(r, onDate)) throw ez("EZ_DATE", `${onDate} 는 이 일정이 반복되는 날이 아닙니다`);
    if (patch !== null) {
      const keys = Object.keys(patch);
      if (keys.length === 0) throw ez("EZ_PATCH", "바꿀 칸이 없습니다 (건너뛰려면 skip)");
      const bad = keys.find((k) => !(PATCH_KEYS as readonly string[]).includes(k));
      if (bad) throw ez("EZ_PATCH", `쓸 수 없는 칸입니다: ${bad}`);
      if (("start_min" in patch) !== ("end_min" in patch)) throw ez("EZ_PATCH", "start_min 과 end_min 은 같이 써 주세요");
      const merged = { ...r, ...patch, repeat: null };
      const issues = validateEvent(merged);
      if (issues.length > 0) throw ez("EZ_VALUE", issues[0]!.reason);
      if (patch.place_id && !this.pl.has(patch.place_id)) throw ez("EZ_PLACE", "없는 지점입니다");
    }
    this.ex = this.ex.filter((x) => !(x.event_id === eventId && x.on_date === onDate));
    this.ex.push({ event_id: eventId, on_date: onDate, skip: patch === null, patch: patch === null ? null : clone(patch) });
  }

  async clearException(eventId: string, onDate: DateStr): Promise<void> {
    await this.wait();
    const r = this.ev.get(eventId);
    if (r?.source) throw ez("EZ_EXTERNAL", "바깥 일정의 회차는 따로 바꿀 수 없습니다");
    this.ex = this.ex.filter((x) => !(x.event_id === eventId && x.on_date === onDate));
  }

  private lock(id: string, base: number, onDate: DateStr): EvRow {
    const r = this.row(id);
    this.notExternal(r);
    this.version(r, base);
    if (!occursOn(r, onDate)) throw ez("EZ_DATE", `${onDate} 는 이 일정의 회차가 아닙니다`);
    return r;
  }

  async split(id: string, baseVersion: number, onDate: DateStr, patch: SplitPatch): Promise<EventRow> {
    await this.wait();
    const r = this.lock(id, baseVersion, onDate);
    if (onDate === firstOn(r)) {
      const next: EvRow = { ...r, ...clone(patch) };
      this.check(next);
      Object.assign(r, next);
      this.touch(r);
      this.pruneExceptions(r);
      const { deleted_at: _, ...out } = r;
      return clone(out);
    }
    const n: EvRow = {
      ...clone(r),
      date: onDate,
      ...clone(patch),
      id: globalThis.crypto.randomUUID(),
      source: null,
      external_id: null,
      task_id: null,
      version: 1,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    this.check(n);
    const cut: EvRow = { ...r, repeat: r.repeat ? { ...r.repeat, until: addDays(onDate, -1) } : null };
    this.check(cut);
    this.ev.set(n.id, n);
    this.ex = this.ex.flatMap((x) => {
      if (x.event_id !== id || x.on_date < onDate) return [x];
      return n.repeat !== null && occursOn(n, x.on_date) ? [{ ...x, event_id: n.id }] : [];
    });
    r.repeat = cut.repeat;
    this.touch(r);
    const { deleted_at: _, ...out } = n;
    return clone(out);
  }

  async cut(id: string, baseVersion: number, onDate: DateStr): Promise<EventRow> {
    await this.wait();
    const r = this.lock(id, baseVersion, onDate);
    if (onDate === firstOn(r)) {
      r.deleted_at = new Date().toISOString();
      this.touch(r);
    } else {
      this.ex = this.ex.filter((x) => x.event_id !== id || x.on_date < onDate);
      r.repeat = r.repeat ? { ...r.repeat, until: addDays(onDate, -1) } : null;
      this.touch(r);
    }
    const { deleted_at: _, ...out } = r;
    return clone(out);
  }

  // ------------------------------------------------------------ 지점 · 이동시간 · 설정

  private livePlaces(): PlRow[] {
    return [...this.pl.values()].filter((p) => p.deleted_at === null);
  }

  private checkPlace(p: PlRow): void {
    const name = p.name;
    if (name !== name.trim() || [...name].length < 1 || [...name].length > 30) {
      throw new DbError('new row for relation "ez_places" violates check constraint "ez_places_name_check"', "23514");
    }
    for (const o of this.livePlaces()) {
      if (o.id === p.id) continue;
      if (o.name.toLowerCase() === name.toLowerCase()) throw unique("ez_places_name_unique");
      if (p.role === "home" && o.role === "home") throw unique("ez_places_home_unique");
    }
  }

  async createPlace(input: PlaceInput): Promise<Place> {
    await this.wait();
    if (this.livePlaces().length >= PLACES_MAX) throw ez("EZ_LIMIT", "지점은 12개까지 둘 수 있습니다. 안 쓰는 지점을 지우고 다시 하세요");
    const used = (c: string) => this.livePlaces().filter((p) => p.color === c).length;
    const color = input.color ?? [...PLACE_COLORS].sort((a, b) => used(a) - used(b) || PLACE_COLORS.indexOf(a) - PLACE_COLORS.indexOf(b))[0]!;
    const p: PlRow = {
      id: globalThis.crypto.randomUUID(),
      name: input.name,
      role: input.role,
      symbol: input.symbol ?? defaultSymbol(input.role),
      color,
      sort: input.sort ?? Math.max(0, ...this.livePlaces().map((x) => x.sort)) + 1,
      deleted: false,
      deleted_at: null,
    };
    this.checkPlace(p);
    this.pl.set(p.id, p);
    const { deleted_at: _, ...out } = p;
    return clone(out);
  }

  async updatePlace(id: string, patch: Partial<PlaceInput>): Promise<Place> {
    await this.wait();
    const p = this.pl.get(id);
    if (!p || p.deleted_at !== null) throw ez("EZ_NOT_FOUND", "지점이 없습니다");
    const next: PlRow = { ...p, ...patch };
    this.checkPlace(next);
    Object.assign(p, next);
    const { deleted_at: _, ...out } = p;
    return clone(out);
  }

  async deletePlace(id: string): Promise<void> {
    await this.wait();
    const p = this.pl.get(id);
    if (!p || p.deleted_at !== null) return;
    p.deleted_at = new Date().toISOString();
    p.deleted = true;
    this.tr = this.tr.filter((t) => t.a !== id && t.b !== id);
  }

  async setTravel(a: string, b: string, minutes: number | null): Promise<void> {
    await this.wait();
    const [x, y] = a < b ? [a, b] : [b, a];
    if (x === y) return;
    this.tr = this.tr.filter((t) => !(t.a === x && t.b === y));
    if (minutes === null) return;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) {
      throw new DbError('new row for relation "ez_travel" violates check constraint "ez_travel_minutes_check"', "23514");
    }
    if ([x, y].some((id) => this.pl.get(id)?.deleted_at !== null)) throw ez("EZ_PLACE", "지운 지점에는 이동시간을 둘 수 없습니다");
    this.tr.push({ a: x, b: y, minutes });
  }

  async saveSettings(patch: Partial<Omit<Settings, "tz">>): Promise<Settings> {
    await this.wait();
    const next = { ...this.st, ...clone(patch) };
    const bad = (["prep_first", "prep_again", "meal_min"] as const).find((k) => !Number.isInteger(next[k]) || next[k] < 0 || next[k] > 120);
    if (bad || !Number.isInteger(next.home_stay) || next.home_stay < 0 || next.home_stay > 600) {
      throw new DbError(`new row for relation "ez_schedule_settings" violates check constraint "ez_schedule_settings_${bad ?? "home_stay"}_check"`, "23514");
    }
    this.st = next;
    return clone(this.st);
  }

  // ------------------------------------------------------------ 플래너

  private task(id: string): TkRow {
    const t = this.tk.get(id);
    if (!t || t.deleted_at !== null) throw ez("EZ_NOT_FOUND", "할 일이 없습니다");
    return t;
  }

  private taskVersion(t: TkRow, base: number): void {
    if (t.version !== base) throw ez("EZ_VERSION", `그 사이 다른 곳에서 이 할 일을 고쳤습니다. 새로 불러오세요 (지금 버전 ${t.version})`);
  }

  private out(t: TkRow): TaskRow {
    const { deleted_at: _, ...rest } = t;
    return clone(rest);
  }

  async tasks(): Promise<TaskRow[]> {
    await this.wait();
    return [...this.tk.values()].filter((t) => t.deleted_at === null).sort((a, b) => a.sort - b.sort).map((t) => this.out(t));
  }

  async links(): Promise<TaskLink[]> {
    await this.wait();
    return [...this.ev.values()]
      .filter((e) => e.deleted_at === null && e.task_id !== null)
      .map((e) => ({ task_id: e.task_id!, event_id: e.id, date: e.date, start_min: e.start_min, repeating: e.repeat !== null }));
  }

  async createTask(input: TaskInput): Promise<TaskRow> {
    await this.wait();
    const issues = validateTask(input);
    if (issues.length > 0) throw ez("EZ_VALUE", issues[0]!.reason);
    const at = new Date().toISOString();
    const live = [...this.tk.values()].filter((t) => t.deleted_at === null);
    const t: TkRow = {
      id: globalThis.crypto.randomUUID(),
      title: input.title.trim(),
      note: input.note ?? null,
      due: input.due ?? null,
      est_min: input.est_min ?? null,
      sort: Math.min(0, ...live.map((x) => x.sort)) - 1,
      done_at: null,
      origin_kind: null,
      origin_id: null,
      version: 1,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    };
    this.tk.set(t.id, t);
    return this.out(t);
  }

  private bumpTask(t: TkRow): void {
    t.version += 1;
    t.updated_at = new Date().toISOString();
  }

  async updateTask(id: string, baseVersion: number, patch: Partial<TaskInput>): Promise<TaskRow> {
    await this.wait();
    const t = this.task(id);
    this.taskVersion(t, baseVersion);
    const next = { ...t, ...patch };
    const issues = validateTask(next);
    if (issues.length > 0) throw ez("EZ_VALUE", issues[0]!.reason);
    Object.assign(t, next);
    this.bumpTask(t);
    return this.out(t);
  }

  async setDone(id: string, baseVersion: number, done: boolean): Promise<TaskRow> {
    await this.wait();
    const t = this.task(id);
    this.taskVersion(t, baseVersion);
    t.done_at = done ? new Date().toISOString() : null;
    this.bumpTask(t);
    return this.out(t);
  }

  async deleteTask(id: string, baseVersion: number): Promise<void> {
    await this.wait();
    const t = this.task(id);
    this.taskVersion(t, baseVersion);
    t.deleted_at = new Date().toISOString();
    this.bumpTask(t);
  }

  async restoreTask(id: string): Promise<TaskRow> {
    await this.wait();
    const t = this.tk.get(id);
    if (!t) throw ez("EZ_NOT_FOUND", "되돌릴 할 일이 없습니다");
    t.deleted_at = null;
    this.bumpTask(t);
    return this.out(t);
  }

  async reorder(id: string, sort: number): Promise<TaskRow> {
    await this.wait();
    const t = this.task(id);
    if (!Number.isFinite(sort)) throw new DbError('violates check constraint "ez_tasks_sort_check"', "23514");
    t.sort = sort;
    this.bumpTask(t);
    return this.out(t);
  }
}
