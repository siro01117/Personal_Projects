"use client";

// 쓸 수 없는 계정 (docs/회원.md 1장): 관리자도 회원도 아니거나(옛 계정 등) 관리자가 끈 회원. 문구 하나 + 로그아웃.

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Source } from "../_data/types";
import { ThemeToggle } from "./ThemeToggle";

export const BLOCKED_MESSAGE = "이 계정은 쓸 수 없습니다";

export function Blocked({ src }: { src: Source }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <div className="app">
      <div className="corner-tools">
        <ThemeToggle />
      </div>
      <main className="login view">
        <div className="blocked" role="alert">
          <span className="logo">
            EZ<b>.</b>WORK
          </span>
          <p>{BLOCKED_MESSAGE}</p>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void src.auth.signOut().finally(() => router.replace("/login"));
            }}
          >
            로그아웃
          </button>
        </div>
      </main>
    </div>
  );
}
