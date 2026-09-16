'use client';

/* ---------------------------------------------------------------------------
   /dash — 지금 뭘 해야 하는지 판단하는 한 화면.

   목표는 하나다: **지금 뭘 해야 하는가**. 그걸 못 돕는 건 내리거나 접었다.
   - 한 항목은 한 문장. 제목+부연 두 줄로 쪼개지 않는다(문장은 lib/dash-rules.js 가 만든다)
   - 급한 정도는 색 띠가 아니라 글자 굵기·색으로 준다
   - 저장소 상태처럼 평소엔 안 봐도 되는 건 접어둔다
   - 읽기 전용. 수집기(10분)와 dash-say 가 쓰고 여기서는 읽기만 한다
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import AuthGate from '../_ui/AuthGate';
import Shell from '../_ui/Shell';
import { Empty } from '../study/parts';
import { loadDash } from '../../lib/dash';
import { findMisses, countBySeverity, ageDays, josa } from '../../lib/dash-rules';
import { addDaysISO, diffDaysISO, expand, fmtTime, todayISO } from '../../lib/plan-core';

const POLL_MS = 120000; // 수집기가 10분 주기라 그보다 촘촘하면 의미가 없다

const ago = (at, now) => {
  const d = ageDays(at, now);
  if (d == null) return '';
  if (d < 1 / 24) return '방금';
  if (d < 1) return `${Math.floor(d * 24)}시간 전`;
  return `${Math.floor(d)}일 전`;
};

// "3시간 20분 뒤" — 헤드라인 한 문장에 그대로 들어간다
const until = (mins) => {
  if (mins <= 0) return '지금';
  if (mins < 60) return `${mins}분 뒤`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}시간 ${m}분 뒤` : `${h}시간 뒤`;
};

function Section({ title, count, children }) {
  return (
    <section className="rk-ds-sec">
      <h2 className="rk-ds-h2">{title}{count != null && <span>{count}</span>}</h2>
      {children}
    </section>
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

  const horizon = useMemo(
    () => (plan ? expand(plan, [], today, addDaysISO(today, 180)) : []),
    [plan, today],
  );
  const todayOcc = useMemo(() => horizon.filter((o) => o.date === today), [horizon, today]);

  const misses = useMemo(
    () => findMisses({ snapshot, plan, occurrences: todayOcc, sessions, now, today }),
    [snapshot, plan, todayOcc, sessions, now, today],
  );

  const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const timed = todayOcc.filter((o) => !o.allDay && o.start != null).sort((a, b) => a.start - b.start);
  const current = timed.find((o) => nowMin >= o.start && nowMin < o.end);
  const next = timed.find((o) => o.start > nowMin);
  const remaining = timed.filter((o) => o.end > nowMin);

  // 7일 밖까지 포함한 약속 + 마감 있는 할 일을 한 줄짜리 목록으로 합친다
  const ahead = useMemo(() => {
    const rows = horizon
      .filter((o) => o.important && o.date >= today)
      .map((o) => ({ key: o.key, date: o.date, title: o.title, sub: o.place || '' }));
    for (const t of plan?.tasks || []) {
      if (t.done || !t.due || t.due < today) continue;
      rows.push({ key: `t:${t.id}`, date: t.due, title: t.title, sub: '마감' });
    }
    return rows.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 6);
  }, [horizon, plan, today]);

  const counts = countBySeverity(misses);
  const active = (sessions?.list || []).filter((s) => s.status !== 'done');

  if (state.loading) {
    return (
      <Shell session={session}>
        <div className="rk-boot" role="status" aria-live="polite">
          <LoaderCircle size={20} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />
          <span>현황을 불러오는 중</span>
        </div>
      </Shell>
    );
  }

  const headline = current
    ? `${current.title} 중입니다.`
    : next
      ? `${until(next.start - nowMin)} ${josa(next.title, '이', '가')} 있습니다.`
      : '오늘 남은 일정이 없습니다.';

  return (
    <Shell session={session}>
      <div className="rk-ds-root">
        {fixtureMode && (
          <p className="rk-ds-fixture">개발용 픽스처 화면입니다 — 실제 수집 결과가 아닙니다.</p>
        )}

        <header className="rk-ds-now">
          <h1>{headline}</h1>
          <p>
            {counts.high > 0 && <b>급한 것 {counts.high}가지</b>}
            <span>챙길 것 {misses.length} · 남은 일정 {remaining.length} · 벌여둔 일 {active.length}</span>
            <button type="button" className="rk-ds-refresh" onClick={fetchAll} aria-label="다시 읽기">
              <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </p>
        </header>

        <Section title="챙길 것" count={misses.length || null}>
          {misses.length === 0 ? (
            <Empty title="걸리는 게 없습니다" hint="마감·방치된 메모·올리지 않은 작업을 계속 보고 있습니다." />
          ) : (
            <ul className="rk-ds-list">
              {misses.map((m) => (
                <li key={m.id} className={`rk-ds-item is-${m.severity}`}>
                  <span className="rk-ds-item-t">{m.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="오늘" count={remaining.length || null}>
          {remaining.length === 0 ? (
            <Empty title="남은 일정이 없습니다" />
          ) : (
            <ul className="rk-ds-list">
              {remaining.map((o) => (
                <li key={o.key} className={'rk-ds-item' + (o === current ? ' is-live' : '')}>
                  <span className="rk-ds-at rk-num">{fmtTime(o.start)}</span>
                  <span className="rk-ds-item-t">{o.title}</span>
                  {o.place && <span className="rk-ds-item-s">{o.place}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="앞으로">
          {ahead.length === 0 ? (
            <Empty title="잡아둔 약속이 없습니다" />
          ) : (
            <ul className="rk-ds-list">
              {ahead.map((a) => {
                const d = diffDaysISO(today, a.date);
                return (
                  <li key={a.key} className="rk-ds-item">
                    <span className="rk-ds-at rk-num">{d === 0 ? '오늘' : `${d}일 뒤`}</span>
                    <span className="rk-ds-item-t">{a.title}</span>
                    {a.sub && <span className="rk-ds-item-s">{a.sub}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="벌여둔 일" count={active.length || null}>
          {active.length === 0 ? (
            <Empty title="벌여둔 일이 없습니다" hint="작업을 멈출 때 한 줄 남기면 여기 쌓입니다." />
          ) : (
            <ul className="rk-ds-list">
              {active.map((s) => (
                <li key={s.id} className="rk-ds-item">
                  <span className="rk-ds-item-t">{s.title}</span>
                  {(s.next?.[0] || s.note) && (
                    <span className="rk-ds-item-s">{s.next?.[0] ? `다음은 ${s.next[0]}` : s.note}</span>
                  )}
                  <span className="rk-ds-when rk-num">{ago(s.at, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* 평소엔 안 봐도 되는 것. 문제가 있으면 위 '챙길 것'이 이미 문장으로 말한다 */}
        <details className="rk-ds-more">
          <summary>
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
            저장소 {snapshot?.repos?.length || 0}곳
          </summary>
          <ul className="rk-ds-list">
            {(snapshot?.repos || []).map((r) => (
              <li key={r.name} className="rk-ds-item">
                <span className="rk-ds-item-t">{r.name}</span>
                <span className="rk-ds-item-s">
                  {r.lastCommit ? r.lastCommit.subject : '기록 없음'}
                </span>
                <span className="rk-ds-when rk-num">{ago(r.lastCommit?.at, now)}</span>
              </li>
            ))}
          </ul>
        </details>

        <p className="rk-ds-foot">
          {snapshot?.at ? `${ago(snapshot.at, now)}에 모은 내용입니다` : '아직 모은 내용이 없습니다'}
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
