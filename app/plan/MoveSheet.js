'use client';

// 옮기기/없애기 시트. 반복(recurring) 이면 이번만/앞으로 계속을 나누고, 수업은
// '이번만'만 허용한다(앞으로 계속은 비활성 — 시간표는 학습 모듈에서 바꾼다).
import { useState } from 'react';
import { CalendarClock, Check, TriangleAlert, X } from 'lucide-react';
import { dowOf, fmtTime, todayISO } from '../../lib/plan-core';
import { suggest } from '../../lib/plan-suggest';
import { shortDate, shortSlot } from './format';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

// 반복 규칙을 "매주 월·수" / "매일" 처럼 사람이 읽을 문구로. until 이 있으면 "~ 10/30" 을 덧붙인다.
function repeatLabel(repeat, fallbackDow) {
  if (!repeat) return '반복 일정';
  let label;
  if (repeat.freq === 'daily') {
    label = '매일';
  } else {
    const days = repeat.days && repeat.days.length ? repeat.days : [fallbackDow];
    label = `매주 ${days.map((d) => DOW[d]).join('·')}`;
  }
  if (repeat.until) {
    label += ` ~ ${Number(repeat.until.slice(5, 7))}/${Number(repeat.until.slice(8, 10))}`;
  }
  return label;
}

export default function MoveSheet({ occ, occurrences, events, settings, onMove, onRemove, onClose }) {
  const [tab, setTab] = useState('move');
  const isClass = occ.source === 'class';
  const isTask = occ.source === 'task';
  const recurring = occ.recurring && !isTask;
  const sourceEvent = occ.source === 'event' ? events?.find((e) => e.id === occ.id) : null;
  const [scope, setScope] = useState('once');
  const [custom, setCustom] = useState(false);
  const [customDate, setCustomDate] = useState(occ.date);
  const [customStart, setCustomStart] = useState(fmtTime(occ.start));
  const [picked, setPicked] = useState(null);

  const duration = occ.start != null && occ.end != null ? occ.end - occ.start : 60;
  const others = occurrences.filter((o) => o.key !== occ.key);
  const candidates = suggest({
    occurrences: others, duration, fromISO: occ.date, days: 14, settings,
    nowISO: occ.date, target: { date: occ.date, start: occ.start }, limit: 3,
  });

  function toMin(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function confirmMove() {
    const to = custom
      ? { date: customDate, start: toMin(customStart) }
      : picked ? { date: picked.date, start: picked.start } : null;
    if (!to || to.start == null) return;
    onMove({ scope: recurring ? scope : 'once', to });
  }

  return (
    <div className="rk-pl-sheet-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rk-pl-sheet" role="dialog" aria-modal="true">
        <div className="rk-pl-sheet-h">
          <CalendarClock size={19} strokeWidth={1.5} aria-hidden="true" />
          <h2 className="rk-pl-sheet-t">{occ.title}</h2>
          <button type="button" className="rk-pl-sheet-x" onClick={onClose} aria-label="닫기"><X size={18} strokeWidth={1.5} aria-hidden="true" /></button>
        </div>
        <p className="rk-pl-sheet-sub">
          <span className="rk-num">{shortDate(occ.date)}</span> ·{' '}
          {occ.allDay ? '종일' : <span className="rk-num">{fmtTime(occ.start)}–{fmtTime(occ.end)}</span>}
          {recurring && <> · {repeatLabel(sourceEvent?.repeat, dowOf(occ.original?.date ?? occ.date))}</>}
        </p>

        <div className="rk-pl-seg">
          <button type="button" className={tab === 'move' ? 'is-on' : ''} onClick={() => setTab('move')}>옮기기</button>
          <button type="button" className={tab === 'remove' ? 'is-on' : ''} onClick={() => setTab('remove')}>없애기</button>
        </div>

        {tab === 'move' ? (
          <>
            {recurring && (
              <>
                <div className="rk-pl-seg">
                  <button type="button" className={scope === 'once' ? 'is-on' : ''} onClick={() => setScope('once')}>이번만</button>
                  <button type="button" className={scope === 'following' ? 'is-on' : ''} disabled={isClass}
                    onClick={() => setScope('following')}>앞으로 계속</button>
                </div>
                {isClass && <p className="rk-pl-seg-note">수업 시간표는 학습 모듈에서 바꿉니다.</p>}
              </>
            )}

            <label className="rk-lab" style={{ margin: '2px 0 8px' }}>추천 시간</label>
            {candidates.length === 0 ? (
              <p className="rk-pl-hint">14일 안에서는 빈 시간을 찾지 못했습니다. 직접 골라 주세요.</p>
            ) : (
              <div className="rk-pl-cands">
                {candidates.map((c) => {
                  const isOn = picked === c;
                  return (
                    <button key={`${c.date}-${c.start}`} type="button"
                      className={'rk-pl-cand' + (isOn ? ' is-on' : '')}
                      onClick={() => { setPicked(c); setCustom(false); }}
                      aria-pressed={isOn}
                    >
                      <span className="rk-pl-cand-head">
                        <span className="rk-pl-cand-d rk-num">{shortSlot(c.date, c.start, todayISO())}</span>
                        {isOn && <Check size={14} strokeWidth={2} aria-hidden="true" />}
                      </span>
                      {c.reasons?.length > 0 && <span className="rk-pl-cand-r">{c.reasons.slice(0, 2).join(' · ')}</span>}
                    </button>
                  );
                })}
              </div>
            )}

            <button type="button" className="rk-pl-more-link" onClick={() => { setCustom((v) => !v); setPicked(null); }}>
              {custom ? '직접 고르기 접기' : '직접 고르기'}
            </button>
            {custom && (
              <div className="rk-pl-picker" style={{ marginTop: 10 }}>
                <input className="rk-input" type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
                <input className="rk-input" type="time" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
              </div>
            )}

            <div className="rk-pl-sheet-foot">
              <button type="button" className="rk-btn" onClick={onClose}>취소</button>
              <button type="button" className="rk-btn rk-btn-fill" style={{ marginTop: 0 }}
                disabled={!custom && !picked} onClick={confirmMove}>옮기기</button>
            </div>
          </>
        ) : (
          <>
            <p className="rk-pl-warn"><TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
              {isTask ? '이 일정에서 빼고 다시 "언젠가 할 일"로 돌아갑니다.' : '삭제하면 되돌릴 수 없습니다(직후 5초 동안은 되돌리기가 가능합니다).'}
            </p>
            <div className="rk-pl-sheet-foot">
              {isTask || (!recurring) ? (
                <button type="button" className="rk-btn rk-btn-fill" style={{ marginTop: 0 }} onClick={() => onRemove({ scope: 'once' })}>삭제</button>
              ) : (
                <>
                  <button type="button" className="rk-btn" onClick={() => onRemove({ scope: 'once' })}>이번만 없애기</button>
                  <button type="button" className="rk-btn rk-btn-fill" style={{ marginTop: 0 }} disabled={isClass}
                    onClick={() => onRemove({ scope: 'following' })}>이후 전부 없애기</button>
                </>
              )}
            </div>
            {isClass && <p className="rk-pl-seg-note">수업은 이번 회차만 없앨 수 있습니다.</p>}
          </>
        )}
      </div>
    </div>
  );
}
