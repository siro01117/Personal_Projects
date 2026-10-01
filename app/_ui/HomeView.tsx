"use client";

// 홈 벤또 (목업 .home). 보고서 서랍 · 일정 · 플래너 타일이 동작한다. 나머지는 점선 '나중' 타일, 눌러도 아무 일 없음.

import { ThemeToggle } from "./ThemeToggle";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toKorean } from "../../lib/errors";
import { withDemo } from "../_data/source";
import { formatToday } from "../_logic/drawer";
import { AUTH_MESSAGE, useSignedIn } from "./AppContext";
import { Icon, type IconName } from "./Icon";
import { useToast } from "./Toast";

export function HomeView() {
  const { ready, src } = useSignedIn();
  const toast = useToast();
  const router = useRouter();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!ready || !src) return;
    let alive = true;
    src.data.unreadCount().then(
      (n) => alive && setUnread(n),
      (e) => {
        if (!alive) return;
        const k = toKorean(e, { authMessage: AUTH_MESSAGE });
        if (k.code === "AUTH") router.replace(`/login?next=${encodeURIComponent("/")}`);
        else toast(k.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [ready, src, toast, router]);

  if (!ready || !src) return null;
  return (
    <div className="app">
      <section className="home view">
        <div className="topline">
          <span className="logo">
            EZ<b>.</b>WORK
          </span>
          <span className="date">{formatToday()}</span>
          <ThemeToggle className="theme-toggle" />
        </div>
        <div className="bento">
          <Link className="tile t-today" href={withDemo("/schedule", src.demo)}>
            <Icon name="cal" className="ico" />
            <span className="lbl">일정</span>
          </Link>
          <Link className="tile t-planner" href={withDemo("/planner", src.demo)}>
            <Icon name="plan" className="ico" />
            <span className="lbl">플래너</span>
          </Link>
          <Link className="tile t-reports" href={withDemo("/drawer", src.demo)}>
            {unread > 0 && <span className="badge new">{unread}</span>}
            <Icon name="rep" className="ico" />
            <span className="lbl">보고서 서랍</span>
          </Link>
          <Later className="t-project" icon="proj" label="프로젝트" />
          <Later className="t-tools" icon="ia" label="IA · 유저플로우" />
          <Later className="t-kick" icon="kick" label="시작 질문지" />
          <Later className="t-meet" icon="meet" label="모임" />
          <Later className="t-learn" icon="learn" label="학습기" />
          <Later className="t-note" icon="note" label="학습 노트" />
        </div>
      </section>
    </div>
  );
}

function Later({ className, icon, label }: { className: string; icon: IconName; label: string }) {
  return (
    <div className={`tile ${className} is-later`} title="준비 중" aria-disabled="true">
      <Icon name={icon} className="ico" />
      <span className="lbl">{label}</span>
    </div>
  );
}
