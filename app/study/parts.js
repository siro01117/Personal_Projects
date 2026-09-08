'use client';

// /study 화면들이 함께 쓰는 잔부품.
import { Check, CircleAlert, CloudOff, LoaderCircle, RotateCw } from 'lucide-react';

// 과목색은 globals.css 의 --s1..--s7 (OKLCH 7색). 점·라인·막대에만 쓰고 배경은 칠하지 않는다.
export const courseColor = (c) => `var(--s${((Number(c?.colorIndex) || 0) % 7) + 1})`;

export function Dot({ course, size = 9 }) {
  return (
    <span
      className="rk-dot"
      style={{ '--c': courseColor(course), width: size, height: size }}
      aria-hidden="true"
    />
  );
}

export function Empty({ title, hint, children }) {
  return (
    <div className="rk-empty-box">
      <p className="rk-empty-t">{title}</p>
      {hint && <p className="rk-empty-h">{hint}</p>}
      {children}
    </div>
  );
}

export function Tag({ tone, children }) {
  return <span className={'rk-tag' + (tone ? ` is-${tone}` : '')}>{children}</span>;
}

// 저장 상태는 항상 보인다 — 눌렀는데 반영됐는지 모르는 게 제일 나쁘다.
export function SaveState({ state, onRetry }) {
  if (state === 'saving') {
    return (
      <span className="rk-save is-busy" role="status">
        <LoaderCircle size={14} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />저장 중
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className="rk-save is-ok" role="status">
        <Check size={14} strokeWidth={1.5} aria-hidden="true" />저장됨
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="rk-save is-bad" role="status">
        <CloudOff size={14} strokeWidth={1.5} aria-hidden="true" />
        저장 실패 · 이 기기에 보관됨
        {onRetry && (
          <button type="button" className="rk-save-retry" onClick={onRetry}>
            <RotateCw size={13} strokeWidth={1.5} aria-hidden="true" />다시 시도
          </button>
        )}
      </span>
    );
  }
  return null;
}

export function Notice({ children }) {
  return (
    <p className="rk-notice" role="status">
      <CircleAlert size={15} strokeWidth={1.5} aria-hidden="true" />
      {children}
    </p>
  );
}

// 평가 비중 막대. weight 합이 100이 아니어도(시드가 미완성이어도) 비율로 그린다.
export function WeightBar({ items }) {
  const list = (items || []).filter((g) => Number(g.weight) > 0);
  const total = list.reduce((s, g) => s + Number(g.weight), 0) || 1;
  if (!list.length) return null;
  return (
    <div className="rk-weights">
      <div className="rk-weight-bar" role="img" aria-label={list.map((g) => `${g.label} ${g.weight}%`).join(', ')}>
        {list.map((g, i) => (
          <span
            key={g.id}
            style={{ width: `${(Number(g.weight) / total) * 100}%`, '--c': `var(--s${(i % 7) + 1})` }}
          />
        ))}
      </div>
      <ul className="rk-weight-legend">
        {list.map((g, i) => (
          <li key={g.id}>
            <span className="rk-dot" style={{ '--c': `var(--s${(i % 7) + 1})` }} aria-hidden="true" />
            {g.label}
            <b className="rk-num">{g.weight}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
