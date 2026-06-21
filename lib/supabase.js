// Supabase 클라이언트 (anon 키 — 공개용, 클라이언트 노출 안전).
// 우선순위: 환경변수(NEXT_PUBLIC_*) → 하드코딩 폴백.
import { createClient } from '@supabase/supabase-js';

const URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://ovnabmmofgujgefuamzn.supabase.co';

const ANON =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92bmFibW1vZmd1amdlZnVhbXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NzY1NDMsImV4cCI6MjA5MDU1MjU0M30.IvgT7eE_PfxRplHVkf2kXGw_sqGy07WNausqit3qskk';

export const supabase = createClient(URL, ANON);
