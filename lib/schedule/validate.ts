// 일정·할 일 입력 검사. MCP 와 웹이 같이 쓴다. 같은 규칙을 DB CHECK 도 지킨다 (docs/일정.md 2장, docs/플래너.md 2장).

import { charCount } from "../names";
import { isDateStr } from "./dates";
import { NOTE_MAX, TASK_TITLE_MAX, TITLE_MAX } from "./types";

export type Issue = { path: string; reason: string };

export const WHERE_MAX = 100;
export const TRAVEL_MAX = 600;
export const EST_MIN = 5;
export const EST_MAX = 600;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const absent = (v: unknown) => v === undefined || v === null;

function title(v: unknown, max: number, out: Issue[]) {
  if (typeof v !== "string") return out.push({ path: "title", reason: "제목이 없습니다" });
  const n = charCount(v.trim());
  if (n === 0) out.push({ path: "title", reason: "제목이 비어 있습니다" });
  else if (n > max) out.push({ path: "title", reason: `제목은 ${max}자까지 쓸 수 있습니다 (지금 ${n}자)` });
}

function text(o: Obj, key: string, max: number, name: string, out: Issue[]) {
  const v = o[key];
  if (absent(v)) return;
  if (typeof v !== "string") return out.push({ path: key, reason: `${name} 글이어야 합니다` });
  const n = charCount(v);
  if (n > max) out.push({ path: key, reason: `${name} ${max}자까지 쓸 수 있습니다 (지금 ${n}자)` });
}

function repeat(v: unknown, date: unknown, out: Issue[]) {
  if (absent(v)) return;
  if (!isObj(v) || (v.freq !== "daily" && v.freq !== "weekly")) {
    return out.push({ path: "repeat", reason: "반복은 없음 · {freq:'daily'} · {freq:'weekly', days:[1..7]} 중 하나입니다" });
  }
  if (v.freq === "weekly") {
    const days = v.days;
    if (!Array.isArray(days) || days.length === 0) {
      out.push({ path: "repeat.days", reason: "매주 반복은 요일을 하나 이상 골라야 합니다 (1=월 … 7=일)" });
    } else if (!days.every((d) => isInt(d) && d >= 1 && d <= 7)) {
      out.push({ path: "repeat.days", reason: "요일은 1(월)~7(일) 정수입니다" });
    } else if (new Set(days).size !== days.length) {
      out.push({ path: "repeat.days", reason: "같은 요일이 두 번 있습니다" });
    }
  }
  const until = v.until;
  if (absent(until)) return;
  if (!isDateStr(until)) out.push({ path: "repeat.until", reason: "끝나는 날은 YYYY-MM-DD 날짜입니다" });
  else if (isDateStr(date) && until < date) out.push({ path: "repeat.until", reason: "끝나는 날이 시작 날짜보다 이릅니다" });
}

/** 일정 한 줄 검사 (고칠 땐 현재 값에 바꿀 칸을 합친 뒤 넣는다). 문제가 없으면 빈 목록 */
export function validateEvent(input: unknown): Issue[] {
  const out: Issue[] = [];
  if (!isObj(input)) return [{ path: "", reason: "일정이 객체가 아닙니다" }];
  const o = input;
  title(o.title, TITLE_MAX, out);
  if (!isDateStr(o.date)) out.push({ path: "date", reason: "날짜는 YYYY-MM-DD 입니다" });

  const s = o.start_min;
  const e = o.end_min;
  if (absent(s) !== absent(e)) {
    out.push({ path: absent(s) ? "start_min" : "end_min", reason: "종일이면 시작·끝을 둘 다 비우고, 아니면 둘 다 채웁니다" });
  } else if (!absent(s)) {
    if (!isInt(s) || s < 0 || s > 1439) out.push({ path: "start_min", reason: "시작은 0~1439분(00:00~23:59)입니다" });
    else if (!isInt(e) || e <= s) out.push({ path: "end_min", reason: "끝이 시작보다 늦어야 합니다" });
    else if (e > s + 1440) out.push({ path: "end_min", reason: "일정은 24시간을 넘을 수 없습니다" });
  }

  const pid = o.place_id;
  if (!absent(pid) && (typeof pid !== "string" || pid === "")) out.push({ path: "place_id", reason: "지점 id 가 맞지 않습니다" });
  text(o, "where_text", WHERE_MAX, "상세 장소는", out);
  const t = o.travel_min;
  if (!absent(t) && (!isInt(t) || t < 0 || t > TRAVEL_MAX)) {
    out.push({ path: "travel_min", reason: `이동시간은 0~${TRAVEL_MAX}분 정수입니다` });
  }
  text(o, "note", NOTE_MAX, "메모는", out);
  repeat(o.repeat, o.date, out);
  return out;
}

/** 할 일 한 줄 검사. 문제가 없으면 빈 목록 */
export function validateTask(input: unknown): Issue[] {
  const out: Issue[] = [];
  if (!isObj(input)) return [{ path: "", reason: "할 일이 객체가 아닙니다" }];
  title(input.title, TASK_TITLE_MAX, out);
  text(input, "note", NOTE_MAX, "메모는", out);
  if (!absent(input.due) && !isDateStr(input.due)) out.push({ path: "due", reason: "마감은 YYYY-MM-DD 날짜입니다" });
  const est = input.est_min;
  if (!absent(est) && (!isInt(est) || est < EST_MIN || est > EST_MAX)) {
    out.push({ path: "est_min", reason: `걸릴 시간은 ${EST_MIN}~${EST_MAX}분 정수입니다` });
  }
  return out;
}
