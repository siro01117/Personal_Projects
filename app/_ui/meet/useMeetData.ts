"use client";

// 모임 화면 데이터 (목록 · 모임 한 건이 같이 쓴다): 모임(사람들까지) + 묶음 + 역할 + 지점 + 설정(내 이름), 모임 화면에서는 할 일도.
// 열 때: 담아 둔 것(캐시)이 있으면 그것부터 그리고, 전부 한 차례에 같이 읽는다.
// 저장은 화면 먼저 바꾸고(낙관적) 줄 세워 하나씩 부른다. 실패하면 되돌리고 알린다. 끝나면 새로 읽어 버전을 맞춘다.
//   저장하는 동안에는 뒤에서 온 읽기(30초 · 창 복귀)가 화면을 덮지 않는다.
// 버전 충돌이면 "방금 다른 곳에서 이 모임을 고쳤습니다" + 새로 불러오기.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskRow } from "../../../lib/schedule";
import { KEY, peekAll, type DataCache } from "../../_data/cache";
import { readMeetLists, type MeetLists } from "../../_data/loaders";
import { meetKorean } from "../../_logic/meet";
import { AUTH_MESSAGE, useApp } from "../AppContext";
import { useToast } from "../Toast";

/** tasks = 살아 있는 할 일 전부 (모임 화면이 그 모임에서 나온 것만 고른다). 목록 화면에서는 읽지 않는다 */
export type MeetState = MeetLists & { tasks: TaskRow[] };

const LIST_KEYS = { meets: KEY.meets, circles: KEY.circles, roles: KEY.roles, places: KEY.places, settings: KEY.settings };

/** 담아 둔 것 — 다섯이 다 있을 때만 */
function cached(cache: DataCache): MeetState | null {
  const lists = peekAll<MeetLists>(cache, LIST_KEYS);
  return lists ? { ...lists, tasks: cache.peek<TaskRow[]>(KEY.tasks) ?? [] } : null;
}

const listeners = new Set<() => void>();

/** 화면 밖에서 모임이 바뀌었을 때(지운 뒤 다른 화면에서 되돌리기) 지금 떠 있는 화면이 다시 읽게 한다 */
export function refreshMeets(): void {
  for (const f of [...listeners]) f();
}

export function useMeetData(opts: { tasks?: boolean } = {}) {
  const withTasks = opts.tasks === true;
  const { src, fail, tick } = useApp();
  const toast = useToast();
  const M = src.meet;
  const T = src.planner;
  const S = src.schedule;
  const cache = src.cache;

  const [state, setStateRaw] = useState<MeetState | null>(() => cached(cache));
  const stateRef = useRef<MeetState | null>(state);
  /** 마지막으로 서버에서 읽은 것 — 버전은 여기서 */
  const serverRef = useRef<MeetState | null>(state);
  const seq = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** 아직 안 끝난 저장 수 */
  const saving = useRef(0);

  const setState = useCallback((s: MeetState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  /**
   * 읽는다. 뒤에서 읽는 것(saved = false)은 저장 중이면 하지 않고, 읽는 사이 저장이 시작됐으면 버린다 — 저장이 끝나면 어차피 새로 읽는다.
   * 저장 뒤 읽기(saved = true)는 버전을 늘 맞추고, 뒤에 줄 선 저장이 남았으면 화면은 그대로 둔다(그 저장의 낙관적 모습을 지킨다)
   */
  const load = useCallback(
    async (saved = false): Promise<void> => {
      if (!saved && saving.current > 0) return;
      const n = ++seq.current;
      try {
        const [lists, tasks] = await Promise.all([readMeetLists(M, T, S), withTasks ? T.tasks() : Promise.resolve(null)]);
        if (n !== seq.current) return;
        if (!saved && saving.current > 0) return;
        for (const k of ["meets", "circles", "roles", "places", "settings"] as const) cache.set(LIST_KEYS[k], lists[k]);
        if (tasks) cache.set(KEY.tasks, tasks);
        const next: MeetState = { ...lists, tasks: tasks ?? serverRef.current?.tasks ?? [] };
        serverRef.current = next;
        if (saving.current === 0) setState(next);
      } catch (e) {
        if (n === seq.current) fail(e);
      }
    },
    [M, T, S, cache, fail, setState, withTasks],
  );

  // 처음 + 창이 다시 보일 때(tick) + 화면 밖에서 바뀌었을 때
  useEffect(() => {
    void load();
  }, [load, tick]);
  useEffect(() => {
    const f = () => void load();
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, [load]);

  const onError = useCallback(
    (e: unknown) => {
      const k = meetKorean(e, AUTH_MESSAGE);
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
    <R>(apply: ((s: MeetState) => MeetState) | null, call: (server: MeetState) => Promise<R>): Promise<R | undefined> => {
      const before = stateRef.current;
      if (apply && before) setState(apply(before));
      saving.current++;
      const p = queue.current.then(async () => {
        try {
          return await call(serverRef.current ?? before!);
        } catch (e) {
          if (before) setState(before);
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

  /** 서버에서 읽은 그 모임의 지금 버전 */
  const versionOf = (server: MeetState, id: string, fallback: number) => server.meets.find((m) => m.id === id)?.version ?? fallback;
  /** 서버에서 읽은 그 할 일의 지금 버전 */
  const taskVersion = (server: MeetState, id: string, fallback: number) => server.tasks.find((t) => t.id === id)?.version ?? fallback;

  return { M, T, S, state, ready: state !== null, run, versionOf, taskVersion, onError };
}

export type MeetDataHook = ReturnType<typeof useMeetData>;
