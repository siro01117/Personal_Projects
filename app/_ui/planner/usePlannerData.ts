"use client";

// 플래너 화면 데이터: 할 일 + 이어진 일정 + 반복 규칙 + 딸린 일정 제목 + 역할 + 지점.
// 열 때 기본 역할을 넣고(seed — 역할이 하나도 없을 때만), 열 때와 창이 다시 보일 때 규칙을 굴린 뒤(roll — 때가 된 반복 할 일을 만든다) 목록을 읽는다.
// 저장은 화면 먼저 바꾸고(낙관적) 줄 세워 하나씩 부른다. 실패하면 되돌리고 알린다. 끝나면 새로 읽어 버전을 맞춘다.
// 버전 충돌이면 "방금 다른 곳에서 이 할 일을 고쳤습니다" + 새로 불러오기.

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type Place, type Role, type TaskRow, type TaskRule } from "../../../lib/schedule";
import type { PlannerData as PlannerDataSource, TaskLink } from "../../_data/types";
import { plannerKorean } from "../../_logic/planner";
import { nowIn } from "../../_logic/schedule";
import { AUTH_MESSAGE, useApp } from "../AppContext";
import { useToast } from "../Toast";

/** titles = 마감을 딸려 둔 일정 · 규칙이 딸린 일정의 제목 (id → 제목) */
export type PlannerState = { tasks: TaskRow[]; links: TaskLink[]; rules: TaskRule[]; roles: Role[]; titles: Record<string, string> };

const EMPTY: PlannerState = { tasks: [], links: [], rules: [], roles: [], titles: {} };

export function usePlannerData() {
  const { src, fail, tick } = useApp();
  const toast = useToast();
  const T = src.planner;
  const S = src.schedule;

  const [state, setStateRaw] = useState<PlannerState | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const stateRef = useRef<PlannerState>(EMPTY);
  /** 마지막으로 서버에서 읽은 것 — 버전은 여기서 */
  const serverRef = useRef<PlannerState>(EMPTY);
  const seq = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const setState = useCallback((s: PlannerState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [tasks, links, rules, roles] = await Promise.all([T.tasks(), T.links(), T.rules(), T.roles()]);
      const ids = [...tasks.map((t) => t.due_event_id), ...rules.map((r) => r.event_id)].filter((x): x is string => x !== null);
      const titles = ids.length > 0 ? await T.eventTitles(ids) : {};
      if (n !== seq.current) return;
      const next = { tasks, links, rules, roles, titles };
      serverRef.current = next;
      setState(next);
    } catch (e) {
      if (n === seq.current) fail(e);
    }
  }, [T, fail, setState]);

  // 처음 + 창이 다시 보일 때(tick): 기본 역할 넣기(처음 한 번) → 규칙 굴리기 → 읽기.
  // 앞의 둘이 실패해도 목록은 읽는다(읽기가 실패하면 거기서 알린다)
  const seeded = useRef<PlannerDataSource | null>(null);
  useEffect(() => {
    let alive = true;
    const at = nowIn(DEFAULT_SETTINGS.tz);
    const seed = seeded.current === T ? Promise.resolve(0) : T.seedRoles().catch(() => 0);
    seeded.current = T;
    seed
      .then(() => T.roll(at.date, at.min))
      .catch(() => 0)
      .then(() => {
        if (alive) void load();
      });
    S.places().then(
      (p) => alive && setPlaces(p),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [T, S, load, tick]);

  const onError = useCallback(
    (e: unknown) => {
      const k = plannerKorean(e, AUTH_MESSAGE);
      if (k.code === "AUTH") fail(e);
      else if (k.code === "EZ_VERSION") toast(k.message, { label: "새로 불러오기", run: () => void load() });
      else toast(k.message);
    },
    [fail, toast, load],
  );

  /**
   * 저장 하나. apply 로 화면을 먼저 바꾸고, call 을 줄 세워 부른다. 실패하면 되돌리고 알림.
   * call 은 부를 때의 서버 상태(버전)를 받는다. 결과는 call 의 값, 실패면 undefined
   */
  const run = useCallback(
    <R>(apply: ((s: PlannerState) => PlannerState) | null, call: (server: PlannerState) => Promise<R>): Promise<R | undefined> => {
      const before = stateRef.current;
      if (apply) setState(apply(before));
      const p = queue.current.then(async () => {
        try {
          return await call(serverRef.current);
        } catch (e) {
          setState(before);
          onError(e);
          return undefined;
        } finally {
          await load();
        }
      });
      queue.current = p.catch(() => {});
      return p;
    },
    [setState, onError, load],
  );

  /** 서버에서 읽은 그 할 일의 지금 버전 */
  const versionOf = (server: PlannerState, id: string, fallback: number) => server.tasks.find((t) => t.id === id)?.version ?? fallback;

  return { T, S, state, places, ready: state !== null, run, versionOf, reload: load };
}

export type PlannerDataHook = ReturnType<typeof usePlannerData>;
