'use client';

/* ---------------------------------------------------------------------------
   Ra_Kan 포털 v3 — 로그인 뒤에 있는 홈.
   두 카테고리로 나뉜다: '학습'(지금 매일 쓰는 것)이 먼저, '헤리티지'(만들어 둔 것)가 뒤.
   프로젝트 목록은 lib/scan.js 가 public/projects/* 를 빌드 시점에 스캔해 넘겨준다.

   v2 의 SHA-256 관리자 토글은 걷어냈다. 해시가 번들에 그대로 실려 잠금 구실을 못 했고,
   이제 사이트 전체가 Supabase Auth 뒤에 있어 '비공개 프로젝트 숨기기'라는 개념 자체가
   필요 없다 — 여기까지 들어온 사람은 이미 로그인한 사람이다.
--------------------------------------------------------------------------- */

import { useMemo } from 'react';
import {
  Archive, ArrowRight, BookOpen, CalendarCheck, ChartNoAxesColumn, CircleCheckBig,
  GraduationCap, Grid2x2, LayoutDashboard, Layers, Sparkles, UsersRound, Utensils,
  Waypoints, Wallet, ClipboardList, MapPin, ShieldAlert,
} from 'lucide-react';
import AuthGate from './_ui/AuthGate';
import Shell from './_ui/Shell';
import { MODULE_ROUTES, MODULES } from '../lib/modules';

// 과목색 7종과 같은 팔레트를 카드 강조에도 쓴다 (globals.css 의 --s1..--s7).
const ACCENTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)'];
const accentAt = (i) => ACCENTS[i % ACCENTS.length];

// manifest 의 icon 키워드 → lucide 아이콘. 모르는 키워드는 기본값으로 떨어진다.
const PROJECT_ICONS = {
  check: CircleCheckBig, nodes: Waypoints, book: BookOpen, chart: ChartNoAxesColumn,
  grid: Grid2x2, layers: Layers, layout: LayoutDashboard, motion: Sparkles,
};
const MODULE_ICONS = {
  student: UsersRound, seat: Grid2x2, patrol: MapPin, penalty: ShieldAlert,
  schedule: CalendarCheck, lunch: Utensils, payment: Wallet, attendance: ClipboardList,
};

function Card({ href, icon: Ico, name, desc, chips, accent, badge }) {
  return (
    <a className="rk-card" href={href} style={{ '--c': accent }}>
      <span className="rk-card-ico"><Ico size={21} strokeWidth={1.5} aria-hidden="true" /></span>
      <span className="rk-card-body">
        <span className="rk-card-name">
          {name}
          {badge && <span className="rk-tag">{badge}</span>}
        </span>
        {desc && <span className="rk-card-desc">{desc}</span>}
        {chips?.length > 0 && (
          <span className="rk-chips">{chips.slice(0, 3).map((c) => <span key={c}>{c}</span>)}</span>
        )}
      </span>
      <span className="rk-card-go" aria-hidden="true"><ArrowRight size={18} strokeWidth={1.5} /></span>
    </a>
  );
}

function Home({ session, projects }) {
  // 헤리티지 — 화면이 실제로 구현된 스터디큐브 모듈만 (MODULE_ROUTES 에 있는 것).
  // 목록에만 있고 화면이 없는 모듈은 눌러도 갈 곳이 없어 카드로 만들지 않는다.
  const modules = useMemo(() => {
    const label = new Map(MODULES.map((m) => [m.key, m.label]));
    return Object.entries(MODULE_ROUTES).map(([key, href]) => ({
      key, href, name: label.get(key) || key, icon: MODULE_ICONS[key] || Layers,
    }));
  }, []);

  return (
    <Shell
      session={session}
      title="Ra_Kan"
      sub="직접 만들어 쓰는 것들. 학습이 먼저, 만들어 둔 것이 뒤."
    >
      <section className="rk-sec" aria-labelledby="sec-study">
        <div className="rk-sec-h">
          <GraduationCap size={17} strokeWidth={1.5} aria-hidden="true" />
          <h2 className="rk-sec-t" id="sec-study">학습</h2>
          <span className="rk-sec-n">1</span>
        </div>
        <div className="rk-grid">
          <Card
            href="/study"
            icon={GraduationCap}
            name="1학년 2학기"
            desc="오늘 수업 · 이번 주 · 할 일 · 과목별 진도와 시험대비."
            chips={['대시보드', '과목 상세', '시험대비']}
            accent={accentAt(4)}
          />
        </div>
      </section>

      <section className="rk-sec" aria-labelledby="sec-heritage">
        <div className="rk-sec-h">
          <Archive size={17} strokeWidth={1.5} aria-hidden="true" />
          <h2 className="rk-sec-t" id="sec-heritage">헤리티지</h2>
          <span className="rk-sec-n">{modules.length + projects.length}</span>
        </div>

        <h3 className="rk-sub-t">스터디큐브 모듈</h3>
        <div className="rk-grid is-tight">
          {modules.map((m, i) => (
            <Card key={m.key} href={m.href} icon={m.icon} name={m.name} accent={accentAt(i)} />
          ))}
        </div>

        <h3 className="rk-sub-t">프로젝트</h3>
        {projects.length === 0 ? (
          <p className="rk-empty">
            아직 프로젝트가 없습니다 — <code>public/projects/</code> 에 폴더를 추가하면 자동으로 나타납니다.
          </p>
        ) : (
          <div className="rk-grid">
            {projects.map((p, i) => (
              <Card
                key={p.id}
                href={p.embedUrl || '#'}
                icon={PROJECT_ICONS[p.icon] || Layers}
                name={p.name}
                desc={p.desc}
                chips={p.stack}
                accent={accentAt(i + 2)}
                badge={p.embedUrl ? null : '준비 중'}
              />
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}

export default function PortalClient({ projects = [] }) {
  return <AuthGate>{(session) => <Home session={session} projects={projects} />}</AuthGate>;
}
