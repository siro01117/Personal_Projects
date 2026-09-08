'use client';

// 사이트 전체 게이트. Supabase Auth 가 유일한 판정자다 — 코드에 비밀번호도 해시도 없다.
//
// 정적 추출이라 첫 페인트는 항상 "복원 중"이다. getSession() 이 localStorage 에서 세션을
// 되살리는 동안 로그인 화면을 띄우면, 이미 로그인한 사람에게 한 번 번쩍인다. 그래서
// 복원 전에는 아무것도 단정하지 않고 조용한 대기 화면을 보여준다.
import { useEffect, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, LogIn } from 'lucide-react';
import { supabase, signIn, authErrorText } from '../../lib/supabase';

function LoginScreen() {
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const idRef = useRef(null);

  useEffect(() => { idRef.current?.focus(); }, []);

  async function submit(e) {
    e.preventDefault();
    if (busy || !id || !pw) return;
    setBusy(true);
    setErr('');
    const { error } = await signIn(id, pw);
    // 성공하면 onAuthStateChange 가 화면을 갈아끼운다 — 여기서 따로 할 일이 없다.
    if (error) {
      setErr(authErrorText(error));
      setPw('');
      setBusy(false);
    }
  }

  return (
    <div className="rk-gate">
      <form className="rk-gate-card" onSubmit={submit}>
        <div className="rk-gate-brand">Ra<i>_</i>Kan</div>
        <h1 className="rk-gate-title">로그인</h1>
        <p className="rk-gate-sub">계정이 있어야 내용을 볼 수 있습니다.</p>

        <label className="rk-lab" htmlFor="rk-id">아이디</label>
        <input
          ref={idRef} id="rk-id" className="rk-input" type="text" value={id}
          autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck="false"
          onChange={(e) => { setId(e.target.value); if (err) setErr(''); }}
        />

        <label className="rk-lab" htmlFor="rk-pw">비밀번호</label>
        <input
          id="rk-pw" className="rk-input" type="password" value={pw}
          autoComplete="current-password"
          onChange={(e) => { setPw(e.target.value); if (err) setErr(''); }}
        />

        {err && (
          <p className="rk-err" role="alert">
            <CircleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
            {err}
          </p>
        )}

        <button className="rk-btn rk-btn-fill" type="submit" disabled={busy || !id || !pw}>
          {busy
            ? <><LoaderCircle size={17} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />확인 중</>
            : <><LogIn size={17} strokeWidth={1.5} aria-hidden="true" />로그인</>}
        </button>

        <p className="rk-gate-note">이 브라우저에 로그인이 유지됩니다. 사용자 메뉴에서 로그아웃할 수 있습니다.</p>
      </form>
    </div>
  );
}

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data?.session ?? null);
      setReady(true);
    }).catch(() => { if (alive) setReady(true); });

    // 로그아웃·토큰 만료·다른 탭에서의 변화까지 여기로 들어온다.
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!alive) return;
      setSession(s ?? null);
      setReady(true);
    });
    return () => { alive = false; sub?.subscription?.unsubscribe(); };
  }, []);

  if (!ready) {
    return (
      <div className="rk-gate">
        <div className="rk-boot" role="status" aria-live="polite">
          <LoaderCircle size={20} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />
          <span>불러오는 중</span>
        </div>
      </div>
    );
  }
  if (!session) return <LoginScreen />;
  return typeof children === 'function' ? children(session) : children;
}
