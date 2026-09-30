"use client";

// 작업면 = 사이드바 + 오른쪽(위쪽 경로 줄 + 탐색기 | 보고서 | 휴지통). 목업 .work

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { TRASH_PATH } from "../../lib/links";
import { useDrawer } from "./DrawerContext";
import { Icon } from "./Icon";

export function Shell({ children }: { children: ReactNode }) {
  const { href } = useDrawer();
  const inTrash = usePathname().startsWith(TRASH_PATH);
  return (
    <div className="app">
      <section className="work view">
        <aside className="side">
          <Link className="logo" href={href("/")} aria-label="홈으로">
            <span>EZ</span>
            <b>.</b>
            <span>WORK</span>
          </Link>
          <nav className="nav" aria-label="메뉴">
            <Link className={inTrash ? undefined : "on"} href={href("/drawer")} aria-current={inTrash ? undefined : "page"}>
              <Icon name="rep" />
              <span className="txt">보고서 서랍</span>
            </Link>
            <Link className={inTrash ? "on" : undefined} href={href(TRASH_PATH)} aria-current={inTrash ? "page" : undefined}>
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
  const { href } = useDrawer();
  return (
    <Link className="iconbtn mhome" href={href("/")} aria-label="홈으로">
      <Icon name="grid" />
    </Link>
  );
}
