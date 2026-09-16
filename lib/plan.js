// 일정(/plan) 데이터 계층 — lib/plan-core.js 를 그대로 다시 내보내고, kv 입출력(공급자)만 더한다.
// 순수 로직은 전부 plan-core.js/plan-suggest.js 에 있다 — 이 파일만 supabase 를 안다.
import { supabase } from './supabase';
import { addDaysISO } from './plan-core';
import { loadSemester } from './study';

export * from './plan-core';

export const PLAN_KEY = 'plan';
export const WORK_KEY = 'work';
const CACHE_KEY = 'rakan.plan.cache';
const QUEUE_KEY = 'rakan.plan.pending';

/* --------------------------------------------------------- 로컬 캐시/대기열 */

const readLS = (key) => {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const writeLS = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };
const dropLS = (key) => { try { localStorage.removeItem(key); } catch {} };

export const readCache = () => readLS(CACHE_KEY);
export const writeCache = (data) => writeLS(CACHE_KEY, data);
export const readPending = () => readLS(QUEUE_KEY);
export const writePending = (data) => writeLS(QUEUE_KEY, data);
export const clearPending = () => dropLS(QUEUE_KEY);

/* ---------------------------------------------------------- 원격 입출력 */

export async function kvGet(key) {
  const { data, error } = await supabase.from('kv').select('v').eq('k', key).maybeSingle();
  if (error) throw error;
  return data?.v ?? null;
}
export async function kvSet(key, value) {
  const { error } = await supabase
    .from('kv')
    .upsert({ k: key, v: value, updated_at: new Date().toISOString() }, { onConflict: 'k' });
  if (error) throw error;
}

// kv 에 없으면 시드 없이 빈 문서로 시작한다(스펙: "시드 없음").
export async function loadPlan() {
  try {
    const remote = await kvGet(PLAN_KEY);
    const { normalize, emptyPlan } = await import('./plan-core');
    const data = remote ? normalize(remote) : emptyPlan();
    writeCache(data);
    return { data, source: remote ? 'kv' : 'empty' };
  } catch (e) {
    const cached = readCache();
    const { normalize, emptyPlan } = await import('./plan-core');
    if (cached) return { data: normalize(cached), source: 'cache', error: e };
    return { data: emptyPlan(), source: 'empty', error: e };
  }
}

export async function savePlan(data) {
  writeCache(data);
  try {
    await kvSet(PLAN_KEY, data);
    clearPending();
    return { ok: true };
  } catch (e) {
    writePending(data);
    return { ok: false, error: e };
  }
}

export async function flushPendingPlan() {
  const pending = readPending();
  if (!pending) return false;
  try { await kvSet(PLAN_KEY, pending); clearPending(); return true; } catch { return false; }
}

/* --------------------------------------------------- 수업 연동 (읽기 전용) */

// study.<semester> kv 에서 과목 시간표를 읽어 plan-core.expand() 가 바로 쓸 수 있는
// { courseId, title, color, room, startDate, endDate, meetings:[{id,day,start,end,room}] } 로 바꾼다.
// 실패하면 빈 배열 — 수업 연동은 있으면 좋은 것이지 없다고 일정 화면이 죽으면 안 된다.
export async function loadClassesForSemester(semesterId) {
  try {
    const { data } = await loadSemester(semesterId);
    if (!data?.startDate) return [];
    const endDate = data.endDate || addDaysISO(data.startDate, (data.totalWeeks || 16) * 7);
    return (data.courses || []).map((c) => ({
      courseId: c.id,
      title: c.name,
      color: c.colorIndex || 0,
      room: c.room || '',
      startDate: data.startDate,
      endDate,
      meetings: (c.meetings || [])
        .filter((m) => m.day != null && m.start != null)
        .map((m) => ({ id: m.id, day: m.day, start: m.start, end: m.end, room: m.room || '' })),
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------- 스큐 근무 연동 (읽기 전용) */

// kv 'work' 는 스터디큐브(학원)에서 동기화해 넣어 주는 문서다. /plan 은 읽기만 한다 —
// 여기서 고쳐 봐야 다음 동기화에 덮인다. 모양은 { shifts:[{id,date,start,end,kind,title,place}],
// syncedAt, person, source }.
// 없거나 실패하면 빈 목록 — 근무 연동은 있으면 좋은 것이지 없다고 일정 화면이 죽으면 안 된다
// (loadClassesForSemester 와 같은 태도라 여기서도 절대 throw 하지 않는다).
export async function loadWork() {
  try {
    const v = await kvGet(WORK_KEY);
    if (!v || typeof v !== 'object') return { shifts: [] };
    return {
      shifts: Array.isArray(v.shifts) ? v.shifts : [],
      syncedAt: typeof v.syncedAt === 'string' ? v.syncedAt : null,
      person: typeof v.person === 'string' ? v.person : '',
      source: typeof v.source === 'string' ? v.source : '',
    };
  } catch {
    return { shifts: [] };
  }
}
