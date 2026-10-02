// 화면을 열 때 무엇을 어떤 순서로 읽는지. 한 요청이 0.3초쯤이라(DB 가 멀다) "첫 그림까지 차례로 몇 번"이 체감 속도를 정한다 —
// 서로 기다릴 이유가 없는 것은 전부 한 차례에 같이 보낸다. 차례 수는 requests.test.ts 가 고정한다.

import { addDays, type DateStr, type Place, type Role, type Settings, type TaskRow, type TaskRule, type Travel } from "../../lib/schedule";
import type { Circle, Meet } from "../../lib/meet";
import type { EventRows, MeetData, PlannerData, ScheduleData, SourceInfo, TaskLink } from "./types";

export type PlannerLists = { tasks: TaskRow[]; links: TaskLink[]; rules: TaskRule[]; roles: Role[] };
export type TaskLists = { tasks: TaskRow[]; links: TaskLink[]; rules: TaskRule[] };
export type MetaLists = { places: Place[]; travel: Travel[]; settings: Settings; sources: SourceInfo[] };
export type Now = { date: DateStr; min: number };

export async function readPlannerLists(T: PlannerData): Promise<PlannerLists> {
  const [tasks, links, rules, roles] = await Promise.all([T.tasks(), T.links(), T.rules(), T.roles()]);
  return { tasks, links, rules, roles };
}

export async function readTaskLists(T: PlannerData): Promise<TaskLists> {
  const [tasks, links, rules] = await Promise.all([T.tasks(), T.links(), T.rules()]);
  return { tasks, links, rules };
}

export async function readMeta(S: ScheduleData): Promise<MetaLists> {
  const [places, travel, settings, sources] = await Promise.all([S.places(), S.travel(), S.settings(), S.sources()]);
  return { places, travel, settings, sources };
}

export type MeetLists = { meets: Meet[]; circles: Circle[]; roles: Role[]; places: Place[]; settings: Settings };

/** 모임 열기: 모임(사람들까지) · 묶음 · 역할 · 지점 · 설정(내 이름)을 한 차례에 */
export async function readMeetLists(M: MeetData, T: PlannerData, S: ScheduleData): Promise<MeetLists> {
  const [meets, circles, roles, places, settings] = await Promise.all([M.meets(), M.circles(), T.roles(), S.places(), S.settings()]);
  return { meets, circles, roles, places, settings };
}

/** 월요일 w 로 시작하는 한 주 */
export function readWeek(S: ScheduleData, w: DateStr): Promise<EventRows> {
  return S.events(w, addDays(w, 6));
}

/** 제목을 보여 줄 일정 id — 마감을 딸려 둔 일정 · 규칙이 딸린 일정 */
export function titleIds(tasks: readonly TaskRow[], rules: readonly TaskRule[]): string[] {
  const ids = [...tasks.map((t) => t.due_event_id), ...rules.map((r) => r.event_id)].filter((x): x is string => x !== null);
  return [...new Set(ids)].sort();
}

/** 이미 아는 제목에서 지금 필요한 것만 (새 제목이 오기 전까지 보여 줄 것) */
export function keepTitles(known: Readonly<Record<string, string>>, ids: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) if (known[id] !== undefined) out[id] = known[id];
  return out;
}

/**
 * 규칙 굴리기(roll)와 읽기를 같이 보낸다. 굴려서 할 일이 생겼을 때만(1 이상) 한 번 더 읽는다.
 * 굴리기가 실패해도 읽은 것은 그대로 쓴다. 읽기 실패는 load 가 알린다(여기로 던지지 않게 load 안에서 잡는다)
 */
export async function rollWith<R>(T: PlannerData, at: Now, load: () => Promise<R>): Promise<R> {
  const rolled = T.roll(at.date, at.min).catch(() => 0);
  const first = await load();
  if ((await rolled) > 0) return load();
  return first;
}

/**
 * 플래너 열기: roll 과 목록을 한 차례에. 역할이 하나도 없을 때만 seed(기본 역할 넣기, 넣은 개수)를 부르고,
 * 굴리거나 넣어서 달라진 게 있을 때만 다시 읽는다. load 는 읽은 목록(실패면 null)을 돌려준다
 */
export async function openPlanner(T: PlannerData, at: Now, load: () => Promise<{ roles: readonly unknown[] } | null>, seed: () => Promise<number>): Promise<void> {
  const rolled = T.roll(at.date, at.min).catch(() => 0);
  const first = await load();
  let again = (await rolled) > 0;
  if (first && first.roles.length === 0) again = (await seed().catch(() => 0)) > 0 || again;
  if (again) await load();
}

/** 이웃 주 (한 칸씩만 미리 읽는다) */
export function neighbors(week: DateStr): [DateStr, DateStr] {
  return [addDays(week, -7), addDays(week, 7)];
}

/** 미리 읽어 둔 이웃 주를 다시 읽을 때가 됐는지 */
export const PREFETCH_MAX_AGE_MS = 5 * 60_000;
export function needsPrefetch(at: number | undefined, now: number): boolean {
  return at === undefined || now - at > PREFETCH_MAX_AGE_MS;
}
