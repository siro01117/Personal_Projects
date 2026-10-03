// 단계(체크 항목) 두 단 — 평탄화 · 지금 단계 · 체크 전파 · 들이기/내기 · 걸릴 시간 합 · 넣기/빼기 · 떼어내기 · 덧붙이기 · 글자로 적기 · 규칙 틀 (docs/플래너.md 7-16)

import { describe, expect, it } from "vitest";
import {
  appendSteps,
  canIndent,
  canOutdent,
  currentStep,
  detachStep,
  draftDepth,
  estSum,
  findStep,
  flatSteps,
  formatStepLines,
  indentStep,
  insertStep,
  isChecklist,
  isRuleChecks,
  mergeSteps,
  moveStep,
  moveSubStep,
  outdentStep,
  parseStepEst,
  parseStepLines,
  removeStep,
  restoreStep,
  ruleChecks,
  sameSteps,
  setStepEst,
  stepCount,
  stepEst,
  stepProgress,
  stepsFromRule,
  toggleStep,
} from "./steps";
import type { CheckItem } from "./types";

const c = (t: string, done = false, extra: Partial<CheckItem> = {}): CheckItem => ({ t, done, ...extra });
/** 읽기 [윗단 20] → [아랫단 1장(끝) · 2장 15] 정리 → 문제 30 */
const LIST: CheckItem[] = [c("읽기", true, { est: 20 }), c("정리", false, { sub: [c("1장", true), c("2장", false, { est: 15 })] }), c("문제", false, { est: 30 })];
const names = (list: readonly CheckItem[]) => flatSteps(list).map((s) => `${s.depth === 1 ? "  " : ""}${s.t}`);

describe("평탄화 · 개수 · 진행", () => {
  it("윗단과 아랫단을 위에서부터 줄 단위로", () => {
    expect(flatSteps(LIST)).toEqual([
      { k: 0, i: 0, j: null, depth: 0, t: "읽기", done: true, est: 20, parent: false },
      { k: 1, i: 1, j: null, depth: 0, t: "정리", done: false, est: 15, parent: true },
      { k: 2, i: 1, j: 0, depth: 1, t: "1장", done: true, est: null, parent: false },
      { k: 3, i: 1, j: 1, depth: 1, t: "2장", done: false, est: 15, parent: false },
      { k: 4, i: 2, j: null, depth: 0, t: "문제", done: false, est: 30, parent: false },
    ]);
    expect(flatSteps([])).toEqual([]);
  });
  it("개수는 윗단 + 아랫단, 진행은 끝낸 줄 / 전체 줄", () => {
    expect(stepCount(LIST)).toBe(5);
    expect(stepProgress(LIST)).toEqual({ done: 2, total: 5, all: false });
    expect(stepProgress([])).toBeNull();
    expect(stepProgress([c("a", true, { sub: [c("b", true)] })])).toEqual({ done: 2, total: 2, all: true });
  });
  it("옛 모양 {t, done} 은 그대로 한 단", () => {
    const old = [c("a", true), c("b")];
    expect(flatSteps(old).map((s) => [s.t, s.depth, s.est])).toEqual([["a", 0, null], ["b", 0, null]]);
    expect(isChecklist(old)).toBe(true);
  });
});

describe("지금 단계 — 깊이 상관없이 첫 번째 안 끝난 줄", () => {
  it("안 끝난 윗단에 안 끝난 아랫단이 있으면 그 아랫단", () => {
    expect(currentStep(LIST)).toBe(3); // 2장
    expect(currentStep([c("a"), c("b")])).toBe(0);
  });
  it("아랫단을 다 끝냈으면 윗단이 지금 단계 (윗단은 사람이 누른다)", () => {
    expect(currentStep([c("정리", false, { sub: [c("1장", true), c("2장", true)] }), c("문제")])).toBe(0);
  });
  it("끝낸 윗단은 아랫단째 건너뛴다. 다 끝났거나 없으면 null", () => {
    expect(currentStep([c("정리", true, { sub: [c("1장", false)] }), c("문제")])).toBe(2);
    expect(currentStep([c("a", true)])).toBeNull();
    expect(currentStep([])).toBeNull();
  });
});

describe("체크", () => {
  it("윗단을 체크하면 아랫단도 체크된다", () => {
    const next = toggleStep(LIST, 1, true);
    expect(flatSteps(next).map((s) => s.done)).toEqual([true, true, true, true, false]);
  });
  it("윗단 체크를 풀어도 아랫단은 그대로, 아랫단을 다 체크해도 윗단은 그대로", () => {
    const all = toggleStep(LIST, 1, true);
    expect(flatSteps(toggleStep(all, 1, false)).map((s) => s.done)).toEqual([true, false, true, true, false]);
    expect(flatSteps(toggleStep(LIST, 3, true)).map((s) => s.done)).toEqual([true, false, true, true, false]);
  });
  it("없는 줄이면 그대로", () => {
    expect(toggleStep(LIST, 9, true)).toEqual(LIST);
  });
});

describe("들이기 · 내기", () => {
  it("Tab: 윗단 줄이 바로 위 윗단의 맨 끝 아랫단이 된다. 첫 줄 · 아랫단은 못 들인다", () => {
    expect(names(indentStep(LIST, 4))).toEqual(["읽기", "정리", "  1장", "  2장", "  문제"]);
    expect(canIndent(LIST, 0)).toBe(false);
    expect(canIndent(LIST, 2)).toBe(false);
    expect(canIndent(LIST, 4)).toBe(true);
    expect(indentStep(LIST, 0)).toEqual(LIST);
    expect(indentStep(LIST, 2)).toEqual(LIST);
  });
  it("아랫단이 생긴 윗단은 자기 걸릴 시간을 버린다 (아랫단 합이 된다)", () => {
    const next = indentStep([c("a", false, { est: 10 }), c("b", false, { est: 5 })], 1);
    expect(next).toEqual([{ t: "a", done: false, sub: [{ t: "b", done: false, est: 5 }] }]);
    expect(stepEst(next[0]!)).toBe(5);
  });
  it("아랫단이 있던 줄을 들이면 그 아랫단도 같은 윗단 밑으로 (둘째 단 밑은 없다)", () => {
    expect(names(indentStep(LIST, 1))).toEqual(["읽기", "  정리", "  1장", "  2장", "문제"]);
  });
  it("Shift+Tab: 아랫단 줄이 윗단이 되고, 뒤의 아랫단은 그 줄의 아랫단이 된다 — 보이는 순서 그대로", () => {
    expect(names(outdentStep(LIST, 2))).toEqual(["읽기", "정리", "1장", "  2장", "문제"]);
    expect(names(outdentStep(LIST, 3))).toEqual(["읽기", "정리", "  1장", "2장", "문제"]);
    expect(canOutdent(LIST, 3)).toBe(true);
    expect(canOutdent(LIST, 1)).toBe(false);
    expect(outdentStep(LIST, 1)).toEqual(LIST);
  });
  it("들이고 내면 줄 수와 순서가 그대로", () => {
    const back = outdentStep(indentStep(LIST, 4), 4);
    expect(names(back)).toEqual(names(LIST));
    expect(stepCount(back)).toBe(5);
  });
});

describe("걸릴 시간", () => {
  it("합: 윗단은 자기 값, 아랫단이 있으면 아랫단 합", () => {
    expect(estSum(LIST)).toBe(65);
    expect(estSum([c("a"), c("b")])).toBe(0);
    expect(stepEst(c("정리", false, { est: 99, sub: [c("x")] }))).toBeNull();
  });
  it("한 줄에 적고 지운다. 아랫단이 있는 윗단에는 못 적는다", () => {
    expect(flatSteps(setStepEst(LIST, 2, 10))[2]!.est).toBe(10);
    expect(estSum(setStepEst(LIST, 2, 10))).toBe(75);
    expect(setStepEst(LIST, 0, null)[0]).toEqual({ t: "읽기", done: true });
    expect(setStepEst(LIST, 1, 40)).toEqual(LIST);
  });
  it("칸 글자 → 분: 빈칸은 없음, 1~600 정수만", () => {
    expect(parseStepEst("")).toBeNull();
    expect(parseStepEst(" 25 ")).toBe(25);
    expect(parseStepEst("600")).toBe(600);
    expect(parseStepEst("0")).toBeNaN();
    expect(parseStepEst("601")).toBeNaN();
    expect(parseStepEst("1.5")).toBeNaN();
  });
});

describe("넣기 · 빼기 · 옮기기", () => {
  it("맨 끝에 넣기. 빈 글자는 그대로, 넘치면 이유", () => {
    expect(names(insertStep(LIST, null, 0, "  복습  ").list)).toEqual(["읽기", "정리", "  1장", "  2장", "문제", "복습"]);
    expect(insertStep(LIST, null, 0, "복습").k).toBe(5);
    expect(insertStep(LIST, null, 0, "   ")).toEqual({ list: LIST, issue: null, k: null });
    expect(insertStep(LIST, null, 0, "가".repeat(101)).issue).toMatch(/100자/);
    const full = Array.from({ length: 25 }, (_, i) => c(`윗단 ${i}`, false, { sub: [c(`아랫단 ${i}`)] }));
    expect(insertStep(full, null, 0, "하나 더").issue).toMatch(/50개/);
  });
  it("줄 바로 아래에: 같은 깊이로, 아랫단이 있는 윗단 아래는 첫 아랫단으로", () => {
    expect(names(insertStep(LIST, 0, 0, "새 줄").list)).toEqual(["읽기", "새 줄", "정리", "  1장", "  2장", "문제"]);
    expect(names(insertStep(LIST, 1, 0, "0장").list)).toEqual(["읽기", "정리", "  0장", "  1장", "  2장", "문제"]);
    expect(names(insertStep(LIST, 2, 1, "1.5장").list)).toEqual(["읽기", "정리", "  1장", "  1.5장", "  2장", "문제"]);
    expect(insertStep(LIST, 2, 1, "1.5장").k).toBe(3);
  });
  it("아랫단을 바라고 넣기: 윗단 줄 아래면 그 줄의 아랫단, 맨 끝이면 마지막 윗단의 아랫단", () => {
    expect(names(insertStep(LIST, 0, 1, "메모").list)).toEqual(["읽기", "  메모", "정리", "  1장", "  2장", "문제"]);
    expect(names(insertStep(LIST, null, 1, "오답").list)).toEqual(["읽기", "정리", "  1장", "  2장", "문제", "  오답"]);
    expect(names(insertStep([], null, 1, "첫 줄").list)).toEqual(["첫 줄"]);
  });
  it("아랫단 줄 아래에 윗단으로 넣으면 뒤의 아랫단이 새 줄 밑으로 간다", () => {
    expect(names(insertStep(LIST, 2, 0, "복습").list)).toEqual(["읽기", "정리", "  1장", "복습", "  2장", "문제"]);
  });
  it("빈 줄이 놓일 깊이", () => {
    expect(draftDepth([], null, 1)).toBe(0);
    expect(draftDepth(LIST, null, 1)).toBe(1);
    expect(draftDepth(LIST, 1, 0)).toBe(1); // 아랫단이 있는 윗단 바로 아래
    expect(draftDepth(LIST, 0, 0)).toBe(0);
    expect(draftDepth(LIST, 3, 0)).toBe(0);
  });
  it("빼고 제자리에 도로 넣는다. 윗단은 아랫단째", () => {
    const sub = removeStep(LIST, 3);
    expect(names(sub.list)).toEqual(["읽기", "정리", "  1장", "문제"]);
    expect(restoreStep(sub.list, sub.removed!)).toEqual(LIST);
    const top = removeStep(LIST, 1);
    expect(names(top.list)).toEqual(["읽기", "문제"]);
    expect(restoreStep(top.list, top.removed!)).toEqual(LIST);
    expect(removeStep(LIST, 9).removed).toBeNull();
    // 그사이 윗단이 없어졌으면 맨 끝 윗단으로
    expect(names(restoreStep([c("혼자")], sub.removed!))).toEqual(["혼자", "2장"]);
  });
  it("끌어 옮기기: 윗단은 아랫단째, 아랫단은 같은 윗단 안에서", () => {
    expect(names(moveStep(LIST, 1, 0))).toEqual(["정리", "  1장", "  2장", "읽기", "문제"]);
    expect(names(moveStep(LIST, 0, 2))).toEqual(["정리", "  1장", "  2장", "문제", "읽기"]);
    expect(moveStep(LIST, 9, 0)).toEqual(LIST);
    expect(names(moveSubStep(LIST, 1, 1, 0))).toEqual(["읽기", "정리", "  2장", "  1장", "문제"]);
    expect(moveSubStep(LIST, 0, 0, 1)).toEqual(LIST);
  });
  it("조금 전에 본 줄을 다시 찾는다 (순서가 바뀌어도)", () => {
    const ref = { k: 3, t: "2장", depth: 1 as const };
    expect(findStep(LIST, ref)).toBe(3);
    expect(findStep(moveStep(LIST, 1, 0), ref)).toBe(2);
    expect(findStep(removeStep(LIST, 3).list, ref)).toBe(-1);
  });
});

describe("떼어내기", () => {
  it("아랫단 줄: 제목만, 그 줄만 빠진다", () => {
    const d = detachStep(LIST, 3)!;
    expect(d.title).toBe("2장");
    expect(d.checklist).toEqual([]);
    expect(names(d.rest)).toEqual(["읽기", "정리", "  1장", "문제"]);
  });
  it("윗단 줄: 아랫단이 새 할 일의 단계가 된다 (체크 · 걸릴 시간 그대로)", () => {
    const d = detachStep(LIST, 1)!;
    expect(d.title).toBe("정리");
    expect(d.checklist).toEqual([{ t: "1장", done: true }, { t: "2장", done: false, est: 15 }]);
    expect(names(d.rest)).toEqual(["읽기", "문제"]);
    expect(restoreStep(d.rest, d.removed)).toEqual(LIST);
    expect(detachStep(LIST, 9)).toBeNull();
  });
});

describe("덧붙이기만 (MCP)", () => {
  it("비어 있으면 채우고, 있으면 뒤에 더한다. 같은 글자의 윗단은 건너뛴다", () => {
    expect(appendSteps([], [c("a"), c("b")])).toEqual([c("a"), c("b")]);
    expect(names(appendSteps(LIST, [c("문제", true), c("복습", false, { sub: [c("퀴즈")] }), c("복습")]))).toEqual(["읽기", "정리", "  1장", "  2장", "문제", "복습", "  퀴즈"]);
    // 이미 있는 줄의 체크는 안 바뀐다
    expect(appendSteps(LIST, [c("문제", true)])[2]!.done).toBe(false);
  });
});

describe("글자로 적기 (수정 칸)", () => {
  it("한 줄에 하나, 들여 쓰면 아랫단. 첫 줄은 늘 윗단", () => {
    expect(parseStepLines(" 읽기 \n\n정리\r\n  1장\n\t2장\n 문제\n")).toEqual({
      lines: [
        { t: "읽기", depth: 0 },
        { t: "정리", depth: 0 },
        { t: "1장", depth: 1 },
        { t: "2장", depth: 1 },
        { t: "문제", depth: 0 }, // 공백 하나는 들여쓰기가 아니다
      ],
      issue: null,
    });
    expect(parseStepLines("  들여 쓴 첫 줄").lines).toEqual([{ t: "들여 쓴 첫 줄", depth: 0 }]);
    expect(parseStepLines("")).toEqual({ lines: [], issue: null });
  });
  it("50개 · 100자를 넘기면 알린다", () => {
    expect(parseStepLines(Array.from({ length: 50 }, (_, i) => `항목 ${i}`).join("\n")).issue).toBeNull();
    expect(parseStepLines(Array.from({ length: 51 }, (_, i) => `항목 ${i}`).join("\n")).issue).toMatch(/50개/);
    expect(parseStepLines("가".repeat(101)).issue).toMatch(/100자/);
  });
  it("단계 → 글자 → 단계: 체크 · 걸릴 시간이 그대로", () => {
    expect(formatStepLines(LIST)).toBe("읽기\n정리\n  1장\n  2장\n문제");
    expect(mergeSteps(LIST, parseStepLines(formatStepLines(LIST)).lines)).toEqual(LIST);
  });
  it("글자가 같은 줄은 체크를 지킨다 (순서 · 깊이가 바뀌어도, 같은 글자는 앞에서부터)", () => {
    const prev = [c("a", true), c("b"), c("a")];
    const lines = ["b", "a", "새것", "a", "a"].map((t) => ({ t, depth: 0 as const }));
    expect(mergeSteps(prev, lines)).toEqual([c("b"), c("a", true), c("새것"), c("a"), c("a")]);
    expect(mergeSteps(prev, [{ t: "a 고침", depth: 0 }])).toEqual([c("a 고침")]);
    // 윗단이던 것을 들여 써도 체크 · 걸릴 시간을 찾는다
    expect(mergeSteps(LIST, [{ t: "정리", depth: 0 }, { t: "읽기", depth: 1 }])).toEqual([c("정리", false, { sub: [{ t: "읽기", done: true, est: 20 }] })]);
  });
});

describe("규칙의 단계 틀", () => {
  it("단계 → 틀: 체크는 버리고, 걸릴 시간 · 아랫단이 없는 줄은 글자 그대로(옛 모양)", () => {
    expect(ruleChecks(LIST)).toEqual([{ t: "읽기", est: 20 }, { t: "정리", sub: ["1장", { t: "2장", est: 15 }] }, { t: "문제", est: 30 }]);
    expect(ruleChecks([c("a", true), c("b")])).toEqual(["a", "b"]);
  });
  it("틀 → 새 회차의 단계: 전부 안 끝남", () => {
    expect(stepsFromRule(["a", { t: "정리", est: 20, sub: ["1장", { t: "2장", est: 15 }] }])).toEqual([
      { t: "a", done: false },
      { t: "정리", done: false, sub: [{ t: "1장", done: false }, { t: "2장", done: false, est: 15 }] },
    ]);
    expect(stepsFromRule(ruleChecks(LIST)).map((x) => x.done)).toEqual([false, false, false]);
  });
});

describe("모양 검사 (DB CHECK 와 같은 규칙)", () => {
  it("할 일의 체크 항목", () => {
    expect(isChecklist(LIST)).toBe(true);
    expect(isChecklist([])).toBe(true);
    for (const bad of [
      [{ t: "x" }],
      [{ t: "x", done: false, est: 0 }],
      [{ t: "x", done: false, est: 1.5 }],
      [{ t: "x", done: false, sub: [{ t: "y", done: false, sub: [] }] }],
      [{ t: "x", done: false, sub: ["글자"] }],
      [{ t: " x", done: false }],
      [{ t: "x", done: false, note: "덤" }],
      ["글자"],
      null,
      [{ t: "윗단", done: false, sub: Array.from({ length: 50 }, (_, i) => ({ t: `${i}`, done: false })) }],
    ])
      expect(isChecklist(bad), JSON.stringify(bad)?.slice(0, 60)).toBe(false);
  });
  it("규칙의 단계 틀: 글자 또는 {t, est?, sub?}, done 은 없다", () => {
    expect(isRuleChecks(["a", { t: "b", est: 5 }, { t: "c", sub: ["d", { t: "e", est: 1 }] }])).toBe(true);
    expect(isRuleChecks([{ t: "a", done: false }])).toBe(false);
    expect(isRuleChecks([{ t: "a", sub: [{ t: "b", sub: [] }] }])).toBe(false);
    expect(isRuleChecks([1])).toBe(false);
  });
  it("같은 단계인지는 칸 순서 · 빈 sub 를 안 본다", () => {
    const db = [{ t: "a", est: 5, done: false }, { t: "b", sub: [], done: true }] as CheckItem[];
    expect(sameSteps(db, [c("a", false, { est: 5 }), c("b", true)])).toBe(true);
    expect(sameSteps(db, [c("a"), c("b", true)])).toBe(false);
  });
});
