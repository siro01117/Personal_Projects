"use client";

// 할 일 수정 칸: 제목 · 마감(날짜, 지우기) · 걸릴 시간(분, 빈칸 가능) · 메모. 보기와 같은 자리에서 바뀐다.
// 일정 수정 칸(.form)과 같은 생김새. 한글 조합 중 Enter 는 무시. Esc 는 취소(화면 쪽에서).

import type { KeyboardEvent } from "react";
import { EST_MAX, EST_MIN, NOTE_MAX, TASK_TITLE_MAX } from "../../../lib/schedule";
import { Icon } from "../Icon";

export type TaskDraft = { title: string; due: string; est: string; note: string };

const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

export function TaskForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: TaskDraft;
  onChange: (d: TaskDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (p: Partial<TaskDraft>) => onChange({ ...draft, ...p });
  return (
    <form
      className="form"
      aria-label="할 일 수정"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <input
        className="ttl"
        value={draft.title}
        placeholder="제목"
        aria-label="제목"
        maxLength={TASK_TITLE_MAX}
        autoFocus
        onChange={(e) => set({ title: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && composing(e)) e.preventDefault();
        }}
      />
      <div className="f">
        <Icon name="flag" />
        <div className="line">
          <input type="date" className="pill num" value={draft.due} aria-label="마감" onChange={(e) => set({ due: e.target.value })} />
          {draft.due !== "" && (
            <button type="button" className="iconbtn clr" aria-label="마감 지우기" title="마감 지우기" onClick={() => set({ due: "" })}>
              <Icon name="x" />
            </button>
          )}
        </div>
      </div>
      <div className="f">
        <Icon name="clock" />
        <div className="line">
          <label className="unit">
            <input
              className="txt-in"
              inputMode="numeric"
              aria-label={`걸릴 시간(분, ${EST_MIN}~${EST_MAX})`}
              value={draft.est}
              onChange={(e) => set({ est: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) })}
            />
            분
          </label>
        </div>
      </div>
      <div className="f">
        <Icon name="memo" />
        <textarea className="memo" placeholder="메모" aria-label="메모" maxLength={NOTE_MAX} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
      <div className="form-acts">
        <button type="submit" className="btn save">
          완료
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
