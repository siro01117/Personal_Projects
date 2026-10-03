// 역할 필터에서 끈 열쇠들을 이 기기에 기억한다 (docs/플래너.md 7-14). 플래너와 작업대 가져오기가 같이 쓴다.

import { parseRoleOff } from "../../_logic/planner";

export const ROLE_OFF_KEY = "ezwork.planner.roles";

export function readRoleOff(): string[] {
  try {
    return parseRoleOff(localStorage.getItem(ROLE_OFF_KEY));
  } catch {
    return [];
  }
}
