// Supabase 클라이언트 (anon publishable 키 — 브라우저 노출 전제).
// anon 역할은 kv/guest_progress 에 GRANT 가 없다. 로그인(authenticated) 전에는 데이터를 못 읽는다.
// 세션 유지는 supabase-js 에 맡긴다 — localStorage 저장 + 토큰 자동 갱신. 직접 만들지 않는다.
import { createClient } from '@supabase/supabase-js';

const URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://ovnabmmofgujgefuamzn.supabase.co';

const ANON =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92bmFibW1vZmd1amdlZnVhbXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NzY1NDMsImV4cCI6MjA5MDU1MjU0M30.IvgT7eE_PfxRplHVkf2kXGw_sqGy07WNausqit3qskk';

// 정적 추출이라 이 모듈이 서버(빌드)에서도 한 번 평가된다. storage 는 브라우저에서만 잡는다.
export const supabase = createClient(URL, ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'rakan.auth',
  },
});

// 화면에서는 아이디만 받는다(`cto`). 내부에서만 메일 주소로 바꾼다.
const MAIL_DOMAIN = 'ra-kan.cloud';
export const toEmail = (id) => {
  const v = String(id || '').trim();
  return v.includes('@') ? v : `${v.toLowerCase()}@${MAIL_DOMAIN}`;
};

export async function signIn(loginId, password) {
  return supabase.auth.signInWithPassword({ email: toEmail(loginId), password });
}

export const signOut = () => supabase.auth.signOut();

// 로그인 실패 메시지를 한국어로. 원문은 영어라 그대로 보여주면 읽히지 않는다.
export function authErrorText(error) {
  const m = String(error?.message || '');
  if (/invalid login credentials/i.test(m)) return '아이디 또는 비밀번호가 맞지 않습니다.';
  if (/email not confirmed/i.test(m)) return '메일 인증이 끝나지 않은 계정입니다.';
  if (/rate limit|too many/i.test(m)) return '시도가 너무 잦습니다. 잠시 후 다시 해주세요.';
  if (/fetch|network/i.test(m)) return '네트워크에 연결하지 못했습니다.';
  return m || '로그인에 실패했습니다.';
}
