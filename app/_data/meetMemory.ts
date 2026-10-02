// 개발 확인용 모임 메모리 저장소 (`?demo=1`, NODE_ENV=development 에서만 쓰인다).
//
// !! 진짜 규칙의 출처는 DB 다 (db/migrations/0011_ez_meets.sql · 0012_ez_meet_public.sql).
// 여기서는 화면이 의지하는 것만 흉내 낸다: 버전 확인 · 내 줄이 같이 생김(설정의 내 이름) · 이름 겹침(대소문자 · 공백 무시) ·
// 50명 · 묶음 30개 · 지운 묶음은 새로 못 걺 · 시간 ↔ 일정(시간이 생기면 일정이 생기고, 바꾸면 따라가고, 비우면 지워진다.
// 일정 화면에서 지우면 event_id 만 비고 되돌리면 다시 붙는다). 일정은 같은 확인 모드의 일정 저장소(MemorySchedule)에 넣는다.
// 시간 맞추기(0012): 맞추기를 켜면 내 줄이 자동 채움 상태 · 공개 링크 열쇠 · 남이 들어오기(이름 + 핀, 5번 틀리면 10분 잠김) ·
// 되는 칸 저장(검사는 lib/meet 의 validateCells) · 온다 / 못 온다 · 핀 지우기. 핀은 이 저장소 안에만 있고 어떤 결과에도 안 실린다.
// 칸 검사는 lib/meet 의 validateMeet · validateCircle 을 그대로 쓰고, 오류는 DB 와 같은 모양(SQLSTATE · '[EZ_*] 설명')으로 던진다.

import { DbError } from "../../lib/errors";
import {
  ATTENDS,
  CELL_DATES_MAX,
  CIRCLES_MAX,
  cleanCells,
  clipCells,
  DEFAULT_MY_NAME,
  nameKey,
  PEOPLE_MAX,
  personNameProblem,
  PIN_LOCK_MIN,
  PIN_RE,
  PIN_TRIES,
  samePoll,
  SLOT_MIN,
  sortPeople,
  TOKEN_RE,
  validateCells,
  validateCircle,
  validateMeet,
  type Attend,
  type Cells,
  type Circle,
  type Meet,
  type MeetPerson,
  type MeetRow,
  type Poll,
  type PublicMeet,
} from "../../lib/meet";
import type { DateStr } from "../../lib/schedule";
import type { MemorySchedule } from "./scheduleMemory";
import type { CircleInput, Entered, EventInput, MeetData, MeetInput, MeetPublicData, PersonInput, PersonPatch } from "./types";

const ez = (code: string, message: string) => new DbError(`[${code}] ${message}`, "P0001");
const unique = (name: string) => new DbError(`duplicate key value violates unique constraint "${name}"`, "23505");
const check = (name: string) => new DbError(`new row violates check constraint "${name}"`, "23514");
const clone = <T>(x: T): T => structuredClone(x);
const uuid = () => globalThis.crypto.randomUUID();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 공개 링크 열쇠 22자 (0012 ez_meet_link 와 같은 모양) */
function newToken(): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(22));
  return Array.from(bytes, (b) => abc[b % 64]).join("");
}

/** 칸의 생김새 (0012 ez_cells_ok): 날짜 100개 · 날짜마다 48칸까지, 30분 단위 0~1410, 이른 순 · 겹침 없음 */
function cellsOk(c: unknown): boolean {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
  const entries = Object.entries(c as Record<string, unknown>);
  if (entries.length > CELL_DATES_MAX) return false;
  return entries.every(
    ([d, list]) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      Array.isArray(list) &&
      list.length <= 48 &&
      list.every((m, i) => Number.isInteger(m) && m % SLOT_MIN === 0 && m >= 0 && m <= 1410 && (i === 0 || m > list[i - 1])),
  );
}

/** 사람 줄에 딸린 핀 (어떤 결과에도 안 실린다) */
type Pin = { pin: string; fails: number; lockedUntil: number | null };

type MtRow = MeetRow & { deleted_at: string | null };
type CrRow = Circle & { deleted_at: string | null };

export type MeetSeed = {
  circles?: (Partial<Circle> & Pick<Circle, "id" | "name">)[];
  /** people 은 내 줄을 뺀 사람들(pin 을 주면 이미 들어온 사람). me = 내 줄의 참석 */
  meets?: (Partial<MeetRow> &
    Pick<MeetRow, "id" | "title"> & { people?: { name: string; attend?: Attend | null; cells?: Cells | null; pin?: string }[]; me?: Attend | null })[];
};

const MEET_KEYS = ["title", "note", "circle_id", "place_id", "place_text", "meet_date", "start_min", "end_min", "poll"] as const;

export class MemoryMeet implements MeetData, MeetPublicData {
  private readonly mt = new Map<string, MtRow>();
  private readonly cr = new Map<string, CrRow>();
  /** 넣은 순서 = 만든 순서 */
  private pp: MeetPerson[] = [];
  /** 사람 id → 핀 */
  private readonly pins = new Map<string, Pin>();
  private readonly latency: number;
  private readonly clock: () => number;
  private tick = 0;

  constructor(
    private readonly schedule: MemorySchedule,
    seed: MeetSeed = {},
    opts: { latency?: number; now?: () => number } = {},
  ) {
    this.latency = opts.latency ?? 0;
    this.clock = opts.now ?? Date.now;
    const at = new Date().toISOString();
    for (const c of seed.circles ?? []) this.cr.set(c.id, { role_id: null, members: [], version: 1, deleted_at: null, ...clone(c) });
    for (const { people, me, ...m } of seed.meets ?? []) {
      this.mt.set(m.id, {
        note: null,
        circle_id: null,
        place_id: null,
        place_text: null,
        meet_date: null,
        start_min: null,
        end_min: null,
        event_id: null,
        poll: null,
        token: null,
        version: 1,
        created_at: at,
        updated_at: at,
        deleted_at: null,
        ...clone(m),
      });
      this.pp.push(this.newPerson(m.id, DEFAULT_MY_NAME, true, { attend: me ?? null, auto: (m.poll ?? null) !== null }));
      for (const p of people ?? []) {
        const row = this.newPerson(m.id, p.name, false, { attend: p.attend ?? null, cells: clone(p.cells ?? null), has_pin: p.pin !== undefined });
        if (p.pin !== undefined) this.pins.set(row.id, { pin: p.pin, fails: 0, lockedUntil: null });
        this.pp.push(row);
      }
    }
    // 일정 화면에서 그 일정을 지우면 event_id 만 비고, 되돌리면 다시 붙는다 (0011 ez_events_after)
    schedule.meetHooks = {
      gone: (eventId) => {
        for (const m of this.mt.values()) if (m.event_id === eventId) m.event_id = null;
      },
      back: (ev) => {
        const m = ev.origin_id ? this.mt.get(ev.origin_id) : undefined;
        if (m && m.deleted_at === null && m.event_id === null && m.meet_date !== null) m.event_id = ev.id;
      },
    };
  }

  private async wait(): Promise<void> {
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
  }

  /** 만든 시각 — 같은 순간에 넣어도 넣은 순서가 남게 조금씩 민다 */
  private stamp(): string {
    this.tick += 1;
    return new Date(Date.now() + this.tick).toISOString();
  }

  private newPerson(meetId: string, name: string, isOwner: boolean, extra: Partial<MeetPerson> = {}): MeetPerson {
    return { id: uuid(), meet_id: meetId, name, is_owner: isOwner, cells: null, auto: false, attend: null, has_pin: false, created_at: this.stamp(), ...extra };
  }

  private out(m: MtRow): Meet {
    const { deleted_at: _, ...row } = m;
    return clone({ ...row, people: sortPeople(this.pp.filter((p) => p.meet_id === m.id)) });
  }

  private outCircle(c: CrRow): Circle {
    const { deleted_at: _, ...row } = c;
    return clone(row);
  }

  // ------------------------------------------------------------ 읽기

  async circles(): Promise<Circle[]> {
    await this.wait();
    return [...this.cr.values()]
      .filter((c) => c.deleted_at === null)
      .sort((a, b) => a.name.localeCompare(b.name, "ko"))
      .map((c) => this.outCircle(c));
  }

  async meets(): Promise<Meet[]> {
    await this.wait();
    return [...this.mt.values()].filter((m) => m.deleted_at === null).map((m) => this.out(m));
  }

  // ------------------------------------------------------------ 모임

  private row(id: string): MtRow {
    const m = this.mt.get(id);
    if (!m || m.deleted_at !== null) throw ez("EZ_NOT_FOUND", "모임이 없습니다");
    return m;
  }

  private version(m: MtRow, base: number): void {
    if (m.version !== base) throw ez("EZ_VERSION", `그 사이 다른 곳에서 이 모임을 고쳤습니다. 새로 불러오세요 (지금 버전 ${m.version})`);
  }

  private touch(m: MtRow): void {
    m.version += 1;
    m.updated_at = new Date().toISOString();
  }

  /** 칸 검사 + 지운 묶음은 새로 못 건다 (ez_meets 의 CHECK 와 ez_meets_guard) */
  private checkMeet(next: MtRow, old: MtRow | null): void {
    const issue = validateMeet(next)[0];
    if (issue) {
      if (issue.path === "meet_date" || issue.path === "start_min" || issue.path === "end_min") throw ez("EZ_VALUE", issue.reason);
      throw check(`ez_meets_${issue.path.startsWith("poll") ? "poll" : issue.path}_check`);
    }
    if (next.title !== next.title.trim() || (next.place_text !== null && next.place_text !== next.place_text.trim())) throw check("ez_meets_title_check");
    if (next.circle_id !== null && next.circle_id !== old?.circle_id) {
      const c = this.cr.get(next.circle_id);
      if (!c) throw new DbError('insert or update on table "ez_meets" violates foreign key constraint "ez_meets_circle_fk"', "23503");
      if (c.deleted_at !== null) throw ez("EZ_CIRCLE", "지운 묶음입니다");
    }
  }

  private eventInput(m: MtRow): EventInput {
    return {
      title: m.title,
      date: m.meet_date!,
      start_min: m.start_min,
      end_min: m.end_min,
      place_id: m.place_id,
      where_text: m.place_text,
      travel_min: null,
      note: null,
      repeat: null,
      task_id: null,
    };
  }

  /**
   * 모임의 시간 ↔ 일정 (0011 ez_meets_guard · ez_meets_after). old = 고치기 전(넣을 때는 null).
   * force = 일정만 비어 있어도 다시 만든다 (ez_meet_decide 의 '일정에 넣기')
   */
  private async syncEvent(m: MtRow, old: MtRow | null, force = false): Promise<void> {
    if (m.meet_date === null) {
      const gone = old?.event_id ?? null;
      m.event_id = null;
      const ev = gone ? this.schedule.liveEvent(gone) : null;
      if (ev) await this.schedule.deleteEvent(ev.id, ev.version);
      return;
    }
    if (m.event_id === null) {
      if (old === null || old.meet_date === null || force) m.event_id = (await this.schedule.createEvent(this.eventInput(m), { kind: "meet", id: m.id })).id;
      return;
    }
    if (!old || old.event_id !== m.event_id) return;
    const ev = this.schedule.liveEvent(m.event_id);
    if (!ev) return;
    // 바뀐 칸만 — 일정 화면에서 따로 고친 칸은 건드리지 않는다
    const patch: Partial<EventInput> = {};
    if (m.meet_date !== old.meet_date || m.start_min !== old.start_min || m.end_min !== old.end_min) {
      patch.date = m.meet_date;
      patch.start_min = m.start_min;
      patch.end_min = m.end_min;
    }
    if (m.title !== old.title) patch.title = m.title;
    if (m.place_id !== old.place_id || m.place_text !== old.place_text) {
      patch.place_id = m.place_id;
      patch.where_text = m.place_text;
    }
    if (Object.keys(patch).length > 0) await this.schedule.updateEvent(ev.id, ev.version, patch);
  }

  async createMeet(input: MeetInput, people: readonly string[] = []): Promise<Meet> {
    await this.wait();
    const at = new Date().toISOString();
    const m: MtRow = {
      id: uuid(),
      title: input.title,
      note: input.note ?? null,
      circle_id: input.circle_id ?? null,
      place_id: input.place_id ?? null,
      place_text: input.place_text ?? null,
      meet_date: input.meet_date ?? null,
      start_min: input.start_min ?? null,
      end_min: input.end_min ?? null,
      event_id: null,
      poll: clone(input.poll ?? null),
      token: null,
      version: 1,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    };
    this.checkMeet(m, null);
    // 맞추기를 켠 모임이면 내 줄이 자동 채움 상태다 (0012 ez_meets_poll_after)
    const rows = [this.newPerson(m.id, this.schedule.myName() ?? DEFAULT_MY_NAME, true, { auto: m.poll !== null })];
    for (const name of people) {
      this.checkPerson(name, rows);
      rows.push(this.newPerson(m.id, name, false));
    }
    await this.syncEvent(m, null);
    this.mt.set(m.id, m);
    this.pp.push(...rows);
    return this.out(m);
  }

  async updateMeet(id: string, baseVersion: number, patch: Partial<MeetInput>): Promise<Meet> {
    await this.wait();
    const m = this.row(id);
    this.version(m, baseVersion);
    const next: MtRow = { ...m };
    for (const k of MEET_KEYS) if (k in patch && patch[k] !== undefined) (next as Record<string, unknown>)[k] = clone(patch[k]);
    this.checkMeet(next, m);
    const changed = MEET_KEYS.some((k) => (k === "poll" ? !samePoll(next.poll, m.poll) : !same(next[k], m[k])));
    const old = { ...m };
    Object.assign(m, next);
    await this.syncEvent(m, old);
    if (m.poll !== null && old.poll === null) {
      const me = this.pp.find((p) => p.meet_id === m.id && p.is_owner);
      if (me && me.cells === null) me.auto = true;
    }
    if (changed || m.event_id !== old.event_id) this.touch(m);
    return this.out(m);
  }

  async deleteMeet(id: string, baseVersion: number): Promise<void> {
    await this.wait();
    const m = this.row(id);
    this.version(m, baseVersion);
    m.deleted_at = new Date().toISOString();
    this.touch(m);
  }

  async restoreMeet(id: string): Promise<Meet> {
    await this.wait();
    const m = this.mt.get(id);
    if (!m) throw ez("EZ_NOT_FOUND", "되돌릴 모임이 없습니다");
    if (m.deleted_at !== null) {
      m.deleted_at = null;
      this.touch(m);
    }
    return this.out(m);
  }

  async decide(id: string, baseVersion: number, date: DateStr, start: number, end: number): Promise<Meet> {
    await this.wait();
    const m = this.row(id);
    this.version(m, baseVersion);
    const next: MtRow = { ...m, meet_date: date, start_min: start, end_min: end };
    this.checkMeet(next, m);
    const old = { ...m };
    Object.assign(m, next);
    await this.syncEvent(m, old, true);
    if (m.meet_date !== old.meet_date || m.start_min !== old.start_min || m.end_min !== old.end_min || m.event_id !== old.event_id) this.touch(m);
    return this.out(m);
  }

  async reopen(id: string, baseVersion: number): Promise<Meet> {
    await this.wait();
    const m = this.row(id);
    this.version(m, baseVersion);
    if (m.meet_date === null) return this.out(m);
    const old = { ...m };
    m.meet_date = null;
    m.start_min = null;
    m.end_min = null;
    await this.syncEvent(m, old);
    this.touch(m);
    return this.out(m);
  }

  // ------------------------------------------------------------ 사람

  /** 이름 1~20자(앞뒤 공백 없음) · 그 모임 안에서 겹침 없음 · 50명 */
  private checkPerson(name: string, rows: readonly MeetPerson[], selfId?: string): void {
    if (personNameProblem(name) !== null || name !== name.trim()) throw check("ez_meet_people_name_check");
    if (rows.some((p) => p.id !== selfId && nameKey(p.name) === nameKey(name))) throw unique("ez_meet_people_name_unique");
    if (selfId === undefined && rows.length >= PEOPLE_MAX) throw ez("EZ_LIMIT", `한 모임에 ${PEOPLE_MAX}명까지입니다. 더는 받을 수 없습니다`);
  }

  async addPerson(meetId: string, input: PersonInput): Promise<MeetPerson> {
    await this.wait();
    const m = this.mt.get(meetId);
    if (!m) throw new DbError('new row violates row-level security policy for table "ez_meet_people"', "42501");
    this.checkPerson(input.name, this.pp.filter((p) => p.meet_id === meetId));
    const p = this.newPerson(meetId, input.name, false, { attend: input.attend ?? null, cells: clone(input.cells ?? null), ...(input.id ? { id: input.id } : {}) });
    this.pp.push(p);
    return clone(p);
  }

  async updatePerson(id: string, patch: PersonPatch): Promise<MeetPerson> {
    await this.wait();
    const p = this.pp.find((x) => x.id === id);
    if (!p) throw ez("EZ_NOT_FOUND", "그 사람이 없습니다");
    if (patch.name !== undefined) {
      this.checkPerson(patch.name, this.pp.filter((x) => x.meet_id === p.meet_id), id);
      p.name = patch.name;
    }
    if (patch.attend !== undefined) {
      if (patch.attend !== null && patch.attend !== "yes" && patch.attend !== "no") throw check("ez_meet_people_attend_check");
      p.attend = patch.attend;
    }
    if (patch.auto !== undefined) {
      if (patch.auto && !p.is_owner) throw check("ez_meet_people_auto_check");
      p.auto = patch.auto;
    }
    if (patch.cells !== undefined) {
      if (patch.cells !== null && !cellsOk(patch.cells)) throw check("ez_meet_people_cells_shape_check");
      p.cells = clone(patch.cells);
    }
    return clone(p);
  }

  async removePerson(id: string): Promise<void> {
    await this.wait();
    const p = this.pp.find((x) => x.id === id);
    if (!p) return;
    if (p.is_owner) throw ez("EZ_FIXED", "내 줄은 뺄 수 없습니다");
    this.pp = this.pp.filter((x) => x.id !== id);
    this.pins.delete(id);
  }

  async clearPin(personId: string): Promise<void> {
    await this.wait();
    const p = this.pp.find((x) => x.id === personId);
    const m = p ? this.mt.get(p.meet_id) : undefined;
    if (!p || !m || m.deleted_at !== null) throw ez("EZ_NOT_FOUND", "그 사람이 없습니다");
    this.pins.delete(p.id);
    p.has_pin = false;
  }

  // ------------------------------------------------------------ 공개 링크 (0012)

  async link(id: string, on: boolean): Promise<string | null> {
    await this.wait();
    const m = this.row(id);
    if (!on) {
      if (m.token !== null) {
        m.token = null;
        this.touch(m);
      }
      return null;
    }
    if (m.token === null) {
      m.token = newToken();
      this.touch(m);
    }
    return m.token;
  }

  private byToken(token: string): MtRow | null {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    return [...this.mt.values()].find((m) => m.token === token && m.deleted_at === null) ?? null;
  }

  private gate(token: string): MtRow {
    const m = this.byToken(token);
    if (!m) throw ez("EZ_NOT_FOUND", "없는 링크입니다");
    return m;
  }

  /** 공개 페이지가 읽는 모양 — id · 메모 · 묶음 · 일정 · 열쇠 · 핀은 없다 (0012 ez_meet_snapshot) */
  private async snapshot(m: MtRow): Promise<PublicMeet> {
    const place = m.place_id ? ((await this.schedule.places()).find((p) => p.id === m.place_id)?.name ?? null) : null;
    return clone({
      title: m.title,
      place,
      where: m.place_text,
      meet_date: m.meet_date,
      start_min: m.start_min,
      end_min: m.end_min,
      poll: m.poll,
      people: sortPeople(this.pp.filter((p) => p.meet_id === m.id)).map((p) => ({ name: p.name, is_owner: p.is_owner, cells: p.cells, attend: p.attend, has_pin: p.has_pin })),
    });
  }

  /**
   * 이름 + 핀 확인 (0012 ez_meet_pin_check). set = 들어오기(없는 이름이면 새 줄, 핀이 없으면 정한다).
   * 틀리면 횟수를 올리고 5번째에 10분 잠근다 — 잠긴 동안에는 맞는 핀도 안 받는다
   */
  private pass(m: MtRow, nameIn: string, pin: string, set: boolean): MeetPerson {
    const name = typeof nameIn === "string" ? nameIn.trim() : "";
    if (personNameProblem(name) !== null) throw ez("EZ_VALUE", "이름은 1~20자입니다");
    if (typeof pin !== "string" || !PIN_RE.test(pin)) throw ez("EZ_VALUE", "핀번호는 숫자 4~6자리입니다");
    const rows = this.pp.filter((p) => p.meet_id === m.id);
    let p = rows.find((x) => nameKey(x.name) === nameKey(name));
    if (!p) {
      if (!set) throw ez("EZ_PIN", "그 이름으로 들어온 적이 없습니다. 다시 들어와 주세요");
      if (rows.length >= PEOPLE_MAX) throw ez("EZ_LIMIT", `한 모임에 ${PEOPLE_MAX}명까지입니다. 더는 받을 수 없습니다`);
      p = this.newPerson(m.id, name, false, { has_pin: true });
      this.pp.push(p);
      this.pins.set(p.id, { pin, fails: 0, lockedUntil: null });
      return p;
    }
    if (p.is_owner) throw ez("EZ_OWNER", "주최자의 이름입니다. 다른 이름을 적어 주세요");
    const k = this.pins.get(p.id);
    if (!k) {
      if (!set) throw ez("EZ_PIN", "핀번호가 지워졌습니다. 다시 들어와 새로 정해 주세요");
      this.pins.set(p.id, { pin, fails: 0, lockedUntil: null });
      p.has_pin = true;
      return p;
    }
    const now = this.clock();
    const locked = () => ez("EZ_LOCKED", `핀번호를 ${PIN_TRIES}번 틀렸습니다. ${PIN_LOCK_MIN}분 뒤에 다시 해 주세요`);
    if (k.lockedUntil !== null && k.lockedUntil > now) throw locked();
    if (k.pin === pin) {
      k.fails = 0;
      k.lockedUntil = null;
      return p;
    }
    const fails = (k.lockedUntil !== null ? 0 : k.fails) + 1;
    if (fails >= PIN_TRIES) {
      k.fails = 0;
      k.lockedUntil = now + PIN_LOCK_MIN * 60_000;
      throw locked();
    }
    k.fails = fails;
    k.lockedUntil = null;
    throw ez("EZ_PIN", "핀번호가 다릅니다. 잊었으면 주최자에게 지워 달라고 하세요");
  }

  async open(token: string): Promise<PublicMeet | null> {
    await this.wait();
    const m = this.byToken(token);
    return m ? this.snapshot(m) : null;
  }

  async enter(token: string, name: string, pin: string): Promise<Entered> {
    await this.wait();
    const m = this.gate(token);
    const p = this.pass(m, name, pin, true);
    return { me: p.name, meet: await this.snapshot(m) };
  }

  async answer(token: string, name: string, pin: string, cells: Cells): Promise<Entered> {
    await this.wait();
    const m = this.gate(token);
    if (typeof cells !== "object" || cells === null || Array.isArray(cells)) throw ez("EZ_VALUE", '칸은 {"날짜": [시작 분, …]} 으로 보냅니다');
    const p = this.pass(m, name, pin, false);
    if (m.meet_date !== null) throw ez("EZ_CLOSED", "이미 시간이 정해졌습니다");
    if (m.poll === null) throw ez("EZ_CLOSED", "시간을 맞추는 모임이 아닙니다");
    const poll: Poll = m.poll;
    const sent: Cells = Object.fromEntries(Object.entries(cells).map(([d, l]) => [d, Array.isArray(l) ? [...new Set(l)] : l]));
    const issue = validateCells(sent, poll)[0];
    if (issue) throw ez("EZ_VALUE", issue.reason);
    // 지금 설정 밖으로 나가 있는 옛 칸은 남긴다 (다시 넓히면 살아나게)
    const inside = clipCells(p.cells, poll);
    const merged: Cells = {};
    for (const [d, list] of Object.entries(p.cells ?? {})) merged[d] = list.filter((x) => !(inside[d] ?? []).includes(x));
    for (const [d, list] of Object.entries(sent)) merged[d] = [...(merged[d] ?? []), ...list];
    const next = cleanCells(merged);
    p.cells = cellsOk(next) ? next : cleanCells(sent);
    return { me: p.name, meet: await this.snapshot(m) };
  }

  async rsvp(token: string, name: string, pin: string, attend: Attend | null): Promise<Entered> {
    await this.wait();
    const m = this.gate(token);
    if (attend !== null && !(ATTENDS as readonly unknown[]).includes(attend)) throw ez("EZ_VALUE", "참석은 yes · no 로 보냅니다");
    const p = this.pass(m, name, pin, false);
    if (m.meet_date === null) throw ez("EZ_OPEN", "아직 시간이 정해지지 않았습니다");
    p.attend = attend;
    return { me: p.name, meet: await this.snapshot(m) };
  }

  // ------------------------------------------------------------ 묶음

  private liveCircles(): CrRow[] {
    return [...this.cr.values()].filter((c) => c.deleted_at === null);
  }

  /** 이름 1~30자 · 사람들 · 살아 있는 것끼리 이름 겹침 */
  private checkCircle(c: CrRow): void {
    const issue = validateCircle(c)[0];
    if (issue || c.name !== c.name.trim() || c.members.some((m) => m !== m.trim())) throw check(`ez_circles_${issue?.path.startsWith("members") ? "members" : "name"}_check`);
    if (this.liveCircles().some((o) => o.id !== c.id && o.name.toLowerCase() === c.name.toLowerCase())) throw unique("ez_circles_name_unique");
  }

  private circleLimit(): void {
    if (this.liveCircles().length >= CIRCLES_MAX) throw ez("EZ_LIMIT", `묶음은 ${CIRCLES_MAX}개까지 둘 수 있습니다. 안 쓰는 묶음을 지우고 다시 하세요`);
  }

  async createCircle(input: CircleInput): Promise<Circle> {
    await this.wait();
    this.circleLimit();
    const c: CrRow = { id: uuid(), name: input.name, role_id: input.role_id ?? null, members: clone(input.members ?? []), version: 1, deleted_at: null };
    this.checkCircle(c);
    this.cr.set(c.id, c);
    return this.outCircle(c);
  }

  async updateCircle(id: string, patch: Partial<CircleInput>): Promise<Circle> {
    await this.wait();
    const c = this.cr.get(id);
    if (!c || c.deleted_at !== null) throw ez("EZ_NOT_FOUND", "묶음이 없습니다");
    const next: CrRow = { ...c };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.role_id !== undefined) next.role_id = patch.role_id;
    if (patch.members !== undefined) next.members = clone(patch.members);
    this.checkCircle(next);
    Object.assign(c, next);
    c.version += 1;
    return this.outCircle(c);
  }

  async deleteCircle(id: string): Promise<void> {
    await this.wait();
    const c = this.cr.get(id);
    if (!c || c.deleted_at !== null) return;
    c.deleted_at = new Date().toISOString();
    c.version += 1;
  }

  async restoreCircle(id: string): Promise<Circle> {
    await this.wait();
    const c = this.cr.get(id);
    if (!c) throw ez("EZ_NOT_FOUND", "되돌릴 묶음이 없습니다");
    if (c.deleted_at !== null) {
      this.circleLimit();
      this.checkCircle({ ...c, deleted_at: null });
      c.deleted_at = null;
      c.version += 1;
    }
    return this.outCircle(c);
  }
}
