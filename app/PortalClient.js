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
  default: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
};
const Icon = ({ k }) => (
  <svg className="ic" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: ICONS[k] || ICONS.default }} />
);
const Chevron = () => (<svg className="ic" viewBox="0 0 24 24"><path d="M5 9l7 7 7-7" /></svg>);
const Arrow = () => (<svg className="ic" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>);

const MARQ = Array(40).fill('RA_KAN' + String.fromCharCode(160).repeat(4)).join('    ');

function clockStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 게스트 ID(쿠키) + 이름(Supabase, 실패 시 localStorage 폴백) ---------- */
function getGuestId() {
  const m = document.cookie.match(/(?:^|; )rk_guest=([^;]+)/);
  if (m) return m[1];
  const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'g' + Date.now() + Math.random().toString(36).slice(2);
  document.cookie = `rk_guest=${id}; path=/; max-age=${60 * 60 * 24 * 365 * 3}; samesite=lax`;
  return id;
}
async function fetchName(id) {
  try {
    const { data } = await supabase.from('guests').select('name').eq('id', id).maybeSingle();
    if (data && data.name) { localStorage.setItem('rk_guest_name', data.name); return data.name; }
  } catch (e) {}
  return localStorage.getItem('rk_guest_name') || null;
}
async function saveName(id, name) {
  localStorage.setItem('rk_guest_name', name);
  try { await supabase.from('guests').upsert({ id, name, updated_at: new Date().toISOString() }); } catch (e) {}
}

export default function PortalClient({ projects = [] }) {
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [guestName, setGuestName] = useState(null);
  const [modal, setModal] = useState({ open: false, kind: '', value: '' });
  const [welcome, setWelcome] = useState('');   // 타이핑되는 현재 텍스트
  const [typing, setTyping] = useState(false);
  const [toast, setToast] = useState('');
  const [clock, setClock] = useState('');
  const gridRef = useRef(null);
  const toastT = useRef(null);
  const typeT = useRef(null);

  useEffect(() => {
    setHydrated(true); setClock(clockStr());
    const t = setInterval(() => setClock(clockStr()), 30000);
    return () => clearInterval(t);
  }, []);

  // 카드 펼침: 열린 카드 높이를 내용에 맞춰 애니메이션 (옆 카드는 align-items:start 로 자리 양보)
  useEffect(() => {
    const grid = gridRef.current; if (!grid) return;
    grid.querySelectorAll('.card').forEach((el) => {
      if (el.dataset.id === openId) el.style.height = el.scrollHeight + 'px';
      else el.style.height = '';
    });
  }, [openId, mode]);

  function showToast(m) { setToast(m); clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(''), 1700); }

  function enter(m) {
    if (m === 'admin') {
      const pw = prompt('Admin 비밀번호');
      if (pw !== ADMIN_PASS) { if (pw !== null) alert('비밀번호가 틀렸어요'); return; }
    }
    setLeaving(true);
    setTimeout(() => { setLeaving(false); setMode(m); if (m === 'guest') resolveGuest(); }, 400);
  }
  async function resolveGuest() {
    const id = getGuestId();
    const name = await fetchName(id);
    if (name) { setGuestName(name); typeWelcome(name); }
    else setModal({ open: true, kind: 'setup', value: '' });
  }
  function backToGate() { setMode(null); setOpenId(null); setWelcome(''); setTyping(false); clearInterval(typeT.current); }
  function typeWelcome(name) {
    const full = `${name}님, 환영합니다`;
    let i = 0; setWelcome(''); setTyping(true); clearInterval(typeT.current);
    typeT.current = setInterval(() => {
      i++; setWelcome(full.slice(0, i));
      if (i >= full.length) { clearInterval(typeT.current); setTimeout(() => setTyping(false), 1200); }
    }, 70);
  }
  function openChange() { setModal({ open: true, kind: 'change', value: guestName || '' }); }
  async function submitName() {
    const name = modal.value.trim(); if (!name) return;
    const kind = modal.kind;
    setGuestName(name); setModal({ open: false, kind: '', value: '' });
    await saveName(getGuestId(), name);
    if (kind === 'change') showToast('이름을 바꿨어요');
  }

  function toggleCard(id) { setOpenId((p) => (p === id ? null : id)); }
  function openProject(p, e) {
    e.stopPropagation();
    if (!p.embedUrl) { showToast('아직 준비 중이에요'); return; }
    window.location.href = p.embedUrl;   // 같은 탭에서 모듈로 통째 이동
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
            {mode === 'guest' && (
              <span className="gname">{guestName || '게스트'}<button className="edit" onClick={openChange}>이름 변경</button></span>
            )}
            {mode && <span className={'tag' + (mode === 'admin' ? ' admin' : '')}>{mode}</span>}
            <span className="mono">{clock}</span>
            {mode && <button className="back" onClick={backToGate}>← 포털</button>}
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
              <span className="mdesc">전체 프로젝트 (비공개 포함)</span><span className="marr">→</span>
            </button>
            <button className="mode" style={{ '--mc': '#e9eaf0' }} onClick={() => enter('guest')}>
              <span className="mn">02</span><span className="mname">Guest</span>
              <span className="mdesc">공개 프로젝트만</span><span className="marr">→</span>
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
          {visible.length === 0 ? (
            <div className="empty">표시할 프로젝트가 없어요</div>
          ) : (
            <div className="grid" ref={gridRef}>
              {featured && card(featured, 0, true)}
              {rest.map((p, i) => card(p, i + 1, false))}
            </div>
          )}
        </section>
      )}

      {modal.open && (
        <div className="scrim" onClick={() => modal.kind === 'change' && setModal({ open: false, kind: '', value: '' })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{modal.kind === 'setup' ? '환영합니다' : '이름 변경'}</h3>
            <p>{modal.kind === 'setup' ? '게스트로 입장합니다. 표시할 이름을 정해주세요. 다음부턴 저장됩니다.' : '새로 쓸 이름을 입력하세요.'}</p>
            <input autoFocus maxLength={20} placeholder="이름" value={modal.value}
              onChange={(e) => setModal({ ...modal, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') submitName(); }} />
            <div className="row">
              {modal.kind === 'change' && <button className="btn-ghost" onClick={() => setModal({ open: false, kind: '', value: '' })}>취소</button>}
              <button className="btn-fill" disabled={!modal.value.trim()} onClick={submitName}>{modal.kind === 'setup' ? '시작' : '저장'}</button>
            </div>
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
