// 학생 정기 스케쥴 제출(submission, type='schedule')을 실제 시간표(schedule_hours/schedule_rule)에
// 반영하는 핵심 로직. 관리자 수동 반영(m/schedule/submissionActions.ts applySubmissions)과 학생 제출
// 즉시 자동 반영(f/actions.ts submitForm, 지점 설정 schedule_auto_apply) 둘 다 이 함수 하나를 그대로
// 타야 한다 — 두 경로가 갈라지면 "자동으로 반영됐다"와 "관리자가 반영했다"의 결과가 달라질 수 있다
// (schedule-request.ts 의 approveScheduleRequest 를 수동/자동 승인이 공유하는 것과 같은 원칙).
import { db } from "./db";
import { academyToDbFields, type ImportHours, type DbAcademy } from "./schedule-import";
import { adaptSubmissionPayload } from "./schedule-submission";

export type ApplySubmissionsResult = {
  applied: number;
  appliedIds: string[]; // 반영에 성공한 submission id
  failed: { id: string; name: string; error: string }[];
};

/** 선택된 submission id 들을 실제 시간표에 반영한다. 호출부(guard 등 권한 확인)는 각자 책임 —
 *  이 함수 자체는 branchId 로만 범위를 한정한다(다른 지점 id 는 애초에 조회되지 않아 자연히 실패 처리).
 *  클라가 보낸 hours/academies 를 신뢰하지 않고, DB의 payload 를 여기서 다시 조회·검증해서 쓴다. */
export async function applySubmissionsCore(branchId: string, ids: string[]): Promise<ApplySubmissionsResult> {
  const uniqIds = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (uniqIds.length === 0) return { applied: 0, appliedIds: [], failed: [] };

  const params: string[] = [branchId];
  const ph = uniqIds.map((id) => {
    params.push(id);
    return `$${params.length}`;
  });
  const rows = await db.query<{ id: string; student_id: string | null; student_name: string | null; payload: unknown; status: string }>(
    `select sub.id, sub.student_id, st.name as student_name, sub.payload, sub.status
       from submission sub
       left join student st on st.id = sub.student_id and st.status='enrolled'
      where sub.branch_id=$1 and sub.type='schedule' and sub.id in (${ph.join(",")})`,
    params,
  );
  const found = new Map(rows.rows.map((r) => [r.id, r]));

  const failed: { id: string; name: string; error: string }[] = [];
  const usable: { id: string; studentId: string; hours: ImportHours[]; academies: DbAcademy[] }[] = [];
  const seenStudents = new Set<string>();

  for (const id of uniqIds) {
    const row = found.get(id);
    if (!row) {
      failed.push({ id, name: "-", error: "제출을 찾을 수 없습니다" });
      continue;
    }
    if (row.status !== "pending") {
      failed.push({ id, name: row.student_name ?? "-", error: "대기 중 상태가 아닙니다" });
      continue;
    }
    if (!row.student_id || !row.student_name) {
      failed.push({ id, name: row.student_name ?? "-", error: "재원생이 아닙니다(학생 정보 없음)" });
      continue;
    }
    if (seenStudents.has(row.student_id)) {
      failed.push({ id, name: row.student_name, error: "같은 학생의 다른 제출과 중복됩니다" });
      continue;
    }
    const result = adaptSubmissionPayload(row.payload, row.student_name, null, 0);
    if (result.ok === false) {
      failed.push({ id, name: row.student_name, error: result.error });
      continue;
    }
    seenStudents.add(row.student_id);
    usable.push({
      id,
      studentId: row.student_id,
      hours: result.student.hours,
      academies: result.student.academies.map(academyToDbFields),
    });
  }

  if (usable.length === 0) return { applied: 0, appliedIds: [], failed };

  const targetStudentIds = usable.map((u) => u.studentId);

  // 기존 등하원 전부 + schedule_rule(kind='academy') 만 지우고 새로 넣는다(임시 일정·예외·다른 사유 보존).
  {
    const delParams: string[] = [branchId];
    const delPh = targetStudentIds.map((id) => {
      delParams.push(id);
      return `$${delParams.length}`;
    });
    await db.query(`delete from schedule_hours where branch_id=$1 and student_id in (${delPh.join(",")})`, delParams);
    await db.query(`delete from schedule_rule where branch_id=$1 and kind='academy' and student_id in (${delPh.join(",")})`, delParams);
  }

  {
    const insParams: (string | number)[] = [branchId];
    const values: string[] = [];
    for (const item of usable) {
      for (const h of item.hours) {
        const base = insParams.length;
        insParams.push(item.studentId, h.day, h.arrive, h.leave);
        values.push(`($1,$${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
      }
    }
    if (values.length > 0) {
      await db.query(
        `insert into schedule_hours(branch_id, student_id, day, arrive_min, leave_min) values ${values.join(",")}`,
        insParams,
      );
    }
  }

  {
    const insParams: (string | number)[] = [branchId];
    const values: string[] = [];
    for (const item of usable) {
      for (const a of item.academies) {
        const daysCsv = [...new Set(a.days)].sort((x, y) => x - y).join(",");
        const base = insParams.length;
        insParams.push(item.studentId, a.reason, a.title, a.start, a.end, daysCsv);
        values.push(`($1,$${base + 1},$${base + 2},'academy',$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
      }
    }
    if (values.length > 0) {
      await db.query(
        `insert into schedule_rule(branch_id, student_id, reason, kind, title, start_min, end_min, days) values ${values.join(",")}`,
        insParams,
      );
    }
  }

  {
    const updParams: (string | null)[] = [null, branchId];
    const updPh = usable.map((u) => {
      updParams.push(u.id);
      return `$${updParams.length}`;
    });
    await db.query(
      `update submission set status='done', note=null, processed_by=$1, processed_at=now()
        where branch_id=$2 and id in (${updPh.join(",")})`,
      updParams,
    );
  }

  return { applied: usable.length, appliedIds: usable.map((u) => u.id), failed };
}

/** 지점의 스케쥴 자동 반영 설정(branch_setting.schedule_auto_apply). 방학·개학 같은 정기 스케쥴 제출은
 *  빈도가 낮고 신뢰도가 높아 "학생이 제출하면 즉시 반영"이 기본이다 — 그래서 설정 행이 아예 없는
 *  지점(새 지점 포함)도 켜진 것으로 간주한다(isAutoApproveOn 의 기본 꺼짐과는 반대 — schedule-request.ts
 *  참고, 그쪽은 일회성 변경 신청이라 기본을 다르게 잡았다). */
export async function isScheduleAutoApplyOn(branchId: string): Promise<boolean> {
  const r = await db.query<{ value: string }>(
    `select value from branch_setting where branch_id=$1 and key='schedule_auto_apply'`,
    [branchId],
  );
  if (r.rows.length === 0) return true;
  return r.rows[0].value === "1";
}
