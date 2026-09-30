// DB·네트워크 오류 → 에이전트가 읽을 한국어. 매핑은 lib/errors.ts 한 곳에 있고(웹과 같이 씀),
// 여기서는 MCP 에서만 다른 말(키 거절 때 고칠 곳)만 덧붙인다.

import { toKorean as base, type KoreanError } from "../lib/errors";

export { DbError, type KoreanError } from "../lib/errors";

const AUTH_MESSAGE = "Supabase 가 키를 거절했습니다 — .env.local 의 EZ_SUPABASE_SERVICE_ROLE_KEY 를 확인하세요";

export function toKorean(err: unknown): KoreanError {
  return base(err, { authMessage: AUTH_MESSAGE });
}
