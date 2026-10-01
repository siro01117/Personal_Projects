"use client";

// 할 일을 누르면 보이는 것 — 보기만. 고치기는 '수정' 을 한 번 더, 끝냄 체크와 체크 항목만 바로 (docs/플래너.md 3장 · 7장).
// 넓은 데스크톱 오른쪽 패널 · 좁은 데스크톱 떠 있는 패널 · 폰 보기 시트가 같이 쓴다. 빈 칸은 줄을 그리지 않는다.
// 지남이면 버튼이 상황에 맞게 바뀐다: 지난 일정 → 끝냄 · 다시 정하기 · 시간 없음으로, 지난 마감 → 끝냄 · 마감 바꾸기 · 마감 지우기.

import Link from "next/link";
import type { MouseEvent } from "react";
import type { DateStr, EventRow, Place, TaskRow } from "../../../lib/schedule";
import type { TaskLink } from "../../_data/types";
import { dueLabel, overdue } from "../../_logic/planner";
import { dayLabel, duration, hm, repeatLabel, timeRange } from "../../_logic/schedule";
import { Icon } from "../Icon";

export function TaskDetail({
  task,
  link,
  event,
  late,
  place,
  dueTitle,
  repeat,
  today,
  scheduleHref,
  onToggle,
  onCheck,
  onPlan,
  onUnplan,
  onDue,
  onClearDue,
  onEdit,
  onDelete,
  onMore,
}: {
  task: TaskRow;
  link: TaskLink | null;
  /** 이어진 일정 줄 (끝 시각 · 반복). 아직 못 읽었으면 null */
  event: EventRow | null;
  /** 무엇이 지났나 (지남 묶음의 할 일) */
  late: "event" | "due" | null;
  place: Place | null;
  /** 마감을 딸려 둔 일정의 제목 */
  dueTitle: string | null;
  /** 반복 규칙에서 왔으면 "매주 월" 같은 한 줄 */
  repeat: string | null;
  today: DateStr;
  scheduleHref: string | null;
  onToggle: (t: TaskRow) => void;
  onCheck: (index: number, done: boolean) => void;
  onPlan: () => void;
  onUnplan: () => void;
  onDue: () => void;
  onClearDue: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** 더보기 메뉴 (일정으로). 없으면 버튼을 그리지 않는다 */
  onMore: ((e: MouseEvent<HTMLButtonElement>) => void) | null;
}) {
  const done = task.done_at !== null;
  let when: string | null = null;
  if (link) {
    const start = event?.start_min ?? link.start_min;
    const end = event?.end_min ?? link.end_min;
    when = `${dayLabel(link.date)} · ${start === null ? "종일" : end === null ? hm(start) : timeRange(start, end)}`;
  }
  const evRepeat = event ? repeatLabel(event.repeat) : null;
  const dueLate = !done && overdue(task.due, today);

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
            <span className={dueLate ? "late-t" : undefined}>
              {task.due_event_id && dueTitle ? `${dueLabel(task.due)} · ${dueTitle}` : `${dayLabel(task.due)}까지`}
            </span>
          </div>
        </div>
      )}
      {link && when && (
        <div className="dp-f">
          <Icon name="cal" />
          <div>
            {scheduleHref ? (
              <Link className={late === "event" ? "go-ev num late-t" : "go-ev num"} href={scheduleHref}>
                {when}
              </Link>
            ) : (
              <span className="num">{when}</span>
            )}
            {evRepeat && <span className="dim">{evRepeat}</span>}
          </div>
        </div>
      )}
      {task.est_min !== null && (
        <div className="dp-f">
          <Icon name="clock" />
          <div>{duration(task.est_min)}</div>
        </div>
      )}
      {place && (
        <div className="dp-f">
          <Icon name="pin" />
          <div>{place.name}</div>
        </div>
      )}
      {repeat && (
        <div className="dp-f">
          <Icon name="repeat" />
          <div>{repeat}</div>
        </div>
      )}
      {task.checklist.length > 0 && (
        <ul className="ck-list" aria-label="체크 항목">
          {task.checklist.map((c, i) => (
            <li key={i}>
              <button type="button" className={c.done ? "ck on" : "ck"} role="checkbox" aria-checked={c.done} onClick={() => onCheck(i, !c.done)}>
                <Icon name={c.done ? "ring-check" : "ring"} />
                <span>{c.t}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {task.note && (
        <div className="dp-f">
          <Icon name="memo" />
          <div className="memo-t">{task.note}</div>
        </div>
      )}
      <div className="dp-acts">
        {late === "event" && (
          <>
            <button type="button" className="btn" onClick={() => onToggle(task)}>
              끝냄
            </button>
            <button type="button" className="ghost" onClick={onPlan}>
              다시 정하기
            </button>
            <button type="button" className="ghost" onClick={onUnplan}>
              시간 없음으로
            </button>
          </>
        )}
        {late === "due" && (
          <>
            <button type="button" className="btn" onClick={() => onToggle(task)}>
              끝냄
            </button>
            <button type="button" className="ghost" onClick={onDue}>
              마감 바꾸기
            </button>
            <button type="button" className="ghost" onClick={onClearDue}>
              마감 지우기
            </button>
          </>
        )}
        {late && <span className="brk" />}
        {!late && !link && !done && (
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
        {onMore && (
          <button type="button" className="iconbtn more-b" aria-label="더보기" title="더보기" aria-haspopup="menu" onClick={onMore}>
            <Icon name="dots" />
          </button>
        )}
      </div>
    </>
  );
}
