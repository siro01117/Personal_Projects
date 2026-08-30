import { db } from "./db";
import { DEFAULT_NOTICE, type LunchMonth, type Closure } from "./lunch";

// 월 설정 행을 가져오거나(없으면) 기본값으로 생성. 관리·공개 페이지 공용.
export async function getOrCreateMonth(branchId: string, year: number, month: number): Promise<LunchMonth> {
  const sel = `select id, year, month, lunch_label, lunch_price, dinner_label, dinner_price, notice
                 from lunch_month where branch_id=$1 and year=$2 and month=$3`;
  const found = await db.query<LunchMonth>(sel, [branchId, year, month]);
  if (found.rows[0]) return found.rows[0];
  await db.query(
    `insert into lunch_month(branch_id, year, month, notice) values ($1,$2,$3,$4)
     on conflict (branch_id, year, month) do nothing`,
    [branchId, year, month, DEFAULT_NOTICE],
  );
  const again = await db.query<LunchMonth>(sel, [branchId, year, month]);
  return again.rows[0];
}

export async function listClosures(monthId: string): Promise<Closure[]> {
  const r = await db.query<Closure>(
    `select date::text as date, lunch_closed, dinner_closed, label
       from lunch_closure where month_id=$1 order by date`,
    [monthId],
  );
  return r.rows;
}
