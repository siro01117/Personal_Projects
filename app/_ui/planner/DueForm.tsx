"use client";

// 마감 바꾸기 (지남 묶음의 지난 마감): 날짜 하나만 고친다. 일정에 딸린 마감이었으면 연결은 끊긴다.

import type { TaskRow } from "../../../lib/schedule";
import { Icon } from "../Icon";

export function DueForm({
  task,
  due,
  onChange,
  onSave,
  onCancel,
}: {
  task: TaskRow;
  due: string;
  onChange: (due: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="form"
      aria-label="마감 바꾸기"
      onSubmit={(e) => {
        e.preventDefault();
        if (due !== "") onSave();
      }}
    >
      <div className="dp-h">
        <h2>{task.title}</h2>
      </div>
      <div className="f">
        <Icon name="flag" />
        <div className="line">
          <input type="date" className="pill num" value={due} aria-label="마감" required autoFocus onChange={(e) => onChange(e.target.value)} />
        </div>
      </div>
      <div className="form-acts">
        <button type="submit" className="btn save" disabled={due === ""}>
          저장
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
