"use client";

// 반복 규칙의 줄 · 보기 · 수정 칸 (docs/플래너.md 7-16 "반복은 따로 섹션").
// 규칙은 보통 할 일 목록에는 안 보이고 플래너의 반복 카드에 산다 — 때가 되면 회차(보통 할 일)를 낳는다.
// 줄: 제목 · 주기(또는 "… 끝날 때마다") · 다음 회차. 누르면 보기: 규칙의 칸 · 단계 틀 · "회차가 생기면 작업대에 올리기" · 수정 · 멈춤 · 지우기.
// 수정 칸은 할 일 수정 칸(.form)과 같은 생김새. 일정에 딸린 규칙은 주기를 못 바꾼다(그 일정이 주기다).

import type { KeyboardEvent } from "react";
import { DUE_AFTER_MAX, EST_MAX, EST_MIN, flatSteps, NOTE_MAX, stepsFromRule, TASK_TITLE_MAX, type DateStr, type Place, type Role, type TaskRule } from "../../../lib/schedule";
import { dateLabel, type RuleDraft } from "../../_logic/planner";
import { duration, WEEKDAYS } from "../../_logic/schedule";
import { Icon } from "../Icon";
import type { MenuBind } from "../useContextMenu";
import { ChecksField, PlaceRoleChips } from "./TaskForm";

const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

/** 반복 카드의 한 줄: ↻ · 제목 · 주기 · 다음 회차(멈췄으면 "멈춤") */
export function RuleLine({
  rule,
  label,
  next,
  selected,
  onPick,
  menu,
}: {
  rule: TaskRule;
  /** "매주 월" · "자료구조 끝날 때마다" */
  label: string;
  /** 다음 회차 날짜. 모르면 null */
  next: DateStr | null;
  selected: boolean;
  onPick: (r: TaskRule) => void;
  menu?: MenuBind;
}) {
  const cls = ["pl-row", "rule", selected && "sel", rule.paused && "paused"].filter(Boolean).join(" ");
  return (
    <li className={cls} data-id={`rule:${rule.id}`} {...menu} onClick={() => onPick(rule)}>
      <span className="rpt" aria-hidden="true">
        <Icon name="repeat" />
      </span>
      <button type="button" className="nm" aria-pressed={selected}>
        {rule.title}
      </button>
      <span className="per">{label}</span>
      <span className="when num">{rule.paused ? "멈춤" : next ? dateLabel(next) : ""}</span>
    </li>
  );
}

export function RuleDetail({
  rule,
  label,
  next,
  place,
  role,
  onBench,
  onEdit,
  onPause,
  onDelete,
}: {
  rule: TaskRule;
  label: string;
  next: DateStr | null;
  place: Place | null;
  role: string | null;
  /** 회차가 생기면 작업대에 올리기 — 바로 켜고 끈다 */
  onBench: (on: boolean) => void;
  onEdit: () => void;
  /** 멈춤(true) · 다시 시작(false) */
  onPause: (paused: boolean) => void;
  onDelete: () => void;
}) {
  const steps = flatSteps(stepsFromRule(rule.checklist));
  return (
    <>
      <div className="dp-h">
        <h2>{rule.title}</h2>
      </div>
      <div className="dp-f">
        <Icon name="repeat" />
        <div>
          {label}
          {rule.due_after !== null && <span className="dim">마감까지 {rule.due_after}일</span>}
        </div>
      </div>
      {(next || rule.paused) && (
        <div className="dp-f">
          <Icon name="cal" />
          <div className="num">{rule.paused ? "멈춤" : dateLabel(next!)}</div>
        </div>
      )}
      {rule.est_min !== null && (
        <div className="dp-f">
          <Icon name="clock" />
          <div>{duration(rule.est_min)}</div>
        </div>
      )}
      {place && (
        <div className="dp-f">
          <Icon name="pin" />
          <div>{place.name}</div>
        </div>
      )}
      {role && (
        <div className="dp-f">
          <Icon name="user" />
          <div>{role}</div>
        </div>
      )}
      {steps.length > 0 && (
        <ul className="ck-list tpl" aria-label="단계 틀">
          {steps.map((c) => (
            <li key={c.k} className={c.depth === 1 ? "sub" : undefined}>
              <span className="ck">
                <Icon name="ring" />
                <span>{c.t}</span>
              </span>
              {c.est !== null && <span className="ck-est num">{c.est}분</span>}
            </li>
          ))}
        </ul>
      )}
      {rule.note && (
        <div className="dp-f">
          <Icon name="memo" />
          <div className="memo-t">{rule.note}</div>
        </div>
      )}
      <label className="rule-bench">
        <input type="checkbox" checked={rule.bench} onChange={(e) => onBench(e.target.checked)} />
        회차가 생기면 작업대에 올리기
      </label>
      <div className="dp-acts">
        <button type="button" className="ghost" onClick={onEdit}>
          수정
        </button>
        <button type="button" className="ghost" onClick={() => onPause(!rule.paused)}>
          {rule.paused ? "다시 시작" : "멈춤"}
        </button>
        <button type="button" className="del" onClick={onDelete}>
          지우기
        </button>
      </div>
    </>
  );
}

export function RuleForm({
  draft,
  eventLabel,
  places,
  roles,
  isNew,
  onChange,
  onSave,
  onCancel,
}: {
  draft: RuleDraft;
  /** 일정에 딸린 규칙의 주기 글자 ("자료구조 끝날 때마다") */
  eventLabel: string | null;
  places: Place[];
  roles: Role[];
  /** 할 일에서 "반복으로 만들기" 로 연 새 규칙 */
  isNew: boolean;
  onChange: (d: RuleDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (p: Partial<RuleDraft>) => onChange({ ...draft, ...p });
  const toggleDay = (d: number) => set({ days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort((a, b) => a - b) });
  return (
    <form
      className="form"
      aria-label={isNew ? "반복으로 만들기" : "반복 수정"}
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
        <Icon name="repeat" />
        <div className="v">
          {draft.kind === "event" ? (
            <div className="line">{eventLabel ?? "일정이 끝날 때마다"}</div>
          ) : (
            <div className="chips" role="group" aria-label="반복">
              <button type="button" className="chip" aria-pressed={draft.kind === "daily"} onClick={() => set({ kind: "daily" })}>
                매일
              </button>
              <button type="button" className="chip" aria-pressed={draft.kind === "weekly"} onClick={() => set({ kind: "weekly" })}>
                매주
              </button>
            </div>
          )}
          {draft.kind === "weekly" && (
            <div className="chips days" role="group" aria-label="요일">
              {WEEKDAYS.map((w, i) => (
                <button type="button" key={w} className="chip" aria-pressed={draft.days.includes(i + 1)} onClick={() => toggleDay(i + 1)}>
                  {w}
                </button>
              ))}
            </div>
          )}
          <div className="line">
            <label className="unit">
              마감까지
              <input
                className="txt-in"
                inputMode="numeric"
                aria-label={`마감까지 며칠 (0~${DUE_AFTER_MAX}, 빈칸이면 마감 없음)`}
                value={draft.dueAfter}
                onChange={(e) => set({ dueAfter: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) })}
              />
              일
            </label>
          </div>
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
      <ChecksField value={draft.checks} label="단계 틀" onChange={(checks) => set({ checks })} />
      <div className="f">
        <Icon name="memo" />
        <textarea className="memo" placeholder="메모" aria-label="메모" maxLength={NOTE_MAX} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
      <label className="rule-bench">
        <input type="checkbox" checked={draft.bench} onChange={(e) => set({ bench: e.target.checked })} />
        회차가 생기면 작업대에 올리기
      </label>
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
