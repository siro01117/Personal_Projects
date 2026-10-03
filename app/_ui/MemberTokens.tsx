"use client";

// 관리 화면 회원 시트의 한 줄 — "토큰 n개 · 전부 폐기" (docs/에이전트-연결.md 3장). 회원이 PC 를 잃어버렸을 때 관리자가 끊는다.
// 회원을 끄면(active=false) 폐기하지 않아도 확인 함수가 막는다 — 이 줄은 그대로 살려 둔 채 끊고 싶을 때 쓴다.

import { useEffect, useState } from "react";
import { useApp } from "./AppContext";
import { useToast } from "./Toast";

export function MemberTokens({ userId }: { userId: string }) {
  const { src, fail } = useApp();
  const toast = useToast();
  const [count, setCount] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setCount(null);
    src.tokens.countOf(userId).then((n) => alive && setCount(n), fail);
    return () => {
      alive = false;
    };
  }, [src, userId, fail]);

  function revokeAll() {
    setConfirm(false);
    setBusy(true);
    src.tokens.revokeAllOf(userId).then(
      (n) => {
        setBusy(false);
        setCount(0);
        toast(`토큰 ${n}개를 폐기했습니다`);
      },
      (e) => {
        setBusy(false);
        fail(e);
      },
    );
  }

  return <MemberTokensRow count={count} confirm={confirm} busy={busy} onAsk={() => setConfirm(true)} onCancel={() => setConfirm(false)} onRevoke={revokeAll} />;
}

export function MemberTokensRow({
  count,
  confirm,
  busy,
  onAsk,
  onCancel,
  onRevoke,
}: {
  /** 아직 모르면 null */
  count: number | null;
  confirm: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onRevoke: () => void;
}) {
  return (
    <div className="ad-f ad-pw ad-tok">
      <span>토큰</span>
      <b className="num">{count === null ? "" : `${count}개`}</b>
      {count !== null && count > 0 && (
        <>
          {confirm ? (
            <button type="button" className="del" autoFocus onBlur={onCancel} onClick={onRevoke}>
              전부 폐기 확인
            </button>
          ) : (
            <button type="button" className="ghost" disabled={busy} onClick={onAsk}>
              전부 폐기
            </button>
          )}
        </>
      )}
    </div>
  );
}
