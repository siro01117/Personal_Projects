// 플래너 화면 조각 (docs/플래너.md 7-13 ~ 7-16): 카드의 자리(비어도 그대로) · 할 일 카드 첫 줄 추가 칸 · 위쪽 줄 · 반복 카드 ·
// 작업대 목록 카드 · 가져올 만한 것 패널 · 집중 화면(머리 · 시작/중지 · 단계 두 단) · 기록 표 · 사이드바 · 역할 필터 칩 · 홈 타일.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Role, TaskRow, TaskRule } from "../../lib/schedule";
import { ruleDraft, weekTable } from "../_logic/planner";
import { HomeTiles } from "./HomeView";
import { BenchCard } from "./planner/BenchCard";
import { BenchItem, BenchPicks } from "./planner/BenchList";
import { LogTableView } from "./planner/LogView";
import { PlannerBar, PlannerCards } from "./planner/PlannerCards";
import { RoleFilter } from "./planner/RoleFilter";
import { RuleDetail, RuleForm, RuleLine } from "./planner/RulePanel";
import { TaskDetail } from "./planner/TaskDetail";
import { TaskLine } from "./planner/TaskLine";
import { activeMenu, MENU } from "./Shell";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => {};
const yes = () => true;
const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

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

const rule = (over: Partial<TaskRule> = {}): TaskRule => ({
  id: "r1",
  kind: "cycle",
  title: "주간 정리",
  note: null,
  est_min: 40,
  place_id: null,
  checklist: ["받은 편지함", { t: "일정 확인", sub: ["이번 주", { t: "다음 주", est: 5 }] }],
  repeat: { freq: "weekly", days: [1] },
  start: "2026-09-01",
  event_id: null,
  due_after: 6,
  last_made: "2026-10-05",
  role_id: null,
  bench: false,
  paused: false,
  version: 1,
  ...over,
});

const NOW = "2026-10-04T01:40:00Z";
const work = (over: Partial<NonNullable<TaskRow["work"]>> = {}) => ({ today_sec: 2400, total_sec: 4800, running: false, started_at: null, at: NOW, ...over });

describe("카드 자리 고정 (7-14 · 7-16)", () => {
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

describe("반복 카드 (7-16)", () => {
  const cards = (rules: { count: number; open: boolean }) =>
    renderToStaticMarkup(
      <PlannerCards
        count={{ late: 0, open: 1, timed: 0, done: 0 }}
        body={(k) => `[${k}]`}
        showDone={false}
        onFold={noop}
        rules={{ ...rules, body: () => "[규칙들]", onFold: noop }}
      />,
    );

  it("끝냄 아래 자리 고정 — 비어도 '반복 없음'. 오른쪽 열의 맨 아래", () => {
    const html = cards({ count: 0, open: false });
    expect(text(html)).toBe("지남 없음 할 일 1 [open] 시간 정함 없음 끝냄 없음 반복 없음");
    expect(text(html.split('<div class="pl-col">')[2]!)).toBe("시간 정함 없음 끝냄 없음 반복 없음");
    expect(html).toContain('class="pl-sec rules" aria-label="반복"');
  });

  it("접힌다: 접으면 개수만, 펴면 규칙 줄들", () => {
    expect(text(cards({ count: 2, open: false }))).toMatch(/반복 2$/);
    expect(text(cards({ count: 2, open: true }))).toMatch(/반복 2 \[규칙들\]$/);
  });

  it("줄 = 제목 · 주기 · 다음 회차. 멈춘 규칙은 '멈춤'", () => {
    const line = (r: TaskRule, next: string | null) =>
      renderToStaticMarkup(<RuleLine rule={r} label="매주 월" next={next} selected={false} onPick={noop} />);
    expect(text(line(rule(), "2026-10-12"))).toBe("주간 정리 매주 월 10/12 월");
    expect(line(rule(), "2026-10-12")).toContain('data-id="rule:r1"');
    expect(text(line(rule({ paused: true }), null))).toBe("주간 정리 매주 월 멈춤");
    expect(line(rule({ paused: true }), null)).toContain("paused");
    expect(text(line(rule(), null))).toBe("주간 정리 매주 월");
  });

  it("보기: 주기 · 다음 회차 · 걸릴 시간 · 단계 틀(아랫단 · 걸릴 시간) · 작업대에 올리기 체크 · 수정 · 멈춤 · 지우기", () => {
    const html = renderToStaticMarkup(
      <RuleDetail rule={rule()} label="매주 월" next="2026-10-12" place={null} role="개인" onBench={noop} onEdit={noop} onPause={noop} onDelete={noop} />,
    );
    expect(text(html)).toBe("주간 정리 매주 월 마감까지 6일 10/12 월 40분 개인 받은 편지함 일정 확인 5분 이번 주 다음 주 5분 회차가 생기면 작업대에 올리기 수정 멈춤 지우기");
    expect(html.match(/<li class="sub">/g)).toHaveLength(2);
    expect(html).toMatch(/<input type="checkbox"\/?>/); // 꺼짐
    expect(html).not.toContain('role="checkbox"'); // 단계 틀은 보기만
    const on = renderToStaticMarkup(
      <RuleDetail rule={rule({ bench: true, paused: true })} label="매주 월" next={null} place={null} role={null} onBench={noop} onEdit={noop} onPause={noop} onDelete={noop} />,
    );
    expect(on).toContain("checked");
    expect(text(on)).toContain("멈춤 40분");
    expect(text(on)).toMatch(/수정 다시 시작 지우기$/);
  });

  it("수정 칸: 주기(매일 · 매주 + 요일) · 마감까지 · 걸릴 시간 · 단계 틀 · 메모 · 작업대에 올리기. 일정에 딸린 규칙은 주기가 글자", () => {
    const form = (r: TaskRule, eventLabel: string | null = null) =>
      renderToStaticMarkup(<RuleForm draft={ruleDraft(r)} eventLabel={eventLabel} places={[]} roles={[]} isNew={false} onChange={noop} onSave={noop} onCancel={noop} />);
    const html = form(rule());
    expect(html).toContain('aria-label="반복 수정"');
    expect(text(html)).toBe("매일 매주 월 화 수 목 금 토 일 마감까지 일 분 없음 받은 편지함 일정 확인 이번 주 다음 주 회차가 생기면 작업대에 올리기 완료 취소");
    expect(html).toContain('aria-label="단계 틀 (한 줄에 하나, 들여 쓰면 아랫단)"');
    const ev = form(rule({ kind: "event", repeat: null, start: null, event_id: "e1" }), "자료구조 끝날 때마다");
    expect(text(ev)).toMatch(/^자료구조 끝날 때마다 마감까지/);
    expect(ev).not.toContain('aria-label="요일"');
  });
});

describe("할 일 추가 칸 (7-15) · 작업대로 가는 길 (7-16)", () => {
  const add = <label className="pl-new">추가칸</label>;

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

  it("할 일 카드 머리에 작업대 링크가 없다 (없앴다)", () => {
    const html = renderToStaticMarkup(<PlannerCards count={{ late: 0, open: 1, timed: 0, done: 0 }} body={(k) => `[${k}]`} showDone={false} onFold={noop} addRow={add} />);
    expect(html).not.toContain("작업대");
    expect(html).not.toContain("pl-hrow");
    expect(css).not.toContain("pl-bnlink");
  });

  it("위쪽 줄에는 홈 · 밝기 전환만 — 추가 칸이 없다", () => {
    const html = renderToStaticMarkup(<PlannerBar home={<a className="mhome">홈</a>} />);
    expect(html).toContain('class="bar-top pl-top"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("할 일 추가");
    expect(html.match(/<(a|button)\b/g)).toHaveLength(2);
  });

  it("사이드바: 플래너 바로 아래 작업대. 플래너는 /planner 에서만, 작업대는 /planner/bench… · 기록에서 켜진다", () => {
    const labels = MENU.map((m) => m.label);
    expect(labels).toEqual(["보고서 서랍", "일정", "플래너", "작업대", "모임"]);
    const on = (path: string) => MENU[activeMenu(path)]?.label;
    expect(on("/planner")).toBe("플래너");
    expect(on("/planner/bench")).toBe("작업대");
    expect(on("/planner/bench/abc")).toBe("작업대");
    expect(on("/planner/log")).toBe("작업대");
    expect(on("/schedule")).toBe("일정");
    expect(on("/drawer/x/y")).toBe("보고서 서랍");
    expect(activeMenu("/trash")).toBe(-1);
    expect(MENU.find((m) => m.label === "작업대")).toMatchObject({ path: "/planner/bench", module: "/planner" });
  });

  it('할 일 보기의 단추는 "작업대"(올리기만), 올라가 있으면 "내리기". 지우는 단추는 "지우기"', () => {
    const detail = (t: TaskRow) =>
      renderToStaticMarkup(
        <TaskDetail
          task={t}
          link={null}
          event={null}
          late={null}
          place={null}
          role={null}
          dueTitle={null}
          repeat={null}
          today="2026-10-04"
          scheduleHref={null}
          onToggle={noop}
          onCheck={noop}
          onPlan={noop}
          onUnplan={noop}
          onDue={noop}
          onClearDue={noop}
          onEdit={noop}
          onBench={t.done_at === null ? noop : null}
          onDelete={noop}
          onMore={null}
        />,
      );
    expect(text(detail(task()))).toBe("상법 내용 정리 시간 정하기 작업대 수정 지우기");
    expect(text(detail(task({ bench_order: 1 })))).toBe("상법 내용 정리 시간 정하기 내리기 수정 지우기");
    expect(text(detail(task({ done_at: "2026-10-04T00:00:00Z" })))).toBe("상법 내용 정리 수정 지우기");
    expect(detail(task())).not.toContain("없애기");
    // 체크 항목도 두 단 · 걸릴 시간
    const steps = detail(task({ checklist: [{ t: "정리", done: false, sub: [{ t: "1장", done: true, est: 10 }] }] }));
    expect(text(steps)).toContain("정리 10분 1장 10분");
    expect(steps).toContain('<li class="sub">');
  });
});

describe("작업대 집중 화면의 종이 (7-13 내용 · 7-15 · 7-16)", () => {
  const t = task({
    est_min: 60,
    place_id: "p1",
    note: "판례는 뒤로",
    bench_order: 1,
    work: work(),
    checklist: [
      { t: "1장 읽기", done: true, est: 20 },
      { t: "요약 쓰기", done: false, sub: [{ t: "쟁점", done: true }, { t: "판례", done: false, est: 15 }] },
      { t: "문제 풀기", done: false, est: 30 },
    ],
  });
  const render = (over: Partial<TaskRow> = {}, now = NOW) =>
    renderToStaticMarkup(
      <BenchCard
        task={{ ...t, ...over }}
        now={new Date(now)}
        onOpen={noop}
        onCheck={noop}
        onAddStep={() => null}
        onMoveStep={noop}
        onIndent={noop}
        onEst={noop}
        onDetach={noop}
        onNote={noop}
        onAddTask={yes}
        onStart={noop}
        onStop={noop}
        onDone={noop}
        onPutDown={noop}
      />,
    );

  it("머리: 제목 → 얇은 막대 → 걸릴 시간 · 단계 합 · 오늘 · 누적 → 시작. '앉은 지' 는 없다", () => {
    const html = render();
    expect(text(html)).toBe("상법 내용 정리 걸릴 시간 1시간 단계 합 1시간 5분 오늘 40분 누적 1시간 20분 시작 1장 읽기 분 요약 쓰기 15분 쟁점 분 판례 분 문제 풀기 분 판례는 뒤로 끝냄 내리기");
    expect(html).not.toContain("앉은");
    const head = html.slice(0, html.indexOf('class="bn-body"'));
    expect(head.indexOf('class="bn-t"')).toBeLessThan(head.indexOf('class="bn-bar"'));
    expect(head.indexOf('class="bn-bar"')).toBeLessThan(head.indexOf('class="bn-meta"'));
    expect(head.indexOf('class="bn-meta"')).toBeLessThan(head.indexOf('class="bn-run"'));
    // 진행: 끝낸 줄 2 / 전체 5 — 숫자 글자 없이 막대만
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuemax="5"[^>]*aria-valuenow="2"/);
    expect(html).toContain("scaleX(0.4)");
    expect(text(html)).not.toMatch(/2\/5/);
  });

  it("단계 합이 걸릴 시간을 넘으면 걸릴 시간 글자만 키위", () => {
    expect(render()).toContain('<span class="num over">걸릴 시간 1시간</span>');
    expect(render({ est_min: 90 })).toContain('<span class="num">걸릴 시간 1시간 30분</span>');
    expect(css).toMatch(/\.bn-meta \.over\{color:var\(--point-ink\)/);
  });

  it("시작 ↔ 중지: 돌고 있으면 중지(키위 채움) + 흐르는 시계", () => {
    const idle = render();
    expect(idle).toMatch(/<button type="button" class="ghost">시작<\/button>/);
    expect(idle).not.toContain("bn-clock");
    const run = render({ work: work({ running: true, started_at: "2026-10-04T01:27:26Z" }) });
    expect(run).toMatch(/<button type="button" class="btn">중지<\/button><span class="bn-clock num" role="timer">12:34<\/span>/);
    expect(run).not.toContain(">시작<");
    // 1분 뒤에 그리면 시계 · 오늘이 같이 흐른다
    const later = render({ work: work({ running: true, started_at: "2026-10-04T01:27:26Z" }) }, "2026-10-04T01:41:00Z");
    expect(later).toContain("13:34");
    expect(text(later)).toContain("오늘 41분");
  });

  it("지금 단계(첫 번째 안 끝난 줄)에 표시 하나. 아랫단은 들여서. 걸릴 시간 칸은 줄마다, 아랫단이 있는 윗단은 합(글자)", () => {
    const html = render();
    expect(html.match(/role="checkbox"/g)).toHaveLength(5);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/<li[^>]*data-depth="1"[^>]*class="sub cur"[^>]*>.*?판례/);
    expect(html.match(/data-depth="1"/g)).toHaveLength(2);
    expect(html).toContain('<span class="bn-est sum num">15분</span>');
    expect(html.match(/걸릴 시간\(분\)"/g)).toHaveLength(4); // 윗단 둘 + 아랫단 둘
    expect(html).toContain('aria-label="판례 걸릴 시간(분)"');
    expect(html).toContain('aria-label="1장 읽기 떼어내기"');
    expect(html).toContain('aria-label="단계 추가"');
    expect(html).toContain('aria-label="새 할 일"');
    expect(css).toMatch(/\.bn-steps li\.sub\{margin-left:16px\}/);
    expect(css).toMatch(/\.bn-steps li\.cur::before\{[^}]*background:var\(--point-ink\)/);
  });

  it("끝냄은 다 체크되면 키위 채움, 아니면 조용한 단추 (단계가 없어도)", () => {
    expect(render()).toMatch(/<button type="button" class="ghost">끝냄<\/button>/);
    expect(render({ checklist: [] })).toMatch(/<button type="button" class="ghost">끝냄<\/button>/);
    expect(render({ checklist: [{ t: "a", done: true, sub: [{ t: "b", done: true }] }] })).toMatch(/<button type="button" class="btn">끝냄<\/button>/);
  });

  it("끝낸 단계가 8개를 넘으면 접고 '끝낸 n' 한 줄", () => {
    const many = [...Array.from({ length: 9 }, (_, i) => ({ t: `끝 ${i}`, done: true })), { t: "남은 것", done: false }];
    const html = render({ checklist: many, est_min: null, work: undefined });
    expect(text(html)).toBe("상법 내용 정리 시작 끝낸 9 남은 것 분 판례는 뒤로 끝냄 내리기");
    expect(html).toMatch(/class="bn-fold"><button type="button" aria-expanded="false">/);
    const few = render({ checklist: many.slice(1), est_min: null, work: undefined });
    expect(few).not.toContain("bn-fold");
    expect(few.match(/role="checkbox"/g)).toHaveLength(9);
  });

  it("메모 안 주소는 읽기 상태에서 눌린다(새 창). 주소가 없으면 적는 칸", () => {
    const linked = render({ note: "강의 https://example.com/ch7 부터" });
    expect(linked).toContain('<a href="https://example.com/ch7" target="_blank" rel="noopener noreferrer">https://example.com/ch7</a>');
    expect(linked).toContain('class="bn-note read"');
    expect(linked).not.toContain("<textarea");
    expect(render()).toContain("<textarea");
    expect(render({ note: "javascript:alert(1)" })).not.toContain("<a href");
  });

  it("제목은 h1, 단계 · 메모는 한 묶음(.bn-body) 안에 — 종이 안에서 가운데 묶음", () => {
    const html = render();
    expect(html).toMatch(/<h1 class="bn-h"><button[^>]*class="bn-t"[^>]*>상법 내용 정리<\/button><\/h1>/);
    const body = html.slice(html.indexOf('<div class="bn-body">'));
    expect(body.indexOf('class="bn-steps"')).toBeGreaterThan(0);
    expect(body.indexOf('class="bn-note"')).toBeGreaterThan(body.indexOf('class="bn-steps"'));
    expect(body.indexOf('class="bn-add"')).toBeGreaterThan(body.indexOf("</textarea></div>"));
  });

  it("단계가 없어도 빈 줄 하나는 있다. 없는 칸은 그리지 않는다(막대 · 정보 줄)", () => {
    const html = render({ est_min: null, checklist: [], note: null, work: undefined });
    expect(text(html)).toBe("상법 내용 정리 시작 끝냄 내리기");
    expect(html).not.toContain('role="checkbox"');
    expect(html).not.toContain("bn-bar");
    expect(html).toContain('aria-label="단계 추가"');
  });

  it("CSS: 종이는 가로 가운데(최대 폭 960), 제목 · 막대 · 정보 줄 · 시작 단추 가운데 맞춤, 두 칸 묶음 · 단추도 가운데", () => {
    expect(css).toMatch(/\.bf-col\{max-width:960px;margin:0 auto;/);
    expect(css).toMatch(/\.bn-h\{[^}]*justify-content:center/);
    expect(css).toMatch(/\.bn-t\{[^}]*text-align:center/);
    expect(css).toMatch(/\.bn-bar\{[^}]*margin:16px auto 0/);
    expect(css).toMatch(/\.bn-meta\{[^}]*justify-content:center/);
    expect(css).toMatch(/\.bn-run\{[^}]*justify-content:center/);
    expect(css).toMatch(/\.bn-body\{[^}]*margin:28px auto 0/);
    expect(css).toMatch(/\.bn-body\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
    expect(css).toMatch(/\.bn-acts\{[^}]*justify-content:center/);
  });
});

describe("작업대 목록 (7-15 · 7-16)", () => {
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
    renderToStaticMarkup(<BenchItem task={{ ...t, ...over }} role={role} now={new Date(NOW)} href="/planner/bench/b1" onOff={noop} />);

  it("카드: 제목 · 역할 · 걸릴 시간 · 얇은 진행 막대 · 지금 단계 글자 · 내리기, 누르면 집중 화면. 숫자 진행 · 앉은 지는 없다", () => {
    const html = card();
    expect(text(html)).toBe("상법 내용 정리 대학 2시간 문제 2 내리기");
    expect(html).toContain('href="/planner/bench/b1"');
    expect(html).toContain('data-id="b1"');
    expect(html).toMatch(/class="bl-bar" role="progressbar"[^>]*aria-valuenow="33"/);
    expect(html).not.toContain("1/3");
    expect(html).not.toContain("앉은");
  });

  it("단계가 없으면 막대 없이 메모 첫 줄. 오늘 기록은 있을 때만. 없는 칸은 그리지 않는다", () => {
    const plain = card({ checklist: [] });
    expect(text(plain)).toBe("상법 내용 정리 대학 2시간 스케줄링은 7장부터 내리기");
    expect(plain).not.toContain("bl-bar");
    expect(text(card({ work: work() }))).toBe("상법 내용 정리 대학 2시간 오늘 40분 문제 2 내리기");
    expect(text(card({ est_min: null, checklist: [], note: null }, null))).toBe("상법 내용 정리 내리기");
  });

  it("시간이 가고 있는 카드는 왼쪽 키위 막대", () => {
    expect(card({ work: work({ running: true, started_at: "2026-10-04T01:30:00Z" }) })).toContain('class="bl-card running"');
    expect(card({ work: work() })).toContain('class="bl-card"');
    expect(css).toMatch(/\.bl-card\.running::before\{[^}]*background:var\(--point-ink\)/);
  });

  it("가져올 만한 것: 제목 글자 없이 첫 줄부터 할 일 — 줄마다 누르면 올라간다", () => {
    const roles: Role[] = [{ id: "r1", name: "대학", from_place: "school", sort: 1, version: 1 }];
    const html = renderToStaticMarkup(
      <BenchPicks picks={[task({ id: "p1", title: "과제", role_id: "r1" }), task({ id: "p2", title: "메일 답장" })]} roles={roles} onPick={noop} />,
    );
    expect(text(html)).toBe("과제 대학 메일 답장");
    expect(html).toMatch(/^<aside class="bl-side" aria-label="가져올 만한 것"><ul class="bl-picks"><li data-id="p1"><button/);
    expect(html.match(/<button type="button" class="bl-pick"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<h[1-6]/);
  });

  it("CSS: 패널은 종이색 라운드 사각형 + 옅은 그림자, 넓으면 옆에 폭 320 으로 따라오고 좁으면 아래", () => {
    expect(css).toMatch(/\.bl-side\{[^}]*background:var\(--paper\);border-radius:var\(--r-l\);box-shadow:/);
    const wide = /@container pstage \(min-width: 1000px\)\{([\s\S]*?)\n\}/.exec(css.replace(/\r\n/g, "\n"))?.[1] ?? "";
    expect(wide).toMatch(/\.bl-col\.two \.bl-cols\{grid-template-columns:minmax\(0,1fr\) 320px/);
    expect(wide).toMatch(/\.bl-side\{position:sticky/);
    expect(css).toMatch(/\.bl-cols\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  });
});

describe("기록 표 (7-16)", () => {
  const tasks = [task({ id: "a", title: "상법 정리", role_id: "univ", place_id: "school" }), task({ id: "b", title: "수업 준비", role_id: "teach" })];
  const by = {
    roles: [
      { id: "univ", name: "대학", sort: 1 },
      { id: "teach", name: "강사", sort: 2 },
    ],
    places: [{ id: "school", name: "학교" }],
  };
  const week = [
    { task_id: "a", day: "2026-10-05", seconds: 2700 },
    { task_id: "a", day: "2026-10-07", seconds: 1800 },
    { task_id: "b", day: "2026-10-05", seconds: 1200 },
  ];
  const table = (byRole = false) => renderToStaticMarkup(<LogTableView table={weekTable(week, "2026-10-05", tasks, by, byRole)} hrefOf={(id) => `/planner?task=${id}`} />);

  it("행 = 할 일(역할 · 지점 옆에), 열 = 월~일 + 합계, 칸 = 분, 맨 아래 합계 줄. 숫자만", () => {
    const html = table();
    expect(text(html)).toBe("월 5 화 6 수 7 목 8 금 9 토 10 일 11 합계 상법 정리 대학 · 학교 45 30 75 수업 준비 강사 20 20 합계 65 30 95");
    expect(html.match(/<tr/g)).toHaveLength(4);
    expect(html).toContain('<a href="/planner?task=a">상법 정리</a>');
    expect(html).not.toMatch(/<svg|<canvas/);
  });

  it("정렬이 역할이면 역할 소계 줄", () => {
    const html = table(true);
    expect(text(html)).toBe("월 5 화 6 수 7 목 8 금 9 토 10 일 11 합계 상법 정리 대학 · 학교 45 30 75 대학 45 30 75 수업 준비 강사 20 20 강사 20 20 합계 65 30 95");
    expect(html.match(/<tr class="sub">/g)).toHaveLength(2);
  });

  it("CSS: 가운데 기둥 960", () => {
    expect(css).toMatch(/\.lg-col\{max-width:960px;margin:0 auto\}/);
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
