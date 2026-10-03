"use client";

// 플래너 카드 넷의 자리 (docs/플래너.md 7-14): 지남 · 할 일 · 시간 정함 · 끝냄은 비어도 그 자리에 그대로(제목 + "없음").
// 두 열(왼쪽 지남 → 할 일, 오른쪽 시간 정함 → 끝냄)은 내용과 무관하게 고정. 좁으면 같은 순서로 한 열. 끝냄은 접힌다.
// 작업대 카드(7-13)는 그 위에 두 열에 걸친다.

import type { ReactNode } from "react";
import { NONE_LABEL } from "../../_logic/planner";
import { Icon } from "../Icon";
import { Presence } from "../motion/Presence";

export const CARD_KEYS = ["late", "open", "timed", "done"] as const;
export type CardKey = (typeof CARD_KEYS)[number];
export const CARD_LABEL: Record<CardKey, string> = { late: "지남", open: "할 일", timed: "시간 정함", done: "끝냄" };

export function PlannerCards({
  count,
  body,
  showDone,
  onFold,
  bench,
}: {
  count: Record<CardKey, number>;
  /** 그 카드의 줄들 (비어 있지 않을 때만 부른다) */
  body: (k: CardKey) => ReactNode;
  showDone: boolean;
  onFold: () => void;
  bench?: ReactNode;
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
      {count[k] > 0 ? body(k) : none}
    </section>
  );
  return (
    <>
      {bench}
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
