'use client';

import { useEffect, useState } from 'react';

const ADMIN_PASS = 'rakan';   // 데모용

function Gate({ onEnter }) {
  const word = 'RA_KAN';
  return (
    <section className="gate" id="gate">
      <div className="kicker">Personal Projects — Select Mode</div>
      <h1 className="mega" aria-label="Ra_Kan">
        {word.split('').map((c, i) => (
          <span key={i} className={'l' + (c === '_' ? ' dim' : '')} style={{ animationDelay: `${0.15 + i * 0.06}s` }}>{c}</span>
        ))}
      </h1>
      <div className="modes">
        <button className="mode" style={{ animationDelay: '.5s' }} onClick={() => onEnter('admin')}>
          <span className="num mono">01</span><span className="mname">Admin</span>
          <span className="mdesc">전체 프로젝트 (비공개 포함)</span><span className="arr">→</span>
        </button>
        <button className="mode" style={{ animationDelay: '.58s' }} onClick={() => onEnter('guest')}>
          <span className="num mono">02</span><span className="mname">Guest</span>
          <span className="mdesc">공개 프로젝트만</span><span className="arr">→</span>
        </button>
      </div>
    </section>
  );
}

function clockStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function PortalClient({ projects = [] }) {
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [clock, setClock] = useState('');

  useEffect(() => {
    setHydrated(true); setClock(clockStr());
    const t = setInterval(() => setClock(clockStr()), 30000);
    return () => clearInterval(t);
  }, []);

  function enter(m) {
    if (m === 'admin') {
      const pw = prompt('Admin 비밀번호');
      if (pw !== ADMIN_PASS) { if (pw !== null) alert('비밀번호가 틀렸어요'); return; }
    }
    document.getElementById('gate')?.classList.add('out');
    setTimeout(() => setMode(m), 420);
  }
  function openProject(p) {
    if (!p.embedUrl) { alert('아직 준비 중인 프로젝트예요'); return; }
    setViewer(p);
  }

  if (!hydrated) return null;
  const visible = mode === 'admin' ? projects : projects.filter((p) => p.public);

  return (
    <div className="app">
      <div className="frame-top"></div>
      <div className="frame-bot"></div>
      <header className="head">
        <div className="brand">Ra_<b>Kan</b></div>
        <div className="head-right">
          {mode && <span className={'mode-tag' + (mode === 'admin' ? ' admin' : '')}>{mode}</span>}
          <span className="clock mono">{clock}</span>
          {mode && <button className="link-btn" onClick={() => setMode(null)}>← 포털</button>}
        </div>
      </header>

      {!mode && <Gate onEnter={enter} />}

      {mode && (
        <section className="gallery show">
          <div className="g-meta">
            <div>
              <div className="g-title">Works</div>
              <div className="g-sub">{visible.length}개 프로젝트 · {mode === 'admin' ? '전체' : '공개'}</div>
            </div>
          </div>
          <div className="list">
            {visible.length === 0 && <div className="empty-msg">표시할 프로젝트가 없어요</div>}
            {visible.map((p, i) => (
              <div key={p.id} className={'row' + (p.embedUrl ? ' clickable' : '')} style={{ animationDelay: `${0.1 + i * 0.06}s` }} onClick={() => openProject(p)}>
                <span className="rn mono">{String(i + 1).padStart(2, '0')}</span>
                <div className="r-main">
                  <div className="r-name">{p.name}
                    {mode === 'admin' && <span className={'r-badge ' + (p.public ? 'pub' : 'priv')}>{p.public ? 'public' : 'private'}</span>}
                    {!p.embedUrl && <span className="r-badge priv">준비중</span>}
                  </div>
                  {p.desc && <div className="r-desc">{p.desc}</div>}
                  {p.stack?.length > 0 && <div className="r-stack">{p.stack.map((s) => <span key={s}>{s}</span>)}</div>}
                </div>
                <span></span>
                <span className="r-arr">→</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {viewer && (
        <div className="viewer">
          <div className="viewer-bar">
            <span className="vt">{viewer.name}</span>
            <div>
              <a className="vnew" href={viewer.embedUrl} target="_blank" rel="noopener noreferrer">새 탭 ↗</a>
              <button className="vx" onClick={() => setViewer(null)}>✕</button>
            </div>
          </div>
          <iframe src={viewer.embedUrl} title={viewer.name} />
        </div>
      )}
    </div>
  );
}
