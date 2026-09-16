'use client';

// 일정/할 일 추가·수정 시트. 모바일 = 하단 시트, PC = 가운데 모달(rk-pl-sheet-* / globals.css).
// 입력 규칙: onChange 에서는 값을 그대로 상태에 둔다. 포맷·보정은 blur/저장 시에만
// (과거 onChange 패딩으로 11→01 버그가 났다 — RENEWAL.md 밖의 사용자 규칙).
import { useEffect, useRef, useState } from 'react';
import { CalendarClock, ClipboardList, X } from 'lucide-react';
import { fmtTime, todayISO, uid } from '../../lib/plan-core';

const COLOR_COUNT = 7;
const DUR_CHIPS = [15, 30, 60, 90, 120];
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function useEscAndOutside(onClose) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return ref;
}

function toMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function Field({ label, children }) {
  return (
    <div style={{ marginTop: 14 }}>
      <label className="rk-lab" style={{ margin: '0 0 7px' }}>{label}</label>
      {children}
    </div>
  );
}

function EventForm({ initial, occ, defaultDate, defaultStart, defaultRepeat, defaultImportant, onSave, onClose }) {
  const ev = initial;
  const editingOccurrence = !!occ && !!ev?.repeat; // 반복 회차 편집 — 반복 패턴 자체는 여기서 건드리지 않는다
  const [title, setTitle] = useState(ev?.title || '');
  const [date, setDate] = useState((occ ? occ.date : ev?.date) || defaultDate || todayISO());
  const [allDay, setAllDay] = useState(ev?.allDay || false);
  const initStart = occ ? occ.start : ev?.start;
  const initEnd = occ ? occ.end : ev?.end;
  const [startRaw, setStartRaw] = useState(initStart != null ? fmtTime(initStart) : (defaultStart != null ? fmtTime(defaultStart) : '09:00'));
  const [endRaw, setEndRaw] = useState(initEnd != null ? fmtTime(initEnd) : (defaultStart != null ? fmtTime(defaultStart + 60) : '10:00'));
  const [place, setPlace] = useState(ev?.place || '');
  const [note, setNote] = useState(ev?.note || '');
  const [important, setImportant] = useState(ev?.important ?? defaultImportant ?? false);
  const [color, setColor] = useState(ev?.color ?? 0);
  const [repeatFreq, setRepeatFreq] = useState(ev?.repeat?.freq || (defaultRepeat ? 'weekly' : 'none'));
  const [repeatDays, setRepeatDays] = useState(ev?.repeat?.days || []);
  const [repeatUntil, setRepeatUntil] = useState(ev?.repeat?.until || '');
  const [scope, setScope] = useState('once');
  const [err, setErr] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!title.trim()) { setErr('제목을 입력해 주세요.'); return; }
    const start = allDay ? null : toMin(startRaw);
    const end = allDay ? null : toMin(endRaw);
    if (!allDay && (start == null || end == null)) { setErr('시작·종료 시각을 확인해 주세요.'); return; }
    if (!allDay && end <= start) { setErr('종료 시각이 시작보다 뒤여야 합니다.'); return; }

    const common = { title: title.trim(), place: place.trim(), note, important, color, allDay };

    if (editingOccurrence) {
      const patch = { ...common, date, start, end };
      onSave({ mode: 'occurrence', scope, occ, patch });
      return;
    }

    let repeat = null;
    if (repeatFreq === 'daily') repeat = { freq: 'daily', until: repeatUntil || null };
    else if (repeatFreq === 'weekly') repeat = { freq: 'weekly', days: repeatDays.length ? repeatDays : [new Date(`${date}T00:00:00`).getDay()], until: repeatUntil || null };

    if (ev) {
      onSave({ mode: 'series', id: ev.id, patch: { ...common, date, start, end, repeat } });
    } else {
      onSave({ mode: 'new', event: { id: uid('ev'), ...common, date, start, end, repeat, exceptions: {} } });
    }
  }

  return (
    <form onSubmit={submit}>
      <Field label="제목">
        <input className="rk-input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>

      <div className="rk-pl-row2">
        <Field label="날짜">
          <input className="rk-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="종일">
          <label className="rk-check" style={{ minHeight: 44 }}>
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            종일 일정
          </label>
        </Field>
      </div>

      {!allDay && (
        <div className="rk-pl-row2">
          <Field label="시작"><input className="rk-input" type="time" value={startRaw} onChange={(e) => setStartRaw(e.target.value)} /></Field>
          <Field label="종료"><input className="rk-input" type="time" value={endRaw} onChange={(e) => setEndRaw(e.target.value)} /></Field>
        </div>
      )}

      <Field label="장소"><input className="rk-input" value={place} onChange={(e) => setPlace(e.target.value)} /></Field>
      <Field label="메모"><textarea className="rk-input rk-area" value={note} onChange={(e) => setNote(e.target.value)} /></Field>

      <Field label="특별한 약속">
        <label className="rk-check">
          <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} />
          7일 밖이어도 따로 모아 보여줍니다
        </label>
      </Field>

      <Field label="색">
        <div className="rk-pl-colors">
          {Array.from({ length: COLOR_COUNT }, (_, i) => (
            <button key={i} type="button" className={'rk-pl-color-dot' + (color === i ? ' is-on' : '')}
              style={{ '--c': `var(--s${i + 1})` }} onClick={() => setColor(i)} aria-label={`색 ${i + 1}`} />
          ))}
        </div>
      </Field>

      {editingOccurrence ? (
        <Field label="적용 범위">
          <div className="rk-pl-seg">
            <button type="button" className={scope === 'once' ? 'is-on' : ''} onClick={() => setScope('once')}>이번만</button>
            <button type="button" className={scope === 'following' ? 'is-on' : ''} onClick={() => setScope('following')}>앞으로 계속</button>
          </div>
        </Field>
      ) : (
        <Field label="반복">
          <div className="rk-pl-chips">
            {[['none', '없음'], ['daily', '매일'], ['weekly', '매주']].map(([k, l]) => (
              <button key={k} type="button" className={'rk-pl-chip' + (repeatFreq === k ? ' is-on' : '')} onClick={() => setRepeatFreq(k)}>{l}</button>
            ))}
          </div>
          {repeatFreq === 'weekly' && (
            <div className="rk-pl-chips" style={{ marginTop: 8 }}>
              {DOW.map((d, i) => (
                <button key={i} type="button" className={'rk-pl-chip' + (repeatDays.includes(i) ? ' is-on' : '')}
                  onClick={() => setRepeatDays((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort()))}>
                  {d}
                </button>
              ))}
            </div>
          )}
          {repeatFreq !== 'none' && (
            <div style={{ marginTop: 10 }}>
              <label className="rk-lab" style={{ margin: '0 0 7px' }}>종료일 (선택)</label>
              <input className="rk-input" type="date" value={repeatUntil} onChange={(e) => setRepeatUntil(e.target.value)} />
            </div>
          )}
        </Field>
      )}

      {err && <p className="rk-err" role="alert">{err}</p>}
      <div className="rk-pl-sheet-foot">
        <button type="button" className="rk-btn" onClick={onClose}>취소</button>
        <button type="submit" className="rk-btn rk-btn-fill" style={{ marginTop: 0 }}>저장</button>
      </div>
    </form>
  );
}

function TaskForm({ initial, onSave, onClose }) {
  const t = initial;
  const [title, setTitle] = useState(t?.title || '');
  const [durationRaw, setDurationRaw] = useState(String(t?.duration ?? 60));
  const [due, setDue] = useState(t?.due || '');
  const [priority, setPriority] = useState(t?.priority || 'normal');
  const [note, setNote] = useState(t?.note || '');
  const [err, setErr] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!title.trim()) { setErr('제목을 입력해 주세요.'); return; }
    const duration = Math.max(5, Number(durationRaw) || 60);
    const patch = { title: title.trim(), duration, due: due || null, priority, note };
    if (t) onSave({ mode: 'edit', id: t.id, patch });
    else onSave({ mode: 'new', task: { id: uid('tk'), ...patch, slot: null, done: false, doneAt: null } });
  }

  return (
    <form onSubmit={submit}>
      <Field label="제목"><input className="rk-input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>

      <Field label="소요 시간">
        <div className="rk-pl-chips">
          {DUR_CHIPS.map((d) => (
            <button key={d} type="button" className={'rk-pl-chip' + (Number(durationRaw) === d ? ' is-on' : '')}
              onClick={() => setDurationRaw(String(d))}>{d}분</button>
          ))}
        </div>
        <input
          className="rk-input" style={{ marginTop: 8, maxWidth: 140 }}
          type="text" inputMode="numeric" value={durationRaw}
          onChange={(e) => setDurationRaw(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => setDurationRaw(String(Math.max(5, Number(durationRaw) || 60)))}
        />
      </Field>

      <div className="rk-pl-row2">
        <Field label="마감일 (선택)"><input className="rk-input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="우선순위">
          <select className="rk-input rk-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="high">중요</option>
            <option value="normal">보통</option>
            <option value="low">낮음</option>
          </select>
        </Field>
      </div>

      <Field label="메모"><textarea className="rk-input rk-area" value={note} onChange={(e) => setNote(e.target.value)} /></Field>

      {err && <p className="rk-err" role="alert">{err}</p>}
      <div className="rk-pl-sheet-foot">
        <button type="button" className="rk-btn" onClick={onClose}>취소</button>
        <button type="submit" className="rk-btn rk-btn-fill" style={{ marginTop: 0 }}>저장</button>
      </div>
    </form>
  );
}

export default function EditSheet({
  kind, initial, occ, defaultDate, defaultStart, defaultRepeat, defaultImportant,
  onSaveEvent, onSaveTask, onClose,
}) {
  const ref = useEscAndOutside(onClose);
  const isEvent = kind === 'event';
  return (
    <div className="rk-pl-sheet-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rk-pl-sheet" ref={ref} role="dialog" aria-modal="true">
        <div className="rk-pl-sheet-h">
          {isEvent
            ? <CalendarClock size={19} strokeWidth={1.5} aria-hidden="true" />
            : <ClipboardList size={19} strokeWidth={1.5} aria-hidden="true" />}
          <h2 className="rk-pl-sheet-t">{initial ? (isEvent ? '일정 수정' : '할 일 수정') : (isEvent ? '일정 추가' : '할 일 추가')}</h2>
          <button type="button" className="rk-pl-sheet-x" onClick={onClose} aria-label="닫기">
            <X size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
        {isEvent
          ? (
            <EventForm
              initial={initial} occ={occ} defaultDate={defaultDate} defaultStart={defaultStart}
              defaultRepeat={defaultRepeat} defaultImportant={defaultImportant}
              onSave={onSaveEvent} onClose={onClose}
            />
          )
          : <TaskForm initial={initial} onSave={onSaveTask} onClose={onClose} />}
      </div>
    </div>
  );
}
