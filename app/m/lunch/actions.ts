import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";
import { defaultClosure, dowOf } from "@/lib/lunch";

const s = (v: FormDataEntryValue | null): string | null => {
  const t = String(v ?? "").trim();
  return t.length ? t : null;
};
const num = (v: FormDataEntryValue | null): number => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// 월 설정(중/석식 라벨·가격·공지) 저장
export async function updateMonth(formData: FormData) {
  const me = await guard("lunch.manage");
  const id = s(formData.get("monthId"));
  if (!id) return;
  await db.query(
    `update lunch_month set lunch_label=$1, lunch_price=$2, dinner_label=$3, dinner_price=$4, notice=$5
      where id=$6 and branch_id=$7`,
    [s(formData.get("lunch_label")) ?? "중식", num(formData.get("lunch_price")),
     s(formData.get("dinner_label")) ?? "석식", num(formData.get("dinner_price")),
     s(formData.get("notice")), id, me.activeBranchId],
  );
  revalidatePath("/m/lunch");
}

// 휴무 설정: 특정 날짜의 중식/석식 휴무 여부를 명시적으로 저장.
// 결과가 그 날의 기본값(주말·공휴일 자동휴무)과 같으면 오버라이드 행을 지워 깔끔하게 유지.
export async function setClosure(formData: FormData) {
  const me = await guard("lunch.manage");
  const monthId = s(formData.get("monthId"));
  const date = s(formData.get("date"));
  if (!monthId || !date) return;
  // 소속 월이 이 지점 것인지 확인
  const own = await db.query(`select 1 from lunch_month where id=$1 and branch_id=$2`, [monthId, me.activeBranchId]);
  if (own.rows.length === 0) return;

  const lunchClosed = s(formData.get("lunch_closed")) === "1";
  const dinnerClosed = s(formData.get("dinner_closed")) === "1";
  const def = defaultClosure(date, dowOf(date));
  const defLunch = def?.lunch_closed ?? false;
  const defDinner = def?.dinner_closed ?? false;

  if (lunchClosed === defLunch && dinnerClosed === defDinner) {
    await db.query(`delete from lunch_closure where month_id=$1 and date=$2`, [monthId, date]);
  } else {
    await db.query(
      `insert into lunch_closure(month_id, date, lunch_closed, dinner_closed, label)
       values ($1,$2,$3,$4,$5)
       on conflict (month_id, date) do update set lunch_closed=excluded.lunch_closed, dinner_closed=excluded.dinner_closed, label=excluded.label`,
      [monthId, date, lunchClosed, dinnerClosed, def?.label || null],
    );
  }
  revalidatePath("/m/lunch");
}

// 주문 결제(선불) 기록
export async function setOrderPayment(formData: FormData) {
  const me = await guard("lunch.manage");
  const id = s(formData.get("orderId"));
  if (!id) return;
  const paid = s(formData.get("paid")) === "1";
  await db.query(
    `update lunch_order set paid=$1, paid_amount=$2, paid_date=$3::date, memo=$4, updated_at=now()
      where id=$5 and branch_id=$6`,
    [paid, num(formData.get("paid_amount")), s(formData.get("paid_date")), s(formData.get("memo")), id, me.activeBranchId],
  );
  revalidatePath("/m/lunch");
}
