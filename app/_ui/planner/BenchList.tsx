"use client";

// 작업대 목록 /planner/bench (docs/플래너.md 7-15). 카드 한 장에 작업대 하나 — 제목 · 역할 · 걸릴 시간 · 단계 진행 · 앉은 지 · 메모 첫 줄.
// 누르면 집중 화면, 데스크톱 마우스로 끌어 순서, 카드의 '내리기'. 위에 '가져오기' → 아직 안 올라간 열린 할 일을 눌러 올린다(연달아).
// 데이터 · 저장은 플래너와 같은 것(usePlannerData · useTaskOps).

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { DEFAULT_SETTINGS, type TaskRow } from "../../../lib/schedule";
import { benchCandidates, benchList, checkLabel, firstLine, moved, NONE_LABEL, roleText, satLabel, satMinutes } from "../../_logic/planner";
import { duration, nowIn } from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { Presence } from "../motion/Presence";
import { useFlip } from "../motion/useFlip";
import { HomeButton } from "../Shell";
import { ThemeToggle } from "../ThemeToggle";
import { useMinuteClock } from "./BenchCard";
import { readRoleOff } from "./roleOff";
import { isTemp, useTaskOps } from "./useTaskOps";
import { usePlannerData } from "./usePlannerData";

const PHONE = "(max-width: 760px)";

function usePhone(): boolean | null {
  const [phone, setPhone] = useState<boolean | null>(null);
  useEffect(() => {
    const m = matchMedia(PHONE);
    const f = () => setPhone(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return phone;
}

type Drag = { id: string; to: number };

/** 목록의 카드 하나: 제목 · 역할 · 걸릴 시간 · 단계 진행 · 앉은 지 · 메모 첫 줄 + 내리기 */
export function BenchItem({
  task: t,
  role,
  now,
  href,
  dragging = false,
  onGrab,
  onOpen,
  onOff,
}: {
  task: TaskRow;
  role: string | null;
  now: Date;
  href: string;
  dragging?: boolean;
  onGrab?: (e: ReactPointerEvent<HTMLLIElement>) => void;
  onOpen?: (e: ReactMouseEvent<HTMLAnchorElement>) => void;
  onOff: () => void;
}) {
  const steps = checkLabel(t.checklist);
  const note = firstLine(t.note);
  return (
    <li data-id={t.id} className={dragging ? "bl-card dragging" : "bl-card"} onPointerDown={onGrab}>
      <Link className="bl-main" href={href} draggable={false} onClick={onOpen}>
        <span className="bl-t">{t.title}</span>
        <span className="bl-meta">
          {role && <span>{role}</span>}
          {t.est_min !== null && <span className="num">{duration(t.est_min)}</span>}
          {steps && <span className={steps.all ? "num all" : "num"}>{steps.text}</span>}
          {t.bench_at && <span className="num sat">{satLabel(satMinutes(t.bench_at, now))}</span>}
        </span>
        {note && <span className="bl-note">{note}</span>}
      </Link>
      <button type="button" className="ghost bl-off" onClick={onOff}>
        내리기
      </button>
    </li>
  );
}

export function BenchList() {
  const { href } = useApp();
  const phone = usePhone();
  const D = usePlannerData();
  const ops = useTaskOps(D);
  const state = D.state;
  const now = useMinuteClock();
  const [picking, setPicking] = useState(false);
  const [roleOff] = useState(readRoleOff);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const justDragged = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  useFlip(listRef, ".bl-card[data-id]");

  const roles = useMemo(() => state?.roles ?? [], [state]);
  const list = useMemo(() => benchList(state?.tasks ?? []), [state]);
  const shown = drag ? moved(list, drag.id, drag.to) : list;
  const picks = useMemo(
    () => (state ? benchCandidates(state.tasks, state.links, now, nowIn(DEFAULT_SETTINGS.tz, now), roleOff, roles) : []),
    [state, now, roleOff, roles],
  );

  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicking(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [picking]);

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
      const top = ul?.getBoundingClientRect().top ?? 0;
      let to = 0;
      for (const el of rows) if (ev.clientY > top + el.offsetTop + el.offsetHeight / 2) to++;
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

  if (phone === null || !state) return <div className="planner bl" />;

  const picker = (
    <>
      <div className="dp-h">
        <h2>가져오기</h2>
      </div>
      {picks.length === 0 ? (
        <p className="pl-none">{NONE_LABEL}</p>
      ) : (
        <ul className="bl-picks">
          {picks.map((t) => {
            const role = roleText(t, roles);
            return (
              <li key={t.id} data-id={t.id}>
                <button type="button" className="bl-pick" onClick={() => void ops.bench(t, true)}>
                  <Icon name="plus" />
                  <span className="t">{t.title}</span>
                  {role && <span className="r">{role}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

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
          <div className="bl-col">
            <div className="bl-acts">
              <button type="button" className="btn" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
                <Icon name="plus" />
                가져오기
              </button>
            </div>
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
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
        <Presence>
          {!phone && picking && (
            <aside className="dp pl-dp float" aria-label="가져오기">
              <button type="button" className="iconbtn pl-x" aria-label="닫기" title="닫기" onClick={() => setPicking(false)}>
                <Icon name="x" />
              </button>
              <div className="dp-in">{picker}</div>
            </aside>
          )}
        </Presence>
      </div>
      <Presence>{phone && picking && <div className="scrim light" onClick={() => setPicking(false)} />}</Presence>
      <Presence>
        {phone && picking && (
          <div className="sheet" role="dialog" aria-label="가져오기">
            <span className="grab" />
            <div className="sh-in">{picker}</div>
          </div>
        )}
      </Presence>
    </div>
  );
}
