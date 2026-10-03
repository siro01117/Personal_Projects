// 토큰 주인의 권한으로 DB 에 들어갈 때 쓰는 짧은 JWT (docs/에이전트-연결.md 2장의 (가)).
// Supabase 프로젝트의 JWT 비밀(HS256)로 서명한다 — 서버 환경변수 EZ_SUPABASE_JWT_SECRET 에만 둔다. 없으면 이 길은 쓰지 않는다.
// PostgREST 는 role 로 역할을 정하고 sub 를 auth.uid() 로 준다. 요청 하나에만 쓰므로 수명은 짧게.

import { createHmac } from "node:crypto";

export const JWT_TTL_SEC = 120;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

export function userJwt(secret: string, userId: string, now: Date = new Date(), ttlSec: number = JWT_TTL_SEC): string {
  const iat = Math.floor(now.getTime() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, role: "authenticated", aud: "authenticated", iat, exp: iat + ttlSec })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
