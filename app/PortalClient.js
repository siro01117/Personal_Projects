'use client';

import { useEffect, useRef, useState } from 'react';

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
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.6-1.7"/>',
  nodes: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7l2.4 8.8M15.7 8.9L13 15.6"/>',
  default: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
};
const Icon = ({ k }) => (<svg className="ic" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: ICONS[k] || ICONS.default }} />);
const Chevron = () => (<svg className="ic" viewBox="0 0 24 24"><path d="M5 9l7 7 7-7" /></svg>);
const Arrow = () => (<svg className="ic" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>);

const MARQ = Array(40).fill('RA_KAN' + String.fromCharCode(160).repeat(4)).join('');

const SECTIONS = [
  { key: 'Personal', label: 'Personal', sub: '개인 도구' },
  { key: 'Display', label: 'Display', sub: '디자인 · 레퍼런스' },
  { key: 'Study', label: 'Study', sub: '학습' },
];
const sectionOf = (p) => (SECTIONS.some((s) => s.key === p.section) ? p.section : 'Study');

function clockStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function PortalClient({ projects = [] }) {
  const [hydrated, setHydrated] = useState(false);
  const [entered, setEntered] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState('');
  const [clock, setClock] = useState('');
  const dockRef = useRef(null);
  const toastT = useRef(null);

  useEffect(() => {
    setHydrated(true); setClock(clockStr());
    const t = setInterval(() => setClock(clockStr()), 30000);
    return () => clearInterval(t);
  }, []);

  // 카드 펼침 높이
  useEffect(() => {
    const dock = dockRef.current; if (!dock) return;
    dock.querySelectorAll('.card').forEach((el) => { el.style.height = el.dataset.id === openId ? el.scrollHeight + 'px' : ''; });
  }, [openId, entered, admin]);

  function showToast(m) { setToast(m); clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(''), 1700); }
  function enter() { setLeaving(true); setTimeout(() => { setLeaving(false); setEntered(true); }, 400); }
  function backToGate() { setEntered(false); setOpenId(null); }
  function toggleAdmin() {
    if (admin) { setAdmin(false); setOpenId(null); return; }
    const pw = prompt('Admin 비밀번호');
    if (pw == null) return;
    if (pw === ADMIN_PASS) setAdmin(true); else alert('비밀번호가 틀렸어요');
  }
  function toggleCard(id) { setOpenId((p) => (p === id ? null : id)); }
  function openProject(p, e) {
    e.stopPropagation();
    if (!p.embedUrl) { showToast('아직 준비 중이에요'); return; }
    setTimeout(() => { window.location.href = p.embedUrl; }, 130);
  }

  if (!hydrated) return null;
  const visible = admin ? projects : projects.filter((p) => p.public);
  const groups = SECTIONS
    .map((s) => ({ ...s, items: visible.filter((p) => sectionOf(p) === s.key) }))
    .filter((g) => g.items.length);

  const card = (p, i) => {
    const color = p.color || PALETTE[i % PALETTE.length];
    const open = openId === p.id;
    return (
      <div key={p.id} className={`card${open ? ' open' : ''}${p.public ? '' : ' muted'}`}
        style={{ '--c': color }} data-id={p.id} onClick={() => toggleCard(p.id)}>
        <div className="chead">
          <div className="ctile"><Icon k={p.icon} /></div>
          <div className="cname">{p.name}{!p.public && <span className="badge priv">private</span>}</div>
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
            {entered && (
              <button className={'lockbtn' + (admin ? ' on' : '')} onClick={toggleAdmin} title={admin ? '관리자 해제' : '관리자'}>
                <Icon k={admin ? 'unlock' : 'lock'} />{admin ? 'Admin' : ''}
              </button>
            )}
            <span className="mono">{clock}</span>
          </div>
        </div>
      </header>

      {!entered && (
        <section className={'gate wrap' + (leaving ? ' out' : '')}>
          <div className="gkick">Personal Projects</div>
          <div className="mega" aria-label="Ra_Kan">
            <span className="lt" style={{ animationDelay: '.1s' }}>R</span>
            <span className="rev" style={{ animationDelay: '.72s' }}>a<span className="dim">_</span></span>
            <span className="lt" style={{ animationDelay: '.24s' }}>K</span>
            <span className="rev" style={{ animationDelay: '1s' }}>an</span>
          </div>
          <button className="enter1" onClick={enter}><span className="mname">Enter</span><span className="marr">→</span></button>
        </section>
      )}

      {entered && (
        <section className="dock wrap in" ref={dockRef}>
          <div className="gtop">
            <div>
              <div className="gtitle">Dock</div>
              <div className="gsub">{visible.length}개 프로젝트 · {admin ? '전체' : '공개'} · 카드를 탭하면 펼쳐집니다</div>
            </div>
          </div>

          {groups.length === 0 ? <div className="empty">표시할 프로젝트가 없어요</div> : (
            groups.map((g) => (
              <div className="secg" key={g.key}>
                <div className="sec-h">
                  <span className="sec-label">{g.label}</span>
                  <span className="sec-sub">{g.sub}</span>
                  <span className="sec-n">{g.items.length}</span>
                </div>
                <div className="grid">{g.items.map((p, i) => card(p, i))}</div>
              </div>
            ))
          )}
        </section>
      )}

      <div className="marquee"><div className="mtrack">
        <span className="mseg">{MARQ}</span><span className="mseg">{MARQ}</span>
      </div></div>

      <div className={'toast' + (toast ? ' show' : '')}>{toast}</div>
    </div>
  );
}
