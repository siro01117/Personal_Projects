"use client";

// 설정 /settings/agent — 에이전트 연결 (docs/에이전트-연결.md 3장). 회원 · 관리자 모두.
// 토큰 목록(이름 · 끝 4자 · 범위 · 마지막 사용 · 폐기) + 만들기(이름 · 범위) + 만든 직후 한 번만 보이는 상자(명령 한 줄 복사 · 주소 / 토큰 따로 복사).
// 원문은 이 화면의 상태에만 잠깐 있다 — 닫거나 떠나면 다시 볼 수 없다. 폐기는 확인 한 번(단추를 한 번 더).

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { connectCommand, mcpUrl, SCOPE_LABEL, tailLabel, TOKEN_NAME_MAX, tokenNameError, type MadeToken, type TokenRow, type TokenScope } from "../../lib/tokens";
import { seenAgo } from "../_logic/views";
import { useApp } from "./AppContext";
import { Icon } from "./Icon";
import { HomeButton } from "./Shell";
import { ThemeToggle } from "./ThemeToggle";
import { useToast } from "./Toast";

const SCOPES: TokenScope[] = ["rw", "ro"];

/** 저장소마다 지난번에 읽은 목록 (다시 들어올 때 바로 그리게) */
const LAST = new WeakMap<object, TokenRow[]>();

export function AgentSettings() {
  const { src, fail, tick } = useApp();
  const toast = useToast();
  const [rows, setRowsState] = useState<TokenRow[] | null>(() => LAST.get(src.tokens) ?? null);
  const [made, setMade] = useState<MadeToken | null>(null);
  const [origin, setOrigin] = useState("");
  /** 고친 횟수 — 읽는 동안 고쳤으면 늦게 온 목록을 버린다 */
  const edits = useRef(0);

  const setRows = useCallback(
    (f: (cur: TokenRow[] | null) => TokenRow[] | null) =>
      setRowsState((cur) => {
        const next = f(cur);
        if (next) LAST.set(src.tokens, next);
        return next;
      }),
    [src],
  );

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    let alive = true;
    const at = edits.current;
    src.tokens.list().then((list) => alive && at === edits.current && setRows(() => list), fail);
    return () => {
      alive = false;
    };
  }, [src, fail, tick, setRows]);

  async function create(name: string, scope: TokenScope): Promise<boolean> {
    const bad = tokenNameError(name);
    if (bad) {
      toast(bad);
      return false;
    }
    try {
      const t = await src.tokens.create(name.trim(), scope);
      edits.current++;
      const { token: _token, ...row } = t;
      setRows((cur) => [...(cur ?? []), row]);
      setMade(t);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  function revoke(row: TokenRow) {
    edits.current++;
    setRows((cur) => cur && cur.filter((r) => r.id !== row.id));
    if (made?.id === row.id) setMade(null);
    src.tokens.revoke(row.id).then(
      () => toast("폐기했습니다"),
      (e) => {
        fail(e);
        edits.current++;
        src.tokens.list().then((list) => setRows(() => list), fail);
      },
    );
  }

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast("복사했습니다"),
      () => toast("복사하지 못했습니다. 직접 옮겨 적으세요"),
    ) ?? toast("복사하지 못했습니다. 직접 옮겨 적으세요");

  return (
    <div className="agent">
      <div className="bar-top">
        <HomeButton />
        <h1>에이전트 연결</h1>
        <span className="grow" />
        <ThemeToggle />
      </div>
      <div className="ag-body">
        <section aria-label="토큰">
          {made && <MadeBox t={made} origin={origin} onCopy={copy} onClose={() => setMade(null)} />}
          {rows && <TokenList rows={rows} now={new Date()} onRevoke={revoke} />}
          {rows && <NewToken onCreate={create} />}
        </section>
      </div>
    </div>
  );
}

/** 만든 직후 한 번만: 붙여 넣을 명령 한 줄 + 주소 · 토큰 따로 */
export function MadeBox({ t, origin, onCopy, onClose }: { t: MadeToken; origin: string; onCopy: (text: string) => void; onClose: () => void }) {
  const command = connectCommand(origin, t.token);
  return (
    <div className="ag-made" role="group" aria-label={`${t.name} 연결`}>
      <div className="ag-made-h">
        <b>{t.name}</b>
        <button type="button" className="iconbtn" aria-label="닫기" title="닫기" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="ag-cmd">
        <code>{command}</code>
        <button type="button" className="btn" onClick={() => onCopy(command)}>
          <Icon name="copy" />
          복사
        </button>
      </div>
      <p>터미널에 붙여 넣으세요</p>
      <p>이 창을 닫으면 다시 볼 수 없습니다</p>
      <div className="ag-made-acts">
        <button type="button" className="ghost" onClick={() => onCopy(mcpUrl(origin))}>
          주소 복사
        </button>
        <button type="button" className="ghost" onClick={() => onCopy(t.token)}>
          토큰 복사
        </button>
      </div>
    </div>
  );
}

export function TokenList({ rows, now, onRevoke }: { rows: TokenRow[]; now: Date; onRevoke: (row: TokenRow) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  if (rows.length === 0) return null;
  return (
    <ul className="ag-list">
      {rows.map((r) => (
        <li key={r.id}>
          <span className="nm">{r.name}</span>
          <span className="tail num">{tailLabel(r.tail)}</span>
          <span className="sc">{SCOPE_LABEL[r.scope]}</span>
          <span className="last">{r.last_used_at ? seenAgo(r.last_used_at, now) : "—"}</span>
          {confirm === r.id ? (
            <button
              type="button"
              className="del sure"
              autoFocus
              onBlur={() => setConfirm(null)}
              onClick={() => {
                setConfirm(null);
                onRevoke(r);
              }}
            >
              폐기 확인
            </button>
          ) : (
            <button type="button" className="del" aria-label={`${r.name} 폐기`} onClick={() => setConfirm(r.id)}>
              폐기
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function NewToken({ onCreate }: { onCreate: (name: string, scope: TokenScope) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<TokenScope>("rw");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    const ok = await onCreate(name, scope);
    setBusy(false);
    if (ok) {
      setName("");
      setScope("rw");
    }
  }

  return (
    <form className="ag-new" onSubmit={submit}>
      <input className="txt-in" placeholder="집 노트북" aria-label="토큰 이름 (어디서 쓰는지)" maxLength={TOKEN_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="seg" role="group" aria-label="범위">
        {SCOPES.map((s) => (
          <button type="button" key={s} aria-pressed={scope === s} onClick={() => setScope(s)}>
            {SCOPE_LABEL[s]}
          </button>
        ))}
      </div>
      <button type="submit" className="btn" disabled={busy || !name.trim()}>
        <Icon name="plus" />
        토큰 만들기
      </button>
    </form>
  );
}
