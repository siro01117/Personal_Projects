"use client";

// 플래너 화면 데이터: 할 일 + 이어진 일정 + 반복 규칙 + 딸린 일정 제목 + 역할 + 지점.
// 열 때: 담아 둔 것(캐시)이 있으면 그것부터 그리고, 규칙 굴리기(roll)와 목록 읽기를 한 차례에 같이 보낸다.
//   굴려서 할 일이 생겼을 때만 다시 읽고, 역할이 하나도 없을 때만 기본 역할을 넣는다(seed). 일정 제목은 그린 뒤에 채운다.
// 저장은 화면 먼저 바꾸고(낙관적) 줄 세워 하나씩 부른다. 실패하면 되돌리고 알린다. 끝나면 새로 읽어 버전을 맞춘다.
//   저장하는 동안에는 뒤에서 온 읽기(30초 · 창 복귀)가 화면을 덮지 않는다.
// 버전 충돌이면 "방금 다른 곳에서 이 할 일을 고쳤습니다" + 새로 불러오기.

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type Place, type Role, type TaskRow, type TaskRule } from "../../../lib/schedule";
import { KEY, peekAll, type DataCache } from "../../_data/cache";
import { keepTitles, openPlanner, readPlannerLists, titleIds, type PlannerLists } from "../../_data/loaders";
import type { PlannerData as PlannerDataSource, TaskLink } from "../../_data/types";
import { plannerKorean } from "../../_logic/planner";
import { nowIn } from "../../_logic/schedule";
import { AUTH_MESSAGE, useApp } from "../AppContext";
import { useToast } from "../Toast";

/** titles = 마감을 딸려 둔 일정 · 규칙이 딸린 일정의 제목 (id → 제목) */
export type PlannerState = { tasks: TaskRow[]; links: TaskLink[]; rules: TaskRule[]; roles: Role[]; titles: Record<string, string> };

const EMPTY: PlannerState = { tasks: [], links: [], rules: [], roles: [], titles: {} };

/** 담아 둔 것 — 목록 넷이 다 있을 때만 */
function cached(cache: DataCache): PlannerState | null {
  const lists = peekAll<PlannerLists>(cache, { tasks: KEY.tasks, links: KEY.links, rules: KEY.rules, roles: KEY.roles });
  return lists ? { ...lists, titles: cache.peek<Record<string, string>>(KEY.titles) ?? {} } : null;
}

export function usePlannerData() {
  const { src, fail, tick } = useApp();
  const toast = useToast();
  const T = src.planner;
  const S = src.schedule;
  const cache = src.cache;

  const [state, setStateRaw] = useState<PlannerState | null>(() => cached(cache));
  const [places, setPlaces] = useState<Place[]>(() => cache.peek<Place[]>(KEY.places) ?? []);
  const stateRef = useRef<PlannerState>(state ?? EMPTY);
  /** 마지막으로 서버에서 읽은 것 — 버전은 여기서 */
  const serverRef = useRef<PlannerState>(state ?? EMPTY);
  const seq = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** 아직 안 끝난 저장 수 */
  const saving = useRef(0);

  const setState = useCallback((s: PlannerState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  /**
   * 목록을 읽는다. 읽은 목록(실패 · 버려짐이면 null).
   * 뒤에서 읽는 것(saved = false)은 저장 중이면 하지 않고, 읽는 사이 저장이 시작됐으면 버린다 — 저장이 끝나면 어차피 새로 읽는다.
   * 저장 뒤 읽기(saved = true)는 버전을 늘 맞추고, 뒤에 줄 선 저장이 남았으면 화면은 그대로 둔다(그 저장의 낙관적 모습을 지킨다)
   */
  const load = useCallback(
    async (saved = false): Promise<PlannerLists | null> => {
      if (!saved && saving.current > 0) return null;
      const n = ++seq.current;
      try {
        const lists = await readPlannerLists(T);
        if (n !== seq.current) return null;
        if (!saved && saving.current > 0) return null;
        cache.set(KEY.tasks, lists.tasks);
        cache.set(KEY.links, lists.links);
        cache.set(KEY.rules, lists.rules);
        cache.set(KEY.roles, lists.roles);
        // 제목은 첫 그림을 막지 않는다 — 아는 제목으로 먼저 그리고 뒤에서 채운다
        const ids = titleIds(lists.tasks, lists.rules);
        const next: PlannerState = { ...lists, titles: keepTitles(serverRef.current.titles, ids) };
        serverRef.current = next;
        if (saving.current === 0) setState(next);
        if (ids.length === 0) cache.set(KEY.titles, {});
        else {
          void T.eventTitles(ids).then(
            (titles) => {
              if (n !== seq.current) return;
              cache.set(KEY.titles, titles);
              serverRef.current = { ...serverRef.current, titles };
              setState({ ...stateRef.current, titles });
            },
            () => {},
          );
        }
        return lists;
      } catch (e) {
        if (n === seq.current) fail(e);
        return null;
      }
    },
    [T, cache, fail, setState],
  );

  // 처음 + 창이 다시 보일 때(tick): 굴리기 · 목록 · 지점을 한 차례에 같이.
  // 굴리기 · 기본 역할 넣기가 실패해도 목록은 읽는다(읽기가 실패하면 거기서 알린다)
  const seeded = useRef<PlannerDataSource | null>(null);
  useEffect(() => {
    let alive = true;
    // 기본 역할 넣기는 역할이 비어 있을 때, 화면당 한 번만
    const seed = async () => {
      if (seeded.current === T) return 0;
      seeded.current = T;
      return T.seedRoles();
    };
    void openPlanner(T, nowIn(DEFAULT_SETTINGS.tz), () => (alive ? load() : Promise.resolve(null)), seed);
    S.places().then(
      (p) => {
        cache.set(KEY.places, p);
        if (alive) setPlaces(p);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [T, S, cache, load, tick]);

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
      saving.current++;
      const p = queue.current.then(async () => {
        try {
          return await call(serverRef.current);
        } catch (e) {
          setState(before);
          onError(e);
          return undefined;
        } finally {
          saving.current--;
          await load(true);
        }
      });
      queue.current = p.catch(() => {});
      return p;
    },
    [setState, onError, load],
  );

  /** 서버에서 읽은 그 할 일의 지금 버전 */
  const versionOf = (server: PlannerState, id: string, fallback: number) => server.tasks.find((t) => t.id === id)?.version ?? fallback;

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  return { T, S, state, places, ready: state !== null, run, versionOf, reload };
}

export type PlannerDataHook = ReturnType<typeof usePlannerData>;
