// GET 회원 목록 · POST 회원 추가 (docs/회원.md 3장). 몸통은 handlers.ts
import { serviceClient } from "./client";
import { createMember, listMembers } from "./handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return listMembers(req, serviceClient());
}

export function POST(req: Request): Promise<Response> {
  return createMember(req, serviceClient());
}
