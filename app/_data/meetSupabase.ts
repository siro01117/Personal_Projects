// 모임 진짜 데이터: 브라우저 supabase-js + 로그인한 사람의 세션. RLS 가 남의 것을 막는다 (사람 줄은 부모 모임의 주인).
// 규칙(칸 검사 · 이름 겹침 · 50명 · 30개 · 내 줄 · 시간 ↔ 일정 · 버전 +1)은 DB(0011)가 지킨다. 여기서는 버전 확인만
// .eq('version', base) 로 하고, 0행이면 왜 0행인지 다시 읽어 [EZ_VERSION] / [EZ_NOT_FOUND] 로 바꾼다.
// 핀 칸(pin_*)은 읽을 권한이 없다 — 사람 줄은 늘 칸 이름을 적어 읽는다. 핀이 있는지(has_pin)만 읽는다.
// 공개 링크 열쇠 · 핀 지우기는 함수로(0012). 공개 페이지는 로그인 없이(anon) 함수 넷만 부른다 — SupabaseMeetPublic.

import { DbError } from "../../lib/errors";
import { sortPeople, type Attend, type Cells, type Circle, type Meet, type MeetPerson, type MeetRow, type PublicMeet } from "../../lib/meet";
import type { DateStr } from "../../lib/schedule";
import { anon, run, sb } from "./supabase";
import type { CircleInput, Entered, MeetData, MeetInput, MeetPublicData, PersonInput, PersonPatch } from "./types";

const PAGE = 1000;
const CIRCLE_COLS = "id, name, role_id, members, version";
const MEET_ROW_COLS =
  "id, title, note, circle_id, place_id, place_text, meet_date, start_min, end_min, event_id, poll, token, version, created_at, updated_at";
const PERSON_COLS = "id, meet_id, name, is_owner, cells, auto, attend, has_pin, created_at";
/** 사람들은 모임에 끼워 한 요청으로 읽는다. FK: ez_meet_people.meet_id → ez_meets.id */
const MEET_COLS = `${MEET_ROW_COLS}, people:ez_meet_people(${PERSON_COLS})`;

const ez = (code: string, message: string) => new DbError(`[${code}] ${message}`, "P0001");

type MeetDb = MeetRow & { people: MeetPerson[] | null };
const toMeet = ({ people, ...m }: MeetDb): Meet => ({ ...m, people: sortPeople(people ?? []) });

export class SupabaseMeet implements MeetData {
  private t(name: string) {
    return sb().from(name);
  }

  // ------------------------------------------------------------ 읽기

  async circles(): Promise<Circle[]> {
    return run<Circle[]>(this.t("ez_circles").select(CIRCLE_COLS).is("deleted_at", null).order("name").order("id"));
  }

  async meets(): Promise<Meet[]> {
    const out: Meet[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await run<MeetDb[]>(this.t("ez_meets").select(MEET_COLS).is("deleted_at", null).order("id").range(from, from + PAGE - 1));
      out.push(...rows.map(toMeet));
      if (rows.length < PAGE) return out;
    }
  }

  private async one(id: string): Promise<Meet> {
    const row = await run<MeetDb | null>(this.t("ez_meets").select(MEET_COLS).eq("id", id).is("deleted_at", null).maybeSingle());
    if (!row) throw ez("EZ_NOT_FOUND", "모임이 없습니다");
    return toMeet(row);
  }

  // ------------------------------------------------------------ 모임

  /** 버전을 걸고 고쳤는데 0행일 때: 왜 안 됐는지 */
  private async whyNot(id: string): Promise<never> {
    const r = await run<{ version: number; deleted_at: string | null } | null>(this.t("ez_meets").select("version, deleted_at").eq("id", id).maybeSingle());
    if (!r || r.deleted_at !== null) throw ez("EZ_NOT_FOUND", "모임이 없습니다");
    throw ez("EZ_VERSION", `그 사이 다른 곳에서 이 모임을 고쳤습니다. 새로 불러오세요 (지금 버전 ${r.version})`);
  }

  async createMeet(input: MeetInput, people: readonly string[] = []): Promise<Meet> {
    const row = await run<{ id: string; version: number }>(this.t("ez_meets").insert(input).select("id, version").single());
    if (people.length > 0) {
      try {
        await run(this.t("ez_meet_people").insert(people.map((name) => ({ meet_id: row.id, name }))));
      } catch (e) {
        // 사람을 못 넣었으면 방금 만든 모임을 남기지 않는다
        await run(this.t("ez_meets").update({ deleted_at: new Date().toISOString() }).eq("id", row.id)).catch(() => {});
        throw e;
      }
    }
    return this.one(row.id);
  }

  async updateMeet(id: string, baseVersion: number, patch: Partial<MeetInput>): Promise<Meet> {
    const rows = await run<MeetDb[]>(
      this.t("ez_meets").update(patch).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select(MEET_COLS),
    );
    return rows[0] ? toMeet(rows[0]) : this.whyNot(id);
  }

  async deleteMeet(id: string, baseVersion: number): Promise<void> {
    const rows = await run<{ id: string }[]>(
      this.t("ez_meets").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select("id"),
    );
    if (rows.length === 0) await this.whyNot(id);
  }

  async restoreMeet(id: string): Promise<Meet> {
    const rows = await run<MeetDb[]>(this.t("ez_meets").update({ deleted_at: null }).eq("id", id).select(MEET_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "되돌릴 모임이 없습니다");
    return toMeet(rows[0]);
  }

  async decide(id: string, baseVersion: number, date: DateStr, start: number, end: number): Promise<Meet> {
    // 함수는 모임 줄만 돌려준다 — 사람들까지 다시 읽는다
    const row = await run<{ id: string }>(sb().rpc("ez_meet_decide", { id, base_version: baseVersion, date, start_min: start, end_min: end }));
    return this.one(row.id);
  }

  async reopen(id: string, baseVersion: number): Promise<Meet> {
    const row = await run<{ id: string }>(sb().rpc("ez_meet_reopen", { id, base_version: baseVersion }));
    return this.one(row.id);
  }

  // ------------------------------------------------------------ 사람

  async addPerson(meetId: string, input: PersonInput): Promise<MeetPerson> {
    return run<MeetPerson>(this.t("ez_meet_people").insert({ ...input, meet_id: meetId }).select(PERSON_COLS).single());
  }

  async updatePerson(id: string, patch: PersonPatch): Promise<MeetPerson> {
    const rows = await run<MeetPerson[]>(this.t("ez_meet_people").update(patch).eq("id", id).select(PERSON_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "그 사람이 없습니다");
    return rows[0];
  }

  async removePerson(id: string): Promise<void> {
    await run(this.t("ez_meet_people").delete().eq("id", id));
  }

  async clearPin(personId: string): Promise<void> {
    await run(sb().rpc("ez_meet_pin_clear", { p_person: personId }));
  }

  async link(id: string, on: boolean): Promise<string | null> {
    return run<string | null>(sb().rpc("ez_meet_link", { p_id: id, p_on: on }));
  }

  // ------------------------------------------------------------ 묶음

  async createCircle(input: CircleInput): Promise<Circle> {
    return run<Circle>(this.t("ez_circles").insert(input).select(CIRCLE_COLS).single());
  }

  async updateCircle(id: string, patch: Partial<CircleInput>): Promise<Circle> {
    const rows = await run<Circle[]>(this.t("ez_circles").update(patch).eq("id", id).is("deleted_at", null).select(CIRCLE_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "묶음이 없습니다");
    return rows[0];
  }

  async deleteCircle(id: string): Promise<void> {
    await run(this.t("ez_circles").update({ deleted_at: new Date().toISOString() }).eq("id", id).is("deleted_at", null));
  }

  async restoreCircle(id: string): Promise<Circle> {
    const rows = await run<Circle[]>(this.t("ez_circles").update({ deleted_at: null }).eq("id", id).select(CIRCLE_COLS));
    if (!rows[0]) throw ez("EZ_NOT_FOUND", "되돌릴 묶음이 없습니다");
    return rows[0];
  }
}

// ------------------------------------------------------------ 공개 페이지 (로그인 없이)

type Answer = Entered | { error: { code: string; message: string } };

/** 틀린 핀 · 잠김은 함수가 예외 대신 {error} 로 준다(틀린 횟수가 남게) — 여기서 같은 모양의 오류로 던진다 */
function entered(r: Answer | null): Entered {
  if (!r) throw ez("EZ_NOT_FOUND", "없는 링크입니다");
  if ("error" in r) throw ez(r.error.code, r.error.message);
  return r;
}

export class SupabaseMeetPublic implements MeetPublicData {
  async open(token: string): Promise<PublicMeet | null> {
    return run<PublicMeet | null>(anon().rpc("ez_meet_public", { p_token: token }));
  }

  async enter(token: string, name: string, pin: string): Promise<Entered> {
    return entered(await run<Answer | null>(anon().rpc("ez_meet_enter", { p_token: token, p_name: name, p_pin: pin })));
  }

  async answer(token: string, name: string, pin: string, cells: Cells): Promise<Entered> {
    return entered(await run<Answer | null>(anon().rpc("ez_meet_answer", { p_token: token, p_name: name, p_pin: pin, p_cells: cells })));
  }

  async rsvp(token: string, name: string, pin: string, attend: Attend | null): Promise<Entered> {
    return entered(await run<Answer | null>(anon().rpc("ez_meet_rsvp", { p_token: token, p_name: name, p_pin: pin, p_attend: attend })));
  }
}
