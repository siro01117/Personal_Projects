// MCP 일정 4개 · 플래너 2개 도구 로직 (docs/일정.md 5장, docs/플래너.md 4장 · 7-8). ScheduleStore 를 받아 돈다.
// 계산(회차 펼치기·동선·빈 시간)과 입력 검사는 lib/schedule 것을 그대로 쓴다. 규칙의 마지막 문은 DB 다.
// 에이전트 쪽 표기: 날짜 'YYYY-MM-DD', 시각 "HH:MM"(다음 날이면 "+1"), 요일 "월".."일". 결과는 drawer.ts 와 같은 ToolResult.

import {
  CHECKLIST_MAX,
  CHECK_ITEM_MAX,
  DUE_AFTER_MAX,
  addDays,
  daysBetween,
  freeSlots,
  isDateStr,
  occursOn,
  planRange,
  roleForPlace,
  spillsOver,
  validateEvent,
  validateTask,
  weekday,
  type DateStr,
  type DayPlan,
  type EventRow,
  type ExceptionPatch,
  type Issue,
  type Occurrence,
  type Place,
  type Repeat,
  type Role,
  type Segment,
  type CheckItem,
  type TaskRow,
  type TaskRule,
} from "../lib/schedule";
import { charCount, sameName } from "../lib/names";
import type { ToolResult } from "./drawer";
import { toKorean } from "./errors";
import type { EventPatch, NewEvent, RulePatch, ScheduleStore, SplitPatch, SyncEvent, TaskPatch } from "./schedule-store";

export const MAX_DAYS = 62;
/** 빈 시간은 07:00~24:00 안에서만 */
export const FREE_FROM = 7 * 60;
export const FREE_TO = 24 * 60;
/** 할 일에 걸릴 시간이 없을 때 일정 길이 (docs/플래너.md) */
export const TASK_DEFAULT_MIN = 60;

export const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;
export const SCOPES = ["once", "following", "all"] as const;
export type Scope = (typeof SCOPES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

const ok = (summary: string, data: Obj = {}): ToolResult => ({ ok: true, summary, data });
const fail = (summary: string, code: string, extra: Obj = {}): ToolResult => ({
  ok: false,
  summary,
  data: { error: { code, message: summary }, ...extra },
});

// ---------------------------------------------------------------------------
// 표기

const pad = (n: number) => String(n).padStart(2, "0");

/** 분 → "HH:MM". 1440 은 "24:00", 넘으면 "+1", 0 미만이면 "-1" (전날) */
export function hm(m: number): string {
  if (m === 1440) return "24:00";
  let x = m;
  let suffix = "";
  if (x > 1440) {
    x -= 1440;
    suffix = "+1";
  } else if (x < 0) {
    x += 1440;
    suffix = "-1";
  }
  return `${pad(Math.floor(x / 60))}:${pad(x % 60)}${suffix}`;
}

export const span = (a: number, b: number) => `${hm(a)}–${hm(b)}`;

const HM = /^(\d{1,2}):(\d{2})$/;

/** "HH:MM" → 분 (0~1440). 아니면 null */
export function parseHM(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = HM.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}

/** '2026-10-05' → '10/5(월)' */
export function dayLabel(d: DateStr): string {
  const [, mo, da] = d.split("-");
  return `${Number(mo)}/${Number(da)}(${WEEKDAYS[weekday(d) - 1]})`;
}

type RepeatOut = { freq: "daily" | "weekly"; days?: string[]; until?: string };

function repeatOut(r: Repeat): RepeatOut | undefined {
  if (!r) return undefined;
  const out: RepeatOut = { freq: r.freq };
  if (r.freq === "weekly") out.days = r.days.map((d) => WEEKDAYS[d - 1] ?? String(d));
  if (r.until) out.until = r.until;
  return out;
}

/** 입력 반복 → DB 반복. 요일은 "월".."일" (1~7 정수도 받는다). undefined = 안 바꿈 */
function repeatIn(v: unknown, issues: Issue[], path = "repeat"): Repeat | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isObj(v) || (v.freq !== "daily" && v.freq !== "weekly")) {
    issues.push({ path, reason: "반복은 null · {freq:'daily', until?} · {freq:'weekly', days:['월','수'], until?} 중 하나입니다" });
    return undefined;
  }
  const until = v.until === undefined || v.until === null ? undefined : (v.until as string);
  if (v.freq === "daily") return until ? { freq: "daily", until } : { freq: "daily" };
  let days = v.days as number[];
  if (Array.isArray(v.days)) {
    const mapped = v.days.map((d) => {
      if (typeof d === "string") {
        const i = WEEKDAYS.indexOf(d.trim().replace(/요일$/, "") as (typeof WEEKDAYS)[number]);
        return i >= 0 ? i + 1 : null;
      }
      return typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7 ? d : null;
    });
    if (mapped.some((d) => d === null)) {
      issues.push({ path: `${path}.days`, reason: "요일은 월·화·수·목·금·토·일 로 씁니다" });
      return undefined;
    }
    days = (mapped as number[]).slice().sort((a, b) => a - b);
  }
  return until ? { freq: "weekly", days, until } : { freq: "weekly", days };
}

/** lib 검사의 칸 이름 → 도구 입력 이름 */
const IN_NAME: Record<string, string> = { start_min: "start", end_min: "end", where_text: "where", place_id: "place" };
const inPath = (p: string) => IN_NAME[p] ?? p;

function badInput(issues: Issue[], extra: Obj = {}): ToolResult {
  const errors = issues.map((i) => ({ path: inPath(i.path), reason: i.reason }));
  return fail(`입력을 고쳐 주세요 — ${errors.map((e) => (e.path ? `${e.path}: ${e.reason}` : e.reason)).join(" / ")}`, "BAD_INPUT", {
    errors,
    ...extra,
  });
}

/** DB 이유 글 → 어느 칸인지 (짐작) */
const GUESS: [RegExp, string][] = [
  [/제목|title/, "title"],
  [/체크/, "checklist"],
  [/마감|due/, "due"],
  [/끝나는 날|until/, "repeat.until"],
  [/요일|days/, "repeat.days"],
  [/반복|repeat|freq/, "repeat"],
  [/이동시간|travel_min/, "travel_min"],
  [/메모|note/, "note"],
  [/상세 장소|where_text/, "where"],
  [/지점|place/, "place"],
  [/시작과 끝|start_min 과 end_min/, "start"],
  [/^끝은|end_min/, "end"],
  [/시작|start_min/, "start"],
  [/날짜|date/, "date"],
];
const guessPath = (reason: string) => GUESS.find(([re]) => re.test(reason))?.[1] ?? "";

/** DB·네트워크 오류 → 위치·이유 */
function dbFail(e: unknown, extra: Obj = {}): ToolResult {
  const err = (isObj(e) ? e : {}) as { code?: string; message?: string; details?: string };
  const all = `${err.message ?? ""} ${err.details ?? ""}`;
  if (err.code === "23505" && all.includes("ez_events_task_unique")) {
    return fail("이 할 일은 이미 다른 일정과 이어져 있습니다 — 그 일정을 고치거나 지운 뒤 다시 하세요", "TASK_TAKEN", extra);
  }
  if (err.code === "23503") {
    if (/due_event_fk|rules_event_fk/.test(all)) return fail("없는 일정입니다", "NOT_FOUND", extra);
    if (all.includes("role_fk")) return fail("없는 역할입니다", "NOT_FOUND", extra);
    if (all.includes("place_fk")) return fail("없는 지점입니다", "NOT_FOUND", extra);
    if (all.includes("rule_fk")) return fail("없는 반복 규칙입니다", "NOT_FOUND", extra);
    if (all.includes("task")) return fail("없는 할 일입니다 (task_id)", "NOT_FOUND", extra);
    if (all.includes("place")) return fail("없는 지점입니다", "NOT_FOUND", extra);
  }
  const k = toKorean(e);
  if (k.code === "EZ_SYNC") {
    let list: { index: number; external_id: unknown; reason: string }[] = [];
    try {
      list = JSON.parse(err.details ?? "[]");
    } catch {
      /* detail 이 없으면 message 만 */
    }
    const errors = list.map((b) => ({ index: b.index, external_id: b.external_id, path: guessPath(b.reason), reason: b.reason }));
    return fail(k.message, k.code, { errors, ...extra });
  }
  if (k.code === "EZ_VALUE" || k.code === "EZ_PATCH" || k.code === "EZ_DATE" || k.code === "EZ_PLACE") {
    return fail(k.message, k.code, { errors: [{ path: guessPath(k.message), reason: k.message }], ...extra });
  }
  return fail(k.message, k.code, extra);
}

// ---------------------------------------------------------------------------
// 지점 이름

/** 두 글의 편집 거리 (코드 포인트) */
function distance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** 가장 가까운 이름 (한쪽이 다른 쪽을 품으면 먼저, 그다음 편집 거리) */
export function closestName(input: string, names: string[]): string | null {
  const k = input.trim().toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const n of names) {
    const m = n.toLowerCase();
    const score = m.includes(k) || k.includes(m) ? Math.abs(m.length - k.length) / 100 : distance(k, m);
    if (score < bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return best;
}

type PlaceHit = { id: string | null } | { error: ToolResult; reason: string };

/** 지점 이름 → id. null·"" 은 지점 없음. 살아 있는 지점에서만 찾는다 */
export function findPlace(name: unknown, places: Place[], emptyHint = "place 를 비우고 where 에 장소 글을 쓰세요"): PlaceHit {
  if (name === null || (typeof name === "string" && name.trim() === "")) return { id: null };
  const live = places.filter((p) => !p.deleted);
  const s = String(name);
  const hit = live.find((p) => sameName(p.name, s));
  if (hit) return { id: hit.id };
  const names = live.map((p) => p.name);
  if (names.length === 0) {
    const reason = `없는 지점입니다: "${s.trim()}" — 지점이 하나도 없습니다(지점은 웹 설정에서 만듭니다). ${emptyHint}`;
    return { reason, error: fail(reason, "PLACE_NOT_FOUND", { places: [] }) };
  }
  const near = closestName(s, names);
  const reason = `없는 지점입니다: "${s.trim()}" — 가장 가까운 이름은 "${near}" (지점: ${names.join(", ")})`;
  return { reason, error: fail(reason, "PLACE_NOT_FOUND", { suggest: near, places: names }) };
}

type RoleHit = { id: string | null } | { error: ToolResult };
const NO_ROLE = "없음";

/** 역할 이름 → id (대소문자 · 앞뒤 공백 무시). null · "" · "없음" 은 역할 없음 — 그 이름의 역할이 있으면 그 역할. 살아 있는 역할에서만 찾는다 */
export function findRole(name: unknown, roles: Role[]): RoleHit {
  const s = name === null ? "" : String(name).trim();
  const hit = roles.find((r) => sameName(r.name, s));
  if (hit) return { id: hit.id };
  if (s === "" || s === NO_ROLE) return { id: null };
  const names = roles.map((r) => r.name);
  if (names.length === 0) {
    return { error: fail(`없는 역할입니다: "${s}" — 역할이 하나도 없습니다(역할은 웹 플래너에서 만듭니다). role 을 비우세요`, "ROLE_NOT_FOUND", { roles: [] }) };
  }
  const near = closestName(s, names);
  return {
    error: fail(`없는 역할입니다: "${s}" — 가장 가까운 이름은 "${near}" (역할: ${names.join(", ")})`, "ROLE_NOT_FOUND", { suggest: near, roles: names }),
  };
}

// ---------------------------------------------------------------------------
// 시각

type TimeArgs = { start?: unknown; end?: unknown; all_day?: unknown };
type Times = { start_min: number | null; end_min: number | null };

/**
 * start·end·all_day → 분. undefined 면 시각은 그대로(또는 문제가 issues 에).
 * end 가 start 보다 이르거나 같으면 다음 날. end 를 안 주면 defaultLen, 그것도 없으면 base 의 길이를 유지.
 */
function resolveTimes(a: TimeArgs, base: Times, defaultLen: number | undefined, issues: Issue[]): Times | undefined {
  const sGiven = a.start !== undefined && a.start !== null;
  const eGiven = a.end !== undefined && a.end !== null;
  if (a.all_day === true) {
    if (sGiven || eGiven) {
      issues.push({ path: "all_day", reason: "종일이면 start·end 를 비우세요" });
      return undefined;
    }
    return { start_min: null, end_min: null };
  }
  if (!sGiven && !eGiven) {
    if (a.all_day === false && base.start_min === null) issues.push({ path: "start", reason: "종일을 끄려면 start(HH:MM)를 주세요" });
    return undefined;
  }
  let s = base.start_min;
  if (sGiven) {
    s = parseHM(a.start);
    if (s === null) {
      issues.push({ path: "start", reason: `시각은 HH:MM 로 씁니다 (예: 09:30). 받은 값: ${JSON.stringify(a.start)}` });
      return undefined;
    }
  }
  if (s === null) {
    issues.push({ path: "start", reason: "start(HH:MM)를 주세요" });
    return undefined;
  }
  if (eGiven) {
    const e = parseHM(a.end);
    if (e === null) {
      issues.push({ path: "end", reason: `시각은 HH:MM 로 씁니다 (예: 18:00). 받은 값: ${JSON.stringify(a.end)}` });
      return undefined;
    }
    return { start_min: s, end_min: e <= s ? e + 1440 : e };
  }
  const len = defaultLen ?? (base.start_min !== null && base.end_min !== null ? base.end_min - base.start_min : undefined);
  if (len === undefined) {
    issues.push({ path: "end", reason: "end(HH:MM)를 주세요 (또는 all_day: true)" });
    return undefined;
  }
  return { start_min: s, end_min: s + len };
}

// ---------------------------------------------------------------------------
// 결과 모양

type Names = Map<string, string>;
const placeName = (names: Names, id: string | null) => (id ? (names.get(id) ?? null) : null);

/** 일정 한 줄 (행 기준) */
function eventOut(e: EventRow, names: Names): Obj {
  const o: Obj = {
    id: e.id,
    title: e.title,
    date: e.date,
    time: e.start_min === null || e.end_min === null ? null : span(e.start_min, e.end_min),
    all_day: e.start_min === null,
    place: placeName(names, e.place_id),
  };
  if (e.where_text) o.where = e.where_text;
  if (e.travel_min !== null) o.travel_min = e.travel_min;
  if (e.note) o.note = e.note;
  if (e.repeat) o.repeat = repeatOut(e.repeat);
  if (e.task_id) o.task_id = e.task_id;
  if (e.source) o.source = e.source;
  o.version = e.version;
  return o;
}

/** 회차 한 줄 */
function occOut(o: Occurrence, names: Names, rows: Map<string, EventRow>, onDay: DateStr): Obj {
  const r: Obj = { id: o.event_id, on_date: o.on_date };
  if (o.date !== onDay || o.date !== o.on_date) r.date = o.date;
  r.title = o.title;
  r.time = o.all_day ? null : span(o.start_min!, o.end_min!);
  r.all_day = o.all_day;
  r.place = placeName(names, o.place_id);
  if (o.where_text) r.where = o.where_text;
  if (o.travel_min !== null) r.travel_min = o.travel_min;
  if (o.note) r.note = o.note;
  if (o.source) r.source = o.source;
  if (o.task_id) r.task_id = o.task_id;
  if (o.repeating) {
    r.repeat = repeatOut(rows.get(o.event_id)?.repeat ?? null);
    if (o.changed) r.changed = true;
  }
  r.version = o.version;
  return r;
}

function eventLine(e: { title: string; date: DateStr; start_min: number | null; end_min: number | null; place_id: string | null }, names: Names) {
  const time = e.start_min === null || e.end_min === null ? "종일" : span(e.start_min, e.end_min);
  const p = placeName(names, e.place_id);
  return `${e.title} · ${dayLabel(e.date)} ${time}${p ? ` · ${p}` : ""}`;
}

function bandOut(s: Extract<Segment, { kind: "prep" | "travel" }>, names: Names): Obj {
  if (s.kind === "prep") return { kind: "준비", time: span(s.start, s.end) };
  const b: Obj = { kind: s.label, time: span(s.start, s.end) };
  const from = placeName(names, s.from);
  const to = placeName(names, s.to);
  if (from) b.from = from;
  if (to) b.to = to;
  if (s.late > 0) b.late_min = s.late;
  return b;
}

const MEAL = { lunch: "점심", dinner: "저녁" } as const;

/** 지금 → Asia/Seoul 의 날짜와 0시부터 센 분 (한국은 서머타임이 없어 +9시간 고정) */
export function seoul(d: Date): { today: DateStr; nowMin: number } {
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return { today: k.toISOString().slice(0, 10), nowMin: k.getUTCHours() * 60 + k.getUTCMinutes() };
}

/** '2026-09-27' → '9/27' */
const shortDay = (d: DateStr) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 규칙 한 줄 요약: "매일" · "매주 월·수" · "'상법' 끝나면" */
function ruleSummary(r: TaskRule, events: Map<string, EventRow>): string {
  if (r.kind === "event") {
    const ev = r.event_id ? events.get(r.event_id) : undefined;
    return ev ? `'${ev.title}' 끝나면` : "일정 끝나면";
  }
  if (r.repeat?.freq === "weekly") return `매주 ${r.repeat.days.map((d) => WEEKDAYS[d - 1] ?? String(d)).join("·")}`;
  return "매일";
}

function ruleOut(r: TaskRule, names: Names, events: Map<string, EventRow>, roleNames: Names = new Map()): Obj {
  const o: Obj = { id: r.id, title: r.title, repeat: ruleSummary(r, events) };
  if (r.event_id) o.event_id = r.event_id;
  if (r.note) o.note = r.note;
  if (r.est_min !== null) o.est_min = r.est_min;
  const place = placeName(names, r.place_id);
  if (place) o.place = place;
  const role = placeName(roleNames, r.role_id);
  if (role) o.role = role;
  if (r.checklist.length > 0) o.checklist = r.checklist;
  if (r.due_after !== null) o.due_after = r.due_after;
  if (r.last_made) o.last_made = r.last_made;
  o.version = r.version;
  return o;
}

/**
 * 안 끝낸 할 일에서 무엇이 지났나 (docs/플래너.md 7-1). 없으면 undefined.
 * 이어진 일정이 끝났다(끝 시각이 지금과 같아도 지난 것 — ez_tasks_roll 과 같은 경계. 종일은 다음 날부터) · 마감 날이 지났다.
 * 이어진 일정이 반복이면 어느 회차인지 몰라 보지 않는다.
 */
export function lateOf(t: TaskRow, ev: EventRow | undefined, today: DateStr, nowMin: number): string | undefined {
  if (t.done_at) return undefined;
  const parts: string[] = [];
  if (ev && !ev.repeat && daysBetween(ev.date, today) * 1440 + nowMin >= (ev.end_min ?? 1440)) {
    parts.push(`일정 ${dayLabel(ev.date)}${ev.start_min === null ? "" : ` ${hm(ev.start_min)}`} 지남`);
  }
  if (t.due && t.due < today) parts.push(`마감 ${shortDay(t.due)} 지남`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

type TaskCtx = { names: Names; roleNames: Names; rules: Map<string, TaskRule>; events: Map<string, EventRow>; today: DateStr; nowMin: number };

function taskOut(t: TaskRow, ev: EventRow | undefined, c: TaskCtx): Obj {
  const o: Obj = { id: t.id, title: t.title };
  if (t.note) o.note = t.note;
  if (t.due) o.due = t.due;
  if (t.est_min !== null) o.est_min = t.est_min;
  const place = placeName(c.names, t.place_id);
  if (place) o.place = place;
  const role = placeName(c.roleNames, t.role_id);
  if (role) o.role = role;
  if (t.checklist.length > 0) o.checklist = t.checklist;
  if (t.done_at) o.done_at = t.done_at;
  // 작업대에 올라간 할 일 — 순서(작은 것이 앞) · 지금 앉은 것인지 (docs/플래너.md 7-15)
  if (t.bench_order !== null) o.bench = { order: t.bench_order, sitting: t.bench_at !== null };
  // 모임에서 나온 할 일 (docs/모임.md 4장)
  if (t.origin_kind === "meet" && t.origin_id) o.meet = t.origin_id;
  o.version = t.version;
  if (ev) o.event = { id: ev.id, date: ev.date, time: ev.start_min === null ? null : hm(ev.start_min) };
  const dueEv = t.due_event_id ? c.events.get(t.due_event_id) : undefined;
  if (dueEv) o.due_event = { id: dueEv.id, title: dueEv.title };
  const rule = t.rule_id ? c.rules.get(t.rule_id) : undefined;
  if (rule) {
    o.repeat = ruleSummary(rule, c.events);
    o.rule_id = rule.id;
  }
  const late = lateOf(t, ev, c.today, c.nowMin);
  if (late) o.late = late;
  return o;
}

// ---------------------------------------------------------------------------
// 플래너 입력

/** 체크 항목: 글자 배열 또는 [{t, done}]. 글자면 done:false. null 은 비움. undefined = 안 바꿈 */
function checklistIn(v: unknown, issues: Issue[]): CheckItem[] | undefined {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (!Array.isArray(v)) {
    issues.push({ path: "checklist", reason: '체크 항목은 글자 배열 ["우유"] 또는 [{t, done}] 로 씁니다' });
    return undefined;
  }
  if (v.length > CHECKLIST_MAX) issues.push({ path: "checklist", reason: `체크 항목은 ${CHECKLIST_MAX}개까지 넣을 수 있습니다 (지금 ${v.length}개)` });
  const out: CheckItem[] = [];
  v.forEach((x, i) => {
    const path = `checklist[${i}]`;
    const t = typeof x === "string" ? x : isObj(x) && typeof x.t === "string" ? x.t : null;
    if (t === null || (isObj(x) && x.done !== undefined && typeof x.done !== "boolean")) {
      issues.push({ path, reason: "체크 항목은 글자 또는 {t: 글자, done: true/false} 입니다" });
      return;
    }
    const s = t.trim();
    const n = charCount(s);
    if (n === 0) issues.push({ path, reason: "체크 항목이 비어 있습니다" });
    else if (n > CHECK_ITEM_MAX) issues.push({ path, reason: `체크 항목은 ${CHECK_ITEM_MAX}자까지 쓸 수 있습니다 (지금 ${n}자)` });
    out.push({ t: s, done: isObj(x) && x.done === true });
  });
  return out;
}

function dueAfterIn(v: unknown, issues: Issue[]): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > DUE_AFTER_MAX) {
    issues.push({ path: "due_after", reason: `마감까지 며칠(due_after)은 0~${DUE_AFTER_MAX} 정수입니다 (null 이면 마감 없음)` });
    return undefined;
  }
  return v;
}

type TodoRepeat = { kind: "cycle"; repeat: Exclude<Repeat, null> } | { kind: "event"; event_id: string };

/** 할 일의 반복: {freq:'daily'} · {freq:'weekly', days} · {after_event: 일정 id}. until 은 없다 */
function todoRepeatIn(v: unknown, today: DateStr, issues: Issue[]): TodoRepeat | undefined {
  if (v === undefined) return undefined;
  if (v === null) {
    issues.push({ path: "repeat", reason: "반복을 그만하려면 rule_id + stop: true 로 규칙을 멈추세요" });
    return undefined;
  }
  if (isObj(v) && v.after_event !== undefined) {
    if (typeof v.after_event !== "string" || !UUID.test(v.after_event.trim()) || v.freq !== undefined) {
      issues.push({ path: "repeat.after_event", reason: "after_event 는 반복 일정의 id(uuid) 하나만 씁니다 — schedule_get 으로 찾으세요" });
      return undefined;
    }
    return { kind: "event", event_id: v.after_event.trim() };
  }
  if (isObj(v) && v.until != null) {
    issues.push({ path: "repeat.until", reason: "반복 할 일에는 끝나는 날(until)을 쓰지 않습니다. 그만하려면 규칙을 멈추세요 (rule_id + stop: true)" });
    return undefined;
  }
  const before = issues.length;
  const r = repeatIn(v, issues);
  if (issues.length > before) {
    issues[issues.length - 1]!.reason = "반복은 {freq:'daily'} · {freq:'weekly', days:['월','수']} · {after_event: 반복 일정 id} 중 하나입니다";
    return undefined;
  }
  if (!r) return undefined;
  const bad = validateEvent({ title: "x", date: today, repeat: r }).filter((i) => i.path.startsWith("repeat"));
  if (bad.length > 0) {
    issues.push(...bad);
    return undefined;
  }
  return { kind: "cycle", repeat: r };
}

/** 규칙이 만들 할 일의 모양 (할 일에서 옮겨 적는다) */
function ruleShape(t: Pick<TaskRow, "title" | "note" | "est_min" | "place_id" | "checklist" | "role_id">) {
  return { title: t.title, note: t.note, est_min: t.est_min, place_id: t.place_id, role_id: t.role_id, checklist: t.checklist.map((c) => c.t) };
}

const same = (a: unknown, b: unknown) => a === b || (typeof a === "object" && a !== null && JSON.stringify(a) === JSON.stringify(b));

// ---------------------------------------------------------------------------

export type ScheduleOptions = { store: ScheduleStore; now?: () => Date };

type SaveArgs = {
  id?: string;
  base_version?: number;
  on_date?: string;
  scope?: string;
  title?: string;
  date?: string;
  start?: string;
  end?: string;
  all_day?: boolean;
  place?: string | null;
  where?: string | null;
  travel_min?: number | null;
  note?: string | null;
  repeat?: unknown;
  task_id?: string | null;
};

type SyncIn = {
  external_id?: string;
  title?: string;
  date?: string;
  start?: string;
  end?: string;
  all_day?: boolean;
  place?: string | null;
  where?: string | null;
  travel_min?: number | null;
  note?: string | null;
  repeat?: unknown;
};

type TodoArgs = {
  id?: string;
  base_version?: number;
  title?: string;
  note?: string | null;
  due?: string | null;
  est_min?: number | null;
  done?: boolean;
  delete?: boolean;
  place?: string | null;
  role?: string | null;
  checklist?: unknown;
  due_event?: unknown;
  repeat?: unknown;
  due_after?: number | null;
  scope?: string;
  rule_id?: string;
  stop?: boolean;
  meet?: string;
  /** 작업대에 올리기(true) · 내리기(false) (docs/플래너.md 7-15) */
  bench?: boolean;
};

const blank = (v: string | null | undefined) => (v == null || v.trim() === "" ? null : v);

/** 일정 칸 비교 (시작·끝은 같이) */
const EVENT_KEYS = ["title", "date", "place_id", "where_text", "travel_min", "note"] as const;

export function createSchedule({ store, now = () => new Date() }: ScheduleOptions) {
  async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await fn();
    } catch (e) {
      return dbFail(e);
    }
  }

  async function names(): Promise<{ places: Place[]; names: Names }> {
    const places = await store.places();
    return { places, names: new Map(places.map((p) => [p.id, p.name])) };
  }

  /** 살아 있는 역할 (sort 순). 하나도 없으면 기본 셋을 넣어 본다(ez_roles_seed) — 다 지운 사람에게는 다시 안 생긴다 */
  async function loadRoles(): Promise<Role[]> {
    const roles = await store.roles();
    if (roles.length > 0) return roles;
    return (await store.seedRoles()) > 0 ? store.roles() : roles;
  }
  const roleNamesOf = (roles: Role[]): Names => new Map(roles.map((r) => [r.id, r.name]));
  /** 그 지점에서 기본으로 들어갈 역할 id (docs/플래너.md 7-11). 없으면 null */
  const roleFrom = (placeId: string | null | undefined, places: Place[], roles: Role[]): string | null =>
    placeId ? (roleForPlace(places.find((p) => p.id === placeId), roles)?.id ?? null) : null;

  const conflict = (cur: EventRow, n: Names) =>
    fail(`그 사이 다른 곳에서 이 일정을 고쳤습니다 (지금 version ${cur.version}) — current 를 보고 다시 하세요`, "EZ_VERSION", {
      conflict: true,
      current: eventOut(cur, n),
    });

  const external = (e: EventRow, verb: string) =>
    fail(`바깥 일정(${e.source})이라 여기서 못 ${verb}. schedule_sync 로 바꾸세요`, "EZ_EXTERNAL");

  /** 바꾼 뒤 version 이 안 맞으면: 지금 값으로 충돌, 없으면 없음 */
  async function lost(id: string, n: Names): Promise<ToolResult> {
    const cur = await store.getEvent(id);
    return cur ? conflict(cur, n) : fail(`일정이 없습니다: ${id}`, "NOT_FOUND");
  }

  /** 반복 회차를 가리키는 입력 검사. 문제가 있으면 ToolResult */
  function needScope(ev: EventRow, a: { on_date?: string; scope?: string }, verb: string): { scope: Scope; on: DateStr | null } | ToolResult {
    if (!a.scope) {
      return fail(
        `반복 일정입니다 — 어느 회차를 ${verb}지 on_date(회차 날짜)와 scope(once 이번만 · following 이후 모두 · all 전체)를 주세요`,
        "NEED_SCOPE",
        { repeat: repeatOut(ev.repeat) },
      );
    }
    if (!(SCOPES as readonly string[]).includes(a.scope)) return fail("scope 는 once · following · all 중 하나입니다", "BAD_INPUT");
    const scope = a.scope as Scope;
    if (scope === "all") return { scope, on: null };
    if (!a.on_date) return fail(`scope ${scope} 에는 on_date(회차 날짜, YYYY-MM-DD)가 필요합니다`, "NEED_SCOPE");
    if (!isDateStr(a.on_date)) return fail("on_date 는 YYYY-MM-DD 날짜입니다", "BAD_INPUT");
    if (!occursOn(ev, a.on_date)) return fail(`${a.on_date} 는 이 일정이 반복되는 날이 아닙니다`, "EZ_DATE", { repeat: repeatOut(ev.repeat), date: ev.date });
    return { scope, on: a.on_date };
  }

  /** 입력의 일정 칸(시각·할 일 빼고) → patch. 지점 이름을 못 찾으면 ToolResult */
  function fieldsOf(a: SaveArgs, places: Place[], issues: Issue[]): EventPatch | ToolResult {
    const f: EventPatch = {};
    if (a.title !== undefined) f.title = typeof a.title === "string" ? a.title.trim() : a.title;
    if (a.date !== undefined) f.date = a.date;
    if (a.place !== undefined) {
      const hit = findPlace(a.place, places);
      if ("error" in hit) return hit.error;
      f.place_id = hit.id;
    }
    if (a.where !== undefined) f.where_text = blank(a.where)?.trim() ?? null;
    if (a.travel_min !== undefined) f.travel_min = a.travel_min;
    if (a.note !== undefined) f.note = blank(a.note);
    const r = repeatIn(a.repeat, issues);
    if (r !== undefined) f.repeat = r;
    return f;
  }

  /** 할 일 찾기 + 다른 일정과 이어져 있지 않은지 */
  async function taskFor(taskId: string, eventId: string | null, n: Names): Promise<TaskRow | ToolResult> {
    if (!UUID.test(taskId)) return fail("task_id 는 할 일의 uuid 입니다 — todo_list 로 찾으세요", "BAD_INPUT");
    const task = await store.getTask(taskId);
    if (!task) return fail(`할 일이 없습니다: ${taskId}`, "NOT_FOUND");
    const linked = (await store.eventsForTasks([taskId])).find((e) => e.id !== eventId);
    if (linked) {
      return fail(`이 할 일은 이미 일정과 이어져 있습니다: ${eventLine(linked, n)} — 그 일정을 고치세요 (id ${linked.id})`, "TASK_TAKEN", {
        event: eventOut(linked, n),
      });
    }
    return task;
  }

  // ------------------------------------------------------------------ 플래너 도우미

  /** 할 일 결과에 붙일 것: 지점 이름 · 역할 이름 · 규칙 · 딸린 일정 · 지금 */
  async function taskCtx(tasks: TaskRow[], known?: TaskRule[], knownRoles?: Role[]): Promise<TaskCtx> {
    const { names: n } = await names();
    const roleNames = roleNamesOf(knownRoles ?? (tasks.some((t) => t.role_id) ? await store.roles() : []));
    const rules = new Map<string, TaskRule>();
    if (tasks.some((t) => t.rule_id)) for (const r of known ?? (await store.rules())) rules.set(r.id, r);
    const ids = new Set<string>();
    for (const t of tasks) {
      if (t.due_event_id) ids.add(t.due_event_id);
      const r = t.rule_id ? rules.get(t.rule_id) : undefined;
      if (r?.event_id) ids.add(r.event_id);
    }
    const events = new Map((await store.eventsByIds([...ids])).map((e) => [e.id, e]));
    return { names: n, roleNames, rules, events, ...seoul(now()) };
  }

  const show = async (t: TaskRow, ev: EventRow | undefined) => taskOut(t, ev, await taskCtx([t]));

  /** due_event 입력 → 걸 일정과 마감 날짜(반복이면 회차 날짜, 아니면 DB 가 채우므로 일정 날짜). undefined · null = 걸지 않음 */
  async function dueEventIn(v: unknown): Promise<{ id: string; due: DateStr } | null | ToolResult> {
    if (v === undefined || v === null) return null;
    const shape = "due_event 는 {id: 일정 id, on_date?: 반복 일정의 회차 날짜} 또는 null(연결 끊기) 입니다";
    if (!isObj(v) || typeof v.id !== "string" || !UUID.test(v.id.trim())) return badInput([{ path: "due_event", reason: shape }]);
    const ev = await store.getEvent(v.id.trim());
    if (!ev) return fail(`일정이 없습니다: ${v.id.trim()} (due_event)`, "NOT_FOUND");
    if (!ev.repeat) return { id: ev.id, due: ev.date };
    if (v.on_date === undefined || v.on_date === null) {
      return fail(`반복 일정입니다 — 어느 회차 전까지인지 due_event.on_date(회차 날짜, YYYY-MM-DD)를 주세요`, "NEED_SCOPE", {
        errors: [{ path: "due_event.on_date", reason: "반복 일정이면 회차 날짜가 필요합니다" }],
        repeat: repeatOut(ev.repeat),
      });
    }
    if (!isDateStr(v.on_date)) return badInput([{ path: "due_event.on_date", reason: "on_date 는 YYYY-MM-DD 날짜입니다" }]);
    if (!occursOn(ev, v.on_date)) {
      return fail(`${v.on_date} 는 이 일정이 반복되는 날이 아닙니다`, "EZ_DATE", {
        errors: [{ path: "due_event.on_date", reason: "이 일정이 반복되는 날이 아닙니다" }],
        repeat: repeatOut(ev.repeat),
        date: ev.date,
      });
    }
    return { id: ev.id, due: v.on_date };
  }

  /** after_event 의 일정: 살아 있는 반복 일정이어야 한다 */
  async function repeatingEvent(id: string): Promise<EventRow | ToolResult> {
    const ev = await store.getEvent(id);
    if (!ev) return fail(`일정이 없습니다: ${id} (repeat.after_event)`, "NOT_FOUND");
    if (!ev.repeat) return fail("반복 일정이 아니라 끝날 때마다 할 일을 만들 수 없습니다. 반복 일정을 고르세요", "EZ_REPEAT");
    return ev;
  }

  /** 규칙의 반복을 바꾸는 patch. 종류(cycle ↔ event)는 못 바꾼다 */
  function ruleRepeatPatch(rule: TaskRule, rep: TodoRepeat | undefined): RulePatch | ToolResult {
    if (!rep) return {};
    if (rep.kind !== rule.kind) {
      return fail("주기 반복과 '일정 끝나면' 은 서로 못 바꿉니다 — rule_id + stop: true 로 멈추고 새로 만드세요", "BAD_INPUT");
    }
    return rep.kind === "cycle" ? { repeat: rep.repeat } : { event_id: rep.event_id };
  }

  /** rule_id 로 규칙만: 멈추기 · 고치기 */
  async function saveRule(a: TodoArgs): Promise<ToolResult> {
    const rid = String(a.rule_id).trim();
    if (!UUID.test(rid)) return fail("rule_id 는 반복 규칙의 uuid 입니다 — todo_list(status: rules) 로 찾으세요", "BAD_INPUT");
    const extra = (["id", "due", "done", "delete", "due_event", "scope", "bench"] as const).filter((k) => a[k] !== undefined);
    if (extra.length > 0) return fail(`rule_id 는 ${extra.join(" · ")} 와 같이 못 씁니다 — 규칙의 칸은 title · note · est_min · place · role · checklist · due_after · repeat 입니다`, "BAD_INPUT");
    const rule = await store.getRule(rid);
    if (!rule) return fail(`반복 규칙이 없습니다(이미 멈췄을 수 있습니다): ${rid}`, "NOT_FOUND");
    const { places, names: n } = await names();
    const events = new Map((await store.eventsByIds(rule.event_id ? [rule.event_id] : [])).map((e) => [e.id, e]));
    const roles = await loadRoles();
    const rn = roleNamesOf(roles);

    if (a.stop === true) {
      await store.stopRule(rid);
      return ok(`반복을 멈췄습니다: ${rule.title} (${ruleSummary(rule, events)}) — 이미 생긴 할 일은 남습니다`, { rule_id: rid, stopped: true });
    }
    const conflict = (r: TaskRule) =>
      fail(`그 사이 이 규칙이 바뀌었습니다 (지금 version ${r.version}) — current 를 보고 다시 하세요`, "EZ_VERSION", {
        conflict: true,
        current: ruleOut(r, n, events, rn),
      });
    if (!Number.isInteger(a.base_version)) return fail("규칙을 고칠 땐 base_version(todo_list status: rules 의 version)이 필요합니다", "BAD_INPUT");
    if (rule.version !== a.base_version) return conflict(rule);

    const issues: Issue[] = [];
    const patch: RulePatch = {};
    if (a.title !== undefined) patch.title = typeof a.title === "string" ? a.title.trim() : a.title;
    if (a.note !== undefined) patch.note = blank(a.note);
    if (a.est_min !== undefined) patch.est_min = a.est_min;
    if (a.place !== undefined) {
      const hit = findPlace(a.place, places, "place 를 비우세요");
      if ("error" in hit) return hit.error;
      patch.place_id = hit.id;
    }
    if (a.role !== undefined) {
      const hit = findRole(a.role, roles);
      if ("error" in hit) return hit.error;
      patch.role_id = hit.id;
    } else if (patch.place_id != null && patch.place_id !== rule.place_id && rule.role_id === null) {
      // 지점을 바꾸는데 역할이 비어 있으면 지점에서 채운다
      const from = roleFrom(patch.place_id, places, roles);
      if (from) patch.role_id = from;
    }
    const checklist = checklistIn(a.checklist, issues);
    if (checklist !== undefined) patch.checklist = checklist.map((c) => c.t);
    const dueAfter = dueAfterIn(a.due_after, issues);
    if (dueAfter !== undefined) patch.due_after = dueAfter;
    const rep = todoRepeatIn(a.repeat, rule.start ?? seoul(now()).today, issues);
    if (issues.length > 0) return badInput(issues);
    if (rep?.kind === "event") {
      const e = await repeatingEvent(rep.event_id);
      if ("ok" in e) return e;
      events.set(e.id, e);
    }
    const rp = ruleRepeatPatch(rule, rep);
    if ("ok" in rp) return rp;
    Object.assign(patch, rp);
    for (const k of Object.keys(patch) as (keyof RulePatch)[]) if (same(patch[k], rule[k])) delete patch[k];
    if (Object.keys(patch).length === 0) return ok(`바뀐 것이 없습니다: ${rule.title}`, { changed: false, rule: ruleOut(rule, n, events, rn) });
    const bad = validateTask({ ...rule, ...patch, checklist: undefined });
    if (bad.length > 0) return badInput(bad);
    const r = await store.updateRule(rid, patch, rule.version);
    if (!r) {
      const cur = await store.getRule(rid);
      return cur ? conflict(cur) : fail(`반복 규칙이 없습니다(이미 멈췄을 수 있습니다): ${rid}`, "NOT_FOUND");
    }
    return ok(`규칙을 고쳤습니다: ${r.title} (${ruleSummary(r, events)}) — 앞으로 생길 할 일부터 적용`, { changed: true, rule: ruleOut(r, n, events, rn) });
  }

  // ------------------------------------------------------------------ save 갈래

  async function saveNew(a: SaveArgs): Promise<ToolResult> {
    const { places, names: n } = await names();
    const issues: Issue[] = [];
    let task: TaskRow | null = null;
    if (a.task_id) {
      const t = await taskFor(a.task_id, null, n);
      if ("ok" in t) return t;
      task = t;
    }
    const f = fieldsOf(a, places, issues);
    if ("ok" in f) return f;
    const before = issues.length;
    const t = resolveTimes(a, { start_min: null, end_min: null }, task ? (task.est_min ?? TASK_DEFAULT_MIN) : undefined, issues);
    if (!t && issues.length === before) issues.push({ path: "start", reason: "start·end(HH:MM) 또는 all_day: true 를 주세요" });
    const row: NewEvent = {
      title: f.title as string,
      date: f.date as string,
      start_min: t?.start_min ?? null,
      end_min: t?.end_min ?? null,
      place_id: f.place_id ?? null,
      where_text: f.where_text ?? null,
      travel_min: f.travel_min ?? null,
      note: f.note ?? null,
      repeat: f.repeat ?? null,
      task_id: task?.id ?? null,
    };
    issues.push(...validateEvent(row)); // 시각에 문제가 있으면 row 는 종일 모양이라 시각 문제가 겹치지 않는다
    if (issues.length > 0) return badInput(issues);
    const ev = await store.insertEvent(row);
    const linked = task ? ` (할 일 "${task.title}" 과 이음)` : "";
    return ok(`넣었습니다: ${eventLine(ev, n)}${linked}`, { created: true, event: eventOut(ev, n) });
  }

  async function saveOnce(a: SaveArgs, ev: EventRow, on: DateStr, n: Names, places: Place[]): Promise<ToolResult> {
    if (a.repeat !== undefined || a.task_id !== undefined) {
      return fail("once(이번만)로는 반복 규칙·할 일을 못 바꿉니다 — following 이나 all 로 하세요", "BAD_INPUT");
    }
    const issues: Issue[] = [];
    const f = fieldsOf(a, places, issues);
    if ("ok" in f) return f;
    const ex = (await store.exceptions([ev.id])).find((x) => x.on_date === on);
    const p: ExceptionPatch = ex?.patch ?? {};
    // 지금 이 회차의 값 (예외를 얹은 것)
    const cur = {
      title: p.title ?? ev.title,
      date: p.date ?? on,
      start_min: "start_min" in p ? (p.start_min ?? null) : ev.start_min,
      end_min: "end_min" in p ? (p.end_min ?? null) : ev.end_min,
      place_id: "place_id" in p ? (p.place_id ?? null) : ev.place_id,
      where_text: "where_text" in p ? (p.where_text ?? null) : ev.where_text,
      travel_min: "travel_min" in p ? (p.travel_min ?? null) : ev.travel_min,
      note: "note" in p ? (p.note ?? null) : ev.note,
    };
    const t = resolveTimes(a, cur, undefined, issues);
    const next = { ...cur, ...f, ...(t ?? {}) };
    if (issues.length === 0) issues.push(...validateEvent({ ...next, repeat: null }));
    if (issues.length > 0) return badInput(issues);

    // 원래 일정과 다른 칸만
    const patch: ExceptionPatch = {};
    const orig = { ...ev, date: on };
    for (const k of EVENT_KEYS) if (next[k] !== orig[k]) (patch as Obj)[k] = next[k];
    if (next.start_min !== ev.start_min || next.end_min !== ev.end_min) {
      patch.start_min = next.start_min;
      patch.end_min = next.end_min;
    }
    if (Object.keys(patch).length === 0) {
      if (ex) await store.dropException(ev.id, on);
      const what = ex ? "원래대로 되돌렸습니다" : "바뀐 것이 없습니다";
      return ok(`${dayLabel(on)} 회차 — ${what}: ${eventLine(orig, n)}`, { scope: "once", on_date: on, changed: !!ex, event: eventOut(ev, n) });
    }
    await store.putException({ event_id: ev.id, on_date: on, skip: false, patch });
    return ok(`${dayLabel(on)} 회차만 고쳤습니다: ${eventLine(next, n)}`, {
      scope: "once",
      on_date: on,
      event: { ...eventOut({ ...ev, ...next }, n), on_date: on, changed: Object.keys(patch) },
    });
  }

  async function saveFollowing(a: SaveArgs, ev: EventRow, on: DateStr, n: Names, places: Place[]): Promise<ToolResult> {
    if (a.task_id !== undefined) return fail("following(이후 모두)로는 할 일을 못 잇습니다 — all 로 하세요", "BAD_INPUT");
    const issues: Issue[] = [];
    const f = fieldsOf(a, places, issues);
    if ("ok" in f) return f;
    const t = resolveTimes(a, ev, undefined, issues);
    if (issues.length > 0) return badInput(issues);
    const patch: SplitPatch = {};
    for (const k of EVENT_KEYS) {
      if (f[k] !== undefined && (k === "date" || f[k] !== ev[k])) (patch as Obj)[k] = f[k];
    }
    if (f.repeat !== undefined && JSON.stringify(f.repeat) !== JSON.stringify(ev.repeat)) patch.repeat = f.repeat;
    if (t && (t.start_min !== ev.start_min || t.end_min !== ev.end_min)) {
      patch.start_min = t.start_min;
      patch.end_min = t.end_min;
    }
    if (Object.keys(patch).length === 0) {
      return ok(`바뀐 것이 없습니다: ${eventLine(ev, n)}`, { scope: "following", on_date: on, changed: false, event: eventOut(ev, n) });
    }
    const merged = { ...ev, date: on, ...patch, repeat: patch.repeat !== undefined ? patch.repeat : ev.repeat };
    issues.push(...validateEvent(merged));
    if (issues.length > 0) return badInput(issues);
    const row = await store.splitEvent(ev.id, ev.version, on, patch);
    if (row.id === ev.id) {
      return ok(`첫 회차라 반복 전체를 고쳤습니다: ${eventLine(row, n)}`, { scope: "following", on_date: on, split: false, event: eventOut(row, n) });
    }
    // 원래 일정에 딸린 '끝나면 할 일' 규칙은 새 일정을 따라간다 (새 일정이 반복일 때만 — 규칙은 반복 일정에만 걸린다)
    const moved = row.repeat ? await store.moveRules(ev.id, row.id) : 0;
    const note = moved > 0 ? ` · 끝나면 생기는 할 일 규칙 ${moved}개도 새 일정으로 옮겼습니다` : "";
    return ok(`${dayLabel(on)} 부터 새 일정으로 나눠 고쳤습니다 (원래 일정은 ${dayLabel(addDays(on, -1))} 까지): ${eventLine(row, n)}${note}`, {
      scope: "following",
      on_date: on,
      split: true,
      original_id: ev.id,
      event: eventOut(row, n),
      ...(moved > 0 ? { rules_moved: moved } : {}),
    });
  }

  async function saveAll(a: SaveArgs, ev: EventRow, n: Names, places: Place[]): Promise<ToolResult> {
    const issues: Issue[] = [];
    const f = fieldsOf(a, places, issues);
    if ("ok" in f) return f;
    let task: TaskRow | null = null;
    if (a.task_id !== undefined && a.task_id !== null && a.task_id !== ev.task_id) {
      const t = await taskFor(a.task_id, ev.id, n);
      if ("ok" in t) return t;
      task = t;
    }
    const defaultLen = task?.est_min != null && a.end === undefined ? task.est_min : undefined;
    const t = resolveTimes(a, ev, defaultLen, issues);
    if (issues.length > 0) return badInput(issues);

    const patch: EventPatch = {};
    for (const k of EVENT_KEYS) if (f[k] !== undefined && f[k] !== ev[k]) (patch as Obj)[k] = f[k];
    if (f.repeat !== undefined && JSON.stringify(f.repeat) !== JSON.stringify(ev.repeat)) patch.repeat = f.repeat;
    if (t && (t.start_min !== ev.start_min || t.end_min !== ev.end_min)) {
      patch.start_min = t.start_min;
      patch.end_min = t.end_min;
    }
    if (a.task_id !== undefined && (a.task_id ?? null) !== ev.task_id) patch.task_id = a.task_id ?? null;
    if (Object.keys(patch).length === 0) return ok(`바뀐 것이 없습니다: ${eventLine(ev, n)}`, { changed: false, event: eventOut(ev, n) });

    issues.push(...validateEvent({ ...ev, ...patch }));
    if (issues.length > 0) return badInput(issues);
    const row = await store.updateEvent(ev.id, patch, ev.version);
    if (!row) return lost(ev.id, n);
    const what = ev.repeat ? "반복 전체를 고쳤습니다" : "고쳤습니다";
    const link = patch.task_id ? ` (할 일 "${task?.title}" 과 이음)` : patch.task_id === null ? " (할 일과 연결을 끊음)" : "";
    return ok(`${what}: ${eventLine(row, n)}${link}`, {
      ...(ev.repeat ? { scope: "all" } : {}),
      changed: true,
      event: eventOut(row, n),
    });
  }

  return {
    // ---------------------------------------------------------------- get
    schedule_get: (a: { from: string; to: string; free_min?: number }) =>
      guard(async () => {
        if (!isDateStr(a.from) || !isDateStr(a.to)) return fail("from·to 는 YYYY-MM-DD 날짜입니다", "BAD_INPUT");
        if (a.to < a.from) return fail("to 가 from 보다 이릅니다", "BAD_INPUT");
        const days = daysBetween(a.from, a.to) + 1;
        if (days > MAX_DAYS) {
          return fail(`한 번에 ${MAX_DAYS}일까지 볼 수 있습니다 (지금 ${days}일) — 기간을 나눠 부르세요`, "RANGE", { max_days: MAX_DAYS });
        }
        const freeMin = a.free_min;
        if (freeMin !== undefined && (!Number.isInteger(freeMin) || freeMin < 1 || freeMin > FREE_TO - FREE_FROM)) {
          return fail(`free_min 은 1~${FREE_TO - FREE_FROM} 분 정수입니다`, "BAD_INPUT");
        }

        const { places, names: n } = await names();
        const travel = await store.travel();
        const settings = await store.settings();
        const events = await store.eventsBetween(addDays(a.from, -2), a.to);
        const exceptions = await store.exceptions(events.filter((e) => e.repeat).map((e) => e.id));
        const rows = new Map(events.map((e) => [e.id, e]));
        const { occurrences, days: plans } = planRange(a.from, a.to, events, exceptions, places, travel, settings);

        const before = addDays(a.from, -1);
        let lateCount = 0;
        let missing = 0;
        let prev: DayPlan | null = null;
        const out = plans.map((day) => {
          const d = day.date;
          const mine = occurrences.filter((o) => o.date === d || (d === a.from && o.date === before));
          const bands: Obj[] = [];
          const meals: Obj[] = [];
          for (const s of day.segments) {
            if (s.kind === "prep" || s.kind === "travel") {
              bands.push(bandOut(s, n));
              if (s.kind === "travel" && s.late > 0) lateCount++;
            } else if (s.kind === "meal") {
              meals.push({ meal: MEAL[s.meal], time: span(s.start, s.end), ...(s.short ? { short: true } : {}) });
            } else {
              meals.push({ meal: MEAL[s.meal], missing: true });
              missing++;
            }
          }
          const row: Obj = { date: d, wd: WEEKDAYS[weekday(d) - 1], events: mine.map((o) => occOut(o, n, rows, d)), bands };
          if (meals.length > 0) row.meals = meals.sort((x, y) => (x.meal === y.meal ? 0 : x.meal === MEAL.lunch ? -1 : 1));
          if (freeMin !== undefined) {
            // 전날 띠(귀가 등)가 자정을 넘어오면 그 부분도 바쁜 시간
            const spill = (prev?.segments ?? [])
              .filter((s): s is Extract<Segment, { kind: "prep" | "travel" }> => (s.kind === "prep" || s.kind === "travel") && s.end > 1440)
              .map((s) => ({ ...s, date: d, start: Math.max(0, s.start - 1440), end: s.end - 1440 }));
            const occs = occurrences.filter((o) => o.date === d || (o.date === addDays(d, -1) && spillsOver(o)));
            row.free = freeSlots({ ...day, segments: [...day.segments, ...spill] }, occs, freeMin, FREE_FROM, FREE_TO).map((g) => span(g.start, g.end));
          }
          prev = day;
          return row;
        });

        const count = out.reduce((k, r) => k + (r.events as unknown[]).length, 0);
        const range = a.from === a.to ? dayLabel(a.from) : `${dayLabel(a.from)}~${dayLabel(a.to)}`;
        const extra = [lateCount > 0 ? `늦음 ${lateCount}곳` : "", missing > 0 ? `식사 틈 없음 ${missing}번` : ""].filter(Boolean);
        return ok(`${range} · 일정 ${count}개${extra.length ? ` · ${extra.join(" · ")}` : ""}`, {
          from: a.from,
          to: a.to,
          days: out,
          places: places.filter((p) => !p.deleted).map((p) => ({ name: p.name, role: p.role })),
        });
      }),

    // ---------------------------------------------------------------- save
    schedule_save: (a: SaveArgs) =>
      guard(async () => {
        if (a.id === undefined || a.id === null || a.id === "") return saveNew(a);
        const id = String(a.id).trim();
        if (!UUID.test(id)) return fail("id 는 일정의 uuid 입니다 — schedule_get 으로 찾으세요", "BAD_INPUT");
        if (!Number.isInteger(a.base_version)) return fail("고칠 땐 base_version(schedule_get 의 version)이 필요합니다", "BAD_INPUT");
        const ev = await store.getEvent(id);
        if (!ev) return fail(`일정이 없습니다: ${id}`, "NOT_FOUND");
        if (ev.source) return external(ev, "고칩니다");
        const { places, names: n } = await names();
        if (ev.version !== a.base_version) return conflict(ev, n);
        if (!ev.repeat) return saveAll(a, ev, n, places);
        const s = needScope(ev, a, "고칠");
        if ("ok" in s) return s;
        if (s.scope === "once") return saveOnce(a, ev, s.on!, n, places);
        if (s.scope === "following") return saveFollowing(a, ev, s.on!, n, places);
        return saveAll(a, ev, n, places);
      }),

    // ---------------------------------------------------------------- delete
    schedule_delete: (a: { id: string; on_date?: string; scope?: string }) =>
      guard(async () => {
        const id = typeof a.id === "string" ? a.id.trim() : "";
        if (!UUID.test(id)) return fail("id 는 일정의 uuid 입니다 — schedule_get 으로 찾으세요", "BAD_INPUT");
        const ev = await store.getEvent(id);
        if (!ev) return fail(`일정이 없습니다: ${id}`, "NOT_FOUND");
        if (ev.source) return external(ev, "지웁니다");
        const { names: n } = await names();
        const line = eventLine(ev, n);
        const freed = ev.task_id ? " — 이어진 할 일은 다시 '시간 없음' 으로" : "";

        let scope: Scope = "all";
        let on: DateStr | null = null;
        if (ev.repeat) {
          const s = needScope(ev, a, "지울");
          if ("ok" in s) return s;
          scope = s.scope;
          on = s.on;
        }
        if (scope === "once") {
          await store.putException({ event_id: ev.id, on_date: on!, skip: true, patch: null });
          return ok(`${dayLabel(on!)} 회차만 지웠습니다: ${ev.title}`, { id, scope, on_date: on, deleted: "once" });
        }
        if (scope === "following") {
          await store.cutEvent(ev.id, ev.version, on!);
          const left = await store.getEvent(ev.id);
          if (!left) return ok(`첫 회차라 반복 전체를 지웠습니다: ${line}${freed}`, { id, scope, on_date: on, deleted: "all" });
          return ok(`${dayLabel(on!)} 부터 지웠습니다 (${dayLabel(addDays(on!, -1))} 까지 남음): ${ev.title}`, {
            id,
            scope,
            on_date: on,
            deleted: "following",
            event: eventOut(left, n),
          });
        }
        if (!(await store.deleteEvent(ev.id, ev.version))) return lost(ev.id, n);
        return ok(`지웠습니다: ${line}${ev.repeat ? " (반복 전체)" : ""}${freed}`, { id, ...(ev.repeat ? { scope } : {}), deleted: "all" });
      }),

    // ---------------------------------------------------------------- sync
    schedule_sync: (a: { source: string; from: string; to: string; events: unknown[]; label?: string }) =>
      guard(async () => {
        if (!isDateStr(a.from) || !isDateStr(a.to)) return fail("from·to 는 YYYY-MM-DD 날짜입니다", "BAD_INPUT");
        if (!Array.isArray(a.events)) return fail("events 는 배열입니다", "BAD_INPUT");
        const { places } = await names();
        const errors: { index: number; external_id: unknown; path: string; reason: string }[] = [];
        const out: SyncEvent[] = [];
        a.events.forEach((raw, index) => {
          const e = (isObj(raw) ? raw : {}) as SyncIn;
          const issues: Issue[] = [];
          if (!isObj(raw)) issues.push({ path: "", reason: "일정 하나는 {external_id, title, date, …} 객체입니다" });
          const xid = typeof e.external_id === "string" ? e.external_id.trim() : "";
          if (!xid) issues.push({ path: "external_id", reason: "external_id(바깥 쪽 id)가 없습니다" });
          const before = issues.length;
          const t = resolveTimes(e, { start_min: null, end_min: null }, undefined, issues);
          if (!t && issues.length === before) issues.push({ path: "start", reason: "start·end(HH:MM) 또는 all_day: true 를 주세요" });
          let placeId: string | null = null;
          if (e.place !== undefined) {
            const hit = findPlace(e.place, places);
            if ("error" in hit) issues.push({ path: "place", reason: hit.reason });
            else placeId = hit.id;
          }
          const repeat = repeatIn(e.repeat, issues) ?? null;
          const row: SyncEvent = {
            external_id: xid,
            title: typeof e.title === "string" ? e.title.trim() : (e.title as unknown as string),
            date: e.date as string,
            start_min: t?.start_min ?? null,
            end_min: t?.end_min ?? null,
            place_id: placeId,
            where_text: blank(e.where)?.trim() ?? null,
            travel_min: e.travel_min ?? null,
            note: blank(e.note),
            repeat,
          };
          issues.push(...validateEvent(row));
          if (isDateStr(row.date) && (row.date < a.from || row.date > a.to)) {
            issues.push({ path: "date", reason: `날짜 ${row.date} 가 맞출 기간(${a.from} ~ ${a.to}) 밖입니다` });
          }
          for (const i of issues) errors.push({ index, external_id: e.external_id ?? null, path: inPath(i.path), reason: i.reason });
          out.push(row);
        });
        if (errors.length > 0) {
          const head = errors
            .slice(0, 5)
            .map((x) => `events[${x.index}]${x.path ? `.${x.path}` : ""}: ${x.reason}`)
            .join(" / ");
          return fail(`events ${errors.length}곳이 틀려 아무것도 바꾸지 않았습니다 — ${head}${errors.length > 5 ? " / …" : ""}`, "EZ_SYNC", { errors });
        }
        const label = typeof a.label === "string" && a.label.trim() ? a.label.trim() : null;
        const r = await store.sync(a.source, a.from, a.to, out, label);
        const name = label ? `${label}(${a.source})` : a.source;
        return ok(`${name} ${dayLabel(a.from)}~${dayLabel(a.to)} 맞춤: 넣음 ${r.inserted} · 고침 ${r.updated} · 지움 ${r.deleted}`, { ...r });
      }),

    // ---------------------------------------------------------------- todo_list
    todo_list: (a: { status?: string; query?: string; role?: string | null } = {}) =>
      guard(async () => {
        const status = a.status ?? "open";
        if (status !== "open" && status !== "done" && status !== "all" && status !== "rules") {
          return fail("status 는 open · done · all · rules 중 하나입니다", "BAD_INPUT");
        }
        // 열 때 역할 기본 셋을 넣고(처음 한 번) 규칙을 굴린다 (docs/플래너.md 7-2 · 7-11)
        const roles = await loadRoles();
        const rn = roleNamesOf(roles);
        let roleId: string | null | undefined;
        if (a.role !== undefined) {
          const h = findRole(a.role, roles);
          if ("error" in h) return h.error;
          roleId = h.id;
        }
        const q = a.query?.trim().toLowerCase() ?? "";
        const hit = (x: { title: string; note: string | null; role_id: string | null }) =>
          (roleId === undefined || x.role_id === roleId) && (!q || x.title.toLowerCase().includes(q) || (x.note ?? "").toLowerCase().includes(q));
        const tail = `${roleId === undefined ? "" : roleId === null ? " · 역할 없음" : ` · 역할 ${rn.get(roleId)}`}${q ? ` · "${a.query!.trim()}"` : ""}`;
        const clock = seoul(now());
        const made = await store.roll(clock.today, clock.nowMin);
        const rules = await store.rules();

        if (status === "rules") {
          const picked = rules.filter(hit);
          const { names: n } = await names();
          const events = new Map((await store.eventsByIds(picked.flatMap((r) => (r.event_id ? [r.event_id] : [])))).map((e) => [e.id, e]));
          return ok(`반복 규칙 ${picked.length}개${tail}`, { status, rules: picked.map((r) => ruleOut(r, n, events, rn)) });
        }

        const all = await store.tasks();
        const picked = all.filter((t) => (status === "all" || (status === "open") === (t.done_at === null)) && hit(t));
        const open = picked.filter((t) => t.done_at === null).sort((x, y) => x.sort - y.sort || x.created_at.localeCompare(y.created_at));
        const done = picked.filter((t) => t.done_at !== null).sort((x, y) => y.done_at!.localeCompare(x.done_at!));
        const linked = new Map<string, EventRow>();
        for (const e of await store.eventsForTasks(picked.map((t) => t.id))) if (e.task_id) linked.set(e.task_id, e);
        const ctx = await taskCtx(picked, rules, roles);
        // 작업대에 올라간 할 일이 맨 위, 올린 순서대로 (docs/플래너.md 7-15)
        const onBench = open.filter((t) => t.bench_order !== null).sort((x, y) => x.bench_order! - y.bench_order!);
        const ordered = [...onBench, ...open.filter((t) => t.bench_order === null), ...done];
        const sitting = onBench.find((t) => t.bench_at !== null);
        const items = ordered.map((t) => taskOut(t, linked.get(t.id), ctx));
        const late = items.filter((t) => t.late).length;
        const what = { open: "안 끝남", done: "끝냄", all: "전체" }[status];
        const benchNote = onBench.length > 0 ? ` · 작업대 ${onBench.length}개${sitting ? ` (앉은 것 "${sitting.title}")` : ""}` : "";
        return ok(`할 일 ${items.length}개 (${what})${late > 0 ? ` · 지남 ${late}개` : ""}${benchNote}${tail}`, {
          status,
          items,
          roles: roles.map((r) => r.name),
          ...(late > 0 ? { late } : {}),
          ...(made > 0 ? { made } : {}),
        });
      }),

    // ---------------------------------------------------------------- todo_save
    todo_save: (a: TodoArgs) =>
      guard(async () => {
        if (a.rule_id !== undefined && a.rule_id !== null && a.rule_id !== "") return saveRule(a);
        if (a.stop !== undefined) return fail("stop 은 rule_id(todo_list 의 rule_id)와 같이 씁니다", "BAD_INPUT");
        const nowIso = now().toISOString();
        const { today } = seoul(now());
        const isNew = a.id === undefined || a.id === null || a.id === "";
        if (isNew && a.delete) return fail("지울 할 일의 id 를 주세요", "BAD_INPUT");
        if (a.scope !== undefined && a.scope !== "once" && a.scope !== "rule") return fail("scope 는 once(이 할 일만) · rule(규칙도 같이) 중 하나입니다", "BAD_INPUT");
        if (a.bench !== undefined && typeof a.bench !== "boolean") return fail("bench 는 true(작업대에 올리기) · false(내리기) 입니다", "BAD_INPUT");
        if (a.bench === true && a.done === true) return fail("끝낸 할 일은 작업대에 올릴 수 없습니다 — done 과 bench 를 같이 쓰지 마세요", "BAD_INPUT");

        // ---- 새 칸 읽기
        const issues: Issue[] = [];
        let placeList: Place[] | null = null;
        const getPlaces = async () => (placeList ??= (await names()).places);
        let placeId: string | null | undefined;
        if (a.place !== undefined) {
          const hit = findPlace(a.place, await getPlaces(), "place 를 비우세요");
          if ("error" in hit) return hit.error;
          placeId = hit.id;
        }
        const checklist = checklistIn(a.checklist, issues);
        const dueAfter = dueAfterIn(a.due_after, issues);
        const rep = todoRepeatIn(a.repeat, today, issues);
        if (a.due_event !== undefined && a.due_event !== null && a.due != null) {
          issues.push({ path: "due", reason: "due 와 due_event 는 같이 못 씁니다 — 일정에 딸린 마감은 그 일정 날짜가 마감입니다" });
        }
        if (issues.length > 0) return badInput(issues);
        const link = await dueEventIn(a.due_event);
        if (link && "ok" in link) return link;
        let ruleEvent: EventRow | null = null;
        if (rep?.kind === "event") {
          const e = await repeatingEvent(rep.event_id);
          if ("ok" in e) return e;
          ruleEvent = e;
        }
        // 역할: 이름으로 주면 그 역할(null 이면 비움), 안 주면 지점에서 (docs/플래너.md 7-11)
        const roles = a.role !== undefined || placeId != null || ruleEvent || (a.meet !== undefined && a.meet !== null && a.meet !== "") ? await loadRoles() : [];
        let roleId: string | null | undefined;
        if (a.role !== undefined) {
          const hit = findRole(a.role, roles);
          if ("error" in hit) return hit.error;
          roleId = hit.id;
        }
        const fromPlace = async (pid: string | null | undefined) => (pid ? roleFrom(pid, await getPlaces(), roles) : null);

        // 모임에서 나온 할 일 (docs/모임.md 4장): 넣을 때만. 지점 · 역할을 안 주면 모임의 지점 · 묶음의 역할을 물려받는다
        const meetGiven = a.meet !== undefined && a.meet !== null && a.meet !== "";
        if (meetGiven && !isNew) return fail("meet 는 새 할 일을 넣을 때만 씁니다 (이미 있는 할 일은 못 옮깁니다)", "BAD_INPUT");
        let meetRef: Awaited<ReturnType<ScheduleStore["meetRef"]>> = null;
        if (meetGiven) {
          const mid = String(a.meet).trim();
          if (!UUID.test(mid)) return fail("meet 는 모임의 uuid 입니다 — meet_get 으로 찾으세요", "BAD_INPUT");
          if (rep?.kind === "event") return fail("meet 는 일정이 끝날 때마다 생기는 규칙에는 못 씁니다", "BAD_INPUT");
          meetRef = await store.meetRef(mid);
          if (!meetRef) return fail(`모임이 없습니다: ${mid}`, "NOT_FOUND");
          if (placeId === undefined) placeId = meetRef.place_id;
          if (roleId === undefined && meetRef.role_id !== null) roleId = meetRef.role_id;
        }

        // ---- 넣기
        if (isNew) {
          if (a.scope === "rule") return fail("scope: rule 은 규칙에서 온 할 일을 고칠 때만 씁니다", "BAD_INPUT");
          if (dueAfter !== undefined && dueAfter !== null && !rep) {
            return badInput([{ path: "due_after", reason: "due_after 는 repeat 와 같이 쓰거나 규칙을 고칠 때(scope: rule · rule_id) 씁니다" }]);
          }
          const row = {
            title: typeof a.title === "string" ? a.title.trim() : (a.title as unknown as string),
            note: blank(a.note),
            due: link ? link.due : (a.due ?? null),
            est_min: a.est_min ?? null,
            place_id: placeId ?? null,
            role_id: roleId !== undefined ? roleId : await fromPlace(placeId),
            due_event_id: link ? link.id : null,
            checklist: checklist ?? [],
          };
          const bad = validateTask(row);
          if (bad.length > 0) return badInput(bad);

          // 일정이 끝날 때마다: 규칙만 만든다 (지금 할 일은 없음). last_made = 오늘이라 지난 회차는 안 생긴다
          if (rep?.kind === "event") {
            const extra = (["due", "due_event", "done", "bench"] as const).filter((k) => a[k] !== undefined && a[k] !== null);
            if (extra.length > 0) {
              return badInput(extra.map((k) => ({ path: k, reason: "일정이 끝날 때마다 생기는 규칙에는 못 씁니다 — 마감은 due_after(며칠 뒤)로" })));
            }
            // 역할을 안 줬고 규칙의 지점에서도 못 얻었으면 그 일정의 지점에서
            const role_id = roleId === undefined && row.role_id === null ? await fromPlace(ruleEvent!.place_id) : row.role_id;
            const rule = await store.insertRule({ ...ruleShape(row), role_id, kind: "event", repeat: null, start: null, event_id: rep.event_id, due_after: dueAfter ?? null, last_made: today });
            const events = new Map([[ruleEvent!.id, ruleEvent!]]);
            const { names: n } = await names();
            return ok(`반복 규칙을 만들었습니다: ${ruleSummary(rule, events)} "${rule.title}" — 다음 회차가 끝난 뒤부터 할 일이 생깁니다`, {
              created: true,
              rule: ruleOut(rule, n, events, roleNamesOf(roles)),
            });
          }

          const sorts = (await store.tasks()).map((t) => t.sort);
          const sort = sorts.length > 0 ? Math.min(...sorts) - 1 : 0;
          const done_at = a.done ? nowIso : null;
          const origin = meetRef ? { origin_kind: "meet" as const, origin_id: meetRef.id } : {};
          if (!rep) {
            let t = await store.insertTask({ ...row, ...origin, sort, done_at });
            if (a.bench === true) t = (await store.benchTask(t.id, true)) ?? t;
            return ok(`넣었습니다: ${t.title}${meetRef ? ` (모임 ${meetRef.title})` : ""}${a.bench === true ? " · 작업대에 올림" : ""}`, {
              created: true,
              task: await show(t, undefined),
            });
          }
          // 주기 반복: 규칙을 만들고 이 할 일이 첫 회차
          if (!link && row.due === null && dueAfter != null) row.due = addDays(today, dueAfter);
          const rule = await store.insertRule({ ...ruleShape(row), kind: "cycle", repeat: rep.repeat, start: today, event_id: null, due_after: dueAfter ?? null, last_made: today });
          let t: TaskRow;
          try {
            t = await store.insertTask({ ...row, ...origin, sort, done_at, rule_id: rule.id, rule_date: today });
          } catch (e) {
            await store.stopRule(rule.id);
            throw e;
          }
          if (a.bench === true) t = (await store.benchTask(t.id, true)) ?? t;
          return ok(`넣었습니다: ${t.title} (반복 ${ruleSummary(rule, new Map())})${a.bench === true ? " · 작업대에 올림" : ""}`, {
            created: true,
            task: await show(t, undefined),
          });
        }

        // ---- 고치기
        const id = String(a.id).trim();
        if (!UUID.test(id)) return fail("id 는 할 일의 uuid 입니다 — todo_list 로 찾으세요", "BAD_INPUT");
        if (!Number.isInteger(a.base_version)) return fail("고칠 땐 base_version(todo_list 의 version)이 필요합니다", "BAD_INPUT");
        const cur = await store.getTask(id);
        if (!cur) return fail(`할 일이 없습니다: ${id}`, "NOT_FOUND");
        const linked = (await store.eventsForTasks([id]))[0];
        const taskConflict = async (t: TaskRow, ev: EventRow | undefined) =>
          fail(`그 사이 다른 곳에서 이 할 일을 고쳤습니다 (지금 version ${t.version}) — current 를 보고 다시 하세요`, "EZ_VERSION", {
            conflict: true,
            current: await show(t, ev),
          });
        const lostTask = async () => {
          const t = await store.getTask(id);
          return t ? taskConflict(t, linked) : fail(`할 일이 없습니다: ${id}`, "NOT_FOUND");
        };
        if (cur.version !== a.base_version) return taskConflict(cur, linked);

        if (a.delete === true) {
          const others = (["title", "note", "due", "est_min", "done", "place", "role", "checklist", "due_event", "repeat", "due_after", "scope", "bench"] as const).filter(
            (k) => a[k] !== undefined,
          );
          if (others.length > 0) return fail(`delete 는 ${others.join(" · ")} 와 같이 못 씁니다 — 따로 부르세요`, "BAD_INPUT");
          if (!(await store.deleteTask(id, cur.version))) return lostTask();
          let kept = "";
          if (linked) {
            // 할 일을 지우면 일정은 남고 연결만 끊는다 (docs/플래너.md 1장)
            const { names: n } = await names();
            await store.updateEvent(linked.id, { task_id: null }, linked.version);
            kept = ` (이어진 일정 ${eventLine(linked, n)} 은 남기고 연결만 끊었습니다)`;
          }
          return ok(`지웠습니다: ${cur.title}${kept}`, { id, deleted: true });
        }

        const patch: TaskPatch = {};
        if (a.title !== undefined) patch.title = typeof a.title === "string" ? a.title.trim() : a.title;
        if (a.note !== undefined) patch.note = blank(a.note);
        if (a.due !== undefined) patch.due = a.due;
        if (a.est_min !== undefined) patch.est_min = a.est_min;
        if (placeId !== undefined) patch.place_id = placeId;
        // 역할은 명시했을 때만 바꾼다. 단 지점을 바꾸는데 지금 역할이 없으면 지점에서 채운다
        if (roleId !== undefined) patch.role_id = roleId;
        else if (placeId != null && placeId !== cur.place_id && cur.role_id === null) {
          const from = await fromPlace(placeId);
          if (from) patch.role_id = from;
        }
        if (checklist !== undefined) patch.checklist = checklist;
        if (a.done === true && cur.done_at === null) patch.done_at = nowIso;
        if (a.done === false && cur.done_at !== null) patch.done_at = null;
        if (link) {
          patch.due_event_id = link.id;
          if (link.due !== null) patch.due = link.due; // 반복 아닌 일정은 DB 가 일정 날짜로 맞춘다
        } else if (a.due_event === null) {
          patch.due_event_id = null;
        } else if (cur.due_event_id !== null && a.due !== undefined && a.due !== cur.due) {
          // 일정에 딸린 마감을 손으로 바꾸거나 지우면 연결도 끊는다 (DB 는 건 채로 due 만 바꾸는 것을 거절한다)
          patch.due_event_id = null;
        }
        for (const k of Object.keys(patch) as (keyof TaskPatch)[]) if (same(patch[k], cur[k])) delete patch[k];

        // ---- 반복: 규칙에서 온 할 일이면 scope, 아니면 이 할 일을 첫 회차로 규칙을 만든다
        const rule = cur.rule_id ? await store.getRule(cur.rule_id) : null;
        const scope = a.scope ?? "once";
        if (scope === "rule" && !rule) {
          return fail("규칙에서 온 할 일이 아닙니다(또는 규칙이 멈췄습니다) — scope 를 빼거나, repeat 를 줘서 반복을 새로 만드세요", "BAD_INPUT");
        }
        if (rule && scope === "once" && (rep || dueAfter !== undefined)) {
          return fail(
            `반복 규칙(${ruleSummary(rule, new Map(ruleEvent ? [[ruleEvent.id, ruleEvent]] : []))})에서 온 할 일입니다 — repeat · due_after 는 scope: "rule" 로 규칙을 고치거나, rule_id + stop: true 로 멈춘 뒤 새로 만드세요`,
            "BAD_INPUT",
            { rule_id: rule.id },
          );
        }
        if (!rule && !rep && dueAfter !== undefined && dueAfter !== null) {
          return badInput([{ path: "due_after", reason: "due_after 는 repeat 와 같이 쓰거나 규칙을 고칠 때(scope: rule · rule_id) 씁니다" }]);
        }
        const next = { ...cur, ...patch };
        const bad = validateTask(next);
        if (bad.length > 0) return badInput(bad);

        let rulePatch: RulePatch = {};
        if (rule && scope === "rule") {
          const p = ruleRepeatPatch(rule, rep);
          if ("ok" in p) return p;
          rulePatch = p;
          if (a.title !== undefined) rulePatch.title = next.title;
          if (a.note !== undefined) rulePatch.note = next.note;
          if (a.est_min !== undefined) rulePatch.est_min = next.est_min;
          if (placeId !== undefined) rulePatch.place_id = placeId;
          if (roleId !== undefined) rulePatch.role_id = roleId;
          else if (placeId != null && placeId !== rule.place_id && rule.role_id === null) {
            const from = await fromPlace(placeId);
            if (from) rulePatch.role_id = from;
          }
          if (checklist !== undefined) rulePatch.checklist = checklist.map((c) => c.t);
          if (dueAfter !== undefined) rulePatch.due_after = dueAfter;
          for (const k of Object.keys(rulePatch) as (keyof RulePatch)[]) if (same(rulePatch[k], rule[k])) delete rulePatch[k];
        }

        let made: TaskRule | null = null;
        if (!rule && rep) {
          made = await store.insertRule({
            ...ruleShape(next),
            // '일정 끝나면' 규칙: 역할을 안 줬고 할 일에도 없으면 그 일정의 지점에서
            role_id: rep.kind === "event" && roleId === undefined && next.role_id === null ? await fromPlace(ruleEvent!.place_id) : next.role_id,
            kind: rep.kind,
            repeat: rep.kind === "cycle" ? rep.repeat : null,
            start: rep.kind === "cycle" ? today : null,
            event_id: rep.kind === "event" ? rep.event_id : null,
            due_after: dueAfter ?? null,
            last_made: today,
          });
          patch.rule_id = made.id;
          patch.rule_date = today;
          if (next.due === null && next.due_event_id === null && dueAfter != null) patch.due = addDays(today, dueAfter);
        }

        const ruleChanged = Object.keys(rulePatch).length > 0;
        // 작업대: 지금과 다를 때만. 끝내면 DB 가 내린다
        const benchTo = a.bench !== undefined && a.bench !== (cur.bench_order !== null) ? a.bench : undefined;
        if (benchTo === true && (cur.done_at !== null || patch.done_at)) {
          return fail("끝낸 할 일은 작업대에 올릴 수 없습니다 — done: false 로 다시 연 뒤 올리세요", "BAD_INPUT");
        }
        const benchWord = benchTo === undefined ? "" : benchTo ? "작업대에 올렸습니다" : "작업대에서 내렸습니다";
        if (Object.keys(patch).length === 0 && !ruleChanged) {
          if (benchTo === undefined) return ok(`바뀐 것이 없습니다: ${cur.title}`, { changed: false, task: await show(cur, linked) });
          const b = await store.benchTask(id, benchTo);
          if (!b) return lostTask();
          return ok(`${benchWord}: ${b.title}`, { changed: true, task: await show(b, linked) });
        }
        let t: TaskRow | null;
        try {
          t = await store.updateTask(id, patch, cur.version);
        } catch (e) {
          if (made) await store.stopRule(made.id);
          throw e;
        }
        if (!t) {
          if (made) await store.stopRule(made.id);
          return lostTask();
        }
        let ruleNote = "";
        if (made) ruleNote = ` (반복 ${ruleSummary(made, new Map(ruleEvent ? [[ruleEvent.id, ruleEvent]] : []))} — 이 할 일이 첫 회차)`;
        if (rule && ruleChanged) {
          const r = await store.updateRule(rule.id, rulePatch, rule.version);
          ruleNote = r ? " (앞으로 생길 할 일에도 적용)" : " — 단, 규칙은 그 사이 바뀌어 못 고쳤습니다. todo_list(status: rules) 를 보고 rule_id 로 다시 하세요";
        }
        if (benchTo !== undefined) t = (await store.benchTask(id, benchTo)) ?? t;
        const cut = patch.due_event_id === null ? " (일정에 딸린 마감 연결을 끊음)" : "";
        const what = "done_at" in patch ? (patch.done_at ? "끝냈습니다" : "다시 열었습니다") : "고쳤습니다";
        const benchNote = benchWord ? ` · ${benchWord}` : "";
        return ok(`${what}: ${t.title}${ruleNote}${cut}${benchNote}`, { changed: true, task: await show(t, linked) });
      }),
  };
}

export type Schedule = ReturnType<typeof createSchedule>;
