'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ---------------------------------------------------------------------------
   Ra_Kan 포털 v2 — 목록이 곧 화면.
   프로젝트 목록은 lib/scan.js 가 public/projects/* 를 빌드 시점에 스캔해 넘겨준다.
   (v1 의 라이브 iframe 프리뷰는 걷어냈다 — 폰에서는 보이지도 않고, 무거운 모듈은
    미리보기가 제대로 뜨지도 않아 값을 못 했다. 대신 카드를 크고 읽기 쉽게.)
--------------------------------------------------------------------------- */

// 관리자 비밀번호는 SHA-256 해시로만 둔다. 다만 정적 사이트라 검증이 전부 브라우저에서
// 일어난다 — 번들을 읽으면 해시가 보이고 짧은 비번은 대입으로 뚫린다. 잠금이라기보다
// "가림막"이다. 진짜 보호가 필요해지면 Supabase RPC 로 옮길 것.
const ADMIN_HASH = 'aec8e4a6445e4be673e2fcf948cfa2e759595cf43721e3edf5d78a2a4deb15ba';
const AUTH_KEY = 'rakan.admin.v1';
const THEME_KEY = 'rakan.theme';
const AUTH_DAYS = 30;

const PALETTE = ['#7c6cf0', '#1f9c8c', '#c07a2a', '#c8548a', '#5b7ecb', '#6a7482'];

const SECTIONS = [
  { key: 'Portfolio', label: 'Portfolio', sub: '포트폴리오' },
  { key: 'Personal', label: 'Personal', sub: '개인 도구' },
  { key: 'Display', label: 'Display', sub: '디자인 · 레퍼런스' },
  { key: 'Study', label: 'Study', sub: '학습' },
];
const sectionOf = (p) => (SECTIONS.some((s) => s.key === p.section) ? p.section : 'Study');

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  motion: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M5 15.5l.7 1.8 1.8.7-1.8.7L5 20.5l-.7-1.8L2.5 18l1.8-.7z"/>',
  chart: '<path d="M3 21h18M6 21v-7M11 21V6M16 21v-10"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19a1 1 0 0 1 1 1v14H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 1 2-2h14"/><path d="M8 7h8M8 10.5h6"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
  check: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.6-1.7"/>',
  nodes: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7l2.4 8.8M15.7 8.9L13 15.6"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2v.1"/>',
  default: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
};
const Icon = ({ k }) => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: ICONS[k] || ICONS.default }} />
);
const Arrow = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 로그인 유지 — 남은 기간이 있으면 관리자 상태를 되살린다. 만료·손상된 값은 지운다.
function readAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const { exp } = JSON.parse(raw);
    if (typeof exp !== 'number' || exp < Date.now()) { localStorage.removeItem(AUTH_KEY); return null; }
    return exp;
  } catch { return null; }
}

export default function PortalClient({ projects = [] }) {
  const [hydrated, setHydrated] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [admin, setAdmin] = useState(false);
  const [expiry, setExpiry] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const inputRef = useRef(null);
  const toastT = useRef(null);

  useEffect(() => {
    setHydrated(true);
    // 테마는 layout.js 의 인라인 스크립트가 이미 <html> 에 박아뒀다 — 여기선 읽어서 맞추기만.
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    const exp = readAuth();
    if (exp) { setAdmin(true); setExpiry(exp); }
    return () => clearTimeout(toastT.current);
  }, []);

  function showToast(m) {
    setToast(m); clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(''), 1900);
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch {}
  }

  const visible = useMemo(
    () => (admin ? projects : projects.filter((p) => p.public)),
    [admin, projects],
  );
  const groups = useMemo(
    () => SECTIONS
      .map((s) => ({ ...s, items: visible.filter((p) => sectionOf(p) === s.key) }))
      .filter((g) => g.items.length),
    [visible],
  );
  const colorOf = useCallback(
    (p, i) => p.color || PALETTE[i % PALETTE.length],
    [],
  );

  function openAuth() {
    if (admin) {                              // 로그아웃은 즉시 — 저장된 세션도 함께 삭제
      try { localStorage.removeItem(AUTH_KEY); } catch {}
      setAdmin(false); setExpiry(null); showToast('관리자 모드를 껐어요');
      return;
    }
    setPw(''); setErr(''); setAuthOpen(true);
  }

  async function submitAuth(e) {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr('');
    try {
      if ((await sha256(pw)) !== ADMIN_HASH) {
        setErr('비밀번호가 맞지 않아요. 다시 입력해 주세요.');
        setPw(''); inputRef.current?.focus();
        return;
      }
      const exp = Date.now() + AUTH_DAYS * 864e5;
      try { localStorage.setItem(AUTH_KEY, JSON.stringify({ exp })); } catch {}
      setAdmin(true); setExpiry(exp); setAuthOpen(false);
      showToast(`관리자 모드 · ${AUTH_DAYS}일간 유지됩니다`);
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!authOpen) return;
    inputRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') setAuthOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authOpen]);

  if (!hydrated) return null;

  const daysLeft = expiry ? Math.max(1, Math.ceil((expiry - Date.now()) / 864e5)) : 0;
  const privateCount = projects.length - projects.filter((p) => p.public).length;

  return (
    <div className="app">
      <a className="skip" href="#list">본문으로 건너뛰기</a>

      <header className="head">
        <div className="wrap">
          <a className="brand" href="#top">Ra<i>_</i>Kan</a>
          <div className="hr">
            <button className="iconbtn" onClick={toggleTheme}
              aria-label={theme === 'dark' ? '밝은 화면으로 바꾸기' : '어두운 화면으로 바꾸기'}>
              <Icon k={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button className={'iconbtn' + (admin ? ' on' : '')} onClick={openAuth} aria-pressed={admin}
              aria-label={admin ? `관리자 모드 · ${daysLeft}일 남음. 누르면 해제` : '관리자로 로그인'}>
              <Icon k={admin ? 'unlock' : 'lock'} />
            </button>
          </div>
        </div>
      </header>

      <section className="mast wrap" id="top">
        <div className="eyebrow">Personal Projects</div>
        <h1 className="mega">Ra<i>_</i>Kan</h1>
        <p className="lede">직접 만들어 쓰고 있는 것들. <b>눌러서 바로 들어가세요.</b></p>
        <div className="mstats">
          <span className="pill"><b>{visible.length}</b> 프로젝트</span>
          {admin
            ? <><span className="pill">비공개 <b>{privateCount}</b> 포함</span>
                <span className="pill">관리자 <b>{daysLeft}</b>일 남음</span></>
            : privateCount > 0 && <span className="pill">비공개 <b>{privateCount}</b> 숨김</span>}
        </div>
      </section>

      <main className="body wrap" id="list">
        {groups.length === 0 ? (
          <div className="empty">표시할 프로젝트가 없어요.</div>
        ) : groups.map((g) => (
          <section className="sec" key={g.key} aria-label={g.label}>
            <div className="sec-h">
              <h2 className="sec-label">{g.label}</h2>
              <span className="sec-sub">{g.sub}</span>
              <span className="sec-n">{g.items.length}</span>
            </div>
            <div className="grid">
              {g.items.map((p, i) => {
                const c = colorOf(p, i);
                const inner = (
                  <>
                    <span className="ctile"><Icon k={p.icon} /></span>
                    <span className="cmain">
                      <span className="cname">
                        {p.name}
                        {!p.public && <span className="badge priv">비공개</span>}
                      </span>
                      {p.desc && <span className="cdesc">{p.desc}</span>}
                      {p.stack?.length > 0 && (
                        <span className="chips">{p.stack.slice(0, 3).map((s) => <span key={s}>{s}</span>)}</span>
                      )}
                    </span>
                    <span className="cgo"><Arrow /></span>
                  </>
                );
                return p.embedUrl ? (
                  <a key={p.id} className="card" style={{ '--c': c }} href={p.embedUrl}>{inner}</a>
                ) : (
                  <button key={p.id} className="card" style={{ '--c': c }} type="button"
                    onClick={() => showToast('아직 준비 중이에요')}>{inner}</button>
                );
              })}
            </div>
          </section>
        ))}
      </main>

      {authOpen && (
        <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setAuthOpen(false); }}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="authT" onSubmit={submitAuth}>
            <h2 id="authT">관리자로 로그인</h2>
            <p>비공개 프로젝트까지 목록에 표시됩니다.</p>
            <label className="fld" htmlFor="pw">비밀번호</label>
            <input ref={inputRef} id="pw" className="ipt" type="password" value={pw}
              autoComplete="current-password" inputMode="text"
              onChange={(e) => { setPw(e.target.value); if (err) setErr(''); }} />
            {err && <div className="err" role="alert"><Icon k="alert" />{err}</div>}
            <div className="mrow">
              <button type="submit" className="btn fill" disabled={!pw || busy}>
                {busy ? '확인 중…' : '로그인'}
              </button>
              <button type="button" className="btn ghost" onClick={() => setAuthOpen(false)}>취소</button>
            </div>
            <p className="note">
              이 브라우저에서 {AUTH_DAYS}일간 로그인이 유지됩니다. 헤더의 자물쇠를 다시 누르면 해제돼요.
            </p>
          </form>
        </div>
      )}

      <div className={'toast' + (toast ? ' show' : '')} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}
