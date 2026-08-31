// 데모 데이터의 날짜 신선도 보정.
//
// 빌드 시점에 미리 시드해둔 덤프(scripts/build-demo-db.ts)는 seedDemo/seedDemoExpansion이
// todayKey() 기준 "상대" 날짜로 데이터를 채운다(예: "지난 20영업일", "이번 주"). 그 결과가
// 덤프 파일에 그대로 굳어버리므로, 빌드한 날과 실제로 열람하는 날 사이에 며칠이 지나면
// "오늘 출결"이 과거 날짜로 보이는 등 신선도가 깨진다.
//
// app_meta.demo_seed_date 에 데이터가 실제로 심긴 날짜를 남겨두고(bootstrap.ts), 매 부팅마다
// 오늘과 비교해 다르면 그 차이(일수)만큼 모든 날짜/시각 컬럼을 일괄로 밀어준다 — 그러면 "지난
// 20영업일" 같은 상대적 배치는 그대로 유지한 채 절대 날짜만 오늘 기준으로 재정렬된다.
// 보정 직후 demo_seed_date를 오늘로 갱신해두므로, 같은 날 안에서는 이 함수가 여러 번 불려도
// (매 페이지 ready() 호출마다) 실제 UPDATE는 하루에 한 번만 돈다.
import { db } from "./db";
import { todayKey } from "./date";

function daysBetween(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

// timestamptz 컬럼 — make_interval(days=>N)만큼 이동(시각은 보존).
const TS_SHIFT: [table: string, cols: string[]][] = [
  ["attendance_event", ["at"]],
  ["patrol_session", ["started_at", "ended_at"]],
  ["patrol_event", ["at"]],
  ["penalty_event", ["at"]],
  ["submission", ["created_at", "first_submitted_at", "processed_at"]],
  ["lunch_order", ["created_at", "updated_at"]],
];

// date 컬럼 — 정수 더하기로 이동(NULL은 NULL 그대로 안전).
const DATE_SHIFT: [table: string, cols: string[]][] = [
  ["attendance_event", ["date"]],
  ["patrol_session", ["date"]],
  ["patrol_event", ["date"]],
  ["penalty_event", ["date"]],
  ["lunch_closure", ["date"]],
  ["lunch_meal", ["date"]],
  ["lunch_order", ["paid_date"]],
];

/** app_meta.demo_seed_date 와 오늘을 비교해, 필요하면 데모 데이터의 날짜를 전부 오늘 기준으로 민다.
 *  demo_seed_date 자체가 없으면(구버전 DB 등) 아무것도 하지 않는다 — 상대 계산 시드가 아니라는 뜻. */
export async function correctDemoDates(): Promise<void> {
  const today = todayKey();
  let seedDate: string | undefined;
  try {
    const r = await db.query<{ value: string }>(`select value from app_meta where key='demo_seed_date'`);
    seedDate = r.rows[0]?.value;
  } catch {
    return; // app_meta 조차 아직 없는 비정상 상태 — 다음 ready() 호출에서 재시도
  }
  if (!seedDate || seedDate === today) return;

  const deltaDays = daysBetween(seedDate, today);
  if (deltaDays !== 0) {
    for (const [table, cols] of TS_SHIFT) {
      const sets = cols.map((c) => `${c} = ${c} + make_interval(days => $1::int)`).join(", ");
      await db.query(`update ${table} set ${sets}`, [deltaDays]);
    }
    // date 컬럼 중 일부(lunch_meal.date, lunch_closure.date)는 복합 유니크 제약(예:
    // lunch_meal(order_id,date,meal_type))의 일부다. 한 방에 "date = date + N"으로 밀면,
    // 최종 결과에는 중복이 없어도 UPDATE가 행을 하나씩 처리하는 도중 아직 안 밀린 행의
    // 기존 값과 방금 밀린 행의 새 값이 우연히 같아져 유니크 제약 위반으로 죽을 수 있다
    // (예: A=8/3, B=8/8, +5일 → A가 먼저 8/8이 되는 순간 아직 안 밀린 B의 8/8과 충돌).
    // 그래서 일단 아주 먼 미래(100000일 = 약 274년, 실제 시드 데이터 범위와 절대 겹치지 않음)로
    // 전부 밀어 서로 안 부딪히게 만든 다음, 그 자리에서 목표 날짜로 되민다 — 2단계 모두
    // "행 처리 순서와 무관하게 절대 겹치지 않는" 상태로만 거치므로 안전하다.
    const FAR_FUTURE_DAYS = 100_000;
    for (const [table, cols] of DATE_SHIFT) {
      const bump = cols.map((c) => `${c} = ${c} + ${FAR_FUTURE_DAYS}`).join(", ");
      await db.query(`update ${table} set ${bump}`);
      const settle = cols.map((c) => `${c} = ${c} + $1::int`).join(", ");
      await db.query(`update ${table} set ${settle}`, [deltaDays - FAR_FUTURE_DAYS]);
    }

    // lunch_month.year/month 는 날짜가 아니라 달력 월 단위 — 일수가 아니라 "월 차이"로 이동해야
    // "이번 달·다음 달" 배치가 유지된다(2/1과 3/3 사이는 30일이 아니라 1개월이다).
    const [ty, tm] = today.split("-").map(Number);
    const [sy, sm] = seedDate.split("-").map(Number);
    const deltaMonths = ty * 12 + (tm - 1) - (sy * 12 + (sm - 1));
    if (deltaMonths !== 0) {
      // lunch_month 도 unique(branch_id,year,month) 복합 제약이 있어 위와 같은 이유로
      // 2단계(먼 미래로 밀었다가 되밀기)로 처리한다.
      const FAR_FUTURE_MONTHS = 100_000 * 12;
      await db.query(
        `update lunch_month set
           year  = ((year*12 + (month-1) + ${FAR_FUTURE_MONTHS}) / 12),
           month = ((year*12 + (month-1) + ${FAR_FUTURE_MONTHS}) % 12) + 1`,
      );
      const settleMonths = deltaMonths - FAR_FUTURE_MONTHS;
      await db.query(
        `update lunch_month set
           year  = ((year*12 + (month-1) + $1::int) / 12),
           month = ((year*12 + (month-1) + $1::int) % 12) + 1`,
        [settleMonths],
      );
    }
  }

  await db.query(
    `insert into app_meta(key,value) values ('demo_seed_date',$1)
     on conflict (key) do update set value=excluded.value, updated_at=now()`,
    [today],
  );
}
