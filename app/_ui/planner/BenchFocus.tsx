"use client";

// 집중 화면 /planner/bench/[id] (docs/플래너.md 7-15). 작업대 종이(BenchCard) 한 장을 화면 가운데에 — 가로 가운데, 최대 폭 960, 위 여백 넉넉히.
// 열면 앉는다(ez_task_sit — 안 올라가 있으면 올라간다). 종이 양옆 바깥에 작은 ‹ ›(올린 순서), 위에 목록으로 가는 길 하나.
// 좁아서 양옆에 자리가 없으면 ‹ › 는 위 줄 오른쪽으로 간다. 끝냄 · 내리기 뒤에는 목록으로.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { benchList, benchSides, moveStep, NONE_LABEL, roleText } from "../../_logic/planner";
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

  // 열면 앉는다 — 이 화면에서 한 번 (다른 집중 화면을 열면 앉는 자리가 옮겨 간다)
  const sat = useRef<string | null>(null);
  useEffect(() => {
    if (!task || !open || isTemp(task.id) || sat.current === task.id) return;
    sat.current = task.id;
    ops.sit(task);
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
                role={roleText(task, state.roles)}
                onOpen={() => router.push(href(`/planner?task=${task.id}`))}
                onCheck={(i, done) => ops.check(task, i, done)}
                onAddStep={(text) => ops.addBenchStep(task, text)}
                onMoveStep={(from, to) => void ops.editSteps(task, (l) => moveStep(l, from, to))}
                onDetach={(i) => void ops.detach(task, i)}
                onDeleteStep={(i) => void ops.removeStep(task, i)}
                onNote={(note) => ops.saveNote(task, note)}
                onAddTask={ops.addTask}
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
