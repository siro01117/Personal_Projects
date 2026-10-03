"use client";

// 작업면 = 사이드바 + 오른쪽(모듈 화면). 목업 .work. 모듈 공용 — 메뉴: 보고서 서랍 · 일정 · 플래너 · 작업대 · 모임, 그 아래 켠 추가 모듈,
// 작업대는 플래너 바로 아래 한 줄(docs/플래너.md 7-16): 플래너는 /planner 에서만, 작업대는 /planner/bench… · 기록(/planner/log)에서 켜진다.
// 맨 아래 추가 모듈 선택창 · 회원(관리자만) · 휴지통(서랍). docs/회원.md 4장.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";
import { TRASH_PATH } from "../../lib/links";
import { ADMIN_PATH, shownModules } from "../../lib/members";
import { useApp } from "./AppContext";
import { Icon, type IconName } from "./Icon";
import { anchorOf, ModuleIcon, ModuleLink, ModulePicker, type PickerAt } from "./ModulePicker";


type MenuLine = {
  path: string;
  icon: IconName;
  label: string;
  /** 그 주소에서만 켜진다 (아래 주소는 다른 줄의 몫) */
  exact?: true;
  /** 여기 아래 주소에서도 켜진다 */
  also?: string[];
  /** 같은 모듈 — 오갈 때 오른쪽 화면을 다시 붙이지 않는다(데이터를 같이 쓴다) */
  module?: string;
};

export const MENU: MenuLine[] = [
  { path: "/drawer", icon: "rep", label: "보고서 서랍" },
  { path: "/schedule", icon: "cal", label: "일정" },
  { path: "/planner", icon: "plan", label: "플래너", exact: true },
  { path: "/planner/bench", icon: "bench", label: "작업대", also: ["/planner/log"], module: "/planner" },
  { path: "/meet", icon: "meet", label: "모임" },
];

function under(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** 그 주소에서 켜지는 메뉴 줄 번호. 없으면 -1 */
export function activeMenu(pathname: string): number {
  return MENU.findIndex((m) => (m.exact ? pathname === m.path : under(pathname, m.path)) || (m.also ?? []).some((p) => under(pathname, p)));
}

export function Shell({ children }: { children: ReactNode }) {
  const { href, me, setPicked } = useApp();
  const pathname = usePathname();
  const inTrash = under(pathname, TRASH_PATH);
  const inAdmin = under(pathname, ADMIN_PATH);
  const activeIndex = inTrash ? -1 : activeMenu(pathname);
  const mods = shownModules(me);
  const [pick, setPick] = useState<PickerAt | null>(null);
  const closePick = useCallback(() => setPick(null), []);
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
            {MENU.map((m, i) => {
              const on = i === activeIndex;
              return (
                <Link key={m.path} className={on ? "on" : undefined} href={href(m.path)} aria-current={on ? "page" : undefined} title={m.label}>
                  <Icon name={m.icon} />
                  <span className="txt">{m.label}</span>
                </Link>
              );
            })}
          </nav>
          {mods.length > 0 && (
            <nav className="nav nav-mods" aria-label="켠 추가 모듈">
              {mods.map((m) => (
                <ModuleLink key={m.key} m={m} href={href}>
                  <ModuleIcon m={m} />
                  <span className="txt">{m.name}</span>
                </ModuleLink>
              ))}
            </nav>
          )}
          <nav className="nav nav-end" aria-label="추가 모듈 · 휴지통">
            <button
              type="button"
              data-mods-open=""
              aria-expanded={pick !== null}
              title="추가 모듈"
              onClick={(e) => setPick(pick ? null : anchorOf(e.currentTarget, "right"))}
            >
              <Icon name="plus" />
              <span className="txt">추가 모듈</span>
            </button>
            {me?.role === "admin" && (
              <Link className={inAdmin ? "on" : undefined} href={href(ADMIN_PATH)} aria-current={inAdmin ? "page" : undefined} title="회원">
                <Icon name="user" />
                <span className="txt">회원</span>
              </Link>
            )}
            <Link className={inTrash ? "on" : undefined} href={href(TRASH_PATH)} aria-current={inTrash ? "page" : undefined} title="휴지통">
              <Icon name="trash" />
              <span className="txt">휴지통</span>
            </Link>
          </nav>
        </aside>
        {/* 모듈이 바뀔 때만 다시 붙어 짧게 나타난다 (모듈 안에서 폴더·주를 오갈 때는 그대로) */}
        <div className="main page-in" key={inTrash ? "trash" : (MENU[activeIndex]?.module ?? MENU[activeIndex]?.path ?? pathname)}>
          {children}
        </div>
      </section>
      <ModulePicker me={me} at={pick} sheet={false} onToggle={setPicked} onClose={closePick} />
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
