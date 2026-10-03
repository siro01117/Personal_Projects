// 고른 정렬과 방향을 이 기기에 기억한다 ({key, dir}) (docs/플래너.md 7-12). 플래너와 기록 표(역할 소계)가 같이 쓴다.

import { parseSort, type Sort } from "../../_logic/planner";

export const SORT_KEY = "ezwork.planner.sort";

export function readSort(): Sort {
  try {
    return parseSort(localStorage.getItem(SORT_KEY));
  } catch {
    return parseSort(null);
  }
}
