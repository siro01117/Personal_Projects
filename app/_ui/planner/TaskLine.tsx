"use client";

// 목록 한 줄: 동그라미(끝냄 체크, 누르면 바로) · 제목 · 마감 · 걸릴 시간 (시간 정함이면 걸릴 시간 대신 일정 시각).
// 좁아지면 말줄임 대신 걸릴 시간 → 마감 순으로 뺀다(CSS 컨테이너 쿼리). 제목은 띄어쓰기에서만 줄을 바꾼다.

import type { PointerEvent as ReactPointerEvent } from "react";
import type { DateStr, TaskRow } from "../../../lib/schedule";
import type { TaskLink } from "../../_data/types";
import { dueLabel, overdue, whenLabel } from "../../_logic/planner";
import { duration } from "../../_logic/schedule";
import { Icon } from "../Icon";

export function TaskLine({
  task,
  link,
  today,
  selected,
  dragging,
  onToggle,
  onPick,
  onGrab,
}: {
  task: TaskRow;
  link?: TaskLink;
  today: DateStr;
  selected: boolean;
  dragging?: boolean;
  onToggle: (t: TaskRow) => void;
  onPick: (t: TaskRow) => void;
  /** 끌어 순서 바꾸기 (할 일 목록 · 데스크톱 마우스만) */
  onGrab?: (e: ReactPointerEvent<HTMLLIElement>, t: TaskRow) => void;
}) {
  const done = task.done_at !== null;
  const cls = ["pl-row", selected && "sel", done && "done", dragging && "dragging", onGrab && "movable"].filter(Boolean).join(" ");
  return (
    <li className={cls} data-id={task.id} onPointerDown={onGrab ? (e) => onGrab(e, task) : undefined} onClick={() => onPick(task)}>
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
          <span className={overdue(task.due, today) ? "due num late" : "due num"}>{task.due ? dueLabel(task.due) : ""}</span>
          {link ? (
            <span className="when num">{whenLabel(link.date, link.start_min)}</span>
          ) : (
            <span className="est num">{task.est_min !== null ? duration(task.est_min) : ""}</span>
          )}
        </>
      )}
    </li>
  );
}
