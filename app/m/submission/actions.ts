import { revalidatePath } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { guard } from "@/lib/auth";

const s = (v: FormDataEntryValue | null): string => String(v ?? "").trim();
const STATUSES = new Set(["pending", "done", "rejected"]);

/** 응답 상태 변경(대기/처리완료/반려). student.edit 권한 필요(perms.ts 에 전용 권한이 없어 재사용). */
export async function setSubmissionStatus(formData: FormData): Promise<void> {
  const me = await guard("student.edit");
  const id = s(formData.get("id"));
  const status = s(formData.get("status"));
  if (!id || !STATUSES.has(status)) return;
  await db.query(
    `update submission set status=$1, processed_by=$2, processed_at=now()
      where id=$3 and branch_id=$4`,
    [status, me.id, id, me.activeBranchId],
  );
  revalidatePath("/m/submission");
}
