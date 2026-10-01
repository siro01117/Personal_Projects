"use client";

// 작업면 = 사이드바 + 오른쪽(모듈 화면). 목업 .work. 모듈 공용 — 메뉴: 보고서 서랍 · 일정 · 플래너, 맨 아래 휴지통(서랍).

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { TRASH_PATH } from "../../lib/links";
import { useApp } from "./AppContext";
import { Icon, type IconName } from "./Icon";

const MENU: { path: string; icon: IconName; label: string }[] = [
  { path: "/drawer", icon: "rep", label: "보고서 서랍" },
  { path: "/schedule", icon: "cal", label: "일정" },
  { path: "/planner", icon: "plan", label: "플래너" },
];

function under(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function Shell({ children }: { children: ReactNode }) {
  const { href } = useApp();
  const pathname = usePathname();
  const inTrash = under(pathname, TRASH_PATH);
  const activeIndex = inTrash ? -1 : MENU.findIndex((m) => under(pathname, m.path));
  return (
    <div className="app">
      <section className="work view">
        <aside className="side">
          <Link className="logo" href={href("/")} aria-label="홈으로">
            <span>EZ</span>
            <b>.</b>
            <span>WORK</span>
          </Link>
          <nav className="nav slide" aria-label="메뉴">
            {activeIndex >= 0 && <i className="ind" aria-hidden="true" style={{ ["--i" as string]: activeIndex }} />}
            {MENU.map((m) => {
              const on = !inTrash && under(pathname, m.path);
              return (
                <Link key={m.path} className={on ? "on" : undefined} href={href(m.path)} aria-current={on ? "page" : undefined} title={m.label}>
                  <Icon name={m.icon} />
                  <span className="txt">{m.label}</span>
                </Link>
              );
            })}
          </nav>
          <nav className="nav nav-end" aria-label="휴지통">
            <Link className={inTrash ? "on" : undefined} href={href(TRASH_PATH)} aria-current={inTrash ? "page" : undefined} title="휴지통">
              <Icon name="trash" />
              <span className="txt">휴지통</span>
            </Link>
          </nav>
        </aside>
        <div className="main">{children}</div>
      </section>
    </div>
  );
}

/** 폰 폭에서 사이드바 대신 보이는 홈 버튼 */
export function HomeButton() {
  const { href } = useApp();
  return (
    <Link className="iconbtn mhome" href={href("/")} aria-label="홈으로">
      <Icon name="grid" />
    </Link>
  );
}
