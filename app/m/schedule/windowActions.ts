// 스케쥴 입력 활성화 관리(2026-08-22, 기간제 폐지 후 전면 재작성) — schedule_grant 를 1회용 활성화로
// 다룬다. 판정 자체(순수 로직)는 lib/schedule-window.ts 를 그대로 재사용한다(로직 재발명 금지) — 여기서는
// 학생·제출·활성화를 한 번씩만 불러온 뒤 메모리에서 학생마다 evaluateEdit 을 돌린다(DB 를 학생 수만큼
// 왕복하지 않는다).
import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";
import { dateTimeLabel } from "@/lib/date";
import { evaluateEdit } from "@/lib/schedule-window";

export type ActivationState = "first" | "grant" | "locked";
export type StudentActivationRow = {
  studentId: string;
  studentName: string;
  seatNumber: number | null;
  lastSubmittedLabel: string | null;
  lastSubmittedAt: string | null; // 정렬용 원시 timestamptz(표시는 라벨만 쓴다)
  state: ActivationState;
};

const s = (v: FormDataEntryValue | null): string => String(v ?? "").trim();

/** 재원생 전체의 제출 이력 + 활성화 상태를 한 번에. 학생마다 DB 를 다시 묻지 않고(제출 이력·활성화는
 *  지점 전체를 한 번씩만 불러온 뒤) evaluateEdit 을 메모리에서 학생마다 돌린다. */
export async function listActivationStatus(): Promise<StudentActivationRow[]> {
  const me = await guard("schedule.view");
  const [studentRows, grantRows] = await Promise.all([
    db.query<{ id: string; name: string; seat_number: number | null; first_submitted_at: string | null; created_at: string | null }>(
      `with sub as (
         select distinct on (student_id) student_id, first_submitted_at, created_at
           from submission
          where branch_id=$1 and type='schedule' and student_id is not null
          order by student_id, created_at desc
       )
       select s.id, s.name, seat.number as seat_number, sub.first_submitted_at, sub.created_at
         from student s
         left join seat on seat.current_student_id = s.id and seat.branch_id = s.branch_id
         left join sub on sub.student_id = s.id
        where s.branch_id=$1 and s.status='enrolled'
        order by seat.number nulls last, s.name`,
      [me.activeBranchId],
    ),
    db.query<{ student_id: string }>(
      `select student_id from schedule_grant where branch_id=$1 and consumed_at is null`,
      [me.activeBranchId],
    ),
  ]);

  const activeGrantStudents = new Set(grantRows.rows.map((r) => r.student_id));

  return studentRows.rows.map((row) => {
    const firstSubmittedAt = row.first_submitted_at ? new Date(row.first_submitted_at) : null;
    const decision = evaluateEdit({ firstSubmittedAt, hasActiveGrant: activeGrantStudents.has(row.id) });
    return {
      studentId: row.id,
      studentName: row.name,
      seatNumber: row.seat_number,
      lastSubmittedLabel: row.created_at ? dateTimeLabel(row.created_at) : null,
      lastSubmittedAt: row.created_at,
      state: decision.open ? (decision.reason as "first" | "grant") : "locked",
    };
  });
}

/** FormData 필드: studentIds(JSON 문자열 배열), label(선택), note(선택). 지금 잠긴(=제출한 적 있고
 *  유효한 활성화가 없는) 학생만 골라 활성화한다 — 이미 열려 있는 학생을 다시 골라도(중복 클릭 등)
 *  on conflict do nothing 으로 조용히 무시된다(uq_schedule_grant_active). opens_at/closes_at 은 더 이상
 *  판정에 쓰지 않지만 NOT NULL·check 제약이 남아있어 now()~+100년으로 채운다(스키마 보존 — schema.modules.ts 참고). */
export async function activateStudents(fd: FormData): Promise<number> {
  const me = await guard("schedule.manage");
  const branchId = me.activeBranchId;
  if (!branchId) throw new Error("소속 지점을 확인할 수 없습니다");

  let studentIds: unknown;
  try {
    studentIds = JSON.parse(s(fd.get("studentIds")) || "[]");
  } catch {
    throw new Error("학생 선택을 확인하세요");
  }
  const uniqIds = Array.isArray(studentIds)
    ? [...new Set(studentIds.filter((x): x is string => typeof x === "string" && x.length > 0))]
    : [];
  if (uniqIds.length === 0) throw new Error("학생을 1명 이상 선택하세요");

  const label = s(fd.get("label")) || null;
  const note = s(fd.get("note")) || null;

  // 이 지점 학생인지 확인하며 한 번의 다중 VALUES insert(학생별 왕복 쿼리 없이). 이미 제출한 적 있는
  // 학생(=잠길 수 있는 학생)만 대상 — 첫 제출로 이미 열려 있는 학생을 활성화해도 의미가 없으니 걸러낸다.
  const params: (string | number | null)[] = [branchId, label, note, me.id];
  const values = uniqIds.map((id) => {
    params.push(id);
    return `($1,$${params.length},$2,$3,$4)`;
  });
  const ins = await db.query<{ student_id: string }>(
    `insert into schedule_grant(branch_id, student_id, label, note, created_by, opens_at, closes_at)
     select v.branch_id, v.student_id, v.label, v.note, v.created_by, now(), now() + interval '100 years'
       from (values ${values.join(",")}) as v(branch_id, student_id, label, note, created_by)
       join student st on st.id = v.student_id and st.branch_id = v.branch_id
      where exists (
        select 1 from submission sub
         where sub.branch_id = v.branch_id and sub.student_id = v.student_id
           and sub.type = 'schedule' and sub.first_submitted_at is not null
      )
     on conflict (branch_id, student_id) where consumed_at is null do nothing
     returning student_id`,
    params,
  );

  revalidatePath("/m/schedule");
  return ins.rows.length;
}

/** 아직 소진되지 않은 활성화를 회수(삭제)한다. 여러 명을 한 번에 받되 배열 파라미터는 쓰지 않고
 *  (fetch_types:false 제약) 학생 수만큼 자리표시자를 만들어 in(...) 으로 묶는다. */
export async function revokeActivation(studentIds: string[]): Promise<void> {
  const me = await guard("schedule.manage");
  const branchId = me.activeBranchId;
  const uniqIds = [...new Set(studentIds.filter((id) => id.length > 0))];
  if (uniqIds.length === 0) return;

  const params: string[] = [branchId ?? ""];
  const placeholders = uniqIds.map((id) => {
    params.push(id);
    return `$${params.length}`;
  });
  await db.query(
    `delete from schedule_grant where branch_id=$1 and consumed_at is null and student_id in (${placeholders.join(",")})`,
    params,
  );
  revalidatePath("/m/schedule");
}
