// 우클릭(길게 누르기) 메뉴의 항목 목록 (docs/공통.md 2장). 화면마다 · 상태마다 무엇이 뜨는지만 정한다 — 하는 일은 화면이 act 로 받아 한다.
// 규칙: 그 화면에 이미 있는 동작만. 첫 항목은 열기/보기, 지우기는 맨 아래 · 그 위에 구분선. 아이콘은 Icon.tsx 에 있는 것만.

import type { IconName } from "../_ui/Icon";

export type MenuItem<A extends string = string> = { act: A; label: string; icon: IconName; danger?: true } | "sep";

const it = <A extends string>(act: A, label: string, icon: IconName): MenuItem<A> => ({ act, label, icon });
const del = <A extends string>(act: A, label = "지우기"): MenuItem<A> => ({ act, label, icon: "trash", danger: true });

/** 눌러 볼 수 있는 항목만 (시험 · 화면에서 글자 확인용) */
export const menuLabels = (items: readonly MenuItem[]): string[] => items.flatMap((m) => (m === "sep" ? [] : [m.label]));

// ------------------------------------------------------------ 플래너 할 일 줄

export type TaskAct = "view" | "done" | "undone" | "bench" | "unbench" | "edit" | "plan" | "replan" | "unplan" | "send" | "repeat" | "delete";

/** 시간 · 일정으로 보내기 항목은 보기 패널(TaskDetail)의 단추와 같은 조건 */
export function taskMenu(t: {
  temp: boolean;
  done: boolean;
  benched: boolean;
  /** 이어진 일정 (반복 일정에 이어진 것은 일정 쪽에서 고친다) */
  link: { repeating: boolean } | null;
  late: "event" | "due" | null;
  /** 살아 있는 반복 규칙에서 온 회차 — "반복으로 만들기" 가 없다 (7-16) */
  repeats?: boolean;
}): MenuItem<TaskAct>[] {
  if (t.temp) return [];
  const out: MenuItem<TaskAct>[] = [it("view", "보기", "eye")];
  out.push(t.done ? it("undone", "되살리기", "restore") : it("done", "끝냄", "ring-check"));
  if (!t.done) out.push(t.benched ? it("unbench", "작업대에서 내리기", "bench") : it("bench", "작업대", "bench"));
  out.push(it("edit", "수정", "pen"));
  if (!t.done) {
    if (t.late === "event" || (t.late === null && t.link && !t.link.repeating)) out.push(it("replan", "다시 정하기", "clock"), it("unplan", "시간 없음으로", "x"));
    else if (t.late === null && !t.link) out.push(it("plan", "시간 정하기", "clock"));
    if (!t.link) out.push(it("send", "일정으로 보내기", "cal"));
    if (!t.repeats) out.push(it("repeat", "반복으로 만들기", "repeat"));
  }
  out.push("sep", del("delete"));
  return out;
}

// ------------------------------------------------------------ 작업대

export type BenchAct = "focus" | "done" | "off";

/** 작업대 목록 카드 */
export function benchMenu(t: { temp: boolean }): MenuItem<BenchAct>[] {
  if (t.temp) return [];
  return [it("focus", "집중 화면", "open"), it("done", "끝냄", "ring-check"), it("off", "내리기", "bench")];
}

export type StepAct = "check" | "indent" | "outdent" | "detach" | "delete";

/** 집중 화면의 단계 줄. 들이기 · 내기는 될 때만 (Tab · Shift+Tab 과 같다 — 터치에서는 여기로) */
export function stepMenu(s: { done: boolean; canIndent?: boolean; canOutdent?: boolean }): MenuItem<StepAct>[] {
  const out: MenuItem<StepAct>[] = [it("check", s.done ? "체크 풀기" : "체크", s.done ? "ring" : "ring-check")];
  if (s.canIndent) out.push(it("indent", "들이기", "right"));
  if (s.canOutdent) out.push(it("outdent", "내기", "left"));
  out.push(it("detach", "떼어내기", "cut"), "sep", del("delete"));
  return out;
}

export type PickAct = "bench";

/** 작업대 목록 옆 "가져올 만한 것" 줄 — 누르면 올라간다 */
export function pickMenu(t: { temp: boolean }): MenuItem<PickAct>[] {
  return t.temp ? [] : [it("bench", "작업대에 올리기", "bench")];
}

export type LogAct = "view" | "focus";

/** 기록 표의 할 일 줄. 집중 화면은 작업대에 올라가 있을 때만 */
export function logMenu(t: { benched: boolean }): MenuItem<LogAct>[] {
  const out: MenuItem<LogAct>[] = [it("view", "보기", "eye")];
  if (t.benched) out.push(it("focus", "집중 화면", "open"));
  return out;
}

// ------------------------------------------------------------ 반복 규칙 (플래너의 반복 카드)

export type RuleAct = "view" | "edit" | "pause" | "resume" | "delete";

/** 반복 카드의 규칙 줄 */
export function ruleMenu(r: { paused: boolean }): MenuItem<RuleAct>[] {
  return [it("view", "보기", "eye"), it("edit", "수정", "pen"), r.paused ? it("resume", "다시 시작", "repeat") : it("pause", "멈춤", "x"), "sep", del("delete")];
}

// ------------------------------------------------------------ 모임

export type MeetAct = "open" | "edit" | "next" | "copy" | "delete";

/** 모임 목록 줄. 링크 복사는 링크가 켜져 있을 때만 */
export function meetMenu(m: { temp: boolean; linked: boolean }): MenuItem<MeetAct>[] {
  if (m.temp) return [];
  const out: MenuItem<MeetAct>[] = [it("open", "열기", "open"), it("edit", "수정", "pen"), it("next", "다음 모임", "plus")];
  if (m.linked) out.push(it("copy", "링크 복사", "copy"));
  out.push("sep", del("delete"));
  return out;
}

export type PersonAct = "yes" | "no" | "clear" | "pin" | "remove";

/** 모임 화면의 사람 줄. 참석은 정해진 뒤에만(지금 값은 빼고), 비우기는 고른 게 있을 때, 빼기는 나 말고 */
export function personMenu(p: {
  temp: boolean;
  decided: boolean;
  attend: "yes" | "no" | null;
  owner: boolean;
  hasPin: boolean;
  /** 참석 글자 (attendLabels — 지난 모임이면 왔다 / 못 왔다) */
  labels: { yes: string; no: string };
}): MenuItem<PersonAct>[] {
  if (p.temp) return [];
  const out: MenuItem<PersonAct>[] = [];
  if (p.decided) {
    if (p.attend !== "yes") out.push(it("yes", p.labels.yes, "check"));
    if (p.attend !== "no") out.push(it("no", p.labels.no, "x"));
    if (p.attend !== null) out.push(it("clear", "비우기", "ring"));
  }
  if (p.hasPin) out.push(it("pin", "핀 지우기", "restore"));
  if (!p.owner) {
    if (out.length > 0) out.push("sep");
    out.push(del("remove", "빼기"));
  }
  return out;
}

// ------------------------------------------------------------ 일정 블록

export type EventAct = "view" | "edit" | "once" | "delete" | "deleteOnce" | "deleteFollowing";

/** 일정 블록(주간 · 하루 · 종일). 바깥에서 온 일정은 보기만. 반복이면 바꾸기 · 지우기에 범위가 붙는다(이번만 · 이후 모두) */
export function eventMenu(o: { draft: boolean; external: boolean; repeating: boolean }): MenuItem<EventAct>[] {
  if (o.draft) return [];
  const out: MenuItem<EventAct>[] = [it("view", "보기", "eye")];
  if (o.external) return out;
  out.push(it("edit", "수정", "pen"));
  if (o.repeating) out.push(it("once", "이번만 바꾸기", "cal"), "sep", del("deleteOnce", "이번만 지우기"), del("deleteFollowing", "이후 모두 지우기"));
  else out.push("sep", del("delete"));
  return out;
}

// ------------------------------------------------------------ 보고서 블록

export type BlockAct = "comment" | "up" | "down" | "delete" | "markdown";

/** 고치기 모드 (도구 줄의 동작) — 위로 · 아래로는 옮길 수 있을 때만 */
export function blockEditMenu(b: { canUp: boolean; canDown: boolean }): MenuItem<BlockAct>[] {
  const out: MenuItem<BlockAct>[] = [it("comment", "댓글", "memo")];
  if (b.canUp) out.push(it("up", "위로", "asc"));
  if (b.canDown) out.push(it("down", "아래로", "desc"));
  out.push("sep", del("delete"));
  return out;
}

/** 읽기 모드 */
export function blockReadMenu(): MenuItem<BlockAct>[] {
  return [it("comment", "댓글", "memo"), it("markdown", "Markdown 으로 복사", "copy")];
}

// ------------------------------------------------------------ 관리(회원) 표

export type MemberAct = "name" | "password" | "toggle" | "delete";

export function memberMenu(m: { active: boolean }): MenuItem<MemberAct>[] {
  return [
    it("name", "이름 고치기", "pen"),
    it("password", "비밀번호 다시 정하기", "restore"),
    m.active ? it("toggle", "끄기", "x") : it("toggle", "켜기", "check"),
    "sep",
    del("delete"),
  ];
}
