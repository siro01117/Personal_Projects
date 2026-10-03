"use client";

// 관리 /admin (docs/회원.md 4장, 관리자만): 회원 표(켬/끔 · 허용 모듈은 누르면 바로) · 행을 누르면 시트(이름 · 비밀번호 · 지우기) ·
// 회원 추가(만든 뒤 아이디 · 비밀번호를 한 번 보여 준다 + 복사) · 추가 모듈 표 · 추가(이름 · https 주소, 키는 자동).
// 관리자가 아니면 "권한이 없습니다". 그릇은 플래너와 같다 — 데스크톱은 떠 있는 패널, 폰은 아래 시트.

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  linkError,
  LOGIN_ID,
  MEMBER_NAME_MAX,
  MODULE_NAME_MAX,
  moduleNameError,
  nameError,
  newMemberError,
  passwordError,
  type MemberRow,
  type ModuleRow,
} from "../../lib/members";
import { memberMenu } from "../_logic/menus";
import { useApp } from "./AppContext";
import { Icon } from "./Icon";
import { Presence } from "./motion/Presence";
import { HomeButton } from "./Shell";
import { useToast } from "./Toast";
import { toEntries, useContextMenu, type MenuBind } from "./useContextMenu";

const PHONE_MAX = 760;
const enter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229);

function useViewportWidth(): number | null {
  const [w, setW] = useState<number | null>(null);
  useEffect(() => {
    const f = () => setW(document.documentElement.clientWidth);
    f();
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return w;
}

const SEOUL = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/** 마지막 로그인: 10.04 13:20 (서울). 없으면 — */
export function lastSeen(at: string | null): string {
  if (!at) return "—";
  const p = Object.fromEntries(SEOUL.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return `${p.month}.${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

/** focus = 표 줄의 우클릭 메뉴로 열었을 때 바로 갈 칸 (지우기는 확인 단추) */
type SheetFocus = "name" | "password" | "delete";
type Panel = { kind: "add" } | { kind: "made"; login_id: string; password: string } | { kind: "member"; id: string; focus?: SheetFocus };

/** 저장소마다 지난번에 읽은 목록 (화면을 떠났다 돌아와도 바로 그리게) */
const LAST = new WeakMap<object, { members: MemberRow[]; mods: ModuleRow[] }>();

export function AdminView() {
  const { src, me, fail, reloadMe, tick } = useApp();
  const toast = useToast();
  const width = useViewportWidth();
  const phone = (width ?? 1440) <= PHONE_MAX;
  const isAdmin = me?.role === "admin";

  // 지난번에 읽은 것을 먼저 그린다 (다시 들어올 때 빈 화면을 기다리지 않게). 뒤에서 새로 읽어 바꾼다
  const kept = LAST.get(src.admin);
  const [members, setMembersState] = useState<MemberRow[] | null>(kept?.members ?? null);
  const [mods, setModsState] = useState<ModuleRow[] | null>(kept?.mods ?? null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const cm = useContextMenu();

  const setMembers = useCallback(
    (f: MemberRow[] | ((list: MemberRow[] | null) => MemberRow[] | null)) =>
      setMembersState((cur) => {
        const next = typeof f === "function" ? f(cur) : f;
        if (next) LAST.set(src.admin, { members: next, mods: LAST.get(src.admin)?.mods ?? [] });
        return next;
      }),
    [src],
  );
  const setMods = useCallback(
    (f: ModuleRow[] | ((list: ModuleRow[] | null) => ModuleRow[] | null)) =>
      setModsState((cur) => {
        const next = typeof f === "function" ? f(cur) : f;
        if (next) LAST.set(src.admin, { members: LAST.get(src.admin)?.members ?? [], mods: next });
        return next;
      }),
    [src],
  );

  // 저장 중인 고치기 수 · 고치기 차례(줄마다) · 읽기 차례 — 늦게 온 응답이 방금 누른 것을 덮지 않게
  const pending = useRef(0);
  const edits = useRef(0);
  const rowSeq = useRef(new Map<string, number>());
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    const at = edits.current;
    Promise.all([src.admin.members(), src.admin.modules()]).then(([m, d]) => {
      // 그 사이 다시 읽었거나, 읽는 동안 무언가 고쳤으면 버린다 (고친 쪽이 더 새것이다)
      if (seq !== loadSeq.current || at !== edits.current || pending.current > 0) return;
      setMembers(m);
      setMods(d);
    }, fail);
  }, [src, fail, setMembers, setMods]);

  useEffect(() => {
    // 30초마다 · 창에 돌아올 때 다시 읽는다. 저장 중이면 건너뛴다
    if (isAdmin && pending.current === 0) load();
  }, [isAdmin, load, tick]);

  /** 한 줄 고치기 (낙관적). 같은 줄을 연달아 고치면 마지막 응답만 반영한다. 실패하면 다시 읽어 되돌린다 */
  const patch = useCallback(
    (m: MemberRow, p: Partial<Pick<MemberRow, "name" | "active" | "allowed">> & { password?: string }, done?: string) => {
      const { password, ...cols } = p;
      const seq = (rowSeq.current.get(m.user_id) ?? 0) + 1;
      rowSeq.current.set(m.user_id, seq);
      edits.current++;
      pending.current++;
      setMembers((list) => list && list.map((r) => (r.user_id === m.user_id ? { ...r, ...cols } : r)));
      return src.admin
        .updateMember(m.user_id, p)
        .then(
          (row) => {
            if (rowSeq.current.get(m.user_id) === seq) setMembers((list) => list && list.map((r) => (r.user_id === row.user_id ? row : r)));
            if (done) toast(done);
            return true;
          },
          (e) => {
            fail(e);
            return false;
          },
        )
        .then((ok) => {
          pending.current--;
          if (!ok && pending.current === 0) load();
          return ok;
        });
    },
    [src, fail, load, toast, setMembers],
  );

  if (!me) return null;
  if (!isAdmin) return <p className="gone">권한이 없습니다</p>;

  const closePanel = () => setPanel(null);
  const sel = panel?.kind === "member" ? (members?.find((m) => m.user_id === panel.id) ?? null) : null;

  let content: ReactNode = null;
  let label = "";
  if (panel?.kind === "add") {
    label = "회원 추가";
    content = (
      <AddMember
        mods={mods ?? []}
        onCreate={async (input) => {
          try {
            const row = await src.admin.createMember(input);
            setMembers((list) => (list ? [...list, row] : [row]));
            setPanel({ kind: "made", login_id: row.login_id, password: input.password });
            return true;
          } catch (e) {
            fail(e);
            return false;
          }
        }}
      />
    );
  } else if (panel?.kind === "made") {
    label = "회원 추가";
    content = <Made login_id={panel.login_id} password={panel.password} onDone={closePanel} />;
  } else if (sel) {
    label = sel.login_id;
    content = (
      <MemberSheet
        key={`${sel.user_id}:${panel?.kind === "member" ? (panel.focus ?? "") : ""}`}
        m={sel}
        focus={panel?.kind === "member" ? panel.focus : undefined}
        onName={(name) => void patch(sel, { name })}
        onPassword={(password) => patch(sel, { password }, "비밀번호를 바꿨습니다")}
        onDelete={() => {
          closePanel();
          setMembers((list) => list && list.filter((r) => r.user_id !== sel.user_id));
          src.admin.deleteMember(sel.user_id).then(
            () => toast("회원을 지웠습니다"),
            (e) => {
              fail(e);
              load();
            },
          );
        }}
      />
    );
  }

  const close = (
    <button type="button" className="iconbtn pl-x" aria-label="닫기" title="닫기" onClick={closePanel}>
      <Icon name="x" />
    </button>
  );

  return (
    <div className="admin">
      <div className="ad-body">
        <section aria-label="회원">
          <div className="ad-h">
            <HomeButton />
            <h2>회원</h2>
            {members && <span className="num">{members.length}</span>}
            <button type="button" className="btn" onClick={() => setPanel({ kind: "add" })}>
              <Icon name="plus" />
              회원 추가
            </button>
          </div>
          {members && mods && (
            <MemberTable
              members={members}
              mods={mods}
              selected={sel?.user_id ?? null}
              onOpen={(m) => setPanel({ kind: "member", id: m.user_id })}
              onActive={(m) => void patch(m, { active: !m.active })}
              onAllowed={(m, key) => void patch(m, { allowed: m.allowed.includes(key) ? m.allowed.filter((k) => k !== key) : [...m.allowed, key] })}
              menu={(m) =>
                cm.bind(`member:${m.user_id}`, () =>
                  toEntries(memberMenu({ active: m.active }), (act) => {
                    if (act === "toggle") void patch(m, { active: !m.active });
                    else setPanel({ kind: "member", id: m.user_id, focus: act === "name" ? "name" : act === "password" ? "password" : "delete" });
                  }),
                )
              }
            />
          )}
        </section>
        <section aria-label="추가 모듈">
          <div className="ad-h">
            <h2>추가 모듈</h2>
          </div>
          {mods && (
            <ModuleTable
              mods={mods}
              onAdd={async (name, href) => {
                const bad = moduleNameError(name) ?? linkError(href);
                if (bad) {
                  toast(bad);
                  return false;
                }
                try {
                  const row = await src.admin.createModule({ name, href });
                  setMods((list) => (list ? [...list, row] : [row]));
                  reloadMe();
                  return true;
                } catch (e) {
                  fail(e);
                  return false;
                }
              }}
              onDelete={(d) => {
                setMods((list) => list && list.filter((x) => x.key !== d.key));
                setMembers((list) => list && list.map((m) => ({ ...m, allowed: m.allowed.filter((k) => k !== d.key) })));
                src.admin.deleteModule(d.key).then(reloadMe, (e) => {
                  fail(e);
                  load();
                });
              }}
            />
          )}
        </section>
      </div>
      <Presence>
        {!phone && content && (
          <aside className="dp pl-dp float ad-dp" aria-label={label}>
            {close}
            <div className="dp-in" key={panel?.kind === "member" ? panel.id : panel?.kind}>
              {content}
            </div>
          </aside>
        )}
      </Presence>
      <Presence>{phone && content && <div className="scrim" onClick={closePanel} />}</Presence>
      <Presence>
        {phone && content && (
          <div className="sheet" role="dialog" aria-label={label}>
            <span className="grab" />
            <div className="sh-in" key={panel?.kind === "member" ? panel.id : panel?.kind}>
              {content}
            </div>
          </div>
        )}
      </Presence>
      {cm.node}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 표
// ---------------------------------------------------------------------------

export function MemberTable({
  members,
  mods,
  selected,
  onOpen,
  onActive,
  onAllowed,
  menu,
}: {
  members: MemberRow[];
  mods: ModuleRow[];
  selected: string | null;
  onOpen: (m: MemberRow) => void;
  onActive: (m: MemberRow) => void;
  onAllowed: (m: MemberRow, key: string) => void;
  /** 줄의 우클릭 · 길게 누르기 메뉴 (docs/공통.md 2장) */
  menu?: (m: MemberRow) => MenuBind;
}) {
  if (members.length === 0) return null;
  return (
    <table className="ad-table ad-members">
      <thead>
        <tr>
          <th>아이디</th>
          <th>이름</th>
          <th>마지막 로그인</th>
          <th>활성화</th>
          <th>허용 모듈</th>
        </tr>
      </thead>
      <tbody>
        {members.map((m) => (
          <tr key={m.user_id} aria-selected={selected === m.user_id} {...menu?.(m)} onClick={() => onOpen(m)}>
            <td className="id">
              <button
                type="button"
                className="rowbtn"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(m);
                }}
              >
                {m.login_id}
              </button>
            </td>
            <td className="nm">{m.name}</td>
            <td className="last num">{lastSeen(m.last_sign_in_at)}</td>
            <td className="st">
              <button
                type="button"
                className="onoff"
                aria-pressed={m.active}
                title={m.active ? "끄기" : "켜기"}
                onClick={(e) => {
                  e.stopPropagation();
                  onActive(m);
                }}
              >
                {m.active ? "켬" : "끔"}
              </button>
            </td>
            <td className="al">
              {mods.length > 0 && (
                <div className="chips" role="group" aria-label={`${m.login_id} 허용 모듈`}>
                  {mods.map((d) => (
                    <button
                      type="button"
                      key={d.key}
                      className="chip"
                      aria-pressed={m.allowed.includes(d.key)}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAllowed(m, d.key);
                      }}
                    >
                      {d.name}
                    </button>
                  ))}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ModuleTable({
  mods,
  onAdd,
  onDelete,
}: {
  mods: ModuleRow[];
  /** 넣었으면 true — 칸을 비운다 */
  onAdd: (name: string, href: string) => Promise<boolean>;
  onDelete: (d: ModuleRow) => void;
}) {
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [href, setHref] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim() || !href.trim()) return;
    setBusy(true);
    const ok = await onAdd(name.trim(), href.trim());
    setBusy(false);
    if (ok) {
      setName("");
      setHref("");
    }
  }

  return (
    <>
      {mods.length > 0 && (
        <table className="ad-table ad-mods">
          <thead>
            <tr>
              <th>키</th>
              <th>이름</th>
              <th>주소</th>
              <th aria-label="지우기" />
            </tr>
          </thead>
          <tbody>
            {mods.map((d) => (
              <tr key={d.key}>
                <td className="key num">{d.key}</td>
                <td className="nm">{d.name}</td>
                <td className="href">
                  <a href={d.href} target="_blank" rel="noopener noreferrer">
                    {d.href}
                  </a>
                </td>
                <td className="del-c">
                  {confirmDel === d.key ? (
                    <button
                      type="button"
                      className="del"
                      autoFocus
                      onBlur={() => setConfirmDel(null)}
                      onClick={() => {
                        setConfirmDel(null);
                        onDelete(d);
                      }}
                    >
                      지우기
                    </button>
                  ) : (
                    <button type="button" className="iconbtn" aria-label={`${d.name} 지우기`} title="지우기" onClick={() => setConfirmDel(d.key)}>
                      <Icon name="trash" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="ad-add" onSubmit={add}>
        <input className="txt-in" placeholder="이름" aria-label="모듈 이름" maxLength={MODULE_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="txt-in"
          type="url"
          inputMode="url"
          placeholder="https://"
          aria-label="모듈 주소"
          autoCapitalize="none"
          spellCheck={false}
          value={href}
          onChange={(e) => setHref(e.target.value)}
        />
        <button type="submit" className="ghost" disabled={busy || !name.trim() || !href.trim()}>
          추가
        </button>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// 시트 내용
// ---------------------------------------------------------------------------

function AddMember({ mods, onCreate }: { mods: ModuleRow[]; onCreate: (input: { login_id: string; password: string; name: string; allowed: string[] }) => Promise<boolean> }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const input = { login_id: login.trim().toLowerCase(), password, name: name.trim(), allowed };
    const bad = newMemberError(input);
    if (bad) return setError(bad);
    setError(null);
    setBusy(true);
    if (!(await onCreate(input))) setBusy(false);
  }

  return (
    <form className="form ad-form" onSubmit={submit} noValidate>
      <div className="dp-h">
        <h2>회원 추가</h2>
      </div>
      <label className="ad-f">
        <span>아이디</span>
        <input
          className="txt-in"
          value={login}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={20}
          pattern={LOGIN_ID.source}
          onChange={(e) => setLogin(e.target.value)}
          autoFocus
        />
      </label>
      <label className="ad-f">
        <span>비밀번호</span>
        <input className="txt-in" value={password} autoComplete="new-password" spellCheck={false} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="ad-f">
        <span>이름</span>
        <input className="txt-in" value={name} maxLength={MEMBER_NAME_MAX} onChange={(e) => setName(e.target.value)} />
      </label>
      {mods.length > 0 && (
        <div className="ad-f">
          <span>허용 모듈</span>
          <div className="chips" role="group" aria-label="허용 모듈">
            {mods.map((d) => (
              <button
                type="button"
                key={d.key}
                className="chip"
                aria-pressed={allowed.includes(d.key)}
                onClick={() => setAllowed((a) => (a.includes(d.key) ? a.filter((k) => k !== d.key) : [...a, d.key]))}
              >
                {d.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="form-acts">
        <button type="submit" className="btn save" disabled={busy}>
          만들기
        </button>
      </div>
    </form>
  );
}

/** 만든 뒤 한 번만: 아이디 · 비밀번호 + 복사 (전달용) */
export function Made({ login_id, password, onDone }: { login_id: string; password: string; onDone: () => void }) {
  const toast = useToast();
  const text = `아이디 ${login_id}\n비밀번호 ${password}`;
  return (
    <div className="form ad-made">
      <div className="dp-h">
        <h2>만들었습니다</h2>
      </div>
      <dl>
        <dt>아이디</dt>
        <dd className="num">{login_id}</dd>
        <dt>비밀번호</dt>
        <dd className="num">{password}</dd>
      </dl>
      <div className="form-acts">
        <button
          type="button"
          className="btn save"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(
              () => toast("복사했습니다"),
              () => toast("복사하지 못했습니다. 직접 옮겨 적으세요"),
            );
          }}
        >
          <Icon name="copy" />
          복사
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          닫기
        </button>
      </div>
    </div>
  );
}

function MemberSheet({
  m,
  focus,
  onName,
  onPassword,
  onDelete,
}: {
  m: MemberRow;
  /** 열자마자 갈 칸 (표 줄의 메뉴) */
  focus?: SheetFocus;
  onName: (name: string) => void;
  /** 바꿨으면 true — 칸을 비운다 */
  onPassword: (password: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(focus === "delete");
  const nameRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus === "name") {
      nameRef.current?.focus();
      nameRef.current?.select();
    } else if (focus === "password") pwRef.current?.focus();
  }, [focus]);

  async function savePw(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const bad = passwordError(pw);
    if (bad) return toast(bad);
    setBusy(true);
    if (await onPassword(pw)) setPw("");
    setBusy(false);
  }

  return (
    <div className="form ad-form">
      <div className="dp-h">
        <h2>{m.login_id}</h2>
      </div>
      <label className="ad-f">
        <span>이름</span>
        <input
          ref={nameRef}
          className="txt-in"
          defaultValue={m.name}
          key={m.name}
          maxLength={MEMBER_NAME_MAX}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v === m.name) return;
            const bad = nameError(v);
            if (bad) {
              toast(bad);
              e.target.value = m.name;
              return;
            }
            onName(v);
          }}
          onKeyDown={(e) => enter(e) && e.currentTarget.blur()}
        />
      </label>
      <form className="ad-f ad-pw" onSubmit={savePw}>
        <span>비밀번호</span>
        <input ref={pwRef} className="txt-in" value={pw} autoComplete="new-password" spellCheck={false} placeholder="새 비밀번호" aria-label="새 비밀번호" onChange={(e) => setPw(e.target.value)} />
        <button type="submit" className="ghost" disabled={busy || pw.length === 0}>
          바꾸기
        </button>
      </form>
      <div className="form-acts">
        {confirmDel ? (
          <button type="button" className="del" autoFocus onBlur={() => setConfirmDel(false)} onClick={onDelete}>
            {m.login_id} 지우기
          </button>
        ) : (
          <button type="button" className="del" onClick={() => setConfirmDel(true)}>
            지우기
          </button>
        )}
      </div>
    </div>
  );
}
