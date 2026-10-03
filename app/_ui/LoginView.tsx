"use client";

// 로그인 — 아이디 또는 이메일 + 비밀번호 (Supabase Auth 계정). @ 가 없으면 회원 아이디로 보고 <아이디>@members.ra-kan.cloud 로 보낸다
// (docs/회원.md 4장). 끝나면 원래 가려던 곳으로.

import { ThemeToggle } from "./ThemeToggle";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { loginErrorKorean } from "../../lib/errors";
import { loginEmail } from "../../lib/members";
import { useSource } from "../_data/source";
import { safeNext } from "../_logic/drawer";

export function LoginView() {
  const src = useSource();
  const router = useRouter();
  const sp = useSearchParams();
  const next = safeNext(sp.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 이미 로그인해 있으면 바로 보낸다
  useEffect(() => {
    if (!src) return;
    let alive = true;
    src.auth.signedIn().then(
      (ok) => alive && ok && router.replace(next),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [src, router, next]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!src || busy) return;
    if (!email.trim() || !password) return setError("아이디와 비밀번호를 넣으세요");
    setBusy(true);
    setError(null);
    try {
      await src.auth.signIn(loginEmail(email), password);
      router.replace(next);
    } catch (err) {
      setError(loginErrorKorean(err));
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="corner-tools"><ThemeToggle /></div>
      <main className="login view">
        <form onSubmit={submit} noValidate>
          <span className="logo">
            EZ<b>.</b>WORK
          </span>
          <input
            type="text"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="아이디 또는 이메일"
            aria-label="아이디 또는 이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            placeholder="비밀번호"
            aria-label="비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn" disabled={busy || !src}>
            로그인
          </button>
        </form>
      </main>
    </div>
  );
}
