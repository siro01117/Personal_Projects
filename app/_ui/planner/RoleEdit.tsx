"use client";

// 역할 편집 (docs/플래너.md 7-11): 이름 바꾸기(벗어날 때 저장) · 순서 · 지우기(한 번 더 눌러 확인) · 맨 아래 한 줄로 더하기(12개까지).
// 보기 · 수정과 같은 그릇(오른쪽 패널 · 떠 있는 패널 · 폰 시트)에 들어간다. from_place 는 드러내지 않는다.
// 한글 조합 중 Enter 는 무시.

import { useState, type KeyboardEvent } from "react";
import { ROLE_NAME_MAX, ROLES_MAX, type Role } from "../../../lib/schedule";
import { Icon } from "../Icon";

const enter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229);

export function RoleEdit({
  roles,
  onRename,
  onAdd,
  onMove,
  onDelete,
}: {
  /** sort 순 */
  roles: Role[];
  /** 잘못된 이름이면 false — 칸을 원래 이름으로 되돌린다 */
  onRename: (r: Role, name: string) => boolean;
  /** 넣었으면 true — 칸을 비운다 */
  onAdd: (name: string) => Promise<boolean>;
  /** i 번째를 j 번째 자리와 바꾼다 */
  onMove: (i: number, j: number) => void;
  onDelete: (r: Role) => void;
}) {
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [name, setName] = useState("");

  function remove(r: Role) {
    if (confirmDel !== r.id) {
      setConfirmDel(r.id);
      return;
    }
    setConfirmDel(null);
    onDelete(r);
  }

  return (
    <>
      <div className="dp-h">
        <h2>역할</h2>
      </div>
      <ul className="roles">
        {roles.map((r, i) => (
          <li key={r.id}>
            <input
              className="txt-in"
              defaultValue={r.name}
              key={`${r.id}:${r.name}`}
              aria-label="역할 이름"
              maxLength={ROLE_NAME_MAX}
              onBlur={(e) => {
                if (!onRename(r, e.target.value)) e.target.value = r.name;
              }}
              onKeyDown={(e) => enter(e) && e.currentTarget.blur()}
            />
            <button type="button" className="iconbtn" aria-label={`${r.name} 위로`} title="위로" disabled={i === 0} onClick={() => onMove(i, i - 1)}>
              <Icon name="up" />
            </button>
            <button type="button" className="iconbtn" aria-label={`${r.name} 아래로`} title="아래로" disabled={i === roles.length - 1} onClick={() => onMove(i, i + 1)}>
              <Icon name="down" />
            </button>
            {confirmDel === r.id ? (
              <button type="button" className="del" onClick={() => remove(r)} onBlur={() => setConfirmDel(null)} autoFocus>
                지우기
              </button>
            ) : (
              <button type="button" className="iconbtn" aria-label={`${r.name} 지우기`} title="지우기" onClick={() => remove(r)}>
                <Icon name="trash" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {roles.length < ROLES_MAX && (
        <label className="role-add">
          <Icon name="plus" />
          <input
            value={name}
            aria-label="역할 추가"
            maxLength={ROLE_NAME_MAX}
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (!enter(e)) return;
              e.preventDefault();
              void onAdd(name).then((ok) => ok && setName(""));
            }}
          />
        </label>
      )}
    </>
  );
}
