/* ---------------------------------------------------------------------------
   "챙길 것" — 전부 규칙으로 계산한다. LLM 판단 아님.
   방치된 기간 · 상태 · 마감 세 축이면 대부분 잡힌다.

   문구 규칙: 한 항목은 **한 문장**이다. 제목+부연으로 나누지 않는다 — 두 줄이 되는 순간
   훑는 화면이 아니라 읽는 화면이 된다. 저장소 이름·커밋 해시 같은 기계 용어는 여기서
   사람 말로 바꾼다(화면은 rules 가 준 문장을 그대로 쓴다).

   순수 함수다. 입력을 주면 같은 결과가 나오고 네트워크·시계를 직접 읽지 않는다
   (now 를 인자로 받는다) — scripts/dash-selftest.mjs 가 이걸 전제로 검증한다.

   화면에서 계산하므로 기준을 고쳐도 수집기(scripts/dash-collect.mjs)를 다시 돌릴 필요가 없다.
--------------------------------------------------------------------------- */

export const DAY = 86400000;

// 기준값을 한곳에 모은다 — 화면에서 "왜 이게 떴나" 를 설명할 때도 이 숫자를 쓴다
export const T = {
  snapshotStaleMin: 30,   // 수집기가 이만큼 안 돌면 대시보드 자체를 믿을 수 없다
  unpushedWarnDays: 1,
  unpushedHighDays: 4,
  dirtyWarnDays: 1,
  staleOpenDays: 14,      // 볼트 메모가 이만큼 손 안 닿으면 방치로 본다
  staleSessionDays: 2,
  dueSoonDays: 2,
};

// 폴더 이름을 그대로 쓰면 읽는 사람이 한 번 더 번역해야 한다.
const REPO_NAMES = {
  Personal_Projects: '라칸 포털',
  'studycube.cloud': '스터디큐브',
  Studycube_info: '스터디큐브 소개 사이트',
};
const repoName = (r) => REPO_NAMES[r] || r;

/* ------------------------------------------------------------ 조사 붙이기 */
// 문장 안에 들어갈 이름이 데이터에서 온다 — 받침을 보고 조사를 골라야 '라칸 포털를'
// 같은 게 안 생긴다. 한글은 (코드-0xAC00)%28 로 받침을 바로 알 수 있다.
export function hasFinal(word) {
  const ch = String(word ?? '').trim().replace(/['’”)\]」』]+$/, '').slice(-1);
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 !== 0;
  if (ch >= '0' && ch <= '9') return '013678'.includes(ch);  // 영·일·삼·육·칠·팔
  const a = ch.toLowerCase();
  if (a >= 'a' && a <= 'z') return 'lmnr'.includes(a);       // 엘·엠·엔·알만 받침이 있다
  return false; // 기호·한자 등은 모르니 받침 없는 쪽으로 (덜 어색하다)
}
export const josa = (word, withFinal, withoutFinal) =>
  `${word}${hasFinal(word) ? withFinal : withoutFinal}`;

const ms = (a, b) => new Date(a).getTime() - new Date(b).getTime();
const daysBetween = (a, b) => ms(a, b) / DAY;
export const ageDays = (at, now) => (at ? daysBetween(now, at) : null);

// "5일째" / "3시간째" — 문장 안에 그대로 끼워 쓴다.
const since = (d) => {
  if (d == null) return '';
  if (d < 1) { const h = Math.floor(d * 24); return h < 1 ? '방금부터' : `${h}시간째`; }
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
 * @returns {Array<{id,kind,severity,text,at?}>} text 는 그 자체로 완결된 한 문장
 */
export function findMisses({ snapshot, plan, occurrences = [], sessions, now, today }) {
  const out = [];
  const push = (a) => out.push(a);

  /* -- 0. 대시보드 자신에 대한 점검. 이게 제일 먼저다 ------------------- */
  if (!snapshot) {
    push({ id: 'snapshot:none', kind: 'snapshot', severity: 'high',
      text: '현황을 모으지 못하고 있습니다. 수집이 도는지 확인해 주세요.' });
  } else {
    const mins = ms(now, snapshot.at) / 60000;
    if (mins > T.snapshotStaleMin) {
      push({ id: 'snapshot:stale', kind: 'snapshot', severity: 'warn', at: snapshot.at,
        text: `아래 내용은 ${Math.floor(mins)}분 전 상태입니다. 그 뒤로 바뀐 건 반영되지 않았습니다.` });
    }
  }

  /* -- 1. 작업: 올리지 않은 것 · 저장하지 않은 것 ------------------------ */
  for (const r of snapshot?.repos || []) {
    const name = repoName(r.name);
    if (r.ahead > 0) {
      // 가장 오래된 것의 나이로 급한 정도를 매긴다 — 개수보다 정확하다
      const oldest = r.unpushed?.length ? r.unpushed[r.unpushed.length - 1].at : r.lastCommit?.at;
      const age = ageDays(oldest, now);
      push({ id: `git:unpushed:${r.name}`, kind: 'work', at: oldest,
        severity: age >= T.unpushedHighDays ? 'high' : age >= T.unpushedWarnDays ? 'warn' : 'info',
        text: `${name}에 아직 올리지 않은 작업이 ${since(age)} 있습니다.` });
    }
    if (r.dirty?.n > 0) {
      const age = ageDays(r.lastCommit?.at, now);
      push({ id: `git:dirty:${r.name}`, kind: 'work', at: r.lastCommit?.at,
        severity: age >= T.dirtyWarnDays ? 'warn' : 'info',
        text: `${name}에 저장하지 않은 수정이 ${r.dirty.n}건, ${since(age)} 그대로입니다.` });
    }
    if (r.behind > 0) {
      push({ id: `git:behind:${r.name}`, kind: 'work', severity: 'warn',
        text: `${josa(name, '을', '를')} 다른 기기에서 고쳤습니다. 먼저 받아온 뒤 이어가세요.` });
    }
    if (r.branch && r.branch !== 'main' && r.branch !== 'HEAD') {
      push({ id: `git:branch:${r.name}`, kind: 'work', severity: 'info',
        text: `${josa(name, '이', '가')} ${r.branch} 갈래에서 작업 중입니다.` });
    }
  }

  /* -- 2. 메모: 오래 방치된 것 ------------------------------------------ */
  const open = (snapshot?.vault?.openItems || []).filter((i) => !i.done);
  const stale = open.filter((i) => ageDays(i.mtime, now) >= T.staleOpenDays);
  // 노트 단위로 묶는다 — 한 노트의 미결 5개가 5줄이 되면 화면이 못 쓰게 된다
  const byNote = new Map();
  for (const i of stale) {
    if (!byNote.has(i.path)) byNote.set(i.path, { note: i.note, path: i.path, mtime: i.mtime, items: [] });
    byNote.get(i.path).items.push(i);
  }
  for (const g of byNote.values()) {
    const age = ageDays(g.mtime, now);
    const n = g.items.length;
    push({ id: `vault:stale:${g.path}`, kind: 'note',
      severity: age >= T.staleOpenDays * 2 ? 'warn' : 'info', at: g.mtime, path: g.path,
      text: n === 1
        ? `‘${g.note}’에 ${since(age)} 그대로인 메모가 있습니다 — ${g.items[0].text}.`
        : `‘${g.note}’에 ${since(age)} 그대로인 메모가 ${n}가지 있습니다.` });
  }

  if (snapshot?.vault?.daily && snapshot.vault.daily.date < today) {
    push({ id: 'vault:daily', kind: 'note', severity: 'info', at: snapshot.vault.daily.mtime,
      text: `오늘 기록을 아직 안 남겼습니다. 마지막은 ${snapshot.vault.daily.date}입니다.` });
  }

  /* -- 3. 일상: 마감 · 겹침 --------------------------------------------- */
  for (const t of plan?.tasks || []) {
    if (t.done || !t.due) continue;
    // 둘 다 YYYY-MM-DD(UTC 자정)라 시차 없이 날짜 차이가 그대로 나온다
    const d = Math.round((new Date(t.due) - new Date(today)) / DAY);
    if (d < 0) {
      push({ id: `task:over:${t.id}`, kind: 'life', severity: 'high',
        text: `‘${t.title}’ 마감이 ${-d}일 지났습니다.` });
    } else if (d <= T.dueSoonDays && !t.slot) {
      push({ id: `task:soon:${t.id}`, kind: 'life', severity: 'warn',
        text: `‘${t.title}’ 마감이 ${d === 0 ? '오늘' : d === 1 ? '내일' : `${d}일 뒤`}인데 아직 언제 할지 안 정했습니다.` });
    }
  }

  const timed = occurrences
    .filter((o) => !o.allDay && o.start != null && o.end != null)
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < timed.length; i += 1) {
    const prev = timed[i - 1], cur = timed[i];
    if (cur.start < prev.end) {
      push({ id: `plan:overlap:${prev.key}:${cur.key}`, kind: 'life', severity: 'warn',
        text: `오늘 일정이 겹칩니다 — ${prev.title}, ${cur.title}.` });
    }
  }

  /* -- 4. 벌여둔 일: 붙잡고 있다가 놓은 것 ------------------------------- */
  for (const s of sessions?.list || []) {
    if (s.status === 'done') continue;
    const age = ageDays(s.at, now);
    if (age >= T.staleSessionDays) {
      push({ id: `session:stale:${s.id}`, kind: 'work', severity: 'warn', at: s.at,
        text: `‘${s.title}’, ${since(age)} 손 놓고 있습니다.` });
    }
    if (s.awaiting) {
      push({ id: `session:awaiting:${s.id}`, kind: 'work', severity: age >= 1 ? 'warn' : 'info', at: s.at,
        text: `${josa(s.awaiting, '을', '를')} 정해야 ${josa(`‘${s.title}’`, '이', '가')} 다음으로 갑니다.` });
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
