// 모임 화면 계산 (docs/모임.md 4 · 5장). DOM 없이 시험할 수 있는 것만:
// "10/7 수 19:00" 같은 글자, 만들기 · 고치기 폼의 값 ↔ 저장할 칸, 묶음을 고르면 사람들이 채워지는 것,
// 다음 모임 · 모임에서 나온 할 일이 물려받는 것, 오류 문구. 상태 · 정렬은 lib/meet 가 한다.
// 시간 맞추기: 후보 날짜 달력 · 추천 시간 글자 · 격자의 칸 높이 · 누른 칸에서 시작하는 묶음 · 공개 링크 주소 · 공개 페이지의 오류 문구.

import type { KoreanError } from "../../lib/errors";
import {
  CIRCLE_NAME_MAX,
  circleOf,
  DEFAULT_POLL,
  nameKey,
  PERSON_NAME_MAX,
  POLL_DATES_MAX,
  roleIdOf,
  samePoll,
  SLOT_MIN,
  type CellAt,
  type Circle,
  type Meet,
  type MeetRow,
  type MeetStatus,
  type Poll,
} from "../../lib/meet";
import { addDays, weekday, type DateStr, type Role, type TaskRow } from "../../lib/schedule";
import { toKorean } from "../../lib/errors";
import type { MeetInput, TaskInput } from "../_data/types";
import { dayLabel, hm, scheduleKorean, timeRange, WEEKDAYS } from "./schedule";

// ------------------------------------------------------------ 글자

const md = (d: DateStr) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const wd = (d: DateStr) => WEEKDAYS[weekday(d) - 1];

/** 후보 날짜 범위 "10/10 – 10/14" (하나면 "10/10") */
export function pollLabel(poll: Poll): string {
  const first = poll.dates[0];
  const last = poll.dates[poll.dates.length - 1];
  if (!first || !last) return "";
  return first === last ? md(first) : `${md(first)} – ${md(last)}`;
}

/** 목록 줄의 시각: 정해졌으면 "10/7 수 19:00", 맞추는 중이면 후보 날짜 범위, 미정이면 빈 글자 */
export function lineWhen(m: Pick<MeetRow, "meet_date" | "start_min" | "poll">): string {
  if (m.meet_date !== null && m.start_min !== null) return `${md(m.meet_date)} ${wd(m.meet_date)} ${hm(m.start_min)}`;
  return m.poll ? pollLabel(m.poll) : "";
}

/** 모임 화면의 언제: "10월 7일 수 · 19:00–21:00". 안 정했으면 null */
export function whenText(m: Pick<MeetRow, "meet_date" | "start_min" | "end_min">): string | null {
  if (m.meet_date === null || m.start_min === null || m.end_min === null) return null;
  return `${dayLabel(m.meet_date)} · ${timeRange(m.start_min, m.end_min)}`;
}

/** 참석 단추 글자: 지난 뒤에는 왔다 / 안 왔다, 그 전에는 온다 / 못 온다 (같은 칸이다) */
export function attendLabels(status: MeetStatus): { yes: string; no: string } {
  return status === "past" ? { yes: "왔다", no: "안 왔다" } : { yes: "온다", no: "못 온다" };
}

// ------------------------------------------------------------ 사람 이름

/** 한 칸에 적은 이름들 → 이름 목록. 쉼표 · 줄바꿈으로 나누고, 앞뒤 공백을 떼고 빈 것은 버린다 */
export function parseNames(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * 이미 있는 이름들에 새 이름들을 더한다. 겹치는 것(대소문자 · 공백 무시)은 한 번만.
 * 너무 긴 이름이 있으면 issue 를 주고 아무것도 더하지 않는다
 */
export function addNames(have: readonly string[], more: readonly string[]): { names: string[]; issue: string | null } {
  if (more.some((n) => [...n].length > PERSON_NAME_MAX)) return { names: [...have], issue: `이름은 ${PERSON_NAME_MAX}자까지입니다` };
  const keys = new Set(have.map(nameKey));
  const names = [...have];
  for (const n of more) {
    if (keys.has(nameKey(n))) continue;
    keys.add(nameKey(n));
    names.push(n);
  }
  return { names, issue: null };
}

// ------------------------------------------------------------ 만들기 · 고치기 폼

/** 폼의 값. 글 칸은 빈 글자 = 없음. 시간은 known 일 때만, 후보 날짜 · 하루 범위 · 길이는 polling 일 때만 쓴다 */
export type MeetDraft = {
  title: string;
  circle_id: string | null;
  /** 시간을 안다 */
  known: boolean;
  date: DateStr;
  start: number;
  end: number;
  /** 시간을 맞춰야 한다 (known 과 같이 켜지지 않는다). 둘 다 꺼져 있으면 아직 모른다 */
  polling: boolean;
  dates: DateStr[];
  dayFrom: number;
  dayTo: number;
  duration: number;
  /** 고치기 전의 맞추기 설정 — 시간이 정해진 모임을 고칠 때 그대로 둔다(다시 열면 이어서 맞춘다) */
  kept: Poll | null;
  place_id: string | null;
  place_text: string;
  note: string;
  /** 새 모임만: 같이 넣을 사람들 (나 빼고) */
  people: string[];
  /** 새 모임만: 사람 칸에 적는 중인 글 (저장할 때 같이 넣는다) */
  personText: string;
  /** 새 모임만, 설정에 내 이름이 없을 때: 처음 한 번 묻는다 */
  myName: string;
};

/** 시간을 안다고 바꿨을 때 처음 보이는 시각: 지금 다음 정시부터 한 시간 (자정을 넘기지 않게) */
export function defaultTime(nowMin: number): { start: number; end: number } {
  const start = Math.min(1380, Math.ceil((nowMin + 1) / 60) * 60);
  return { start, end: start + 60 };
}

export function newMeetDraft(today: DateStr, nowMin: number): MeetDraft {
  return {
    title: "",
    circle_id: null,
    known: false,
    date: today,
    ...defaultTime(nowMin),
    polling: false,
    dates: [],
    dayFrom: DEFAULT_POLL.day_from,
    dayTo: DEFAULT_POLL.day_to,
    duration: DEFAULT_POLL.duration_min,
    kept: null,
    place_id: null,
    place_text: "",
    note: "",
    people: [],
    personText: "",
    myName: "",
  };
}

/** 모임 → 폼. 지운 묶음이면 묶음 없음으로 연다 */
export function meetDraftOf(m: MeetRow, circles: readonly Circle[], today: DateStr, nowMin: number): MeetDraft {
  const known = m.meet_date !== null && m.start_min !== null && m.end_min !== null;
  return {
    title: m.title,
    circle_id: circleOf(m, circles)?.id ?? null,
    known,
    date: m.meet_date ?? today,
    ...(known ? { start: m.start_min!, end: m.end_min! } : defaultTime(nowMin)),
    polling: !known && m.poll !== null,
    dates: m.poll ? [...m.poll.dates] : [],
    dayFrom: m.poll?.day_from ?? DEFAULT_POLL.day_from,
    dayTo: m.poll?.day_to ?? DEFAULT_POLL.day_to,
    duration: m.poll?.duration_min ?? DEFAULT_POLL.duration_min,
    kept: m.poll,
    place_id: m.place_id,
    place_text: m.place_text ?? "",
    note: m.note ?? "",
    people: [],
    personText: "",
    myName: "",
  };
}

/**
 * 묶음을 고른다. 새 모임이면 사람들이 채워진다: 앞서 고른 묶음에서 온 사람은 빼고, 새 묶음의 사람들을 더한다
 * (손으로 적은 사람은 남는다)
 */
export function draftWithCircle(d: MeetDraft, next: Circle | null, circles: readonly Circle[], fill: boolean): MeetDraft {
  const out = { ...d, circle_id: next?.id ?? null };
  if (!fill) return out;
  const prev = d.circle_id === null ? null : (circles.find((c) => c.id === d.circle_id) ?? null);
  const gone = new Set((prev?.members ?? []).map(nameKey));
  const kept = d.people.filter((n) => !gone.has(nameKey(n)));
  return { ...out, people: addNames(kept, next?.members ?? []).names };
}

const orNull = (s: string) => (s.trim() === "" ? null : s);

export type TimeMode = "known" | "poll" | "none";

/** 시간 고르기 셋 중 어느 것인가: 안다 · 맞춰야 한다 · 아직 모른다 */
export function timeMode(d: Pick<MeetDraft, "known" | "polling">): TimeMode {
  return d.known ? "known" : d.polling ? "poll" : "none";
}

export function withTimeMode(d: MeetDraft, mode: TimeMode): MeetDraft {
  return { ...d, known: mode === "known", polling: mode === "poll" };
}

/** 후보 날짜를 켜고 끈다 (이른 날짜부터). 31개를 넘기면 그대로 */
export function toggleDate(dates: readonly DateStr[], d: DateStr): DateStr[] {
  if (dates.includes(d)) return dates.filter((x) => x !== d);
  if (dates.length >= POLL_DATES_MAX) return [...dates];
  return [...dates, d].sort();
}

/** 폼의 맞추기 설정 */
export function draftPoll(d: MeetDraft): Poll {
  return { dates: [...d.dates].sort(), day_from: d.dayFrom, day_to: d.dayTo, duration_min: d.duration };
}

/** 폼 → 모임 칸. 시간을 모르면 셋 다 비운다. 맞추기는 맞춰야 할 때만 — 시간이 정해진 모임은 있던 설정을 그대로 둔다 */
export function draftInput(d: MeetDraft): Required<MeetInput> {
  return {
    poll: d.polling && !d.known ? draftPoll(d) : d.known ? d.kept : null,
    title: d.title.trim(),
    note: orNull(d.note),
    circle_id: d.circle_id,
    place_id: d.place_id,
    place_text: orNull(d.place_text)?.trim() ?? null,
    meet_date: d.known ? d.date : null,
    start_min: d.known ? d.start : null,
    end_min: d.known ? d.end : null,
  };
}

/** 폼에서 바뀐 칸만. 시간은 셋을 같이. 지운 묶음을 가리키던 모임은 묶음을 건드리지 않았으면 그대로 둔다 */
export function draftPatch(d: MeetDraft, m: MeetRow, circles: readonly Circle[]): Partial<MeetInput> {
  const a = draftInput(d);
  const out: Partial<MeetInput> = {};
  if (a.title !== m.title) out.title = a.title;
  if (a.note !== m.note) out.note = a.note;
  if (a.circle_id !== (circleOf(m, circles)?.id ?? null)) out.circle_id = a.circle_id;
  if (a.place_id !== m.place_id) out.place_id = a.place_id;
  if (a.place_text !== m.place_text) out.place_text = a.place_text;
  if (a.meet_date !== m.meet_date || a.start_min !== m.start_min || a.end_min !== m.end_min) {
    out.meet_date = a.meet_date;
    out.start_min = a.start_min;
    out.end_min = a.end_min;
  }
  if (!samePoll(a.poll, m.poll)) out.poll = a.poll;
  return out;
}

/** 새 모임에 같이 넣을 사람들: 칩 + 적는 중인 글. 내 이름과 겹치는 것은 뺀다(내 줄이 따로 생긴다) */
export function draftPeople(d: MeetDraft, myName: string): { names: string[]; issue: string | null } {
  const r = addNames(d.people, parseNames(d.personText));
  return { names: r.names.filter((n) => nameKey(n) !== nameKey(myName)), issue: r.issue };
}

// ------------------------------------------------------------ 파생: 다음 모임 · 할 일

/** 다음 모임: 같은 묶음 · 사람 · 지점 · 제목, 시간만 비어 있다. 지운 묶음은 물려받지 않는다 */
export function nextMeet(m: Meet, circles: readonly Circle[]): { input: MeetInput; people: string[] } {
  return {
    input: { title: m.title, circle_id: circleOf(m, circles)?.id ?? null, place_id: m.place_id, place_text: m.place_text },
    people: m.people.filter((p) => !p.is_owner).map((p) => p.name),
  };
}

/** 모임에서 나온 할 일: 묶음의 역할과 모임의 지점을 물려받는다 */
export function meetTaskInput(title: string, m: MeetRow, circles: readonly Circle[], roles: readonly Pick<Role, "id">[]): TaskInput {
  return { title, origin_kind: "meet", origin_id: m.id, place_id: m.place_id, role_id: roleIdOf(m, circles, roles) };
}

/** 그 모임에서 나온 할 일: 안 끝낸 것(만든 순) 먼저, 끝낸 것은 뒤에 */
export function meetTasks(tasks: readonly TaskRow[], meetId: string): TaskRow[] {
  return tasks
    .filter((t) => t.origin_kind === "meet" && t.origin_id === meetId)
    .sort((a, b) => Number(a.done_at !== null) - Number(b.done_at !== null) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------ 시간 맞추기

/** 달력 한 달: 월요일부터 7칸씩. 그 달이 아닌 칸은 null. month 는 그 달의 아무 날짜 */
export function monthGrid(month: DateStr): (DateStr | null)[][] {
  const first = `${month.slice(0, 8)}01`;
  const lead = weekday(first) - 1;
  const cells: (DateStr | null)[] = Array.from({ length: lead }, () => null);
  for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const out: (DateStr | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  return out;
}

/** 앞 · 뒤 달의 1일 */
export function shiftMonth(month: DateStr, by: number): DateStr {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + by;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${String(yy).padStart(4, "0")}-${String(mm + 1).padStart(2, "0")}-01`;
}

/** "2026년 10월" */
export function monthTitle(month: DateStr): string {
  return `${Number(month.slice(0, 4))}년 ${Number(month.slice(5, 7))}월`;
}

/** 모임 길이 "1시간 30분" · "30분" · "2시간" */
export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h === 0 ? `${m}분` : m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/** 하루 범위의 끝 "24:00" (hm 은 00:00 으로 돈다) */
export function hmEnd(min: number): string {
  return min >= 1440 ? "24:00" : hm(min);
}

/** 격자 머리의 날짜: "10/7" 과 요일 */
export function gridDay(d: DateStr): { md: string; wd: string } {
  return { md: md(d), wd: wd(d) ?? "" };
}

/** 추천 시간 한 줄: "10/7 수 19:00–20:30" */
export function slotLabel(s: { date: DateStr; start: number; end: number }): string {
  return `${md(s.date)} ${wd(s.date)} ${hm(s.start)}–${hmEnd(s.end)}`;
}

/** 공개 페이지의 정한 시간: 날짜 "10월 7일 수" 와 시각 "19:00–20:30" */
export function decidedText(m: { meet_date: DateStr | null; start_min: number | null; end_min: number | null }): { day: string; time: string } | null {
  if (m.meet_date === null || m.start_min === null || m.end_min === null) return null;
  return { day: dayLabel(m.meet_date), time: `${hm(m.start_min)}–${hmEnd(m.end_min)}` };
}

/** 격자에서 누른 칸에서 시작하는 묶음 (모임 길이만큼). 하루 범위를 넘기면 끝에 맞춰 당긴다 */
export function windowAt(poll: Poll, at: CellAt): { date: DateStr; start: number; end: number } {
  const start = Math.max(poll.day_from, Math.min(at.min, poll.day_to - poll.duration_min));
  return { date: at.date, start, end: start + poll.duration_min };
}

/**
 * 격자의 칸 높이(px). 폰에서는 격자가 화면을 다 덮지 않게(화면 높이의 55% 안) 줄인다 — 격자 밖을 잡고 스크롤할 자리가 남는다.
 * 너무 작아 못 누르지 않게 14px 아래로는 안 줄인다
 */
export function cellHeight(rows: number, viewportH: number, phone: boolean): number {
  if (!phone) return 22;
  return Math.max(14, Math.min(24, Math.floor((viewportH * 0.55) / Math.max(1, rows))));
}

/** 하루 범위 · 길이를 고르는 값들 (30분 단위) */
export function halfHours(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; m <= to; m += SLOT_MIN) out.push(m);
  return out;
}

/** 공개 페이지 주소. 확인 모드면 demo=1 을 붙인다 */
export function publicPath(token: string, demo: boolean): string {
  return `/m/${token}${demo ? "?demo=1" : ""}`;
}

/** 공개 페이지의 오류 문구. 핀 · 잠김 · 주최자 이름 · 없는 링크는 DB 가 준 문구 그대로 */
export function publicKorean(err: unknown): KoreanError {
  const o = typeof err === "object" && err !== null ? (err as { message?: unknown; details?: unknown; code?: unknown }) : null;
  const text = o ? `${String(o.message ?? "")} ${String(o.details ?? "")}` : String(err);
  if (text.includes("ez_meet_people_name_unique")) return { code: "NAME_TAKEN", message: "같은 이름이 방금 들어왔습니다. 다시 해 주세요" };
  const k = toKorean(err);
  if (k.code === "NETWORK") return { code: k.code, message: "연결하지 못했습니다. 잠시 뒤 다시 해 주세요" };
  return k;
}

// ------------------------------------------------------------ 오류 문구

/** 모임 쪽 DB 오류를 화면 문구로. 나머지는 일정 쪽(scheduleKorean → toKorean) */
export function meetKorean(err: unknown, authMessage?: string): KoreanError {
  const o = typeof err === "object" && err !== null ? (err as { message?: unknown; details?: unknown }) : null;
  const text = o ? `${String(o.message ?? "")} ${String(o.details ?? "")}` : String(err);
  if (text.includes("ez_circles_name_unique")) return { code: "NAME_TAKEN", message: "같은 이름의 묶음이 있습니다" };
  if (text.includes("ez_circles_name_check")) return { code: "BAD_NAME", message: `묶음 이름은 앞뒤 공백 없이 1~${CIRCLE_NAME_MAX}자입니다` };
  if (text.includes("ez_circles_members_check")) return { code: "BAD_MEMBERS", message: `묶음의 사람은 50명까지, 이름은 1~${PERSON_NAME_MAX}자이고 겹칠 수 없습니다` };
  if (text.includes("ez_meet_people_name_unique")) return { code: "NAME_TAKEN", message: "같은 이름의 사람이 이미 있습니다" };
  if (text.includes("ez_meet_people_name_check")) return { code: "BAD_NAME", message: `이름은 앞뒤 공백 없이 1~${PERSON_NAME_MAX}자입니다` };
  if (text.includes("ez_meets_title_check")) return { code: "BAD_TITLE", message: "제목은 앞뒤 공백 없이 1~60자입니다" };
  if (text.includes("ez_meets_place_text_check")) return { code: "BAD_PLACE", message: "장소는 60자까지입니다" };
  if (text.includes("ez_meets_poll_check")) return { code: "BAD_POLL", message: "후보 날짜는 1~31개, 하루 범위와 길이는 30분 단위입니다" };
  if (text.includes("ez_meet_people_cells")) return { code: "BAD_CELLS", message: "칸을 저장하지 못했습니다. 새로 불러와 다시 해 주세요" };
  if (text.includes("ez_schedule_settings_my_name_check")) return { code: "BAD_NAME", message: `내 이름은 1~${PERSON_NAME_MAX}자입니다` };
  const k = scheduleKorean(err, authMessage);
  if (k.code === "EZ_VERSION") return { code: k.code, message: "방금 다른 곳에서 이 모임을 고쳤습니다" };
  return k;
}
