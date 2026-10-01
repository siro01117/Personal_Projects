"use client";

// 시간 정하기: 날짜(기본 오늘) · 시작 시각(기본 그날 첫 빈 시간, 지금 이후, 15분 단위) · 길이(기본 걸릴 시간 또는 60분).
// 빈 시간은 그날 일정·준비·이동을 lib/schedule 로 계산해서 고른다. 시작 시각을 손으로 바꾸면 그 뒤로는 두고 본다.

import { useEffect, useRef, useState } from "react";
import type { DateStr, Place, Settings, TaskRow, Travel } from "../../../lib/schedule";
import { DEFAULT_LEN, firstFreeStart } from "../../_logic/planner";
import { hm } from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";

export type PlanDraft = { date: DateStr; start: number | null; len: string };

type Meta = { places: Place[]; travel: Travel[]; settings: Settings };

/** "HH:MM" → 분 (못 읽으면 null) */
function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
}

export function planDraftFor(task: TaskRow, today: DateStr): PlanDraft {
  return { date: today, start: null, len: String(task.est_min ?? DEFAULT_LEN) };
}

export function PlanForm({
  task,
  draft,
  now,
  onChange,
  onSave,
  onCancel,
}: {
  task: TaskRow;
  draft: PlanDraft;
  now: { date: DateStr; min: number };
  onChange: (d: PlanDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { src, fail } = useApp();
  const S = src.schedule;
  const [meta, setMeta] = useState<Meta | null>(null);
  /** 시작 시각을 손으로 바꿨으면 기본값으로 덮지 않는다 */
  const touched = useRef(false);
  const live = useRef({ draft, onChange, now });
  live.current = { draft, onChange, now };

  useEffect(() => {
    let alive = true;
    Promise.all([S.places(), S.travel(), S.settings()]).then(
      ([places, travel, settings]) => alive && setMeta({ places, travel, settings }),
      (e) => alive && fail(e),
    );
    return () => {
      alive = false;
    };
  }, [S, fail]);

  // 날짜·길이가 바뀌면 그날 첫 빈 시간을 다시 고른다
  const len = Number(draft.len) || DEFAULT_LEN;
  useEffect(() => {
    if (!meta || touched.current) return;
    let alive = true;
    const date = draft.date;
    S.events(date, date).then(
      (rows) => {
        if (!alive || touched.current) return;
        const { draft: d, onChange: set, now: n } = live.current;
        if (d.date !== date) return;
        set({ ...d, start: firstFreeStart(date, len, rows, meta, n) });
      },
      (e) => alive && fail(e),
    );
    return () => {
      alive = false;
    };
  }, [S, meta, draft.date, len, fail]);

  const set = (p: Partial<PlanDraft>) => onChange({ ...draft, ...p });

  return (
    <form
      className="form"
      aria-label="시간 정하기"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.start !== null) onSave();
      }}
    >
      <div className="dp-h">
        <h2>{task.title}</h2>
      </div>
      <div className="f">
        <Icon name="clock" />
        <div className="v">
          <div className="line">
            <input
              type="date"
              className="pill num"
              value={draft.date}
              aria-label="날짜"
              required
              autoFocus
              onChange={(e) => e.target.value && set({ date: e.target.value })}
            />
            <input
              type="time"
              className="pill num"
              value={draft.start === null ? "" : hm(draft.start)}
              step={900}
              aria-label="시작"
              required
              onChange={(e) => {
                const m = parseHm(e.target.value);
                if (m === null) return;
                touched.current = true;
                set({ start: m });
              }}
            />
          </div>
          <div className="line">
            <label className="unit">
              <input
                className="txt-in"
                inputMode="numeric"
                aria-label="길이(분)"
                value={draft.len}
                onChange={(e) => set({ len: e.target.value.replace(/[^0-9]/g, "").slice(0, 4) })}
              />
              분
            </label>
          </div>
        </div>
      </div>
      <div className="form-acts">
        <button type="submit" className="btn save" disabled={draft.start === null}>
          저장
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
