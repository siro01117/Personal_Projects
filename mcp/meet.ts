// MCP 모임 도구 2개 로직 (docs/모임.md 6장). MeetStore 와 ScheduleStore(지점 · 역할 · 할 일 · 일정)를 받아 돈다.
// 상태 · 입력 검사는 lib/meet 것을 그대로 쓴다. 규칙의 마지막 문은 DB 다.
// 에이전트 쪽 표기는 일정 도구와 같다: 날짜 'YYYY-MM-DD', 시각 "HH:MM", 지점 · 묶음 · 역할은 이름. 결과는 drawer.ts 와 같은 ToolResult.
// 시간 맞추기: 맞추기 설정(poll) · 공개 링크 켜기/끄기(link) · 추천 시간(lib/meet 의 suggestTimes) · 내 되는 시간 자동 채우기(일정에서).
// 남의 칸 · 핀을 다루는 길은 없다 — 남은 공개 링크로 직접 들어와 칠한다.

import {
  ATTENDS,
  circleOf,
  DEFAULT_POLL,
  firstDuplicate,
  meetStatus,
  myFreeCells,
  nameKey,
  pollRange,
  roleIdOf,
  sameCells,
  samePoll,
  splitMeets,
  suggestTimes,
  validateCircle,
  validateMeet,
  validatePeople,
  validatePoll,
  type Attend,
  type Cells,
  type Circle,
  type Meet,
  type MeetStatus,
  type Poll,
} from "../lib/meet";
import { webBase } from "../lib/links";
import { sameName } from "../lib/names";
import { addDays, isDateStr, type Issue, type Place, type Role } from "../lib/schedule";
import type { ToolResult } from "./drawer";
import { toKorean } from "./errors";
import type { CirclePatch, MeetPatch, MeetStore } from "./meet-store";
import { closestName, dayLabel, findPlace, findRole, hm, parseHM, seoul, span } from "./schedule";
import type { ScheduleStore } from "./schedule-store";

/** end 를 안 줬을 때 모임 길이 (분) */
export const MEET_DEFAULT_MIN = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

const ok = (summary: string, data: Obj = {}): ToolResult => ({ ok: true, summary, data });
const fail = (summary: string, code: string, extra: Obj = {}): ToolResult => ({
  ok: false,
  summary,
  data: { error: { code, message: summary }, ...extra },
});

/** lib 검사의 칸 이름 → 도구 입력 이름 */
const IN_NAME: Record<string, string> = { meet_date: "date", start_min: "start", end_min: "end", place_text: "where", place_id: "place", circle_id: "circle" };

function badInput(issues: Issue[]): ToolResult {
  const errors = issues.map((i) => ({ path: IN_NAME[i.path] ?? i.path, reason: i.reason }));
  return fail(`입력을 고쳐 주세요 — ${errors.map((e) => (e.path ? `${e.path}: ${e.reason}` : e.reason)).join(" / ")}`, "BAD_INPUT", { errors });
}

/** DB · 네트워크 오류 → 이유 */
function dbFail(e: unknown): ToolResult {
  const err = (isObj(e) ? e : {}) as { code?: string; message?: string; details?: string };
  const all = `${err.message ?? ""} ${err.details ?? ""}`;
  if (err.code === "23505") {
    if (all.includes("ez_circles_name_unique")) return fail("같은 이름의 묶음이 이미 있습니다", "NAME_TAKEN");
    if (all.includes("ez_meet_people_name_unique")) return fail("그 모임에 같은 이름의 사람이 이미 있습니다 (대소문자 · 공백 무시)", "NAME_TAKEN");
  }
  if (err.code === "23503") {
    if (all.includes("circle_fk")) return fail("없는 묶음입니다", "NOT_FOUND");
    if (all.includes("place_fk")) return fail("없는 지점입니다", "NOT_FOUND");
    if (all.includes("role_fk")) return fail("없는 역할입니다", "NOT_FOUND");
  }
  const k = toKorean(e);
  return fail(k.message, k.code);
}

const STATUS: Record<MeetStatus, string> = { polling: "맞추는 중", open: "미정", upcoming: "다가옴", past: "지남" };
const ATTEND: Record<Attend, string> = { yes: "온다", no: "못 온다" };

type Names = Map<string, string>;

/** webUrl = 결과에 싣는 공개 링크의 앞부분 (.env.local EZ_WEB_URL) */
export type MeetOptions = { store: MeetStore; schedule: ScheduleStore; now?: () => Date; webUrl?: string };

type PollArgs = { dates?: unknown; from?: string; to?: string; minutes?: number };

type GroupArgs = { name?: string; rename?: string; members?: unknown; role?: string | null; delete?: boolean };

type SaveArgs = {
  id?: string;
  base_version?: number;
  title?: string;
  note?: string | null;
  circle?: string | null;
  place?: string | null;
  where?: string | null;
  date?: string;
  start?: string;
  end?: string;
  reopen?: boolean;
  poll?: PollArgs | null;
  link?: boolean;
  people?: unknown;
  remove_people?: unknown;
  attend?: unknown;
  delete?: boolean;
  group?: GroupArgs;
};

const blank = (v: string | null | undefined) => (v == null || v.trim() === "" ? null : v);

export function createMeet({ store, schedule, now = () => new Date(), webUrl }: MeetOptions) {
  const base = webBase(webUrl);

  async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await fn();
    } catch (e) {
      return dbFail(e);
    }
  }

  /** 묶음 이름 → 묶음 (대소문자 · 앞뒤 공백 무시). 없으면 가장 가까운 이름을 알려 준다 */
  function findCircle(name: unknown, circles: Circle[]): Circle | ToolResult {
    const s = String(name ?? "").trim();
    const hit = circles.find((c) => sameName(c.name, s));
    if (hit) return hit;
    const names = circles.map((c) => c.name);
    if (names.length === 0) return fail(`없는 묶음입니다: "${s}" — 묶음이 하나도 없습니다. meet_save 의 group 으로 먼저 만드세요`, "CIRCLE_NOT_FOUND", { circles: [] });
    const near = closestName(s, names);
    return fail(`없는 묶음입니다: "${s}" — 가장 가까운 이름은 "${near}" (묶음: ${names.join(", ")})`, "CIRCLE_NOT_FOUND", { suggest: near, circles: names });
  }

  /** 이름들 → 앞뒤 공백을 뗀 목록. 배열이 아니면 issues */
  function namesIn(v: unknown, path: string, issues: Issue[]): string[] | undefined {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      issues.push({ path, reason: '이름은 글자 배열로 씁니다 (예: ["민서", "도윤"])' });
      return undefined;
    }
    return (v as string[]).map((x) => x.trim());
  }

  type Ctx = { circles: Circle[]; roles: Role[]; places: Place[]; placeNames: Names; roleNames: Names; today: string; nowMin: number };

  async function context(): Promise<Ctx> {
    const [circles, roles, places] = await Promise.all([store.circles(), schedule.roles(), schedule.places()]);
    return {
      circles,
      roles,
      places,
      placeNames: new Map(places.map((p) => [p.id, p.name])),
      roleNames: new Map(roles.map((r) => [r.id, r.name])),
      ...seoul(now()),
    };
  }

  function circleOut(c: Circle, x: Ctx): Obj {
    const o: Obj = { id: c.id, name: c.name, members: c.members };
    const role = c.role_id ? x.roleNames.get(c.role_id) : undefined;
    if (role) o.role = role;
    o.version = c.version;
    return o;
  }

  /** 목록의 한 줄 */
  function meetLine(m: Meet, x: Ctx): Obj {
    const o: Obj = { id: m.id, title: m.title, status: STATUS[meetStatus(m, { date: x.today, min: x.nowMin })] };
    if (m.meet_date !== null && m.start_min !== null && m.end_min !== null) {
      o.date = m.meet_date;
      o.time = span(m.start_min, m.end_min);
    } else if (m.poll) o.candidates = m.poll.dates;
    const circle = circleOf(m, x.circles);
    if (circle) o.circle = circle.name;
    const place = m.place_id ? x.placeNames.get(m.place_id) : undefined;
    if (place) o.place = place;
    if (m.place_text) o.where = m.place_text;
    o.people = m.people.length;
    o.version = m.version;
    return o;
  }

  /** poll 입력 → 설정. 고칠 땐 준 칸만 바꾼다. 문제가 있으면 issues 에 */
  function pollIn(p: PollArgs, cur: Poll | null, issues: Issue[]): Poll | undefined {
    if (!isObj(p)) {
      issues.push({ path: "poll", reason: 'poll 은 {dates: ["YYYY-MM-DD", …], from: "HH:MM", to: "HH:MM", minutes: 60} 로 씁니다 (null 이면 맞추기를 끈다)' });
      return undefined;
    }
    const time = (v: string | undefined, path: string, parse: (s: unknown) => number | null, fallback: number): number => {
      if (v === undefined) return fallback;
      const n = typeof v === "string" ? parse(v) : null;
      if (n === null) issues.push({ path, reason: `시각은 HH:MM 로 씁니다 (30분 단위). 받은 값: ${JSON.stringify(v)}` });
      return n ?? fallback;
    };
    const dates = p.dates !== undefined ? p.dates : cur?.dates;
    if (!Array.isArray(dates) || dates.some((d) => typeof d !== "string")) {
      issues.push({ path: "poll.dates", reason: '후보 날짜(dates)를 주세요 (예: ["2026-10-12", "2026-10-13"])' });
      return undefined;
    }
    const poll: Poll = {
      dates: [...new Set(dates as string[])].sort(),
      day_from: time(p.from, "poll.from", parseHM, cur?.day_from ?? DEFAULT_POLL.day_from),
      day_to: time(p.to, "poll.to", parseHM, cur?.day_to ?? DEFAULT_POLL.day_to),
      duration_min: p.minutes ?? cur?.duration_min ?? DEFAULT_POLL.duration_min,
    };
    if (issues.length > 0) return undefined;
    const bad = validatePoll(poll).map((i) => ({ ...i, path: i.path.replace("day_from", "from").replace("duration_min", "minutes") }));
    issues.push(...bad);
    return bad.length > 0 ? undefined : poll;
  }

  /** 일정(준비 · 이동 포함)을 뺀, 통째로 비는 내 30분 칸 (lib/meet — 웹과 같은 계산) */
  async function freeCells(poll: Poll): Promise<Cells> {
    const r = pollRange(poll);
    const [places, travel, settings, events] = await Promise.all([schedule.places(), schedule.travel(), schedule.settings(), schedule.eventsBetween(addDays(r.from, -2), r.to)]);
    const exceptions = await schedule.exceptions(events.filter((e) => e.repeat).map((e) => e.id));
    return myFreeCells(poll, events, exceptions, places, travel, settings);
  }

  /** 맞추는 중이고 내 줄이 자동 채움이면 지금 일정으로 다시 채운다. save 면 달라졌을 때 저장도 한다 */
  async function refill(m: Meet, save: boolean): Promise<Meet> {
    const me = m.people.find((p) => p.is_owner);
    if (!m.poll || m.meet_date !== null || !me?.auto) return m;
    const cells = await freeCells(m.poll);
    if (sameCells(me.cells, cells)) return m;
    if (save) await store.setMyCells(m.id, cells);
    return { ...m, people: m.people.map((p) => (p.is_owner ? { ...p, cells } : p)) };
  }

  /** 모임 한 건: 사람(참석 · 칠했는지) + 맞추기 설정 · 추천 시간 + 공개 링크 + 딸린 할 일 */
  async function meetOut(m0: Meet, x: Ctx): Promise<Obj> {
    // 추천 시간은 지금 일정으로 본 내 칸으로 계산한다 (보기만 할 때는 저장하지 않는다)
    const m = await refill(m0, false);
    const o = meetLine(m, x);
    if (m.note) o.note = m.note;
    const role = roleIdOf(m, x.circles, x.roles);
    if (role) o.role = x.roleNames.get(role);
    if (m.meet_date !== null) o.in_schedule = m.event_id !== null;
    if (m.event_id) o.event_id = m.event_id;
    o.people = m.people.map((p) => {
      const q: Obj = { name: p.name };
      if (p.is_owner) q.me = true;
      if (p.attend) q.attend = ATTEND[p.attend];
      if (p.cells !== null) q.painted = true;
      return q;
    });
    if (m.poll) {
      o.poll = { dates: m.poll.dates, from: hm(m.poll.day_from), to: m.poll.day_to >= 1440 ? "24:00" : hm(m.poll.day_to), minutes: m.poll.duration_min };
      if (m.meet_date === null) {
        o.suggest = suggestTimes(m.people, m.poll, { date: x.today, min: x.nowMin }).map((s) => ({
          date: s.date,
          time: span(s.start, s.end),
          count: s.count,
          people: s.names,
          ...(s.mine ? { me: true } : {}),
        }));
      }
    }
    if (m.token) o.link = `${base}/m/${m.token}`;
    const tasks = (await schedule.tasks()).filter((t) => t.origin_kind === "meet" && t.origin_id === m.id);
    if (tasks.length > 0) {
      o.todos = tasks
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((t) => ({ id: t.id, title: t.title, ...(t.done_at ? { done: true } : {}), version: t.version }));
    }
    return o;
  }

  const whenLine = (m: Meet) => (m.meet_date !== null && m.start_min !== null && m.end_min !== null ? ` ${dayLabel(m.meet_date)} ${span(m.start_min, m.end_min)}` : "");

  const conflict = async (cur: Meet, x: Ctx) =>
    fail(`그 사이 다른 곳에서 이 모임을 고쳤습니다 (지금 version ${cur.version}) — current 를 보고 다시 하세요`, "EZ_VERSION", {
      conflict: true,
      current: await meetOut(cur, x),
    });

  /** 바꾼 뒤 version 이 안 맞으면: 지금 값으로 충돌, 없으면 없음 */
  async function lost(id: string, x: Ctx): Promise<ToolResult> {
    const cur = await store.getMeet(id);
    return cur ? conflict(cur, x) : fail(`모임이 없습니다: ${id}`, "NOT_FOUND");
  }

  /** date · start · end → 분. 셋 다 없으면 undefined. 문제가 있으면 issues 에 */
  function timeIn(a: SaveArgs, base: { start: number | null; end: number | null; date: string | null }, issues: Issue[]): { date: string; start: number; end: number } | undefined {
    if (a.date === undefined && a.start === undefined && a.end === undefined) return undefined;
    const date = a.date ?? base.date;
    if (date === null || !isDateStr(date)) {
      issues.push({ path: "date", reason: "날짜(date)는 YYYY-MM-DD 로 씁니다" });
      return undefined;
    }
    let start = base.start;
    if (a.start !== undefined) {
      start = parseHM(a.start);
      if (start === null) {
        issues.push({ path: "start", reason: `시각은 HH:MM 로 씁니다 (예: 19:00). 받은 값: ${JSON.stringify(a.start)}` });
        return undefined;
      }
    }
    if (start === null) {
      issues.push({ path: "start", reason: "시작(start, HH:MM)을 주세요" });
      return undefined;
    }
    let end: number | null;
    if (a.end !== undefined) {
      end = parseHM(a.end);
      if (end === null) {
        issues.push({ path: "end", reason: `시각은 HH:MM 로 씁니다 (예: 21:00). 받은 값: ${JSON.stringify(a.end)}` });
        return undefined;
      }
    } else end = start + (base.start !== null && base.end !== null ? base.end - base.start : MEET_DEFAULT_MIN);
    if (end <= start || end > 1440) {
      issues.push({ path: "end", reason: `끝(${hm(end)})은 시작(${hm(start)})보다 늦고 24:00 까지입니다 — 모임은 자정을 넘기지 않습니다` });
      return undefined;
    }
    return { date, start, end };
  }

  // ---------------------------------------------------------------- 묶음 만들기 · 고치기

  async function saveGroup(g: GroupArgs, x: Ctx): Promise<ToolResult> {
    if (!isObj(g) || typeof g.name !== "string" || g.name.trim() === "") return fail("group.name(묶음 이름)을 주세요", "BAD_INPUT");
    const issues: Issue[] = [];
    const members = namesIn(g.members, "group.members", issues);
    if (issues.length > 0) return badInput(issues);
    let roleId: string | null | undefined;
    if (g.role !== undefined) {
      const hit = findRole(g.role, x.roles);
      if ("error" in hit) return hit.error;
      roleId = hit.id;
    }
    const cur = x.circles.find((c) => sameName(c.name, g.name!));

    if (g.delete === true) {
      if (!cur) return findCircle(g.name, x.circles) as ToolResult;
      await store.deleteCircle(cur.id);
      return ok(`묶음을 지웠습니다: ${cur.name} (모임은 남습니다)`, { deleted: true, id: cur.id });
    }

    if (!cur) {
      if (g.rename !== undefined) return findCircle(g.name, x.circles) as ToolResult;
      const row = { name: g.name.trim(), members: members ?? [], role_id: roleId ?? null };
      const bad = validateCircle(row);
      if (bad.length > 0) return badInput(bad.map((i) => ({ ...i, path: `group.${i.path}` })));
      const made = await store.insertCircle(row);
      return ok(`묶음을 만들었습니다: ${made.name} (${made.members.length}명)`, { created: true, circle: circleOut(made, x) });
    }

    const patch: CirclePatch = {};
    if (g.rename !== undefined && g.rename.trim() !== cur.name) patch.name = String(g.rename).trim();
    if (members !== undefined && JSON.stringify(members) !== JSON.stringify(cur.members)) patch.members = members;
    if (roleId !== undefined && roleId !== cur.role_id) patch.role_id = roleId;
    if (Object.keys(patch).length === 0) return ok(`바뀐 것이 없습니다: ${cur.name}`, { changed: false, circle: circleOut(cur, x) });
    const bad = validateCircle({ ...cur, ...patch });
    if (bad.length > 0) return badInput(bad.map((i) => ({ ...i, path: `group.${i.path}` })));
    const row = await store.updateCircle(cur.id, patch, cur.version);
    if (!row) return fail("그 사이 다른 곳에서 이 묶음을 고쳤습니다 — meet_get 으로 다시 보고 하세요", "EZ_VERSION", { conflict: true });
    return ok(`묶음을 고쳤습니다: ${row.name}${patch.members ? " (이미 만든 모임의 사람은 안 바뀝니다)" : ""}`, { changed: true, circle: circleOut(row, x) });
  }

  return {
    // ---------------------------------------------------------------- meet_get
    meet_get: (a: { id?: string; circle?: string } = {}) =>
      guard(async () => {
        const x = await context();
        if (a.id !== undefined && a.id !== null && a.id !== "") {
          const id = String(a.id).trim();
          if (!UUID.test(id)) return fail("id 는 모임의 uuid 입니다 — id 없이 meet_get 을 불러 찾으세요", "BAD_INPUT");
          const m = await store.getMeet(id);
          if (!m) return fail(`모임이 없습니다: ${id}`, "NOT_FOUND");
          return ok(`${m.title}${whenLine(m)} · ${m.people.length}명`, { meet: await meetOut(m, x) });
        }
        let meets = await store.meets();
        let tail = "";
        if (a.circle !== undefined && a.circle !== null && a.circle !== "") {
          const c = findCircle(a.circle, x.circles);
          if ("ok" in c) return c;
          meets = meets.filter((m) => m.circle_id === c.id);
          tail = ` · 묶음 ${c.name}`;
        }
        const lists = splitMeets(meets, { date: x.today, min: x.nowMin });
        const key = (m: Meet) => `${m.meet_date ?? m.poll?.dates[0] ?? "9999"} ${String(m.start_min ?? 0).padStart(4, "0")}`;
        const asc = (p: Meet, q: Meet) => key(p).localeCompare(key(q));
        // 정할 것 · 다가오는 모임은 이른 날짜부터, 지난 모임은 최근 것부터
        const items = [...lists.todo.sort(asc), ...lists.upcoming.sort(asc), ...lists.past.sort((p, q) => asc(q, p))].map((m) => meetLine(m, x));
        return ok(`모임 ${meets.length}개 (정할 것 ${lists.todo.length} · 다가옴 ${lists.upcoming.length} · 지남 ${lists.past.length})${tail}`, {
          items,
          circles: x.circles.map((c) => circleOut(c, x)),
        });
      }),

    // ---------------------------------------------------------------- meet_save
    meet_save: (a: SaveArgs) =>
      guard(async () => {
        const x = await context();
        if (a.group !== undefined) {
          const others = Object.keys(a).filter((k) => k !== "group" && (a as Obj)[k] !== undefined);
          if (others.length > 0) return fail(`group(묶음)은 ${others.join(" · ")} 와 같이 못 씁니다 — 따로 부르세요`, "BAD_INPUT");
          return saveGroup(a.group, x);
        }
        const isNew = a.id === undefined || a.id === null || a.id === "";
        if (isNew && (a.delete || a.reopen)) return fail("지우거나 다시 열 모임의 id 를 주세요", "BAD_INPUT");

        // ---- 칸 읽기
        const issues: Issue[] = [];
        const add = namesIn(a.people, "people", issues);
        const remove = namesIn(a.remove_people, "remove_people", issues);
        let attend: [string, Attend | null][] | undefined;
        if (a.attend !== undefined) {
          if (!isObj(a.attend) || Object.values(a.attend).some((v) => v !== null && !(ATTENDS as readonly unknown[]).includes(v))) {
            issues.push({ path: "attend", reason: '참석은 {이름: "yes" | "no" | null} 로 씁니다' });
          } else attend = Object.entries(a.attend) as [string, Attend | null][];
        }
        if (issues.length > 0) return badInput(issues);

        let circle: Circle | null | undefined;
        if (a.circle !== undefined) {
          if (a.circle === null || a.circle.trim() === "") circle = null;
          else {
            const c = findCircle(a.circle, x.circles);
            if ("ok" in c) return c;
            circle = c;
          }
        }
        let placeId: string | null | undefined;
        if (a.place !== undefined) {
          const hit = findPlace(a.place, x.places);
          if ("error" in hit) return hit.error;
          placeId = hit.id;
        }

        // ---- 만들기
        if (isNew) {
          if (remove !== undefined || attend !== undefined) return fail("remove_people · attend 는 이미 있는 모임에 씁니다", "BAD_INPUT");
          if (a.poll === null) return fail("poll: null 은 이미 있는 모임의 맞추기를 끌 때 씁니다", "BAD_INPUT");
          const when = timeIn(a, { date: null, start: null, end: null }, issues);
          const poll = a.poll !== undefined ? pollIn(a.poll, null, issues) : undefined;
          if (issues.length > 0) return badInput(issues);
          if (when && poll) return fail("시간(date · start)과 맞추기(poll)는 같이 못 씁니다 — 시간을 알면 date · start, 맞춰야 하면 poll", "BAD_INPUT");
          const row = {
            title: typeof a.title === "string" ? a.title.trim() : (a.title as unknown as string),
            note: blank(a.note),
            circle_id: circle?.id ?? null,
            place_id: placeId ?? null,
            place_text: blank(a.where)?.trim() ?? null,
            meet_date: when?.date ?? null,
            start_min: when?.start ?? null,
            end_min: when?.end ?? null,
            poll: poll ?? null,
          };
          const bad = validateMeet(row);
          if (bad.length > 0) return badInput(bad);
          // 사람을 안 주면 묶음의 사람들로 채운다
          const names = add ?? circle?.members ?? [];
          const badPeople = validatePeople(names);
          if (badPeople.length > 0) return badInput(badPeople);
          const made = await store.insertMeet(row);
          try {
            // 내 줄과 겹치는 이름은 뺀다
            const me = (await store.getMeet(made.id))?.people[0]?.name ?? "";
            await store.addPeople(made.id, names.filter((n) => nameKey(n) !== nameKey(me)));
          } catch (e) {
            // 사람을 못 넣었으면 방금 만든 모임을 남기지 않는다 (딸린 일정도)
            if (made.meet_date !== null) await store.reopen(made.id, made.version).then((r) => store.deleteMeet(r.id, r.version), () => {});
            else await store.deleteMeet(made.id, made.version).catch(() => {});
            throw e;
          }
          if (a.link === true) await store.setLink(made.id, true, made.version);
          // 맞추는 모임이면 내 되는 시간을 일정에서 채워 둔다
          const m = await refill((await store.getMeet(made.id))!, true);
          const tail = when ? " (일정에 넣음)" : poll ? ` (후보 ${poll.dates.length}일 · 내 되는 시간을 채움)` : "";
          return ok(`모임을 만들었습니다: ${m.title}${whenLine(m)}${tail} · ${m.people.length}명`, { created: true, meet: await meetOut(m, x) });
        }

        // ---- 고치기
        const id = String(a.id).trim();
        if (!UUID.test(id)) return fail("id 는 모임의 uuid 입니다 — meet_get 으로 찾으세요", "BAD_INPUT");
        if (!Number.isInteger(a.base_version)) return fail("고칠 땐 base_version(meet_get 의 version)이 필요합니다", "BAD_INPUT");
        const cur = await store.getMeet(id);
        if (!cur) return fail(`모임이 없습니다: ${id}`, "NOT_FOUND");
        if (cur.version !== a.base_version) return conflict(cur, x);

        if (a.delete === true) {
          const others = (["title", "note", "circle", "place", "where", "date", "start", "end", "reopen", "poll", "link", "people", "remove_people", "attend"] as const).filter((k) => a[k] !== undefined);
          if (others.length > 0) return fail(`delete 는 ${others.join(" · ")} 와 같이 못 씁니다 — 따로 부르세요`, "BAD_INPUT");
          if (!(await store.deleteMeet(id, cur.version))) return lost(id, x);
          return ok(`모임을 지웠습니다: ${cur.title}${cur.event_id ? " (딸린 일정은 남습니다 — 필요하면 schedule_delete)" : ""}`, { id, deleted: true });
        }

        if (a.reopen === true && (a.date !== undefined || a.start !== undefined || a.end !== undefined)) {
          return fail("reopen(시간 비우기)은 date · start · end 와 같이 못 씁니다", "BAD_INPUT");
        }
        const when = timeIn(a, { date: cur.meet_date, start: cur.start_min, end: cur.end_min }, issues);
        const poll = a.poll === undefined ? undefined : a.poll === null ? null : pollIn(a.poll, cur.poll, issues);
        if (issues.length > 0) return badInput(issues);

        const patch: MeetPatch = {};
        if (poll !== undefined && !samePoll(poll, cur.poll)) patch.poll = poll;
        if (a.title !== undefined) patch.title = typeof a.title === "string" ? a.title.trim() : a.title;
        if (a.note !== undefined) patch.note = blank(a.note);
        if (circle !== undefined) patch.circle_id = circle?.id ?? null;
        if (placeId !== undefined) patch.place_id = placeId;
        if (a.where !== undefined) patch.place_text = blank(a.where)?.trim() ?? null;
        for (const k of Object.keys(patch) as (keyof MeetPatch)[]) {
          if (k === "poll") continue;
          // 지운 묶음을 가리키던 모임에 '묶음 없음' 을 주면 그대로 둔다
          const was = k === "circle_id" ? (circleOf(cur, x.circles)?.id ?? null) : cur[k];
          if (patch[k] === was) delete patch[k];
        }
        const bad = validateMeet({ ...cur, ...patch });
        if (bad.length > 0) return badInput(bad);

        // 사람: 뺄 이름 · 참석을 적을 이름은 그 모임에 있어야 한다
        const byKey = new Map(cur.people.map((p) => [nameKey(p.name), p]));
        const gone = (remove ?? []).map((n) => ({ n, p: byKey.get(nameKey(n)) }));
        const missing = [...gone.filter((g) => !g.p).map((g) => g.n), ...(attend ?? []).filter(([n]) => !byKey.has(nameKey(n)) && !(add ?? []).some((y) => nameKey(y) === nameKey(n))).map(([n]) => n)];
        if (missing.length > 0) {
          return fail(`그 모임에 없는 사람입니다: ${missing.join(", ")} (사람: ${cur.people.map((p) => p.name).join(", ")})`, "PERSON_NOT_FOUND", {
            people: cur.people.map((p) => p.name),
          });
        }
        if (gone.some((g) => g.p!.is_owner)) return fail("내 줄은 뺄 수 없습니다", "BAD_INPUT");
        const fresh = (add ?? []).filter((n) => !byKey.has(nameKey(n)));
        if (fresh.length > 0) {
          const badPeople = validatePeople(fresh);
          if (badPeople.length > 0) return badInput(badPeople);
          const dup = firstDuplicate(fresh);
          if (dup !== null) return badInput([{ path: "people", reason: `같은 이름이 두 번 있습니다: ${dup}` }]);
        }

        // ---- 쓰기: 모임 칸 → 시간(일정과 한 묶음) → 사람 · 참석
        let version = cur.version;
        const did: string[] = [];
        if (Object.keys(patch).length > 0) {
          const row = await store.updateMeet(id, patch, version);
          if (!row) return lost(id, x);
          version = row.version;
          did.push(patch.poll === undefined ? "고침" : patch.poll === null ? "맞추기를 끔" : cur.poll ? "맞추기 설정을 바꿈" : "맞추기를 켬");
        }
        if (a.link !== undefined && a.link !== (cur.token !== null)) {
          const row = await store.setLink(id, a.link, version);
          if (!row) return lost(id, x);
          version = row.version;
          did.push(a.link ? "공개 링크를 켬" : "공개 링크를 끔(옛 링크는 죽음)");
        }
        if (a.reopen === true) {
          if (cur.meet_date !== null) {
            version = (await store.reopen(id, version)).version;
            did.push("시간을 비움(딸린 일정도 지움)");
          }
        } else if (when && (when.date !== cur.meet_date || when.start !== cur.start_min || when.end !== cur.end_min || cur.event_id === null)) {
          version = (await store.decide(id, version, when.date, when.start, when.end)).version;
          did.push(cur.meet_date === null ? "시간을 정함(일정에 넣음)" : cur.event_id === null ? "일정에 다시 넣음" : "시간을 바꿈(일정도 옮김)");
        }
        if (gone.length > 0) {
          await store.removePeople(id, gone.map((g) => g.p!.id));
          did.push(`${gone.length}명 뺌`);
        }
        if (fresh.length > 0) {
          await store.addPeople(id, fresh);
          did.push(`${fresh.length}명 넣음`);
        }
        if (attend && attend.length > 0) {
          const after = await store.getMeet(id);
          const ids = new Map((after?.people ?? []).map((p) => [nameKey(p.name), p.id]));
          for (const [n, v] of attend) {
            const pid = ids.get(nameKey(n));
            if (pid) await store.setAttend(id, pid, v);
          }
          did.push(`참석 ${attend.length}명 적음`);
        }
        const read = await store.getMeet(id);
        if (!read) return fail(`모임이 없습니다: ${id}`, "NOT_FOUND");
        // 맞추기 설정을 바꿨거나(켰거나) 다시 열었으면 내 되는 시간을 다시 채운다
        const m = patch.poll || a.reopen === true ? await refill(read, true) : read;
        if (did.length === 0) return ok(`바뀐 것이 없습니다: ${m.title}`, { changed: false, meet: await meetOut(m, x) });
        return ok(`${m.title}${whenLine(m)}: ${did.join(" · ")}`, { changed: true, meet: await meetOut(m, x) });
      }),
  };
}

export type MeetTools = ReturnType<typeof createMeet>;
