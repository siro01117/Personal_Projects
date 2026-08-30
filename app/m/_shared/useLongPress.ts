// 터치 꾹누르기(long-press) = 데스크톱 우클릭 대체.
// 요소에 bind(payload) 핸들러를 펼치고, onClick 맨 앞에서 consumed()로 방금 롱프레스면 클릭 무시.
import { useRef } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

export function useLongPress<T>(
  onLongPress: (payload: T, x: number, y: number) => void,
  { ms = 500, moveTol = 12 }: { ms?: number; moveTol?: number } = {},
) {
  const cb = useRef(onLongPress);
  cb.current = onLongPress; // 매 렌더 최신값 유지(stale 방지)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  };

  const bind = (payload: T) => ({
    onTouchStart: (e: ReactTouchEvent) => {
      if (e.touches.length !== 1) { clear(); return; } // 두 손가락(핀치)이면 취소
      const t = e.touches[0];
      startPos.current = { x: t.clientX, y: t.clientY };
      fired.current = false;
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        if (startPos.current) cb.current(payload, startPos.current.x, startPos.current.y);
      }, ms);
    },
    onTouchMove: (e: ReactTouchEvent) => {
      const t = e.touches[0];
      if (startPos.current && (Math.abs(t.clientX - startPos.current.x) > moveTol || Math.abs(t.clientY - startPos.current.y) > moveTol)) clear();
    },
    onTouchEnd: () => clear(),
    onTouchCancel: () => clear(),
  });

  const consumed = () => { const f = fired.current; fired.current = false; return f; };

  return { bind, consumed };
}
