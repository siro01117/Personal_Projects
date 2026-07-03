'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

const ADMIN_PASS = 'rakan';
const PALETTE = ['#8a7cf7', '#2dd4bf', '#e0a356', '#ef7aa7', '#7c8794', '#6aa0f7'];

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  motion: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M5 15.5l.7 1.8 1.8.7-1.8.7L5 20.5l-.7-1.8L2.5 18l1.8-.7z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18"/>',
  database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  chart: '<path d="M3 21h18M6 21v-7M11 21V6M16 21v-10"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19a1 1 0 0 1 1 1v14H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 1 2-2h14"/><path d="M8 7h8M8 10.5h6"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
  check: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  default: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
};
const Icon = ({ k }) => (<svg className="ic" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: ICONS[k] || ICONS.default }} />);
const Chevron = () => (<svg className="ic" viewBox="0 0 24 24"><path d="M5 9l7 7 7-7" /></svg>);
const Arrow = () => (<svg className="ic" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>);

const MARQ = Array(40).fill('RA_KAN' + String.fromCharCode(160).repeat(4)).join('');

function clockStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtTime(s) {
  s = Math.floor(s || 0);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}
function fmtAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return '방금';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

/* 4자리 PIN 입력 */
function PinInput({ value, onChange }) {
  const refs = useRef([]);
  const set = (i, ch) => {
    ch = (ch || '').replace(/\D/g, '').slice(-1);
    const arr = (value + '    ').slice(0, 4).split('');
    arr[i] = ch || '';
    const next = arr.join('').replace(/\s/g, '').slice(0, 4);
    onChange(next);
    if (ch && i < 3) refs.current[i + 1] && refs.current[i + 1].focus();
  };
  const onKey = (i, e) => { if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1] && refs.current[i - 1].focus(); };
  return (
    <div className="pinwrap">
      {[0, 1, 2, 3].map((i) => (
        <input key={i} ref={(el) => (refs.current[i] = el)} className="pinbox" inputMode="numeric" maxLength={1}
          value={value[i] || ''} onChange={(e) => set(i, e.target.value)} onKeyDown={(e) => onKey(i, e)} aria-label={`PIN ${i + 1}`} />
      ))}
    </div>
  );
}

export default function PortalClient({ projects = [] }) {
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [me, setMe] = useState(null);                 // 로그인 프로필
  const [guestName, setGuestName] = useState(null);
  const [modal, setModal] = useState(null);           // {name, pin, err, busy} | null
  const [welcome, setWelcome] = useState('');
  const [typing, setTyping] = useState(false);
  const [stats, setStats] = useState(null);           // admin 통계
  const [toast, setToast] = useState('');
  const [clock, setClock] = useState('');
  const gridRef = useRef(null);
  const toastT = useRef(null);
  const typeT = useRef(null);
  const sess = useRef({ name: null, last: 0, opened: 0 });

  useEffect(() => {
    setHydrated(true); setClock(clockStr());
    // 모듈 갔다가 돌아와도 로그인 유지 — 게스트였으면 게이트 없이 dock 복원
    try {
      const saved = JSON.parse(localStorage.getItem('rk_login') || 'null');
      if (localStorage.getItem('rk_mode') === 'guest' && saved && saved.name) { setMode('guest'); resolveGuest(true); }
    } catch (e) {}
    const t = setInterval(() => setClock(clockStr()), 30000);
    return () => clearInterval(t);
  }, []);

  // 체류시간 누적 flush (45초·숨김·이탈)
  function flush(extraOpen = 0) {
    const s = sess.current; if (!s.name) return;
    const secs = Math.max(0, Math.floor((Date.now() - s.last) / 1000));
    const op = s.opened + extraOpen;
    if (secs <= 0 && op <= 0) return;
    s.last = Date.now(); s.opened = 0;
    try { supabase.rpc('guest_touch', { p_name: s.name, p_seconds: secs, p_opened: op }); } catch (e) {}
  }
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    const onUnload = () => flush();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    const iv = setInterval(() => flush(), 45000);
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('beforeunload', onUnload); clearInterval(iv); flush(); };
  }, []);

  // 카드 펼침 높이
  useEffect(() => {
    const grid = gridRef.current; if (!grid) return;
    grid.querySelectorAll('.card').forEach((el) => { el.style.height = el.dataset.id === openId ? el.scrollHeight + 'px' : ''; });
  }, [openId, mode, stats]);

  // admin 통계 로드
  useEffect(() => { if (mode === 'admin') loadStats(); }, [mode]);
  async function loadStats() { try { const { data } = await supabase.rpc('guest_stats'); setStats(data || []); } catch (e) { setStats([]); } }

  function showToast(m) { setToast(m); clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(''), 1700); }

  function enter(m) {
    if (m === 'admin') {
      const pw = prompt('Admin 비밀번호');
      if (pw !== ADMIN_PASS) { if (pw !== null) alert('비밀번호가 틀렸어요'); return; }
    }
    setLeaving(true);
    setTimeout(() => { setLeaving(false); setMode(m); if (m === 'guest') resolveGuest(false); }, 400);
  }

  async function resolveGuest(silent) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('rk_login') || 'null'); } catch (e) {}
    if (saved && saved.name && saved.pin) {
      try {
        const { data } = await supabase.rpc('guest_auth', { p_name: saved.name, p_pin: saved.pin });
        const r = data && data[0];
        if (r && r.status !== 'badpin') { onLogin(saved.name, saved.pin, r, silent); return; }
        localStorage.removeItem('rk_login'); localStorage.removeItem('rk_mode');
      } catch (e) { onLogin(saved.name, saved.pin, null, silent); return; }  // 오프라인 폴백
    }
    if (silent) setMode(null); else setModal({ name: '', pin: '', err: '', busy: false });
  }

  async function doLogin() {
    const name = (modal.name || '').trim(), pin = modal.pin || '';
    if (!name || pin.length !== 4) return;
    setModal({ ...modal, busy: true, err: '' });
    try {
      const { data, error } = await supabase.rpc('guest_auth', { p_name: name, p_pin: pin });
      const r = data && data[0];
      if (error || !r) { setModal({ ...modal, busy: false, err: '연결 오류 — 잠시 후 다시' }); return; }
      if (r.status === 'badpin') { setModal({ ...modal, busy: false, pin: '', err: 'PIN이 일치하지 않아요' }); return; }
      onLogin(name, pin, r);
    } catch (e) { setModal({ ...modal, busy: false, err: '연결 오류 — 잠시 후 다시' }); }
  }

  function onLogin(name, pin, r, silent) {
    try { localStorage.setItem('rk_login', JSON.stringify({ name, pin })); localStorage.setItem('rk_mode', 'guest'); } catch (e) {}
    setGuestName(name); setMe(r); setModal(null);
    sess.current = { name, last: Date.now(), opened: 0 };
    if (!silent) typeWelcome(name);
  }
  function logout() {
    flush(); sess.current = { name: null, last: 0, opened: 0 };
    try { localStorage.removeItem('rk_login'); localStorage.removeItem('rk_mode'); } catch (e) {}
    setMe(null); setGuestName(null); setWelcome(''); setTyping(false);
    setMode(null); setOpenId(null);
  }

  function typeWelcome(name) {
    const full = `${name}님, 환영합니다`;
    let i = 0; setWelcome(''); setTyping(true); clearInterval(typeT.current);
    typeT.current = setInterval(() => {
      i++; setWelcome(full.slice(0, i));
      if (i >= full.length) { clearInterval(typeT.current); setTimeout(() => setTyping(false), 1200); }
    }, 70);
  }

  function backToGate() { flush(); setMode(null); setOpenId(null); setWelcome(''); setTyping(false); }
  function toggleCard(id) { setOpenId((p) => (p === id ? null : id)); }
  function openProject(p, e) {
    e.stopPropagation();
    if (!p.embedUrl) { showToast('아직 준비 중이에요'); return; }
    flush(1);
    setTimeout(() => { window.location.href = p.embedUrl; }, 130);
  }

  if (!hydrated) return null;
  const visible = mode === 'admin' ? projects : projects.filter((p) => p.public);
  const featured = visible[0];
  const rest = visible.slice(1);

  const card = (p, i, isFeat) => {
    const color = p.color || PALETTE[i % PALETTE.length];
    const open = openId === p.id;
    return (
      <div key={p.id} className={`card${isFeat ? ' feat' : ''}${open ? ' open' : ''}${p.public ? '' : ' muted'}`}
        style={{ '--c': color }} data-id={p.id} onClick={() => toggleCard(p.id)}>
        {!isFeat && <span className="cnum">{String(i + 1).padStart(2, '0')}</span>}
        <div className="chead">
          <div className="ctile"><Icon k={p.icon} /></div>
          {isFeat ? (
            <div className="cmeta">
              <span className="fkick"><span className="dot" />현행 · 추천</span>
              <div className="cname">{p.name}</div>
            </div>
          ) : (
            <div className="cname">{p.name}{!p.public && <span className="badge priv">private</span>}</div>
          )}
          <span className="cexp"><Chevron /></span>
        </div>
        <div className="cbody">
          {p.desc && <div className="cdesc">{p.desc}</div>}
          {p.stack && p.stack.length > 0 && <div className="cchips">{p.stack.map((s) => <span key={s}>{s}</span>)}</div>}
          <button className="enterbtn" onClick={(e) => openProject(p, e)}>진입 <Arrow /></button>
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      <header className="head">
        <div className="wrap">
          <div className="brand" onClick={backToGate}>Ra_<b>Kan</b></div>
          <div className="hr">
            {mode === 'guest' && guestName && (
              <span className="gname">{guestName}<button className="edit" onClick={logout}>로그아웃</button></span>
            )}
            {mode && <span className={'tag' + (mode === 'admin' ? ' admin' : '')}>{mode}</span>}
            <span className="mono">{clock}</span>
            {mode && <button className="back" onClick={mode === 'guest' ? logout : backToGate}>← 포털</button>}
          </div>
        </div>
      </header>

      {!mode && (
        <section className={'gate wrap' + (leaving ? ' out' : '')}>
          <div className="gkick">Personal Projects — Select Mode</div>
          <div className="mega" aria-label="Ra_Kan">
            <span className="lt" style={{ animationDelay: '.1s' }}>R</span>
            <span className="rev" style={{ animationDelay: '.72s' }}>a<span className="dim">_</span></span>
            <span className="lt" style={{ animationDelay: '.24s' }}>K</span>
            <span className="rev" style={{ animationDelay: '1s' }}>an</span>
          </div>
          <div className="modes">
            <button className="mode" style={{ '--mc': '#e9eaf0' }} onClick={() => enter('admin')}>
              <span className="mn">01</span><span className="mname">Admin</span>
              <span className="mdesc">전체 프로젝트 · 게스트 통계</span><span className="marr">→</span>
            </button>
            <button className="mode" style={{ '--mc': '#e9eaf0' }} onClick={() => enter('guest')}>
              <span className="mn">02</span><span className="mname">Guest</span>
              <span className="mdesc">이름·PIN으로 로그인 (기기 간 유지)</span><span className="marr">→</span>
            </button>
          </div>
        </section>
      )}

      {mode && (
        <section className="dock wrap in">
          <div className="gtop">
            <div>
              <div className="trow">
                <div className="gtitle">Dock</div>
                {welcome && <span className="wtype">{welcome}{typing && <i className="cw" />}</span>}
              </div>
              <div className="gsub">{visible.length}개 프로젝트 · {mode === 'admin' ? '전체' : '공개'} · 카드를 탭하면 펼쳐집니다</div>
            </div>
          </div>

          {mode === 'admin' && (
            <div className="stats">
              <div className="stats-h">게스트 통계</div>
              {!stats ? <div className="stats-empty">불러오는 중…</div>
                : stats.length === 0 ? <div className="stats-empty">아직 게스트 기록이 없어요</div>
                  : (
                    <div className="stats-list">
                      <div className="srow shead"><span className="sname">이름</span><span>체류</span><span>방문</span><span>진입</span><span className="sseen">마지막</span></div>
                      {stats.map((g) => (
                        <div className="srow" key={g.name}>
                          <span className="sname">{g.name}</span>
                          <span><b>{fmtTime(g.total_seconds)}</b></span>
                          <span>{g.visits}</span>
                          <span>{g.opened}</span>
                          <span className="sseen">{fmtAgo(g.last_seen)}</span>
                        </div>
                      ))}
                    </div>
                  )}
            </div>
          )}

          {visible.length === 0 ? <div className="empty">표시할 프로젝트가 없어요</div> : (
            <div className="grid" ref={gridRef}>
              {featured && card(featured, 0, true)}
              {rest.map((p, i) => card(p, i + 1, false))}
            </div>
          )}
        </section>
      )}

      {modal && (
        <div className="scrim">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>게스트 로그인</h3>
            <p>이름과 4자리 PIN으로 입장합니다. 처음이면 그대로 가입돼요. 같은 이름·PIN이면 다른 기기에서도 이어집니다.</p>
            <label className="fld">이름</label>
            <input className="ipt" autoFocus maxLength={16} placeholder="표시할 이름" value={modal.name}
              onChange={(e) => setModal({ ...modal, name: e.target.value, err: '' })}
              onKeyDown={(e) => { if (e.key === 'Enter' && modal.name.trim() && modal.pin.length === 4) doLogin(); }} />
            <label className="fld">PIN · 4자리</label>
            <PinInput value={modal.pin} onChange={(v) => setModal({ ...modal, pin: v, err: '' })} />
            {modal.err && <div className="err">{modal.err}</div>}
            <button className="btn-fill big" disabled={modal.busy || !modal.name.trim() || modal.pin.length !== 4} onClick={doLogin}>
              {modal.busy ? '확인 중…' : '입장'}
            </button>
          </div>
        </div>
      )}

      <div className="marquee"><div className="mtrack">
        <span className="mseg">{MARQ}</span><span className="mseg">{MARQ}</span>
      </div></div>

      <div className={'toast' + (toast ? ' show' : '')}>{toast}</div>
    </div>
  );
}
