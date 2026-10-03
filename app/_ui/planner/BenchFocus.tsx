"use client";

// 집중 화면 /planner/bench/[id] (docs/플래너.md 7-15 · 7-16). 작업대 종이(BenchCard) 한 장을 화면 가운데에 — 가로 가운데, 최대 폭 960, 위 여백 넉넉히.
// 열어도 시간은 가지 않는다 — 시작을 눌러야 간다(다른 할 일에서 돌던 것은 그때 멈춘다). 안 올라가 있던 할 일을 열면 작업대에 올린다.
// 종이 양옆 바깥에 작은 ‹ ›(올린 순서), 위에 목록으로 가는 길 하나. 좁아서 양옆에 자리가 없으면 ‹ › 는 위 줄 오른쪽으로 간다.
// 끝냄 · 내리기 뒤에는 목록으로.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { moveStep, moveSubStep } from "../../../lib/schedule";
import { benchList, benchSides, NONE_LABEL } from "../../_logic/planner";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { HomeButton } from "../Shell";
import { BenchCard } from "./BenchCard";
import { isTemp, useTaskOps } from "./useTaskOps";
import { usePlannerData } from "./usePlannerData";

export function BenchFocus({ id }: { id: string }) {
  const { href } = useApp();
  const router = useRouter();
  const D = usePlannerData();
  const ops = useTaskOps(D);
  const state = D.state;
  const task = state?.tasks.find((t) => t.id === id) ?? null;
  const open = task !== null && task.done_at === null;
  const list = useMemo(() => benchList(state?.tasks ?? []), [state]);
  const { prev, next } = benchSides(list, id);
  const toList = href("/planner/bench");

  // 주소로 바로 연 할 일이 아직 안 올라가 있으면 올린다 — 이 화면에서 한 번 (내린 뒤에는 목록으로 나간다)
  const raised = useRef<string | null>(null);
  useEffect(() => {
    if (!task || !open || isTemp(task.id) || raised.current === task.id) return;
    raised.current = task.id;
    if (task.bench_order === null) void ops.bench(task, true);
  }, [task, open, ops]);

  const nav = (cls: string) => (
    <div className={cls}>
      {prev ? (
        <Link className="iconbtn bf-go" href={href(`/planner/bench/${prev}`)} aria-label="앞 작업대" title="앞 작업대">
          <Icon name="left" />
        </Link>
      ) : (
        <span className="iconbtn bf-go" aria-hidden="true" />
      )}
      {next ? (
        <Link className="iconbtn bf-go" href={href(`/planner/bench/${next}`)} aria-label="다음 작업대" title="다음 작업대">
          <Icon name="right" />
        </Link>
      ) : (
        <span className="iconbtn bf-go" aria-hidden="true" />
      )}
    </div>
  );

  return (
    <div className="planner bf page-in" key={id}>
      <div className="bf-scroll">
        <div className="bf-col">
          <div className="bf-top">
            <HomeButton />
            <Link className="bf-back" href={toList}>
              <Icon name="left" />
              작업대
            </Link>
            {open && list.length > 1 && nav("bf-nav")}
          </div>
          {!state ? null : !task || !open ? (
            <p className="pl-none bf-none">{NONE_LABEL}</p>
          ) : (
            <div className="bf-stage">
              {list.length > 1 && (
                <>
                  {prev && (
                    <Link className="iconbtn bf-side prev" href={href(`/planner/bench/${prev}`)} aria-label="앞 작업대" title="앞 작업대">
                      <Icon name="left" />
                    </Link>
                  )}
                  {next && (
                    <Link className="iconbtn bf-side next" href={href(`/planner/bench/${next}`)} aria-label="다음 작업대" title="다음 작업대">
                      <Icon name="right" />
                    </Link>
                  )}
                </>
              )}
              <BenchCard
                key={task.id}
                task={task}
                onOpen={() => router.push(href(`/planner?task=${task.id}`))}
                onCheck={(k, done) => ops.check(task, k, done)}
                onAddStep={(after, depth, text) => ops.addStep(task, after, depth, text)}
                onMoveStep={(from, to) => void ops.editSteps(task, (l) => moveStep(l, from, to))}
                onMoveSub={(i, from, to) => void ops.editSteps(task, (l) => moveSubStep(l, i, from, to))}
                onIndent={(k, into) => ops.indent(task, k, into)}
                onEst={(k, est) => ops.setEst(task, k, est)}
                onDetach={(k) => void ops.detach(task, k)}
                onDeleteStep={(k) => void ops.removeStep(task, k)}
                onNote={(note) => ops.saveNote(task, note)}
                onAddTask={ops.addTask}
                onStart={() => ops.workStart(task)}
                onStop={ops.workStop}
                onDone={() => {
                  void ops.toggle(task);
                  router.push(toList);
                }}
                onPutDown={() => {
                  void ops.bench(task, false);
                  router.push(toList);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
