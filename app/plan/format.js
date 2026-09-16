// /plan 전용 짧은 날짜·시각 포맷터. "09/18(금) 08:00" 처럼 긴 표기 대신 문맥에 따라
// 오늘/내일/요일/날짜 중 가장 짧고 자연스러운 것 하나만 남긴다. 여러 화면(개요의 제안
// 버튼·펼침 후보·오늘 빈 시간 칩, MoveSheet 후보)이 이 포맷을 공유해 표기가 서로 어긋나지
// 않게 한다.
import { dowOf, diffDaysISO } from '../../lib/plan-core';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

// 시는 앞자리 0 없이, 분은 두 자리 — "8:00", "18:30".
function hm(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// "오늘 18:30" / "내일 8:00" / "금 8:00"(2~7일 안) / "9/25 8:00"(그 밖)
export function shortSlot(dateISO, start, todayISO) {
  const time = hm(start);
  const d = diffDaysISO(todayISO, dateISO);
  if (d === 0) return `오늘 ${time}`;
  if (d === 1) return `내일 ${time}`;
  if (d > 1 && d <= 7) return `${DOW[dowOf(dateISO)]} ${time}`;
  const mm = Number(dateISO.slice(5, 7));
  const dd = Number(dateISO.slice(8, 10));
  return `${mm}/${dd} ${time}`;
}

// 날짜만 짧게 — "9/19 토" (특별한 약속 메타, 옮기기 시트 헤더 등에 시간 범위와 함께 쓴다)
export function shortDate(dateISO) {
  const mm = Number(dateISO.slice(5, 7));
  const dd = Number(dateISO.slice(8, 10));
  return `${mm}/${dd} ${DOW[dowOf(dateISO)]}`;
}
