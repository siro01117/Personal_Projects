// 우클릭(길게 누르기) 메뉴의 항목 목록 — 화면별 · 상태별 (docs/공통.md 2장).

import { describe, expect, it } from "vitest";
import { benchMenu, blockEditMenu, blockReadMenu, eventMenu, meetMenu, memberMenu, menuLabels, personMenu, stepMenu, taskMenu, type MenuItem } from "./menus";

/** 규칙: 지우기(위험)는 맨 아래에 모이고, 다른 항목이 있으면 그 바로 위가 구분선. 구분선은 처음 · 끝 · 겹침 없이 */
function wellFormed(items: readonly MenuItem[]) {
  if (items.length === 0) return;
  expect(items[0]).not.toBe("sep");
  expect(items.at(-1)).not.toBe("sep");
  items.forEach((m, i) => i > 0 && m === "sep" && expect(items[i - 1]).not.toBe("sep"));
  const firstDanger = items.findIndex((m) => m !== "sep" && m.danger);
  if (firstDanger >= 0) {
    if (firstDanger > 0) expect(items[firstDanger - 1]).toBe("sep");
    expect(items.slice(firstDanger).every((m) => m !== "sep" && m.danger)).toBe(true);
  }
}

const task = (over: Partial<Parameters<typeof taskMenu>[0]> = {}) => taskMenu({ temp: false, done: false, benched: false, link: null, late: null, ...over });

describe("플래너 할 일 줄", () => {
  it("열린 할 일: 보기 · 끝냄 · 작업대에 · 수정 · 시간 정하기 · 일정으로 보내기 · 지우기", () => {
    expect(menuLabels(task())).toEqual(["보기", "끝냄", "작업대에", "수정", "시간 정하기", "일정으로 보내기", "지우기"]);
    expect(task()[0]).toMatchObject({ act: "view" });
  });
  it("작업대에 올라가 있으면 내리기", () => {
    expect(menuLabels(task({ benched: true }))).toContain("작업대에서 내리기");
    expect(menuLabels(task({ benched: true }))).not.toContain("작업대에");
  });
  it("시간 정함(안 지남): 다시 정하기 · 시간 없음으로, 일정으로 보내기는 없다", () => {
    expect(menuLabels(task({ link: { repeating: false } }))).toEqual(["보기", "끝냄", "작업대에", "수정", "다시 정하기", "시간 없음으로", "지우기"]);
  });
  it("반복 일정에 이어진 것은 시간을 여기서 안 바꾼다", () => {
    expect(menuLabels(task({ link: { repeating: true } }))).toEqual(["보기", "끝냄", "작업대에", "수정", "지우기"]);
  });
  it("지난 일정: 다시 정하기 · 시간 없음으로 (반복이어도)", () => {
    expect(menuLabels(task({ link: { repeating: true }, late: "event" }))).toContain("다시 정하기");
    expect(menuLabels(task({ link: { repeating: true }, late: "event" }))).toContain("시간 없음으로");
  });
  it("지난 마감: 시간 항목 없이 일정으로 보내기만", () => {
    const l = menuLabels(task({ late: "due" }));
    expect(l).not.toContain("시간 정하기");
    expect(l).toContain("일정으로 보내기");
  });
  it("끝낸 할 일: 보기 · 되살리기 · 수정 · 지우기", () => {
    expect(menuLabels(task({ done: true }))).toEqual(["보기", "되살리기", "수정", "지우기"]);
  });
  it("아직 저장 안 된 할 일은 메뉴 없음", () => {
    expect(task({ temp: true })).toEqual([]);
  });
  it("모양 규칙", () => {
    for (const t of [task(), task({ done: true }), task({ link: { repeating: false } }), task({ late: "event", link: { repeating: false } })]) wellFormed(t);
  });
});

describe("작업대", () => {
  it("목록 카드: 집중 화면 · 끝냄 · 내리기", () => {
    expect(menuLabels(benchMenu({ temp: false }))).toEqual(["집중 화면", "끝냄", "내리기"]);
    expect(benchMenu({ temp: true })).toEqual([]);
  });
  it("단계 줄: 체크 · 떼어내기 · 지우기 (체크한 것은 체크 풀기)", () => {
    expect(menuLabels(stepMenu({ done: false }))).toEqual(["체크", "떼어내기", "지우기"]);
    expect(menuLabels(stepMenu({ done: true }))).toEqual(["체크 풀기", "떼어내기", "지우기"]);
    wellFormed(stepMenu({ done: false }));
  });
});

describe("모임", () => {
  it("목록 줄: 열기 · 수정 · 다음 모임 · (링크가 켜져 있으면) 링크 복사 · 지우기", () => {
    expect(menuLabels(meetMenu({ temp: false, linked: false }))).toEqual(["열기", "수정", "다음 모임", "지우기"]);
    expect(menuLabels(meetMenu({ temp: false, linked: true }))).toEqual(["열기", "수정", "다음 모임", "링크 복사", "지우기"]);
    expect(meetMenu({ temp: true, linked: false })).toEqual([]);
    wellFormed(meetMenu({ temp: false, linked: true }));
  });

  const labels = { yes: "온다", no: "못 온다" };
  const person = (over: Partial<Parameters<typeof personMenu>[0]> = {}) =>
    personMenu({ temp: false, decided: true, attend: null, owner: false, hasPin: false, labels, ...over });
  it("사람 줄(정해진 뒤): 지금 고른 것은 빼고, 고른 게 있으면 비우기", () => {
    expect(menuLabels(person())).toEqual(["온다", "못 온다", "빼기"]);
    expect(menuLabels(person({ attend: "yes" }))).toEqual(["못 온다", "비우기", "빼기"]);
    expect(menuLabels(person({ attend: "no", hasPin: true }))).toEqual(["온다", "비우기", "핀 지우기", "빼기"]);
  });
  it("맞추는 중이면 참석 없음, 나는 못 뺀다", () => {
    expect(menuLabels(person({ decided: false }))).toEqual(["빼기"]);
    expect(person({ decided: false })).toEqual([{ act: "remove", label: "빼기", icon: "trash", danger: true }]);
    expect(menuLabels(person({ owner: true }))).toEqual(["온다", "못 온다"]);
    expect(person({ decided: false, owner: true })).toEqual([]);
  });
  it("지난 모임은 참석 글자가 바뀐다", () => {
    expect(menuLabels(person({ labels: { yes: "왔다", no: "못 왔다" } }))).toEqual(["왔다", "못 왔다", "빼기"]);
  });
  it("모양 규칙", () => {
    for (const p of [person(), person({ attend: "yes", hasPin: true }), person({ decided: false }), person({ owner: true })]) wellFormed(p);
  });
});

describe("일정 블록", () => {
  it("한 번짜리: 보기 · 수정 · 지우기", () => {
    expect(menuLabels(eventMenu({ draft: false, external: false, repeating: false }))).toEqual(["보기", "수정", "지우기"]);
  });
  it("반복: 이번만 바꾸기 · 이번만 지우기 · 이후 모두 지우기", () => {
    const m = eventMenu({ draft: false, external: false, repeating: true });
    expect(menuLabels(m)).toEqual(["보기", "수정", "이번만 바꾸기", "이번만 지우기", "이후 모두 지우기"]);
    wellFormed(m);
  });
  it("바깥에서 온 일정은 보기만, 만드는 중인 칸은 메뉴 없음", () => {
    expect(menuLabels(eventMenu({ draft: false, external: true, repeating: true }))).toEqual(["보기"]);
    expect(eventMenu({ draft: true, external: false, repeating: false })).toEqual([]);
  });
});

describe("보고서 블록", () => {
  it("고치기 모드: 댓글 · 위로 · 아래로 · 지우기 — 옮길 수 없는 쪽은 빠진다", () => {
    expect(menuLabels(blockEditMenu({ canUp: true, canDown: true }))).toEqual(["댓글", "위로", "아래로", "지우기"]);
    expect(menuLabels(blockEditMenu({ canUp: false, canDown: true }))).toEqual(["댓글", "아래로", "지우기"]);
    expect(menuLabels(blockEditMenu({ canUp: false, canDown: false }))).toEqual(["댓글", "지우기"]);
    wellFormed(blockEditMenu({ canUp: true, canDown: false }));
  });
  it("읽기 모드: 댓글 · Markdown 으로 복사", () => {
    expect(menuLabels(blockReadMenu())).toEqual(["댓글", "Markdown 으로 복사"]);
  });
});

describe("관리(회원) 표 줄", () => {
  it("이름 고치기 · 비밀번호 다시 정하기 · 켜기/끄기 · 지우기", () => {
    expect(menuLabels(memberMenu({ active: true }))).toEqual(["이름 고치기", "비밀번호 다시 정하기", "끄기", "지우기"]);
    expect(menuLabels(memberMenu({ active: false }))).toEqual(["이름 고치기", "비밀번호 다시 정하기", "켜기", "지우기"]);
    wellFormed(memberMenu({ active: true }));
  });
});
