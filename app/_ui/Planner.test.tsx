// 플래너 화면 조각 (docs/플래너.md 7-13 · 7-14 · 7-15): 카드 넷의 자리(비어도 그대로) · 할 일 카드 첫 줄 추가 칸 · 위쪽 줄 ·
// 작업대 목록 카드 · 집중 화면(가운데 묶음) · 역할 필터 칩 · 작업대 표시 · 홈 타일.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Role, TaskRow } from "../../lib/schedule";
import { HomeTiles } from "./HomeView";
import { BenchCard } from "./planner/BenchCard";
import { BenchItem } from "./planner/BenchList";
import { PlannerBar, PlannerCards } from "./planner/PlannerCards";
import { RoleFilter } from "./planner/RoleFilter";
import { TaskLine } from "./planner/TaskLine";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => {};
const yes = () => true;

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  title: "상법 내용 정리",
  note: null,
  due: null,
  est_min: null,
  sort: 0,
  done_at: null,
  origin_kind: null,
  origin_id: null,
  place_id: null,
  due_event_id: null,
  checklist: [],
  rule_id: null,
  rule_date: null,
  role_id: null,
  bench_order: null,
  bench_at: null,
  version: 1,
  created_at: "2026-10-04T00:00:00Z",
  updated_at: "2026-10-04T00:00:00Z",
  ...over,
});

describe("카드 자리 고정 (7-14)", () => {
  it("넷이 다 비어도 제목 + '없음' 으로 자리를 지킨다. 왼쪽 지남 → 할 일, 오른쪽 시간 정함 → 끝냄", () => {
    const html = renderToStaticMarkup(
      <PlannerCards count={{ late: 0, open: 0, timed: 0, done: 0 }} body={() => "줄"} showDone={false} onFold={noop} />,
    );
    expect(text(html)).toBe("지남 없음 할 일 없음 시간 정함 없음 끝냄 없음");
    expect(html).toContain('class="pl-cols two"');
    const cols = html.split('<div class="pl-col">').slice(1);
    expect(cols).toHaveLength(2);
    expect(text(cols[0]!)).toBe("지남 없음 할 일 없음");
    expect(text(cols[1]!)).toBe("시간 정함 없음 끝냄 없음");
    expect(html).not.toContain("줄");
  });

  it("있는 카드만 줄을 그리고 개수를 단다. 끝냄은 접힌 채 개수만", () => {
    const html = renderToStaticMarkup(
      <PlannerCards count={{ late: 0, open: 2, timed: 0, done: 3 }} body={(k) => `[${k}]`} showDone={false} onFold={noop} />,
    );
    expect(text(html)).toBe("지남 없음 할 일 2 [open] 시간 정함 없음 끝냄 3");
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("할 일 추가 칸 · 작업대 링크 (7-15)", () => {
  const add = <label className="pl-new">추가칸</label>;
  const link = <a href="/planner/bench">작업대 2</a>;

  it("추가 칸은 할 일 카드의 첫 줄 — 줄들보다 앞, 비어도 있다", () => {
    const html = renderToStaticMarkup(
      <PlannerCards count={{ late: 1, open: 2, timed: 0, done: 0 }} body={(k) => `[${k}]`} showDone={false} onFold={noop} addRow={add} />,
    );
    expect(text(html)).toBe("지남 1 [late] 할 일 2 추가칸 [open] 시간 정함 없음 끝냄 없음");
    const empty = renderToStaticMarkup(
      <PlannerCards count={{ late: 0, open: 0, timed: 0, done: 0 }} body={() => "줄"} showDone={false} onFold={noop} addRow={add} />,
    );
    expect(text(empty)).toBe("지남 없음 할 일 추가칸 없음 시간 정함 없음 끝냄 없음");
  });

  it("할 일 카드 머리 오른쪽에 작업대 링크 (안 주면 없다)", () => {
    const html = renderToStaticMarkup(
      <PlannerCards count={{ late: 0, open: 1, timed: 0, done: 0 }} body={(k) => `[${k}]`} showDone={false} onFold={noop} addRow={add} benchLink={link} />,
    );
    expect(html).toContain('<div class="pl-hrow"><h2 class="pl-h">할 일<span class="num">1</span></h2><a href="/planner/bench">작업대 2</a></div>');
    const none = renderToStaticMarkup(<PlannerCards count={{ late: 0, open: 1, timed: 0, done: 0 }} body={(k) => `[${k}]`} showDone={false} onFold={noop} />);
    expect(none).not.toContain("pl-hrow");
  });

  it("위쪽 줄에는 홈 · 밝기 전환만 — 추가 칸이 없다", () => {
    const html = renderToStaticMarkup(<PlannerBar home={<a className="mhome">홈</a>} />);
    expect(html).toContain('class="bar-top pl-top"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("할 일 추가");
    expect(html.match(/<(a|button)\b/g)).toHaveLength(2);
  });
});

describe("작업대 집중 화면의 종이 (7-13 내용 · 7-15)", () => {
  const t = task({
    est_min: 90,
    place_id: "p1",
    note: "판례는 뒤로",
    bench_order: 1,
    bench_at: "2026-10-04T01:00:00Z",
    checklist: [
      { t: "1장 읽기", done: true },
      { t: "요약 쓰기", done: false },
    ],
  });
  const render = (over: Partial<TaskRow> = {}, role: string | null = "대학", now = "2026-10-04T01:40:00Z") =>
    renderToStaticMarkup(
      <BenchCard
        task={{ ...t, ...over }}
        role={role}
        now={new Date(now)}
        onOpen={noop}
        onCheck={noop}
        onAddStep={yes}
        onMoveStep={noop}
        onDetach={noop}
        onNote={noop}
        onAddTask={yes}
        onDone={noop}
        onPutDown={noop}
      />,
    );

  it("제목 · 역할 · 걸릴 시간 · 앉은 지 n분 · 단계(체크) · 메모 · 새 할 일 · 끝냄 · 내리기", () => {
    const html = render();
    expect(text(html)).toBe("상법 내용 정리 대학 1시간 30분 앉은 지 40분 1장 읽기 요약 쓰기 판례는 뒤로 끝냄 내리기");
    expect(html).toContain('aria-label="작업대"');
    expect(html).not.toContain('title="학교"'); // 지점 점은 없다
    expect(html.match(/role="checkbox"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?1장 읽기/);
    expect(html).toContain('aria-label="1장 읽기 떼어내기"');
    expect(html).toContain('aria-label="단계 추가"');
    expect(html).toContain('aria-label="새 할 일"');
  });

  it("제목은 h1, 단계 · 메모는 한 묶음(.bn-body) 안에 — 종이 안에서 가운데 묶음", () => {
    const html = render();
    expect(html).toMatch(/<h1 class="bn-h"><button[^>]*class="bn-t"[^>]*>상법 내용 정리<\/button><\/h1>/);
    const body = html.slice(html.indexOf('<div class="bn-body">'));
    expect(body.indexOf('class="bn-steps"')).toBeGreaterThan(0);
    expect(body.indexOf('class="bn-note"')).toBeGreaterThan(body.indexOf('class="bn-steps"'));
    expect(body.indexOf('class="bn-add"')).toBeGreaterThan(body.indexOf("</textarea></div>"));
  });

  it("단계가 없어도 빈 줄 하나는 있다. 역할 · 걸릴 시간이 없으면 그 칸은 없다", () => {
    const html = render({ est_min: null, checklist: [], note: null }, null, "2026-10-04T01:00:20Z");
    expect(text(html)).toBe("상법 내용 정리 방금 앉음 끝냄 내리기");
    expect(html).not.toContain('role="checkbox"');
    expect(html).toContain('aria-label="단계 추가"');
  });

  it("CSS: 종이는 가로 가운데(최대 폭 960), 제목 · 정보 줄 가운데 맞춤, 두 칸 묶음 · 단추도 가운데", () => {
    const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.bf-col\{max-width:960px;margin:0 auto;/);
    expect(css).toMatch(/\.bn-h\{[^}]*justify-content:center/);
    expect(css).toMatch(/\.bn-t\{[^}]*text-align:center/);
    expect(css).toMatch(/\.bn-meta\{[^}]*justify-content:center/);
    expect(css).toMatch(/\.bn-body\{[^}]*margin:28px auto 0/);
    expect(css).toMatch(/\.bn-body\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
    expect(css).toMatch(/\.bn-acts\{[^}]*justify-content:center/);
  });
});

describe("작업대 목록 카드 (7-15)", () => {
  const t = task({
    id: "b1",
    est_min: 120,
    note: "\n스케줄링은 7장부터\n제출은 PDF",
    bench_order: 2,
    checklist: [
      { t: "문제 1", done: true },
      { t: "문제 2", done: false },
      { t: "보고서", done: false },
    ],
  });
  const card = (over: Partial<TaskRow> = {}, role: string | null = "대학") =>
    renderToStaticMarkup(<BenchItem task={{ ...t, ...over }} role={role} now={new Date("2026-10-04T01:40:00Z")} href="/planner/bench/b1" onOff={noop} />);

  it("제목 · 역할 · 걸릴 시간 · 단계 진행 · 메모 첫 줄 · 내리기, 누르면 집중 화면", () => {
    const html = card();
    expect(text(html)).toBe("상법 내용 정리 대학 2시간 1/3 스케줄링은 7장부터 내리기");
    expect(html).toContain('href="/planner/bench/b1"');
    expect(html).toContain('data-id="b1"');
    expect(html).not.toContain("앉은 지");
  });

  it("앉아 있으면 앉은 지 n분. 없는 칸은 그리지 않는다", () => {
    expect(text(card({ bench_at: "2026-10-04T01:00:00Z" }))).toBe("상법 내용 정리 대학 2시간 1/3 앉은 지 40분 스케줄링은 7장부터 내리기");
    expect(text(card({ est_min: null, checklist: [], note: null }, null))).toBe("상법 내용 정리 내리기");
  });
});

describe("홈 타일 (7-15)", () => {
  it("플래너 옆에 작업대 — /planner/bench 로", () => {
    const html = renderToStaticMarkup(<HomeTiles demo={false} unread={0} />);
    expect(text(html)).toMatch(/^일정 플래너 작업대 보고서 서랍/);
    expect(html).toContain('<a class="tile t-bench" href="/planner/bench">');
    expect(renderToStaticMarkup(<HomeTiles demo unread={0} />)).toContain('href="/planner/bench?demo=1"');
  });
});

describe("역할 필터 (7-14)", () => {
  const roles: Role[] = [
    { id: "r1", name: "대학", from_place: "school", sort: 1, version: 1 },
    { id: "r2", name: "강사", from_place: "work", sort: 2, version: 1 },
  ];

  it("둘째 단: 역할마다 칩 + 맨 뒤 역할 없음 + 역할 편집 연필. 라벨 글자 없음", () => {
    const html = renderToStaticMarkup(<RoleFilter roles={roles} off={[]} onToggle={noop} editing={false} onEdit={noop} />);
    expect(text(html)).toBe("대학 강사 역할 없음");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect(html).toMatch(/역할 없음<\/button><button[^>]*aria-label="역할 편집"/);
    expect(html).not.toContain('role="checkbox"');
  });

  it("끈 칩만 aria-pressed=false. 역할 편집이 열리면 연필이 펼침 상태", () => {
    const html = renderToStaticMarkup(<RoleFilter roles={roles} off={["r2", "none"]} onToggle={noop} editing onEdit={noop} />);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="false"[^>]*>강사</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>역할 없음</);
    expect(html).toContain('aria-expanded="true"');
  });
});

describe("작업대에 올라간 줄", () => {
  it("줄 앞에 작은 표시 하나(글자 없이)", () => {
    const line = (benched: boolean) =>
      renderToStaticMarkup(<TaskLine task={task()} today="2026-10-04" selected={false} benched={benched} onToggle={noop} onPick={noop} />);
    expect(line(true)).toContain('class="bn-mark"');
    expect(line(false)).not.toContain("bn-mark");
    expect(text(line(true))).toBe(text(line(false)));
  });
});
