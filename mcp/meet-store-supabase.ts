// 실제 MeetStore: supabase-js + service_role 키. RLS 를 우회하므로 모든 쿼리에 owner = EZ_OWNER_ID 를 직접 걸고,
// 넣을 때 owner 를 명시하고, DB 함수에는 p_as 를 준다. 사람 줄은 부모 모임이 내 것인지 먼저 확인한다. ez_ 모임 표 밖은 건드리지 않는다.

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { sortPeople, type Attend, type Cells, type Circle, type Meet, type MeetRow } from "../lib/meet";
import type { DateStr } from "../lib/schedule";
import { DbError } from "./errors";
import { serviceClient, type StoreClient } from "./supabase-client";
import { CIRCLE_COLS, MEET_COLS, PERSON_COLS, toCircle, toMeetRow, toPerson, type CirclePatch, type MeetPatch, type MeetStore, type NewCircle, type NewMeet } from "./meet-store";

const PAGE = 1000; // PostgREST 기본 최대 행 수

type Row = Record<string, unknown>;
type Res<T> = { data: T | null; error: { message: string; code?: string; details?: string | null } | null };

async function run<T>(p: PromiseLike<Res<T>>): Promise<T> {
  const res = await p;
  if (res.error) throw new DbError(res.error.message, res.error.code ?? "", res.error.details ?? undefined);
  return res.data as T;
}

/** 사람들은 모임에 끼워 한 요청으로 읽는다 */
const WITH_PEOPLE = `${MEET_COLS}, people:ez_meet_people(${PERSON_COLS})`;
const toMeet = (r: Row): Meet => ({ ...toMeetRow(r), people: sortPeople(((r.people as Row[] | null) ?? []).map(toPerson)) });
const defined = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

export class SupabaseMeetStore implements MeetStore {
  private readonly sb: SupabaseClient;
  private readonly asUser: boolean;

  constructor(
    url: string,
    serviceRoleKey: string,
    readonly owner: string,
    opts: StoreClient = {},
  ) {
    this.sb = opts.client ?? serviceClient(url, serviceRoleKey);
    this.asUser = opts.asUser === true;
  }

  private meetTable() {
    return this.sb.from("ez_meets");
  }

  private circleTable() {
    return this.sb.from("ez_circles");
  }

  async circles(): Promise<Circle[]> {
    const rows = await run<Row[]>(this.circleTable().select(CIRCLE_COLS).eq("owner", this.owner).is("deleted_at", null).order("name").order("id"));
    return rows.map(toCircle);
  }

  async insertCircle(c: NewCircle): Promise<Circle> {
    return toCircle(await run<Row>(this.circleTable().insert({ ...c, owner: this.owner }).select(CIRCLE_COLS).single()));
  }

  async updateCircle(id: string, patch: CirclePatch, baseVersion: number): Promise<Circle | null> {
    const body = defined(patch);
    const base = () => this.circleTable();
    const rows =
      Object.keys(body).length === 0
        ? await run<Row[]>(base().select(CIRCLE_COLS).eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null))
        : await run<Row[]>(base().update(body).eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select(CIRCLE_COLS));
    return rows[0] ? toCircle(rows[0]) : null;
  }

  async deleteCircle(id: string): Promise<boolean> {
    const rows = await run<Row[]>(
      this.circleTable().update({ deleted_at: new Date().toISOString() }).eq("owner", this.owner).eq("id", id).is("deleted_at", null).select("id"),
    );
    return rows.length > 0;
  }

  async meets(): Promise<Meet[]> {
    const out: Meet[] = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await run<Row[]>(
        this.meetTable().select(WITH_PEOPLE).eq("owner", this.owner).is("deleted_at", null).order("id").range(from, from + PAGE - 1),
      );
      out.push(...rows.map(toMeet));
      if (rows.length < PAGE) return out;
    }
  }

  async getMeet(id: string): Promise<Meet | null> {
    const row = await run<Row | null>(this.meetTable().select(WITH_PEOPLE).eq("owner", this.owner).eq("id", id).is("deleted_at", null).maybeSingle());
    return row ? toMeet(row) : null;
  }

  async insertMeet(m: NewMeet): Promise<MeetRow> {
    return toMeetRow(await run<Row>(this.meetTable().insert({ ...m, owner: this.owner }).select(MEET_COLS).single()));
  }

  async updateMeet(id: string, patch: MeetPatch, baseVersion: number): Promise<MeetRow | null> {
    const body = defined(patch);
    const rows =
      Object.keys(body).length === 0
        ? await run<Row[]>(this.meetTable().select(MEET_COLS).eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null))
        : await run<Row[]>(
            this.meetTable().update(body).eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select(MEET_COLS),
          );
    return rows[0] ? toMeetRow(rows[0]) : null;
  }

  async deleteMeet(id: string, baseVersion: number): Promise<boolean> {
    const rows = await run<Row[]>(
      this.meetTable()
        .update({ deleted_at: new Date().toISOString() })
        .eq("owner", this.owner)
        .eq("id", id)
        .eq("version", baseVersion)
        .is("deleted_at", null)
        .select("id"),
    );
    return rows.length > 0;
  }

  async decide(id: string, baseVersion: number, date: DateStr, start: number, end: number): Promise<MeetRow> {
    return toMeetRow(
      await run<Row>(this.sb.rpc("ez_meet_decide", { id, base_version: baseVersion, date, start_min: start, end_min: end, p_as: this.owner }).single()),
    );
  }

  async reopen(id: string, baseVersion: number): Promise<MeetRow> {
    return toMeetRow(await run<Row>(this.sb.rpc("ez_meet_reopen", { id, base_version: baseVersion, p_as: this.owner }).single()));
  }

  /** 사람 줄에는 owner 칸이 없다 — 부모 모임이 내 것인지 본다 */
  private async mine(meetId: string): Promise<void> {
    const row = await run<Row | null>(this.meetTable().select("id").eq("owner", this.owner).eq("id", meetId).maybeSingle());
    if (!row) throw new DbError("[EZ_NOT_FOUND] 모임이 없습니다", "P0001");
  }

  async addPeople(meetId: string, names: string[]): Promise<void> {
    if (names.length === 0) return;
    await this.mine(meetId);
    // 넣은 순서는 DB 가 지킨다 (ez_meet_people_guard)
    await run(this.sb.from("ez_meet_people").insert(names.map((name) => ({ meet_id: meetId, name }))));
  }

  async removePeople(meetId: string, personIds: string[]): Promise<void> {
    if (personIds.length === 0) return;
    await this.mine(meetId);
    await run(this.sb.from("ez_meet_people").delete().eq("meet_id", meetId).in("id", personIds));
  }

  async setAttend(meetId: string, personId: string, attend: Attend | null): Promise<void> {
    await this.mine(meetId);
    await run(this.sb.from("ez_meet_people").update({ attend }).eq("meet_id", meetId).eq("id", personId));
  }

  async setMyCells(meetId: string, cells: Cells): Promise<void> {
    await this.mine(meetId);
    await run(this.sb.from("ez_meet_people").update({ cells, auto: true }).eq("meet_id", meetId).eq("is_owner", true));
  }

  async setLink(id: string, on: boolean, baseVersion: number): Promise<MeetRow | null> {
    const base = () => this.meetTable();
    if (this.asUser) {
      // 주인의 권한으로는 열쇠 칸을 직접 못 쓴다 (0011 권한) — 화면과 같은 함수(0012 ez_meet_link)로. version 은 먼저 맞춰 본다
      const cur = await run<Row[]>(base().select("id").eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null));
      if (!cur[0]) return null;
      await run(this.sb.rpc("ez_meet_link", { p_id: id, p_on: on }));
      const rows = await run<Row[]>(base().select(MEET_COLS).eq("owner", this.owner).eq("id", id).is("deleted_at", null));
      return rows[0] ? toMeetRow(rows[0]) : null;
    }
    if (on) {
      // 이미 켜져 있으면 그 열쇠를 그대로 둔다
      const cur = await run<Row[]>(base().select(MEET_COLS).eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null));
      if (!cur[0]) return null;
      if (cur[0].token) return toMeetRow(cur[0]);
    }
    // 열쇠: 16바이트 → base64url 22자 (0012 ez_meet_link 와 같은 모양)
    const token = on ? randomBytes(16).toString("base64url") : null;
    const rows = await run<Row[]>(base().update({ token }).eq("owner", this.owner).eq("id", id).eq("version", baseVersion).is("deleted_at", null).select(MEET_COLS));
    return rows[0] ? toMeetRow(rows[0]) : null;
  }
}
