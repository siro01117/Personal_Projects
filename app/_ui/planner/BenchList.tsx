"use client";

// 작업대 목록 /planner/bench (docs/플래너.md 7-15 · 7-16). 가운데 기둥 안에 두 열 — 왼쪽은 작업대 카드들, 오른쪽은 "가져올 만한 것".
// 카드 한 장에 작업대 하나: 제목 · 역할 · 걸릴 시간 · 얇은 진행 막대 · 지금 단계(단계가 없으면 메모 첫 줄) · 오늘 기록 n분.
//   시간이 가고 있는 카드는 왼쪽에 키위 막대. 누르면 집중 화면, 데스크톱 마우스로 끌어 순서, 카드의 '내리기'.
// 가져올 만한 것: 아직 안 올라간 열린 할 일(지남 · 할 일 · 시간 정함 순, 역할 필터 적용)이 늘 옆에 — 떠 있는 라운드 패널(폭 320, 따라온다).
//   누르면 바로 올라가고(FLIP 으로 목록 쪽으로) 패널에서 빠진다. 좁으면 카드들 아래. 둘 다 비면 "없음" 한 줄.
// 데이터 · 저장은 플래너와 같은 것(usePlannerData · useTaskOps).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { DEFAULT_SETTINGS, type Role, type TaskRow } from "../../../lib/schedule";
import { benchCandidates, benchLine, benchList, moved, NONE_LABEL, progressOf, roleText, todayLabel } from "../../_logic/planner";
import { benchMenu, pickMenu } from "../../_logic/menus";
import { duration, nowIn } from "../../_logic/schedule";
import { toCss } from "../../_logic/zoom";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { useFlip } from "../motion/useFlip";
import { HomeButton } from "../Shell";
import { ThemeToggle } from "../ThemeToggle";
import { toEntries, useContextMenu, type MenuBind } from "../useContextMenu";
import { useMinuteClock } from "./BenchCard";
import { readRoleOff } from "./roleOff";
import { isTemp, useTaskOps } from "./useTaskOps";
import { usePlannerData } from "./usePlannerData";

type Drag = { id: string; to: number };

/** 목록의 카드 하나: 제목 · 역할 · 걸릴 시간 · 진행 막대 · 지금 단계(또는 메모 첫 줄) · 오늘 기록 + 내리기 */
export function BenchItem({
  task: t,
  role,
  now,
  href,
  dragging = false,
  onGrab,
  onOpen,
  onOff,
  menu,
}: {
  task: TaskRow;
  role: string | null;
  now: Date;
  href: string;
  dragging?: boolean;
  onGrab?: (e: ReactPointerEvent<HTMLLIElement>) => void;
  onOpen?: (e: ReactMouseEvent<HTMLAnchorElement>) => void;
  onOff: () => void;
  /** 우클릭 · 길게 누르기 메뉴 (docs/공통.md 2장) */
  menu?: MenuBind;
}) {
  const progress = progressOf(t.checklist);
  const line = benchLine(t);
  const today = todayLabel(t, now.getTime());
  const running = t.work?.running === true;
  const cls = ["bl-card", running && "running", dragging && "dragging"].filter(Boolean).join(" ");
  return (
    <li
      data-id={t.id}
      className={cls}
      {...menu}
      onPointerDown={(e) => {
        menu?.onPointerDown(e);
        onGrab?.(e);
      }}
    >
      <Link className="bl-main" href={href} draggable={false} onClick={onOpen}>
        <span className="bl-t">{t.title}</span>
        <span className="bl-meta">
          {role && <span>{role}</span>}
          {t.est_min !== null && <span className="num">{duration(t.est_min)}</span>}
          {today && <span className="num today">{today}</span>}
        </span>
        {progress !== null && (
          <span className="bl-bar" role="progressbar" aria-label="진행" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <i style={{ transform: `scaleX(${progress})` }} />
          </span>
        )}
        {line && <span className="bl-note">{line}</span>}
      </Link>
      <button type="button" className="ghost bl-off" onClick={onOff}>
        내리기
      </button>
    </li>
  );
}

/** 가져올 만한 것: 떠 있는 라운드 패널. 제목 글자 없이 첫 줄부터 할 일 — 누르면 올라간다 */
export function BenchPicks({
  picks,
  roles,
  onPick,
  menuOf,
}: {
  picks: readonly TaskRow[];
  roles: readonly Role[];
  onPick: (t: TaskRow) => void;
  menuOf?: (t: TaskRow) => MenuBind;
}) {
  return (
    <aside className="bl-side" aria-label="가져올 만한 것">
      <ul className="bl-picks">
        {picks.map((t) => {
          const role = roleText(t, roles);
          return (
            <li key={t.id} data-id={t.id} {...menuOf?.(t)}>
              <button type="button" className="bl-pick" onClick={() => onPick(t)}>
                <Icon name="plus" />
                <span className="t">{t.title}</span>
                {role && <span className="r">{role}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

export function BenchList() {
  const { href } = useApp();
  const router = useRouter();
  const cm = useContextMenu();
  const D = usePlannerData();
  const ops = useTaskOps(D);
  const state = D.state;
  const now = useMinuteClock();
  const [roleOff] = useState(readRoleOff);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const justDragged = useRef(false);
  const colsRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // 카드와 가져올 줄을 같이 잰다 — 올리면 그 줄이 있던 자리에서 카드 자리로 미끄러진다
  useFlip(colsRef, ".bl-card[data-id], .bl-picks > li[data-id]");

  const roles = useMemo(() => state?.roles ?? [], [state]);
  const list = useMemo(() => benchList(state?.tasks ?? []), [state]);
  const shown = drag ? moved(list, drag.id, drag.to) : list;
  const picks = useMemo(
    () => (state ? benchCandidates(state.tasks, state.links, now, nowIn(DEFAULT_SETTINGS.tz, now), roleOff, roles) : []),
    [state, now, roleOff, roles],
  );

  /** 끌어서 순서 바꾸기 — 데스크톱 마우스만, 4px 움직여야 시작. 놓인 자리(offsetTop)로 잰다 */
  function grab(e: ReactPointerEvent<HTMLLIElement>, t: TaskRow) {
    if (e.pointerType !== "mouse" || e.button !== 0 || isTemp(t.id) || (e.target as HTMLElement).closest("button")) return;
    const sy = e.clientY;
    const from = list.findIndex((x) => x.id === t.id);
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientY - sy) < 4) return;
      if (!started) {
        started = true;
        document.body.classList.add("pl-grabbing");
        setDrag({ id: t.id, to: from });
      }
      const ul = listRef.current;
      const rows = [...(ul?.querySelectorAll<HTMLElement>("li[data-id]") ?? [])].filter((el) => el.dataset.id !== t.id);
      // 포인터가 목록 위에서 얼마나 내려왔나 — offsetTop 과 같은 단위(CSS px)로
      const y = toCss(ev.clientY - (ul?.getBoundingClientRect().top ?? 0));
      let to = 0;
      for (const el of rows) if (y > el.offsetTop + el.offsetHeight / 2) to++;
      setDrag((d) => (d && d.to !== to ? { ...d, to } : d));
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (!started) return;
      document.body.classList.remove("pl-grabbing");
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      const to = dragRef.current?.to ?? from;
      setDrag(null);
      if (to !== from) ops.reorderBench(moved(list, t.id, to).map((x) => x.id));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  if (!state) return <div className="planner bl" />;

  return (
    <div className="planner bl page-in">
      <div className="bar-top pl-top">
        <HomeButton />
        <nav className="bl-crumb" aria-label="위치">
          <Link href={href("/planner")}>플래너</Link>
          <Icon name="right" />
          <span aria-current="page">작업대</span>
        </nav>
        <ThemeToggle />
      </div>
      <div className="pl-stage">
        <div className="pl-list bl-stage">
          <div className={picks.length > 0 ? "bl-col two" : "bl-col"}>
            <div className="bl-acts">
              <Link className="bl-log" href={href("/planner/log")}>
                기록
              </Link>
            </div>
            <div className="bl-cols" ref={colsRef}>
              <div className="bl-left">
                {shown.length === 0 ? (
                  <p className="pl-none bl-none">{NONE_LABEL}</p>
                ) : (
                  <ul className="bl-list" ref={listRef} aria-label="작업대">
                    {shown.map((t) => (
                      <BenchItem
                        key={t.id}
                        task={t}
                        role={roleText(t, roles)}
                        now={now}
                        href={href(`/planner/bench/${t.id}`)}
                        dragging={drag?.id === t.id}
                        onGrab={(e) => grab(e, t)}
                        onOpen={(e) => {
                          if (justDragged.current) e.preventDefault();
                        }}
                        onOff={() => void ops.bench(t, false)}
                        menu={cm.bind(`bench:${t.id}`, () =>
                          toEntries(benchMenu({ temp: isTemp(t.id) }), (act) => {
                            if (act === "focus") router.push(href(`/planner/bench/${t.id}`));
                            else if (act === "done") void ops.toggle(t);
                            else void ops.bench(t, false);
                          }),
                        )}
                      />
                    ))}
                  </ul>
                )}
              </div>
              {picks.length > 0 && (
                <BenchPicks
                  picks={picks}
                  roles={roles}
                  onPick={(t) => void ops.bench(t, true)}
                  menuOf={(t) => cm.bind(`pick:${t.id}`, () => toEntries(pickMenu({ temp: isTemp(t.id) }), () => void ops.bench(t, true)))}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      {cm.node}
    </div>
  );
}
