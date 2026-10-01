"use client";

// 할 일 수정 칸 (docs/플래너.md 3장 · 7장): 제목 · 마감(날짜 또는 '일정으로') · 걸릴 시간 · 지점 칩 · 역할 칩 ·
// 반복(안 함 / 매일 / 매주 + 요일, 마감까지 며칠) · 체크 항목(한 줄에 하나) · 메모. 보기와 같은 자리에서 바뀐다.
// 지점을 고르면 그 지점의 역할이 들어간다 — 역할 칩을 직접 누른 뒤에는 덮지 않는다(7-11).
// 일정 수정 칸(.form)과 같은 생김새. 반복에서 온 할 일을 고치면 '이번만 / 앞으로도' 를 고른다.
// 한글 조합 중 Enter 는 무시. Esc 는 취소(화면 쪽에서).

import { useState, type KeyboardEvent } from "react";
import { EST_MAX, EST_MIN, NOTE_MAX, TASK_TITLE_MAX, weekday, type DateStr, type Place, type Role } from "../../../lib/schedule";
import { dateLabel, draftWithPlace, draftWithRole, parseChecks, taskScopes, type DueOption, type RepeatKind, type TaskDraft, type TaskScope } from "../../_logic/planner";
import { WEEKDAYS } from "../../_logic/schedule";
import { Icon } from "../Icon";
import { PlaceSymbol } from "../schedule/PlaceSymbol";

const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

export function TaskForm({
  draft,
  base,
  today,
  places,
  roles,
  loadDueOptions,
  onChange,
  onSave,
  onCancel,
}: {
  draft: TaskDraft;
  /** 고치기 전 값 — 무엇을 바꿨는지로 저장 범위를 정한다 */
  base: TaskDraft;
  today: DateStr;
  /** 고를 수 있는 지점 (지운 지점은 이미 붙어 있을 때만) */
  places: Place[];
  roles: Role[];
  /** 마감으로 고를 일정 회차 (오늘부터 60일) */
  loadDueOptions: () => Promise<DueOption[]>;
  onChange: (d: TaskDraft) => void;
  onSave: (scope: TaskScope | null) => void;
  onCancel: () => void;
}) {
  const set = (p: Partial<TaskDraft>) => onChange({ ...draft, ...p });
  const [options, setOptions] = useState<DueOption[] | null>(null);
  const [picking, setPicking] = useState(false);
  const scopes = taskScopes(draft, base);
  const shown = places.filter((p) => !p.deleted || p.id === draft.place_id);
  const checkIssue = parseChecks(draft.checks).issue;

  function togglePick() {
    if (picking) {
      setPicking(false);
      return;
    }
    setPicking(true);
    if (options === null) void loadDueOptions().then(setOptions, () => setOptions([]));
  }
  function setRepeat(kind: RepeatKind) {
    set({ repeat: kind, days: kind === "weekly" && draft.days.length === 0 ? [weekday(today)] : draft.days });
  }
  function toggleDay(d: number) {
    set({ days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort((a, b) => a - b) });
  }

  return (
    <form
      className="form"
      aria-label="할 일 수정"
      onSubmit={(e) => {
        e.preventDefault();
        if (scopes.length === 0) onSave(null);
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
      <div className="f">
        <Icon name="pin" />
        <div className="chips" role="group" aria-label="지점">
          {shown.map((p) => (
            <button type="button" key={p.id} className={`chip pc-${p.color}`} aria-pressed={draft.place_id === p.id} onClick={() => onChange(draftWithPlace(draft, p, roles))}>
              <PlaceSymbol symbol={p.symbol} />
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
      <div className="f">
        <Icon name="repeat" />
        <div className="v">
          <div className="chips" role="group" aria-label="반복">
            <button type="button" className="chip" aria-pressed={draft.repeat === "none"} onClick={() => setRepeat("none")}>
              안 함
            </button>
            {base.repeat === "event" ? (
              <button type="button" className="chip" aria-pressed={draft.repeat === "event"} onClick={() => setRepeat("event")}>
                일정 끝나면
              </button>
            ) : (
              <>
                <button type="button" className="chip" aria-pressed={draft.repeat === "daily"} onClick={() => setRepeat("daily")}>
                  매일
                </button>
                <button type="button" className="chip" aria-pressed={draft.repeat === "weekly"} onClick={() => setRepeat("weekly")}>
                  매주
                </button>
              </>
            )}
          </div>
          {draft.repeat === "weekly" && (
            <div className="chips days" role="group" aria-label="요일">
              {WEEKDAYS.map((w, i) => (
                <button type="button" key={w} className="chip" aria-pressed={draft.days.includes(i + 1)} onClick={() => toggleDay(i + 1)}>
                  {w}
                </button>
              ))}
            </div>
          )}
          {draft.repeat !== "none" && (
            <div className="line">
              <label className="unit">
                마감까지
                <input
                  className="txt-in"
                  inputMode="numeric"
                  aria-label="마감까지 며칠 (0~60, 빈칸이면 마감 없음)"
                  value={draft.dueAfter}
                  onChange={(e) => set({ dueAfter: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) })}
                />
                일
              </label>
            </div>
          )}
        </div>
      </div>
      <div className="f">
        <Icon name="select" />
        <div className="v">
          <textarea
            className="memo checks"
            placeholder="체크 항목"
            aria-label="체크 항목 (한 줄에 하나)"
            value={draft.checks}
            onChange={(e) => set({ checks: e.target.value })}
          />
          {checkIssue && <p className="warn-t">{checkIssue}</p>}
        </div>
      </div>
      <div className="f">
        <Icon name="memo" />
        <textarea className="memo" placeholder="메모" aria-label="메모" maxLength={NOTE_MAX} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
      <div className="form-acts">
        {scopes.length === 0 ? (
          <button type="submit" className="btn save">
            완료
          </button>
        ) : (
          <div className={scopes.length === 1 ? "scope one" : "scope"} role="group" aria-label="저장 범위">
            {scopes.includes("once") && (
              <button type="button" onClick={() => onSave("once")}>
                이번만
              </button>
            )}
            <button type="button" onClick={() => onSave("future")}>
              앞으로도
            </button>
          </div>
        )}
        <button type="button" className="ghost" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
