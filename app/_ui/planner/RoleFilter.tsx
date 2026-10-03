"use client";

// 역할 필터 (docs/플래너.md 7-14): 정렬 줄 아래 둘째 단. 역할마다 칩(여럿 켜고 끔) + 맨 뒤 '역할 없음' + 역할 편집 연필.
// 켠 칩은 정렬 칩의 선택 모양, 끈 칩은 글자만 흐리게. 누르면 바로 걸러진다.

import type { Role } from "../../../lib/schedule";
import { NO_ROLE, NONE_LABEL } from "../../_logic/planner";
import { Icon } from "../Icon";

export function RoleFilter({
  roles,
  off,
  onToggle,
  editing,
  onEdit,
}: {
  roles: Role[];
  off: readonly string[];
  onToggle: (key: string, on: boolean) => void;
  /** 역할 편집이 열려 있나 */
  editing: boolean;
  onEdit: () => void;
}) {
  const chips = [...roles.map((r) => ({ key: r.id, name: r.name })), { key: NO_ROLE, name: `역할 ${NONE_LABEL}` }];
  return (
    <div className="pl-sort pl-roles" role="group" aria-label="보일 역할">
      {chips.map((c) => {
        const on = !off.includes(c.key);
        return (
          <button type="button" key={c.key} className="rf" aria-pressed={on} onClick={() => onToggle(c.key, !on)}>
            {c.name}
          </button>
        );
      })}
      <button type="button" className="iconbtn rf-edit" aria-label="역할 편집" title="역할 편집" aria-expanded={editing} onClick={onEdit}>
        <Icon name="pen" />
      </button>
    </div>
  );
}
