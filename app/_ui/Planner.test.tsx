// 플래너 화면 조각 (docs/플래너.md 7-13 · 7-14): 카드 넷의 자리(비어도 그대로) · 작업대 카드 · 역할 필터 단추의 점 · 작업대 표시.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Place, Role, TaskRow } from "../../lib/schedule";
import { BenchCard } from "./planner/BenchCard";
import { PlannerCards } from "./planner/PlannerCards";
import { RoleFilter, RoleFilterButton } from "./planner/RoleFilter";
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
      <PlannerCards count={{ late: 0, open: 2, timed: 0, done: 3 }} body={(k) => `[${k}]`} showDone={false} onFold={noop} bench={<i>작업대</i>} />,
    );
    expect(text(html)).toBe("작업대 지남 없음 할 일 2 [open] 시간 정함 없음 끝냄 3");
    expect(html).toContain('aria-expanded="false"');
    // 작업대 카드는 두 열 위에
    expect(html.indexOf("작업대")).toBeLessThan(html.indexOf("pl-cols"));
  });
});

describe("작업대 카드 (7-13)", () => {
  const place: Place = { id: "p1", name: "학교", role: "school", symbol: "school", color: "sky", sort: 1, deleted: false };
  const t = task({
    est_min: 90,
    place_id: "p1",
    note: "판례는 뒤로",
    bench_at: "2026-10-04T01:00:00Z",
    checklist: [
      { t: "1장 읽기", done: true },
      { t: "요약 쓰기", done: false },
    ],
  });
  const render = (over: Partial<TaskRow> = {}) =>
    renderToStaticMarkup(
      <BenchCard
        task={{ ...t, ...over }}
        place={place}
        role="대학"
        now={new Date("2026-10-04T01:40:00Z")}
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

  it("제목 · 역할 · 걸릴 시간 · 앉은 지 n분 · 단계(체크) · 메모 · 새 할 일 · 끝냄 · 내려놓기", () => {
    const html = render();
    expect(text(html)).toBe("상법 내용 정리 대학 1시간 30분 앉은 지 40분 1장 읽기 요약 쓰기 판례는 뒤로 끝냄 내려놓기");
    expect(html).toContain('aria-label="작업대"');
    expect(html).toContain('title="학교"');
    expect(html.match(/role="checkbox"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?1장 읽기/);
    expect(html).toContain('aria-label="1장 읽기 떼어내기"');
    expect(html).toContain('aria-label="요약 쓰기 떼어내기"');
    expect(html).toContain('aria-label="단계 추가"');
    expect(html).toContain('aria-label="새 할 일"');
  });

  it("단계가 없어도 빈 줄 하나는 있다. 역할 · 걸릴 시간이 없으면 그 칸은 없다", () => {
    const html = renderToStaticMarkup(
      <BenchCard
        task={task({ bench_at: "2026-10-04T01:00:00Z" })}
        place={null}
        role={null}
        now={new Date("2026-10-04T01:00:20Z")}
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
    expect(text(html)).toBe("상법 내용 정리 방금 앉음 끝냄 내려놓기");
    expect(html).not.toContain('role="checkbox"');
    expect(html).toContain('aria-label="단계 추가"');
  });
});

describe("역할 필터 (7-14)", () => {
  const roles: Role[] = [
    { id: "r1", name: "대학", from_place: "school", sort: 1, version: 1 },
    { id: "r2", name: "강사", from_place: "work", sort: 2, version: 1 },
  ];

  it("하나라도 끄면 단추에 점", () => {
    const off = renderToStaticMarkup(<RoleFilterButton active={false} open={false} onClick={noop} />);
    const on = renderToStaticMarkup(<RoleFilterButton active open={false} onClick={noop} />);
    expect(text(off)).toBe("역할");
    expect(off).not.toContain('class="dot"');
    expect(on).toContain('class="dot"');
  });

  it("시트: 역할마다 체크 + 역할 없음. 끈 것만 aria-checked=false", () => {
    const html = renderToStaticMarkup(<RoleFilter roles={roles} off={["r2"]} onToggle={noop} />);
    expect(text(html)).toBe("역할 대학 강사 역할 없음");
    expect(html.match(/aria-checked="true"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="false"[^>]*>.*?강사/);
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
