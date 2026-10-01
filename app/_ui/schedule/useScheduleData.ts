"use client";

// 일정 화면 데이터: 지점·이동시간·설정·출처(메타) + 보는 주의 일정 줄 + 할 일.
// 저장은 화면 먼저 바꾸고(낙관적) 줄 세워 하나씩 부른다. 실패하면 되돌리고 알린다. 끝나면 새로 읽어 버전을 맞춘다.
// 버전 충돌이면 "방금 다른 곳에서 이 일정을 고쳤습니다" + 새로 불러오기.

import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, DEFAULT_SETTINGS, type DateStr, type EventRow, type Place, type Settings, type TaskRow, type Travel } from "../../../lib/schedule";
import type { EventRows, SourceInfo, TaskLink } from "../../_data/types";
import { scheduleKorean } from "../../_logic/schedule";
import { AUTH_MESSAGE, useApp } from "../AppContext";
import { useToast } from "../Toast";

export type Meta = { places: Place[]; travel: Travel[]; settings: Settings; sources: SourceInfo[] };

const EMPTY: EventRows = { events: [], exceptions: [] };

export function useScheduleData(week: DateStr) {
  const { src, fail, tick } = useApp();
  const toast = useToast();
  const S = src.schedule;
  const T = src.planner;

  const [meta, setMeta] = useState<Meta | null>(null);
  const [rows, setRowsState] = useState<EventRows | null>(null);
  /** rows 가 어느 주를 읽은 것인지 */
  const [loadedFor, setLoadedFor] = useState<DateStr | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [links, setLinks] = useState<TaskLink[]>([]);
  /** 화면에 보이는 줄 (낙관적 반영 포함) */
  const rowsRef = useRef<EventRows>(EMPTY);
  /** 마지막으로 서버에서 읽은 줄 — 버전은 여기서 */
  const serverRef = useRef<EventRows>(EMPTY);
  const weekRef = useRef(week);
  weekRef.current = week;
  const seq = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const setRows = useCallback((r: EventRows) => {
    rowsRef.current = r;
    setRowsState(r);
  }, []);

  const onError = useCallback(
    (e: unknown, reload: () => void) => {
      const k = scheduleKorean(e, AUTH_MESSAGE);
      if (k.code === "AUTH") fail(e);
      else if (k.code === "EZ_VERSION") toast(k.message, { label: "새로 불러오기", run: reload });
      else toast(k.message);
    },
    [fail, toast],
  );

  const loadMeta = useCallback(async () => {
    try {
      const [places, travel, settings, sources] = await Promise.all([S.places(), S.travel(), S.settings(), S.sources()]);
      setMeta({ places, travel, settings, sources });
    } catch (e) {
      fail(e);
      setMeta((m) => m ?? { places: [], travel: [], settings: DEFAULT_SETTINGS, sources: [] });
    }
  }, [S, fail]);

  const loadWeek = useCallback(async () => {
    const n = ++seq.current;
    const w = weekRef.current;
    try {
      const r = await S.events(w, addDays(w, 6));
      if (n !== seq.current) return;
      serverRef.current = r;
      setRows(r);
      setLoadedFor(w);
    } catch (e) {
      if (n === seq.current) fail(e);
    }
  }, [S, fail, setRows]);

  const loadTasks = useCallback(async () => {
    try {
      const [t, l] = await Promise.all([T.tasks(), T.links()]);
      setTasks(t);
      setLinks(l);
    } catch (e) {
      fail(e);
    }
  }, [T, fail]);

  const reload = useCallback(async () => {
    await Promise.all([loadMeta(), loadWeek(), loadTasks()]);
  }, [loadMeta, loadWeek, loadTasks]);

  // 처음 + 창이 다시 보일 때(tick)
  useEffect(() => {
    void loadMeta();
    void loadTasks();
  }, [loadMeta, loadTasks, tick]);
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
      const p = queue.current.then(async () => {
        try {
          return await call(serverRef.current);
        } catch (e) {
          setRows(before);
          onError(e, () => void reload());
          return undefined;
        } finally {
          await Promise.all([loadWeek(), loadTasks()]);
        }
      });
      queue.current = p.catch(() => {});
      return p;
    },
    [setRows, onError, reload, loadWeek, loadTasks],
  );

  /** 서버 줄의 지금 버전 */
  const versionOf = useCallback((id: string): number => serverRef.current.events.find((e) => e.id === id)?.version ?? 0, []);

  /** 할 일 쪽 저장 (끝냄 등). 실패하면 알림 */
  const runTask = useCallback(
    async <R>(call: () => Promise<R>): Promise<R | undefined> => {
      try {
        return await call();
      } catch (e) {
        onError(e, () => void reload());
        return undefined;
      } finally {
        await loadTasks();
      }
    },
    [onError, reload, loadTasks],
  );

  /** 지점 · 이동시간 · 설정 쪽 저장. 실패하면 알림 후 다시 읽기 */
  const runMeta = useCallback(
    async <R>(apply: ((m: Meta) => Meta) | null, call: () => Promise<R>): Promise<R | undefined> => {
      if (apply) setMeta((m) => (m ? apply(m) : m));
      try {
        return await call();
      } catch (e) {
        onError(e, () => void reload());
        return undefined;
      } finally {
        await loadMeta();
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
