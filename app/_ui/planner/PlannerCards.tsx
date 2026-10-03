"use client";

// 플래너 카드 넷의 자리 (docs/플래너.md 7-14): 지남 · 할 일 · 시간 정함 · 끝냄은 비어도 그 자리에 그대로(제목 + "없음").
// 두 열(왼쪽 지남 → 할 일, 오른쪽 시간 정함 → 끝냄)은 내용과 무관하게 고정. 좁으면 같은 순서로 한 열. 끝냄은 접힌다.
// 할 일 카드의 첫 줄은 추가 칸(비어도 있다), 머리 오른쪽에 "작업대 n" 링크 (7-15).

import type { ReactNode } from "react";
import { NONE_LABEL } from "../../_logic/planner";
import { Icon } from "../Icon";
import { Presence } from "../motion/Presence";
import { ThemeToggle } from "../ThemeToggle";

export const CARD_KEYS = ["late", "open", "timed", "done"] as const;
export type CardKey = (typeof CARD_KEYS)[number];
export const CARD_LABEL: Record<CardKey, string> = { late: "지남", open: "할 일", timed: "시간 정함", done: "끝냄" };

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
  benchLink,
}: {
  count: Record<CardKey, number>;
  /** 그 카드의 줄들 (비어 있지 않을 때만 부른다) */
  body: (k: CardKey) => ReactNode;
  showDone: boolean;
  onFold: () => void;
  /** 할 일 카드의 첫 줄 — 추가 칸 */
  addRow?: ReactNode;
  /** 할 일 카드 머리 오른쪽 — "작업대 n" (0이면 안 준다) */
  benchLink?: ReactNode;
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
      {k === "open" && benchLink ? (
        <div className="pl-hrow">
          {head(k)}
          {benchLink}
        </div>
      ) : (
        head(k)
      )}
      {k === "open" && addRow}
      {count[k] > 0 ? body(k) : none}
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
          <section className="pl-sec done" aria-label={CARD_LABEL.done}>
            {count.done === 0 ? (
              <>
                {head("done")}
                {none}
              </>
            ) : (
              <>
                <button type="button" className="pl-h pl-fold" aria-expanded={showDone} onClick={onFold}>
                  {CARD_LABEL.done}
                  <span className="num">{count.done}</span>
                  <Icon name={showDone ? "up" : "down"} />
                </button>
                <Presence>
                  {showDone && (
                    <div className="fold" data-flip-skip="">
                      <div>{body("done")}</div>
                    </div>
                  )}
                </Presence>
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
