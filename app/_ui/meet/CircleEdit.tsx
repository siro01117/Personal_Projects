"use client";

// 묶음 시트 (docs/모임.md 5장): 묶음 이름(벗어날 때 저장) · 사람들(칩 + 한 칸으로 더하기) · 역할 · 지우기(한 번 더 눌러 확인) ·
// 맨 아래 한 줄로 묶음 더하기(30개까지). 보기 · 수정과 같은 그릇(오른쪽 패널 · 떠 있는 패널 · 폰 시트)에 들어간다.
// 묶음의 사람을 바꿔도 이미 만든 모임은 안 바뀐다 — 다음 모임부터. 한글 조합 중 Enter 는 무시.

import { useState, type KeyboardEvent } from "react";
import { CIRCLE_NAME_MAX, CIRCLES_MAX, MEMBERS_MAX, type Circle } from "../../../lib/meet";
import type { Role } from "../../../lib/schedule";
import { Icon } from "../Icon";

const enter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229);

export function CircleEdit({
  circles,
  roles,
  onRename,
  onMembers,
  onRole,
  onAdd,
  onDelete,
}: {
  /** 이름순 */
  circles: Circle[];
  roles: Role[];
  /** 잘못된 이름이면 false — 칸을 원래 이름으로 되돌린다 */
  onRename: (c: Circle, name: string) => boolean;
  /** 사람을 더한다(text: 쉼표로 여럿) 또는 뺀다. 더했으면 true — 칸을 비운다 */
  onMembers: (c: Circle, change: { add: string } | { remove: string }) => boolean;
  onRole: (c: Circle, roleId: string | null) => void;
  /** 넣었으면 그 묶음 id — 칸을 비우고 그 묶음을 편다 */
  onAdd: (name: string) => Promise<string | null>;
  onDelete: (c: Circle) => void;
}) {
  const [open, setOpen] = useState<string | null>(circles.length === 1 ? circles[0]!.id : null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [member, setMember] = useState("");

  function remove(c: Circle) {
    if (confirmDel !== c.id) {
      setConfirmDel(c.id);
      return;
    }
    setConfirmDel(null);
    onDelete(c);
  }

  function addMember(c: Circle) {
    if (member.trim() !== "" && onMembers(c, { add: member })) setMember("");
  }

  return (
    <>
      <div className="dp-h">
        <h2>묶음</h2>
      </div>
      <ul className="circles">
        {circles.map((c) => {
          const on = open === c.id;
          // 지운 역할을 가리키면 역할 없음으로 읽는다
          const roleId = roles.some((r) => r.id === c.role_id) ? c.role_id : null;
          return (
            <li key={c.id}>
              <div className="crow">
                <input
                  className="txt-in"
                  defaultValue={c.name}
                  key={`${c.id}:${c.name}`}
                  aria-label="묶음 이름"
                  maxLength={CIRCLE_NAME_MAX}
                  onBlur={(e) => {
                    if (!onRename(c, e.target.value)) e.target.value = c.name;
                  }}
                  onKeyDown={(e) => enter(e) && e.currentTarget.blur()}
                />
                <span className="num cnt">{c.members.length}</span>
                <button
                  type="button"
                  className="iconbtn"
                  aria-expanded={on}
                  aria-label={`${c.name} 사람들 · 역할`}
                  title="사람들 · 역할"
                  onClick={() => {
                    setOpen(on ? null : c.id);
                    setMember("");
                  }}
                >
                  <Icon name={on ? "up" : "down"} />
                </button>
                {confirmDel === c.id ? (
                  <button type="button" className="del" onClick={() => remove(c)} onBlur={() => setConfirmDel(null)} autoFocus>
                    지우기
                  </button>
                ) : (
                  <button type="button" className="iconbtn" aria-label={`${c.name} 지우기`} title="지우기" onClick={() => remove(c)}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
              {on && (
                <div className="copts">
                  {c.members.length > 0 && (
                    <div className="chips" aria-label="사람들">
                      {c.members.map((n) => (
                        <span className="chip who" key={n}>
                          {n}
                          <button type="button" aria-label={`${n} 빼기`} title="빼기" onClick={() => onMembers(c, { remove: n })}>
                            <Icon name="x" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {c.members.length < MEMBERS_MAX && (
                    <input
                      className="txt-in"
                      placeholder="사람"
                      aria-label={`${c.name} 사람 더하기`}
                      enterKeyHint="done"
                      value={member}
                      onChange={(e) => setMember(e.target.value)}
                      onKeyDown={(e) => {
                        if (!enter(e)) return;
                        e.preventDefault();
                        addMember(c);
                      }}
                    />
                  )}
                  {(roles.length > 0 || roleId !== null) && (
                    <div className="chips" role="group" aria-label="역할">
                      {roles.map((r) => (
                        <button type="button" key={r.id} className="chip" aria-pressed={roleId === r.id} onClick={() => roleId !== r.id && onRole(c, r.id)}>
                          {r.name}
                        </button>
                      ))}
                      <button type="button" className="chip" aria-pressed={roleId === null} onClick={() => roleId !== null && onRole(c, null)}>
                        없음
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {circles.length < CIRCLES_MAX && (
        <label className="role-add">
          <Icon name="plus" />
          <input
            value={name}
            aria-label="묶음 추가"
            maxLength={CIRCLE_NAME_MAX}
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (!enter(e)) return;
              e.preventDefault();
              void onAdd(name).then((id) => {
                if (id === null) return;
                setName("");
                setOpen(id);
                setMember("");
              });
            }}
          />
        </label>
      )}
    </>
  );
}
