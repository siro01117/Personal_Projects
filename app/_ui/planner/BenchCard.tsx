"use client";

// 작업대 종이 (docs/플래너.md 7-13 내용 · 7-15 집중 화면 · 7-16 다듬기): 지금 하는 할 일 하나를 쪼개며 한다. 한 장 가득, 가운데 맞춤.
// 머리: 제목(누르면 플래너의 보기) → 얇은 진행 막대 → "걸릴 시간 · 단계 합 · 오늘 · 누적"(있는 것만) → 시작 ↔ 중지(흐르는 12:34).
// 단계 = 체크 항목, 두 단까지. 지금 단계(첫 번째 안 끝난 줄)는 키위 막대 + 진한 글자, 끝낸 줄은 흐리게.
//   줄에 초점: Space 체크(→ 다음 단계로 초점) · Enter 아래 빈 줄 · Tab 들이기 · Shift+Tab 내기 · ↑↓ 옮겨 가기.
//   줄 오른쪽에 걸릴 시간(분) 칸 — 비어 있으면 마우스를 올리거나 초점이 있을 때만 자리가 보인다. 아랫단이 있는 윗단은 아랫단 합(못 적음).
//   마우스로 끌어 순서(윗단은 아랫단째, 아랫단은 같은 윗단 안에서), 줄마다 떼어내기. 끝낸 줄이 8개를 넘으면 접는다.
// 메모(note): 여러 줄, 벗어나면 저장. 안에 http(s) 주소가 있으면 읽기 상태에서 눌린다(다른 곳을 누르면 고치기).
// 맨 아래 '새 할 일' 한 줄. 단추 끝냄(다 체크되면 키위 채움) · 내리기. 한글 조합 중 Enter 는 무시. 저장 · 검사는 부르는 쪽(BenchFocus)이 한다.

import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  canIndent,
  canOutdent,
  CHECK_ITEM_MAX,
  clockText,
  currentStep,
  draftDepth,
  flatSteps,
  liveWork,
  moveStep,
  moveSubStep,
  NOTE_MAX,
  parseStepEst,
  stepProgress,
  TASK_TITLE_MAX,
  toggleStep,
  type FlatStep,
  type TaskRow,
} from "../../../lib/schedule";
import { stepMenu } from "../../_logic/menus";
import { DONE_FOLD, focusMeta, splitLinks } from "../../_logic/planner";
import { Icon } from "../Icon";
import { useFlip } from "../motion/useFlip";
import { toEntries, useContextMenu } from "../useContextMenu";

const enter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229);
const MINUTE = 60_000;
const SECOND = 1000;

/** every 마다 지금 시각. 탭이 숨으면 멈추고, 다시 보이면 바로 맞춘다 */
export function useClock(every: number, initial?: Date): Date {
  const [now, setNow] = useState(() => initial ?? new Date());
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      setNow(new Date());
      if (id === null) id = setInterval(() => setNow(new Date()), every);
    };
    const stop = () => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    const vis = () => (document.visibilityState === "visible" ? start() : stop());
    vis();
    document.addEventListener("visibilitychange", vis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", vis);
    };
  }, [every]);
  return now;
}

/** 1분마다 지금 시각 */
export const useMinuteClock = (initial?: Date) => useClock(MINUTE, initial);

/** 줄마다 FLIP · React 열쇠: 같은 글자가 여럿이면 몇 번째인지 붙인다 (들이기 · 내기로 깊이가 바뀌어도 그대로) */
function stepKeys(rows: readonly FlatStep[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((c) => {
    const n = seen.get(c.t) ?? 0;
    seen.set(c.t, n + 1);
    return `${c.t}#${n}`;
  });
}

/** 끄는 중인 줄: 윗단 i (j = null) 또는 윗단 i 의 아랫단 j. to = 그 줄을 뺀 같은 묶음에서의 자리 */
type Drag = { i: number; j: number | null; to: number; key: string };
/** 그리고 난 뒤 초점을 줄 곳 */
type Focus = { row: number } | { draft: true } | null;

/** 단계 줄의 걸릴 시간 칸(분). 벗어나거나 Enter 면 저장, 틀린 값이면 되돌린다 */
function EstInput({ value, label, onSave }: { value: number | null; label: string; onSave: (est: number | null) => void }) {
  const shown = value === null ? "" : String(value);
  const [text, setText] = useState(shown);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(shown);
  }, [shown]);
  const save = () => {
    const n = parseStepEst(text);
    if (Number.isNaN(n)) setText(shown);
    else if (n !== value) onSave(n);
  };
  return (
    <label className={text === "" ? "bn-est" : "bn-est has"} onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className="num"
        inputMode="numeric"
        value={text}
        aria-label={label}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!(e.nativeEvent.isComposing || e.keyCode === 229)) e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setText(shown);
            e.stopPropagation();
          }
        }}
      />
      분
    </label>
  );
}

export function BenchCard({
  task,
  now: initialNow,
  onOpen,
  onCheck,
  onAddStep,
  onMoveStep,
  onMoveSub,
  onIndent,
  onEst,
  onDetach,
  onDeleteStep,
  onNote,
  onAddTask,
  onStart,
  onStop,
  onDone,
  onPutDown,
}: {
  task: TaskRow;
  /** 시계의 처음 값 (시험용). 없으면 지금 */
  now?: Date;
  onOpen: () => void;
  /** k = 줄 번호(윗단 · 아랫단을 위에서부터 센다) */
  onCheck: (k: number, done: boolean) => void;
  /** after 줄 바로 아래(null 이면 맨 끝)에 depth 깊이로. 넣었으면 그 줄의 번호 — 칸을 비우고 그 아래로 간다 */
  onAddStep: (after: number | null, depth: 0 | 1, text: string) => number | null;
  /** 윗단 from 을 to 자리로 (아랫단째) */
  onMoveStep: (from: number, to: number) => void;
  /** 윗단 i 의 아랫단 from 을 to 자리로 */
  onMoveSub?: (i: number, from: number, to: number) => void;
  /** 들이기(true) · 내기(false) */
  onIndent?: (k: number, into: boolean) => void;
  /** 단계의 걸릴 시간(분). null 이면 지운다 */
  onEst?: (k: number, est: number | null) => void;
  onDetach: (k: number) => void;
  /** 단계 지우기 (우클릭 · 길게 누르기 메뉴) */
  onDeleteStep?: (k: number) => void;
  onNote: (note: string | null) => void;
  /** 넣었으면 true — 칸을 비운다 */
  onAddTask: (title: string) => boolean;
  /** 시간 재기 시작 · 중지 */
  onStart?: () => void;
  onStop?: () => void;
  onDone: () => void;
  /** 내리기 */
  onPutDown: () => void;
}) {
  const running = task.work?.running === true;
  const now = useClock(running ? SECOND : MINUTE, initialNow);
  const live = liveWork(task.work, now.getTime());
  const bits = focusMeta(task, now.getTime());
  const progress = stepProgress(task.checklist);

  const [step, setStep] = useState("");
  const [next, setNext] = useState("");
  /** 빈 줄(적는 칸)이 놓인 자리: 그 줄 바로 아래. null 이면 맨 끝 */
  const [draftAfter, setDraftAfter] = useState<number | null>(null);
  const [draftWant, setDraftWant] = useState<0 | 1>(0);
  const [showDone, setShowDone] = useState(false);
  const [focus, setFocus] = useState<Focus>(null);
  const draftRef = useRef<HTMLInputElement>(null);

  const cm = useContextMenu();
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const justDragged = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  useFlip(listRef, "li[data-flip]");

  const list = drag ? (drag.j === null ? moveStep(task.checklist, drag.i, drag.to) : moveSubStep(task.checklist, drag.i, drag.j, drag.to)) : task.checklist;
  const rows = flatSteps(list);
  const keys = stepKeys(rows);
  const current = currentStep(list);
  const doneCount = rows.filter((r) => r.done).length;
  const folded = doneCount > DONE_FOLD && !showDone;
  /** 접었을 때 숨는 줄: 끝낸 줄 (아랫단이 남은 윗단은 보인다) */
  const hidden = (r: FlatStep) => folded && r.done && !(r.parent && rows.some((s) => s.i === r.i && s.j !== null && !s.done));
  const after = draftAfter !== null && rows[draftAfter] && !hidden(rows[draftAfter]!) ? draftAfter : null;
  const depth = draftDepth(list, after, draftWant);

  // 열면 커서가 지금 단계(없으면 빈 줄)에 — 마우스 · 키보드로 쓰는 화면에서만(폰에서는 자판이 올라오지 않게)
  useEffect(() => {
    if (typeof matchMedia !== "function" || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    setFocus(current === null ? { draft: true } : { row: current });
    // 처음 한 번
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!focus) return;
    if ("draft" in focus) draftRef.current?.focus({ preventScroll: true });
    else listRef.current?.querySelector<HTMLElement>(`[data-step="${focus.row}"]`)?.focus({ preventScroll: true });
    setFocus(null);
  }, [focus]);

  /** 보이는 줄에서 위 · 아래로 */
  function moveFocus(k: number, by: 1 | -1) {
    for (let x = k + by; x >= 0 && x < rows.length; x += by) {
      if (!hidden(rows[x]!)) {
        setFocus({ row: x });
        return;
      }
    }
    if (by === 1) setFocus({ draft: true });
  }

  function check(r: FlatStep) {
    if (justDragged.current) return;
    const done = !r.done;
    onCheck(r.k, done);
    if (!done) return;
    // 체크하면 다음 단계로 초점
    const to = currentStep(toggleStep(task.checklist, r.k, true));
    if (to !== null) setFocus({ row: to });
  }

  function openDraft(r: FlatStep) {
    setDraftAfter(r.k);
    setDraftWant(r.depth);
    setFocus({ draft: true });
  }

  function rowKey(e: KeyboardEvent<HTMLButtonElement>, r: FlatStep) {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      openDraft(r);
    } else if (e.key === "Tab") {
      const can = e.shiftKey ? canOutdent(task.checklist, r.k) : canIndent(task.checklist, r.k);
      if (!can || !onIndent) return;
      e.preventDefault();
      onIndent(r.k, !e.shiftKey);
      setFocus({ row: r.k });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(r.k, e.key === "ArrowDown" ? 1 : -1);
    }
  }

  function draftKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!enter(e)) return;
      const k = onAddStep(after, depth, step);
      if (k === null) return;
      setStep("");
      setDraftAfter(k);
      setDraftWant(depth);
      // 빈 줄이 새 줄 아래로 옮겨 가며 다시 붙는다 — 초점을 이어 준다(Enter 연타)
      setFocus({ draft: true });
      return;
    }
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const want = e.shiftKey ? 0 : 1;
      if (draftDepth(list, after, want) === depth) return; // 못 바꾸면 초점이 넘어간다
      e.preventDefault();
      setDraftWant(want);
    } else if (e.key === "Escape" && after !== null) {
      e.stopPropagation();
      setDraftAfter(null);
      setDraftWant(0);
      setFocus({ draft: true });
    } else if (e.key === "ArrowUp" && step === "") {
      e.preventDefault();
      moveFocus(after === null ? rows.length : after + 1, -1);
    }
  }

  /** 끌어서 순서 바꾸기 — 데스크톱 마우스만, 4px 움직여야 시작. 놓인 자리(offsetTop)로 잰다. 같은 묶음(윗단끼리 · 한 윗단의 아랫단끼리) 안에서만 */
  function grab(e: ReactPointerEvent<HTMLLIElement>, r: FlatStep, key: string) {
    if (e.pointerType !== "mouse" || e.button !== 0 || (e.target as HTMLElement).closest("input")) return;
    const sy = e.clientY;
    const from = r.j === null ? r.i : r.j;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientY - sy) < 4) return;
      if (!started) {
        started = true;
        document.body.classList.add("pl-grabbing");
        setDrag({ i: r.i, j: r.j, to: from, key });
      }
      const ul = listRef.current;
      const group = r.j === null ? 'li[data-depth="0"]' : `li[data-depth="1"][data-i="${r.i}"]`;
      const others = [...(ul?.querySelectorAll<HTMLElement>(group) ?? [])].filter((el) => el.dataset.flip !== key);
      const top = ul?.getBoundingClientRect().top ?? 0;
      let to = 0;
      for (const el of others) if (ev.clientY > top + el.offsetTop + el.offsetHeight / 2) to++;
      setDrag((d) => (d && d.to !== to ? { ...d, to } : d));
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (!started) return;
      document.body.classList.remove("pl-grabbing");
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      const to = dragRef.current?.to ?? from;
      setDrag(null);
      if (to === from) return;
      if (r.j === null) onMoveStep(from, to);
      else onMoveSub?.(r.i, from, to);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  const draft = (
    <li className={depth === 1 ? "bn-new sub" : "bn-new"} key="draft">
      <Icon name="ring" />
      <input
        ref={draftRef}
        value={step}
        maxLength={CHECK_ITEM_MAX}
        aria-label="단계 추가"
        enterKeyHint="next"
        onChange={(e) => setStep(e.target.value)}
        onKeyDown={draftKey}
      />
    </li>
  );

  return (
    <section className="bn-paper" aria-label="작업대">
      <h1 className="bn-h">
        <button type="button" className="bn-t" onClick={onOpen}>
          {task.title}
        </button>
      </h1>
      {progress && (
        <div className="bn-bar" role="progressbar" aria-label="진행" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
          <i style={{ transform: `scaleX(${progress.done / progress.total})` }} />
        </div>
      )}
      <div className="bn-meta">
        {bits.map((b) => (
          <span key={b.key} className={b.over ? "num over" : "num"}>
            {b.text}
          </span>
        ))}
      </div>
      <div className="bn-run">
        {running ? (
          <>
            <button type="button" className="btn" onClick={onStop}>
              중지
            </button>
            <span className="bn-clock num" role="timer">
              {clockText(live.clock ?? 0)}
            </span>
          </>
        ) : (
          <button type="button" className="ghost" onClick={onStart}>
            시작
          </button>
        )}
      </div>

      <div className="bn-body">
        <ul className="bn-steps" ref={listRef} aria-label="단계">
          {doneCount > DONE_FOLD && (
            <li className="bn-fold">
              <button type="button" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                끝낸 <span className="num">{doneCount}</span>
                <Icon name={showDone ? "up" : "down"} />
              </button>
            </li>
          )}
          {rows.map((r) => {
            if (hidden(r)) return null;
            const key = keys[r.k]!;
            const menu = cm.bind(`step:${key}`, () => {
              const items = stepMenu({
                done: r.done,
                canIndent: !!onIndent && canIndent(task.checklist, r.k),
                canOutdent: !!onIndent && canOutdent(task.checklist, r.k),
              });
              return toEntries(onDeleteStep ? items : items.filter((m) => m !== "sep" && m.act !== "delete"), (act) => {
                if (act === "check") onCheck(r.k, !r.done);
                else if (act === "detach") onDetach(r.k);
                else if (act === "indent" || act === "outdent") onIndent?.(r.k, act === "indent");
                else onDeleteStep?.(r.k);
              });
            });
            const cls = [r.depth === 1 && "sub", r.k === current && "cur", drag?.key === key && "dragging"].filter(Boolean).join(" ");
            return (
              <Fragment key={key}>
                <li
                  data-flip={key}
                  data-depth={r.depth}
                  data-i={r.i}
                  className={cls || undefined}
                  {...menu}
                  onPointerDown={(e) => {
                    menu.onPointerDown(e);
                    grab(e, r, key);
                  }}
                >
                  <button
                    type="button"
                    className={r.done ? "ck on" : "ck"}
                    role="checkbox"
                    aria-checked={r.done}
                    aria-current={r.k === current ? "step" : undefined}
                    data-step={r.k}
                    onClick={() => check(r)}
                    onKeyDown={(e) => rowKey(e, r)}
                  >
                    <Icon name={r.done ? "ring-check" : "ring"} />
                    <span>{r.t}</span>
                  </button>
                  {r.parent ? (
                    r.est !== null && <span className="bn-est sum num">{r.est}분</span>
                  ) : (
                    onEst && <EstInput value={r.est} label={`${r.t} 걸릴 시간(분)`} onSave={(est) => onEst(r.k, est)} />
                  )}
                  <button
                    type="button"
                    className="iconbtn bn-cut"
                    aria-label={`${r.t} 떼어내기`}
                    title="떼어내기"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onDetach(r.k)}
                  >
                    <Icon name="cut" />
                  </button>
                </li>
                {after === r.k && draft}
              </Fragment>
            );
          })}
          {after === null && draft}
        </ul>

        <NoteBox key={task.id} note={task.note} onSave={onNote} />
      </div>

      <label className="bn-add">
        <Icon name="plus" />
        <input
          value={next}
          maxLength={TASK_TITLE_MAX}
          aria-label="새 할 일"
          enterKeyHint="done"
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (!enter(e)) return;
            if (onAddTask(next)) setNext("");
          }}
        />
      </label>

      <div className="bn-acts">
        <button type="button" className={progress?.all ? "btn" : "ghost"} onClick={onDone}>
          끝냄
        </button>
        <button type="button" className="ghost" onClick={onPutDown}>
          내리기
        </button>
      </div>
      {cm.node}
    </section>
  );
}

/**
 * 메모: 여러 줄, 벗어나면 저장. 안에 http(s) 주소가 있으면 읽기 상태로 그려 주소가 눌리고(새 창),
 * 주소가 아닌 곳을 누르면 고치기로 바뀐다. 주소가 없으면 늘 적는 칸
 */
function NoteBox({ note, onSave }: { note: string | null; onSave: (note: string | null) => void }) {
  const [text, setText] = useState(note ?? "");
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // 서버에서 메모가 바뀌면(다른 곳에서 고침) 쓰는 중이 아닐 때만 따라간다
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(note ?? "");
  }, [note]);
  const parts = splitLinks(text);
  const linked = parts.some((p) => p.url);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const save = () => {
    setEditing(false);
    const v = text.trim() === "" ? null : text;
    if (v !== note) onSave(v);
  };

  if (linked && !editing) {
    return (
      <div
        className="bn-note read"
        role="textbox"
        aria-label="메모"
        aria-multiline="true"
        tabIndex={0}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("a")) setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {parts.map((p, i) =>
          p.url ? (
            <a key={i} href={p.url} target="_blank" rel="noopener noreferrer">
              {p.text}
            </a>
          ) : (
            <Fragment key={i}>{p.text}</Fragment>
          ),
        )}
      </div>
    );
  }
  return (
    <textarea
      ref={ref}
      className="bn-note"
      value={text}
      maxLength={NOTE_MAX}
      aria-label="메모"
      rows={2}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={save}
    />
  );
}
