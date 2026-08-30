"use client";

// 폰 전용 화면들의 좌상단 메뉴 — 뒤로가기 대신 이걸 눌러 4개 화면을 오간다.
// (폰에서는 이 네 화면만 쓴다: 좌석 / 순찰 / 순찰 기록 / 벌점)
import { useState } from "react";
import Link from "next/link";

// 데모 이식 범위: 원본은 /seat·/patrol·/records·/penalty(폰 전용 공개 라우트)를 오갔지만
// 그 라우트들은 이식 범위 밖이라 /m 아래 동등 화면으로 바꿨다(순찰 기록은 /m/patrol이 겸함).
export const MOBILE_SCREENS = [
  { href: "/m/seat", label: "좌석 배치도", desc: "누가 어디 · 입퇴실" },
  { href: "/m/patrol", label: "순찰 기록", desc: "지난 순찰 확인·정정" },
  { href: "/m/penalty", label: "벌점", desc: "이번 주 누적·부여" },
] as const;

const ICON: Record<string, React.ReactNode> = {
  "/m/seat": <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>,
  "/m/patrol": <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  "/m/penalty": <><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4M12 17h.01" /></>,
};

export default function MobileNav({ current }: { current: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="메뉴"
        style={{ width: 40, height: 40, border: "none", background: "transparent", color: "var(--sub)", display: "grid", placeItems: "center", cursor: "pointer", flex: "none" }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(10,12,18,.45)", zIndex: 60 }} />
          <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 61, background: "var(--card)", borderRadius: "18px 18px 0 0", padding: "16px 14px calc(14px + env(safe-area-inset-bottom))" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12, padding: "0 2px" }}>
              <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>화면 이동</span>
              <button onClick={() => setOpen(false)} aria-label="닫기"
                style={{ width: 40, height: 40, borderRadius: 12, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--sub)", fontSize: 16, cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {MOBILE_SCREENS.map((s) => {
                const on = s.href === current;
                return (
                  <Link key={s.href} href={s.href} onClick={() => setOpen(false)}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, minHeight: 60, padding: "0 14px",
                      borderRadius: 14, textDecoration: "none",
                      border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
                      background: on ? "var(--accent-soft)" : "var(--bg)",
                    }}>
                    <span style={{ width: 38, height: 38, borderRadius: 11, background: on ? "var(--accent)" : "var(--panel2)", color: on ? "#fff" : "var(--sub)", display: "grid", placeItems: "center", flex: "none" }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICON[s.href]}</svg>
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 15, fontWeight: on ? 800 : 700, color: on ? "var(--accent)" : "var(--ink)" }}>{s.label}</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--faint)" }}>{s.desc}</span>
                    </span>
                    {on && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent)" }}>현재</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}
