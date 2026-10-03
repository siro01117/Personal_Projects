// PATCH 회원 고치기(비밀번호 · 이름 · 켬 · 허용) · DELETE 회원 지우기 (docs/회원.md 3장). 몸통은 ../handlers.ts
import { serviceClient } from "../client";
import { deleteMember, updateMember } from "../handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: RouteContext<"/api/admin/members/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return updateMember(req, serviceClient(), id);
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/admin/members/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return deleteMember(req, serviceClient(), id);
}
