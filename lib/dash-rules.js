/* ---------------------------------------------------------------------------
   "내가 신경 쓰지 못한 것" — 전부 규칙으로 계산한다. LLM 판단 아님.
   방치된 기간 · 상태(미푸시/미커밋) · 마감 세 축이면 대부분 잡힌다.

   순수 함수다. 입력을 주면 같은 결과가 나오고 네트워크·시계를 직접 읽지 않는다
   (now 를 인자로 받는다) — scripts/dash-selftest.mjs 가 이걸 전제로 검증한다.

   화면에서 계산하므로 규칙을 고쳐도 수집기(scripts/dash-collect.mjs)를 다시 돌릴 필요가 없다.
--------------------------------------------------------------------------- */

export const DAY = 86400000;

// 기준값을 한곳에 모은다 — 화면에서 "왜 이게 떴나" 를 설명할 때도 이 숫자를 쓴다
export const T = {
  snapshotStaleMin: 30,   // 수집기가 이만큼 안 돌면 대시보드 자체를 믿을 수 없다
  unpushedWarnDays: 1,
  unpushedHighDays: 4,
  dirtyWarnDays: 1,
  staleOpenDays: 14,      // 볼트 미결이 이만큼 손 안 닿으면 방치로 본다
  staleSessionDays: 2,
  dueSoonDays: 2,
};

const ms = (a, b) => new Date(a).getTime() - new Date(b).getTime();
const daysBetween = (a, b) => ms(a, b) / DAY;
export const ageDays = (at, now) => (at ? daysBetween(now, at) : null);

const fmtAge = (d) => {
  if (d == null) return '';
  if (d < 1) { const h = Math.floor(d * 24); return h < 1 ? '방금' : `${h}시간째`; }
  return `${Math.floor(d)}일째`;
};

const SEV_ORDER = { high: 0, warn: 1, info: 2 };

/**
 * @param {object} i
 * @param {object|null} i.snapshot  kv `dash.snapshot` (scripts/dash-collect.mjs 가 올림)
 * @param {object|null} i.plan      kv `plan` — events/tasks
 * @param {Array}       i.occurrences 오늘치 전개 결과(plan-core expand). 겹침 검사용
 * @param {object|null} i.sessions  kv `dash.sessions`
 * @param {string}      i.now       ISO
 * @param {string}      i.today     YYYY-MM-DD
 */
export function findMisses({ snapshot, plan, occurrences = [], sessions, now, today }) {
  const out = [];
  const push = (a) => out.push(a);

  /* -- 0. 대시보드 자신에 대한 점검. 이게 제일 먼저다 ------------------- */
  if (!snapshot) {
    push({ id: 'snapshot:none', kind: 'snapshot', severity: 'high',
      title: '수집된 현황이 없습니다', detail: '작업 스케줄러에 dash-collect 가 등록됐는지 확인' });
  } else {
    const mins = ms(now, snapshot.at) / 60000;
    if (mins > T.snapshotStaleMin) {
      push({ id: 'snapshot:stale', kind: 'snapshot', severity: 'warn', at: snapshot.at,
        title: `현황이 ${Math.floor(mins)}분 전 것입니다`,
        detail: '수집기가 멈췄거나 데스크탑이 꺼져 있습니다 — 아래 내용은 그 시점 기준' });
    }
  }

  /* -- 1. 깃: 미푸시 · 미커밋 · 뒤처짐 ---------------------------------- */
  for (const r of snapshot?.repos || []) {
    if (r.ahead > 0) {
      // 가장 오래된 미푸시 커밋의 나이로 심각도를 매긴다 — 개수보다 정확하다
      const oldest = r.unpushed?.length ? r.unpushed[r.unpushed.length - 1].at : r.lastCommit?.at;
      const age = ageDays(oldest, now);
      const sev = age >= T.unpushedHighDays ? 'high' : age >= T.unpushedWarnDays ? 'warn' : 'info';
      push({ id: `git:unpushed:${r.name}`, kind: 'git', severity: sev, at: oldest, repo: r.name,
        title: `${r.name} — 푸시 안 된 커밋 ${r.ahead}개`,
        detail: `${fmtAge(age)}. ${r.unpushed?.[0]?.subject || ''}`.trim() });
    }
    if (r.dirty?.n > 0) {
      const age = ageDays(r.lastCommit?.at, now);
      const sev = age >= T.dirtyWarnDays ? 'warn' : 'info';
      push({ id: `git:dirty:${r.name}`, kind: 'git', severity: sev, at: r.lastCommit?.at, repo: r.name,
        title: `${r.name} — 커밋 안 된 변경 ${r.dirty.n}개`,
        detail: r.dirty.files.slice(0, 3).join(', ') + (r.dirty.n > 3 ? ` 외 ${r.dirty.n - 3}` : '') });
    }
    if (r.behind > 0) {
      push({ id: `git:behind:${r.name}`, kind: 'git', severity: 'warn', repo: r.name,
        title: `${r.name} — 원격보다 ${r.behind}개 뒤처짐`,
        detail: '다른 기기에서 작업한 게 있습니다. pull 먼저' });
    }
    if (r.branch && r.branch !== 'main' && r.branch !== 'HEAD') {
      push({ id: `git:branch:${r.name}`, kind: 'git', severity: 'info', repo: r.name,
        title: `${r.name} — ${r.branch} 브랜치에 있음`,
        detail: r.upstream ? '' : '원격 추적 없음 — 푸시하면 사라지지 않게 -u 필요' });
    }
  }

  /* -- 2. 볼트: 오래 방치된 미결 ---------------------------------------- */
  const open = (snapshot?.vault?.openItems || []).filter((i) => !i.done);
  const stale = open.filter((i) => ageDays(i.mtime, now) >= T.staleOpenDays);
  // 노트 단위로 묶는다 — 한 노트의 미결 5개가 알림 5줄이 되면 화면이 못 쓰게 된다
  const byNote = new Map();
  for (const i of stale) {
    if (!byNote.has(i.path)) byNote.set(i.path, { note: i.note, path: i.path, mtime: i.mtime, items: [] });
    byNote.get(i.path).items.push(i);
  }
  for (const g of byNote.values()) {
    const age = ageDays(g.mtime, now);
    push({ id: `vault:stale:${g.path}`, kind: 'vault', severity: age >= T.staleOpenDays * 2 ? 'warn' : 'info',
      at: g.mtime, note: g.note, path: g.path,
      title: `${g.note} — 미결 ${g.items.length}개가 ${fmtAge(age)} 그대로`,
      detail: g.items[0].text });
  }

  if (snapshot?.vault?.daily && snapshot.vault.daily.date < today) {
    push({ id: 'vault:daily', kind: 'vault', severity: 'info', at: snapshot.vault.daily.mtime,
      title: '오늘 데일리 노트가 없습니다',
      detail: `마지막 기록 ${snapshot.vault.daily.date}` });
  }

  /* -- 3. 일정·할 일: 마감 · 겹침 --------------------------------------- */
  for (const t of plan?.tasks || []) {
    if (t.done || !t.due) continue;
    // 둘 다 YYYY-MM-DD(UTC 자정)라 시차 없이 날짜 차이가 그대로 나온다
    const d = Math.round((new Date(t.due) - new Date(today)) / DAY);
    if (d < 0) {
      push({ id: `task:over:${t.id}`, kind: 'task', severity: 'high',
        title: `'${t.title}' 마감 ${-d}일 지남`, detail: `${t.due}${t.slot ? '' : ' · 아직 언제 할지 안 정함'}` });
    } else if (d <= T.dueSoonDays && !t.slot) {
      push({ id: `task:soon:${t.id}`, kind: 'task', severity: 'warn',
        title: `'${t.title}' 마감 ${d === 0 ? '오늘' : `${d}일 남음`}`, detail: '아직 언제 할지 안 정했습니다' });
    }
  }

  const timed = occurrences
    .filter((o) => !o.allDay && o.start != null && o.end != null)
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < timed.length; i += 1) {
    const prev = timed[i - 1], cur = timed[i];
    if (cur.start < prev.end) {
      push({ id: `plan:overlap:${prev.key}:${cur.key}`, kind: 'task', severity: 'warn',
        title: `일정이 겹칩니다 — ${prev.title} / ${cur.title}`, detail: '오늘' });
    }
  }

  /* -- 4. 세션: 붙잡고 있다가 놓은 것 ------------------------------------ */
  for (const s of sessions?.list || []) {
    if (s.status === 'done') continue;
    const age = ageDays(s.at, now);
    if (age >= T.staleSessionDays) {
      push({ id: `session:stale:${s.id}`, kind: 'session', severity: 'warn', at: s.at,
        title: `'${s.title}' — ${fmtAge(age)} 멈춰 있음`, detail: s.blocked || s.note || '' });
    }
    if (s.awaiting) {
      push({ id: `session:awaiting:${s.id}`, kind: 'session', severity: age >= 1 ? 'warn' : 'info', at: s.at,
        title: `답 대기 중 — ${s.awaiting}`, detail: s.title });
    }
  }

  out.sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
    || (a.at && b.at ? ms(a.at, b.at) : 0)
    || a.id.localeCompare(b.id));
  return out;
}

export const countBySeverity = (misses) => misses.reduce(
  (acc, m) => { acc[m.severity] = (acc[m.severity] || 0) + 1; return acc; },
  { high: 0, warn: 0, info: 0 },
);
