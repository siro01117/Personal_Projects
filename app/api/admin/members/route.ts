// GET 회원 목록 · POST 회원 추가 (docs/회원.md 3장). 몸통은 handlers.ts
import { serviceClient } from "./client";
import { createMember, listMembers } from "./handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Supabase 가 싱가포르(ap-southeast-1)에 있다 — 함수도 그 옆에서 돌려 왕복을 짧게 (기본 리전은 미국 동부라 왕복마다 0.25초씩 걸렸다)
export const preferredRegion = "sin1";

export function GET(req: Request): Promise<Response> {
  return listMembers(req, serviceClient());
}

export function POST(req: Request): Promise<Response> {
  return createMember(req, serviceClient());
}
