"use client";

// 목록 한 줄: (작업대에 올라가 있으면 맨 앞에 작은 키위 표시) 동그라미(끝냄 체크, 누르면 바로) · 지점 심볼 · 제목 · 반복 표시 · 역할(회색 글자, 역할 정렬일 때는 구분 라벨에 적고 줄에서는 뺀다) · 체크 수 · 마감 · 걸릴 시간
// (시간 정함이면 걸릴 시간 대신 일정 시각, 지남이면 무엇이 지났는지).
// 좁아지면 말줄임 대신 걸릴 시간 → 역할 → 체크 수 → 마감 → 반복 표시 순으로 뺀다(CSS 컨테이너 쿼리).
// 지남 글자와 지점 심볼은 남긴다. 제목은 띄어쓰기에서만 줄을 바꾼다.

import type { PointerEvent as ReactPointerEvent } from "react";
import type { DateStr, Place, TaskRow } from "../../../lib/schedule";
import type { TaskLink } from "../../_data/types";
import { checkLabel, dueLabel, lateLabel, overdue, whenLabel, type Late } from "../../_logic/planner";
import { duration } from "../../_logic/schedule";
import { Icon } from "../Icon";
import type { MenuBind } from "../useContextMenu";

export function TaskLine({
  task,
  link,
  late,
  place,
  role,
  repeats,
  benched,
  today,
  selected,
  dragging,
  onToggle,
  onPick,
  onGrab,
  menu,
}: {
  task: TaskRow;
  link?: TaskLink;
  /** 지남 묶음의 줄 */
  late?: Late;
  place?: Place;
  /** 줄에 보일 역할 이름 (역할 정렬일 때는 안 온다) */
  role?: string | null;
  /** 살아 있는 반복 규칙에서 온 할 일 */
  repeats?: boolean;
  /** 작업대에 올라간 할 일 — 줄 앞에 작은 표시 하나 (7-13) */
  benched?: boolean;
  today: DateStr;
  selected: boolean;
  dragging?: boolean;
  onToggle: (t: TaskRow) => void;
  onPick: (t: TaskRow) => void;
  /** 끌어 순서 바꾸기 (할 일 목록 · '직접' 정렬 · 데스크톱 마우스만) */
  onGrab?: (e: ReactPointerEvent<HTMLLIElement>, t: TaskRow) => void;
  /** 우클릭 · 길게 누르기 메뉴 (docs/공통.md 2장) */
  menu?: MenuBind;
}) {
  const done = task.done_at !== null;
  const checks = checkLabel(task.checklist);
  const byEvent = late?.why === "event";
  const byDue = late?.why === "due";
  const cls = ["pl-row", selected && "sel", done && "done", benched && "benched", dragging && "dragging", onGrab && "movable", (link || byEvent) && "has-when"]
    .filter(Boolean)
    .join(" ");
  return (
    <li
      className={cls}
      data-id={task.id}
      {...menu}
      onPointerDown={(e) => {
        menu?.onPointerDown(e);
        onGrab?.(e, task);
      }}
      onClick={() => onPick(task)}
    >
      {benched && <span className="bn-mark" title="작업대" />}
      <button
        type="button"
        className="chk"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `${task.title} 끝냄 풀기` : `${task.title} 끝냄`}
        title={done ? "끝냄 풀기" : "끝냄"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(task);
        }}
      >
        <Icon name={done ? "ring-check" : "ring"} />
      </button>
      <button type="button" className="nm" aria-pressed={selected}>
        {task.title}
      </button>
      {!done && (
        <>
          {repeats && (
            <span className="rpt" title="반복">
              <Icon name="repeat" />
            </span>
          )}
          {role && <span className="role">{role}</span>}
          <span className={checks?.all ? "cnt num all" : "cnt num"}>{checks?.text ?? ""}</span>
          <span className={byDue ? "due num late keep" : overdue(task.due, today) ? "due num late" : "due num"}>{task.due ? dueLabel(task.due) : ""}</span>
          {byEvent && late ? (
            <span className="when num late keep">{lateLabel(late)}</span>
          ) : link ? (
            <span className="when num">{whenLabel(link.date, link.start_min)}</span>
          ) : (
            <span className="est num">{task.est_min !== null ? duration(task.est_min) : ""}</span>
          )}
        </>
      )}
    </li>
  );
}
