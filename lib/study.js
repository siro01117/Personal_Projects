// 학습 데이터 계층 — Supabase `kv` 테이블 (k text pk, v jsonb).
//
// 원본은 kv, key = `study.<semesterId>`.
// 최초 1회는 public/study-seed.json 을 읽어 kv 에 적재한다. 시드가 아직 없어도 죽지 않는다.
// 저장은 낙관적 업데이트 + 실패 시 localStorage 대기열 → 다음 접속 때 재시도.
//
// 스키마는 "느슨하게" 읽는다. 다른 도구가 만든 시드에 없는 필드가 있거나 이름이 달라도
// 화면이 깨지지 않는 게 우선이라, normalize() 가 별칭을 흡수하고 모자란 건 기본값으로 채운다.
import { supabase } from './supabase';

export const KV_PREFIX = 'study.';
export const DEFAULT_SEMESTER = '2026-2';
const QUEUE_KEY = 'rakan.study.pending';
const CACHE_KEY = 'rakan.study.cache';

/* ---------------------------------------------------------------- 유틸 */

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, d = '') => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
};

let seq = 0;
export const uid = (p = 'x') => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

// 요일: 0=일 … 6=토. 시드가 '월'/'mon'/1 무엇으로 주든 받는다.
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_ALIAS = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6,
};
export function toDay(v) {
  if (typeof v === 'number' && v >= 0 && v <= 6) return v;
  const s = String(v ?? '').trim().toLowerCase().slice(0, 3);
  if (s in DAY_ALIAS) return DAY_ALIAS[s];
  const k = String(v ?? '').trim()[0];
  return k in DAY_ALIAS ? DAY_ALIAS[k] : null;
}
export const dayName = (d) => DAY_NAMES[d] ?? '';

// "9:00" · "0900" · 540(분) 어느 쪽이든 분 단위 정수로.
export function toMinutes(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 24 * 60 ? null : v;
  const m = String(v).match(/^(\d{1,2})\s*[:시]?\s*(\d{2})?/);
  if (!m) return null;
  return num(m[1]) * 60 + num(m[2] || 0);
}
export const fmtTime = (min) =>
  min == null ? '' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ------------------------------------------------------- 스키마 정규화 */

function normSession(s, i) {
  const o = s && typeof s === 'object' ? s : {};
  const start = toMinutes(pick(o, 'start', 'from', 'begin', 'startTime'));
  const endRaw = toMinutes(pick(o, 'end', 'to', 'finish', 'endTime'));
  return {
    ...o,
    id: str(o.id, `ses${i}`),
    day: toDay(pick(o, 'day', 'weekday', 'dow', 'dayOfWeek')),
    start,
    end: endRaw ?? (start == null ? null : start + 75),
    room: str(pick(o, 'room', 'place', 'location', 'classroom')),
  };
}

function normGrade(g, i) {
  const o = g && typeof g === 'object' ? g : { label: String(g ?? '') };
  return {
    ...o,
    id: str(o.id, `gr${i}`),
    label: str(pick(o, 'label', 'name', 'title', 'item'), '항목'),
    weight: num(pick(o, 'weight', 'percent', 'ratio', 'value'), 0),
  };
}

// 16주 강의계획. seed 는 syllabus:[{week,title,note}] 로 준다.
function normWeek(w, i) {
  const o = w && typeof w === 'object' ? w : { title: String(w ?? '') };
  return {
    ...o,
    week: num(pick(o, 'week', 'no', 'n', 'index'), i + 1),
    topic: str(pick(o, 'topic', 'title', 'subject', 'name')),
    note: str(pick(o, 'note', 'notes', 'memo', 'detail', 'body')),
    done: pick(o, 'done', 'organized', 'complete') === true,
    ink: arr(o.ink),
  };
}

// 차시 — 실제로 열린 수업 한 번. 주차(week)로 강의계획에 붙는다.
// summary 가 채워진 차시가 곧 시험대비의 요약 카드가 된다.
function normLesson(s, i) {
  const o = s && typeof s === 'object' ? s : { topic: String(s ?? '') };
  return {
    ...o,
    id: str(pick(o, 'id', 'date'), `ls${i}`),
    date: str(pick(o, 'date', 'on')),
    week: pick(o, 'week', 'no') != null ? num(pick(o, 'week', 'no')) : null,
    topic: str(pick(o, 'topic', 'title', 'subject')),
    status: str(pick(o, 'status', 'state')),
    hasAudio: pick(o, 'hasAudio', 'audio', 'recorded') === true,
    summary: str(pick(o, 'summary', 'digest'), ''),
    note: str(pick(o, 'note', 'memo'), ''),
    ink: arr(o.ink),
  };
}

// materials 는 [{group, items}] 도, 평평한 [{title,url,group}] 도 받는다.
function normMaterials(raw) {
  const list = arr(raw);
  if (!list.length) return [];
  const grouped = list.some((m) => m && Array.isArray(m.items));
  if (grouped) {
    return list.map((g, i) => ({
      id: str(g?.id, `mg${i}`),
      group: str(pick(g || {}, 'group', 'label', 'name', 'title'), '자료'),
      items: arr(g?.items).map((it, j) => normMaterialItem(it, j)),
    }));
  }
  const byGroup = new Map();
  list.forEach((it, j) => {
    const g = str(pick(it || {}, 'group', 'category', 'kind'), '자료');
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(normMaterialItem(it, j));
  });
  return [...byGroup].map(([group, items], i) => ({ id: `mg${i}`, group, items }));
}
function normMaterialItem(it, j) {
  const o = it && typeof it === 'object' ? it : { title: String(it ?? '') };
  return {
    ...o,
    id: str(o.id, `mi${j}`),
    title: str(pick(o, 'title', 'name', 'label'), '제목 없음'),
    url: str(pick(o, 'url', 'href', 'link')),
    note: str(pick(o, 'note', 'desc', 'description')),
  };
}

function normSummary(s, i) {
  const o = s && typeof s === 'object' ? s : { body: String(s ?? '') };
  return {
    ...o,
    id: str(o.id, `sum${i}`),
    title: str(pick(o, 'title', 'label', 'heading', 'name'), `정리 ${i + 1}`),
    week: pick(o, 'week', 'no') != null ? num(pick(o, 'week', 'no')) : null,
    body: str(pick(o, 'body', 'content', 'text', 'note', 'summary')),
  };
}

// 시험 정보는 구조체로 올 수도, 한 덩어리 글로 올 수도 있다(seed 는 후자).
// 어느 쪽이든 화면이 같은 모양으로 읽을 수 있게 text 를 항상 채운다.
function normExam(raw) {
  if (typeof raw === 'string') return { type: '', scope: '', difficulty: '', date: '', text: raw };
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    ...o,
    type: str(pick(o, 'type', 'format', 'style')),
    scope: str(pick(o, 'scope', 'range', 'coverage')),
    difficulty: str(pick(o, 'difficulty', 'level', 'hardness')),
    date: str(pick(o, 'date', 'when', 'at')),
    text: str(pick(o, 'text', 'detail', 'note'), ''),
  };
}

function normCourse(c, i) {
  const o = c && typeof c === 'object' ? c : { name: String(c ?? '') };
  // meetings = 매주 반복되는 시간표. sessions = 실제 차시. 이름이 비슷해 섞기 쉬운데 다른 것이다.
  const meetings = arr(pick(o, 'meetings', 'slots', 'times', 'schedule')).map(normSession);
  const lessons = arr(pick(o, 'sessions', 'lessons', 'classes')).map(normLesson);
  // 요약 카드: 따로 준 summaries 가 있으면 그것, 없으면 summary 가 채워진 차시에서 만든다.
  const explicit = arr(pick(o, 'summaries', 'cards')).map(normSummary);
  const fromLessons = lessons
    .filter((l) => l.summary)
    .map((l, j) => ({
      id: `ls-${l.id}`, title: l.topic || (l.week != null ? `${l.week}주차` : `정리 ${j + 1}`),
      week: l.week, body: l.summary,
    }));
  return {
    ...o,
    id: str(pick(o, 'id', 'code', 'key'), `c${i}`),
    name: str(pick(o, 'name', 'title', 'course', 'label'), `과목 ${i + 1}`),
    professor: str(pick(o, 'professor', 'prof', 'teacher', 'instructor')),
    category: str(pick(o, 'category', 'kind')),
    room: str(pick(o, 'room', 'place', 'location')),
    credits: num(pick(o, 'credits', 'credit', 'unit'), 0),
    confirmed: pick(o, 'confirmed', 'verified') !== false,
    colorIndex: num(pick(o, 'colorIndex'), i) % 7,
    meetings,
    lessons,
    grading: arr(pick(o, 'grading', 'grades', 'evaluation', 'weights')).map(normGrade),
    textbook: str(pick(o, 'textbook', 'book', 'text')),
    style: str(pick(o, 'professorStyle', 'style', 'profStyle', 'teachingStyle')),
    cautions: arr(pick(o, 'cautions', 'warnings', 'caution')).map((x) => str(x, String(x ?? ''))),
    strategy: str(pick(o, 'strategy', 'plan', 'approach')),
    progress: arr(pick(o, 'syllabus', 'progress', 'weeks', 'plan_weeks')).map(normWeek),
    materials: normMaterials(pick(o, 'materials', 'resources', 'files')),
    exam: normExam(pick(o, 'examInfo', 'exam', 'test')),
    summaries: explicit.length ? explicit : fromLessons,
    memo: str(pick(o, 'memo', 'wrongNotes'), ''),
    ink: arr(o.ink),
  };
}

function normTodo(t, i) {
  const o = t && typeof t === 'object' ? t : { title: String(t ?? '') };
  return {
    ...o,
    id: str(o.id, `todo${i}`),
    title: str(pick(o, 'title', 'text', 'name', 'label'), '할 일'),
    courseId: str(pick(o, 'courseId', 'course', 'cid')),
    due: str(pick(o, 'due', 'deadline', 'dueDate', 'date')),
    priority: str(pick(o, 'priority', 'level')),
    detail: str(pick(o, 'detail', 'desc', 'note')),
    done: pick(o, 'done', 'complete', 'checked') === true,
  };
}

function normConflict(c, i) {
  const o = c && typeof c === 'object' ? c : { detail: String(c ?? '') };
  return {
    ...o,
    id: str(o.id, `cf${i}`),
    week: pick(o, 'week', 'no') != null ? num(pick(o, 'week', 'no')) : null,
    date: str(pick(o, 'date', 'on')),
    title: str(pick(o, 'title', 'label', 'name'), ''),
    detail: str(pick(o, 'detail', 'desc', 'description', 'note')),
    courseIds: arr(pick(o, 'courseIds', 'courses')).map((x) => str(x, String(x ?? ''))),
  };
}

// 학기 메타는 두 모양을 다 받는다: 평평한 {semesterId,startDate,...} 와
// seed 처럼 감싸인 {semester:{id,label,start,weeks}}.
export function normalize(raw, semesterId = DEFAULT_SEMESTER) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const s = o.semester && typeof o.semester === 'object' ? o.semester : {};
  return {
    ...o,
    semester: s,
    semesterId: str(pick(s, 'id') ?? pick(o, 'semesterId', 'id'), semesterId),
    label: str(pick(s, 'label', 'name') ?? pick(o, 'label', 'title'), '학기'),
    startDate: str(pick(s, 'start', 'startDate') ?? pick(o, 'startDate', 'start')),
    endDate: str(pick(s, 'end', 'endDate') ?? pick(o, 'endDate', 'end')),
    totalWeeks: num(pick(s, 'weeks', 'totalWeeks') ?? pick(o, 'totalWeeks', 'weekCount'), 16),
    holidays: arr(pick(s, 'holidays') ?? o.holidays),
    courses: arr(pick(o, 'courses', 'subjects', 'classes')).map(normCourse),
    todos: arr(pick(o, 'todos', 'tasks', 'todo')).map(normTodo),
    conflicts: arr(pick(o, 'conflicts', 'clashes')).map(normConflict),
  };
}

export const emptySemester = (semesterId = DEFAULT_SEMESTER) => normalize({ semesterId }, semesterId);

/* ------------------------------------------------------------ 주차 계산 */

// 학기 시작일 기준 현재 몇 주차인지. startDate 가 없으면 null (화면에서 표시를 감춘다).
export function currentWeek(data) {
  if (!data?.startDate) return null;
  const start = new Date(`${data.startDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const diff = Math.floor((Date.now() - start.getTime()) / 864e5);
  const w = Math.floor(diff / 7) + 1;
  if (w < 1) return null;
  return Math.min(w, data.totalWeeks || 16);
}

// 요일별 수업 — 대시보드의 '오늘'/'이번 주'가 함께 쓴다. 시간표는 meetings 다.
export function sessionsOfDay(data, day) {
  const out = [];
  for (const c of data?.courses || []) {
    for (const s of c.meetings || []) {
      if (s.day === day) out.push({ course: c, session: s });
    }
  }
  return out.sort((a, b) => (a.session.start ?? 1e9) - (b.session.start ?? 1e9));
}

/* --------------------------------------------------- 로컬 캐시 / 대기열 */

const readLS = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};
const writeLS = (key, val) => {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
};
const dropLS = (key) => { try { localStorage.removeItem(key); } catch {} };

export const readCache = (semesterId) => readLS(`${CACHE_KEY}.${semesterId}`);
export const writeCache = (semesterId, data) => writeLS(`${CACHE_KEY}.${semesterId}`, data);
export const readPending = (semesterId) => readLS(`${QUEUE_KEY}.${semesterId}`);
export const writePending = (semesterId, data) => writeLS(`${QUEUE_KEY}.${semesterId}`, data);
export const clearPending = (semesterId) => dropLS(`${QUEUE_KEY}.${semesterId}`);

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

// 시드는 없을 수도 있다 (다른 도구가 아직 만드는 중). 없으면 null 을 돌려주고 빈 상태로 간다.
export async function fetchSeed() {
  try {
    const res = await fetch('/study-seed.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;    // 404 를 index.html 로 돌려주는 정적 호스팅 대비
    return await res.json();
  } catch { return null; }
}

// 학기 하나를 불러온다.
//   kv 에 있으면 그것.
//   없고 시드가 있으면 시드를 kv 에 심고 그것 (최초 1회 적재).
//   둘 다 없으면 빈 학기.
// 원격이 통째로 실패하면 로컬 캐시로 버틴다.
export async function loadSemester(semesterId = DEFAULT_SEMESTER) {
  const key = KV_PREFIX + semesterId;
  try {
    const remote = await kvGet(key);
    if (remote) {
      const data = normalize(remote, semesterId);
      writeCache(semesterId, data);
      return { data, source: 'kv' };
    }
    const seed = await fetchSeed();
    if (seed) {
      const data = normalize(seed, semesterId);
      try { await kvSet(key, data); } catch {}
      writeCache(semesterId, data);
      return { data, source: 'seed' };
    }
    return { data: emptySemester(semesterId), source: 'empty' };
  } catch (e) {
    const cached = readCache(semesterId);
    if (cached) return { data: normalize(cached, semesterId), source: 'cache', error: e };
    const seed = await fetchSeed();
    if (seed) return { data: normalize(seed, semesterId), source: 'seed-offline', error: e };
    return { data: emptySemester(semesterId), source: 'empty', error: e };
  }
}

// 저장 — 호출부는 이미 낙관적으로 화면을 바꾼 뒤다. 실패하면 대기열에 넣고 알린다.
export async function saveSemester(semesterId, data) {
  writeCache(semesterId, data);
  try {
    await kvSet(KV_PREFIX + semesterId, data);
    clearPending(semesterId);
    return { ok: true };
  } catch (e) {
    writePending(semesterId, data);
    return { ok: false, error: e };
  }
}

// 지난 접속에서 못 보낸 게 있으면 조용히 다시 보낸다.
export async function flushPending(semesterId) {
  const pending = readPending(semesterId);
  if (!pending) return false;
  try {
    await kvSet(KV_PREFIX + semesterId, pending);
    clearPending(semesterId);
    return true;
  } catch { return false; }
}

// kv 에 있는 학기 목록. 실패하면 기본 학기 하나만.
export async function listSemesters() {
  try {
    const { data, error } = await supabase.from('kv').select('k').like('k', `${KV_PREFIX}%`);
    if (error) throw error;
    const ids = (data || []).map((r) => String(r.k).slice(KV_PREFIX.length)).filter(Boolean);
    return ids.length ? [...new Set(ids)].sort().reverse() : [DEFAULT_SEMESTER];
  } catch {
    return [DEFAULT_SEMESTER];
  }
}
