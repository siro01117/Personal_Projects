
import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";
import { PATROL_BY_KEY } from "@/lib/patrol";
import { todayKey as todayStr } from "@/lib/date"; // KST 기준(서버 UTC 어긋남 방지)

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

// 순찰에서 '입석(seated)'으로 찍힌 학생 → 출결 입실 연동.
// 그날 마지막 출결 이벤트가 이미 in 이면 no-op(중복 방지). out 이거나 기록이 없을 때만 in 추가.
// attendance_event 에는 source/note 컬럼이 없어(스키마 변경 금지) auto=true 로 "순찰발 자동 입실"임을 남긴다
// (수동 checkIn 은 auto=false로 기록되므로 구분 가능).
async function ensureCheckedInFromPatrol(branchId: string | null, studentId: string, date: string, by: string) {
  const last = await db.query<{ kind: string }>(
    `select kind from attendance_event where student_id=$1 and branch_id=$2 and date=$3 order by at desc limit 1`,
    [studentId, branchId, date],
  );
  if (last.rows[0]?.kind === "in") return;
  await db.query(
    `insert into attendance_event(branch_id, student_id, kind, auto, date, created_by)
     values ($1,$2,'in',true,$3,$4)`,
    [branchId, studentId, date, by],
  );
}

// 순찰 상태 원탭 기록. points 는 프리셋에서 스냅샷 → 나중에 프리셋 바꿔도 과거 기록 불변.
// 한 순찰 세션(sessionId) 안에서는 학생당 상태 1개 → 재탭하면 기존 걸 지우고 교체.
export async function recordPatrol(formData: FormData) {
  const me = await guard("patrol.manage");
  const id = s(formData.get("studentId"));
  const state = s(formData.get("state"));
  const sessionId = s(formData.get("sessionId"));
  if (!id || !state) return;
  const preset = PATROL_BY_KEY[state];
  if (!preset) return;
  // 기록 당시 앉아있던 좌석 스냅샷
  const seatRow = await db.query<{ id: string }>(
    `select id from seat where current_student_id=$1 and branch_id=$2 limit 1`,
    [id, me.activeBranchId],
  );
  const seatId = seatRow.rows[0]?.id ?? null;
  const date = todayStr();
  if (sessionId) {
    // 같은 세션 내 이 학생 기존 기록 제거(교체)
    await db.query(
      `delete from patrol_event where student_id=$1 and branch_id=$2 and session_id=$3`,
      [id, me.activeBranchId, sessionId],
    );
  }
  await db.query(
    `insert into patrol_event(branch_id, student_id, state, points, session_id, seat_id, date, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [me.activeBranchId, id, state, preset.points, sessionId, seatId, date, me.id],
  );
  if (state === "seated") {
    await ensureCheckedInFromPatrol(me.activeBranchId, id, date, me.id);
  }
  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 여러 학생 상태를 한 번에 기록 (모바일 순찰의 '이 방 완료' — 미점검 좌석을 일괄 입석 처리).
// 학생 27명이면 개별 호출 시 왕복 100회 이상 → 단일 왕복으로 줄인다. 세션당 학생 1상태(교체) 규칙은 동일.
export async function recordPatrolBulk(formData: FormData) {
  const me = await guard("patrol.manage");
  const sessionId = s(formData.get("sessionId"));
  let items: { studentId: string; state: string }[];
  try {
    items = JSON.parse(s(formData.get("items")) ?? "[]");
  } catch { return; }
  if (!Array.isArray(items) || items.length === 0) return;

  // 유효 상태만 통과 + 학생 중복 제거(뒤엣것 우선)
  const byStudent = new Map<string, string>();
  for (const it of items) {
    if (!it?.studentId || !PATROL_BY_KEY[it?.state]) continue;
    byStudent.set(it.studentId, it.state);
  }
  if (byStudent.size === 0) return;

  // 좌석 스냅샷 — 지점 좌석은 100석 내외라 통째로 읽고 메모리에서 매칭(배열 파라미터 회피)
  const seatRows = await db.query<{ id: string; current_student_id: string }>(
    `select id, current_student_id from seat where branch_id=$1 and current_student_id is not null`,
    [me.activeBranchId],
  );
  const seatOf = new Map(seatRows.rows.map((r) => [r.current_student_id, r.id]));
  const ids = [...byStudent.keys()];
  const date = todayStr();

  // 같은 세션의 기존 기록 제거(교체)
  if (sessionId) {
    const ph = ids.map((_, i) => `$${i + 3}`).join(",");
    await db.query(
      `delete from patrol_event where branch_id=$1 and session_id=$2 and student_id in (${ph})`,
      [me.activeBranchId, sessionId, ...ids],
    );
  }

  const params: (string | number | null)[] = [me.activeBranchId, sessionId, date, me.id];
  const values = ids.map((id) => {
    const state = byStudent.get(id)!;
    const i = params.length;
    params.push(id, state, PATROL_BY_KEY[state].points, seatOf.get(id) ?? null);
    return `($1,$${i + 1},$${i + 2},$${i + 3},$2,$${i + 4},$3,$4)`;
  });
  await db.query(
    `insert into patrol_event(branch_id, student_id, state, points, session_id, seat_id, date, created_by)
     values ${values.join(",")}`,
    params,
  );

  // 입석으로 찍힌 학생만 출결 입실 연동 — 학생별 루프 쿼리 없이 조회 1회 + insert 1회로 처리.
  const seatedIds = ids.filter((id) => byStudent.get(id) === "seated");
  if (seatedIds.length > 0) {
    const seatedArr = "{" + seatedIds.join(",") + "}"; // fetch_types:false → 배열은 리터럴 문자열로 전달
    const lastAtt = await db.query<{ student_id: string; kind: string }>(
      `select distinct on (student_id) student_id, kind
         from attendance_event
        where branch_id=$1 and date=$2 and student_id = any($3::uuid[])
        order by student_id, at desc`,
      [me.activeBranchId, date, seatedArr],
    );
    const lastKind = new Map(lastAtt.rows.map((r) => [r.student_id, r.kind]));
    const needCheckIn = seatedIds.filter((id) => lastKind.get(id) !== "in");
    if (needCheckIn.length > 0) {
      const attParams: (string | boolean | null)[] = [me.activeBranchId, date, me.id];
      const attValues = needCheckIn.map((id) => {
        attParams.push(id);
        return `($1,$${attParams.length},'in',true,$2,$3)`;
      });
      await db.query(
        `insert into attendance_event(branch_id, student_id, kind, auto, date, created_by)
         values ${attValues.join(",")}`,
        attParams,
      );
    }
  }

  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 순찰 이벤트 1건 삭제 (벌점 내역에서 정정 — id로)
export async function removePatrolEvent(formData: FormData) {
  const me = await guard("patrol.manage");
  const id = s(formData.get("id"));
  if (!id) return;
  await db.query(`delete from patrol_event where id=$1 and branch_id=$2`, [id, me.activeBranchId]);
  revalidatePath("/m/penalty");
  revalidatePath("/m/patrol");
  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 마지막 순찰 기록 취소 (오탭 정정)
export async function undoLastPatrol(formData: FormData) {
  const me = await guard("patrol.manage");
  const id = s(formData.get("studentId"));
  if (!id) return;
  await db.query(
    `delete from patrol_event
      where id = (select id from patrol_event
                   where student_id=$1 and branch_id=$2 and date=$3
                   order by at desc limit 1)`,
    [id, me.activeBranchId, todayStr()],
  );
  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 순찰 시작 — 세션 행 생성(시작 시각 기록). id 는 클라가 생성해 patrol_event 와 매칭.
export async function startPatrol(formData: FormData) {
  const me = await guard("patrol.manage");
  const id = s(formData.get("sessionId"));
  if (!id) return;
  await db.query(
    `insert into patrol_session(id, branch_id, date, created_by) values ($1,$2,$3,$4)
     on conflict (id) do nothing`,
    [id, me.activeBranchId, todayStr(), me.id],
  );
  revalidatePath("/m/seat");
}

// 순찰 종료 — 종료 시각 기록 + 이 세션에서 찍은 학생별 마지막 마크를 출결로 확정한다.
// recordPatrol/recordPatrolBulk 의 즉시 입실 연동(입석 → in)은 순찰 도중의 잠정 처리이고, 종료 시
// 여기서 그 세션의 모든 마크(asIn true/false)를 최종적으로 출결에 반영해 정리한다.
//
// 쿼리 3개로 고정(학생별 루프 없음):
//  1) 세션의 학생별 마지막 마크 — recordPatrol/recordPatrolBulk 가 세션당 학생 1행으로
//     delete-then-insert 하므로 (student_id, session_id) 는 이미 유일 → distinct 불필요.
//  2) 그 학생들의 오늘 마지막 출결 상태(이미 같은 kind 면 중복 삽입 방지) — 배열 파라미터로 세션
//     학생만 필터(지점 전체가 아니라 이 세션 인원으로 한정되므로 학생별 루프보다 훨씬 적은 비용).
//  3) 필요한 행만 모아 단일 multi-row insert.
export async function endPatrol(formData: FormData) {
  const me = await guard("patrol.manage");
  const id = s(formData.get("sessionId"));
  if (!id) return;
  await db.query(
    `update patrol_session set ended_at=now() where id=$1 and branch_id=$2 and ended_at is null`,
    [id, me.activeBranchId],
  );

  const marks = await db.query<{ student_id: string; state: string; at: string }>(
    `select student_id, state, at::text as at from patrol_event where session_id=$1 and branch_id=$2`,
    [id, me.activeBranchId],
  );
  if (marks.rows.length > 0) {
    const date = todayStr();
    const ids = marks.rows.map((r) => r.student_id);
    const idArr = "{" + ids.join(",") + "}"; // fetch_types:false → 배열은 리터럴 문자열로 전달
    const lastAtt = await db.query<{ student_id: string; kind: string }>(
      `select distinct on (student_id) student_id, kind
         from attendance_event
        where branch_id=$1 and date=$2 and student_id = any($3::uuid[])
        order by student_id, at desc`,
      [me.activeBranchId, date, idArr],
    );
    const lastKind = new Map(lastAtt.rows.map((r) => [r.student_id, r.kind]));

    // params 앞 3개(branch_id/date/created_by)는 모든 행이 공유 — 학생별로는 student_id/kind/at 만 붙인다.
    const params: (string | null)[] = [me.activeBranchId, date, me.id];
    const values: string[] = [];
    for (const r of marks.rows) {
      const asIn = PATROL_BY_KEY[r.state]?.asIn ?? true;
      const kind = asIn ? "in" : "out";
      if (lastKind.get(r.student_id) === kind) continue; // 이미 같은 상태 — 중복 방지
      const i = params.length;
      params.push(r.student_id, kind, r.at);
      values.push(`($1,$${i + 1},$${i + 2},true,$2,$3,$${i + 3},'순찰 자동 처리')`);
    }
    if (values.length > 0) {
      // at 은 그 학생의 마지막 마크 시각을 그대로 쓴다(종료 시각 대신 — 실제 상태가 확정된 시점).
      // note = '순찰 자동 처리' — 순찰이 자동으로 확정한 퇴실을 수동 퇴실과 구분해 좌석 tooltip 에 남긴다.
      await db.query(
        `insert into attendance_event(branch_id, student_id, kind, auto, date, created_by, at, note)
         values ${values.join(",")}`,
        params,
      );
    }
  }

  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 순찰 세션 삭제 (오시작·테스트 정정) — 세션 행 + 그 세션의 순찰 기록 함께 삭제
export async function deletePatrolSession(formData: FormData) {
  const me = await guard("patrol.manage");
  const id = s(formData.get("sessionId"));
  if (!id) return;
  await db.query(`delete from patrol_event where session_id=$1 and branch_id=$2`, [id, me.activeBranchId]);
  await db.query(`delete from patrol_session where id=$1 and branch_id=$2`, [id, me.activeBranchId]);
  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 순찰 이력 — 세션별 시각 + 점검 인원 + 벌점 합계. date(KST, "YYYY-MM-DD") 미지정이면 오늘.
// started_at 은 timestamptz(서버는 UTC로 돎) → ::text 슬라이싱이 아니라
// at time zone 'Asia/Seoul' 로 변환한 날짜로 비교해야 자정 근처 세션이 올바른 날짜로 묶인다.
// limit 은 하루 안에서만 걸리므로 넉넉히 200(순찰 20회/일 기준으로도 충분한 여유).
export async function getPatrolSessions(date?: string) {
  const me = await guard("patrol.view");
  const d = date ?? todayStr();
  // started_at/ended_at(::text)은 DB 세션 타임존을 따른다 — 로컬 PGlite 는 KST 라 '+09' 가 붙지만
  // 운영(Supabase)은 UTC 라 '+00' 이 붙는다. 오프셋이 있으니 Date.parse 로 하는 소요시간 계산과
  // 브라우저 toLocale* 표시는 어느 쪽이든 맞다. 다만 문자열을 그대로 잘라 쓰는 화면(/records)이
  // 있어서, 표시용 KST 문자열을 서버에서 따로 만들어 함께 내려준다.
  const r = await db.query<{
    id: string; started_at: string; ended_at: string | null;
    started_kst: string; ended_kst: string | null; marked: number; penalty: number;
  }>(
    `select ps.id, ps.started_at::text as started_at, ps.ended_at::text as ended_at,
            to_char(ps.started_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') as started_kst,
            to_char(ps.ended_at   at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') as ended_kst,
            count(pe.id)::int as marked, coalesce(sum(pe.points),0)::int as penalty
       from patrol_session ps
       left join patrol_event pe on pe.session_id = ps.id
      where ps.branch_id=$1
        and (ps.started_at at time zone 'Asia/Seoul')::date = $2::date
      group by ps.id
      order by ps.started_at desc
      limit 200`,
    [me.activeBranchId, d],
  );
  return r.rows;
}

// 순찰 기록이 있는 날짜 목록(최근 180일, KST 기준) — 날짜 선택기에서 빈 날을 표시해 헛클릭을 줄이는 용도.
// started_at >= now() - 180일 은 대략적인 사전 필터일 뿐(경계값이 하루 어긋나도 무해) — 정확한 날짜
// 판정은 항상 at time zone 'Asia/Seoul' 쪽에서 이뤄진다.
export async function getPatrolDates(): Promise<string[]> {
  const me = await guard("patrol.view");
  const r = await db.query<{ d: string }>(
    `select distinct (started_at at time zone 'Asia/Seoul')::date::text as d
       from patrol_session
      where branch_id=$1 and started_at >= now() - interval '180 days'
      order by d desc`,
    [me.activeBranchId],
  );
  return r.rows.map((row) => row.d);
}

// 한 순찰 세션의 학생별 기록 (student_id 포함 → 좌석 매핑·수정용)
export async function getPatrolSessionDetail(sessionId: string) {
  const me = await guard("patrol.view");
  const r = await db.query<{ student_id: string; seat_id: string | null; name: string; state: string; points: number; at: string }>(
    `select pe.student_id, pe.seat_id, st.name, pe.state, pe.points, pe.at::text as at
       from patrol_event pe join student st on st.id = pe.student_id
      where pe.session_id=$1 and pe.branch_id=$2
      order by pe.at`,
    [sessionId, me.activeBranchId],
  );
  return r.rows;
}

// 지난 순찰 기록 수정 — 특정 세션에서 학생 상태를 바꾸거나 새로 찍음(세션당 1상태, 교체).
// date 는 그 세션의 날짜로 맞춤(오늘이 아닐 수 있음).
export async function setPatrolMark(formData: FormData) {
  const me = await guard("patrol.manage");
  const sessionId = s(formData.get("sessionId"));
  const id = s(formData.get("studentId"));
  const state = s(formData.get("state"));
  const seatId = s(formData.get("seatId")); // 수정 대상 좌석(클릭한 자리) — 스냅샷 유지
  if (!sessionId || !id || !state) return;
  const preset = PATROL_BY_KEY[state];
  if (!preset) return;
  const sess = await db.query<{ date: string }>(
    `select date::text as date from patrol_session where id=$1 and branch_id=$2`,
    [sessionId, me.activeBranchId],
  );
  const date = sess.rows[0]?.date ?? todayStr();
  await db.query(
    `delete from patrol_event where student_id=$1 and branch_id=$2 and session_id=$3`,
    [id, me.activeBranchId, sessionId],
  );
  await db.query(
    `insert into patrol_event(branch_id, student_id, state, points, session_id, seat_id, date, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [me.activeBranchId, id, state, preset.points, sessionId, seatId, date, me.id],
  );
  if (state === "seated") {
    await ensureCheckedInFromPatrol(me.activeBranchId, id, date, me.id);
  }
  revalidatePath("/m/patrol");
  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 지난 순찰 기록에서 학생 상태 지우기(오탭 삭제)
export async function clearPatrolMark(formData: FormData) {
  const me = await guard("patrol.manage");
  const sessionId = s(formData.get("sessionId"));
  const id = s(formData.get("studentId"));
  if (!sessionId || !id) return;
  await db.query(
    `delete from patrol_event where student_id=$1 and branch_id=$2 and session_id=$3`,
    [id, me.activeBranchId, sessionId],
  );
  revalidatePath("/m/patrol");
  revalidatePath("/m/seat");
  revalidatePath("/seat");
}

// 미종료 순찰 세션 조회 (모바일 "이어하기") — 지점당 최신 1건.
// 12시간 넘게 방치된 세션은 이어하기 대상에서 제외하고 조용히 종료 처리한다
// (ended_at = 마지막 patrol_event 시각, 없으면 started_at). 자동 종료는 여기서만 일어난다.
//
// 미종료 세션이 최신 1건보다 더 있으면(중복 시작 레이스·과거 예외 등으로 발생 가능) 그 낡은 것들은
// 나이와 무관하게 여기서 함께 정리한다 — 그러지 않으면 최신 세션 뒤에 가려져 영영 "진행중"으로
// 순찰 기록에 남는다(이어하기는 항상 최신 1건만 대상으로 하므로 그 뒤의 것들은 다시는 조회되지 않음).
export type OpenPatrolSession = {
  sessionId: string;
  startedByName: string;
  markedCount: number;
  dayLabel: string;   // "오늘" | "8월 10일" — 서버에서 포맷(하이드레이션 불일치 방지)
  timeLabel: string;  // "19:40"
  lastLabel: string | null; // "20:12" | 기록 없으면 null
};
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export async function getOpenPatrolSession(): Promise<OpenPatrolSession | null> {
  const me = await guard("patrol.view");
  // raw = 오프셋 포함 텍스트(::text, 예 "...+00") — Date.parse 로 절대 시각을 안전하게 얻어 age 계산·
  // ended_at 재기록(::timestamptz)에 쓴다. kst = 'Asia/Seoul' 로 명시 변환한 오프셋 없는 텍스트 —
  // 화면 표시 전용(다시 timestamptz 로 캐스팅하지 않는다: 오프셋이 없으면 DB 세션 타임존 기준으로
  // 재해석돼 배포 환경(기본 UTC)에서 값이 틀어진다). date.ts 의 todayKey() 와 같은 이유로 DB 세션
  // 타임존(배포 Postgres는 기본 UTC)에 기대지 않는다.
  const r = await db.query<{
    id: string; started_at: string; started_at_kst: string; started_by_name: string | null;
    marked: number; last_at: string | null; last_at_kst: string | null;
  }>(
    `select ps.id, ps.started_at::text as started_at,
            (ps.started_at at time zone 'Asia/Seoul')::text as started_at_kst,
            p.name as started_by_name, count(pe.id)::int as marked,
            max(pe.at)::text as last_at,
            (max(pe.at) at time zone 'Asia/Seoul')::text as last_at_kst
       from patrol_session ps
       left join person p on p.id = ps.created_by
       left join patrol_event pe on pe.session_id = ps.id
      where ps.branch_id=$1 and ps.ended_at is null
      group by ps.id, p.name
      order by ps.started_at desc`,
    [me.activeBranchId],
  );
  const [row, ...stale] = r.rows;
  if (!row) return null;

  // 최신 1건을 제외한 나머지 미종료 세션은 여기서 곧바로 정리(그 세션의 마지막 기록 시각, 없으면 시작 시각).
  for (const s of stale) {
    const endAt = s.last_at ?? s.started_at;
    await db.query(
      `update patrol_session set ended_at=$1::timestamptz where id=$2 and branch_id=$3 and ended_at is null`,
      [endAt, s.id, me.activeBranchId],
    );
  }

  const startedMs = Date.parse(row.started_at);
  const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : Infinity;
  if (ageMs > TWELVE_HOURS_MS) {
    // 오래 방치된 세션 — 조용히 종료 처리(로그 없음), 이어하기 대상에서 제외
    const endAt = row.last_at ?? row.started_at;
    await db.query(
      `update patrol_session set ended_at=$1::timestamptz where id=$2 and branch_id=$3 and ended_at is null`,
      [endAt, row.id, me.activeBranchId],
    );
    return null;
  }

  const today = todayStr();
  const day = row.started_at_kst.slice(0, 10);
  const time = row.started_at_kst.slice(11, 16);
  const [, mo, da] = day.split("-");
  return {
    sessionId: row.id,
    startedByName: row.started_by_name ?? "알 수 없음",
    markedCount: row.marked,
    dayLabel: day === today ? "오늘" : `${Number(mo)}월 ${Number(da)}일`,
    timeLabel: time,
    lastLabel: row.last_at_kst ? row.last_at_kst.slice(11, 16) : null,
  };
}

// 특정 학생·날짜 순찰 기록 (팝업용)
export async function getPatrolEvents(studentId: string, date: string) {
  const me = await guard("patrol.view");
  const r = await db.query<{ state: string; points: number; at: string }>(
    `select state, points, at::text as at
       from patrol_event
      where student_id=$1 and branch_id=$2 and date=$3
      order by at`,
    [studentId, me.activeBranchId, date],
  );
  return r.rows;
}
