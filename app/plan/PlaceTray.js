'use client';

// 이번 주 시간표 위의 '넣을 할 일' 줄. 하나를 고르거나(탭) 시간표로 끌어다 놓는다.
// 고른 뒤에는 시간표가 배치 모드가 되어, 커서 자리에 그림자 블록과 그 자리의 판정이 뜬다.
import { GripVertical, X } from 'lucide-react';
import { dur } from './todayShared';
import { shortSlot } from './format';

export const DRAG_TYPE = 'application/x-rakan-task';

export default function PlaceTray({ tasks, placingId, onPick, candidates, today }) {
  if (!tasks.length) return null;
  const picked = tasks.find((t) => t.id === placingId);
  return (
    <div className={'rk-pl-tray' + (picked ? ' is-placing' : '')}>
      <p className="rk-pl-tray-h">
        {picked ? (
          <>
            <b>&lsquo;{picked.title}&rsquo;</b> {dur(picked.duration)} — 시간표에서 놓을 자리를 누르세요
            {candidates?.length > 0 && (
              <span className="rk-pl-tray-sug">
                {' '}· 추천 {candidates.map((c) => shortSlot(c.date, c.start, today)).join(', ')}
              </span>
            )}
            <button type="button" className="rk-pl-tray-x" onClick={() => onPick(null)}>
              <X size={13} strokeWidth={1.5} aria-hidden="true" />그만두기
            </button>
          </>
        ) : '시간이 안 정해진 할 일 — 골라서 시간표에 놓거나 끌어다 놓으세요'}
      </p>
      <ul className="rk-pl-tray-list">
        {tasks.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={'rk-pl-tray-chip' + (t.id === placingId ? ' is-on' : '')}
              aria-pressed={t.id === placingId}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, t.id);
                e.dataTransfer.effectAllowed = 'move';
                onPick(t.id);
              }}
              onClick={() => onPick(t.id === placingId ? null : t.id)}
            >
              <GripVertical size={13} strokeWidth={1.5} aria-hidden="true" />
              <span className="rk-pl-tray-t">{t.title}</span>
              <span className="rk-pl-tray-d rk-num">{dur(t.duration)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
