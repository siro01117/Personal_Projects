// 원본(src/app/home/actions.ts)의 로그아웃 서버 액션 심.
// 데모엔 로그인 화면이 없다(auth.ts가 항상 데모 관리자 고정) — 로그아웃은 포털 홈으로 돌아가는 것으로 대체.
import { clearSession } from "@/lib/auth";

export async function logoutAction(): Promise<void> {
  await clearSession();
  if (typeof window !== "undefined") window.location.href = "/";
}
