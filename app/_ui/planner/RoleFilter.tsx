"use client";

// 역할 필터 (docs/플래너.md 7-14): 역할마다 체크(여럿) + 맨 아래 '역할 없음'. 누르면 바로 걸러진다.
// 보기 · 수정과 같은 그릇(오른쪽 패널 · 떠 있는 패널 · 폰 시트)에 들어간다. 단추는 정렬 줄 오른쪽 — 하나라도 끄면 키위 점.

import type { Role } from "../../../lib/schedule";
import { NO_ROLE, NONE_LABEL } from "../../_logic/planner";
import { Icon } from "../Icon";

export function RoleFilter({ roles, off, onToggle }: { roles: Role[]; off: readonly string[]; onToggle: (key: string, on: boolean) => void }) {
  const rows = [...roles.map((r) => ({ key: r.id, name: r.name })), { key: NO_ROLE, name: `역할 ${NONE_LABEL}` }];
  return (
    <>
      <div className="dp-h">
        <h2>역할</h2>
      </div>
      <ul className="ck-list rf-list" aria-label="보일 역할">
        {rows.map((r) => {
          const on = !off.includes(r.key);
          return (
            <li key={r.key}>
              <button type="button" className={on ? "ck on" : "ck"} role="checkbox" aria-checked={on} onClick={() => onToggle(r.key, !on)}>
                <Icon name={on ? "ring-check" : "ring"} />
                <span>{r.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** 정렬 줄의 '역할' 단추. 하나라도 꺼졌으면 키위 점 */
export function RoleFilterButton({ active, open, onClick }: { active: boolean; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rf rf-role"
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={active ? "역할 (일부만 보임)" : "역할"}
      onClick={onClick}
    >
      역할
      {active && <span className="dot" aria-hidden="true" />}
    </button>
  );
}
