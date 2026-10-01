"use client";

// 흑백 토글 (Aurora 고정 사양). 기본은 시스템 설정을 따르고, 누르면 반대로 바꿔 기기에 기억한다.
// 저장 키는 layout.tsx 의 첫 페인트 스크립트와 같다.

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { reducedMotion } from "./motion/motion";

const KEY = "ezwork.theme";
let animTimer: ReturnType<typeof setTimeout> | undefined;

function currentIsDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(currentIsDark());
    // 선택하지 않은 동안에는 시스템 설정이 바뀌면 아이콘도 따라간다
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(currentIsDark());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function toggle() {
    const next = currentIsDark() ? "light" : "dark";
    const root = document.documentElement;
    // 색만 0.2초 동안 바뀐다 (docs/모션.md)
    if (!reducedMotion()) {
      root.classList.add("theme-anim");
      clearTimeout(animTimer);
      animTimer = setTimeout(() => root.classList.remove("theme-anim"), 240);
    }
    root.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* 저장이 막혀도 이번 화면에서는 바뀐다 */
    }
    setDark(next === "dark");
  }

  const label = dark ? "밝게" : "어둡게";
  return (
    <button type="button" className={className ? `iconbtn ${className}` : "iconbtn"} onClick={toggle} aria-label={label} title={label}>
      {dark !== null && <Icon name={dark ? "sun" : "moon"} />}
    </button>
  );
}
