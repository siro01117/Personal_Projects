// 모임 데이터 접근 (docs/모임.md 2 · 6장). 구현: meet-store-supabase(실제), meet-store-pglite(시험).
// 일정 · 플래너 ScheduleStore 와 따로 둔다. 모든 구현은 자기 owner 의 것만 보고 고친다. 묶음 · 모임은 살아 있는(deleted_at is null) 것만.
// 규칙(칸 범위 · 이름 겹침 · 50명 · 30개 · 내 줄 · 시간 ↔ 일정 · 버전)은 DB 트리거 · 함수(0011)가 막는다. 실패하면 DbError 를 던진다.
// 핀 칸(pin_*) · 남의 칸(cells) 쓰기는 여기 없다 — 에이전트가 다루는 길이 없다. 내 줄의 칸(자동 채우기)과 공개 링크 켜기 · 끄기만 있다.

import type { Attend, Cells, Circle, Meet, MeetPerson, MeetRow, Poll } from "../lib/meet";
import type { DateStr } from "../lib/schedule";

export type NewMeet = Pick<MeetRow, "title"> & Partial<Pick<MeetRow, "note" | "circle_id" | "place_id" | "place_text" | "meet_date" | "start_min" | "end_min" | "poll">>;
/** 시간(meet_date · start_min · end_min)은 여기로 안 고친다 — decide · reopen 으로 */
export type MeetPatch = Partial<Pick<MeetRow, "title" | "note" | "circle_id" | "place_id" | "place_text" | "poll">>;
export type NewCircle = Pick<Circle, "name"> & Partial<Pick<Circle, "role_id" | "members">>;
export type CirclePatch = Partial<Pick<Circle, "name" | "role_id" | "members">>;

export interface MeetStore {
  readonly owner: string;

  /** 살아 있는 묶음, 이름순 */
  circles(): Promise<Circle[]>;
  insertCircle(c: NewCircle): Promise<Circle>;
  /** version 이 같을 때만. 고친 행이 없으면 null */
  updateCircle(id: string, patch: CirclePatch, baseVersion: number): Promise<Circle | null>;
  /** soft delete. 모임은 남는다. 지웠으면 true */
  deleteCircle(id: string): Promise<boolean>;

  /** 살아 있는 모임 전부 + 사람들 (내 줄이 맨 앞) */
  meets(): Promise<Meet[]>;
  getMeet(id: string): Promise<Meet | null>;
  /** 내 줄은 DB 가 같이 만든다. 시간을 주면 일정도 같이 생긴다 */
  insertMeet(m: NewMeet): Promise<MeetRow>;
  /** version 이 같을 때만. 고친 행이 없으면 null */
  updateMeet(id: string, patch: MeetPatch, baseVersion: number): Promise<MeetRow | null>;
  /** soft delete. version 이 같을 때만. 딸린 일정 · 할 일은 남는다. 지웠으면 true */
  deleteMeet(id: string, baseVersion: number): Promise<boolean>;
  /** ez_meet_decide — 시간 정하기 + 일정 (이미 있으면 옮긴다) */
  decide(id: string, baseVersion: number, date: DateStr, start: number, end: number): Promise<MeetRow>;
  /** ez_meet_reopen — 시간을 비우고 딸린 일정을 지운다 */
  reopen(id: string, baseVersion: number): Promise<MeetRow>;

  /** 내 모임에만. 이름이 겹치면 23505, 50명을 넘으면 [EZ_LIMIT] */
  addPeople(meetId: string, names: string[]): Promise<void>;
  /** 그 모임의 사람 줄을 지운다 (내 줄은 DB 가 거절한다) */
  removePeople(meetId: string, personIds: string[]): Promise<void>;
  setAttend(meetId: string, personId: string, attend: Attend | null): Promise<void>;

  /** 내 줄의 되는 칸 (일정에서 자동으로 채운 것 — auto 는 켜진 채). 남의 줄은 못 쓴다 */
  setMyCells(meetId: string, cells: Cells): Promise<void>;
  /** 공개 링크 켜기(새 열쇠 — 이미 켜져 있으면 그대로) · 끄기. version 이 같을 때만. 고친 행이 없으면 null */
  setLink(id: string, on: boolean, baseVersion: number): Promise<MeetRow | null>;
}

export const CIRCLE_COLS = "id, name, role_id, members, version";
export const MEET_COLS =
  "id, title, note, circle_id, place_id, place_text, meet_date, start_min, end_min, event_id, poll, token, version, created_at, updated_at";
export const PERSON_COLS = "id, meet_id, name, is_owner, cells, auto, attend, has_pin, created_at";

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
/** date 열 → 'YYYY-MM-DD' (PGlite 는 ::text 로 받고, PostgREST 는 원래 문자열) */
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export function toCircle(r: Row): Circle {
  return {
    id: r.id as string,
    name: r.name as string,
    role_id: (r.role_id as string | null) ?? null,
    members: (r.members as string[] | null) ?? [],
    version: r.version as number,
  };
}

export function toMeetRow(r: Row): MeetRow {
  return {
    id: r.id as string,
    title: r.title as string,
    note: (r.note as string | null) ?? null,
    circle_id: (r.circle_id as string | null) ?? null,
    place_id: (r.place_id as string | null) ?? null,
    place_text: (r.place_text as string | null) ?? null,
    meet_date: day(r.meet_date),
    start_min: (r.start_min as number | null) ?? null,
    end_min: (r.end_min as number | null) ?? null,
    event_id: (r.event_id as string | null) ?? null,
    poll: (r.poll as Poll | null) ?? null,
    token: (r.token as string | null) ?? null,
    version: r.version as number,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export function toPerson(r: Row): MeetPerson {
  return {
    id: r.id as string,
    meet_id: r.meet_id as string,
    name: r.name as string,
    is_owner: r.is_owner === true,
    cells: (r.cells as Cells | null) ?? null,
    auto: r.auto === true,
    attend: (r.attend as Attend | null) ?? null,
    has_pin: r.has_pin === true,
    created_at: iso(r.created_at),
  };
}
