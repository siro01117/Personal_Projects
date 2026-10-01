"use client";

// 일정 화면 데이터: 지점·이동시간·설정·출처(메타) + 보는 주의 일정 줄 + 할 일 + 반복 규칙(끝나면 할 일).
// 열 때: 담아 둔 것(캐시)이 있으면 그것부터 그리고, 메타 · 그 주 · 규칙 굴리기(roll) · 할 일을 한 차례에 같이 보낸다.
//   굴려서 할 일이 생겼을 때만 할 일을 다시 읽는다. 주는 주마다 따로 담고, 이웃 주(앞 · 뒤 한 칸)를 미리 읽어 둔다 — ‹ › 가 바로 바뀐다.
// 저장은 화면 먼저 바꾸고(낙관적) 줄 세워 하나씩 부른다. 실패하면 되돌리고 알린다. 끝나면 새로 읽어 버전을 맞춘다.
//   저장하는 동안에는 뒤에서 온 읽기(30초 · 창 복귀)가 화면을 덮지 않는다.
// 버전 충돌이면 "방금 다른 곳에서 이 일정을 고쳤습니다" + 새로 불러오기.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type DateStr, type EventRow, type Place, type Settings, type TaskRow, type TaskRule, type Travel } from "../../../lib/schedule";
import { KEY, peekAll } from "../../_data/cache";
import { needsPrefetch, neighbors, readMeta, readTaskLists, readWeek, rollWith, type TaskLists } from "../../_data/loaders";
import type { EventRows, PlannerData, SourceInfo, TaskLink } from "../../_data/types";
import { nowIn, scheduleKorean } from "../../_logic/schedule";
import { AUTH_MESSAGE, useApp } from "../AppContext";
import { useToast } from "../Toast";

export type Meta = { places: Place[]; travel: Travel[]; settings: Settings; sources: SourceInfo[] };

const EMPTY: EventRows = { events: [], exceptions: [] };
const META_KEYS = { places: KEY.places, travel: KEY.travel, settings: KEY.settings, sources: KEY.sources };
const TASK_KEYS = { tasks: KEY.tasks, links: KEY.links, rules: KEY.rules };

export function useScheduleData(week: DateStr) {
  const { src, fail, tick } = useApp();
  const toast = useToast();
  const S = src.schedule;
  const rawT = src.planner;
  const cache = src.cache;

  const [meta, setMeta] = useState<Meta | null>(() => peekAll<Meta>(cache, META_KEYS));
  const [rows, setRowsState] = useState<EventRows | null>(() => cache.peek<EventRows>(KEY.week(week)) ?? null);
  /** rows 가 어느 주를 읽은 것인지 */
  const [loadedFor, setLoadedFor] = useState<DateStr | null>(() => (rows ? week : null));
  const [taskLists] = useState(() => peekAll<TaskLists>(cache, TASK_KEYS));
  const [tasks, setTasks] = useState<TaskRow[]>(taskLists?.tasks ?? []);
  const [links, setLinks] = useState<TaskLink[]>(taskLists?.links ?? []);
  const [rules, setRules] = useState<TaskRule[]>(taskLists?.rules ?? []);
  /** 화면에 보이는 줄 (낙관적 반영 포함) */
  const rowsRef = useRef<EventRows>(rows ?? EMPTY);
  /** 마지막으로 서버에서 읽은 줄 — 버전은 여기서 */
  const serverRef = useRef<EventRows>(rows ?? EMPTY);
  const weekRef = useRef(week);
  weekRef.current = week;
  const seq = useRef(0);
  const taskSeq = useRef(0);
  const metaSeq = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** 아직 안 끝난 저장 수 (일정 · 할 일 · 메타) */
  const saving = useRef(0);
  const taskSaving = useRef(0);
  const metaSaving = useRef(0);
  /** 저장이 시작되거나 끝날 때마다 오른다 — 그 전에 떠난 읽기의 답은 캐시에 담지 않는다 (저장 전 모습일 수 있다) */
  const gen = useRef(0);
  const prefetching = useRef(new Set<DateStr>());

  const setRows = useCallback((r: EventRows) => {
    rowsRef.current = r;
    setRowsState(r);
  }, []);

  // 주를 옮길 때: 담아 둔 주면 그 자리에서 바꾼다 (그리는 도중에 맞춘다 — 앞 주 줄이 새 주 자리에 한 번 그려지지 않게)
  const [seenWeek, setSeenWeek] = useState(week);
  if (seenWeek !== week) {
    setSeenWeek(week);
    const hit = saving.current === 0 ? cache.peek<EventRows>(KEY.week(week)) : undefined;
    if (hit) {
      rowsRef.current = hit;
      serverRef.current = hit;
      setRowsState(hit);
      setLoadedFor(week);
    }
  }

  const onError = useCallback(
    (e: unknown, reload: () => void) => {
      const k = scheduleKorean(e, AUTH_MESSAGE);
      if (k.code === "AUTH") fail(e);
      else if (k.code === "EZ_VERSION") toast(k.message, { label: "새로 불러오기", run: reload });
      else toast(k.message);
    },
    [fail, toast],
  );

  // 아래 읽기들: saved = 저장 뒤 읽기. 뒤에서 읽는 것(saved = false)은 저장 중이면 하지 않고, 읽는 사이 저장이 시작됐으면 버린다 —
  // 저장이 끝나면 어차피 새로 읽는다. 저장 뒤 읽기는 뒤에 다른 저장이 남았으면 화면은 그대로 둔다(그 저장의 낙관적 모습을 지킨다)

  const loadMeta = useCallback(
    async (saved = false) => {
      if (!saved && metaSaving.current > 0) return;
      const n = ++metaSeq.current;
      const g = gen.current;
      try {
        const m = await readMeta(S);
        if (n !== metaSeq.current || metaSaving.current > 0) return;
        if (g === gen.current) for (const k of ["places", "travel", "settings", "sources"] as const) cache.set(META_KEYS[k], m[k]);
        setMeta(m);
      } catch (e) {
        if (n !== metaSeq.current) return;
        fail(e);
        setMeta((m) => m ?? { places: [], travel: [], settings: DEFAULT_SETTINGS, sources: [] });
      }
    },
    [S, cache, fail],
  );

  /** 이웃 주를 미리 읽어 둔다 (없거나 오래됐을 때만, 한 칸씩) */
  const prefetch = useCallback(
    (w: DateStr) => {
      for (const nb of neighbors(w)) {
        if (prefetching.current.has(nb) || !needsPrefetch(cache.get(KEY.week(nb))?.at, Date.now())) continue;
        prefetching.current.add(nb);
        const g = gen.current;
        readWeek(S, nb)
          .then(
            (r) => {
              if (g === gen.current) cache.set(KEY.week(nb), r);
            },
            () => {},
          )
          .finally(() => prefetching.current.delete(nb));
      }
    },
    [S, cache],
  );

  const loadWeek = useCallback(
    async (saved = false) => {
      if (!saved && saving.current > 0) return;
      const n = ++seq.current;
      const g = gen.current;
      const w = weekRef.current;
      try {
        const r = await readWeek(S, w);
        if (g === gen.current) cache.set(KEY.week(w), r);
        if (n !== seq.current) return;
        if (!saved && saving.current > 0) return;
        serverRef.current = r;
        if (saving.current > 0) return;
        setRows(r);
        setLoadedFor(w);
        prefetch(w);
      } catch (e) {
        if (n === seq.current) fail(e);
      }
    },
    [S, cache, fail, setRows, prefetch],
  );

  const loadTasks = useCallback(
    async (saved = false) => {
      if (!saved && taskSaving.current > 0) return;
      const n = ++taskSeq.current;
      const g = gen.current;
      try {
        const l = await readTaskLists(rawT);
        if (n !== taskSeq.current || taskSaving.current > 0) return;
        if (g === gen.current) for (const k of ["tasks", "links", "rules"] as const) cache.set(TASK_KEYS[k], l[k]);
        setTasks(l.tasks);
        setLinks(l.links);
        setRules(l.rules);
      } catch (e) {
        if (n === taskSeq.current) fail(e);
      }
    },
    [rawT, cache, fail],
  );

  const reload = useCallback(async () => {
    await Promise.all([loadMeta(), loadWeek(), loadTasks()]);
  }, [loadMeta, loadWeek, loadTasks]);

  // 처음 + 창이 다시 보일 때(tick): 메타 · 굴리기 · 할 일을 같이 보낸다.
  // 굴려서 할 일이 생겼을 때만 다시 읽는다. 굴리기가 실패해도 읽은 것은 쓴다(읽기가 실패하면 거기서 알린다)
  useEffect(() => {
    void loadMeta();
    void rollWith(rawT, nowIn(DEFAULT_SETTINGS.tz), () => loadTasks());
  }, [rawT, loadMeta, loadTasks, tick]);
  useEffect(() => {
    void loadWeek();
  }, [loadWeek, week, tick]);

  /**
   * 저장 하나. apply 로 화면을 먼저 바꾸고, call 을 줄 세워 부른다. 실패하면 되돌리고 알림.
   * call 은 부를 때의 서버 줄(버전)을 받는다. 결과는 call 의 값, 실패면 undefined
   */
  const run = useCallback(
    <R>(apply: ((r: EventRows) => EventRows) | null, call: (server: EventRows) => Promise<R>): Promise<R | undefined> => {
      const before = rowsRef.current;
      if (apply) setRows(apply(before));
      saving.current++;
      taskSaving.current++;
      gen.current++;
      const p = queue.current.then(async () => {
        try {
          return await call(serverRef.current);
        } catch (e) {
          setRows(before);
          onError(e, () => void reload());
          return undefined;
        } finally {
          saving.current--;
          taskSaving.current--;
          gen.current++;
          // 일정 하나가 다른 주에도 걸친다(반복 · 옮기기) — 담아 둔 다른 주는 버리고 이웃 주는 다시 미리 읽는다
          cache.drop(KEY.weeks);
          await Promise.all([loadWeek(true), loadTasks(true)]);
        }
      });
      queue.current = p.catch(() => {});
      return p;
    },
    [setRows, onError, reload, loadWeek, loadTasks, cache],
  );

  /** 서버 줄의 지금 버전 */
  const versionOf = useCallback((id: string): number => serverRef.current.events.find((e) => e.id === id)?.version ?? 0, []);

  /** 할 일 쪽 저장 (끝냄 등). 실패하면 알림 */
  const runTask = useCallback(
    async <R>(call: () => Promise<R>): Promise<R | undefined> => {
      taskSaving.current++;
      gen.current++;
      try {
        return await call();
      } catch (e) {
        onError(e, () => void reload());
        return undefined;
      } finally {
        taskSaving.current--;
        gen.current++;
        await loadTasks(true);
      }
    },
    [onError, reload, loadTasks],
  );

  // 끝냄 표시는 누르는 즉시 화면에 (runTask 안에서 부른다 — 실패하면 runTask 가 다시 읽어 되돌린다)
  const T = useMemo<PlannerData>(
    () =>
      new Proxy(rawT, {
        get(target, prop) {
          if (prop === "setDone") {
            return (id: string, baseVersion: number, done: boolean) => {
              const at = done ? new Date().toISOString() : null;
              setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, done_at: at } : t)));
              return target.setDone(id, baseVersion, done);
            };
          }
          const v: unknown = Reflect.get(target, prop, target);
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }),
    [rawT],
  );

  /** 지점 · 이동시간 · 설정 쪽 저장. 실패하면 알림 후 다시 읽기 */
  const runMeta = useCallback(
    async <R>(apply: ((m: Meta) => Meta) | null, call: () => Promise<R>): Promise<R | undefined> => {
      if (apply) setMeta((m) => (m ? apply(m) : m));
      metaSaving.current++;
      gen.current++;
      try {
        return await call();
      } catch (e) {
        onError(e, () => void reload());
        return undefined;
      } finally {
        metaSaving.current--;
        gen.current++;
        await loadMeta(true);
      }
    },
    [onError, reload, loadMeta],
  );

  return {
    S,
    T,
    meta,
    rows: rows ?? EMPTY,
    /** 처음 읽기가 끝남 (주를 옮기는 동안은 앞 주 줄을 그대로 둔다) */
    ready: rows !== null && meta !== null,
    /** 지금 주를 읽음 */
    loaded: rows !== null && meta !== null && loadedFor === week,
    tasks,
    links,
    rules,
    setLinks,
    run,
    runTask,
    runMeta,
    versionOf,
    reload,
    serverEvent: (id: string): EventRow | undefined => serverRef.current.events.find((e) => e.id === id),
  };
}

export type ScheduleDataHook = ReturnType<typeof useScheduleData>;
