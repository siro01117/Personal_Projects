"use client";

// 작업대 종이 (docs/플래너.md 7-13 내용 · 7-15 집중 화면): 지금 하는 할 일 하나를 쪼개며 한다. 집중 화면 한 장 가득, 가운데 맞춤.
// 위: 제목(누르면 플래너의 보기) · 역할 · 걸릴 시간 · "앉은 지 n분"(1분마다, 탭이 숨으면 멈춘다).
// 단계 = 체크 항목: 체크는 바로, 마우스로 끌어 순서(플래너 직접 정렬과 같은 끌기), 줄마다 떼어내기, 맨 아래 빈 줄에 적고 Enter.
// 메모(note): 여러 줄, 벗어나면 저장. 넓으면 단계 · 메모 두 칸을 가운데 묶음으로. 맨 아래 '새 할 일' 한 줄. 단추 끝냄 · 내리기.
// 한글 조합 중 Enter 는 무시. 저장 · 검사는 부르는 쪽(BenchFocus)이 한다.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CHECK_ITEM_MAX, NOTE_MAX, TASK_TITLE_MAX, type CheckItem, type TaskRow } from "../../../lib/schedule";
import { satLabel, satMinutes } from "../../_logic/planner";
import { duration } from "../../_logic/schedule";
import { Icon } from "../Icon";
import { useFlip } from "../motion/useFlip";

const enter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229);
const MINUTE = 60_000;

/** 1분마다 지금 시각. 탭이 숨으면 멈추고, 다시 보이면 바로 맞춘다 */
export function useMinuteClock(initial?: Date): Date {
  const [now, setNow] = useState(() => initial ?? new Date());
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      setNow(new Date());
      if (id === null) id = setInterval(() => setNow(new Date()), MINUTE);
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
  }, []);
  return now;
}

/** 단계마다 FLIP 열쇠: 같은 글자가 여럿이면 몇 번째인지 붙인다 */
function stepKeys(list: readonly CheckItem[]): string[] {
  const seen = new Map<string, number>();
  return list.map((c) => {
    const n = seen.get(c.t) ?? 0;
    seen.set(c.t, n + 1);
    return `${c.t}#${n}`;
  });
}

type Drag = { from: number; to: number };

export function BenchCard({
  task,
  role,
  now: initialNow,
  onOpen,
  onCheck,
  onAddStep,
  onMoveStep,
  onDetach,
  onNote,
  onAddTask,
  onDone,
  onPutDown,
}: {
  task: TaskRow;
  /** 역할 이름 */
  role: string | null;
  /** 시계의 처음 값 (시험용). 없으면 지금 */
  now?: Date;
  onOpen: () => void;
  onCheck: (index: number, done: boolean) => void;
  /** 넣었으면 true — 칸을 비운다 */
  onAddStep: (text: string) => boolean;
  onMoveStep: (from: number, to: number) => void;
  onDetach: (index: number) => void;
  onNote: (note: string | null) => void;
  /** 넣었으면 true — 칸을 비운다 */
  onAddTask: (title: string) => boolean;
  onDone: () => void;
  /** 내리기 */
  onPutDown: () => void;
}) {
  const now = useMinuteClock(initialNow);
  const sat = task.bench_at ? satLabel(satMinutes(task.bench_at, now)) : null;

  const [step, setStep] = useState("");
  const [next, setNext] = useState("");
  const [note, setNote] = useState(task.note ?? "");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // 서버에서 메모가 바뀌면(다른 곳에서 고침) 쓰는 중이 아닐 때만 따라간다
  useEffect(() => {
    if (document.activeElement !== noteRef.current) setNote(task.note ?? "");
  }, [task.id, task.note]);

  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const justDragged = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  useFlip(listRef, "li[data-flip]");

  const keys = stepKeys(task.checklist);
  const order = task.checklist.map((_, i) => i);
  if (drag) {
    order.splice(drag.from, 1);
    order.splice(Math.max(0, Math.min(order.length, drag.to)), 0, drag.from);
  }

  /** 끌어서 순서 바꾸기 — 데스크톱 마우스만, 4px 움직여야 시작. 놓인 자리(offsetTop)로 잰다 */
  function grab(e: ReactPointerEvent<HTMLLIElement>, from: number) {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const sy = e.clientY;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientY - sy) < 4) return;
      if (!started) {
        started = true;
        document.body.classList.add("pl-grabbing");
        setDrag({ from, to: from });
      }
      const ul = listRef.current;
      const rows = [...(ul?.querySelectorAll<HTMLElement>("li[data-i]") ?? [])].filter((el) => el.dataset.i !== String(from));
      const top = ul?.getBoundingClientRect().top ?? 0;
      let to = 0;
      for (const el of rows) if (ev.clientY > top + el.offsetTop + el.offsetHeight / 2) to++;
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
      if (to !== from) onMoveStep(from, to);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  const saveNote = () => {
    const v = note.trim() === "" ? null : note;
    if (v !== task.note) onNote(v);
  };

  return (
    <section className="bn-paper" aria-label="작업대">
      <h1 className="bn-h">
        <button type="button" className="bn-t" onClick={onOpen}>
          {task.title}
        </button>
      </h1>
      <div className="bn-meta">
        {role && <span>{role}</span>}
        {task.est_min !== null && <span className="num">{duration(task.est_min)}</span>}
        {sat && <span className="num">{sat}</span>}
      </div>

      <div className="bn-body">
        <ul className="bn-steps" ref={listRef} aria-label="단계">
          {order.map((i) => {
            const c = task.checklist[i]!;
            return (
              <li key={keys[i]} data-flip={keys[i]} data-i={i} className={drag?.from === i ? "dragging" : undefined} onPointerDown={(e) => grab(e, i)}>
                <button
                  type="button"
                  className={c.done ? "ck on" : "ck"}
                  role="checkbox"
                  aria-checked={c.done}
                  onClick={() => {
                    if (!justDragged.current) onCheck(i, !c.done);
                  }}
                >
                  <Icon name={c.done ? "ring-check" : "ring"} />
                  <span>{c.t}</span>
                </button>
                <button
                  type="button"
                  className="iconbtn bn-cut"
                  aria-label={`${c.t} 떼어내기`}
                  title="떼어내기"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onDetach(i)}
                >
                  <Icon name="cut" />
                </button>
              </li>
            );
          })}
          <li className="bn-new">
            <Icon name="ring" />
            <input
              value={step}
              maxLength={CHECK_ITEM_MAX}
              aria-label="단계 추가"
              enterKeyHint="next"
              onChange={(e) => setStep(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (!enter(e)) return;
                if (onAddStep(step)) setStep("");
              }}
            />
          </li>
        </ul>

        <textarea
          ref={noteRef}
          className="bn-note"
          value={note}
          maxLength={NOTE_MAX}
          aria-label="메모"
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
        />
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
        <button type="button" className="btn" onClick={onDone}>
          끝냄
        </button>
        <button type="button" className="ghost" onClick={onPutDown}>
          내리기
        </button>
      </div>
    </section>
  );
}
