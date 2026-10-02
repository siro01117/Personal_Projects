// 모임이 쓰는 모양 (docs/모임.md 2장). lib/meet 의 계산, DB 행(0011), MCP, 웹이 모두 이 타입을 쓴다.
// 날짜 · 시각 표기는 lib/schedule 과 같다: 'YYYY-MM-DD'(Asia/Seoul), 시각은 그 날짜 0시부터 센 분. 모임은 자정을 넘기지 않는다.

import type { DateStr } from "../schedule";

/** ez_circles 한 줄 — 묶음 (같은 사람들과 또 만날 때) */
export type Circle = {
  id: string;
  name: string;
  /** 플래너의 역할. 묶음의 모임 · 거기서 나온 할 일이 물려받는다. 지운 역할을 가리킬 수 있다(없는 것으로 읽는다) */
  role_id: string | null;
  /** 늘 오는 사람 이름들. 나는 안 적는다 */
  members: string[];
  version: number;
};

/** 시간 맞추기 설정. 후보 날짜는 오름차순, 하루 범위와 길이는 30분 단위 */
export type Poll = { dates: DateStr[]; day_from: number; day_to: number; duration_min: number };

/** ez_meets 한 줄 — 만남 한 번 */
export type MeetRow = {
  id: string;
  title: string;
  note: string | null;
  /** 지운 묶음을 가리킬 수 있다(없는 것으로 읽는다) */
  circle_id: string | null;
  place_id: string | null;
  place_text: string | null;
  /** 정해진 시간. 셋 다 있거나 셋 다 없다(= 아직 안 정함) */
  meet_date: DateStr | null;
  start_min: number | null;
  end_min: number | null;
  /** 정하면서 만든 일정. 일정 화면에서 지우면 이것만 빈다 */
  event_id: string | null;
  /** 있으면 시간 맞추기를 쓰는 모임 */
  poll: Poll | null;
  /** 공개 링크 열쇠 (켰을 때만) */
  token: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export const ATTENDS = ["yes", "no"] as const;
export type Attend = (typeof ATTENDS)[number];

/** 날짜별 되는 칸의 시작 분 */
export type Cells = Record<DateStr, number[]>;

/** ez_meet_people 한 줄. 핀 칸은 어디로도 안 나온다 */
export type MeetPerson = {
  id: string;
  meet_id: string;
  name: string;
  /** 내 줄 (모임당 하나) */
  is_owner: boolean;
  /** 없으면 아직 안 칠함 */
  cells: Cells | null;
  /** 내 줄만: 일정에서 자동으로 채운 상태 */
  auto: boolean;
  /** 정해진 뒤 온다 / 못 온다, 지난 뒤 왔다 / 안 왔다 — 같은 칸 */
  attend: Attend | null;
  /** 핀번호를 정했는가 (= 링크로 들어온 적이 있는가). 핀 값은 어디로도 안 나온다 */
  has_pin: boolean;
  created_at: string;
};

/** 모임 + 사람들 (화면 · MCP 가 한 번에 읽는 모양). 내 줄이 맨 앞, 나머지는 넣은 순서 */
export type Meet = MeetRow & { people: MeetPerson[] };

/** 공개 페이지(/m/열쇠)가 읽는 사람 한 줄 — id 는 안 나간다 (0012 ez_meet_public) */
export type PublicPerson = Pick<MeetPerson, "name" | "is_owner" | "cells" | "attend" | "has_pin">;

/** 공개 페이지가 읽는 모임. 메모 · 주인 · id · 일정 내용 · 핀 값은 없다. place 는 지점 이름, where 는 장소 글 */
export type PublicMeet = {
  title: string;
  place: string | null;
  where: string | null;
  meet_date: DateStr | null;
  start_min: number | null;
  end_min: number | null;
  poll: Poll | null;
  people: PublicPerson[];
};

/** 핀번호: 숫자 4~6자리 */
export const PIN_RE = /^[0-9]{4,6}$/;
/** 5번 틀리면 10분 잠긴다 (0012 와 같아야 한다) */
export const PIN_TRIES = 5;
export const PIN_LOCK_MIN = 10;
/** 공개 링크 열쇠: 22자 */
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export const MEET_TITLE_MAX = 60;
export const MEET_NOTE_MAX = 2000;
export const PLACE_TEXT_MAX = 60;
export const PERSON_NAME_MAX = 20;
export const PEOPLE_MAX = 50;
export const CIRCLE_NAME_MAX = 30;
export const CIRCLES_MAX = 30;
export const MEMBERS_MAX = 50;
/** 설정에 내 이름이 없을 때 내 줄에 적히는 이름 (0011 ez_meets_after 와 같아야 한다) */
export const DEFAULT_MY_NAME = "나";

/** 사람 줄 순서: 내 줄이 맨 앞, 나머지는 넣은 순서 */
export function sortPeople<T extends Pick<MeetPerson, "is_owner" | "created_at" | "id">>(people: readonly T[]): T[] {
  return [...people].sort((a, b) => Number(b.is_owner) - Number(a.is_owner) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
