"use client";

// 나 (ez_me — docs/회원.md 4장 '공통'). 로그인을 확인한 뒤 한 번 읽는다. 담아 둔 것이 있으면 그것으로 먼저 그리고 뒤에서 새로 읽는다
// (다른 모듈과 같은 캐시 규칙). 첫 그림을 나 때문에 기다리게 하지 않는다 — 모르는 동안은 추가 모듈 없이 그린다.
// 켜기 · 끄기는 낙관적: 화면을 먼저 바꾸고 저장한다. 실패하면 다시 읽어 되돌린다.

import { useCallback, useEffect, useRef, useState } from "react";
import { toKorean } from "../../lib/errors";
import { togglePicked, type Me } from "../../lib/members";
import { KEY } from "../_data/cache";
import type { Source } from "../_data/types";

export type MeState = {
  /** 아직 모르면 null */
  me: Me | null;
  /** 추가 모듈 하나 켜기 · 끄기 */
  setPicked: (key: string, on: boolean) => void;
  /** 다시 읽기 (관리 화면에서 모듈을 더하고 지운 뒤) */
  reloadMe: () => void;
};

export function useMe(src: Source | null, ready: boolean, fail: (err: unknown) => void, tick = 0): MeState {
  const [me, setMe] = useState<Me | null>(() => (src ? (src.cache.peek<Me>(KEY.me) ?? null) : null));
  const meRef = useRef(me);
  meRef.current = me;
  /** 켜기 · 끄기 차례 — 늦게 온 옛 답이 새 상태를 덮지 않게 */
  const seq = useRef(0);
  const failRef = useRef(fail);
  failRef.current = fail;

  const read = useCallback(() => {
    if (!src) return;
    const mine = seq.current;
    src.me.me().then(
      (v) => {
        if (seq.current === mine) setMe(v);
      },
      // 못 읽으면 추가 모듈 없이 그대로 둔다 (알릴 것은 로그인 풀림뿐)
      (e) => toKorean(e).code === "AUTH" && failRef.current(e),
    );
  }, [src]);

  useEffect(() => {
    if (!ready || !src) return;
    read();
    // 뒤에서 새로 읽은 값이 담아 둔 것과 다르면
    return src.cache.subscribe((key) => key === KEY.me && read());
  }, [ready, src, read, tick]);

  const setPicked = useCallback(
    (key: string, on: boolean) => {
      const cur = meRef.current;
      if (!src || !cur) return;
      const next = togglePicked(cur, key, on);
      const mine = ++seq.current;
      const optimistic = { ...cur, picked: next };
      meRef.current = optimistic;
      setMe(optimistic);
      src.me.setPicked(next).then(
        (saved) => {
          if (seq.current === mine) setMe((m) => (m ? { ...m, picked: saved } : m));
        },
        (e) => {
          failRef.current(e);
          if (seq.current !== mine) return;
          src.cache.drop(KEY.me);
          read();
        },
      );
    },
    [src, read],
  );

  const reloadMe = useCallback(() => {
    if (!src) return;
    src.cache.drop(KEY.me);
    read();
  }, [src, read]);

  return { me, setPicked, reloadMe };
}
