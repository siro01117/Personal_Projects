// 서버 라우트 전용 service_role 클라이언트. 키는 서버 환경변수(EZ_SUPABASE_SERVICE_ROLE_KEY)에만 있다 —
// NEXT_PUBLIC_ 이 아니라 브라우저 번들에 박히지 않는다. 이 파일은 route.ts 만 가져온다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** 환경변수가 없으면 null (라우트가 500 과 문구를 돌려준다) */
export function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.EZ_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client ??= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return client;
}
