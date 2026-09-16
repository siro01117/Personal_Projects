// /dash 데이터 입출력. 대시보드는 **읽기 전용**이다 — 화면에서 kv 에 쓰지 않는다.
//   dash.snapshot  scripts/dash-collect.mjs 가 10분마다 올림(깃·볼트)
//   dash.sessions  scripts/dash-say.mjs 로 "일단 여기까지" 시점에만 기록
//   plan           /plan 이 쓰는 문서를 그대로 읽어온다(일정·할 일)
import { kvGet, loadPlan } from './plan';

export const SNAPSHOT_KEY = 'dash.snapshot';
export const SESSIONS_KEY = 'dash.sessions';

export async function loadDash() {
  // 하나가 비어도 나머지는 보여준다 — 수집기가 안 돌았다는 사실 자체가 알림거리다
  const [snapshot, sessions, plan] = await Promise.all([
    kvGet(SNAPSHOT_KEY).catch(() => null),
    kvGet(SESSIONS_KEY).catch(() => null),
    loadPlan().then((r) => r.data).catch(() => null),
  ]);
  return { snapshot, sessions: normalizeSessions(sessions), plan };
}

export function normalizeSessions(raw) {
  const list = Array.isArray(raw?.list) ? raw.list : [];
  return {
    list: list.map((s) => ({
      id: String(s.id || ''),
      title: String(s.title || ''),
      status: s.status === 'done' || s.status === 'paused' ? s.status : 'active',
      note: s.note ? String(s.note) : '',
      blocked: s.blocked ? String(s.blocked) : '',
      awaiting: s.awaiting ? String(s.awaiting) : '',
      next: Array.isArray(s.next) ? s.next.map(String) : [],
      repo: s.repo ? String(s.repo) : '',
      at: s.at || null,
    })).filter((s) => s.id && s.title),
  };
}
