// 스케줄 JSON 업로드 → 미리보기 → 부분 적용 화면의 서버액션.
// src/app/m/schedule/importActions.ts(하드코딩 시드 1회성 임포트)와 별개 — 이쪽은 임의의 정제된
// src/lib/schedule-import.ts 형식 JSON 을 받아 미리보기·부분 적용을 지원하는 상위 호환 경로다.
// 기존 스키마(schedule_hours/schedule_rule)만 쓰고 SCHEDULE_VERSION 은 건드리지 않는다.
import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";
import type { ImportHours, DbAcademy } from "@/lib/schedule-import";

export type BaseStudent = { id: string; name: string; seatNumber: number | null };
export type BaseHours = { studentId: string; day: number; arrive: number; leave: number };
export type BaseAcademy = { studentId: string; reason: string; title: string; days: number[]; start: number; end: number };

export type ImportBase = { students: BaseStudent[]; hours: BaseHours[]; academies: BaseAcademy[] };

// 미리보기 비교용 — 지점 전체를 3쿼리로 읽어 클라에서 이름 매칭·비교(학생별 루프 없음).
export async function loadImportBase(): Promise<ImportBase> {
  const me = await guard("schedule.manage");
  const branchId = me.activeBranchId;
  if (!branchId) throw new Error("소속 지점을 확인할 수 없습니다");

  const [studentRows, hoursRows, ruleRows] = await Promise.all([
    db.query<{ id: string; name: string; seat_number: number | null }>(
      `select s.id, s.name, seat.number as seat_number
         from student s
         left join seat on seat.current_student_id = s.id and seat.branch_id = s.branch_id
        where s.branch_id=$1 and s.status='enrolled'`,
      [branchId],
    ),
    db.query<{ student_id: string; day: number; arrive_min: number; leave_min: number }>(
      `select student_id, day, arrive_min, leave_min from schedule_hours where branch_id=$1`,
      [branchId],
    ),
    db.query<{ student_id: string; reason: string; title: string; start_min: number; end_min: number; days: string }>(
      `select student_id, reason, title, start_min, end_min, days from schedule_rule where branch_id=$1 and kind='academy'`,
      [branchId],
    ),
  ]);

  return {
    students: studentRows.rows.map((r) => ({ id: r.id, name: r.name, seatNumber: r.seat_number })),
    hours: hoursRows.rows.map((r) => ({ studentId: r.student_id, day: r.day, arrive: r.arrive_min, leave: r.leave_min })),
    academies: ruleRows.rows.map((r) => ({
      studentId: r.student_id,
      reason: r.reason,
      title: r.title,
      days: r.days ? r.days.split(",").map(Number).filter((n) => Number.isFinite(n)) : [],
      start: r.start_min,
      end: r.end_min,
    })),
  };
}

export type ApplyItem = { studentId: string; name: string; hours: ImportHours[]; academies: DbAcademy[] };
export type ApplyResult = {
  applied: number;
  skipped: number;
  // 성공적으로 반영된 studentId 목록 — 화면이 재조회 없이 해당 행만 "반영됨"으로 갱신하는 데 쓴다.
  appliedStudentIds: string[];
  failed: { studentId: string; name: string; error: string }[];
};

// 선택된 학생만 반영 — 학생별 schedule_hours 전부 + schedule_rule(kind='academy') 만 지우고 새로 넣는다.
// (다른 사유·임시 일정·예외는 건드리지 않음). 삭제·삽입 모두 여러 학생을 묶어서 1~2문으로 처리한다.
// 멱등: 매번 대상 학생의 기존 행을 지우고 넘어온 값으로 새로 채우는 방식이라, 같은 선택으로 다시
// 호출해도(중복 클릭 등) 최종 상태는 동일하다 — 별도의 dedup 로직이 필요 없다.
export async function applyImportSelection(itemsJson: string): Promise<ApplyResult> {
  const me = await guard("schedule.manage");
  const branchId = me.activeBranchId;
  if (!branchId) throw new Error("소속 지점을 확인할 수 없습니다");

  let items: ApplyItem[];
  try {
    items = JSON.parse(itemsJson);
  } catch {
    throw new Error("입력값을 확인하세요");
  }
  if (!Array.isArray(items) || items.length === 0) return { applied: 0, skipped: 0, appliedStudentIds: [], failed: [] };

  // 클라 조작 방지 — 지금 이 지점의 재원생인지 한 번에 재확인.
  const ids = [...new Set(items.map((i) => i.studentId).filter(Boolean))];
  if (ids.length === 0) return { applied: 0, skipped: items.length, appliedStudentIds: [], failed: [] };
  const rosterParams: string[] = [branchId];
  const rosterPh = ids.map((id) => {
    rosterParams.push(id);
    return `$${rosterParams.length}`;
  });
  const roster = await db.query<{ id: string }>(
    `select id from student where branch_id=$1 and status='enrolled' and id in (${rosterPh.join(",")})`,
    rosterParams,
  );
  const validIds = new Set(roster.rows.map((r) => r.id));

  const failed: { studentId: string; name: string; error: string }[] = [];
  const usable = items.filter((i) => {
    if (!validIds.has(i.studentId)) {
      failed.push({ studentId: i.studentId, name: i.name, error: "재원생이 아닙니다(명단에서 사라졌거나 다른 지점)" });
      return false;
    }
    return true;
  });
  if (usable.length === 0) return { applied: 0, skipped: items.length, appliedStudentIds: [], failed };

  const targetIds = [...new Set(usable.map((i) => i.studentId))];

  {
    const params: string[] = [branchId];
    const ph = targetIds.map((id) => {
      params.push(id);
      return `$${params.length}`;
    });
    await db.query(`delete from schedule_hours where branch_id=$1 and student_id in (${ph.join(",")})`, params);
    await db.query(`delete from schedule_rule where branch_id=$1 and kind='academy' and student_id in (${ph.join(",")})`, params);
  }

  {
    const params: (string | number)[] = [branchId];
    const values: string[] = [];
    for (const item of usable) {
      for (const h of item.hours) {
        const base = params.length;
        params.push(item.studentId, h.day, h.arrive, h.leave);
        values.push(`($1,$${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
      }
    }
    if (values.length > 0) {
      await db.query(
        `insert into schedule_hours(branch_id, student_id, day, arrive_min, leave_min) values ${values.join(",")}`,
        params,
      );
    }
  }

  {
    const params: (string | number)[] = [branchId];
    const values: string[] = [];
    for (const item of usable) {
      for (const a of item.academies) {
        const daysCsv = [...new Set(a.days)].sort((x, y) => x - y).join(",");
        const base = params.length;
        params.push(item.studentId, a.reason, a.title, a.start, a.end, daysCsv);
        values.push(`($1,$${base + 1},$${base + 2},'academy',$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
      }
    }
    if (values.length > 0) {
      await db.query(
        `insert into schedule_rule(branch_id, student_id, reason, kind, title, start_min, end_min, days) values ${values.join(",")}`,
        params,
      );
    }
  }

  revalidatePath("/m/schedule");
  return { applied: targetIds.length, skipped: items.length - usable.length, appliedStudentIds: targetIds, failed };
}
