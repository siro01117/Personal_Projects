// 개발 확인용 일정·플래너 메모리 저장소 (`?demo=1`, NODE_ENV=development 에서만 쓰인다).
//
// !! 진짜 규칙의 출처는 DB 다 (db/migrations/0006_ez_schedule.sql · 0007_ez_planner.sql).
// 여기서는 화면이 의지하는 것만 흉내 낸다: 버전 확인 · 바깥 일정 거절 · 집 하나 · 할 일 하나에 일정 하나 ·
// 지점 이름 겹침 · 지점 12개 · 반복 회차 검사 · split/cut · 일정에 딸린 마감(따라가기 · 끊기) · 반복 규칙 굴리기(roll) ·
// 역할(0008: 이름 겹침 · from_place 하나 · 12개 · 지우면 role_id null · seed 는 행이 하나도 없을 때만) ·
// 모임에서 온 일정(0011: 지우면 모임에 알리고 되돌리면 다시 알린다 — meetHooks. 모임 쪽 흉내는 meetMemory.ts).
// 칸 검사는 lib/schedule 의 validateEvent 를 그대로 쓰고, 오류는 DB 와 같은 모양(SQLSTATE · '[EZ_*] 설명')으로 던진다.

import { DbError } from "../../lib/errors";
import {
  addDays,
  CHECK_ITEM_MAX,
  CHECKLIST_MAX,
  daysBetween,
  DEFAULT_ROLES,
  DEFAULT_SETTINGS,
  DUE_AFTER_MAX,
  occursOn,
  PLACE_COLORS,
  PLACES_MAX,
  ROLE_NAME_MAX,
  ROLES_MAX,
  validateEvent,
  validateTask,
  type DateStr,
  type EventException,
  type EventRow,
  type ExceptionPatch,
  type OriginKind,
  type Place,
  type PlaceSymbol,
  type Role,
  type Settings,
  type TaskRow,
  type TaskRule,
  type Travel,
} from "../../lib/schedule";
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

const ez = (code: string, message: string) => new DbError(`[${code}] ${message}`, "P0001");
const unique = (name: string) => new DbError(`duplicate key value violates unique constraint "${name}"`, "23505");
const clone = <T>(x: T): T => structuredClone(x);

type EvRow = EventRow & { deleted_at: string | null };
type PlRow = Place & { deleted_at: string | null };
type TkRow = TaskRow & { deleted_at: string | null };
type RlRow = TaskRule & { deleted_at: string | null };
type RoRow = Role & { deleted_at: string | null };

export type ScheduleSeed = {
  places?: Place[];
  travel?: Travel[];
  settings?: Partial<Settings>;
  sources?: SourceInfo[];
  events?: (Partial<EventRow> & Pick<EventRow, "id" | "title" | "date">)[];
  exceptions?: EventException[];
  tasks?: (Partial<TaskRow> & Pick<TaskRow, "id" | "title">)[];
  rules?: (Partial<TaskRule> & Pick<TaskRule, "id" | "kind" | "title">)[];
  roles?: (Partial<Role> & Pick<Role, "id" | "name">)[];
};

const RULE_KEYS = ["kind", "title", "note", "est_min", "place_id", "checklist", "repeat", "start", "event_id", "due_after", "last_made", "role_id"] as const;
const TASK_KEYS = ["title", "note", "due", "est_min", "place_id", "due_event_id", "checklist", "rule_id", "rule_date", "role_id"] as const;
/** roll 이 돌아보는 날 수 */
const ROLL_BACK = 60;

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
  /** 넣은 순서 = 만든 순서 (roll 이 이 순서로 돈다) */
  private readonly rl = new Map<string, RlRow>();
  private readonly ro = new Map<string, RoRow>();
  private ex: EventException[] = [];
  private tr: Travel[] = [];
  private st: Settings;
  private src: SourceInfo[];
  private readonly latency: number;
  /** 모임에서 온 일정이 지워지거나 되돌아올 때 (0011 ez_events_after). meetMemory 가 건다 */
  meetHooks: { gone?: (eventId: string) => void; back?: (ev: EventRow) => void } = {};

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
        place_id: null,
        due_event_id: null,
        checklist: [],
        rule_id: null,
        rule_date: null,
        role_id: null,
        bench_order: null,
        bench_at: null,
        version: 1,
        created_at: at,
        updated_at: at,
        deleted_at: null,
        ...clone(t),
      });
    }
    for (const r of seed.rules ?? []) {
      this.rl.set(r.id, {
        note: null,
        est_min: null,
        place_id: null,
        checklist: [],
        repeat: null,
        start: null,
        event_id: null,
        due_after: null,
        last_made: null,
        role_id: null,
        version: 1,
        deleted_at: null,
        ...clone(r),
      });
    }
    for (const [i, r] of (seed.roles ?? []).entries()) this.ro.set(r.id, { from_place: null, sort: i + 1, version: 1, deleted_at: null, ...r });
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

  /** 지금 설정의 내 이름 (모임의 내 줄) */
  myName(): string | null {
    return this.st.my_name;
  }

  /** 살아 있는 일정 줄 (모임이 딸린 일정을 옮기거나 지울 때) */
  liveEvent(id: string): EventRow | null {
    const r = this.ev.get(id);
    if (!r || r.deleted_at !== null) return null;
    const { deleted_at: _, ...out } = r;
    return clone(out);
  }

  /** origin = 어디서 넘어온 일정인가 (모임이 만든 일정) */
  async createEvent(input: EventInput, origin: { kind: OriginKind; id: string } | null = null): Promise<EventRow> {
    await this.wait();
    const r: EvRow = {
      id: globalThis.crypto.randomUUID(),
      ...input,
      source: null,
      external_id: null,
      origin_kind: origin?.kind ?? null,
      origin_id: origin?.id ?? null,
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
    const old = { ...r };
    Object.assign(r, next);
    if (changed) this.touch(r);
    this.pruneExceptions(r);
    this.afterEvent(old, r);
    const { deleted_at: _, ...out } = r;
    return clone(out);
  }

  /**
   * 일정이 바뀐 뒤 딸린 것 (0007 ez_events_after): 지우면 딸린 마감은 연결만 끊기고 규칙은 멈춘다,
   * 반복이 아니게 되면 규칙이 멈춘다, 반복 아닌 일정의 날짜가 바뀌면 딸린 마감이 따라간다
   */
  private afterEvent(old: EvRow, r: EvRow): void {
    const at = new Date().toISOString();
    const stopRules = () => {
      for (const x of this.rl.values()) {
        if (x.event_id === r.id && x.deleted_at === null) {
          x.deleted_at = at;
          x.version += 1;
        }
      }
    };
    if (r.deleted_at !== null && old.deleted_at === null) {
      for (const t of this.tk.values()) {
        if (t.due_event_id === r.id) {
          t.due_event_id = null;
          this.bumpTask(t);
        }
      }
      stopRules();
      this.meetHooks.gone?.(r.id);
      return;
    }
    if (r.repeat === null && old.repeat !== null) stopRules();
    if (r.repeat === null && r.deleted_at === null && r.date !== old.date) {
      for (const t of this.tk.values()) {
        if (t.due_event_id === r.id && t.deleted_at === null && t.due !== r.date) {
          t.due = r.date;
          this.bumpTask(t);
        }
      }
    }
  }

  async dependents(id: string): Promise<EventDeps> {
    await this.wait();
    return {
      tasks: [...this.tk.values()].filter((t) => t.due_event_id === id).map((t) => t.id),
      rules: [...this.rl.values()].filter((r) => r.event_id === id && r.deleted_at === null).map((r) => r.id),
    };
  }

  async deleteEvent(id: string, baseVersion: number): Promise<void> {
    await this.wait();
    const r = this.row(id);
    this.notExternal(r);
    this.version(r, baseVersion);
    const old = { ...r };
    r.deleted_at = new Date().toISOString();
    this.touch(r);
    this.afterEvent(old, r);
  }

  async restoreEvent(id: string, deps?: EventDeps): Promise<EventRow> {
    await this.wait();
    const r = this.ev.get(id);
    if (!r) throw ez("EZ_NOT_FOUND", "되돌릴 일정이 없습니다");
    this.notExternal(r);
    const next = { ...r, deleted_at: null };
    this.check(next);
    r.deleted_at = null;
    this.touch(r);
    if (r.origin_kind === "meet") this.meetHooks.back?.(r);
    // 끊긴 마감 연결 · 멈춘 규칙을 다시 잇는다. 그 사이 달라진 것(다른 일정에 걺 · 지움 · 회차가 아님)은 건너뛴다
    for (const tid of deps?.tasks ?? []) {
      const t = this.tk.get(tid);
      if (!t || t.deleted_at !== null || t.due_event_id !== null) continue;
      const linked: TkRow = { ...t, due_event_id: id };
      try {
        this.guardDue(linked, t);
      } catch {
        continue;
      }
      Object.assign(t, linked);
      this.bumpTask(t);
    }
    for (const rid of deps?.rules ?? []) {
      const x = this.rl.get(rid);
      if (!x || x.deleted_at === null || x.event_id !== id || r.repeat === null) continue;
      x.deleted_at = null;
      x.version += 1;
    }
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
      const old = { ...r };
      Object.assign(r, next);
      this.touch(r);
      this.pruneExceptions(r);
      this.afterEvent(old, r);
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
    // 딸린 규칙(끝나면 할 일)은 새 일정으로 옮긴다. 새 일정이 반복이 아니면 옮길 수 없어 그대로 둔다
    if (n.repeat !== null) {
      for (const x of this.rl.values()) {
        if (x.event_id === id && x.deleted_at === null) {
          x.event_id = n.id;
          x.version += 1;
        }
      }
    }
    const { deleted_at: _, ...out } = n;
    return clone(out);
  }

  async cut(id: string, baseVersion: number, onDate: DateStr): Promise<EventRow> {
    await this.wait();
    const r = this.lock(id, baseVersion, onDate);
    if (onDate === firstOn(r)) {
      const old = { ...r };
      r.deleted_at = new Date().toISOString();
      this.touch(r);
      this.afterEvent(old, r);
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
    const me = next.my_name;
    if (me !== null && (me !== me.trim() || [...me].length < 1 || [...me].length > 20)) {
      throw new DbError('new row for relation "ez_schedule_settings" violates check constraint "ez_schedule_settings_my_name_check"', "23514");
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
      .map((e) => ({ task_id: e.task_id!, event_id: e.id, date: e.date, start_min: e.start_min, end_min: e.end_min, repeating: e.repeat !== null }));
  }

  async rules(): Promise<TaskRule[]> {
    await this.wait();
    return [...this.rl.values()].filter((r) => r.deleted_at === null).map((r) => this.outRule(r));
  }

  async eventTitles(ids: readonly string[]): Promise<Record<string, string>> {
    await this.wait();
    const out: Record<string, string> = {};
    for (const id of ids) {
      const e = this.ev.get(id);
      if (e && e.deleted_at === null) out[id] = e.title;
    }
    return out;
  }

  /**
   * 일정에 딸린 마감 (0007 ez_tasks_guard). 반복 아닌 일정: 걸 때 due 를 일정 날짜로 맞추고, 건 채로 due 만 바꾸면 거절.
   * 반복 일정: due 가 있어야 하고 그 일정의 회차여야 한다. old 가 없으면 넣기
   */
  private guardDue(next: TkRow, old: TkRow | null): void {
    if (next.due_event_id === null) return;
    const link = old === null || next.due_event_id !== old.due_event_id;
    if (!link && next.due === old!.due) return;
    const e = this.ev.get(next.due_event_id);
    if (!e) throw new DbError('insert or update on table "ez_tasks" violates foreign key constraint "ez_tasks_due_event_fk"', "23503");
    if (e.deleted_at !== null) throw ez("EZ_EVENT", "지운 일정에는 마감을 걸 수 없습니다");
    if (e.repeat === null) {
      if (link) next.due = e.date;
      else if (next.due !== e.date) {
        throw ez("EZ_VALUE", "일정에 딸린 마감은 일정 날짜를 따라갑니다. 날짜를 따로 정하려면 일정 연결(due_event_id)을 비우세요");
      }
    } else {
      if (next.due === null) throw ez("EZ_VALUE", "반복 일정에 마감을 걸 때는 어느 회차인지 날짜(due)를 같이 써 주세요");
      if (!occursOn(e, next.due)) throw ez("EZ_DATE", `${next.due} 는 이 일정이 반복되는 날이 아닙니다`);
    }
  }

  private checkTask(next: TkRow, old: TkRow | null): void {
    const issues = validateTask(next);
    if (issues.length > 0) throw ez("EZ_VALUE", issues[0]!.reason);
    const list = next.checklist;
    const ok =
      Array.isArray(list) &&
      list.length <= CHECKLIST_MAX &&
      list.every((c) => typeof c.t === "string" && typeof c.done === "boolean" && c.t === c.t.trim() && [...c.t].length >= 1 && [...c.t].length <= CHECK_ITEM_MAX);
    if (!ok) throw new DbError('new row for relation "ez_tasks" violates check constraint "ez_tasks_checklist_check"', "23514");
    if (next.place_id !== null && !this.pl.has(next.place_id)) {
      throw new DbError('insert or update on table "ez_tasks" violates foreign key constraint "ez_tasks_place_fk"', "23503");
    }
    this.checkRoleRef(next.role_id, old?.role_id ?? null, "ez_tasks");
    if ((next.rule_id === null) !== (next.rule_date === null)) {
      throw new DbError('new row for relation "ez_tasks" violates check constraint "ez_tasks_rule_check"', "23514");
    }
    if (next.rule_id !== null) {
      if (!this.rl.has(next.rule_id)) throw new DbError('insert or update on table "ez_tasks" violates foreign key constraint "ez_tasks_rule_fk"', "23503");
      for (const o of this.tk.values()) {
        if (o.id !== next.id && o.rule_id === next.rule_id && o.rule_date === next.rule_date) throw unique("ez_tasks_rule_once");
      }
    }
    this.guardDue(next, old);
  }

  private topSort(): number {
    const live = [...this.tk.values()].filter((t) => t.deleted_at === null);
    return live.length === 0 ? 0 : Math.min(...live.map((x) => x.sort)) - 1;
  }

  async createTask(input: TaskInput): Promise<TaskRow> {
    await this.wait();
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
      origin_kind: input.origin_kind ?? null,
      origin_id: input.origin_id ?? null,
      place_id: input.place_id ?? null,
      due_event_id: input.due_event_id ?? null,
      checklist: clone(input.checklist ?? []),
      rule_id: input.rule_id ?? null,
      rule_date: input.rule_date ?? null,
      role_id: input.role_id ?? null,
      bench_order: null,
      bench_at: null,
      version: 1,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    };
    this.checkTask(t, null);
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
    const next: TkRow = { ...t };
    for (const k of TASK_KEYS) if (k in patch && patch[k] !== undefined) (next as Record<string, unknown>)[k] = clone(patch[k]);
    this.checkTask(next, t);
    Object.assign(t, next);
    this.bumpTask(t);
    return this.out(t);
  }

  async setDone(id: string, baseVersion: number, done: boolean): Promise<TaskRow> {
    await this.wait();
    const t = this.task(id);
    this.taskVersion(t, baseVersion);
    t.done_at = done ? new Date().toISOString() : null;
    // 끝내면 작업대에서 내려온다 (0017 ez_tasks_bench)
    if (done) {
      t.bench_at = null;
      t.bench_order = null;
    }
    this.bumpTask(t);
    return this.out(t);
  }

  async deleteTask(id: string, baseVersion: number): Promise<void> {
    await this.wait();
    const t = this.task(id);
    this.taskVersion(t, baseVersion);
    t.deleted_at = new Date().toISOString();
    t.bench_at = null;
    t.bench_order = null;
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

  /** 올린 것 중 가장 큰 순서 + 1 (0017 ez_task_bench) */
  private nextBench(): number {
    let max = 0;
    for (const o of this.tk.values()) if (o.deleted_at === null && o.bench_order !== null) max = Math.max(max, o.bench_order);
    return max + 1;
  }

  async bench(id: string, on: boolean): Promise<TaskRow> {
    await this.wait();
    const t = this.task(id);
    if (!on) {
      if (t.bench_order === null && t.bench_at === null) return this.out(t);
      t.bench_order = null;
      t.bench_at = null;
      this.bumpTask(t);
      return this.out(t);
    }
    if (t.done_at !== null) throw ez("EZ_VALUE", "끝낸 할 일은 작업대에 올릴 수 없습니다. 끝냄을 풀고 다시 하세요");
    if (t.bench_order !== null) return this.out(t);
    t.bench_order = this.nextBench();
    this.bumpTask(t);
    return this.out(t);
  }

  async sit(id: string): Promise<TaskRow> {
    await this.wait();
    const t = this.task(id);
    if (t.done_at !== null) throw ez("EZ_VALUE", "끝낸 할 일에는 앉을 수 없습니다. 끝냄을 풀고 다시 하세요");
    if (t.bench_at !== null) return this.out(t);
    for (const o of this.tk.values()) {
      if (o.id !== id && o.bench_at !== null) {
        o.bench_at = null;
        this.bumpTask(o);
      }
    }
    if (t.bench_order === null) t.bench_order = this.nextBench();
    t.bench_at = new Date().toISOString();
    this.bumpTask(t);
    return this.out(t);
  }

  async reorderBench(ids: readonly string[]): Promise<TaskRow[]> {
    await this.wait();
    const out: TaskRow[] = [];
    ids.forEach((id, i) => {
      const t = this.tk.get(id);
      if (!t || t.deleted_at !== null || t.bench_order === null || t.bench_order === i + 1) return;
      t.bench_order = i + 1;
      this.bumpTask(t);
      out.push(this.out(t));
    });
    return out;
  }

  // ------------------------------------------------------------ 반복 규칙 (0007 ez_task_rules · ez_tasks_roll)

  private outRule(r: RlRow): TaskRule {
    const { deleted_at: _, ...rest } = r;
    return clone(rest);
  }

  /** 칸 범위 · kind 별 칸 · 살아 있는 반복 일정 (ez_task_rules 의 CHECK 와 ez_task_rules_guard) */
  private checkRule(r: RlRow, old: RlRow | null): void {
    const bad = (name: string) => new DbError(`new row for relation "ez_task_rules" violates check constraint "ez_task_rules_${name}_check"`, "23514");
    const len = [...r.title].length;
    if (r.title !== r.title.trim() || len < 1 || len > 200) throw bad("title");
    if (r.note !== null && [...r.note].length > 2000) throw bad("note");
    if (r.est_min !== null && (!Number.isInteger(r.est_min) || r.est_min < 5 || r.est_min > 600)) throw bad("est");
    const texts = r.checklist;
    if (!Array.isArray(texts) || texts.length > CHECKLIST_MAX || !texts.every((t) => typeof t === "string" && t === t.trim() && [...t].length >= 1 && [...t].length <= CHECK_ITEM_MAX)) {
      throw bad("checklist");
    }
    if (r.due_after !== null && (!Number.isInteger(r.due_after) || r.due_after < 0 || r.due_after > DUE_AFTER_MAX)) throw bad("due_after");
    if (r.place_id !== null && !this.pl.has(r.place_id)) {
      throw new DbError('insert or update on table "ez_task_rules" violates foreign key constraint "ez_task_rules_place_fk"', "23503");
    }
    this.checkRoleRef(r.role_id, old?.role_id ?? null, "ez_task_rules");
    if (r.kind === "cycle") {
      if (r.repeat === null || r.start === null || r.event_id !== null) throw bad("kind");
      if (r.repeat.until) throw ez("EZ_VALUE", "반복 할 일에는 끝나는 날(until)을 쓰지 않습니다. 그만하려면 규칙을 멈추세요");
      const issue = validateEvent({ title: "x", date: r.start, repeat: r.repeat }).find((i) => i.path.startsWith("repeat") || i.path === "date");
      if (issue) throw ez("EZ_VALUE", issue.reason);
      return;
    }
    if (r.kind !== "event" || r.event_id === null || r.repeat !== null || r.start !== null) throw bad("kind");
    // 넣을 때 · 일정을 바꿀 때 · 멈춘 규칙을 되살릴 때만 본다
    if (r.deleted_at === null && (old === null || old.event_id !== r.event_id || old.deleted_at !== null || old.kind !== r.kind)) {
      const e = this.ev.get(r.event_id);
      if (!e) throw new DbError('insert or update on table "ez_task_rules" violates foreign key constraint "ez_task_rules_event_fk"', "23503");
      if (e.deleted_at !== null) throw ez("EZ_NOT_FOUND", "지운 일정에는 반복 할 일을 걸 수 없습니다");
      if (e.repeat === null) throw ez("EZ_REPEAT", "반복 일정이 아니라 끝날 때마다 할 일을 만들 수 없습니다. 반복 일정을 고르세요");
    }
  }

  async createRule(input: RuleInput): Promise<TaskRule> {
    await this.wait();
    const r: RlRow = { id: globalThis.crypto.randomUUID(), ...clone(input), version: 1, deleted_at: null };
    this.checkRule(r, null);
    this.rl.set(r.id, r);
    return this.outRule(r);
  }

  async updateRule(id: string, patch: Partial<RuleInput>): Promise<TaskRule> {
    await this.wait();
    const r = this.rl.get(id);
    if (!r || r.deleted_at !== null) throw ez("EZ_NOT_FOUND", "반복 규칙이 없습니다");
    const next: RlRow = { ...r };
    for (const k of RULE_KEYS) if (k in patch && patch[k] !== undefined) (next as Record<string, unknown>)[k] = clone(patch[k]);
    this.checkRule(next, r);
    Object.assign(r, next);
    r.version += 1;
    return this.outRule(r);
  }

  async stopRule(id: string): Promise<void> {
    await this.wait();
    const r = this.rl.get(id);
    if (!r || r.deleted_at !== null) return;
    r.deleted_at = new Date().toISOString();
    r.version += 1;
  }

  /**
   * 그 회차가 끝나는 시각 (회차 날짜 0시부터 센 분). 이번만 바꾼 end_min 이 있으면 그것, 종일이면 1440.
   * 건너뛴 회차는 null
   */
  private occurrenceEnd(e: EvRow, d: DateStr): number | null {
    const x = this.ex.find((y) => y.event_id === e.id && y.on_date === d);
    if (x?.skip) return null;
    const end = x?.patch && "end_min" in x.patch ? (x.patch.end_min ?? null) : e.end_min;
    return end ?? 1440;
  }

  async roll(today: DateStr, nowMin: number): Promise<number> {
    await this.wait();
    if (!Number.isInteger(nowMin) || nowMin < 0 || nowMin > 1439) throw ez("EZ_VALUE", "지금 시각(p_now_min)은 0~1439분(00:00~23:59)이어야 합니다");
    const floor = addDays(today, -ROLL_BACK);
    const later = (a: DateStr, b: DateStr) => (a >= b ? a : b);
    let made = 0;
    for (const r of [...this.rl.values()]) {
      if (r.deleted_at !== null) continue;
      // 가장 최근 회차 하나: last_made 다음 날(없으면 시작)과 60일 전 중 늦은 날부터 오늘까지에서 가장 늦은 날
      let d: DateStr | null = null;
      if (r.kind === "cycle") {
        if (r.repeat === null || r.start === null) continue;
        const base = { date: r.start, repeat: r.repeat } as EventRow;
        const from = later(r.last_made ? addDays(r.last_made, 1) : r.start, floor);
        for (let x = today; x >= from; x = addDays(x, -1)) {
          if (occursOn(base, x)) {
            d = x;
            break;
          }
        }
      } else {
        const e = r.event_id ? this.ev.get(r.event_id) : undefined;
        if (!e || e.deleted_at !== null || e.repeat === null) continue;
        const from = later(r.last_made ? addDays(r.last_made, 1) : e.date, floor);
        for (let x = today; x >= from; x = addDays(x, -1)) {
          if (!occursOn(e, x)) continue;
          const end = this.occurrenceEnd(e, x);
          // 끝나야 만든다: 끝 시각이 지금(그 회차 날짜 0시부터 센 분)보다 뒤면 아직
          if (end === null || end > daysBetween(x, today) * 1440 + nowMin) continue;
          d = x;
          break;
        }
      }
      if (d === null) continue;

      // 밀리면 한 건만: 안 끝낸 지난 회차는 지운다
      for (const t of this.tk.values()) {
        if (t.rule_id === r.id && t.rule_date !== null && t.rule_date < d && t.done_at === null && t.deleted_at === null) {
          t.deleted_at = new Date().toISOString();
          t.bench_at = null;
          t.bench_order = null;
          this.bumpTask(t);
        }
      }
      // 같은 (규칙, 회차)가 이미 있으면(지운 것 포함) 만들지 않는다
      const on = d;
      if (![...this.tk.values()].some((t) => t.rule_id === r.id && t.rule_date === on)) {
        const at = new Date().toISOString();
        const t: TkRow = {
          id: globalThis.crypto.randomUUID(),
          title: r.title,
          note: r.note,
          due: r.due_after !== null ? addDays(on, r.due_after) : null,
          est_min: r.est_min,
          sort: this.topSort(),
          done_at: null,
          origin_kind: null,
          origin_id: null,
          place_id: r.place_id,
          due_event_id: null,
          checklist: r.checklist.map((c) => ({ t: c, done: false })),
          rule_id: r.id,
          rule_date: on,
          role_id: r.role_id,
          bench_order: null,
          bench_at: null,
          version: 1,
          created_at: at,
          updated_at: at,
          deleted_at: null,
        };
        this.tk.set(t.id, t);
        made += 1;
      }
      r.last_made = on;
    }
    return made;
  }

  // ------------------------------------------------------------ 역할 (0008 ez_roles · ez_roles_seed)

  private outRole(r: RoRow): Role {
    const { deleted_at: _, ...rest } = r;
    return clone(rest);
  }

  private liveRoles(): RoRow[] {
    return [...this.ro.values()].filter((r) => r.deleted_at === null);
  }

  /** 할 일 · 규칙에 역할을 걸 때: 없는 역할은 FK, 지운 역할은 [EZ_ROLE]. 걸거나 바꿀 때만 본다 */
  private checkRoleRef(next: string | null, old: string | null, table: string): void {
    if (next === null || next === old) return;
    const r = this.ro.get(next);
    if (!r) throw new DbError(`insert or update on table "${table}" violates foreign key constraint "${table}_role_fk"`, "23503");
    if (r.deleted_at !== null) throw ez("EZ_ROLE", "지운 역할입니다. 다른 역할을 고르세요");
  }

  /** 이름 1~20자(앞뒤 공백 없음) · 살아 있는 것끼리 이름 겹침 · from_place 는 값마다 하나 */
  private checkRole(r: RoRow): void {
    const len = [...r.name].length;
    if (r.name !== r.name.trim() || len < 1 || len > ROLE_NAME_MAX) {
      throw new DbError('new row for relation "ez_roles" violates check constraint "ez_roles_name_check"', "23514");
    }
    if (!Number.isFinite(r.sort)) throw new DbError('new row for relation "ez_roles" violates check constraint "ez_roles_sort_check"', "23514");
    for (const o of this.liveRoles()) {
      if (o.id === r.id) continue;
      if (o.name.toLowerCase() === r.name.toLowerCase()) throw unique("ez_roles_name_unique");
      if (r.from_place !== null && o.from_place === r.from_place) throw unique("ez_roles_from_place_unique");
    }
  }

  private roleLimit(): void {
    if (this.liveRoles().length >= ROLES_MAX) throw ez("EZ_LIMIT", `역할은 ${ROLES_MAX}개까지 둘 수 있습니다. 안 쓰는 역할을 지우고 다시 하세요`);
  }

  async roles(): Promise<Role[]> {
    await this.wait();
    return this.liveRoles()
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
      .map((r) => this.outRole(r));
  }

  async seedRoles(): Promise<number> {
    await this.wait();
    if (this.ro.size > 0) return 0;
    for (const [i, d] of DEFAULT_ROLES.entries()) {
      const id = globalThis.crypto.randomUUID();
      this.ro.set(id, { id, name: d.name, from_place: d.from_place, sort: i + 1, version: 1, deleted_at: null });
    }
    return DEFAULT_ROLES.length;
  }

  async createRole(input: RoleInput): Promise<Role> {
    await this.wait();
    this.roleLimit();
    const r: RoRow = {
      id: globalThis.crypto.randomUUID(),
      name: input.name,
      from_place: input.from_place ?? null,
      sort: input.sort ?? Math.max(0, ...this.liveRoles().map((x) => x.sort)) + 1,
      version: 1,
      deleted_at: null,
    };
    this.checkRole(r);
    this.ro.set(r.id, r);
    return this.outRole(r);
  }

  async updateRole(id: string, patch: Partial<RoleInput>): Promise<Role> {
    await this.wait();
    const r = this.ro.get(id);
    if (!r || r.deleted_at !== null) throw ez("EZ_NOT_FOUND", "역할이 없습니다");
    const next: RoRow = { ...r };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.from_place !== undefined) next.from_place = patch.from_place;
    if (patch.sort !== undefined) next.sort = patch.sort;
    this.checkRole(next);
    Object.assign(r, next);
    r.version += 1;
    return this.outRole(r);
  }

  async deleteRole(id: string): Promise<RoleDeps> {
    await this.wait();
    const r = this.ro.get(id);
    const deps: RoleDeps = { tasks: [], rules: [] };
    if (!r || r.deleted_at !== null) return deps;
    r.deleted_at = new Date().toISOString();
    r.version += 1;
    for (const t of this.tk.values()) {
      if (t.role_id !== id) continue;
      deps.tasks.push(t.id);
      t.role_id = null;
      this.bumpTask(t);
    }
    for (const x of this.rl.values()) {
      if (x.role_id !== id) continue;
      deps.rules.push(x.id);
      x.role_id = null;
      x.version += 1;
    }
    return deps;
  }

  async restoreRole(id: string, deps?: RoleDeps): Promise<Role> {
    await this.wait();
    const r = this.ro.get(id);
    if (!r) throw ez("EZ_NOT_FOUND", "되돌릴 역할이 없습니다");
    if (r.deleted_at !== null) {
      this.roleLimit();
      this.checkRole({ ...r, deleted_at: null });
      r.deleted_at = null;
      r.version += 1;
    }
    // 그 사이 다른 역할을 고른 것은 건너뛴다
    for (const tid of deps?.tasks ?? []) {
      const t = this.tk.get(tid);
      if (!t || t.role_id !== null) continue;
      t.role_id = id;
      this.bumpTask(t);
    }
    for (const rid of deps?.rules ?? []) {
      const x = this.rl.get(rid);
      if (!x || x.role_id !== null) continue;
      x.role_id = id;
      x.version += 1;
    }
    return this.outRole(r);
  }
}
