"use client";

// 플래너 카드의 자리 (docs/플래너.md 7-14 · 7-16): 지남 · 할 일 · 시간 정함 · 끝냄 · 반복은 비어도 그 자리에 그대로(제목 + "없음").
// 두 열(왼쪽 지남 → 할 일, 오른쪽 시간 정함 → 끝냄 → 반복)은 내용과 무관하게 고정. 좁으면 같은 순서로 한 열. 끝냄 · 반복은 접힌다.
// 할 일 카드의 첫 줄은 추가 칸(비어도 있다). 작업대로 가는 길은 여기 없다 — 사이드바와 할 일 보기의 "작업대" 단추 (7-16).

import type { ReactNode } from "react";
import { NONE_LABEL } from "../../_logic/planner";
import { Icon } from "../Icon";
import { Presence } from "../motion/Presence";
import { ThemeToggle } from "../ThemeToggle";

export const CARD_KEYS = ["late", "open", "timed", "done"] as const;
export type CardKey = (typeof CARD_KEYS)[number];
export const CARD_LABEL: Record<CardKey, string> = { late: "지남", open: "할 일", timed: "시간 정함", done: "끝냄" };
/** 반복 카드 — 규칙이 사는 곳 (7-16) */
export const RULES_LABEL = "반복";

/** 위쪽 줄 — 홈(폰) · 밝기 전환만. 할 일 추가 칸은 할 일 카드의 첫 줄로 갔다 (7-15) */
export function PlannerBar({ home }: { home: ReactNode }) {
  return (
    <div className="bar-top pl-top">
      {home}
      <ThemeToggle />
    </div>
  );
}

export function PlannerCards({
  count,
  body,
  showDone,
  onFold,
  addRow,
  rules,
}: {
  count: Record<CardKey, number>;
  /** 그 카드의 줄들 (비어 있지 않을 때만 부른다) */
  body: (k: CardKey) => ReactNode;
  showDone: boolean;
  onFold: () => void;
  /** 할 일 카드의 첫 줄 — 추가 칸 */
  addRow?: ReactNode;
  /** 반복 카드: 규칙 수 · 줄들 · 펼침. 안 주면 카드를 그리지 않는다(모임처럼 같은 틀만 쓰는 화면) */
  rules?: { count: number; body: () => ReactNode; open: boolean; onFold: () => void };
}) {
  const head = (k: CardKey) => (
    <h2 className="pl-h">
      {CARD_LABEL[k]}
      {count[k] > 0 && <span className="num">{count[k]}</span>}
    </h2>
  );
  const none = <p className="pl-none">{NONE_LABEL}</p>;
  const card = (k: Exclude<CardKey, "done">) => (
    <section className={`pl-sec ${k}`} aria-label={CARD_LABEL[k]}>
      {head(k)}
      {k === "open" && addRow}
      {count[k] > 0 ? body(k) : none}
    </section>
  );
  /** 접히는 카드 (끝냄 · 반복): 비면 접기 단추 없이 "없음" */
  const folding = (cls: string, label: string, n: number, open: boolean, fold: () => void, rows: () => ReactNode) => (
    <section className={`pl-sec ${cls}`} aria-label={label}>
      {n === 0 ? (
        <>
          <h2 className="pl-h">{label}</h2>
          {none}
        </>
      ) : (
        <>
          <button type="button" className="pl-h pl-fold" aria-expanded={open} onClick={fold}>
            {label}
            <span className="num">{n}</span>
            <Icon name={open ? "up" : "down"} />
          </button>
          <Presence>
            {open && (
              <div className="fold" data-flip-skip="">
                <div>{rows()}</div>
              </div>
            )}
          </Presence>
        </>
      )}
    </section>
  );
  return (
    <>
      <div className="pl-cols two">
        <div className="pl-col">
          {card("late")}
          {card("open")}
        </div>
        <div className="pl-col">
          {card("timed")}
          {folding("done", CARD_LABEL.done, count.done, showDone, onFold, () => body("done"))}
          {rules && folding("rules", RULES_LABEL, rules.count, rules.open, rules.onFold, rules.body)}
        </div>
      </div>
    </>
  );
}
