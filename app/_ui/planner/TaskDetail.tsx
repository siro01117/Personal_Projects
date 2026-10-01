"use client";

// 할 일을 누르면 보이는 것 — 보기만. 고치기는 '수정' 을 한 번 더, 끝냄 체크만 바로 (docs/플래너.md 3장).
// 넓은 데스크톱 오른쪽 패널 · 좁은 데스크톱 떠 있는 패널 · 폰 보기 시트가 같이 쓴다. 빈 칸은 줄을 그리지 않는다.

import Link from "next/link";
import type { DateStr, EventRow, TaskRow } from "../../../lib/schedule";
import type { TaskLink } from "../../_data/types";
import { overdue } from "../../_logic/planner";
import { dayLabel, duration, hm, repeatLabel, timeRange } from "../../_logic/schedule";
import { Icon } from "../Icon";

export function TaskDetail({
  task,
  link,
  event,
  today,
  scheduleHref,
  onToggle,
  onPlan,
  onEdit,
  onDelete,
}: {
  task: TaskRow;
  link: TaskLink | null;
  /** 이어진 일정 줄 (끝 시각 · 반복). 아직 못 읽었으면 null */
  event: EventRow | null;
  today: DateStr;
  scheduleHref: string | null;
  onToggle: (t: TaskRow) => void;
  onPlan: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const done = task.done_at !== null;
  let when: string | null = null;
  if (link) {
    const start = event?.start_min ?? link.start_min;
    const end = event?.end_min ?? null;
    when = `${dayLabel(link.date)} · ${start === null ? "종일" : end === null ? hm(start) : timeRange(start, end)}`;
  }
  const repeat = event ? repeatLabel(event.repeat) : null;

  return (
    <>
      <div className="dp-h">
        <button
          type="button"
          className="chk"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? "끝냄 풀기" : "끝냄"}
          title={done ? "끝냄 풀기" : "끝냄"}
          onClick={() => onToggle(task)}
        >
          <Icon name={done ? "ring-check" : "ring"} />
        </button>
        <h2>{task.title}</h2>
      </div>
      {task.due && (
        <div className="dp-f">
          <Icon name="flag" />
          <div>
            <span className={!done && overdue(task.due, today) ? "late-t" : undefined}>{dayLabel(task.due)}까지</span>
          </div>
        </div>
      )}
      {task.est_min !== null && (
        <div className="dp-f">
          <Icon name="clock" />
          <div>{duration(task.est_min)}</div>
        </div>
      )}
      {task.note && (
        <div className="dp-f">
          <Icon name="memo" />
          <div className="memo-t">{task.note}</div>
        </div>
      )}
      {link && when && (
        <div className="dp-f">
          <Icon name="cal" />
          <div>
            {scheduleHref ? (
              <Link className="go-ev num" href={scheduleHref}>
                {when}
              </Link>
            ) : (
              <span className="num">{when}</span>
            )}
            {repeat && <span className="dim">{repeat}</span>}
          </div>
        </div>
      )}
      <div className="dp-acts">
        {!link && !done && (
          <button type="button" className="btn" onClick={onPlan}>
            시간 정하기
          </button>
        )}
        <button type="button" className="ghost" onClick={onEdit}>
          수정
        </button>
        <button type="button" className="del" onClick={onDelete}>
          없애기
        </button>
      </div>
    </>
  );
}
