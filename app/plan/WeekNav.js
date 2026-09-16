'use client';

// 주 이동 ‹ › — 월요일 고정 주를 한 주씩 넘긴다. 이번 주가 아니면 '이번 주로' 복귀 버튼이 붙는다.
// days 를 주면 "9/14–9/20" 기간 표시도 같이 한다(시간표 페이지용).
import { ChevronLeft, ChevronRight } from 'lucide-react';

const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

export default function WeekNav({ offset, onChange, days }) {
  if (!onChange) return null;
  return (
    <span className="rk-pl-weeknav">
      {days && <span className="rk-pl-weeknav-r rk-num">{md(days[0])}–{md(days[6])}</span>}
      <button type="button" onClick={() => onChange(offset - 1)} aria-label="지난 주">
        <ChevronLeft size={15} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {offset !== 0 && (
        <button type="button" className="rk-pl-weeknav-now" onClick={() => onChange(0)}>이번 주로</button>
      )}
      <button type="button" onClick={() => onChange(offset + 1)} aria-label="다음 주">
        <ChevronRight size={15} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </span>
  );
}
