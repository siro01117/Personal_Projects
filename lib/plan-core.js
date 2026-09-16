// 일정(/plan) 모듈 — 순수 로직 전부. supabase 를 절대 import 하지 않는다.
// node 로 직접 실행해 검증해야 하므로(scripts/plan-selftest.mjs) 이 파일은 브라우저·서버
// 어느 쪽 전역도 필요로 하지 않는다.
//
// 날짜는 전부 로컬 날짜 문자열('YYYY-MM-DD') 기준으로 계산한다. `new Date(iso)` 로 바로
// 파싱하면 UTC 로 해석돼 자정 근처에서 하루가 밀리는 함정이 있어, 항상
// `new Date(y, m-1, d)` (로컬 타임존 생성자)를 거친다 — RENEWAL.md 의 UTC 금지 원칙과 같다.

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d = false) => (typeof v === 'boolean' ? v : d);

let seq = 0;
export const uid = (p = 'x') => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

/* ------------------------------------------------------------ 날짜 헬퍼 */

const pad2 = (n) => String(n).padStart(2, '0');

export function parseISO(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}
export function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
export function addDaysISO(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}
// 0=일 … 6=토 — lib/study.js 의 toDay 와 같은 규약.
export function dowOf(iso) {
  return parseISO(iso).getDay();
}
export function diffDaysISO(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}
export const cmpISO = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// 주 이동 머리말 — 0 이번 주 / 1 다음 주 / -1 지난 주 / 그 밖은 N주 뒤·전
export const weekLabel = (offset) => (
  offset === 0 ? '이번 주' : offset === 1 ? '다음 주' : offset === -1 ? '지난 주'
    : offset > 0 ? `${offset}주 뒤` : `${-offset}주 전`
);

// iso 가 속한 주의 월요일~일요일. 오늘을 맨 앞에 두지 않고 요일 자리를 고정한다.
export function weekDays(iso) {
  const monday = addDaysISO(iso, -((dowOf(iso) + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
}
export const todayISO = () => toISO(new Date());
export const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
export const fmtTime = (min) =>
  min == null ? '' : `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

/* ------------------------------------------------------- 스키마 정규화 */

function normRepeat(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.freq !== 'weekly' && r.freq !== 'daily') return null;
  const out = { freq: r.freq, until: r.until ? str(r.until) : null };
  if (r.freq === 'weekly') out.days = arr(r.days).map(Number).filter((d) => d >= 0 && d <= 6);
  return out;
}

function normPlace(p, i) {
  const o = p && typeof p === 'object' ? p : {};
  return { id: str(o.id, `pl${i}`), name: str(o.name, '').trim() };
}

// { "<idA>|<idB>": 분 } — 키는 항상 정렬된 쌍이라 방향이 없다(왕복 같은 시간으로 본다).
function normTravel(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const m = Math.max(0, num(v, 0));
    if (m > 0) out[k] = m;
  }
  return out;
}

export const travelKey = (a, b) => [a, b].sort().join('|');

export function travelMinutes(settings, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return 0;
  return Math.max(0, num(settings?.travel?.[travelKey(fromId, toId)], 0));
}

// 지점 n 개에서 나오는 쌍 목록 — 설정 화면이 입력칸을 만들 때 쓴다.
export function travelPairs(places) {
  const out = [];
  for (let i = 0; i < places.length; i += 1) {
    for (let j = i + 1; j < places.length; j += 1) out.push([places[i], places[j]]);
  }
  return out;
}

function normEvent(e, i) {
  const o = e && typeof e === 'object' ? e : {};
  const allDay = bool(o.allDay, false);
  return {
    ...o,
    id: str(o.id, uid('ev')),
    title: str(o.title, '일정'),
    place: str(o.place, ''),
    // placeId 는 이동시간 행렬의 지점. place 는 그 안의 상세("본관 201")로 남긴다.
    // travelMin 은 행렬에 없는 일회성 일정에 직접 적는 편도 이동시간(행렬보다 우선).
    placeId: str(o.placeId, ''),
    travelMin: o.travelMin == null ? null : Math.max(0, num(o.travelMin, 0)),
    note: str(o.note, ''),
    important: bool(o.important, false),
    date: str(o.date, ''),
    start: allDay ? null : (o.start == null ? null : num(o.start)),
    end: allDay ? null : (o.end == null ? null : num(o.end)),
    allDay,
    repeat: normRepeat(o.repeat),
    exceptions: o.exceptions && typeof o.exceptions === 'object' ? o.exceptions : {},
    color: num(o.color, i % 7) % 7,
  };
}

function normTask(t, i) {
  const o = t && typeof t === 'object' ? t : {};
  const slot = o.slot && typeof o.slot === 'object' && o.slot.date
    ? { date: str(o.slot.date), start: num(o.slot.start) }
    : null;
  return {
    ...o,
    id: str(o.id, uid('tk')),
    title: str(o.title, '할 일'),
    note: str(o.note, ''),
    duration: num(o.duration, 60),
    priority: ['high', 'normal', 'low'].includes(o.priority) ? o.priority : 'normal',
    due: o.due ? str(o.due) : null,
    slot,
    done: bool(o.done, false),
    doneAt: o.doneAt ? str(o.doneAt) : null,
  };
}

export function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const s = o.settings && typeof o.settings === 'object' ? o.settings : {};
  return {
    ...o,
    version: num(o.version, 1),
    settings: {
      dayStart: num(s.dayStart, 480),
      // 끝이 시작보다 앞이면(00:00 을 넣은 경우) 자정으로 본다. 시간 입력칸은 24:00 을 못 받아
      // 자정을 넣으려다 0(오전 12:00)이 저장된 적이 있다 — 그대로 두면 빈 시간 제안이 전부 사라진다.
      dayEnd: (() => {
        const start = num(s.dayStart, 480), end = Math.min(1440, num(s.dayEnd, 1380));
        return end <= start ? 1440 : end;
      })(),
      step: num(s.step, 30),
      buffer: num(s.buffer, 15),
      showClasses: bool(s.showClasses, true),
      showWork: bool(s.showWork, true),
      semester: str(s.semester, '2026-2'),
      // 자주 가는 지점 몇 개 + 그 사이 이동시간. 지점 n 개면 쌍은 n(n-1)/2 개다.
      places: arr(s.places).map(normPlace).filter((x) => x.name),
      travel: normTravel(s.travel),
      homeId: str(s.homeId, ''),   // 하루의 시작·끝 기준점(집). 비면 왕복 이동을 안 센다
      // 피로도 — 둘 다 "하지 마라"가 아니라 "덜 권한다"는 뜻의 감점 기준이다.
      dailyLimit: num(s.dailyLimit, 480), // 하루에 채우고 싶은 최대 분(일정+이동+할 일)
      minRest: num(s.minRest, 30),        // 앞뒤 일정과 이만큼은 띄우고 싶다
    },
    events: arr(o.events).map(normEvent),
    tasks: arr(o.tasks).map(normTask),
    classOverrides: o.classOverrides && typeof o.classOverrides === 'object' ? o.classOverrides : {},
  };
}

export const emptyPlan = () => normalize({});

/* ---------------------------------------------------------------- 전개 */

// event/class 공통 — 반복 패턴이 특정 날짜에 "원래" 발생하는지(예외 적용 전).
function occursOnRepeat(startDate, repeat, iso) {
  if (cmpISO(iso, startDate) < 0) return false;
  if (repeat.until && cmpISO(iso, repeat.until) > 0) return false;
  if (repeat.freq === 'daily') return true;
  const days = repeat.days && repeat.days.length ? repeat.days : [dowOf(startDate)];
  return days.includes(dowOf(iso));
}
function occursOnClass(course, meeting, iso) {
  if (cmpISO(iso, course.startDate) < 0) return false;
  if (course.endDate && cmpISO(iso, course.endDate) > 0) return false;
  return dowOf(iso) === meeting.day;
}

// exceptions(원래날짜 → {skip}|{date,start,end,title?,place?}) 를 반영해, [fromISO,toISO]
// 범위 안에 놓이는 (원본이든 이동해 들어온 것이든) 날짜 목록을 만든다.
// occursOnFn(origISO) 은 그 예외의 원래 날짜가 애초에 반복 패턴이 발생하는 날인지 검사한다
// (전개 창 밖에서 옮겨 들어온 회차도 원본 패턴에 맞아야 유효한 예외로 친다).
function expandWithExceptions(occursOnFn, exceptions, fromISO, toISO, build) {
  const out = [];
  const movedAway = new Set();      // 다른 날로 옮겨간 원래 날짜 (제자리에 다시 그리지 않는다)
  const handledInRange = new Set(); // 이미 예외로 처리해 범위 안에 넣은 원래 날짜

  for (const [origDate, ex] of Object.entries(exceptions || {})) {
    if (!ex) continue;
    if (ex.skip) { movedAway.add(origDate); continue; }
    if (!ex.date) continue;
    movedAway.add(origDate);
    if (ex.date >= fromISO && ex.date <= toISO && occursOnFn(origDate)) {
      out.push(build(origDate, ex, true));
      handledInRange.add(origDate);
    }
  }

  let cur = fromISO;
  while (cur <= toISO) {
    if (!movedAway.has(cur) && !handledInRange.has(cur) && occursOnFn(cur)) {
      out.push(build(cur, null, false));
    }
    cur = addDaysISO(cur, 1);
  }
  return out;
}

function makeOcc({ source, id, date, start, end, allDay, important, color, place, placeId, travelMin, title, recurring, moved, origDate }) {
  return {
    key: `${source}:${id}:${origDate}`,
    eventId: source === 'event' ? id : null,
    id, source, title, date, start, end,
    allDay: !!allDay, important: !!important, color: color ?? 0, place: place || '',
    placeId: placeId || '', travelMin: travelMin == null ? null : Number(travelMin),
    recurring: !!recurring, moved: !!moved,
    original: { date: origDate, start, end },
  };
}

// occ 는 makeOcc 결과와 같은 모양이면 되므로, 위에서 만든 moved occurrence 는
// original.start/end 를 "이동 전 시각"으로 다시 채워야 한다. helper 로 보정.
function withOriginalTimes(occ, baseStart, baseEnd) {
  return { ...occ, original: { ...occ.original, start: baseStart, end: baseEnd } };
}

// 스큐 근무 색 — 기존 0~6 인덱스 체계를 그대로 쓰되 근무는 한 색으로 고정한다. 6(=--s7)을
// 고른 이유: 학교 과목은 colorIndex 를 0부터 순서대로 받고(lib/study.js) 이벤트 기본색도
// 0부터 도는 만큼, 6 이 가장 늦게 쓰이는 인덱스라 수업·일정과 색이 겹칠 확률이 가장 낮다.
export const WORK_COLOR = 6;

/**
 * classes: [{ courseId, title, color, room, startDate, endDate,
 *             meetings:[{ id, day, start, end, room }] }]
 * (lib/plan.js 가 study kv 를 읽어 이 모양으로 만들어 넘긴다 — 이 파일은 supabase 를 모른다)
 *
 * shifts: [{ id, date, start, end, kind, title, place }] — 스터디큐브에서 동기화한 근무.
 * 읽기 전용이라 doc 에 저장되지 않고 매번 밖에서 들어오므로, normalize() 가 아니라 여기서
 * 방어적으로 타입을 확인한다(plan-core 는 kv 를 모른다는 원칙 유지).
 */
export function expand(doc, classes, fromISO, toISO, shifts = []) {
  const out = [];

  for (const e of doc.events) {
    if (!e.date) continue;
    if (!e.repeat) {
      if (e.date >= fromISO && e.date <= toISO) {
        out.push(makeOcc({
          source: 'event', id: e.id, date: e.date, start: e.start, end: e.end,
          allDay: e.allDay, important: e.important, color: e.color, place: e.place,
          placeId: e.placeId, travelMin: e.travelMin,
          title: e.title, recurring: false, moved: false, origDate: e.date,
        }));
      }
      continue;
    }
    const occursOnFn = (iso) => occursOnRepeat(e.date, e.repeat, iso);
    const list = expandWithExceptions(occursOnFn, e.exceptions, fromISO, toISO, (origDate, ex, moved) => {
      const date = moved ? ex.date : origDate;
      const start = moved ? (ex.start ?? e.start) : e.start;
      const end = moved ? (ex.end ?? e.end) : e.end;
      const title = moved ? (ex.title ?? e.title) : e.title;
      const place = moved ? (ex.place ?? e.place) : e.place;
      const occ = makeOcc({
        source: 'event', id: e.id, date, start, end, allDay: e.allDay,
        important: e.important, color: e.color, place, title,
        placeId: e.placeId, travelMin: e.travelMin,
        recurring: true, moved, origDate,
      });
      return withOriginalTimes(occ, e.start, e.end);
    });
    out.push(...list);
  }

  if (doc.settings.showClasses) {
    for (const c of classes || []) {
      for (const m of c.meetings || []) {
        const overrideKey = `${c.courseId}:${m.id}`;
        const overrides = doc.classOverrides?.[overrideKey] || {};
        const occursOnFn = (iso) => occursOnClass(c, m, iso);
        const list = expandWithExceptions(occursOnFn, overrides, fromISO, toISO, (origDate, ex, moved) => {
          const date = moved ? ex.date : origDate;
          const start = moved ? (ex.start ?? m.start) : m.start;
          const end = moved ? (ex.end ?? m.end) : m.end;
          const occ = makeOcc({
            source: 'class', id: overrideKey, date, start, end, allDay: false,
            important: false, color: c.color, place: m.room || c.room || '',
            title: c.title, recurring: true, moved, origDate,
          });
          return withOriginalTimes(occ, m.start, m.end);
        });
        out.push(...list);
      }
    }
  }

  // 근무는 반복 개념이 없다 — 스큐가 이미 날짜별로 펼쳐서 보내주므로 그대로 한 회차씩 만든다.
  if (doc.settings.showWork) {
    for (const s of arr(shifts)) {
      if (!s || typeof s !== 'object') continue;
      const date = str(s.date, '');
      if (!date || date < fromISO || date > toISO) continue;
      const start = s.start == null ? null : num(s.start);
      const end = s.end == null ? null : num(s.end);
      out.push(makeOcc({
        source: 'work', id: str(s.id, `work_${date}_${start ?? 0}`),
        date, start, end, allDay: false, important: false, color: WORK_COLOR,
        place: str(s.place, ''), title: str(s.title, '근무'),
        recurring: false, moved: false, origDate: date,
      }));
    }
  }

  for (const t of doc.tasks) {
    if (t.done || !t.slot) continue;
    if (t.slot.date >= fromISO && t.slot.date <= toISO) {
      const end = t.slot.start + t.duration;
      out.push(makeOcc({
        source: 'task', id: t.id, date: t.slot.date, start: t.slot.start, end,
        allDay: false, important: false, color: 0, place: '',
        title: t.title, recurring: false, moved: false, origDate: t.slot.date,
      }));
    }
  }

  out.sort((a, b) => (a.date === b.date ? (a.start ?? 0) - (b.start ?? 0) : cmpISO(a.date, b.date)));
  return out;
}

/* --------------------------------------------------------- 옮기기/없애기 */
// occ 는 expand() 가 만든 occurrence. to = { date, start, end? } (end 없으면 원래 길이 유지).

function durationOf(occ) {
  return occ.start != null && occ.end != null ? occ.end - occ.start : null;
}
function resolveEnd(occ, to) {
  if (to.end != null) return to.end;
  const d = durationOf(occ);
  return d != null && to.start != null ? to.start + d : occ.end;
}

export function moveOnce(doc, occ, to) {
  // 근무는 원본이 스큐에 있다 — 여기서 고쳐도 다음 동기화에 덮이므로 아예 손대지 않는다.
  if (occ.source === 'work') return doc;
  const newStart = to.start;
  const newEnd = resolveEnd(occ, to);

  if (occ.source === 'task') {
    return { ...doc, tasks: doc.tasks.map((t) => (t.id === occ.id ? { ...t, slot: { date: to.date, start: newStart } } : t)) };
  }
  if (occ.source === 'class') {
    const key = occ.id; // `${courseId}:${meetingId}`
    const forKey = { ...(doc.classOverrides[key] || {}) };
    forKey[occ.original.date] = { date: to.date, start: newStart, end: newEnd };
    return { ...doc, classOverrides: { ...doc.classOverrides, [key]: forKey } };
  }
  const ev = doc.events.find((e) => e.id === occ.id);
  if (!ev) return doc;
  if (!ev.repeat) {
    return { ...doc, events: doc.events.map((e) => (e.id === ev.id ? { ...e, date: to.date, start: newStart, end: newEnd } : e)) };
  }
  return {
    ...doc,
    events: doc.events.map((e) => (e.id === ev.id
      ? { ...e, exceptions: { ...e.exceptions, [occ.original.date]: { date: to.date, start: newStart, end: newEnd } } }
      : e)),
  };
}

// 반복 시리즈 분할. weekly 면 원래 요일을 새 요일로 치환(다른 요일은 유지).
function replaceWeeklyDay(repeat, fromISO_orig, toISO_new) {
  if (repeat.freq !== 'weekly') return repeat;
  const fromDow = dowOf(fromISO_orig);
  const toDow = dowOf(toISO_new);
  const base = repeat.days && repeat.days.length ? repeat.days : [fromDow];
  const days = [...new Set(base.map((d) => (d === fromDow ? toDow : d)))].sort((a, b) => a - b);
  return { ...repeat, days };
}

export function moveFollowing(doc, occ, to) {
  if (occ.source !== 'event') return moveOnce(doc, occ, to); // class/task 는 시리즈 개념이 없다
  const ev = doc.events.find((e) => e.id === occ.id);
  if (!ev || !ev.repeat) return moveOnce(doc, occ, to);

  const origDate = occ.original.date;
  const newStart = to.start;
  const newEnd = resolveEnd(occ, to);

  // 시작일 자체를 옮기는 경우 — 분할할 앞부분이 없으므로 원본을 통째로 수정.
  if (origDate === ev.date) {
    const repeat = replaceWeeklyDay(ev.repeat, origDate, to.date);
    return { ...doc, events: doc.events.map((e) => (e.id === ev.id ? { ...e, date: to.date, start: newStart, end: newEnd, repeat } : e)) };
  }

  const untilDate = addDaysISO(origDate, -1);
  // 원래날짜 이후의 exceptions 는 새 이벤트로 옮기지 않고 버린다(단순화 — 새 시리즈는 깨끗하게 시작).
  const keptExceptions = {};
  for (const [k, v] of Object.entries(ev.exceptions || {})) {
    if (cmpISO(k, origDate) < 0) keptExceptions[k] = v;
  }
  const updatedOld = { ...ev, repeat: { ...ev.repeat, until: untilDate }, exceptions: keptExceptions };
  const newRepeat = replaceWeeklyDay(ev.repeat, origDate, to.date);
  const newEvent = {
    ...ev,
    id: uid('ev'),
    date: to.date,
    start: newStart,
    end: newEnd,
    repeat: { ...newRepeat, until: ev.repeat.until },
    exceptions: {},
  };
  return { ...doc, events: [...doc.events.map((e) => (e.id === ev.id ? updatedOld : e)), newEvent] };
}

export function removeOnce(doc, occ) {
  if (occ.source === 'work') return doc; // 위와 같은 이유 — 근무는 읽기 전용.
  if (occ.source === 'task') {
    return { ...doc, tasks: doc.tasks.map((t) => (t.id === occ.id ? { ...t, slot: null } : t)) };
  }
  if (occ.source === 'class') {
    const key = occ.id;
    const forKey = { ...(doc.classOverrides[key] || {}) };
    forKey[occ.original.date] = { skip: true };
    return { ...doc, classOverrides: { ...doc.classOverrides, [key]: forKey } };
  }
  const ev = doc.events.find((e) => e.id === occ.id);
  if (!ev) return doc;
  if (!ev.repeat) {
    return { ...doc, events: doc.events.filter((e) => e.id !== ev.id) };
  }
  return {
    ...doc,
    events: doc.events.map((e) => (e.id === ev.id
      ? { ...e, exceptions: { ...e.exceptions, [occ.original.date]: { skip: true } } }
      : e)),
  };
}

/* ------------------------------------------------------- 속성 편집(제목·장소 등) */
// 시간(date/start/end)이 아닌 속성 변경. important/note/color/allDay 는 시리즈 전체에
// 적용한다(스키마상 exceptions 는 date/start/end/title/place 만 담을 수 있다).
// title/place/date/start/end 는 scope 에 따라 이번 회차(exceptions)/이후 전부(분할)로 나뉜다.

function seriesPatchOf(patch) {
  const out = {};
  for (const k of ['note', 'important', 'color', 'allDay']) if (patch[k] !== undefined) out[k] = patch[k];
  return out;
}

export function editEventOnce(doc, occ, patch) {
  const ev = doc.events.find((e) => e.id === occ.id);
  if (!ev) return doc;
  const seriesPatch = seriesPatchOf(patch);
  const occPatch = { date: patch.date, start: patch.allDay ? null : patch.start, end: patch.allDay ? null : patch.end, title: patch.title, place: patch.place };

  if (!ev.repeat) {
    return { ...doc, events: doc.events.map((e) => (e.id === ev.id ? { ...e, ...seriesPatch, ...occPatch } : e)) };
  }
  return {
    ...doc,
    events: doc.events.map((e) => (e.id === ev.id
      ? { ...e, ...seriesPatch, exceptions: { ...e.exceptions, [occ.original.date]: occPatch } }
      : e)),
  };
}

export function editEventFollowing(doc, occ, patch) {
  const ev = doc.events.find((e) => e.id === occ.id);
  if (!ev || !ev.repeat) return editEventOnce(doc, occ, patch);
  const origDate = occ.original.date;
  const seriesPatch = seriesPatchOf(patch);

  if (origDate === ev.date) {
    const repeat = replaceWeeklyDay(ev.repeat, origDate, patch.date);
    return {
      ...doc,
      events: doc.events.map((e) => (e.id === ev.id
        ? { ...e, ...seriesPatch, date: patch.date, start: patch.start, end: patch.end, title: patch.title, place: patch.place, repeat }
        : e)),
    };
  }
  const untilDate = addDaysISO(origDate, -1);
  const keptExceptions = {};
  for (const [k, v] of Object.entries(ev.exceptions || {})) if (cmpISO(k, origDate) < 0) keptExceptions[k] = v;
  const updatedOld = { ...ev, ...seriesPatch, repeat: { ...ev.repeat, until: untilDate }, exceptions: keptExceptions };
  const newRepeat = replaceWeeklyDay(ev.repeat, origDate, patch.date);
  const newEvent = {
    ...ev, ...seriesPatch,
    id: uid('ev'), date: patch.date, start: patch.start, end: patch.end, title: patch.title, place: patch.place,
    repeat: { ...newRepeat, until: ev.repeat.until }, exceptions: {},
  };
  return { ...doc, events: [...doc.events.map((e) => (e.id === ev.id ? updatedOld : e)), newEvent] };
}

/* --------------------------------------------------------------- CRUD */

export const addEvent = (doc, ev) => ({ ...doc, events: [...doc.events, ev] });
export const replaceEvent = (doc, id, patch) => ({ ...doc, events: doc.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
export const removeEvent = (doc, id) => ({ ...doc, events: doc.events.filter((e) => e.id !== id) });
export const addTask = (doc, t) => ({ ...doc, tasks: [...doc.tasks, t] });
export const replaceTask = (doc, id, patch) => ({ ...doc, tasks: doc.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
export const removeTask = (doc, id) => ({ ...doc, tasks: doc.tasks.filter((t) => t.id !== id) });

export function removeFollowing(doc, occ) {
  if (occ.source !== 'event') return removeOnce(doc, occ);
  const ev = doc.events.find((e) => e.id === occ.id);
  if (!ev || !ev.repeat) return removeOnce(doc, occ);
  const origDate = occ.original.date;
  if (origDate === ev.date) {
    return { ...doc, events: doc.events.filter((e) => e.id !== ev.id) };
  }
  const untilDate = addDaysISO(origDate, -1);
  return { ...doc, events: doc.events.map((e) => (e.id === ev.id ? { ...e, repeat: { ...e.repeat, until: untilDate } } : e)) };
}
