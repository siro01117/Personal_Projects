// 시험용 MeetStore: PGlite(마이그레이션 전부)에서 service_role 로 SQL 을 실행한다. schedule-store-pglite.ts 와 같은 방식.

import type { PGlite } from "@electric-sql/pglite";
import { sortPeople, type Attend, type Cells, type Circle, type Meet, type MeetRow } from "../lib/meet";
import type { DateStr } from "../lib/schedule";
import { DbError } from "./errors";
import { toCircle, toMeetRow, toPerson, type CirclePatch, type MeetPatch, type MeetStore, type NewCircle, type NewMeet } from "./meet-store";

type Row = Record<string, unknown>;

// date 열은 ::text 로 받아 시간대 영향을 없앤다
const MEET = `id, title, note, circle_id, place_id, place_text, meet_date::text as meet_date, start_min, end_min, event_id, poll, token,
  version, created_at, updated_at`;
const PERSON = "id, meet_id, name, is_owner, cells, auto, attend, has_pin, created_at";
const CIRCLE = "id, name, role_id, members, version";

export class PgliteMeetStore implements MeetStore {
  constructor(
    readonly db: PGlite,
    readonly owner: string,
  ) {}

  /** service_role 로 한 문장 */
  private async q(text: string, params: unknown[] = []): Promise<Row[]> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.exec("set local role service_role");
        return (await tx.query<Row>(text, params)).rows;
      });
    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string; constraint?: string };
      throw new DbError(`${err.message ?? String(e)}${err.constraint ? ` (constraint "${err.constraint}")` : ""}`, err.code ?? "", err.detail);
    }
  }

  /** patch → "a = $4, b = $5" (params 에 덧붙임) */
  private sets(patch: Record<string, unknown>, params: unknown[]): string {
    const out: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      // jsonb 칸은 글자로 보내 ::jsonb 로 읽는다
      const json = k === "poll";
      params.push(json && v !== null ? JSON.stringify(v) : v);
      out.push(`${k} = $${params.length}${json ? "::jsonb" : ""}`);
    }
    return out.join(", ");
  }

  async circles(): Promise<Circle[]> {
    const rows = await this.q(`select ${CIRCLE} from ez_circles where owner = $1 and deleted_at is null order by name, id`, [this.owner]);
    return rows.map(toCircle);
  }

  async insertCircle(c: NewCircle): Promise<Circle> {
    const rows = await this.q(`insert into ez_circles (owner, name, role_id, members) values ($1, $2, $3, $4::text[]) returning ${CIRCLE}`, [
      this.owner,
      c.name,
      c.role_id ?? null,
      c.members ?? [],
    ]);
    return toCircle(rows[0]!);
  }

  async updateCircle(id: string, patch: CirclePatch, baseVersion: number): Promise<Circle | null> {
    const params: unknown[] = [this.owner, id, baseVersion];
    const set = this.sets(patch, params);
    const rows = set
      ? await this.q(`update ez_circles set ${set} where owner = $1 and id = $2 and version = $3 and deleted_at is null returning ${CIRCLE}`, params)
      : await this.q(`select ${CIRCLE} from ez_circles where owner = $1 and id = $2 and version = $3 and deleted_at is null`, params);
    return rows[0] ? toCircle(rows[0]) : null;
  }

  async deleteCircle(id: string): Promise<boolean> {
    const rows = await this.q("update ez_circles set deleted_at = now() where owner = $1 and id = $2 and deleted_at is null returning id", [this.owner, id]);
    return rows.length > 0;
  }

  private async withPeople(rows: Row[]): Promise<Meet[]> {
    if (rows.length === 0) return [];
    const people = (await this.q(`select ${PERSON} from ez_meet_people where meet_id = any($1::uuid[])`, [rows.map((r) => r.id)])).map(toPerson);
    return rows.map((r) => ({ ...toMeetRow(r), people: sortPeople(people.filter((p) => p.meet_id === r.id)) }));
  }

  async meets(): Promise<Meet[]> {
    return this.withPeople(await this.q(`select ${MEET} from ez_meets where owner = $1 and deleted_at is null order by id`, [this.owner]));
  }

  async getMeet(id: string): Promise<Meet | null> {
    const rows = await this.withPeople(await this.q(`select ${MEET} from ez_meets where owner = $1 and id = $2 and deleted_at is null`, [this.owner, id]));
    return rows[0] ?? null;
  }

  async insertMeet(m: NewMeet): Promise<MeetRow> {
    const rows = await this.q(
      `insert into ez_meets (owner, title, note, circle_id, place_id, place_text, meet_date, start_min, end_min, poll)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) returning ${MEET}`,
      [
        this.owner,
        m.title,
        m.note ?? null,
        m.circle_id ?? null,
        m.place_id ?? null,
        m.place_text ?? null,
        m.meet_date ?? null,
        m.start_min ?? null,
        m.end_min ?? null,
        m.poll ? JSON.stringify(m.poll) : null,
      ],
    );
    return toMeetRow(rows[0]!);
  }

  async updateMeet(id: string, patch: MeetPatch, baseVersion: number): Promise<MeetRow | null> {
    const params: unknown[] = [this.owner, id, baseVersion];
    const set = this.sets(patch, params);
    const rows = set
      ? await this.q(`update ez_meets set ${set} where owner = $1 and id = $2 and version = $3 and deleted_at is null returning ${MEET}`, params)
      : await this.q(`select ${MEET} from ez_meets where owner = $1 and id = $2 and version = $3 and deleted_at is null`, params);
    return rows[0] ? toMeetRow(rows[0]) : null;
  }

  async deleteMeet(id: string, baseVersion: number): Promise<boolean> {
    const rows = await this.q("update ez_meets set deleted_at = now() where owner = $1 and id = $2 and version = $3 and deleted_at is null returning id", [
      this.owner,
      id,
      baseVersion,
    ]);
    return rows.length > 0;
  }

  async decide(id: string, baseVersion: number, date: DateStr, start: number, end: number): Promise<MeetRow> {
    const rows = await this.q(`select ${MEET} from ez_meet_decide($1::uuid, $2::int, $3::date, $4::int, $5::int, $6::uuid)`, [id, baseVersion, date, start, end, this.owner]);
    return toMeetRow(rows[0]!);
  }

  async reopen(id: string, baseVersion: number): Promise<MeetRow> {
    const rows = await this.q(`select ${MEET} from ez_meet_reopen($1::uuid, $2::int, $3::uuid)`, [id, baseVersion, this.owner]);
    return toMeetRow(rows[0]!);
  }

  async addPeople(meetId: string, names: string[]): Promise<void> {
    if (names.length === 0) return;
    // 주인 확인: 내 모임에만. 넣은 순서는 DB 가 지킨다 (ez_meet_people_guard)
    await this.q(
      `insert into ez_meet_people (meet_id, name)
       select m.id, n.name
         from ez_meets m, unnest($3::text[]) with ordinality as n(name, i)
        where m.id = $2 and m.owner = $1 order by n.i`,
      [this.owner, meetId, names],
    );
  }

  async removePeople(meetId: string, personIds: string[]): Promise<void> {
    if (personIds.length === 0) return;
    await this.q(
      `delete from ez_meet_people p using ez_meets m
        where m.id = p.meet_id and m.owner = $1 and p.meet_id = $2 and p.id = any($3::uuid[])`,
      [this.owner, meetId, personIds],
    );
  }

  async setAttend(meetId: string, personId: string, attend: Attend | null): Promise<void> {
    await this.q(
      `update ez_meet_people p set attend = $4 from ez_meets m
        where m.id = p.meet_id and m.owner = $1 and p.meet_id = $2 and p.id = $3`,
      [this.owner, meetId, personId, attend],
    );
  }

  async setMyCells(meetId: string, cells: Cells): Promise<void> {
    await this.q(
      `update ez_meet_people p set cells = $3::jsonb, auto = true from ez_meets m
        where m.id = p.meet_id and m.owner = $1 and p.meet_id = $2 and p.is_owner`,
      [this.owner, meetId, JSON.stringify(cells)],
    );
  }

  async setLink(id: string, on: boolean, baseVersion: number): Promise<MeetRow | null> {
    // 열쇠는 0012 ez_meet_link 와 같은 모양(22자 base64url). 이미 켜져 있으면 그대로 둔다
    const rows = await this.q(
      `update ez_meets set token = case when $4::boolean then coalesce(token, translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/=', '-_')) end
        where owner = $1 and id = $2 and version = $3 and deleted_at is null returning ${MEET}`,
      [this.owner, id, baseVersion, on],
    );
    return rows[0] ? toMeetRow(rows[0]) : null;
  }
}
