// 지점 심볼 12개 (docs/일정.md 2장). 집 · 학사모 · 가방 · 컵은 목업 그대로, 나머지는 같은 선 굵기로 그렸다.
// 색은 지점 색 토큰(--pc-ink)을 CSS 가 입힌다.

import type { ReactNode } from "react";
import type { PlaceSymbol as Sym } from "../../../lib/schedule";

const PATHS: Record<Sym, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9v11h14V9" />
      <path d="M10 20v-6h4v6" />
    </>
  ),
  school: (
    <>
      <path d="M2 9l10-5 10 5-10 5z" />
      <path d="M6 11v5c3 2.5 9 2.5 12 0v-5" />
      <path d="M22 9v6" />
    </>
  ),
  work: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M3 13h18" />
    </>
  ),
  cafe: (
    <>
      <path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" />
      <path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17" />
      <path d="M8 3v3M12 3v3" />
    </>
  ),
  book: (
    <>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z" />
      <path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3" />
    </>
  ),
  gym: <path d="M6 7v10M18 7v10M3 9.5v5M21 9.5v5M6 12h12" />,
  hospital: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  cart: (
    <>
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h3l2.6 12.4a1.5 1.5 0 0 0 1.5 1.1h8.6a1.5 1.5 0 0 0 1.5-1.2L21 8H6" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="7" r="4" />
      <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9" />
    </>
  ),
  building: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="1" />
      <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3" />
    </>
  ),
  tree: (
    <>
      <path d="M12 3 6 11h3l-4 6h14l-4-6h3z" />
      <path d="M12 17v4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
};

export const SYMBOL_NAMES: Record<Sym, string> = {
  home: "집",
  school: "학사모",
  work: "가방",
  cafe: "컵",
  book: "책",
  gym: "운동",
  hospital: "병원",
  cart: "장보기",
  people: "사람",
  building: "건물",
  tree: "나무",
  pin: "핀",
};

export function PlaceSymbol({ symbol, className }: { symbol: Sym; className?: string }) {
  return (
    <svg className={className ? `ps ${className}` : "ps"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[symbol]}
    </svg>
  );
}
