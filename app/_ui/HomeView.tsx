"use client";

// 홈 벤또 (목업 .home). 보고서 서랍 · 일정 · 플래너 · 작업대(플래너의 하위, docs/플래너.md 7-15) · 모임 타일이 동작한다. 나머지는 점선 '나중' 타일, 눌러도 아무 일 없음.
// 켠 추가 모듈도 타일로(link 는 새 탭). 맨 아래 추가 모듈 선택창 · 회원(관리자만) — 홈에는 사이드바가 없어서 (docs/회원.md 4장).

import { ThemeToggle } from "./ThemeToggle";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toKorean } from "../../lib/errors";
import { ADMIN_PATH, shownModules, usable } from "../../lib/members";
import { withDemo } from "../_data/source";
import { formatToday } from "../_logic/drawer";
import { AUTH_MESSAGE, useSignedIn } from "./AppContext";
import { Blocked } from "./Blocked";
import { Icon, type IconName } from "./Icon";
import { anchorOf, ModuleIcon, ModuleLink, ModulePicker, type PickerAt } from "./ModulePicker";
import { useToast } from "./Toast";
import { useMe } from "./useMe";

/** 이 폭 이하면 선택창이 아래 시트 (앱의 폰 폭과 같다) */
const PHONE_MAX = 760;

export function HomeView() {
  const { ready, src } = useSignedIn();
  const toast = useToast();
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const fail = useCallback(
    (e: unknown) => {
      const k = toKorean(e, { authMessage: AUTH_MESSAGE });
      if (k.code === "AUTH") router.replace(`/login?next=${encodeURIComponent("/")}`);
      else toast(k.message);
    },
    [router, toast],
  );
  const { me, setPicked } = useMe(src, ready, fail);
  const [pick, setPick] = useState<PickerAt | null>(null);
  const [sheet, setSheet] = useState(false);
  const closePick = useCallback(() => setPick(null), []);

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
  if (me && !usable(me)) return <Blocked src={src} />;
  const mods = shownModules(me);
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
          <HomeTiles demo={src.demo} unread={unread} />
          {mods.map((m) => (
            <ModuleLink key={m.key} m={m} href={(p) => withDemo(p, src.demo)} className="tile t-mod">
              <ModuleIcon m={m} className="ico" />
              <span className="lbl">{m.name}</span>
            </ModuleLink>
          ))}
        </div>
        <div className="home-end">
          <button
            type="button"
            className="ghost"
            data-mods-open=""
            aria-expanded={pick !== null}
            onClick={(e) => {
              if (pick) return setPick(null);
              setSheet(document.documentElement.clientWidth <= PHONE_MAX);
              setPick(anchorOf(e.currentTarget, "above"));
            }}
          >
            <Icon name="plus" />
            추가 모듈
          </button>
          {me?.role === "admin" && (
            <Link className="ghost" href={withDemo(ADMIN_PATH, src.demo)}>
              <Icon name="user" />
              회원
            </Link>
          )}
        </div>
      </section>
      <ModulePicker me={me} at={pick} sheet={sheet} onToggle={setPicked} onClose={closePick} />
    </div>
  );
}

/** 고정 타일들 — 일정 · 플래너 · 작업대 · 보고서 서랍 · 나중 타일 · 모임 */
export function HomeTiles({ demo, unread }: { demo: boolean; unread: number }) {
  return (
    <>
      <Link className="tile t-today" href={withDemo("/schedule", demo)}>
        <Icon name="cal" className="ico" />
        <span className="lbl">일정</span>
      </Link>
      <Link className="tile t-planner" href={withDemo("/planner", demo)}>
        <Icon name="plan" className="ico" />
        <span className="lbl">플래너</span>
      </Link>
      <Link className="tile t-bench" href={withDemo("/planner/bench", demo)}>
        <Icon name="bench" className="ico" />
        <span className="lbl">작업대</span>
      </Link>
      <Link className="tile t-reports" href={withDemo("/drawer", demo)}>
        {unread > 0 && <span className="badge new">{unread}</span>}
        <Icon name="rep" className="ico" />
        <span className="lbl">보고서 서랍</span>
      </Link>
      <Later className="t-project" icon="proj" label="프로젝트" />
      <Later className="t-tools" icon="ia" label="IA · 유저플로우" />
      <Later className="t-kick" icon="kick" label="시작 질문지" />
      <Link className="tile t-meet" href={withDemo("/meet", demo)}>
        <Icon name="meet" className="ico" />
        <span className="lbl">모임</span>
      </Link>
      <Later className="t-learn" icon="learn" label="학습기" />
      <Later className="t-note" icon="note" label="학습 노트" />
    </>
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
