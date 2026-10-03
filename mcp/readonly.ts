// 읽기만 되는 토큰(scope ro)의 스토어 (docs/에이전트-연결.md 2장).
// 쓰는 도구를 등록하지 않는 것(tools.ts)에 더해, 스토어에서도 한 번 더 막는다 — 읽는 메서드만 통과시키고 나머지는 거절한다.
// 읽는 도구가 하는 정리성 쓰기(todo_list 의 반복 회차 만들기 · 역할 기본 셋 넣기)는 건너뛴다(0개 만든 것으로) — 읽기만 되는 토큰은 DB 를 한 줄도 바꾸지 않는다.

import { DbError } from "./errors";
import type { MeetStore } from "./meet-store";
import type { ScheduleStore } from "./schedule-store";
import type { Store } from "./store";

export const STORE_READS = ["owner", "folders", "children", "get", "getReport", "search", "notes", "imageExists", "listImages", "imageSrcs"] as const satisfies readonly (keyof Store)[];

export const SCHEDULE_READS = [
  "owner",
  "places",
  "travel",
  "settings",
  "eventsBetween",
  "getEvent",
  "eventsByIds",
  "eventsForTasks",
  "exceptions",
  "tasks",
  "getTask",
  "workSums",
  "workList",
  "meetRef",
  "rules",
  "getRule",
  "roles",
] as const satisfies readonly (keyof ScheduleStore)[];

/** 읽는 도구가 부르는 정리성 쓰기 — 아무것도 하지 않고 "0개" 를 돌려준다 */
export const SCHEDULE_SKIPS = ["roll", "seedRoles"] as const satisfies readonly (keyof ScheduleStore)[];

export const MEET_READS = ["owner", "circles", "meets", "getMeet"] as const satisfies readonly (keyof MeetStore)[];

export const READ_ONLY_MESSAGE = "[EZ_FORBIDDEN] 읽기만 되는 토큰입니다 — 고치려면 읽고 쓰기 토큰을 만드세요";

function wrap<T extends object>(store: T, reads: readonly string[], skips: readonly string[] = []): T {
  const allow = new Set(reads);
  const skip = new Set(skips);
  return new Proxy(store, {
    get(target, prop) {
      if (typeof prop !== "string") return Reflect.get(target, prop, target);
      if (skip.has(prop)) return async () => 0;
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return allow.has(prop) ? value : undefined;
      if (allow.has(prop)) return value.bind(target);
      return async () => {
        throw new DbError(READ_ONLY_MESSAGE, "P0001");
      };
    },
    set() {
      return false;
    },
  });
}

export const readOnlyStore = (s: Store): Store => wrap(s, STORE_READS);
export const readOnlySchedule = (s: ScheduleStore): ScheduleStore => wrap(s, SCHEDULE_READS, SCHEDULE_SKIPS);
export const readOnlyMeet = (s: MeetStore): MeetStore => wrap(s, MEET_READS);
