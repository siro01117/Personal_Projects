// 일정(/plan) 데이터 계층 — lib/plan-core.js 를 그대로 다시 내보내고, kv 입출력(공급자)만 더한다.
// 순수 로직은 전부 plan-core.js/plan-suggest.js 에 있다 — 이 파일만 supabase 를 안다.
import { supabase } from './supabase';
import { addDaysISO, mergePlan, normalize } from './plan-core';
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
// 대기열에는 문서와 함께 그 문서의 기준본(base)을 둔다 — 나중에 올릴 때 합치기에 쓴다.
// 옛 형식(문서만 들어 있음)은 base 없이 다룬다(지우기 없이 얹기만).
export const readPending = () => {
  const p = readLS(QUEUE_KEY);
  if (!p) return null;
  return p && p.doc && typeof p.doc === 'object' ? p : { doc: p, base: null };
};
export const writePending = (doc, base = null) => writeLS(QUEUE_KEY, { doc, base });
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

// 저장 = 서버 최신본을 다시 읽고 → 이 탭의 변경만 얹어(mergePlan) → 그 사이 아무도 안 썼을 때만 쓴다.
// 읽고 쓰는 사이에 누가 썼으면(updated_at 이 달라짐) 다시 읽어 합친다. 반환의 data 가 실제로
// 서버에 들어간 문서이고, 다음 저장의 기준본(base)이 된다.
async function writeMerged(local, base) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data: row, error: readErr } = await supabase
      .from('kv').select('v, updated_at').eq('k', PLAN_KEY).maybeSingle();
    if (readErr) throw readErr;
    const merged = row ? mergePlan(base, local, normalize(row.v)) : local;
    const stamp = new Date().toISOString();
    if (!row) {
      const { error } = await supabase.from('kv').insert({ k: PLAN_KEY, v: merged, updated_at: stamp });
      if (error) { if (attempt < 3) continue; throw error; } // 동시에 누가 처음 만들었으면 다시 합친다
      return merged;
    }
    const { data: done, error } = await supabase
      .from('kv').update({ v: merged, updated_at: stamp })
      .eq('k', PLAN_KEY).eq('updated_at', row.updated_at)
      .select('k');
    if (error) throw error;
    if (done && done.length) return merged;
    // 읽은 뒤 누가 썼다 → 한 번 더
  }
  throw new Error('다른 곳에서 계속 저장하고 있어 합치지 못했습니다');
}

export async function savePlan(local, base) {
  writeCache(local);
  try {
    const merged = await writeMerged(local, base);
    writeCache(merged);
    clearPending();
    return { ok: true, data: merged };
  } catch (e) {
    writePending(local, base);
    return { ok: false, error: e };
  }
}

export async function flushPendingPlan() {
  const pending = readPending();
  if (!pending) return false;
  try {
    await writeMerged(normalize(pending.doc), pending.base ? normalize(pending.base) : null);
    clearPending();
    return true;
  } catch {
    return false;
  }
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

// 근무는 스터디큐브(학원)가 원본이다. /plan 은 읽기만 한다 — 여기서 고쳐 봐야 다음에 덮인다.
// 모양은 { shifts:[{id,date,start,end,kind,title,place}], syncedAt, person, source }.
//
// **볼 때 받아온다.** 주기 작업을 두지 않고, 화면을 열거나 다시 돌아올 때 서버 함수
// refresh_work() 가 스큐에 물어 kv 'work' 를 갈아끼운다(토큰은 서버에만 있다).
// 스큐가 응답이 없으면 null 이 오고, 그때는 마지막으로 받아 둔 kv 'work' 를 쓴다(live:false).
// 없거나 실패하면 빈 목록 — 근무 연동이 죽어도 일정 화면이 죽으면 안 되므로 절대 throw 하지 않는다.
const shapeWork = (v, live) => (!v || typeof v !== 'object' ? { shifts: [], live: false } : {
  shifts: Array.isArray(v.shifts) ? v.shifts : [],
  syncedAt: typeof v.syncedAt === 'string' ? v.syncedAt : null,
  person: typeof v.person === 'string' ? v.person : '',
  source: typeof v.source === 'string' ? v.source : '',
  live,
});

export async function loadWork({ fresh = true } = {}) {
  if (fresh) {
    try {
      const { data, error } = await supabase.rpc('refresh_work');
      if (!error && data && Array.isArray(data.shifts)) return shapeWork(data, true);
    } catch {
      // 아래 저장본으로 넘어간다
    }
  }
  try {
    return shapeWork(await kvGet(WORK_KEY), false);
  } catch {
    return { shifts: [], live: false };
  }
}
