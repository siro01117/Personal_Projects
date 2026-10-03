"use client";

// 할 일 수정 칸 (docs/플래너.md 3장 · 7장): 제목 · 마감(날짜 또는 '일정으로') · 걸릴 시간 · 지점 칩 · 역할 칩 ·
// 체크 항목(한 줄에 하나, 들여 쓰면 아랫단) · 메모. 보기와 같은 자리에서 바뀐다.
// 반복 설정은 여기 없다 — 반복 카드의 규칙에서 한다(7-16). 반복에서 온 회차를 고치면 그 회차만 바뀐다.
// 지점을 고르면 그 지점의 역할이 들어간다 — 역할 칩을 직접 누른 뒤에는 덮지 않는다(7-11).
// 일정 수정 칸(.form)과 같은 생김새. 한글 조합 중 Enter 는 무시. Esc 는 취소(화면 쪽에서).

import { useState, type KeyboardEvent } from "react";
import { EST_MAX, EST_MIN, NOTE_MAX, parseStepLines, TASK_TITLE_MAX, type Place, type Role } from "../../../lib/schedule";
import { dateLabel, draftWithPlace, draftWithRole, type DueOption, type TaskDraft } from "../../_logic/planner";
import { Icon } from "../Icon";
import { PlaceDot } from "../schedule/PlaceSymbol";

const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

/** 체크 항목 칸에서 Tab 은 그 줄을 들이고 Shift+Tab 은 낸다 (공백 둘) */
export function indentLine(el: HTMLTextAreaElement, into: boolean): string {
  const v = el.value;
  const at = el.selectionStart;
  const start = v.lastIndexOf("\n", at - 1) + 1;
  if (into) return `${v.slice(0, start)}  ${v.slice(start)}`;
  const lead = /^(\t| {1,2})/.exec(v.slice(start))?.[0].length ?? 0;
  return v.slice(0, start) + v.slice(start + lead);
}

/** 지점 칩 · 역할 칩 (할 일 칸 · 규칙 칸 공용) */
export function PlaceRoleChips<D extends { place_id: string | null; role_id: string | null; roleManual: boolean }>({
  draft,
  places,
  roles,
  onChange,
}: {
  draft: D;
  places: Place[];
  roles: Role[];
  onChange: (d: D) => void;
}) {
  const shown = places.filter((p) => !p.deleted || p.id === draft.place_id);
  return (
    <>
      <div className="f">
        <Icon name="pin" />
        <div className="chips" role="group" aria-label="지점">
          {shown.map((p) => (
            <button type="button" key={p.id} className={`chip pc-${p.color}`} aria-pressed={draft.place_id === p.id} onClick={() => onChange(draftWithPlace(draft, p, roles))}>
              <PlaceDot />
              {p.name}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={draft.place_id === null} onClick={() => onChange(draftWithPlace(draft, null, roles))}>
            없음
          </button>
        </div>
      </div>
      {(roles.length > 0 || draft.role_id !== null) && (
        <div className="f">
          <Icon name="user" />
          <div className="chips" role="group" aria-label="역할">
            {roles.map((r) => (
              <button type="button" key={r.id} className="chip" aria-pressed={draft.role_id === r.id} onClick={() => onChange(draftWithRole(draft, r.id))}>
                {r.name}
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={draft.role_id === null} onClick={() => onChange(draftWithRole(draft, null))}>
              없음
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** 체크 항목 · 단계 틀 칸: 한 줄에 하나, Tab 으로 들이면 아랫단 */
export function ChecksField({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  const issue = parseStepLines(value).issue;
  return (
    <div className="f">
      <Icon name="select" />
      <div className="v">
        <textarea
          className="memo checks"
          placeholder={label}
          aria-label={`${label} (한 줄에 하나, 들여 쓰면 아랫단)`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Tab" || composing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            const el = e.currentTarget;
            const at = el.selectionStart;
            const next = indentLine(el, !e.shiftKey);
            const shift = next.length - el.value.length;
            onChange(next);
            requestAnimationFrame(() => el.setSelectionRange(Math.max(0, at + shift), Math.max(0, at + shift)));
          }}
        />
        {issue && <p className="warn-t">{issue}</p>}
      </div>
    </div>
  );
}

export function TaskForm({
  draft,
  places,
  roles,
  loadDueOptions,
  onChange,
  onSave,
  onCancel,
}: {
  draft: TaskDraft;
  /** 고를 수 있는 지점 (지운 지점은 이미 붙어 있을 때만) */
  places: Place[];
  roles: Role[];
  /** 마감으로 고를 일정 회차 (오늘부터 60일) */
  loadDueOptions: () => Promise<DueOption[]>;
  onChange: (d: TaskDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (p: Partial<TaskDraft>) => onChange({ ...draft, ...p });
  const [options, setOptions] = useState<DueOption[] | null>(null);
  const [picking, setPicking] = useState(false);

  function togglePick() {
    if (picking) {
      setPicking(false);
      return;
    }
    setPicking(true);
    if (options === null) void loadDueOptions().then(setOptions, () => setOptions([]));
  }

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
        <div className="v">
          <div className="line">
            {draft.dueEvent ? (
              <span className="pill due-ev">
                <span className="num">{draft.due ? dateLabel(draft.due) : ""}</span>
                <span className="t">{draft.dueEvent.title}</span>
              </span>
            ) : (
              <input type="date" className="pill num" value={draft.due} aria-label="마감" onChange={(e) => set({ due: e.target.value })} />
            )}
            {(draft.due !== "" || draft.dueEvent) && (
              <button type="button" className="iconbtn clr" aria-label="마감 지우기" title="마감 지우기" onClick={() => set({ due: "", dueEvent: null })}>
                <Icon name="x" />
              </button>
            )}
            <button type="button" className="chip" aria-pressed={picking} aria-expanded={picking} onClick={togglePick}>
              일정으로
            </button>
          </div>
          {picking && options !== null && (
            <ul className="due-opts" aria-label="마감으로 삼을 일정">
              {options.length === 0 && <li className="none">60일 안에 일정이 없습니다</li>}
              {options.map((o) => (
                <li key={o.key}>
                  <button
                    type="button"
                    aria-pressed={draft.dueEvent?.id === o.event_id && draft.due === o.due}
                    onClick={() => {
                      set({ due: o.due, dueEvent: { id: o.event_id, title: o.title } });
                      setPicking(false);
                    }}
                  >
                    <span className="t">{o.title}</span>
                    <span className="num">{dateLabel(o.date)}</span>
                  </button>
                </li>
              ))}
            </ul>
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
      <PlaceRoleChips draft={draft} places={places} roles={roles} onChange={onChange} />
      <ChecksField value={draft.checks} label="체크 항목" onChange={(checks) => set({ checks })} />
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
