'use client';

// 비회원 둘러보기. 목록 → 액자(iframe) 두 상태뿐이고 저장하는 것은 없다.
import { useState } from 'react';
import { ArrowLeft, ExternalLink, LogIn, Presentation } from 'lucide-react';

// 새 시안을 열려면 public/demos/<이름>.html 을 넣고 여기 한 줄 추가한다.
// file 에는 **확장자를 빼고** 적는다 — Vercel 이 cleanUrls 로 .html 을 떼고 서빙해서,
// '/demos/x.html' 로 요청하면 404 가 난다.
const DEMOS = [
  {
    key: 'philosophy',
    file: '/demos/philosophy',
    name: '층 — 철학 학습기',
    desc: '하루 한 층씩 올리는 교양 학습 시안. 좌우로 밀어 단계를 넘긴다.',
    meta: 'APPTIVE 26-2 · 1팀',
    chips: ['스테이지', '스와이프', '모바일'],
  },
];

function Frame({ demo, onBack }) {
  return (
    <div className="rk-open-frame">
      <div className="rk-open-bar">
        <button type="button" className="rk-icon" onClick={onBack} aria-label="목록으로">
          <ArrowLeft size={18} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <span className="rk-open-bar-t">{demo.name}</span>
        <a className="rk-icon" href={demo.file} target="_blank" rel="noreferrer" aria-label="새 탭에서 열기">
          <ExternalLink size={17} strokeWidth={1.5} aria-hidden="true" />
        </a>
      </div>
      <iframe
        className="rk-open-iframe"
        src={demo.file}
        title={demo.name}
        loading="lazy"
        sandbox="allow-scripts"
      />
    </div>
  );
}

export default function OpenClient() {
  const [open, setOpen] = useState(null);

  if (open) return <Frame demo={open} onBack={() => setOpen(null)} />;

  return (
    <main className="rk-open">
      <header className="rk-open-head">
        <p className="rk-open-kicker">둘러보기</p>
        <h1 className="rk-open-t">로그인 없이 볼 수 있는 것</h1>
        <p className="rk-open-s">만들다 만 것도 있고 시안도 있습니다. 눌러서 직접 만져보세요.</p>
      </header>

      <ul className="rk-open-list">
        {DEMOS.map((d) => (
          <li key={d.key}>
            <button type="button" className="rk-open-card" onClick={() => setOpen(d)}>
              <span className="rk-open-ico" aria-hidden="true">
                <Presentation size={19} strokeWidth={1.5} />
              </span>
              <span className="rk-open-body">
                <span className="rk-open-name">{d.name}</span>
                <span className="rk-open-desc">{d.desc}</span>
                <span className="rk-open-chips">
                  {d.chips.map((c) => <span key={c} className="rk-tag">{c}</span>)}
                </span>
              </span>
              <span className="rk-open-meta">{d.meta}</span>
            </button>
          </li>
        ))}
      </ul>

      <footer className="rk-open-foot">
        <a className="rk-btn" href="/">
          <LogIn size={16} strokeWidth={1.5} aria-hidden="true" />로그인 화면으로
        </a>
        <p className="rk-open-note">여기 있는 화면은 저장하거나 전송하는 것이 없습니다.</p>
      </footer>
    </main>
  );
}
