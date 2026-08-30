// 학생 스케쥴러 서버액션 — schedule_period / schedule_rule / schedule_exception 테이블 CRUD.
// 클라이언트(ScheduleView.tsx)는 낙관적 갱신으로 즉시 반영하고, 여기서 실패하면 롤백한다.
import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";

export type Kind = "study" | "academy" | "counsel" | "absent";
const KINDS: Kind[] = ["study", "academy", "counsel", "absent"];

export type Period = { id: string; label: string; start: number; end: number };
export type Rule = { id: string; kind: Kind; reason: string; title: string; start: number; end: number; days: number[] };
export type Exc = {
  id: string; kind: Kind; reason: string; title: string; start: number; end: number; date: string; skipRuleId?: string;
};
export type Hours = { day: number; arrive_min: number; leave_min: number };

type PeriodRow = { id: string; label: string; start_min: number; end_min: number; ord: number };
type RuleRow = {
  id: string; student_id: string; reason: string; kind: Kind; title: string; start_min: number; end_min: number; days: string;
};
type ExceptionRow = {
  id: string; student_id: string; reason: string; kind: Kind; title: string; start_min: number; end_min: number;
  date: string; skip_rule_id: string | null;
};
type HoursRow = { day: number; arrive_min: number; leave_min: number };

const toPeriod = (r: PeriodRow): Period => ({ id: r.id, label: r.label, start: r.start_min, end: r.end_min });
const toRule = (r: RuleRow): Rule => ({
  id: r.id, kind: r.kind, reason: r.reason, title: r.title, start: r.start_min, end: r.end_min,
  days: r.days ? r.days.split(",").map(Number).filter((n) => Number.isFinite(n)) : [],
});
const toExc = (r: ExceptionRow): Exc => ({
  id: r.id, kind: r.kind, reason: r.reason, title: r.title, start: r.start_min, end: r.end_min,
  date: r.date, skipRuleId: r.skip_rule_id ?? undefined,
});
const toHours = (r: HoursRow): Hours => ({ day: r.day, arrive_min: r.arrive_min, leave_min: r.leave_min });

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};

// 그 학생의 정기 규칙 전체 + 지점 운영 시간표 + [weekStart, weekEnd] 범위의 예외 + 요일별 등하원 시각
export async function listSchedule(studentId: string, weekStart: string, weekEnd: string) {
  const me = await guard("schedule.view");
  const [periods, rules, excs, hours] = await Promise.all([
    db.query<PeriodRow>(
      `select id, label, start_min, end_min, ord from schedule_period where branch_id=$1 order by ord`,
      [me.activeBranchId],
    ),
    db.query<RuleRow>(
      `select id, student_id, reason, kind, title, start_min, end_min, days
         from schedule_rule where branch_id=$1 and student_id=$2 order by start_min`,
      [me.activeBranchId, studentId],
    ),
    db.query<ExceptionRow>(
      `select id, student_id, reason, kind, title, start_min, end_min, date::text as date, skip_rule_id
         from schedule_exception
        where branch_id=$1 and student_id=$2 and date between $3 and $4
        order by date`,
      [me.activeBranchId, studentId, weekStart, weekEnd],
    ),
    db.query<HoursRow>(
      `select day, arrive_min, leave_min from schedule_hours where branch_id=$1 and student_id=$2 order by day`,
      [me.activeBranchId, studentId],
    ),
  ]);
  return {
    periods: periods.rows.map(toPeriod),
    rules: rules.rows.map(toRule),
    exceptions: excs.rows.map(toExc),
    hours: hours.rows.map(toHours),
  };
}

// 선택 요일들에 동일한 등원/하원 시각을 upsert. 단일 multi-row 문(on conflict (student_id, day) do update).
export async function setHours(fd: FormData): Promise<Hours[]> {
  const me = await guard("schedule.manage");
  const studentId = s(fd.get("studentId"));
  const daysRaw = s(fd.get("days"));
  const arrive = Number(s(fd.get("arrive")));
  const leave = Number(s(fd.get("leave")));
  const days = daysRaw
    ? [...new Set(daysRaw.split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 7))]
    : [];

  if (!studentId || !days.length) throw new Error("요일을 선택하세요");
  if (!Number.isFinite(arrive) || !Number.isFinite(leave) || leave <= arrive) throw new Error("시간을 확인하세요");

  const params: (string | number | null)[] = [me.activeBranchId, studentId];
  const values = days.map((d) => {
    const base = params.length;
    params.push(d, arrive, leave);
    return `($1,$2,$${base + 1},$${base + 2},$${base + 3})`;
  });
  const row = await db.query<HoursRow>(
    `insert into schedule_hours(branch_id, student_id, day, arrive_min, leave_min)
     values ${values.join(",")}
     on conflict (student_id, day) do update set arrive_min=excluded.arrive_min, leave_min=excluded.leave_min
     returning day, arrive_min, leave_min`,
    params,
  );
  revalidatePath("/m/schedule");
  return row.rows.map(toHours);
}

// 선택 요일들의 등하원 시각 삭제.
export async function clearHours(fd: FormData): Promise<void> {
  const me = await guard("schedule.manage");
  const studentId = s(fd.get("studentId"));
  const daysRaw = s(fd.get("days"));
  const days = daysRaw ? daysRaw.split(",").map(Number).filter((n) => Number.isFinite(n)) : [];
  if (!studentId || !days.length) throw new Error("요일을 선택하세요");

  const params: (string | number | null)[] = [me.activeBranchId, studentId];
  const placeholders = days.map((d) => {
    params.push(d);
    return `$${params.length}`;
  });
  await db.query(
    `delete from schedule_hours where branch_id=$1 and student_id=$2 and day in (${placeholders.join(",")})`,
    params,
  );
  revalidatePath("/m/schedule");
}

// 정기 규칙 추가/수정. id 가 있으면 그 규칙을(그 학생 소유인지 확인하며) 수정, 없으면 새로 생성.
export async function upsertRule(fd: FormData): Promise<Rule> {
  const me = await guard("schedule.manage");
  const id = s(fd.get("id"));
  const studentId = s(fd.get("studentId"));
  const reason = s(fd.get("reason"));
  const kind = s(fd.get("kind")) as Kind | null;
  const title = s(fd.get("title")) ?? "";
  const start = Number(s(fd.get("start")));
  const end = Number(s(fd.get("end")));
  const daysRaw = s(fd.get("days"));
  const days = daysRaw ? daysRaw.split(",").map(Number).filter((n) => Number.isFinite(n)) : [];

  if (!studentId || !reason || !kind || !KINDS.includes(kind)) throw new Error("입력값을 확인하세요");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("시간을 확인하세요");
  if (!days.length) throw new Error("요일을 선택하세요");
  const daysCsv = [...new Set(days)].sort((a, b) => a - b).join(",");

  const row = id
    ? (
        await db.query<RuleRow>(
          `update schedule_rule set reason=$1, kind=$2, title=$3, start_min=$4, end_min=$5, days=$6
            where id=$7 and branch_id=$8 and student_id=$9
            returning id, student_id, reason, kind, title, start_min, end_min, days`,
          [reason, kind, title, start, end, daysCsv, id, me.activeBranchId, studentId],
        )
      ).rows[0]
    : (
        await db.query<RuleRow>(
          `insert into schedule_rule(branch_id, student_id, reason, kind, title, start_min, end_min, days)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           returning id, student_id, reason, kind, title, start_min, end_min, days`,
          [me.activeBranchId, studentId, reason, kind, title, start, end, daysCsv],
        )
      ).rows[0];
  if (!row) throw new Error("저장에 실패했습니다");
  revalidatePath("/m/schedule");
  return toRule(row);
}

export async function deleteRule(id: string): Promise<void> {
  const me = await guard("schedule.manage");
  await db.query(`delete from schedule_rule where id=$1 and branch_id=$2`, [id, me.activeBranchId]);
  revalidatePath("/m/schedule");
}

// 규칙에서 요일 하나만 제거. 마지막 요일이면 규칙 자체를 삭제.
export async function removeRuleDay(id: string, day: number): Promise<{ deleted: boolean }> {
  const me = await guard("schedule.manage");
  const r = await db.query<{ days: string }>(
    `select days from schedule_rule where id=$1 and branch_id=$2`,
    [id, me.activeBranchId],
  );
  const row = r.rows[0];
  if (!row) return { deleted: true };
  const days = row.days.split(",").map(Number).filter((d) => d !== day);
  if (days.length === 0) {
    await db.query(`delete from schedule_rule where id=$1 and branch_id=$2`, [id, me.activeBranchId]);
    revalidatePath("/m/schedule");
    return { deleted: true };
  }
  await db.query(`update schedule_rule set days=$1 where id=$2 and branch_id=$3`, [days.join(","), id, me.activeBranchId]);
  revalidatePath("/m/schedule");
  return { deleted: false };
}

// 예외 추가/수정
export async function upsertException(fd: FormData): Promise<Exc> {
  const me = await guard("schedule.manage");
  const id = s(fd.get("id"));
  const studentId = s(fd.get("studentId"));
  const reason = s(fd.get("reason"));
  const kind = s(fd.get("kind")) as Kind | null;
  const title = s(fd.get("title")) ?? "";
  const start = Number(s(fd.get("start")));
  const end = Number(s(fd.get("end")));
  const date = s(fd.get("date"));
  const skipRuleId = s(fd.get("skipRuleId"));

  if (!studentId || !reason || !kind || !KINDS.includes(kind) || !date) throw new Error("입력값을 확인하세요");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("시간을 확인하세요");

  const row = id
    ? (
        await db.query<ExceptionRow>(
          `update schedule_exception
              set reason=$1, kind=$2, title=$3, start_min=$4, end_min=$5, date=$6, skip_rule_id=$7
            where id=$8 and branch_id=$9 and student_id=$10
            returning id, student_id, reason, kind, title, start_min, end_min, date::text as date, skip_rule_id`,
          [reason, kind, title, start, end, date, skipRuleId, id, me.activeBranchId, studentId],
        )
      ).rows[0]
    : (
        await db.query<ExceptionRow>(
          `insert into schedule_exception(branch_id, student_id, reason, kind, title, start_min, end_min, date, skip_rule_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning id, student_id, reason, kind, title, start_min, end_min, date::text as date, skip_rule_id`,
          [me.activeBranchId, studentId, reason, kind, title, start, end, date, skipRuleId],
        )
      ).rows[0];
  if (!row) throw new Error("저장에 실패했습니다");
  revalidatePath("/m/schedule");
  return toExc(row);
}

export async function deleteException(id: string): Promise<void> {
  const me = await guard("schedule.manage");
  await db.query(`delete from schedule_exception where id=$1 and branch_id=$2`, [id, me.activeBranchId]);
  revalidatePath("/m/schedule");
}

// 운영 시간표(교시) 전체 교체 — 지점 단위. delete+insert 를 하나의 CTE 문으로 원자적으로 처리.
export async function savePeriods(fd: FormData): Promise<{ periods: Period[] }> {
  const me = await guard("schedule.manage");
  let items: { label: string; start: number; end: number }[];
  try {
    items = JSON.parse(s(fd.get("periods")) ?? "[]");
  } catch {
    throw new Error("입력값을 확인하세요");
  }
  if (!Array.isArray(items)) throw new Error("입력값을 확인하세요");
  const clean = items
    .map((p) => ({ label: String(p.label ?? "").trim(), start: Number(p.start), end: Number(p.end) }))
    .filter((p) => p.label && Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);

  if (clean.length === 0) {
    await db.query(`delete from schedule_period where branch_id=$1`, [me.activeBranchId]);
    revalidatePath("/m/schedule");
    return { periods: [] };
  }

  const params: (string | number | null)[] = [me.activeBranchId];
  const values = clean.map((p, i) => {
    const base = params.length;
    params.push(p.label, p.start, p.end, i);
    return `($1,$${base + 1},$${base + 2},$${base + 3},$${base + 4})`;
  });
  const r = await db.query<PeriodRow>(
    `with del as (delete from schedule_period where branch_id=$1)
     insert into schedule_period(branch_id, label, start_min, end_min, ord)
     values ${values.join(",")}
     returning id, label, start_min, end_min, ord`,
    params,
  );
  revalidatePath("/m/schedule");
  return { periods: r.rows.sort((a, b) => a.ord - b.ord).map(toPeriod) };
}
