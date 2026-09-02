'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ---------------------------------------------------------------------------
   Ra_Kan 포털 — 살아있는 색인
   왼쪽: 프로젝트 색인(행). 오른쪽: 가리키는 프로젝트의 실제 화면(iframe).
   프로젝트 목록은 lib/scan.js 가 public/projects/* 를 빌드 시점에 스캔해 넘겨준다 —
   여기서 하드코딩하는 목록은 없다.
--------------------------------------------------------------------------- */

// 관리자 비밀번호는 SHA-256 해시로만 둔다. 다만 정적 사이트라 검증이 전부 브라우저에서
// 일어난다 — 번들을 읽으면 해시가 보이고 짧은 비번은 대입으로 뚫린다. 잠금이라기보다
// "가림막"이다. 진짜 보호가 필요해지면 Supabase RPC 로 옮길 것.
const ADMIN_HASH = 'aec8e4a6445e4be673e2fcf948cfa2e759595cf43721e3edf5d78a2a4deb15ba';
const AUTH_KEY = 'rakan.admin.v1';
const AUTH_DAYS = 30;

const PALETTE = ['#8a7cf7', '#2dd4bf', '#e0a356', '#ef7aa7', '#7c8794', '#6aa0f7'];

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
  database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  chart: '<path d="M3 21h18M6 21v-7M11 21V6M16 21v-10"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19a1 1 0 0 1 1 1v14H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 1 2-2h14"/><path d="M8 7h8M8 10.5h6"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
  check: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.6-1.7"/>',
  nodes: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7l2.4 8.8M15.7 8.9L13 15.6"/>',
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

function clockStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
  const [admin, setAdmin] = useState(false);
  const [expiry, setExpiry] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [loadingPv, setLoadingPv] = useState(false);
  const [clock, setClock] = useState('');
  const [toast, setToast] = useState('');

  const frameRef = useRef(null);
  const inputRef = useRef(null);
  const hoverT = useRef(null);
  const toastT = useRef(null);

  useEffect(() => {
    setHydrated(true);
    setClock(clockStr());
    const exp = readAuth();
    if (exp) { setAdmin(true); setExpiry(exp); }
    const t = setInterval(() => setClock(clockStr()), 30000);
    return () => { clearInterval(t); clearTimeout(hoverT.current); clearTimeout(toastT.current); };
  }, []);

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
    (p) => p.color || PALETTE[Math.max(0, visible.findIndex((v) => v.id === p.id)) % PALETTE.length],
    [visible],
  );

  // 활성 항목: 아직 아무것도 안 가리켰으면 미리보기가 뜨는 첫 프로젝트를 기본값으로 —
  // 처음 열었을 때 오른쪽이 빈 안내판이면 이 화면의 요점이 안 보인다.
  // 관리자 전환으로 목록이 바뀌어 활성 항목이 사라져도 같은 기본값으로 되돌아간다.
  const canPreview = (p) => /^\/projects\//.test(p?.embedUrl || '');
  const active = visible.find((p) => p.id === activeId)
    || visible.find(canPreview) || visible[0] || null;
  const sig = active ? colorOf(active) : PALETTE[0];

  // 프리뷰는 포털이 직접 서빙하는 정적 프로젝트(/projects/*)만 띄운다.
  // 앱 라우트(/studycube-demo 등)는 브라우저 DB를 부팅해서 미리보기로 돌리기엔 무겁다.
  const previewable = canPreview(active);

  useEffect(() => { if (previewable) setLoadingPv(true); }, [active?.id, previewable]);

  // iframe 을 1280px 기준으로 그린 뒤 패널 폭에 맞춰 축소 — 모바일 레이아웃이 아닌
  // 데스크톱 화면 그대로가 보여야 미리보기의 의미가 있다.
  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const fit = () => {
      const f = el.querySelector('iframe');
      if (f) f.style.transform = `scale(${el.clientWidth / 1280})`;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el); fit();
    return () => ro.disconnect();
  }, [hydrated, previewable, active?.id]);

  function point(id) {                       // hover/focus → 잠깐 머무를 때만 프리뷰 교체
    clearTimeout(hoverT.current);
    hoverT.current = setTimeout(() => setActiveId(id), 90);
  }
  function showToast(m) {
    setToast(m); clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(''), 1800);
  }

  function openAuth() {
    if (admin) {                              // 로그아웃은 즉시 — 저장된 세션도 함께 삭제
      try { localStorage.removeItem(AUTH_KEY); } catch {}
      setAdmin(false); setExpiry(null); setActiveId(null); showToast('관리자 모드를 껐어요');
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

  // 모달: 열리면 입력으로 포커스, Esc 로 닫기
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
    <div className="app" style={{ '--sig': sig }}>
      <a className="skip" href="#index">본문으로 건너뛰기</a>

      <header className="head">
        <div className="wrap">
          <a className="brand" href="#top">Ra<i>_</i>Kan</a>
          <div className="hr">
            <span className="clock">{clock}</span>
            <button className={'lockbtn' + (admin ? ' on' : '')} onClick={openAuth}
              aria-pressed={admin}
              title={admin ? `관리자 모드 · ${daysLeft}일 남음 (누르면 해제)` : '관리자로 로그인'}>
              <Icon k={admin ? 'unlock' : 'lock'} />{admin ? 'Admin' : 'Lock'}
            </button>
          </div>
        </div>
      </header>

      <section className="mast wrap" id="top">
        <div className="eyebrow">Personal Projects</div>
        <h1 className="mega" aria-label="Ra_Kan">
          {['R', 'a', '_', 'K', 'a', 'n'].map((ch, i) => (
            <span key={i} className={'lt' + (ch === '_' ? ' us' : '')}
              style={{ animationDelay: `${0.06 * i}s` }} aria-hidden="true">{ch}</span>
          ))}
        </h1>
        <p className="lede">
          직접 만들어 쓰고 있는 것들의 <b>색인</b>입니다. 목록에서 하나를 가리키면
          오른쪽에 그 프로젝트의 <b>실제 화면</b>이 그대로 뜹니다.
        </p>
        <div className="mstats">
          <span><b>{visible.length}</b> 프로젝트</span>
          <span><b>{groups.length}</b> 분류</span>
          <span>{admin ? <>비공개 <b>{privateCount}</b>개 포함 · {daysLeft}일 유지</> : <>공개 목록{privateCount ? ` · 비공개 ${privateCount}개 숨김` : ''}</>}</span>
        </div>
      </section>

      <div className="body wrap" id="index">
        <div>
          {groups.length === 0 ? (
            <div className="empty">표시할 프로젝트가 없어요.</div>
          ) : groups.map((g) => (
            <section className="sec" key={g.key} aria-label={g.label}>
              <div className="sec-h">
                <h2 className="sec-label">{g.label}</h2>
                <span className="sec-sub">{g.sub}</span>
                <span className="sec-n">{String(g.items.length).padStart(2, '0')}</span>
              </div>
              {g.items.map((p, i) => {
                const c = colorOf(p);
                const on = active && active.id === p.id;
                const cls = 'row' + (on ? ' on' : '') + (p.public ? '' : ' muted');
                const inner = (
                  <>
                    <span className="rn">{String(i + 1).padStart(2, '0')}</span>
                    <span className="rtile"><Icon k={p.icon} /></span>
                    <span className="rmain">
                      <span className="rname">
                        {p.name}
                        {!p.public && <span className="badge priv">비공개</span>}
                      </span>
                      {p.desc && <span className="rdesc">{p.desc}</span>}
                    </span>
                    <span className="rgo"><Arrow /></span>
                  </>
                );
                return p.embedUrl ? (
                  <a key={p.id} className={cls} style={{ '--c': c }} href={p.embedUrl}
                    onMouseEnter={() => point(p.id)} onFocus={() => point(p.id)}>
                    {inner}
                  </a>
                ) : (
                  <button key={p.id} className={cls} style={{ '--c': c }} type="button"
                    onMouseEnter={() => point(p.id)} onFocus={() => point(p.id)}
                    onClick={() => showToast('아직 준비 중이에요')}>
                    {inner}
                  </button>
                );
              })}
            </section>
          ))}
        </div>

        {active && (
          <aside className="pv" aria-label="선택한 프로젝트 미리보기">
            <div ref={frameRef} className={'pvframe' + (loadingPv && previewable ? ' loading' : '')}>
              {previewable ? (
                <>
                  <iframe key={active.id} src={active.embedUrl} title={`${active.name} 미리보기`}
                    tabIndex={-1} aria-hidden="true" loading="lazy" scrolling="no"
                    onLoad={() => setLoadingPv(false)} />
                  <div className="pvfade" />
                </>
              ) : (
                <div className="pvnone">
                  <span className="big"><Icon k={active.icon} /></span>
                  직접 실행되는 앱이라 미리보기를 띄우지 않아요.<br />열기를 눌러 확인해 주세요.
                </div>
              )}
            </div>

            <div className="pvmeta">
              <div className="pvkick">{sectionOf(active)}</div>
              <div className="pvname">{active.name}</div>
              {active.desc && <p className="pvdesc">{active.desc}</p>}
              {active.stack?.length > 0 && (
                <div className="chips">{active.stack.map((s) => <span key={s}>{s}</span>)}</div>
              )}
              {active.embedUrl ? (
                <a className="pvgo" href={active.embedUrl}>열기 <Arrow /></a>
              ) : (
                <div className="pvhint">아직 화면이 없는 항목이에요.</div>
              )}
              {previewable && <div className="pvhint">미리보기는 조작되지 않아요 — 열기를 눌러 사용하세요.</div>}
            </div>
          </aside>
        )}
      </div>

      {authOpen && (
        <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setAuthOpen(false); }}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="authT" onSubmit={submitAuth}>
            <h2 id="authT">관리자로 로그인</h2>
            <p>비공개 프로젝트까지 목록에 표시됩니다.</p>
            <label className="fld" htmlFor="pw">비밀번호</label>
            <input ref={inputRef} id="pw" className="ipt" type="password" value={pw}
              autoComplete="current-password"
              onChange={(e) => { setPw(e.target.value); if (err) setErr(''); }} />
            {err && (
              <div className="err" role="alert"><Icon k="alert" />{err}</div>
            )}
            <div className="mrow">
              <button type="submit" className="btn fill" disabled={!pw || busy}>
                {busy ? '확인 중…' : '로그인'}
              </button>
              <button type="button" className="btn ghost" onClick={() => setAuthOpen(false)}>취소</button>
            </div>
            <p className="note">
              이 브라우저에서 {AUTH_DAYS}일간 로그인이 유지됩니다. 헤더의 Admin 버튼을 다시 누르면 해제돼요.
            </p>
          </form>
        </div>
      )}

      <div className={'toast' + (toast ? ' show' : '')} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}
