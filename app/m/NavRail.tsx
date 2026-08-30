"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "../home/actions";
import { SQ_IDB_NAME } from "@/lib/db";

export type NavModule = { key: string; label: string; href: string | null };

// 폰 하단 탭에 직접 노출할 개수(나머지는 '더보기' 시트).
// Material·Apple HIG 모두 하단 탭 3~5개 권장 — 여기서는 4 + 더보기 = 5.
const PRIMARY_TABS = 4;

// 데모 데이터를 지우고 새로고침 — PGlite가 idb:// 접두사로 만드는 실제 IndexedDB 이름을 정확히 지운다.
function resetDemo() {
  if (!window.confirm("이 브라우저에 저장된 데모 데이터를 모두 지우고 처음 상태로 되돌립니다. 계속할까요?")) return;
  const req = indexedDB.deleteDatabase(SQ_IDB_NAME);
  const done = () => window.location.reload();
  req.onsuccess = done;
  req.onerror = done;
  req.onblocked = done;
}

export default function NavRail({ modules, me }: { modules: NavModule[]; me: { name: string; isCto: boolean } }) {
  const path = usePathname();
  const [more, setMore] = useState(false);
  // 준비중(href 없음) 모듈은 탭 자리를 낭비하므로 폰에서는 뒤로 밀린다.
  const ready = modules.filter((m) => m.href);
  const primaryKeys = new Set(ready.slice(0, PRIMARY_TABS).map((m) => m.key));

  return (
    <nav className="nav-rail" style={S.rail}>
      <div className="rail-brand" style={S.brand} title="StudyCube">SC</div>

      {/* 데모 바 — 이 브라우저에만 저장됨을 알리고, 초기화·포털 복귀 동선을 제공 */}
      <div style={S.demoBar} title="데모 모드 — 데이터는 이 브라우저에만 저장됩니다">
        <button onClick={resetDemo} style={S.demoBtn} title="데모 데이터 초기화">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
          </svg>
        </button>
        <Link href="/" style={S.demoBtn} title="Ra_Kan으로 돌아가기">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
          </svg>
        </Link>
      </div>

      <div className="rail-list" style={S.list}>
        {modules.map((m) => {
          const isReady = !!m.href;
          const active = isReady && (path === m.href || path.startsWith(m.href + "/"));
          const body: ReactNode = (
            <>
              <span style={{ ...S.icoBox, ...(active ? S.icoOn : null) }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {ICON[m.key] ?? ICON._default}
                </svg>
              </span>
              <span style={{ ...S.lbl, ...(active ? { color: "var(--accent)", fontWeight: 700 } : null) }}>{m.label}</span>
            </>
          );
          return isReady ? (
            <Link key={m.key} className="rail-item" data-primary={primaryKeys.has(m.key) ? "1" : "0"} href={m.href!} style={S.item} title={m.label}>
              {body}
            </Link>
          ) : (
            <div key={m.key} className="rail-item" data-primary="0" style={{ ...S.item, opacity: 0.4, cursor: "default" }} title={`${m.label} · 준비중`}>
              {body}
            </div>
          );
        })}

        {/* 폰 전용 5번째 탭 — 나머지 모듈·로그아웃 */}
        <button className="rail-more" onClick={() => setMore(true)} style={{ ...S.item, border: "none", background: "transparent", cursor: "pointer" }}>
          <span style={S.icoBox}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
            </svg>
          </span>
          <span style={S.lbl}>더보기</span>
        </button>
      </div>

      {/* 더보기 시트 (폰) */}
      {more && (
        <>
          <div onClick={() => setMore(false)} style={{ position: "fixed", inset: 0, background: "rgba(10,12,18,.45)", zIndex: 40 }} />
          <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 41, background: "var(--card)", borderRadius: "18px 18px 0 0", padding: "18px 16px calc(16px + env(safe-area-inset-bottom))", maxHeight: "76dvh", overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span style={S.avatar}>{me.name.slice(0, 1)}</span>
              <span style={{ fontSize: 16, fontWeight: 800, flex: 1 }}>{me.name}</span>
              <button onClick={() => setMore(false)} style={{ width: 44, height: 44, borderRadius: 12, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--sub)", fontSize: 17, cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {modules.filter((m) => !primaryKeys.has(m.key)).map((m) => {
                const inner = (
                  <>
                    <span style={{ ...S.icoBox, width: 44, height: 40 }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICON[m.key] ?? ICON._default}</svg>
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--sub)" }}>{m.label}</span>
                  </>
                );
                const box: CSSProperties = { minHeight: 88, borderRadius: 14, border: "1px solid var(--line)", background: "var(--bg)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, textDecoration: "none" };
                return m.href
                  ? <Link key={m.key} href={m.href} onClick={() => setMore(false)} style={box}>{inner}</Link>
                  : <div key={m.key} style={{ ...box, opacity: 0.4 }}>{inner}</div>;
              })}
            </div>
            <form action={logoutAction} style={{ marginTop: 14 }}>
              <button type="submit" className="btn" style={{ height: 50, width: "100%", fontSize: 15 }}>로그아웃</button>
            </form>
          </div>
        </>
      )}

      <div className="rail-foot" style={S.foot}>
        <div style={S.avatar} title={me.name}>{me.name.slice(0, 1)}</div>
        <form action={logoutAction}>
          <button type="submit" style={S.logout} title="로그아웃">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </form>
      </div>
    </nav>
  );
}

const ICON: Record<string, ReactNode> = {
  student: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></>,
  seat: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  attendance: <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
  patrol: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  penalty: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></>,
  schedule: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
  payment: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>,
  lunch: <><path d="M3 2v7a2 2 0 0 0 2 2 2 2 0 0 0 2-2V2M5 2v20M21 15V2a5 5 0 0 0-3 5v6h3zM18 15v7" /></>,
  grade: <><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></>,
  planner: <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
  counsel: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></>,
  mentor: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 11l-3 3-1.5-1.5" /></>,
  activity: <><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></>,
  _default: <><rect x="3" y="3" width="18" height="18" rx="2" /></>,
};

const S: Record<string, CSSProperties> = {
  rail: {
    width: 78, flex: "none", alignSelf: "stretch", position: "sticky", top: 0, height: "100dvh",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
    padding: "12px 0", background: "var(--card)", borderRight: "1px solid var(--line)",
  },
  brand: {
    width: 38, height: 38, borderRadius: 11, background: "var(--accent)", color: "#fff",
    display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13, letterSpacing: ".02em", marginBottom: 8,
  },
  demoBar: {
    display: "flex", gap: 4, marginBottom: 8, paddingBottom: 8,
    borderBottom: "1px dashed var(--line)", width: "100%", justifyContent: "center",
  },
  demoBtn: {
    width: 28, height: 28, borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg)",
    color: "var(--sub)", display: "grid", placeItems: "center", cursor: "pointer", textDecoration: "none",
  },
  list: { display: "flex", flexDirection: "column", gap: 2, width: "100%", alignItems: "center", overflowY: "auto", flex: 1 },
  item: {
    width: 66, padding: "7px 0", borderRadius: 12, textDecoration: "none", color: "var(--sub)",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
  },
  icoBox: { width: 40, height: 34, borderRadius: 10, display: "grid", placeItems: "center", color: "var(--sub)" },
  icoOn: { background: "var(--accent-soft)", color: "var(--accent)" },
  lbl: { fontSize: 10.5, lineHeight: 1.15, textAlign: "center", color: "var(--faint)", maxWidth: 68 },
  foot: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginTop: 6 },
  avatar: {
    width: 34, height: 34, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent)",
    display: "grid", placeItems: "center", fontWeight: 800, fontSize: 14,
  },
  logout: {
    width: 34, height: 34, borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg)",
    color: "var(--sub)", display: "grid", placeItems: "center", cursor: "pointer",
  },
};
