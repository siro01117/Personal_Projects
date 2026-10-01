"use client";

// 알림 한 줄 (목업 .toast). 한 번에 하나. 되돌리기 같은 동작 버튼을 하나 붙일 수 있다.

import { Presence } from "./motion/Presence";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastAction = { label: string; run: () => void };
export type ToastFn = (message: string, action?: ToastAction, ms?: number) => void;

const Ctx = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ message: string; action?: ToastAction; key: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback<ToastFn>((message, action, ms) => {
    clearTimeout(timer.current);
    setState({ message, action, key: Date.now() });
    timer.current = setTimeout(() => setState(null), ms ?? (action ? 5000 : 1800));
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const value = useMemo(() => toast, [toast]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <Presence>
        {state && (
        <div className="toast" role="status" key={state.key}>
          <span>{state.message}</span>
          {state.action && (
            <button
              type="button"
              onClick={() => {
                const run = state.action!.run;
                clearTimeout(timer.current);
                setState(null);
                run();
              }}
            >
              {state.action.label}
            </button>
          )}
        </div>
        )}
      </Presence>
    </Ctx.Provider>
  );
}
