"use client";

// 블록을 누르면 보이는 상세 — 보기만. 고치기는 '수정' 을 한 번 더 (docs/일정.md 6장).
// 데스크톱 오른쪽 패널 · 좁은 데스크톱 작은 창 · 폰 보기 시트가 같이 쓴다.

import type { EventRow, Occurrence, Place, Segment, TaskRow } from "../../../lib/schedule";
import type { SourceInfo } from "../../_data/types";
import { dayLabel, departureFor, departureText, hm, nowIn, repeatLabel, timeRange, type Scope } from "../../_logic/schedule";
import { Icon } from "../Icon";
import { PlaceDot } from "./PlaceSymbol";

export function Detail({
  occ,
  ev,
  places,
  sources,
  segments,
  task,
  after,
  tz,
  deleting,
  onEdit,
  onDelete,
  onCancelDelete,
  onToggleTask,
}: {
  occ: Occurrence;
  ev: EventRow | null;
  places: Map<string, Place>;
  sources: SourceInfo[];
  segments: Segment[];
  task: TaskRow | null;
  /** 끝나면 생기는 할 일의 제목 (반복 일정에 딸린 규칙) */
  after: string | null;
  tz: string;
  /** 반복 회차를 없애려는 중 — 범위를 고른다 */
  deleting: boolean;
  onEdit: () => void;
  onDelete: (scope: Scope | null) => void;
  onCancelDelete: () => void;
  onToggleTask: (t: TaskRow) => void;
}) {
  const place = occ.place_id ? places.get(occ.place_id) : undefined;
  const dep = departureFor(occ.key, segments);
  const repeat = ev ? repeatLabel(ev.repeat) : null;
  const src = occ.source ? sources.find((s) => s.source === occ.source) : undefined;
  const when = occ.all_day || occ.start_min === null || occ.end_min === null ? "종일" : timeRange(occ.start_min, occ.end_min);
  let synced: string | null = null;
  if (src?.synced_at) {
    const n = nowIn(tz, new Date(src.synced_at));
    synced = `${dayLabel(n.date, false)} ${hm(n.min)}`;
  }
  const done = task?.done_at != null;

  return (
    <>
      <div className={place ? `dp-h pc-${place.color}` : "dp-h"}>
        {place && <PlaceDot />}
        <h2>{occ.title}</h2>
      </div>
      <div className="dp-f">
        <Icon name="clock" />
        <div>
          <span className="num">
            {dayLabel(occ.date)} · {when}
          </span>
        </div>
      </div>
      {repeat && (
        <div className="dp-f">
          <Icon name="repeat" />
          <div>{repeat}</div>
        </div>
      )}
      <div className="dp-f">
        <Icon name="pin" />
        <div>
          {place ? place.name : "지점 없음"}
          {occ.where_text ? ` · ${occ.where_text}` : ""}
        </div>
      </div>
      {dep && (
        <div className="dp-f">
          <Icon name="route" />
          <div>
            <span className="num">{departureText(dep, [...places.values()])}</span>
            {dep.late > 0 && <span className="late num">{dep.late}분 늦음</span>}
          </div>
        </div>
      )}
      {task && (
        <div className="dp-f">
          <button
            type="button"
            className="chk"
            role="checkbox"
            aria-checked={done}
            aria-label={done ? "할 일 끝냄 풀기" : "할 일 끝냄"}
            title={done ? "끝냄 풀기" : "끝냄"}
            onClick={() => onToggleTask(task)}
          >
            <Icon name={done ? "ring-check" : "ring"} />
          </button>
          <div>할 일에서 옴</div>
        </div>
      )}
      {after && (
        <div className="dp-f">
          <Icon name="plan" />
          <div>끝나면: {after}</div>
        </div>
      )}
      {occ.note && (
        <div className="dp-f">
          <Icon name="memo" />
          <div className="memo-t">{occ.note}</div>
        </div>
      )}
      {occ.source ? (
        <div className="dp-f">
          <Icon name="link" />
          <div>
            <span>{src?.label ?? occ.source}에서 온 일정</span>
            {synced && <span className="dim num">{synced} 맞춤</span>}
          </div>
        </div>
      ) : deleting ? (
        <div className="dp-acts">
          <div className="scope" role="group" aria-label="없앨 범위">
            <button type="button" onClick={() => onDelete("once")}>
              이번만
            </button>
            <button type="button" onClick={() => onDelete("following")}>
              이후 모두
            </button>
          </div>
          <button type="button" className="ghost" onClick={onCancelDelete}>
            취소
          </button>
        </div>
      ) : (
        <div className="dp-acts">
          <button type="button" className="ghost" onClick={onEdit}>
            수정
          </button>
          <button type="button" className="del" onClick={() => onDelete(null)}>
            없애기
          </button>
        </div>
      )}
    </>
  );
}
