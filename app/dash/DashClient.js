'use client';

/* ---------------------------------------------------------------------------
   /dash — 병렬로 벌여둔 작업을 한 화면에서 본다.

   읽기만 한다. 수집기(10분)가 올린 기계적 사실 + /plan 의 일정·할 일 + "여기까지"
   시점에 기록된 세션 서술을 합쳐 보여주고, "놓친 것"은 lib/dash-rules.js 가
   그 자리에서 계산한다(규칙을 고쳐도 수집기를 다시 돌릴 필요가 없다).
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CalendarDays, CircleAlert, FolderGit2, Info, LoaderCircle,
  NotebookPen, RefreshCw, Workflow,
} from 'lucide-react';
import AuthGate from '../_ui/AuthGate';
import Shell from '../_ui/Shell';
import { Empty, Notice, Tag } from '../study/parts';
import { loadDash } from '../../lib/dash';
import { findMisses, countBySeverity, ageDays } from '../../lib/dash-rules';
import { addDaysISO, expand, fmtTime, todayISO } from '../../lib/plan-core';

const POLL_MS = 120000; // 수집기가 10분 주기라 그보다 촘촘하면 의미가 없다

const SEV = {
  high: { icon: CircleAlert, label: '급함', tone: 'bad' },
  warn: { icon: AlertTriangle, label: '확인', tone: 'warn' },
  info: { icon: Info, label: '참고', tone: null },
};

const fmtAgo = (at, now) => {
  const d = ageDays(at, now);
  if (d == null) return '';
  if (d < 1 / 24) return '방금';
  if (d < 1) return `${Math.floor(d * 24)}시간 전`;
  return `${Math.floor(d)}일 전`;
};

/* ------------------------------------------------------------------ 조각 */

function MissRow({ miss, now }) {
  const s = SEV[miss.severity] || SEV.info;
  const Icon = s.icon;
  return (
    <li className={`rk-ds-miss is-${miss.severity}`}>
      <Icon size={15} strokeWidth={1.5} aria-hidden="true" />
      <div className="rk-ds-miss-body">
        <div className="rk-ds-miss-t">{miss.title}</div>
        {miss.detail && <div className="rk-ds-miss-d">{miss.detail}</div>}
      </div>
      {miss.at && <span className="rk-ds-ago rk-num">{fmtAgo(miss.at, now)}</span>}
    </li>
  );
}

function RepoRow({ repo, now }) {
  const clean = !repo.ahead && !repo.behind && !repo.dirty?.n;
  return (
    <li className="rk-ds-repo">
      <div className="rk-ds-repo-head">
        <span className="rk-ds-repo-n">{repo.name}</span>
        <span className="rk-ds-repo-b rk-num">{repo.branch}</span>
        {clean ? <Tag>깨끗</Tag> : (
          <>
            {repo.ahead > 0 && <Tag tone="warn">미푸시 {repo.ahead}</Tag>}
            {repo.behind > 0 && <Tag tone="bad">뒤처짐 {repo.behind}</Tag>}
            {repo.dirty?.n > 0 && <Tag>변경 {repo.dirty.n}</Tag>}
          </>
        )}
      </div>
      {repo.lastCommit && (
        <div className="rk-ds-repo-c">
          <span className="rk-ds-repo-s">{repo.lastCommit.subject}</span>
          <span className="rk-ds-ago rk-num">{fmtAgo(repo.lastCommit.at, now)}</span>
        </div>
      )}
    </li>
  );
}

function SessionRow({ s, now }) {
  return (
    <li className={`rk-ds-sess is-${s.status}`}>
      <div className="rk-ds-sess-head">
        <span className="rk-ds-sess-t">{s.title}</span>
        {s.repo && <span className="rk-ds-sess-r">{s.repo}</span>}
        <span className="rk-ds-ago rk-num">{fmtAgo(s.at, now)}</span>
      </div>
      {s.note && <div className="rk-ds-sess-n">{s.note}</div>}
      {s.blocked && <div className="rk-ds-sess-b">막힘 — {s.blocked}</div>}
      {s.awaiting && <div className="rk-ds-sess-a">답 대기 — {s.awaiting}</div>}
      {s.next?.length > 0 && (
        <ul className="rk-ds-sess-next">
          {s.next.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ 본체 */

function Dash({ session, fixtureMode }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [now, setNow] = useState(() => new Date().toISOString());

  const fetchAll = useCallback(async () => {
    try {
      if (fixtureMode && process.env.NODE_ENV === 'development') {
        const { buildFixture } = await import('./fixture');
        setState({ loading: false, error: null, data: buildFixture() });
      } else {
        setState({ loading: false, error: null, data: await loadDash() });
      }
    } catch (e) {
      setState((p) => ({ loading: false, error: e, data: p.data }));
    }
    setNow(new Date().toISOString());
  }, [fixtureMode]);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, POLL_MS);
    // 다른 탭·기기에서 보다가 돌아왔을 때 묵은 화면을 보여주지 않는다
    const onVis = () => { if (document.visibilityState === 'visible') fetchAll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [fetchAll]);

  const today = todayISO();
  const { snapshot, sessions, plan } = state.data || {};

  const week = useMemo(
    () => (plan ? expand(plan, [], today, addDaysISO(today, 6)) : []),
    [plan, today],
  );
  const todayOcc = useMemo(() => week.filter((o) => o.date === today), [week, today]);

  const misses = useMemo(
    () => findMisses({ snapshot, plan, occurrences: todayOcc, sessions, now, today }),
    [snapshot, plan, todayOcc, sessions, now, today],
  );
  const counts = countBySeverity(misses);
  const active = (sessions?.list || []).filter((s) => s.status !== 'done');
  const openItems = (snapshot?.vault?.openItems || []).filter((i) => !i.done);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const remaining = todayOcc.filter((o) => o.allDay || o.end == null || o.end > nowMin);

  if (state.loading) {
    return (
      <Shell session={session} wide>
        <div className="rk-boot" role="status" aria-live="polite">
          <LoaderCircle size={20} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />
          <span>현황을 불러오는 중</span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell session={session} wide>
      <div className="rk-ds-root">
        {fixtureMode && <Notice>개발용 픽스처 화면입니다 — 실제 수집 결과가 아닙니다.</Notice>}
        <div className="rk-ds-toolbar">
          <div>
            <h1 className="rk-ds-h1">현황</h1>
            <p className="rk-ds-sub">
              {counts.high > 0 && <b className="rk-ds-c-high">급함 {counts.high}</b>}
              {counts.warn > 0 && <b className="rk-ds-c-warn">확인 {counts.warn}</b>}
              <span>벌여둔 일 {active.length} · 오늘 남은 일정 {remaining.length} · 볼트 미결 {openItems.length}</span>
            </p>
          </div>
          <button type="button" className="rk-btn" onClick={fetchAll}>
            <RefreshCw size={15} strokeWidth={1.5} aria-hidden="true" />다시 읽기
          </button>
        </div>

        <section className="rk-block">
          <h2 className="rk-h2">
            <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" />놓치고 있던 것
            <span className="rk-h2-note">{misses.length}</span>
          </h2>
          {misses.length === 0 ? (
            <Empty title="걸리는 게 없습니다" hint="미푸시 커밋·방치된 미결·마감 임박·겹친 일정을 규칙으로 계속 보고 있습니다." />
          ) : (
            <ul className="rk-ds-misses">
              {misses.map((m) => <MissRow key={m.id} miss={m} now={now} />)}
            </ul>
          )}
        </section>

        <div className="rk-ds-cols">
          <section className="rk-block">
            <h2 className="rk-h2">
              <Workflow size={16} strokeWidth={1.5} aria-hidden="true" />벌여둔 일
              <span className="rk-h2-note">{active.length}</span>
            </h2>
            {active.length === 0 ? (
              <Empty title="기록된 작업 축이 없습니다" hint="작업을 멈출 때 dash-say 로 한 줄 남기면 여기 쌓입니다." />
            ) : (
              <ul className="rk-ds-sesses">
                {active.map((s) => <SessionRow key={s.id} s={s} now={now} />)}
              </ul>
            )}
          </section>

          <section className="rk-block">
            <h2 className="rk-h2">
              <FolderGit2 size={16} strokeWidth={1.5} aria-hidden="true" />저장소
              <a className="rk-h2-link" href="/plan">일정 보기</a>
            </h2>
            {!snapshot?.repos?.length ? (
              <Empty title="수집된 저장소가 없습니다" hint="scripts/dash-collect.mjs 가 도는지 확인하세요." />
            ) : (
              <ul className="rk-ds-repos">
                {snapshot.repos.map((r) => <RepoRow key={r.name} repo={r} now={now} />)}
              </ul>
            )}
          </section>

          <section className="rk-block">
            <h2 className="rk-h2">
              <CalendarDays size={16} strokeWidth={1.5} aria-hidden="true" />오늘
              <span className="rk-h2-note">{remaining.length}</span>
            </h2>
            {remaining.length === 0 ? (
              <Empty title="남은 일정이 없습니다" />
            ) : (
              <ul className="rk-ds-occs">
                {remaining.map((o) => (
                  <li key={o.key}>
                    <span className="rk-ds-occ-t rk-num">{o.allDay ? '종일' : fmtTime(o.start)}</span>
                    <span className="rk-ds-occ-n">{o.title}</span>
                    {o.place && <span className="rk-ds-occ-p">{o.place}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rk-block">
            <h2 className="rk-h2">
              <NotebookPen size={16} strokeWidth={1.5} aria-hidden="true" />볼트 미결
              <span className="rk-h2-note">{openItems.length}</span>
            </h2>
            {openItems.length === 0 ? (
              <Empty title="미결로 잡힌 항목이 없습니다" />
            ) : (
              <ul className="rk-ds-open">
                {openItems.slice(0, 12).map((i, n) => (
                  <li key={`${i.path}:${n}`}>
                    <span className="rk-ds-open-n">{i.note}</span>
                    <span className="rk-ds-open-t">{i.text}</span>
                    <span className="rk-ds-ago rk-num">{fmtAgo(i.mtime, now)}</span>
                  </li>
                ))}
              </ul>
            )}
            {openItems.length > 12 && (
              <p className="rk-ds-more">오래 방치된 것부터 12개. 나머지 {openItems.length - 12}개는 볼트에서.</p>
            )}
          </section>
        </div>

        <p className="rk-ds-foot">
          {snapshot?.at
            ? `수집 ${fmtAgo(snapshot.at, now)}${snapshot.host ? ` · ${snapshot.host}` : ''}`
            : '수집 기록 없음'}
          {state.error && ' · 마지막 불러오기 실패'}
        </p>
      </div>
    </Shell>
  );
}

export default function DashClient() {
  const [fixtureMode, setFixtureMode] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    if (new URLSearchParams(window.location.search).get('fixture') === '1') setFixtureMode(true);
  }, []);
  if (fixtureMode) return <Dash session={null} fixtureMode />;
  return <AuthGate>{(session) => <Dash session={session} />}</AuthGate>;
}
