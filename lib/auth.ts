// auth.ts (브라우저 데모판) — 원본은 서버 전용(cookies, node:crypto)이라 그대로 못 옮긴다.
// 데모는 로그인 화면이 없다: 항상 고정된 데모 관리자(Me)를 반환하고, guard()는 항상 통과한다.
// 함수 시그니처는 원본(src/lib/auth.ts)과 동일하게 맞춰 호출부 코드를 한 줄도 바꾸지 않는다.
import { db } from "./db";
import { ready } from "./bootstrap";
import { PERMISSIONS } from "./perms";

export type Me = {
  id: string;
  loginId: string;
  name: string;
  isCto: boolean;
  activeBranchId: string | null;
  perms: string[];
};

const ALL_PERMS = PERMISSIONS.map((p) => p.key);

/** 권한 판정 — 데모는 CTO 고정이라 항상 true */
export function can(me: Me | null, perm: string): boolean {
  if (!me) return false;
  return me.isCto || me.perms.includes(perm);
}

/** 서버액션 가드 — 데모는 항상 통과, Me만 채워서 반환 */
export async function guard(_perm: string): Promise<Me> {
  const me = await getMe();
  if (!me) throw new Error("데모 데이터가 아직 준비되지 않았습니다");
  return me;
}

let cachedMe: Me | null = null;

/** 현재 로그인 사용자 — 데모는 항상 시드된 마스터 계정(나한결)을 반환 */
export async function getMe(): Promise<Me | null> {
  if (cachedMe) return cachedMe;
  await ready();
  const p = await db.query<{ id: string; login_id: string; name: string; is_cto: boolean }>(
    `select id, login_id, name, is_cto from person where is_cto = true order by created_at limit 1`,
  );
  const person = p.rows[0];
  if (!person) return null;
  const hq = await db.query<{ id: string }>(`select id from branch where code='HQ' order by created_at limit 1`);
  const any = hq.rows[0]
    ? hq.rows[0]
    : (await db.query<{ id: string }>(`select id from branch order by created_at limit 1`)).rows[0];
  cachedMe = {
    id: person.id,
    loginId: person.login_id,
    name: person.name,
    isCto: true,
    activeBranchId: any?.id ?? null,
    perms: ALL_PERMS,
  };
  return cachedMe;
}

// 데모엔 실제 세션이 없다 — 로그인/로그아웃 UI가 호출해도 아무 일도 하지 않는다.
export async function setSession(_personId: string, _remember: boolean): Promise<void> {}
export async function clearSession(): Promise<void> {
  cachedMe = null;
}
