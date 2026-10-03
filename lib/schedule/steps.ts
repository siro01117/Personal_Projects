// 단계(체크 항목) 다루기 — 두 단까지 (docs/플래너.md 7-6 · 7-16). DOM 없는 순수 함수.
// 웹(집중 화면 · 할 일 보기 · 수정 칸 · 메모리 저장소)과 MCP 가 같이 쓴다. 같은 모양을 DB(0018 ez_checklist_ok · ez_check_texts_ok)도 지킨다.
//
// 모양: [{t, done, est?, sub?: [{t, done, est?}]}]. 윗단 + 아랫단 합쳐 50개까지, 아랫단은 더 못 들어간다.
// 화면은 줄 단위로 다룬다 — "평탄 번호 k" 는 윗단과 그 아랫단을 위에서부터 센 번호다.
// 윗단에 아랫단이 있으면 윗단의 걸릴 시간(est)은 아랫단 합이다(직접 적은 값은 버린다).

import { charCount } from "../names";
import { CHECK_ITEM_MAX, CHECKLIST_MAX, STEP_EST_MAX, STEP_EST_MIN, type CheckItem, type RuleCheck, type RuleSub, type SubCheck } from "./types";

/** 화면의 한 줄. k = 평탄 번호, (i, j) = 윗단 번호와 아랫단 번호(윗단이면 null) */
export type FlatStep = {
  k: number;
  i: number;
  j: number | null;
  depth: 0 | 1;
  t: string;
  done: boolean;
  /** 걸릴 시간(분). 아랫단이 있는 윗단이면 아랫단 합 */
  est: number | null;
  /** 아랫단이 있는 윗단 */
  parent: boolean;
};

const subsOf = (c: Pick<CheckItem, "sub">): SubCheck[] => c.sub ?? [];

function sub(t: string, done: boolean, est?: number | null): SubCheck {
  return est == null ? { t, done } : { t, done, est };
}

/** 깔끔한 한 줄: 빈 sub 는 빼고, 아랫단이 있으면 윗단의 est 는 뺀다 */
function item(t: string, done: boolean, est?: number | null, subs: readonly SubCheck[] = []): CheckItem {
  if (subs.length > 0) return { t, done, sub: subs.map((s) => sub(s.t, s.done, s.est)) };
  return est == null ? { t, done } : { t, done, est };
}

/** 저장할 모양으로 다듬는다 (빈 sub · 아랫단이 있는 윗단의 est 를 뺀다) */
export function tidySteps(list: readonly CheckItem[]): CheckItem[] {
  return list.map((c) => item(c.t, c.done, c.est, subsOf(c)));
}

/** 두 목록이 같은 단계인가 (칸 순서 · 빈 sub 는 보지 않는다 — DB 의 jsonb 는 칸 순서를 바꿔 돌려준다) */
export function sameSteps(a: readonly CheckItem[], b: readonly CheckItem[]): boolean {
  return JSON.stringify(tidySteps(a)) === JSON.stringify(tidySteps(b));
}

// ------------------------------------------------------------ 읽기

/** 한 줄의 걸릴 시간(분): 아랫단이 있으면 그 합(하나도 안 적었으면 null), 없으면 적은 값 */
export function stepEst(c: CheckItem): number | null {
  const subs = subsOf(c);
  if (subs.length === 0) return c.est ?? null;
  const known = subs.filter((s) => s.est != null);
  return known.length === 0 ? null : known.reduce((n, s) => n + s.est!, 0);
}

/** 줄 단위로 편다 */
export function flatSteps(list: readonly CheckItem[]): FlatStep[] {
  const out: FlatStep[] = [];
  list.forEach((c, i) => {
    const subs = subsOf(c);
    out.push({ k: out.length, i, j: null, depth: 0, t: c.t, done: c.done, est: stepEst(c), parent: subs.length > 0 });
    subs.forEach((s, j) => out.push({ k: out.length, i, j, depth: 1, t: s.t, done: s.done, est: s.est ?? null, parent: false }));
  });
  return out;
}

/** 전체 줄 수 (윗단 + 아랫단) — 상한 50 은 이것으로 센다 */
export function stepCount(list: readonly CheckItem[]): number {
  return list.reduce((n, c) => n + 1 + subsOf(c).length, 0);
}

/** 진행: 끝낸 줄 수 / 전체 줄 수. 단계가 없으면 null */
export function stepProgress(list: readonly CheckItem[]): { done: number; total: number; all: boolean } | null {
  const flat = flatSteps(list);
  if (flat.length === 0) return null;
  const done = flat.filter((s) => s.done).length;
  return { done, total: flat.length, all: done === flat.length };
}

/** 단계에 적은 걸릴 시간의 합(분). 하나도 안 적었으면 0 */
export function estSum(list: readonly CheckItem[]): number {
  return list.reduce((n, c) => n + (stepEst(c) ?? 0), 0);
}

/**
 * 지금 단계: 깊이와 상관없이 첫 번째 안 끝난 줄의 평탄 번호. 다 끝났거나 단계가 없으면 null.
 * 안 끝난 윗단에 안 끝난 아랫단이 있으면 그 아랫단이 지금 단계다(윗단은 묶음). 끝낸 윗단은 아랫단째 건너뛴다
 */
export function currentStep(list: readonly CheckItem[]): number | null {
  let k = 0;
  for (const c of list) {
    const subs = subsOf(c);
    if (!c.done) {
      const j = subs.findIndex((s) => !s.done);
      return j >= 0 ? k + 1 + j : k;
    }
    k += 1 + subs.length;
  }
  return null;
}

/** k 번째 줄이 어디인가. 없으면 null */
function locate(list: readonly CheckItem[], k: number): { i: number; j: number | null } | null {
  const f = flatSteps(list)[k];
  return f ? { i: f.i, j: f.j } : null;
}

/** 그 줄(윗단 i · 아랫단 j)의 평탄 번호 */
export function flatIndex(list: readonly CheckItem[], i: number, j: number | null): number {
  let k = 0;
  for (let x = 0; x < i && x < list.length; x++) k += 1 + subsOf(list[x]!).length;
  return j === null ? k : k + 1 + j;
}

/**
 * 조금 전에 본 줄(글자 · 깊이 · 번호)을 지금 목록에서 찾는다 — 그사이 순서가 바뀌었을 수 있다.
 * 같은 번호에 그대로 있으면 그 번호, 아니면 글자와 깊이가 같은 첫 줄. 없으면 -1
 */
export function findStep(list: readonly CheckItem[], ref: Pick<FlatStep, "k" | "t" | "depth">): number {
  const flat = flatSteps(list);
  const at = flat[ref.k];
  if (at && at.t === ref.t && at.depth === ref.depth) return ref.k;
  return flat.findIndex((s) => s.t === ref.t && s.depth === ref.depth);
}

// ------------------------------------------------------------ 고치기 (새 목록을 돌려준다)

/** 체크 · 체크 풀기. 윗단을 체크하면 아랫단도 체크된다. 아랫단을 다 체크해도 윗단은 그대로(사람이 누른다) */
export function toggleStep(list: readonly CheckItem[], k: number, done: boolean): CheckItem[] {
  const at = locate(list, k);
  if (!at) return [...list];
  return list.map((c, i) => {
    if (i !== at.i) return c;
    const subs = subsOf(c);
    if (at.j === null) return item(c.t, done, c.est, done ? subs.map((s) => ({ ...s, done: true })) : subs);
    return item(c.t, c.done, c.est, subs.map((s, j) => (j === at.j ? { ...s, done } : s)));
  });
}

/** 들일 수 있나: 윗단이고 첫 줄이 아니다 */
export function canIndent(list: readonly CheckItem[], k: number): boolean {
  const at = locate(list, k);
  return at !== null && at.j === null && at.i > 0;
}

/** 낼 수 있나: 아랫단이다 */
export function canOutdent(list: readonly CheckItem[], k: number): boolean {
  return (locate(list, k)?.j ?? null) !== null;
}

/**
 * 들이기 (Tab): 윗단 줄이 바로 위 윗단의 맨 끝 아랫단이 된다. 자기 아랫단이 있었으면 같이 그 윗단의 아랫단으로 간다(둘째 단 밑은 없다).
 * 첫 줄 · 이미 아랫단인 줄은 못 들인다 — 그대로 돌려준다
 */
export function indentStep(list: readonly CheckItem[], k: number): CheckItem[] {
  const at = locate(list, k);
  if (!at || at.j !== null || at.i === 0) return [...list];
  const me = list[at.i]!;
  const up = list[at.i - 1]!;
  const moved = [sub(me.t, me.done, subsOf(me).length > 0 ? null : me.est), ...subsOf(me)];
  const next = item(up.t, up.done, null, [...subsOf(up), ...moved]);
  return [...list.slice(0, at.i - 1), next, ...list.slice(at.i + 1)];
}

/**
 * 내기 (Shift+Tab): 아랫단 줄이 윗단이 되어 자기 윗단 바로 아래에 온다. 뒤에 있던 아랫단은 이 줄의 아랫단이 된다(보이는 순서가 그대로).
 * 윗단 줄은 못 낸다 — 그대로 돌려준다
 */
export function outdentStep(list: readonly CheckItem[], k: number): CheckItem[] {
  const at = locate(list, k);
  if (!at || at.j === null) return [...list];
  const up = list[at.i]!;
  const subs = subsOf(up);
  const me = subs[at.j]!;
  const head = item(up.t, up.done, up.est, subs.slice(0, at.j));
  const top = item(me.t, me.done, me.est, subs.slice(at.j + 1));
  return [...list.slice(0, at.i), head, top, ...list.slice(at.i + 1)];
}

/** 걸릴 시간 칸 → 분. 빈칸이면 null, 1~600 정수가 아니면 NaN */
export function parseStepEst(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return Number.NaN;
  const n = Number(t);
  return n >= STEP_EST_MIN && n <= STEP_EST_MAX ? n : Number.NaN;
}

/** 한 줄의 걸릴 시간을 적거나(분) 지운다(null). 아랫단이 있는 윗단은 직접 못 적는다 — 그대로 돌려준다 */
export function setStepEst(list: readonly CheckItem[], k: number, est: number | null): CheckItem[] {
  const at = locate(list, k);
  if (!at) return [...list];
  return list.map((c, i) => {
    if (i !== at.i) return c;
    const subs = subsOf(c);
    if (at.j === null) return subs.length > 0 ? c : item(c.t, c.done, est);
    return item(c.t, c.done, c.est, subs.map((s, j) => (j === at.j ? sub(s.t, s.done, est) : s)));
  });
}

/**
 * 빈 줄(적는 칸)이 놓일 깊이. after = 그 위의 줄(평탄 번호, null 이면 맨 끝), want = 바라는 깊이.
 * 아랫단이 있는 윗단 바로 아래는 늘 아랫단. 맨 끝은 줄이 하나라도 있어야 아랫단이 된다
 */
export function draftDepth(list: readonly CheckItem[], after: number | null, want: 0 | 1): 0 | 1 {
  if (list.length === 0) return 0;
  if (after === null) return want;
  const f = flatSteps(list)[after];
  if (!f) return 0;
  return f.parent ? 1 : want;
}

/**
 * 줄 하나 넣기. after 줄 바로 아래(null 이면 맨 끝)에 depth 깊이로. 앞뒤 공백을 떼고, 비면 그대로(k = null).
 * 넘치면 issue. 넣었으면 그 줄의 평탄 번호 k
 */
export function insertStep(
  list: readonly CheckItem[],
  after: number | null,
  want: 0 | 1,
  text: string,
): { list: CheckItem[]; issue: string | null; k: number | null } {
  const t = text.trim();
  const same = { list: [...list], k: null };
  if (t === "") return { ...same, issue: null };
  if (stepCount(list) >= CHECKLIST_MAX) return { ...same, issue: `단계는 ${CHECKLIST_MAX}개까지입니다` };
  if (charCount(t) > CHECK_ITEM_MAX) return { ...same, issue: `단계 하나는 ${CHECK_ITEM_MAX}자까지입니다` };
  const depth = draftDepth(list, after, want);
  const at = after === null ? null : locate(list, after);
  let next: CheckItem[];
  let i: number;
  let j: number | null;
  if (!at) {
    // 맨 끝
    if (depth === 1) {
      i = list.length - 1;
      const up = list[i]!;
      j = subsOf(up).length;
      next = [...list.slice(0, i), item(up.t, up.done, null, [...subsOf(up), sub(t, false)])];
    } else {
      i = list.length;
      j = null;
      next = [...list, item(t, false)];
    }
  } else {
    const up = list[at.i]!;
    const subs = subsOf(up);
    i = at.i;
    if (depth === 1) {
      j = at.j === null ? 0 : at.j + 1;
      next = [...list.slice(0, i), item(up.t, up.done, null, [...subs.slice(0, j), sub(t, false), ...subs.slice(j)]), ...list.slice(i + 1)];
    } else if (at.j === null) {
      i = at.i + 1;
      j = null;
      next = [...list.slice(0, i), item(t, false), ...list.slice(i)];
    } else {
      // 아랫단 줄 아래에 윗단으로: 뒤의 아랫단은 새 줄의 아랫단이 된다 (내기와 같다)
      const head = item(up.t, up.done, up.est, subs.slice(0, at.j + 1));
      i = at.i + 1;
      j = null;
      next = [...list.slice(0, at.i), head, item(t, false, null, subs.slice(at.j + 1)), ...list.slice(at.i + 1)];
    }
  }
  return { list: next, issue: null, k: flatIndex(next, i, j) };
}

/** 뺀 줄 — 되돌릴 때 그 자리에 다시 넣는다. 윗단이면 아랫단째 */
export type RemovedStep = { i: number; j: number | null; item: CheckItem };

/** k 번째 줄을 뺀다. 윗단이면 아랫단도 같이 빠진다. 없는 줄이면 removed = null */
export function removeStep(list: readonly CheckItem[], k: number): { list: CheckItem[]; removed: RemovedStep | null } {
  const at = locate(list, k);
  if (!at) return { list: [...list], removed: null };
  const up = list[at.i]!;
  if (at.j === null) return { list: list.filter((_, i) => i !== at.i), removed: { i: at.i, j: null, item: up } };
  const subs = subsOf(up);
  const me = subs[at.j]!;
  return {
    list: list.map((c, i) => (i === at.i ? item(c.t, c.done, c.est, subs.filter((_, j) => j !== at.j)) : c)),
    removed: { i: at.i, j: at.j, item: sub(me.t, me.done, me.est) },
  };
}

/** 뺀 줄을 제자리에 다시 (되돌리기). 그사이 윗단이 없어졌으면 맨 끝 윗단으로 */
export function restoreStep(list: readonly CheckItem[], r: RemovedStep): CheckItem[] {
  if (r.j === null) {
    const at = Math.max(0, Math.min(list.length, r.i));
    return [...list.slice(0, at), r.item, ...list.slice(at)];
  }
  const up = list[r.i];
  if (!up) return [...list, item(r.item.t, r.item.done, r.item.est)];
  const subs = subsOf(up);
  const at = Math.max(0, Math.min(subs.length, r.j));
  const back = sub(r.item.t, r.item.done, r.item.est);
  return list.map((c, i) => (i === r.i ? item(c.t, c.done, c.est, [...subs.slice(0, at), back, ...subs.slice(at)]) : c));
}

/** 윗단 from 을 to 자리로 (to 는 그 줄을 뺀 윗단 목록에서의 자리). 아랫단은 따라간다 */
export function moveStep(list: readonly CheckItem[], from: number, to: number): CheckItem[] {
  const me = list[from];
  if (!me) return [...list];
  const rest = list.filter((_, k) => k !== from);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), me, ...rest.slice(at)];
}

/** 윗단 i 의 아랫단 from 을 to 자리로 (같은 윗단 안에서만) */
export function moveSubStep(list: readonly CheckItem[], i: number, from: number, to: number): CheckItem[] {
  const up = list[i];
  const subs = up ? subsOf(up) : [];
  const me = subs[from];
  if (!up || !me) return [...list];
  const rest = subs.filter((_, k) => k !== from);
  const at = Math.max(0, Math.min(rest.length, to));
  return list.map((c, x) => (x === i ? item(c.t, c.done, c.est, [...rest.slice(0, at), me, ...rest.slice(at)]) : c));
}

/**
 * 떼어내기: k 번째 줄이 새 할 일이 된다. 제목 = 그 줄. 윗단이면 아랫단이 새 할 일의 단계가 된다(체크 · 걸릴 시간 그대로).
 * 돌려주는 것: 새 할 일의 제목 · 단계, 그 줄을 뺀 목록, 되돌릴 때 쓸 자리. 없는 줄이면 null
 */
export function detachStep(list: readonly CheckItem[], k: number): { title: string; checklist: CheckItem[]; rest: CheckItem[]; removed: RemovedStep } | null {
  const r = removeStep(list, k);
  if (!r.removed) return null;
  const subs = r.removed.j === null ? subsOf(r.removed.item) : [];
  return { title: r.removed.item.t, checklist: subs.map((s) => item(s.t, s.done, s.est)), rest: r.list, removed: r.removed };
}

/**
 * 덧붙이기만 (MCP — 사람이 적은 계획을 덮지 않는다): 지금 단계는 그대로 두고 add 를 뒤에 더한다.
 * 이미 같은 글자의 윗단이 있으면 그 줄은 건너뛴다(같은 것을 두 번 보내도 한 번만). 비어 있으면 add 가 그대로 들어간다
 */
export function appendSteps(cur: readonly CheckItem[], add: readonly CheckItem[]): CheckItem[] {
  const have = new Set(cur.map((c) => c.t));
  const out = tidySteps(cur);
  for (const c of add) {
    if (have.has(c.t)) continue;
    have.add(c.t);
    out.push(item(c.t, c.done, c.est, subsOf(c)));
  }
  return out;
}

// ------------------------------------------------------------ 글자로 적기 (수정 칸 — 한 줄에 하나, 들여 쓰면 아랫단)

export type StepLine = { t: string; depth: 0 | 1 };

/**
 * 수정 칸의 여러 줄 → 줄 목록. 한 줄에 하나, 앞뒤 공백을 떼고 빈 줄은 버린다.
 * 탭이나 공백 둘 이상으로 들여 쓴 줄은 아랫단(첫 줄은 늘 윗단). 넘치면 issue
 */
export function parseStepLines(text: string): { lines: StepLine[]; issue: string | null } {
  const lines: StepLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t === "") continue;
    lines.push({ t, depth: lines.length > 0 && /^(\t| {2,})/.test(raw) ? 1 : 0 });
  }
  let issue: string | null = null;
  if (lines.length > CHECKLIST_MAX) issue = `체크 항목은 ${CHECKLIST_MAX}개까지입니다 (지금 ${lines.length}개)`;
  else if (lines.some((l) => charCount(l.t) > CHECK_ITEM_MAX)) issue = `체크 항목 하나는 ${CHECK_ITEM_MAX}자까지입니다`;
  return { lines, issue };
}

/** 단계 → 수정 칸의 글자 (아랫단은 공백 둘로 들인다) */
export function formatStepLines(list: readonly CheckItem[]): string {
  return flatSteps(list)
    .map((s) => (s.depth === 1 ? `  ${s.t}` : s.t))
    .join("\n");
}

/**
 * 고친 줄에 체크 · 걸릴 시간을 얹는다: 글자와 깊이가 같은 줄은 그대로 지킨다(같은 글자가 여럿이면 앞에서부터 하나씩),
 * 깊이만 바뀐 줄은 글자로 찾는다
 */
export function mergeSteps(prev: readonly CheckItem[], lines: readonly StepLine[]): CheckItem[] {
  const left = flatSteps(prev).map((s) => ({ t: s.t, depth: s.depth, done: s.done, est: s.parent ? null : s.est }));
  const take = (l: StepLine) => {
    let i = left.findIndex((c) => c.t === l.t && c.depth === l.depth);
    if (i < 0) i = left.findIndex((c) => c.t === l.t);
    return i < 0 ? { done: false, est: null as number | null } : left.splice(i, 1)[0]!;
  };
  const out: CheckItem[] = [];
  for (const l of lines) {
    const hit = take(l);
    const up = out[out.length - 1];
    if (l.depth === 1 && up) out[out.length - 1] = item(up.t, up.done, null, [...subsOf(up), sub(l.t, hit.done, hit.est)]);
    else out.push(item(l.t, hit.done, hit.est));
  }
  return out;
}

// ------------------------------------------------------------ 규칙의 단계 틀

const ruleSub = (s: RuleSub): SubCheck => (typeof s === "string" ? { t: s, done: false } : sub(s.t, false, s.est));

/** 규칙의 단계 틀 → 새 회차의 단계 (전부 안 끝남). 0018 ez_check_from_texts 와 같다 */
export function stepsFromRule(tpl: readonly RuleCheck[]): CheckItem[] {
  return tpl.map((c) => (typeof c === "string" ? { t: c, done: false } : item(c.t, false, c.est, (c.sub ?? []).map(ruleSub))));
}

/** 단계 → 규칙의 단계 틀 (체크는 버린다). 걸릴 시간 · 아랫단이 없는 줄은 글자 그대로 — 옛 모양과 같다 */
export function ruleChecks(list: readonly CheckItem[]): RuleCheck[] {
  return list.map((c) => {
    const subs = subsOf(c);
    if (subs.length > 0) return { t: c.t, sub: subs.map((s) => (s.est == null ? s.t : { t: s.t, est: s.est })) };
    return c.est == null ? c.t : { t: c.t, est: c.est };
  });
}

// ------------------------------------------------------------ 모양 검사 (DB CHECK 와 같은 규칙 — 메모리 저장소 · MCP 입력)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function lineOk(v: unknown, done: boolean, canSub: boolean): boolean {
  if (!isObj(v) || typeof v.t !== "string") return false;
  for (const key of Object.keys(v)) {
    if (key !== "t" && key !== "est" && !(done && key === "done") && !(canSub && key === "sub")) return false;
  }
  if (done && typeof v.done !== "boolean") return false;
  const n = charCount(v.t);
  if (v.t !== v.t.trim() || n < 1 || n > CHECK_ITEM_MAX) return false;
  if ("est" in v && (typeof v.est !== "number" || !Number.isInteger(v.est) || v.est < STEP_EST_MIN || v.est > STEP_EST_MAX)) return false;
  return !("sub" in v) || Array.isArray(v.sub);
}

function listOk(v: unknown, done: boolean): boolean {
  if (!Array.isArray(v)) return false;
  let n = 0;
  for (const raw of v) {
    n++;
    const c: unknown = !done && typeof raw === "string" ? { t: raw } : raw;
    if (!lineOk(c, done, true)) return false;
    for (const s of ((c as { sub?: unknown[] }).sub ?? []) as unknown[]) {
      n++;
      if (!lineOk(!done && typeof s === "string" ? { t: s } : s, done, false)) return false;
    }
  }
  return n <= CHECKLIST_MAX;
}

/** 할 일의 체크 항목 모양이 맞나 (ez_checklist_ok) */
export function isChecklist(v: unknown): v is CheckItem[] {
  return listOk(v, true);
}

/** 규칙의 단계 틀 모양이 맞나 (ez_check_texts_ok) */
export function isRuleChecks(v: unknown): v is RuleCheck[] {
  return listOk(v, false);
}
