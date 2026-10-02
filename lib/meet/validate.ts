// 모임 · 묶음 · 사람 입력 검사. MCP 와 웹이 같이 쓴다. 같은 규칙을 DB CHECK(0011)도 지킨다 (docs/모임.md 2장).

import { charCount } from "../names";
import { isDateStr, type Issue } from "../schedule";
import { validatePoll } from "./cells";
import { CIRCLE_NAME_MAX, MEET_NOTE_MAX, MEET_TITLE_MAX, MEMBERS_MAX, PEOPLE_MAX, PERSON_NAME_MAX, PLACE_TEXT_MAX } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const absent = (v: unknown) => v === undefined || v === null;

/** 이름 겹침을 볼 때의 열쇠: 대소문자 · 공백 무시 (0011 ez_name_key 와 같다) */
export function nameKey(s: string): string {
  return s.replace(/\s/g, "").toLowerCase();
}

/** 이름 목록에서 앞에 나온 것과 겹치는 첫 이름. 없으면 null */
export function firstDuplicate(names: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const n of names) {
    const k = nameKey(n);
    if (seen.has(k)) return n;
    seen.add(k);
  }
  return null;
}

/** 사람 이름 하나. 문제가 없으면 null */
export function personNameProblem(v: unknown): string | null {
  if (typeof v !== "string") return "이름이 없습니다";
  const n = charCount(v.trim());
  if (n === 0) return "이름이 비어 있습니다";
  if (n > PERSON_NAME_MAX) return `이름은 ${PERSON_NAME_MAX}자까지 쓸 수 있습니다 (지금 ${n}자)`;
  return null;
}

/** 이름들(묶음의 사람들 · 모임에 넣을 사람들): 각 1~20자, 겹침 없음, max 개까지 */
export function validateNames(v: unknown, path: string, max: number): Issue[] {
  if (!Array.isArray(v)) return [{ path, reason: "이름 목록이 배열이 아닙니다" }];
  const out: Issue[] = [];
  if (v.length > max) out.push({ path, reason: `${max}명까지 넣을 수 있습니다 (지금 ${v.length}명)` });
  v.forEach((x, i) => {
    const why = personNameProblem(x);
    if (why) out.push({ path: `${path}[${i}]`, reason: why });
  });
  if (out.length === 0) {
    const dup = firstDuplicate(v.map((x) => String(x).trim()));
    if (dup !== null) out.push({ path, reason: `같은 이름이 두 번 있습니다: ${dup}` });
  }
  return out;
}

/** 모임에 넣을 사람들 (나 빼고 49명까지 — 내 줄까지 50명) */
export function validatePeople(v: unknown, path = "people"): Issue[] {
  return validateNames(v, path, PEOPLE_MAX - 1);
}

/** 모임 한 줄 검사 (고칠 땐 현재 값에 바꿀 칸을 합친 뒤 넣는다). 문제가 없으면 빈 목록 */
export function validateMeet(input: unknown): Issue[] {
  if (!isObj(input)) return [{ path: "", reason: "모임이 객체가 아닙니다" }];
  const o = input;
  const out: Issue[] = [];
  if (typeof o.title !== "string") out.push({ path: "title", reason: "제목이 없습니다" });
  else {
    const n = charCount(o.title.trim());
    if (n === 0) out.push({ path: "title", reason: "제목이 비어 있습니다" });
    else if (n > MEET_TITLE_MAX) out.push({ path: "title", reason: `제목은 ${MEET_TITLE_MAX}자까지 쓸 수 있습니다 (지금 ${n}자)` });
  }
  if (!absent(o.note)) {
    if (typeof o.note !== "string") out.push({ path: "note", reason: "메모는 글이어야 합니다" });
    else if (charCount(o.note) > MEET_NOTE_MAX) out.push({ path: "note", reason: `메모는 ${MEET_NOTE_MAX}자까지 쓸 수 있습니다 (지금 ${charCount(o.note)}자)` });
  }
  if (!absent(o.place_text)) {
    if (typeof o.place_text !== "string") out.push({ path: "place_text", reason: "장소는 글이어야 합니다" });
    else {
      const n = charCount(o.place_text.trim());
      if (n === 0) out.push({ path: "place_text", reason: "장소가 비어 있습니다 (없으면 비우세요)" });
      else if (n > PLACE_TEXT_MAX) out.push({ path: "place_text", reason: `장소는 ${PLACE_TEXT_MAX}자까지 쓸 수 있습니다 (지금 ${n}자)` });
    }
  }
  if (!absent(o.poll)) out.push(...validatePoll(o.poll));

  const d = o.meet_date;
  const s = o.start_min;
  const e = o.end_min;
  const none = [d, s, e].filter(absent).length;
  if (none === 3) return out;
  if (none > 0) {
    out.push({
      path: absent(d) ? "meet_date" : absent(s) ? "start_min" : "end_min",
      reason: "시간을 정했으면 날짜 · 시작 · 끝을 모두 채우고, 안 정했으면 모두 비웁니다",
    });
    return out;
  }
  if (!isDateStr(d)) out.push({ path: "meet_date", reason: "날짜는 YYYY-MM-DD 입니다" });
  if (!isInt(s) || s < 0 || s > 1439) out.push({ path: "start_min", reason: "시작은 0~1439분(00:00~23:59)입니다" });
  else if (!isInt(e) || e <= s) out.push({ path: "end_min", reason: "끝이 시작보다 늦어야 합니다" });
  else if (e > 1440) out.push({ path: "end_min", reason: "모임은 자정을 넘길 수 없습니다 (끝은 24:00 까지)" });
  return out;
}

/** 묶음 한 줄 검사. 문제가 없으면 빈 목록 */
export function validateCircle(input: unknown): Issue[] {
  if (!isObj(input)) return [{ path: "", reason: "묶음이 객체가 아닙니다" }];
  const out: Issue[] = [];
  if (typeof input.name !== "string") out.push({ path: "name", reason: "묶음 이름이 없습니다" });
  else {
    const n = charCount(input.name.trim());
    if (n === 0) out.push({ path: "name", reason: "묶음 이름이 비어 있습니다" });
    else if (n > CIRCLE_NAME_MAX) out.push({ path: "name", reason: `묶음 이름은 ${CIRCLE_NAME_MAX}자까지 쓸 수 있습니다 (지금 ${n}자)` });
  }
  if (!absent(input.members)) out.push(...validateNames(input.members, "members", MEMBERS_MAX));
  return out;
}
