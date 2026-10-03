// PATCH 회원 고치기(비밀번호 · 이름 · 켬 · 허용) · DELETE 회원 지우기 (docs/회원.md 3장). 몸통은 ../handlers.ts
import { serviceClient } from "../client";
import { deleteMember, updateMember } from "../handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Supabase 가 싱가포르(ap-southeast-1)에 있다 — 함수도 그 옆에서 돌려 왕복을 짧게 (기본 리전은 미국 동부라 왕복마다 0.25초씩 걸렸다)
export const preferredRegion = "sin1";

export async function PATCH(req: Request, ctx: RouteContext<"/api/admin/members/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return updateMember(req, serviceClient(), id);
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/admin/members/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return deleteMember(req, serviceClient(), id);
}
