// 역할 (docs/플래너.md 7-11). 지점이 "어디서" 라면 역할은 "누구로서".

import type { Place, Role } from "./types";

/** 그 지점에서 기본으로 들어갈 역할. 지점이 없거나 맞는 역할이 없으면 null */
export function roleForPlace(place: Pick<Place, "role"> | null | undefined, roles: Role[]): Role | null {
  if (!place?.role) return null;
  return roles.find((r) => r.from_place === place.role) ?? null;
}
