"use client";

// 기록 /planner/log (docs/플래너.md 7-16 "기록을 보는 자리"). 주 단위로 넘기는 표 하나 — 숫자만, 그래프 없음.
// 행 = 할 일(역할 · 지점 옆에), 열 = 월~일, 칸 = 그날 잰 분, 맨 아래 합계 줄, 맨 오른쪽 주 합계.
// 플래너의 정렬이 역할이면 역할별로 묶고 묶음 끝에 소계 줄. 비면 "없음". 가운데 기둥 960.
// 데이터는 플래너와 같은 것(할 일 · 역할 · 지점) + 그 주의 기록(ez_work_week). 줄을 누르면 그 할 일의 보기(플래너).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { addDays, DEFAULT_SETTINGS, type WorkDay } from "../../../lib/schedule";
import { logMenu } from "../../_logic/menus";
import { logDayLabel, NONE_LABEL, weekTable, type LogTable } from "../../_logic/planner";
import { mondayOf, nowIn, weekTitle } from "../../_logic/schedule";
import { useApp } from "../AppContext";
import { Icon } from "../Icon";
import { HomeButton } from "../Shell";
import { ThemeToggle } from "../ThemeToggle";
import { toEntries, useContextMenu, type MenuBind } from "../useContextMenu";
import { readSort } from "./sortPref";
import { usePlannerData } from "./usePlannerData";

/** 칸의 숫자: 0 이면 비운다 */
const cell = (n: number) => (n > 0 ? n : "");

/** 표: 행 = 할 일(역할 · 지점 옆에) 또는 역할 소계, 열 = 월~일 + 합계, 맨 아래 합계 줄. 숫자만 */
export function LogTableView({ table, hrefOf, menuOf }: { table: LogTable; hrefOf: (taskId: string) => string; menuOf?: (taskId: string) => MenuBind }) {
  return (
    <div className="lg-paper">
      <table className="lg-table">
        <thead>
          <tr>
            <th scope="col" className="t" />
            {table.days.map((d) => {
              // 요일 · 날짜를 따로 — 폰에서는 두 줄로 선다
              const [w, n] = logDayLabel(d).split(" ");
              return (
                <th scope="col" key={d} className="num">
                  <span>{w}</span> <span>{n}</span>
                </th>
              );
            })}
            <th scope="col" className="num sum">
              합계
            </th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) =>
            r.kind === "role" ? (
              <tr key={r.id} className="sub">
                <th scope="row" className="t">
                  {r.label}
                </th>
                {r.cells.map((n, i) => (
                  <td key={i} className="num">
                    {cell(n)}
                  </td>
                ))}
                <td className="num sum">{r.total}</td>
              </tr>
            ) : (
              <tr key={r.id} {...menuOf?.(r.id)}>
                <th scope="row" className="t">
                  <Link href={hrefOf(r.id)}>{r.title}</Link>
                  {(r.role || r.place) && <span className="who">{[r.role, r.place].filter(Boolean).join(" · ")}</span>}
                </th>
                {r.cells.map((n, i) => (
                  <td key={i} className="num">
                    {cell(n)}
                  </td>
                ))}
                <td className="num sum">{r.total}</td>
              </tr>
            ),
          )}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="t">
              합계
            </th>
            {table.sum.cells.map((n, i) => (
              <td key={i} className="num">
                {cell(n)}
              </td>
            ))}
            <td className="num sum">{table.sum.total}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function LogView() {
  const { href, fail, tick } = useApp();
  const router = useRouter();
  const cm = useContextMenu();
  const D = usePlannerData();
  const state = D.state;
  const T = D.T;
  const [monday, setMonday] = useState(() => mondayOf(nowIn(DEFAULT_SETTINGS.tz).date));
  const [week, setWeek] = useState<{ monday: string; rows: WorkDay[] } | null>(null);
  const [byRole] = useState(() => readSort().key === "role");

  useEffect(() => {
    let alive = true;
    T.workWeek(monday).then(
      (rows) => alive && setWeek({ monday, rows }),
      (e) => alive && fail(e),
    );
    return () => {
      alive = false;
    };
  }, [T, monday, fail, tick]);

  const table = useMemo(
    () => (state && week?.monday === monday ? weekTable(week.rows, monday, state.tasks, { roles: state.roles, places: D.places }, byRole) : null),
    [state, week, monday, D.places, byRole],
  );
  const benched = useMemo(() => new Set((state?.tasks ?? []).filter((t) => t.bench_order !== null && t.done_at === null).map((t) => t.id)), [state]);

  return (
    <div className="planner lg page-in">
      <div className="bar-top pl-top">
        <HomeButton />
        <nav className="bl-crumb" aria-label="위치">
          <Link href={href("/planner/bench")}>작업대</Link>
          <Icon name="right" />
          <span aria-current="page">기록</span>
        </nav>
        <ThemeToggle />
      </div>
      <div className="pl-stage">
        <div className="pl-list lg-stage">
          <div className="lg-col">
            <div className="lg-nav">
              <button type="button" className="iconbtn" aria-label="앞 주" title="앞 주" onClick={() => setMonday((m) => addDays(m, -7))}>
                <Icon name="left" />
              </button>
              <h1 className="num">{weekTitle(monday)}</h1>
              <button type="button" className="iconbtn" aria-label="다음 주" title="다음 주" onClick={() => setMonday((m) => addDays(m, 7))}>
                <Icon name="right" />
              </button>
            </div>
            {!table ? null : table.rows.length === 0 ? (
              <p className="pl-none bl-none">{NONE_LABEL}</p>
            ) : (
              <LogTableView
                table={table}
                hrefOf={(id) => href(`/planner?task=${id}`)}
                menuOf={(id) =>
                  cm.bind(`log:${id}`, () =>
                    toEntries(logMenu({ benched: benched.has(id) }), (act) => router.push(href(act === "focus" ? `/planner/bench/${id}` : `/planner?task=${id}`))),
                  )
                }
              />
            )}
          </div>
        </div>
      </div>
      {cm.node}
    </div>
  );
}
