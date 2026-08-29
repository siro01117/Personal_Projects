'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import {
  saveSeatPositions, updateSeat, removeSeat, assignSeat, releaseSeat,
  setSeatStatus, addStudent, createRoom,
} from './actions';
import { checkIn, checkOut } from './attendanceActions';
import { updateRoom, deleteRoom, saveRoomPositions } from './roomActions';
import StudentPopup, { ReleaseSeatIcon, MoveSeatIcon } from '../_shared/StudentPopup';
import ContextMenu, { type MenuItem } from '../_shared/ContextMenu';
import { useLongPress } from '../_shared/useLongPress';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { recordPatrol, clearPatrolMark, startPatrol, endPatrol, getPatrolSessionDetail, type OpenPatrolSession } from './patrolActions';
import { PATROL_STATES, PATROL_BY_KEY } from '../../../lib/patrol';
import {
  statusAt, ghostStyleOf, reasonColor, isPatrolExempt, checkoutBranchAt,
  type DaySlot, type Period, type ActualAttendance, type CheckoutBranch,
} from '../../../lib/schedule';
import { CHECKOUT_REASON_PRESETS, CHECKOUT_OTHER_REASON, CHECKOUT_REASON_KEY } from '../../../lib/attendance';
import { tint, line, ink, solid } from '../../../lib/semantic-color';
import { needsAttentionCheck, type OccKind, type SeatOcc } from '../../../lib/occupancy';

// ---------------- types ----------------
export type Room = { id: string; name: string; floor: number; cols: number; rows: number; pos_x: number; pos_y: number; door_side: string | null };
export type Seat = {
  id: string; room_id: string | null; grid_x: number | null; grid_y: number | null;
  number: number | null; label: string; seat_type: string | null; facing: string | null;
  status: string; current_student_id: string | null;
};
export type Student = {
  id: string; name: string; level: string | null; grade: string | null; is_repeat: boolean | null;
  school: string | null; status: string; birthdate: string | null; gender: string | null;
  guardian_phone: string | null; student_phone: string | null; enrolled_at: string | null;
};

type EditSeat = {
  id: string; x: number; y: number; number: number | null; status: string;
  current_student_id: string | null; facing: string | null; seat_type: string | null;
  label: string; isNew?: boolean;
};

// ---------------- constants ----------------
const SW = 82, SH = 60, HW = 41, HH = 30, STEP = 20, SNAP = 10;
// 격자 셀: 좌석(82×60)이 100×80 칸에 들어감 → 가로 18 / 세로 20 여백. 전부 STEP(20)의 배수라 격자에 딱 맞음.
const CELL_X = 100, CELL_Y = 80, ORIGIN = 40, PER_ROW = 6;
const EDIT_W = 1140, EDIT_H = 640;
const FACINGS = ['down', 'up', 'left', 'right'];
const FACE_LABEL: Record<string, string> = { down: '↓ 아래', up: '↑ 위', left: '← 왼쪽', right: '→ 오른쪽' };
const SEAT_STATUS: Record<string, string> = { empty: '공석', occupied: '사용중', maintenance: '점검' };

// 이번 순찰 세션 중에 클라에서 찍은 마크 — state/points 만 즉시 반영된다(순찰 모드 전용 배지).
type PatrolMark = { state: string; points: number };

// ---------------- 스케쥴 고스트(오늘 요일 기준 학생별 파생 정보) ----------------
// page.tsx 에서 branch 전체를 3개 쿼리로 읽어 memory join(모바일 순찰 page.tsx 와 동일 패턴).
// hours 도 slots 도 없으면(=이 학생은 스케쥴 정보가 아예 없음) 고스트를 그리지 않는다.
export type ScheduleInfo = { hours: { arrive_min: number; leave_min: number } | null; slots: DaySlot[] };
type Ghost = { state: 'scheduled' | 'study' | 'break' | 'away' | 'none'; label: string; slot?: DaySlot };

// scheduled 상태 예상 표시 색 · 배경/스트립/흐림 계산은 src/lib/schedule.ts 의 REASON_SEMANTIC/ghostStyleOf/reasonColor
// (모바일 MobilePatrol.tsx 와 공용 — 계산이 갈리지 않도록 여기서 재정의하지 않는다).

// KST 기준 분(minute-of-day) 계산 — new Date() 호출은 반드시 useEffect/이벤트 핸들러 안에서만 이 함수를 통해.
function kstNowMin(): number {
  const d = new Date();
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 540) % 1440;
}
// nowMin(분) → "HH:MM" — 순수 포맷팅, Date 미사용.
function fmtHM(min: number): string {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 순찰 경과 시간 — 자체 타이머를 갖는 독립 컴포넌트. 매초 이 작은 조각만 리렌더되고
// 부모(FloorEditor)와 좌석 90개는 건드리지 않는다.
function PatrolElapsed({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  const el = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const hh = Math.floor(el / 3600), mm = Math.floor((el % 3600) / 60), ss = el % 60;
  const s = (hh > 0 ? hh + ':' : '') + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  return <b style={{ color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{s}</b>;
}

// ---------------- 출결(입·퇴실 상태 = 순찰/출결 중 더 최근 기록) ----------------
// occupancy(재실/부재 + title)는 page.tsx 가 src/lib/occupancy.ts 의 buildOccupancy() 로 서버에서
// 미리 계산해 내려준다 — 오늘 마지막 순찰 기록과 마지막 출결 기록 중 시각이 더 늦은 쪽(동시각이면 출결)을
// 이미 반영한 최종값이므로, 클라에서는 우선순위 비교 없이 그대로 쓴다(수동 버튼 클릭 직후 revalidatePath
// 로 이 값이 새로 내려오면 그게 곧 화면에 반영된다 — 예전엔 순찰 기록이 있으면 항상 그걸 우선해 수동
// 입/퇴실을 눌러도 화면이 안 바뀌는 버그가 있었다).
export type AttInfo = OccKind;
const ATT_LABEL: Record<AttInfo, string> = { in: '재실', out: '하원' };
// "확인 필요" 배지의 title — occ 가 없어(attTitle=undefined) 다른 title 이 안 잡힌 좌석에만 대신 채운다.
const ATTENTION_TITLE = '확인 필요 — 지금 자리에 있어야 하는데 오늘 출결·순찰 기록이 없습니다';
// 재실(in) = 순찰 '입석'/스케쥴 '자습'과 같은 의미 → SEMANTIC.present 재사용. 하원(out)은 무채색(none).
const ATT_COLOR: Record<AttInfo, { bg: string; bd: string }> = {
  in: { bg: tint('present', 15), bd: line('present', 55) },
  out: { bg: tint('none', 12), bd: line('none', 40) },
};

// 퇴실 확인창 사유 버튼 색 — 라벨→SemanticKey 매핑은 attendance.ts CHECKOUT_REASON_KEY(단일 정의),
// 색 계산은 semantic-color.ts 함수 그대로 사용(화면에 새 헥스 추가 안 함). filled=true 는 확정 선택 상태
// (예: '기타' 눌러 입력칸이 열린 상태)로 채워진 배경 — 나머지는 옅은 톤.
function checkoutReasonStyle(label: string, filled: boolean): CSSProperties {
  const key = CHECKOUT_REASON_KEY[label as keyof typeof CHECKOUT_REASON_KEY] ?? 'none';
  return filled
    ? { backgroundColor: solid(key), borderColor: solid(key), color: '#fff' }
    : { backgroundColor: tint(key, 16), borderColor: line(key, 55), color: ink(key) };
}

// 대시보드 통계 타일 — 순수 프레젠테이션. 모듈 스코프에 두어 리렌더마다 재마운트 방지.
function Tile({ label, value, color, span = 1, sub }: { label: string; value: string | number; color?: string; span?: number; sub?: string }) {
  return (
    <div className="card" style={{ gridColumn: `span ${span}`, padding: '16px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ fontSize: 12.5, color: 'var(--faint)' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: color ?? 'var(--txt)', marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function lbl(s: Pick<Student, 'level' | 'grade' | 'is_repeat'>): string {
  if (s.level === 'adult') return s.is_repeat ? '성인·N수생' : '성인';
  const lv = s.level === 'middle' ? '중' : s.level === 'high' ? '고' : '';
  return lv && s.grade ? `${lv}${s.grade}` : lv || s.grade || '';
}

function ageFrom(bd: string | null): number | null {
  if (!bd) return null;
  const b = new Date(bd);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) a--;
  return a;
}

// 팝업 정보 한 칸
function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>{k}</div>
      <div style={{ fontWeight: 600, marginTop: 1 }}>{v}</div>
    </div>
  );
}

// 좌석 픽셀 위치 (null 이면 인덱스 기반 폴백)
function seatXY(s: Seat, i: number): { x: number; y: number } {
  const x = s.grid_x == null ? ORIGIN + (i % PER_ROW) * CELL_X : s.grid_x;
  const y = s.grid_y == null ? ORIGIN + Math.floor(i / PER_ROW) * CELL_Y : s.grid_y;
  return { x, y };
}

function bounds(list: { x: number; y: number }[]): { w: number; h: number } {
  if (!list.length) return { w: 340, h: 240 };
  const maxX = Math.max(...list.map((s) => s.x + SW));
  const maxY = Math.max(...list.map((s) => s.y + SH));
  return { w: maxX + 40, h: maxY + 40 };
}

// ---------------- icons ----------------
const Ic = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" className="ic" style={{ width: size, height: size }}><path d={d} /></svg>
);
const I_EDIT = 'M14 7l3 3M5 19l6-6M17 3a4 4 0 00-5 5L3 17v4h4l9-9a4 4 0 005-5z';
const I_PLUS = 'M12 5v14M5 12h14';
const I_CHECK = 'M5 12l5 5L20 7';
const I_CLOSE = 'M6 6l12 12M18 6L6 18';
const I_GRID = 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z';
const I_TRASH = 'M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3M10 11v6M14 11v6';
const I_GEAR = 'M4 8h10M18 8h2M4 16h2M10 16h10M14 6v4M8 14v4'; // 슬라이더형 설정 아이콘
const I_PATROL = 'M12 3l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V6z'; // 방패(순찰)
const I_CLOCK = 'M12 21a9 9 0 110-18 9 9 0 010 18M12 8v4l3 2'; // 시계(순찰 기록)
const I_LOGOUT = 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9'; // 퇴실(문 밖으로 화살표)

// ---------------- 좌석 프레젠테이션 헬퍼 (state 미사용 → 모듈 스코프) ----------------
// 조건부로 바뀌는 색은 항상 개별 속성(borderColor/backgroundColor/opacity)으로 통일한다 — border/background
// 축약형과 섞으면 React 의 style diff 가 "사라진 속성" 을 축약형이 다시 채워주기 전에 지워버려(clear 가
// 먼저, 값 적용이 나중) 렌더가 이전 값으로 눌어붙거나 깨진다(과거에도 같은 원인으로 경고가 났던 패턴).
// opacity 도 기본값을 항상 갖고 있어야 같은 이유로 "적용 안 됨" 현상이 재발하지 않는다.
// 좌석 테두리 두께·라운드 — 고스트 좌측 스트립을 테두리 안쪽으로 들일 때도 이 값을 참조한다(하드코딩 금지).
const SEAT_BORDER_W = 1.5;
const SEAT_RADIUS = 12;
const seatStyle = (status: string, sel: boolean, editable: boolean): CSSProperties => ({
  position: 'absolute', width: SW, height: SH, borderRadius: SEAT_RADIUS,
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
  userSelect: 'none', padding: 2,
  borderWidth: SEAT_BORDER_W, borderStyle: 'solid',
  borderColor: sel ? 'var(--accent)' : status === 'occupied' ? 'rgba(91,141,239,.5)' : status === 'maintenance' ? 'rgba(201,138,43,.5)' : 'var(--line)',
  backgroundColor: status === 'occupied' ? 'rgba(91,141,239,.14)' : status === 'maintenance' ? 'rgba(201,138,43,.16)' : 'var(--panel2)',
  opacity: 1,
  boxShadow: sel ? '0 0 0 3px rgba(91,141,239,.25)' : undefined,
  cursor: editable ? 'grab' : 'pointer', transition: 'box-shadow .12s, border-color .12s',
});
const faceStyle = (f: string | null): CSSProperties => {
  const base: CSSProperties = { position: 'absolute', background: 'var(--accent)', borderRadius: 3, opacity: 0.85 };
  const ff = f || 'down';
  if (ff === 'down') return { ...base, left: 22, right: 22, bottom: -1, height: 3 };
  if (ff === 'up') return { ...base, left: 22, right: 22, top: -1, height: 3 };
  if (ff === 'left') return { ...base, top: 18, bottom: 18, left: -1, width: 3 };
  return { ...base, top: 18, bottom: 18, right: -1, width: 3 };
};
const seatInner = (num: number | null, label: string, who: string | null) => (
  who ? (
    // 배정된 좌석: 번호는 좌상단에 작게, 이름 가운데 — 번호·이름 같은 톤
    <>
      <span style={{ position: 'absolute', top: 4, left: 6, fontSize: 9, fontWeight: 700, color: 'var(--faint)', lineHeight: 1 }}>{num ?? label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--dim)', maxWidth: 74, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1 }}>{who}</span>
    </>
  ) : (
    // 공석: 번호만 가운데
    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--faint)', lineHeight: 1 }}>{num ?? label}</span>
  )
);

// 방 입구(문) 마커 — 방 블록의 지정된 벽에 '입구' 표시
const doorMark = (side: string | null) => {
  if (!side) return null;
  const pill: CSSProperties = {
    position: 'absolute', zIndex: 6, background: 'var(--accent)', color: '#fff', fontSize: 10, fontWeight: 800,
    padding: '2px 8px', borderRadius: 999, lineHeight: 1.4, whiteSpace: 'nowrap', boxShadow: '0 1px 3px rgba(0,0,0,.2)',
  };
  if (side === 'top') return <span style={{ ...pill, top: -11, left: '50%', transform: 'translateX(-50%)' }}>입구</span>;
  if (side === 'bottom') return <span style={{ ...pill, bottom: -11, left: '50%', transform: 'translateX(-50%)' }}>입구</span>;
  if (side === 'left') return <span style={{ ...pill, left: -16, top: '50%', transform: 'translateY(-50%) rotate(-90deg)' }}>입구</span>;
  return <span style={{ ...pill, right: -16, top: '50%', transform: 'translateY(-50%) rotate(90deg)' }}>입구</span>;
};

// ---------------- 좌석 상호작용 컨텍스트 (부모의 안정적 핸들러 묶음) ----------------
type SeatMenuState = { x: number; y: number; seat: Seat };
type CallFn = (action: (fd: FormData) => Promise<unknown>, fields: Record<string, string | number>, after?: () => void) => void;
type SeatCtx = {
  moveTo: (s: Seat) => void;
  openSeat: (id: string) => void;
  setPatrolMenu: (v: SeatMenuState | null) => void;
  setSeatMenu: (v: SeatMenuState | null) => void;
  call: CallFn;
};

// 정적(보기/전체보기) 좌석 — 모듈 스코프 + memo. 부모 state 변경 시 element.type 정체성이
// 유지되어 좌석이 재마운트되지 않는다(box-shadow 트랜지션·번호 input 포커스 보존).
type StaticSeatProps = {
  s: Seat; i: number; clickable: boolean;
  numberEditMode: boolean;
  stuById: Map<string, Student>;
  occ: SeatOcc | undefined; // 오늘 재실/부재 최종 판정(순찰·출결 중 더 최근 것) — page.tsx 에서 서버 계산
  patrolMode: boolean;
  patrolMark: PatrolMark | undefined;
  ghost: Ghost | undefined;
  needsAttention: boolean; // "확인 필요" — 순찰 모드 중엔 항상 false 로 넘어온다(호출부에서 게이트)
  movingStudentId: string | null;
  ctx: SeatCtx;
};
const StaticSeat = memo(function StaticSeat({
  s, i, clickable, numberEditMode, stuById, occ, patrolMode, patrolMark, ghost, needsAttention, movingStudentId, ctx,
}: StaticSeatProps) {
  const { moveTo, openSeat, setPatrolMenu, setSeatMenu, call } = ctx;
  // 터치 꾹누르기 = 좌석 컨텍스트 메뉴(데스크톱 우클릭 대체). 순찰/이동 중엔 비활성.
  // 좌석마다 자체 useLongPress — 부모 ctx 를 오염시키지 않아 memo 경계가 유지된다.
  const lp = useLongPress<Seat>((seat, x, y) => {
    if (!movingStudentId && !patrolMode) setSeatMenu({ x, y, seat });
  });
  const { x, y } = seatXY(s, i);
  // 번호 재지정 모드: 좌석마다 번호 텍스트박스
  if (numberEditMode) {
    const style: CSSProperties = { ...seatStyle(s.status, false, false), left: x, top: y, cursor: 'default', borderColor: 'var(--accent)', backgroundColor: 'var(--accent-soft)' };
    return (
      <div className="seatbox" style={style}>
        <input
          key={s.id}
          defaultValue={s.number ?? ''}
          inputMode="numeric"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== String(s.number ?? '')) call(updateSeat, { seatId: s.id, number: v });
          }}
          style={{ width: 46, height: 30, textAlign: 'center', border: '1px solid var(--accent)', borderRadius: 7, fontSize: 15, fontWeight: 800, background: '#fff', color: 'var(--ink)', outline: 'none' }}
        />
      </div>
    );
  }
  const who = s.current_student_id ? stuById.get(s.current_student_id)?.name ?? null : null;
  const patSt = patrolMark?.state ? PATROL_BY_KEY[patrolMark.state] : undefined;
  const pts = patrolMode ? patrolMark?.points ?? 0 : 0;
  const moveTarget = !!movingStudentId && !s.current_student_id; // 이동 중이며 이 자리가 빈자리
  const style: CSSProperties = { ...seatStyle(s.status, false, false), left: x, top: y, cursor: (clickable || moveTarget) ? 'pointer' : 'default' };
  // 평상시(순찰 모드 아님) 재실/부재 판정: page.tsx 가 이미 순찰·출결 중 더 최근 기록으로 계산해 내려준 값을 그대로 쓴다.
  const attKind: AttInfo | undefined = occ?.kind;
  const attTitle = occ?.title || undefined;
  // 순찰 모드면 순찰 상태 색이 출결/순찰기록 색을 덮고, 순찰 모드 자체에서는 마크 없는 좌석에 그 색을
  // 쓰지 않는다(고스트가 생겼으니 이제 불필요하고 고스트 색과 섞여 판단을 방해한다).
  // 우선순위(순찰 모드): 실제 마크 색(patSt) > 고스트 색(ghost, 아래) > 기본 좌석 색.
  if (patSt) {
    style.backgroundColor = patSt.bg;
    style.borderColor = patSt.bd;
  } else if (!patrolMode && attKind && ATT_COLOR[attKind]) {
    style.backgroundColor = ATT_COLOR[attKind].bg;
    style.borderColor = ATT_COLOR[attKind].bd;
  }
  if (moveTarget) { style.borderColor = 'var(--accent)'; style.backgroundColor = 'var(--accent-soft)'; }
  // 스케쥴 고스트(예상 상태) — 아직 마크 안 된(patSt 없는) 좌석에만 온다(ghost prop 자체가 이미 그렇게 필터됨).
  // 배경은 예상 상태 색으로 옅게 물들이고(실제 마크된 진한 프리셋 색과 구분), away 는 좌석 전체를 흐리게.
  // 테두리는 건드리지 않는다(선택·체크 표시용). 색 계산은 모바일과 공유하는 lib/schedule.ts 의 ghostStyleOf.
  // 좌측 스트립은 별도 절대배치 요소 대신 배경의 linear-gradient 로 그린다 — background 는 border-box 안쪽에
  // 클리핑되고 border 가 그 위에 그려지므로, 테두리 두께·라운드를 따로 계산하지 않아도 모서리 밖으로 새지 않는다.
  let ghostLabelColor: string | undefined;
  if (ghost) {
    const gs = ghostStyleOf(ghost.state, ghost.label);
    style.backgroundColor = gs.bg;
    style.opacity = gs.dim;
    if (gs.strip) style.backgroundImage = `linear-gradient(to right, ${gs.strip} 0 3px, transparent 3px)`;
    ghostLabelColor = ghost.state === 'away' || ghost.state === 'none' ? 'var(--faint)' : reasonColor(ghost.label);
  }
  return (
    <div
      className="seatbox"
      {...lp.bind(s)}
      onClick={(e) => {
        if (lp.consumed()) return; // 방금 꾹누르기로 메뉴 열렸으면 클릭 무시
        if (!clickable && !moveTarget) return;
        if (movingStudentId) { moveTo(s); return; }
        if (patrolMode) { if (s.current_student_id) setPatrolMenu({ x: e.clientX, y: e.clientY, seat: s }); return; }
        if (clickable) openSeat(s.id);
      }}
      onContextMenu={(e) => { e.preventDefault(); if (!movingStudentId && !patrolMode) setSeatMenu({ x: e.clientX, y: e.clientY, seat: s }); }}
      style={style}
      title={!patrolMode ? (attTitle ?? (needsAttention ? ATTENTION_TITLE : undefined)) : undefined}
    >
      {seatInner(s.number, s.label, who)}
      {patSt ? (
        <span style={{ position: 'absolute', top: 3, right: 5, fontSize: 9.5, fontWeight: 800, color: patSt.dot }}>
          {patSt.label}
        </span>
      ) : ghost ? (
        <span style={{ position: 'absolute', top: 3, right: 5, fontSize: 9.5, fontWeight: 800, color: ghostLabelColor, opacity: 0.48 }}>
          {ghost.label}
        </span>
      ) : !patrolMode && attKind ? (
        <span style={{ position: 'absolute', top: 3, right: 5, fontSize: 9.5, fontWeight: 800, color: attKind === 'in' ? ink('present') : 'var(--faint)' }}>
          {ATT_LABEL[attKind]}
        </span>
      ) : needsAttention ? (
        <span style={{ position: 'absolute', top: 3, right: 5, fontSize: 10.5, fontWeight: 800, color: 'var(--warn)' }}>
          확인 필요
        </span>
      ) : null}
      {/* 하원 사유 — 수동 퇴실 사유(attendance_event.note) 또는 없으면 스케쥴 추정(옅게). occ.reason 은
          occupancy.ts buildOccupancy() 가 이미 우선순위를 적용해 계산해 내려준다(여기선 표시만). */}
      {!patrolMode && attKind === 'out' && occ?.reason && (
        <span
          style={{
            position: 'absolute', bottom: 3, left: 4, right: 4, textAlign: 'center',
            fontSize: 10, fontWeight: 700, color: 'var(--dim)', opacity: occ.reasonEstimated ? 0.7 : 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none',
          }}
        >
          {occ.reason}
        </span>
      )}
      {patrolMode && pts > 0 && (
        <span style={{ position: 'absolute', bottom: 3, right: 5, fontSize: 9.5, fontWeight: 800, color: '#fff', background: '#e5484d', borderRadius: 8, padding: '0 5px', lineHeight: '14px' }}>
          {pts}
        </span>
      )}
      <span style={faceStyle(s.facing)} />
    </div>
  );
});

// ---------------- overview (모든 방 / 전층) 한 칸 — 모듈 스코프 + memo ----------------
type OvRoomProps = {
  r: Room;
  seats: Seat[];
  numberEditMode: boolean;
  stuById: Map<string, Student>;
  occupancy: Record<string, SeatOcc>; // 오늘 재실/부재 최종 판정(순찰·출결 중 더 최근 것)
  patrolMode: boolean;
  patrolMarks: Record<string, PatrolMark>;
  ghostOf: Map<string, Ghost>;
  attentionIds: Set<string>; // "확인 필요" 학생 id(전체 지점) — 순찰 모드 중엔 호출부가 게이트
  movingStudentId: string | null;
  ctx: SeatCtx;
};
const OvRoom = memo(function OvRoom({
  r, seats, numberEditMode, stuById, occupancy, patrolMode, patrolMarks, ghostOf, attentionIds, movingStudentId, ctx,
}: OvRoomProps) {
  const rs = seats;
  const list = rs.map((s, i) => seatXY(s, i));
  const b = bounds(list);
  const occ = rs.filter((s) => s.status === 'occupied').length;
  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 9 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>
          {r.name} <span style={{ color: 'var(--accent)' }}>{String(rs.length - occ).padStart(2, '0')}</span>/{String(rs.length).padStart(2, '0')}
        </span>
      </div>
      <div style={{
        position: 'relative', width: b.w, height: b.h, borderRadius: 14,
        border: '1px solid var(--line)', background: 'var(--panel)',
      }}>
        {rs.map((s, i) => {
          const sid = s.current_student_id;
          const mark = patrolMode && sid ? patrolMarks[sid] : undefined;
          const unmarked = patrolMode && !!sid && !mark;
          return (
            <StaticSeat
              key={s.id}
              s={s}
              i={i}
              clickable
              numberEditMode={numberEditMode}
              stuById={stuById}
              occ={sid ? occupancy[sid] : undefined}
              patrolMode={patrolMode}
              patrolMark={mark}
              ghost={unmarked ? ghostOf.get(sid!) : undefined}
              needsAttention={!patrolMode && !!sid && attentionIds.has(sid)}
              movingStudentId={movingStudentId}
              ctx={ctx}
            />
          );
        })}
        {doorMark(r.door_side)}
      </div>
    </div>
  );
});

export default function FloorEditor({
  rooms, seats, students, canManage, canEditStudent, initialRoomId, occupancy, canAttend, canPatrol, lastPatrolAt,
  openSession, scheduleMap, periods, actual, serverNowMin,
}: {
  rooms: Room[]; seats: Seat[]; students: Student[];
  canManage: boolean; canEditStudent: boolean; initialRoomId: string | null;
  occupancy: Record<string, SeatOcc>; canAttend: boolean; // 오늘 재실/부재 최종 판정(순찰·출결 중 더 최근 것)
  canPatrol: boolean; lastPatrolAt: string | null;
  openSession: OpenPatrolSession | null; scheduleMap: Record<string, ScheduleInfo>;
  periods: Period[];
  actual: Record<string, ActualAttendance>; // 학생별 오늘 실제 출결 요약(statusAt 5번째 인자)
  serverNowMin: number; // 서버가 계산해 내려준 지금 KST 분 — "확인 필요" 판정 전용(클라 new Date() 금지 원칙)
}) {
  const router = useRouter();
  const floors = useMemo(
    () => Array.from(new Set(rooms.map((r) => r.floor))).sort((a, b) => a - b),
    [rooms],
  );
  const initRoom = initialRoomId ? rooms.find((r) => r.id === initialRoomId) ?? null : rooms[0] ?? null;

  const [floorSel, setFloorSel] = useState<number | 'all'>(initRoom?.floor ?? floors[0] ?? 0);
  const [roomSel, setRoomSel] = useState<string | 'all'>('all'); // 방별 뷰 없음 — 항상 층 뷰
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selSeatId, setSelSeatId] = useState<string | null>(null);
  const [editList, setEditList] = useState<EditSeat[]>([]);
  const [removedSeats, setRemovedSeats] = useState<string[]>([]); // 편집 중 삭제한 실제 좌석 id
  const [guides, setGuides] = useState<{ type: 'v' | 'h'; pos: number }[]>([]);
  const [marqueeBox, setMarqueeBox] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<'student' | 'room' | null>(null);
  const [, start] = useTransition();

  // ---------------- server action helper ----------------
  // useCallback 으로 안정화 — SeatCtx 를 통해 memo 된 좌석에 내려가므로 정체성이 바뀌면 안 됨.
  // (첫 사용처인 doStartPatrol 보다 위에 선언해야 컴파일러의 mutable-range 분석이 깔끔하다.)
  const call = useCallback<CallFn>((action, fields, after) => {
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.set(k, String(v)));
    start(async () => { await action(fd); after?.(); });
  }, [start]);

  // 전체 배치 편집(방 드래그)
  const [arrange, setArrange] = useState(false);
  const [roomPos, setRoomPos] = useState<Record<string, { x: number; y: number }>>({});
  const [roomSettings, setRoomSettings] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.15); // 단일층 실좌석 전용 확대(네비·바 영향 X)
  const zoomBy = (d: number) => setZoom((z) => Math.min(2.5, Math.max(0.6, Math.round((z + d) * 100) / 100)));
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false); // 설정 메뉴 팝업
  const [numberEditMode, setNumberEditMode] = useState(false); // 좌석 번호 재지정: 좌석마다 텍스트박스
  const [movingStudentId, setMovingStudentId] = useState<string | null>(null); // 좌석 이동 중
  const [seatMenu, setSeatMenu] = useState<{ x: number; y: number; seat: Seat } | null>(null); // 우클릭 메뉴
  const [patrolMode, setPatrolMode] = useState(false); // 순찰 모드 오버레이
  const [patrolSession, setPatrolSession] = useState<string | null>(null); // 이번 순찰 세션 id
  const [patrolStartedAt, setPatrolStartedAt] = useState<number | null>(null); // 시작 시각(ms)
  const [patrolMenu, setPatrolMenu] = useState<{ x: number; y: number; seat: Seat } | null>(null); // 순찰 상태 선택
  const [patrolConfirm, setPatrolConfirm] = useState<null | 'start' | 'end' | 'resume'>(null); // 시작/종료/이어하기 확인창
  // 퇴실 확인창 — checkoutBranchAt() 분류 결과 + 사유 입력 진행 상태(공용 프리셋 펼침/기타 입력).
  const [checkoutConfirm, setCheckoutConfirm] = useState<{
    studentId: string; branch: CheckoutBranch; expanded: boolean; otherOpen: boolean; otherText: string;
  } | null>(null);
  const [patrolMarks, setPatrolMarks] = useState<Record<string, { state: string; points: number }>>({}); // 이번 세션에 찍은 것(시작 시 리셋)
  const [patrolToast, setPatrolToast] = useState<string | null>(null); // 종료 알림
  // 서버가 감지한 미종료 세션("이어하기" 대상). 이어하기/새로시작을 거치면 비운다.
  const [resume, setResume] = useState<OpenPatrolSession | null>(openSession);
  // ── 예상 상태(고스트) 기준 시각: 현재 KST 분(minute-of-day). 초기 렌더는 null(하이드레이션 안전).
  // 인터벌로 계속 갱신하지 않고, 마운트/순찰 시작·이어받기/수동 갱신 시점에만 새로 계산해 고정한다. ──
  const [nowMin, setNowMin] = useState<number | null>(null);
  useEffect(() => { setNowMin(kstNowMin()); }, []);
  const refreshNowMin = () => {
    setNowMin(kstNowMin());
    setPatrolToast('기준 시각 갱신됨');
  };
  // 실제 시작/종료(확인창 확인 후). 이동 모드와 상호배타.
  const doStartPatrol = () => {
    setMovingStudentId(null);
    const id = crypto.randomUUID();
    setPatrolSession(id); setPatrolStartedAt(Date.now()); setPatrolMode(true);
    setPatrolMarks({}); // 이전 순찰 표시 리셋 → 빈 화면에서 시작
    call(startPatrol, { sessionId: id });
    setPatrolConfirm(null);
    setResume(null);
    setNowMin(kstNowMin()); // 순찰 시작 시점 기준으로 고스트 기준 시각을 다시 고정
  };
  const doEndPatrol = () => {
    if (patrolSession) call(endPatrol, { sessionId: patrolSession });
    setPatrolMode(false); setPatrolSession(null); setPatrolStartedAt(null); setPatrolMarks({});
    setPatrolConfirm(null);
    setPatrolToast('순찰 종료 · 순찰 기록에 저장되었습니다');
  };
  // 이어하기 — 새 세션을 만들지 않고 기존 세션 id 로 진입, 기존 마크를 불러와 복원한다.
  const doResumePatrol = () => {
    if (!resume) return;
    const target = resume.sessionId;
    setMovingStudentId(null);
    setPatrolSession(target); setPatrolStartedAt(Date.now()); setPatrolMode(true);
    setPatrolConfirm(null);
    setResume(null);
    setNowMin(kstNowMin()); // 이어받는 시점 기준으로 고스트 기준 시각을 다시 고정
    getPatrolSessionDetail(target)
      .then((rows) => {
        const m: Record<string, { state: string; points: number }> = {};
        for (const r of rows) m[r.student_id] = { state: r.state, points: r.points };
        setPatrolMarks(m);
      })
      .catch(() => setPatrolToast('기존 기록 불러오기 실패 — 새로고침 후 다시 시도하세요'));
  };
  // 새로 시작 — 미종료 세션을 종료 처리한 뒤 새 세션을 시작(미종료 세션이 쌓이지 않게).
  const doFreshPatrol = () => {
    if (!resume) return;
    const target = resume.sessionId;
    call(endPatrol, { sessionId: target }, () => { setResume(null); doStartPatrol(); });
  };
  // (경과 시각은 아래 PatrolElapsed 가 자체 타이머로 갱신 — 매초 FloorEditor 전체가
  //  리렌더되어 좌석 90개가 재마운트되던 문제를 없앤다. 확인창은 스냅샷이면 충분.)
  // 종료 알림 자동 사라짐
  useEffect(() => {
    if (!patrolToast) return;
    const t = setTimeout(() => setPatrolToast(null), 2800);
    return () => clearTimeout(t);
  }, [patrolToast]);
  const arrangeRef = useRef<HTMLDivElement>(null);
  // 층 스크롤 스냅(5층 위→4층, 자석처럼)
  const stageRef = useRef<HTMLDivElement>(null);
  const floorRefs = useRef<Record<number, HTMLElement | null>>({});
  const roomDragRef = useRef<{ id: string; gx: number; gy: number; left: number; top: number; moved: boolean } | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const tmpRef = useRef(0);
  const dragRef = useRef<{
    primaryId: string; items: { id: string; sx: number; sy: number }[];
    others: { id: string; x: number; y: number }[]; cx0: number; cy0: number; moved: boolean;
  } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number; base: Set<string>; all: { id: string; x: number; y: number }[] } | null>(null);

  const stuById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);
  const seatsByRoom = useMemo(() => {
    const m = new Map<string, Seat[]>();
    for (const s of seats) { if (!s.room_id) continue; (m.get(s.room_id) ?? m.set(s.room_id, []).get(s.room_id)!).push(s); }
    return m;
  }, [seats]);
  const seatedSet = useMemo(
    () => new Set(seats.map((s) => s.current_student_id).filter(Boolean) as string[]),
    [seats],
  );
  const unseated = useMemo(
    () => students.filter((s) => s.status === 'enrolled' && !seatedSet.has(s.id)),
    [students, seatedSet],
  );
  // 학생별 예상 상태 — 스케쥴 정보(hours/slots)가 아예 없으면 state:'none'('미설정')으로 표시(away 와 구분).
  // 자정 넘김 대비: 새벽 시간대(0~5시)는 오늘 분(minute) 과 +1440 좌표계 둘 다로 판정해 away 아닌 쪽을 채택.
  const ghostOf = useMemo(() => {
    const m = new Map<string, Ghost>();
    if (nowMin == null) return m;
    for (const [sid, info] of Object.entries(scheduleMap)) {
      // 등하원·오늘 일정 둘 다 없으면 "모르는 것"(none/미설정) — away(등원전/하원)와 구분해 회색으로 표시한다.
      // 단, 실제 출결(첫 입실)이 있으면 스케쥴이 없어도 "모르는 것"이 아니라 실제 상태로 판정해야 한다.
      const act = actual[sid] ?? null;
      if (!info.hours && info.slots.length === 0 && act?.firstInMin == null) { m.set(sid, { state: 'none', label: '미설정' }); continue; }
      let result = statusAt(nowMin, info.hours, info.slots, periods, act);
      if (result.state === 'away' && nowMin < 300) {
        const shifted: ActualAttendance | null = act
          ? {
              firstInMin: act.firstInMin != null ? act.firstInMin + 1440 : act.firstInMin,
              lastOutMin: act.lastOutMin != null ? act.lastOutMin + 1440 : act.lastOutMin,
            }
          : null;
        const alt = statusAt(nowMin + 1440, info.hours, info.slots, periods, shifted);
        if (alt.state !== 'away') result = alt;
      }
      m.set(sid, result);
    }
    return m;
  }, [scheduleMap, nowMin, periods, actual]);

  // 확인 필요 — 스케쥴상 지금 원 안에 있어야 하는데(자습/원내 사유, 쉬는시간 제외) 오늘 출결·순찰 기록이
  // 전혀 없는 학생. checkoutBranchAt() 이 이미 스케쥴·자정 넘김 판정을 끝낸 CheckoutBranch 를
  // needsAttentionCheck() 에 그대로 넘긴다(새 판정 로직 없음). scheduleMap/periods/actual/occupancy 모두
  // 이미 있는 값 재사용(추가 쿼리 없음). ghostOf 와 달리 순찰 화면 전용 클라 nowMin(state) 이 아니라
  // 서버가 내려준 serverNowMin 을 쓴다(클라 new Date() 금지 원칙 — 이 판정은 "지금 이 순간"이 아니라
  // 페이지 로드 시점 기준이면 충분하다).
  const attentionIds = useMemo(() => {
    const set = new Set<string>();
    for (const [sid, info] of Object.entries(scheduleMap)) {
      const branch = checkoutBranchAt(serverNowMin, info.hours, info.slots, periods, actual[sid] ?? null);
      if (needsAttentionCheck(branch, occupancy[sid])) set.add(sid);
    }
    return set;
  }, [scheduleMap, serverNowMin, periods, actual, occupancy]);

  // 툴바 요약 — 현재 보고 있는 층(전체보기면 전 층) 기준 확인 필요 인원 수. 순찰 모드 중엔 0(호출부가
  // 이미 그 상황에선 patrolSummary 를 쓰므로 겹치지 않게 감춘다).
  const attentionSummary = useMemo(() => {
    if (patrolMode) return 0;
    const roomIds = typeof floorSel === 'number'
      ? new Set(rooms.filter((r) => r.floor === floorSel).map((r) => r.id))
      : null; // null = 전체 층(대시보드)
    let n = 0;
    for (const s of seats) {
      if (!s.room_id || !s.current_student_id) continue;
      if (roomIds && !roomIds.has(s.room_id)) continue;
      if (attentionIds.has(s.current_student_id)) n += 1;
    }
    return n;
  }, [patrolMode, floorSel, rooms, seats, attentionIds]);

  // 순찰 종료 시 미점검 경고 — 현재 층에 배정된 학생이 있는데 이번 세션에 마크가 없는 좌석.
  // 오프라인 큐 대기분도 patrolMarks 에 즉시 반영되므로(patrolMenuItems) 별도 처리 불필요.
  // 고스트 none(미설정)/away(등원전·하원)인 학생은 확인이 필요 없으니 경고에서 제외한다(탭 자체는 막지 않음).
  const uncheckedPatrol = useMemo(() => {
    if (!patrolMode || typeof floorSel !== 'number') return [];
    const roomIds = new Set(rooms.filter((r) => r.floor === floorSel).map((r) => r.id));
    return seats
      .filter((s) => s.room_id && roomIds.has(s.room_id) && s.current_student_id && !patrolMarks[s.current_student_id]
        && !isPatrolExempt(ghostOf.get(s.current_student_id!)?.state))
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  }, [patrolMode, floorSel, rooms, seats, patrolMarks, ghostOf]);

  // 순찰 툴바 요약 — 점검 N/M · 제외 K명 · 예상 재실 K명 · 쉬는시간/등원전/미설정 J명(방 단위 배지가 없는
  // 데스크탑 대체). M(total)·K(exempt)는 고스트 none/away/break 를 분모에서 뺀 값 — N(marked)은 제외
  // 대상이라도 실제로 찍었으면 포함한다.
  // present 에는 study·scheduled 만 합산한다(실제로 확인이 필요한 인원). break 는 exempt 로 잡히므로
  // present 에서 빼고 별도(brk)로 센다 — 각 좌석은 ghost.state 하나에만 속하므로 중복 집계는 없다.
  const patrolSummary = useMemo(() => {
    if (!patrolMode || typeof floorSel !== 'number') return null;
    const roomIds = new Set(rooms.filter((r) => r.floor === floorSel).map((r) => r.id));
    const floorAssigned = seats.filter((s) => s.room_id && roomIds.has(s.room_id) && s.current_student_id);
    const exempt = floorAssigned.filter((s) => isPatrolExempt(ghostOf.get(s.current_student_id!)?.state)).length;
    const total = floorAssigned.length - exempt;
    const marked = floorAssigned.filter((s) => patrolMarks[s.current_student_id!]).length;
    let present = 0, away = 0, unset = 0, brk = 0;
    if (nowMin != null) {
      for (const s of floorAssigned) {
        const sid = s.current_student_id!;
        const g = ghostOf.get(sid);
        if (g) {
          if (g.state === 'away') away++;
          else if (g.state === 'none') unset++;
          else if (g.state === 'break') brk++;
          else present++;
        }
      }
    }
    return { marked, total, exempt, present, away, unset, brk };
  }, [patrolMode, floorSel, rooms, seats, nowMin, ghostOf, patrolMarks]);

  const roomsOnFloor = (fl: number) => rooms.filter((r) => r.floor === fl);
  const selRoom = roomSel !== 'all' ? rooms.find((r) => r.id === roomSel) ?? null : null;
  const overview = floorSel === 'all' || roomSel === 'all';
  const floorOverview = typeof floorSel === 'number' && roomSel === 'all'; // 특정 층의 전체보기 = 배치 편집 가능
  const floorStack = mode === 'view' && !arrange && typeof floorSel === 'number' && floors.length >= 2; // 2개층 이상일 때만 스크롤 스냅
  const curRoomSeats = selRoom ? (seatsByRoom.get(selRoom.id) ?? []) : [];
  const selSeat = selSeatId ? seats.find((s) => s.id === selSeatId) ?? null : null;

  // ---------------- 좌석 상호작용 핸들러 (모두 안정적 → memo 경계 유지) ----------------
  // 롱프레스는 StaticSeat 안에서 자체 useLongPress 로 처리(부모 ctx 에서 제외 → 안정성 확보).
  const openSeat = useCallback((id: string) => { setSelSeatId(id); }, []);
  // 좌석 이동: 이동 중인 학생을 빈자리로 (assignSeat 이 기존 자리 자동 비움)
  const moveTo = useCallback((seat: Seat) => {
    if (!movingStudentId || seat.current_student_id) return;
    call(assignSeat, { seatId: seat.id, studentId: movingStudentId }, () => setMovingStudentId(null));
  }, [call, movingStudentId]);
  // 퇴실 확인창 열기 — 클릭 시점의 신선한 kstNowMin() 으로 지금 이 순간의 분류를 계산한다(캐시된 nowMin
  // state 를 쓰지 않음 — 순찰 고스트 기준 시각과 달리 이건 그때그때 정확해야 한다).
  const openCheckoutConfirm = useCallback((sid: string) => {
    const now = kstNowMin();
    const info = scheduleMap[sid];
    const branch = checkoutBranchAt(now, info?.hours ?? null, info?.slots ?? [], periods, actual[sid] ?? null);
    setCheckoutConfirm({ studentId: sid, branch, expanded: false, otherOpen: false, otherText: '' });
  }, [scheduleMap, periods, actual]);
  const ctx = useMemo<SeatCtx>(() => ({
    moveTo, openSeat, setPatrolMenu, setSeatMenu, call,
  }), [moveTo, openSeat, setPatrolMenu, setSeatMenu, call]);
  // 좌석/방 렌더 헬퍼 — 부모 컨텍스트를 모듈 스코프 컴포넌트에 주입
  const staticSeat = (s: Seat, i: number, clickable: boolean) => {
    const sid = s.current_student_id;
    const mark = patrolMode && sid ? patrolMarks[sid] : undefined;
    const unmarked = patrolMode && !!sid && !mark;
    return (
      <StaticSeat
        key={s.id}
        s={s}
        i={i}
        clickable={clickable}
        numberEditMode={numberEditMode}
        stuById={stuById}
        occ={sid ? occupancy[sid] : undefined}
        patrolMode={patrolMode}
        patrolMark={mark}
        ghost={unmarked ? ghostOf.get(sid!) : undefined}
        needsAttention={!patrolMode && !!sid && attentionIds.has(sid)}
        movingStudentId={movingStudentId}
        ctx={ctx}
      />
    );
  };
  const ovRoom = (r: Room) => (
    <OvRoom
      key={r.id}
      r={r}
      seats={seatsByRoom.get(r.id) ?? []}
      numberEditMode={numberEditMode}
      stuById={stuById}
      occupancy={occupancy}
      patrolMode={patrolMode}
      patrolMarks={patrolMarks}
      ghostOf={ghostOf}
      attentionIds={attentionIds}
      movingStudentId={movingStudentId}
      ctx={ctx}
    />
  );

  // 스크롤로 층 넘길 때 현재 보이는 층으로 라디오 동기화
  useEffect(() => {
    if (!floorStack) return;
    const root = stageRef.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      let best: { fl: number; ratio: number } | null = null;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const fl = Number((e.target as HTMLElement).dataset.floor);
        if (Number.isNaN(fl)) continue;
        if (!best || e.intersectionRatio > best.ratio) best = { fl, ratio: e.intersectionRatio };
      }
      if (best) { const b = best; setFloorSel((cur) => (cur === b.fl ? cur : b.fl)); }
    }, { root, threshold: [0.4, 0.6, 0.8] });
    Object.values(floorRefs.current).forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [floorStack, floors, rooms]);

  // ---------------- 전체 배치 편집 (방 블록 드래그) ----------------
  const ROOM_GAP = 54;
  const roomBW = (r: Room) => bounds((seatsByRoom.get(r.id) ?? []).map((s, i) => seatXY(s, i))).w;
  const roomBH = (r: Room) => bounds((seatsByRoom.get(r.id) ?? []).map((s, i) => seatXY(s, i))).h;

  const enterArrange = () => {
    if (typeof floorSel !== 'number') return;
    const rms = roomsOnFloor(floorSel);
    const pos: Record<string, { x: number; y: number }> = {};
    let ax = 40;
    for (const r of rms) {
      if (r.pos_x || r.pos_y) pos[r.id] = { x: r.pos_x, y: r.pos_y };
      else { pos[r.id] = { x: ax, y: 48 }; ax += roomBW(r) + ROOM_GAP; }
    }
    setRoomPos(pos); setSelSeatId(null); setArrange(true);
  };
  const onRoomDown = (e: ReactPointerEvent, id: string) => {
    e.preventDefault();
    const rect = arrangeRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = roomPos[id] ?? { x: 0, y: 0 };
    roomDragRef.current = { id, gx: e.clientX - rect.left - p.x, gy: e.clientY - rect.top - p.y, left: rect.left, top: rect.top, moved: false };
    window.addEventListener('pointermove', onRoomMove);
    window.addEventListener('pointerup', onRoomUp);
  };
  const onRoomMove = (e: PointerEvent) => {
    const d = roomDragRef.current; if (!d) return;
    d.moved = true;
    const x = Math.max(0, Math.round((e.clientX - d.left - d.gx) / 10) * 10);
    const y = Math.max(0, Math.round((e.clientY - d.top - d.gy) / 10) * 10);
    setRoomPos((prev) => ({ ...prev, [d.id]: { x, y } }));
  };
  const onRoomUp = () => {
    roomDragRef.current = null;
    window.removeEventListener('pointermove', onRoomMove);
    window.removeEventListener('pointerup', onRoomUp);
  };
  const saveArrange = () => {
    const positions = Object.entries(roomPos).map(([id, p]) => ({ id, x: p.x, y: p.y }));
    call(saveRoomPositions, { positions: JSON.stringify(positions) }, () => setArrange(false));
  };

  // ---------------- navigation ----------------
  const pickFloor = (f: number | 'all') => {
    setMode('view'); setSelSeatId(null); setSelected(new Set());
    setFloorSel(f);
    setRoomSel('all'); // 방별 뷰 없음 — 항상 층(전체 방) 뷰
    // 해당 층으로 부드럽게 스크롤(스택이 렌더된 뒤)
    if (typeof f === 'number') setTimeout(() => floorRefs.current[f]?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
  };
  // 특정 방의 좌석 편집으로 진입(층 뷰에서 방 '편집' 클릭). 저장/취소 시 층 뷰로 복귀.
  const editRoom = (room: Room) => {
    const rs = seatsByRoom.get(room.id) ?? [];
    setEditList(rs.map((s, i) => {
      const { x, y } = seatXY(s, i);
      return {
        id: s.id, x, y, number: s.number, status: s.status, current_student_id: s.current_student_id,
        facing: s.facing, seat_type: s.seat_type, label: s.label,
      };
    }));
    setFloorSel(room.floor); setRoomSel(room.id);
    setSelected(new Set()); setSelSeatId(null); setGuides([]); setRemovedSeats([]); setArrange(false); setMode('edit');
  };

  // ---------------- edit mode ----------------
  const enterEdit = () => {
    if (!selRoom) return;
    setEditList(curRoomSeats.map((s, i) => {
      const { x, y } = seatXY(s, i);
      return {
        id: s.id, x, y, number: s.number, status: s.status, current_student_id: s.current_student_id,
        facing: s.facing, seat_type: s.seat_type, label: s.label,
      };
    }));
    setSelected(new Set()); setSelSeatId(null); setGuides([]); setRemovedSeats([]); setMode('edit');
  };
  const cancelEdit = () => { setMode('view'); setRoomSel('all'); setEditList([]); setSelected(new Set()); setGuides([]); setMarqueeBox(null); setRemovedSeats([]); };
  const saveEdit = () => {
    if (!selRoom) return;
    const positions = editList.map((s) => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y) }));
    call(saveSeatPositions, { roomId: selRoom.id, positions: JSON.stringify(positions), removed: JSON.stringify(removedSeats) }, () => {
      setMode('view'); setRoomSel('all'); setEditList([]); setSelected(new Set()); setGuides([]); setMarqueeBox(null); setRemovedSeats([]);
    });
  };
  // 선택한 좌석 삭제(편집 중) — 실제 좌석은 저장 때 DB에서 제거, tmp 는 그냥 목록에서 뺌
  const deleteSelectedInEdit = () => {
    if (!selected.size) return;
    const ids = [...selected];
    setRemovedSeats((prev) => [...prev, ...ids.filter((id) => !id.startsWith('tmp'))]);
    setEditList((prev) => prev.filter((s) => !selected.has(s.id)));
    setSelected(new Set());
  };
  const addSeatEdit = () => {
    const k = editList.length;
    const x = ORIGIN + (k % PER_ROW) * CELL_X, y = ORIGIN + Math.floor(k / PER_ROW) * CELL_Y;
    const maxN = editList.reduce((m, s) => Math.max(m, s.number ?? 0), 0);
    setEditList((prev) => [...prev, {
      id: 'tmp_' + (tmpRef.current++), x, y, number: maxN + 1, status: 'empty',
      current_student_id: null, facing: 'down', seat_type: null, label: String(maxN + 1), isNew: true,
    }]);
  };
  // 자동 정렬 — 방의 모든 좌석을 번호 순으로 깔끔한 격자에 재배치(한 줄 PER_ROW개)
  const autoArrange = () => {
    const sorted = [...editList].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const posById = new Map(
      sorted.map((s, i) => [s.id, { x: ORIGIN + (i % PER_ROW) * CELL_X, y: ORIGIN + Math.floor(i / PER_ROW) * CELL_Y }]),
    );
    setEditList((prev) => prev.map((s) => ({ ...s, ...posById.get(s.id)! })));
    setSelected(new Set()); setGuides([]);
  };

  // ---------------- pointer drag / marquee ----------------
  const onMove = useCallback((e: PointerEvent) => {
    const mq = marqueeRef.current;
    if (mq) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const l = Math.min(x, mq.x0), t = Math.min(y, mq.y0), w = Math.abs(x - mq.x0), h = Math.abs(y - mq.y0);
      setMarqueeBox({ l, t, w, h });
      const hit = mq.all.filter((s) => s.x < l + w && s.x + SW > l && s.y < t + h && s.y + SH > t).map((s) => s.id);
      setSelected(new Set([...mq.base, ...hit]));
      return;
    }
    const dr = dragRef.current;
    if (!dr) return;
    const dx = e.clientX - dr.cx0, dy = e.clientY - dr.cy0; dr.moved = true;
    const prim = dr.items.find((it) => it.id === dr.primaryId)!;
    let px = prim.sx + dx, py = prim.sy + dy;
    // 1) 격자 스냅 먼저
    px = Math.round(px / STEP) * STEP; py = Math.round(py / STEP) * STEP;
    // 2) 이웃 좌석과 모서리 정렬이 격자보다 우선 — 정렬되면 그 자리에 딱(가이드=실제 위치, 격자가 다시 밀지 않음)
    const g: { type: 'v' | 'h'; pos: number }[] = [];
    for (const o of dr.others) {
      if (Math.abs(o.x - px) < SNAP) { px = o.x; g.push({ type: 'v', pos: o.x + HW }); }
      if (Math.abs(o.y - py) < SNAP) { py = o.y; g.push({ type: 'h', pos: o.y + HH }); }
    }
    const edx = px - prim.sx, edy = py - prim.sy;
    const moved = new Map<string, { x: number; y: number }>();
    dr.items.forEach((it) => moved.set(it.id, { x: Math.max(4, it.sx + edx), y: Math.max(4, it.sy + edy) }));
    setEditList((prev) => prev.map((s) => (moved.has(s.id) ? { ...s, ...moved.get(s.id)! } : s)));
    setGuides(g);
  }, []);

  const onUp = useCallback(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (marqueeRef.current) { marqueeRef.current = null; setMarqueeBox(null); return; }
    if (dragRef.current) { dragRef.current = null; setGuides([]); }
  }, [onMove]);

  const onSeatDown = (e: ReactPointerEvent, s: EditSeat) => {
    if (mode !== 'edit') return;
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) {
      setSelected((prev) => { const n = new Set(prev); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; });
      return;
    }
    let sel = selected;
    if (!selected.has(s.id)) { sel = new Set([s.id]); setSelected(sel); }
    const items = editList.filter((x) => sel.has(x.id)).map((x) => ({ id: x.id, sx: x.x, sy: x.y }));
    const others = editList.filter((x) => !sel.has(x.id)).map((x) => ({ id: x.id, x: x.x, y: x.y }));
    dragRef.current = { primaryId: s.id, items, others, cx0: e.clientX, cy0: e.clientY, moved: false };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onCanvasDown = (e: ReactPointerEvent) => {
    if (mode !== 'edit') return;
    const target = e.target as HTMLElement;
    if (target.closest('.seatbox') || target.closest('.toolbarbox')) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const base = e.shiftKey ? new Set(selected) : new Set<string>();
    if (!e.shiftKey) setSelected(new Set());
    marqueeRef.current = {
      x0: e.clientX - rect.left, y0: e.clientY - rect.top, base,
      all: editList.map((s) => ({ id: s.id, x: s.x, y: s.y })),
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ---------------- seat rendering ----------------
  // 우클릭 컨텍스트 메뉴 항목 (좌석 상태별)
  const seatMenuItems = (s: Seat): MenuItem[] => {
    const sid = s.current_student_id;
    if (sid) {
      return [
        { label: '입실 기록', onClick: () => call(checkIn, { studentId: sid }), disabled: !canAttend },
        { label: '퇴실 기록', onClick: () => openCheckoutConfirm(sid), disabled: !canAttend },
        { separator: true },
        { label: '학생 정보', onClick: () => openSeat(s.id) },
        { label: '스케쥴 보기', onClick: () => {} },
        ...(canManage ? [
          { label: '자리 이동', onClick: () => setMovingStudentId(sid) },
          { label: '자리 비우기', onClick: () => call(releaseSeat, { seatId: s.id }), danger: true },
        ] : []),
      ];
    }
    if (canManage && s.status !== 'maintenance') {
      return [{ label: '학생 배정', onClick: () => openSeat(s.id) }];
    }
    return [{ label: '작업 없음', disabled: true }];
  };
  // 순찰 상태 선택 메뉴 — 재석(자리 있음) / 이석(자리 비움) 두 그룹. 세션당 학생 1상태(교체).
  const patrolMenuItems = (s: Seat): MenuItem[] => {
    const sid = s.current_student_id;
    if (!sid) return [{ label: '빈자리', disabled: true }];
    const cur = patrolMarks[sid]?.state; // 이번 세션에 찍힌 상태
    const mk = (st: (typeof PATROL_STATES)[number]): MenuItem => ({
      label: st.label + (cur === st.key ? ' ✓' : ''),
      dot: st.dot,
      right: st.points > 0 ? `+${st.points}` : undefined,
      onClick: () => {
        setPatrolMarks((m) => ({ ...m, [sid]: { state: st.key, points: st.points } }));
        call(recordPatrol, { studentId: sid, state: st.key, sessionId: patrolSession ?? '' });
      },
    });
    const present = PATROL_STATES.filter((st) => st.present).map(mk);
    const away = PATROL_STATES.filter((st) => !st.present).map(mk);
    return [
      { label: '자리에 있음', disabled: true },
      ...present,
      { separator: true },
      { label: '자리 비움', disabled: true },
      ...away,
      { separator: true },
      { label: '지우기', danger: true, disabled: !cur, onClick: () => {
        setPatrolMarks((m) => { const n = { ...m }; delete n[sid]; return n; });
        call(clearPatrolMark, { sessionId: patrolSession ?? '', studentId: sid });
      } },
    ];
  };
  const closeDrawer = () => setSelSeatId(null);
  // 순찰 벌점 합계(오늘, 전체)
  const patrolTally = Object.values(patrolMarks).reduce((n, p) => n + (p?.points ?? 0), 0);

  // ---------------- canvas (single room) ----------------
  const renderSingleRoom = () => {
    if (!selRoom) return null;
    const isEdit = mode === 'edit';
    const list = isEdit ? editList : curRoomSeats.map((s, i) => {
      const { x, y } = seatXY(s, i);
      return { id: s.id, x, y, number: s.number, status: s.status, current_student_id: s.current_student_id, facing: s.facing, seat_type: s.seat_type, label: s.label } as EditSeat;
    });
    const b = bounds(list);
    const cw = isEdit ? Math.max(EDIT_W, b.w) : b.w;
    const ch = isEdit ? Math.max(EDIT_H, b.h) : b.h;
    const occCount = curRoomSeats.filter((s) => s.status === 'occupied').length;

    return (
      <>
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-.01em', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {selRoom.name}
            {canManage && !isEdit && (
              <button onClick={() => setRoomSettings(selRoom.id)} title="방 설정" style={{ border: '1px solid var(--line)', background: 'var(--panel2)', borderRadius: 7, width: 24, height: 24, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
                <Ic d={I_EDIT} size={12} />
              </button>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--dim)', marginTop: 2 }}>{selRoom.floor}층 · 좌석 {curRoomSeats.length} · 사용 {occCount}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div
            ref={canvasRef}
            onPointerDown={onCanvasDown}
            style={{
              position: 'relative', display: 'inline-block', width: cw, height: ch,
              borderRadius: 18, verticalAlign: 'top',
              border: isEdit ? '1px dashed var(--accent)' : '1px solid var(--line)',
              background: 'var(--panel)',
              // 좌석이 스냅되는 20px 격자를 실제로 보이게 (라이트 테마용 옅은 선)
              backgroundImage: isEdit
                ? 'linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)'
                : 'none',
              backgroundSize: '20px 20px', backgroundPosition: '0 0',
              cursor: 'default',
            }}
          >
            {isEdit && guides.map((g, i) => (
              <span key={i} style={{
                position: 'absolute', background: 'var(--accent)', opacity: 0.55, zIndex: 15, pointerEvents: 'none',
                ...(g.type === 'v' ? { left: g.pos, top: 0, width: 1, height: '100%' } : { top: g.pos, left: 0, height: 1, width: '100%' }),
              }} />
            ))}
            {isEdit && marqueeBox && (
              <span style={{
                position: 'absolute', left: marqueeBox.l, top: marqueeBox.t, width: marqueeBox.w, height: marqueeBox.h,
                border: '1px solid var(--accent)', background: 'rgba(91,141,239,.10)', borderRadius: 4, zIndex: 14, pointerEvents: 'none',
              }} />
            )}
            {list.map((s) => {
              const who = s.current_student_id ? stuById.get(s.current_student_id)?.name ?? null : null;
              const occ = s.status === 'occupied';
              const sel = isEdit ? selected.has(s.id) : selSeatId === s.id;
              const att = !isEdit && s.current_student_id ? occupancy[s.current_student_id]?.kind : undefined;
              const st: CSSProperties = { ...seatStyle(s.status, sel, isEdit), left: s.x, top: s.y };
              if (att && ATT_COLOR[att]) { st.backgroundColor = ATT_COLOR[att].bg; st.borderColor = ATT_COLOR[att].bd; }
              return (
                <div
                  key={s.id}
                  className="seatbox"
                  onPointerDown={isEdit ? (e) => onSeatDown(e, s) : undefined}
                  onClick={!isEdit ? () => openSeat(s.id) : undefined}
                  style={st}
                >
                  {seatInner(s.number, s.label, who)}
                  {att && (
                    <span style={{ position: 'absolute', top: 3, right: 5, fontSize: 9.5, fontWeight: 800, color: att === 'in' ? ink('present') : 'var(--faint)' }}>
                      {ATT_LABEL[att]}
                    </span>
                  )}
                  <span style={faceStyle(s.facing)} />
                </div>
              );
            })}

            {selRoom && doorMark(selRoom.door_side)}

            {isEdit && (
              <div
                className="toolbarbox"
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 22,
                  display: 'flex', alignItems: 'center', gap: 6, background: 'var(--panel)',
                  border: '1px solid var(--line)', borderRadius: 14, padding: 7, zIndex: 55,
                  boxShadow: '0 8px 24px rgba(0,0,0,.35)',
                }}
              >
                <button className="btn" onClick={addSeatEdit} style={{ height: 34, padding: '0 12px', fontSize: 13 }}>
                  <Ic d={I_PLUS} /> 좌석 추가
                </button>
                <button className="btn" onClick={autoArrange} style={{ height: 34, padding: '0 12px', fontSize: 13 }}>
                  <Ic d={I_GRID} /> 자동 정렬
                </button>
                {selected.size > 0 && (
                  <button className="btn" onClick={deleteSelectedInEdit} style={{ height: 34, padding: '0 12px', fontSize: 13, color: 'var(--danger)' }}>
                    <Ic d={I_TRASH} /> 선택 삭제 ({selected.size})
                  </button>
                )}
                <span style={{ width: 1, height: 22, background: 'var(--line)' }} />
                <button className="btn" onClick={cancelEdit} style={{ height: 34, padding: '0 12px', fontSize: 13 }}>취소</button>
                <button className="btn btn-accent" onClick={saveEdit} style={{ height: 34, padding: '0 14px', fontSize: 13 }}>
                  <Ic d={I_CHECK} /> 저장
                </button>
              </div>
            )}
          </div>
        </div>
        {isEdit && (
          <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12, color: 'var(--faint)' }}>
            빈 곳 드래그 = 여러 좌석 선택 · Shift = 추가 선택 · 좌석 드래그 = 이동(그리드 스냅·정렬 가이드)
          </div>
        )}
      </>
    );
  };

  // ---------------- overview (모든 방 / 전층) ----------------
  // 방 하나의 오늘 통계(배정·재실)
  const roomStat = (room: Room) => {
    const rs = seatsByRoom.get(room.id) ?? [];
    const total = rs.length;
    let assigned = 0, inRoom = 0;
    for (const s of rs) {
      if (!s.current_student_id) continue;
      assigned++;
      if (occupancy[s.current_student_id]?.kind === 'in') inRoom++;
    }
    return { total, assigned, in: inRoom, vacant: total - assigned };
  };

  // 대시보드(전층 대체) — 오늘 입·퇴실 + 결제(예정) + 방별 입실
  const renderDashboard = () => {
    let totalSeats = 0;
    const perRoom = rooms
      .map((r) => { const st = roomStat(r); totalSeats += st.total; return { r, st }; })
      .sort((a, b) => a.r.floor - b.r.floor || a.r.name.localeCompare(b.r.name, 'ko'));
    let inNow = 0, out = 0;
    for (const o of Object.values(occupancy)) {
      if (o.kind === 'in') inNow++;
      else if (o.kind === 'out') out++;
    }
    const vacant = Math.max(0, totalSeats - inNow);
    return (
      <div style={{ maxWidth: 940, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: 'minmax(84px, auto)', gap: 12 }}>
        {/* 입실 히어로 (2×2) */}
        <div className="card" style={{ gridColumn: 'span 2', gridRow: 'span 2', padding: 24, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--faint)' }}>지금 입실 (재실)</div>
          <div style={{ fontSize: 58, fontWeight: 800, color: 'var(--ok)', lineHeight: 1.05 }}>{inNow}</div>
          <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 4 }}>전체 {totalSeats}석 · 공석 {vacant}</div>
        </div>
        <Tile label="퇴실" value={out} />
        <Tile label="공석" value={vacant} />
        <Tile label="전체 좌석" value={totalSeats} span={2} />
        <Tile label="미납" value="—" color="var(--faint)" span={2} sub="결제 모듈 붙으면 표시" />
        <Tile label="곧 납부 예정" value="—" color="var(--faint)" span={2} />
        {/* 방별 입실 (4칸 폭) */}
        <div className="card" style={{ gridColumn: 'span 4', padding: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--dim)', marginBottom: 12 }}>방별 입실</div>
          {perRoom.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--faint)', fontSize: 13, padding: 12 }}>등록된 방이 없습니다.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[...new Set(perRoom.map((x) => x.r.floor))].sort((a, b) => b - a).map((fl) => {
                const onFloor = perRoom.filter((x) => x.r.floor === fl);
                const flIn = onFloor.reduce((n, x) => n + x.st.in, 0);
                const flTotal = onFloor.reduce((n, x) => n + x.st.total, 0);
                const flRatio = flTotal ? flIn / flTotal : 0;
                return (
                <div key={fl} style={{ display: 'flex', alignItems: 'stretch', gap: 12 }}>
                  <div className="flex" style={{ gap: 10, flexWrap: 'wrap' }}>
                    {/* 층 카드 — 그 층 전체 입실. 방 카드보다 앞에 두어 구분 */}
                    <button
                      onClick={() => pickFloor(fl)}
                      style={{
                        width: 150, textAlign: 'left', cursor: 'pointer', color: 'inherit',
                        border: '1px solid var(--accent)', borderRadius: 12, padding: 12,
                        background: 'var(--accent-soft)',
                      }}
                    >
                      <div style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--accent)' }}>{fl}층</div>
                      <div style={{ marginTop: 5, fontSize: 19, fontWeight: 800, color: 'var(--accent)' }}>
                        {flIn}
                        <span style={{ fontSize: 12.5, color: 'var(--dim)', fontWeight: 700 }}> / {flTotal}</span>
                      </div>
                      <div style={{ height: 7, borderRadius: 999, background: 'var(--panel2)', overflow: 'hidden', marginTop: 6 }}>
                        <div style={{ height: '100%', width: `${Math.round(flRatio * 100)}%`, background: 'var(--accent)' }} />
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 5 }}>방 {onFloor.length}개</div>
                    </button>
                    {onFloor.map(({ r, st }) => {
                      const came = st.in;
                      const ratio = st.total ? came / st.total : 0;
                      return (
                        <button key={r.id} onClick={() => pickFloor(r.floor)} style={{ width: 150, textAlign: 'left', cursor: 'pointer', color: 'inherit', border: '1px solid var(--line)', borderRadius: 12, padding: 12, background: 'var(--panel)' }}>
                          <div style={{ fontSize: 13.5, fontWeight: 800 }}>{r.name}</div>
                          <div style={{ marginTop: 5, fontSize: 19, fontWeight: 800 }}>{came}<span style={{ fontSize: 12.5, color: 'var(--dim)', fontWeight: 700 }}> / {st.total}</span></div>
                          <div style={{ height: 7, borderRadius: 999, background: 'var(--panel2)', overflow: 'hidden', marginTop: 6 }}>
                            <div style={{ height: '100%', width: `${Math.round(ratio * 100)}%`, background: 'var(--ok)' }} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  // 한 층의 방들(저장된 배치면 그 위치, 아니면 자동 나열)
  const renderFloorRooms = (fl: number) => {
    const rms = roomsOnFloor(fl);
    if (!rms.length) return <div style={{ textAlign: 'center', color: 'var(--faint)', fontSize: 13, padding: 30 }}>이 층에 방이 없습니다.</div>;
    const positioned = rms.some((r) => r.pos_x || r.pos_y);
    if (positioned) {
      const W = Math.max(...rms.map((r) => r.pos_x + roomBW(r)), 400) + 50;
      const H = Math.max(...rms.map((r) => r.pos_y + roomBH(r) + 34), 300) + 50;
      return (
        <div style={{ position: 'relative', width: W, height: H, margin: '0 auto' }}>
          {rms.map((r) => (
            <div key={r.id} style={{ position: 'absolute', left: r.pos_x, top: r.pos_y }}>{ovRoom(r)}</div>
          ))}
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 30, justifyContent: 'center', alignItems: 'flex-start' }}>
        {rms.map((r) => ovRoom(r))}
      </div>
    );
  };

  // 층을 세로로 쌓아 스크롤 스냅 — 5층 위, 4층 아래. 다음 층이 살짝 보이며 자석처럼 붙음.
  // 스테이지가 고정 높이 스크롤 컨테이너라, 섹션은 스테이지의 100%(살짝 빼서 다음 층 peek).
  const renderFloorsStack = () => {
    const flDesc = [...floors].sort((a, b) => b - a);
    return (
      <>
        {flDesc.map((fl) => (
          <section
            key={fl}
            data-floor={fl}
            ref={(el) => { floorRefs.current[fl] = el; }}
            style={{ scrollSnapAlign: 'start', minHeight: 'calc(100% - 46px)', padding: 28, boxSizing: 'border-box' }}
          >
            <div style={{ zoom }}>{renderFloorRooms(fl)}</div>
          </section>
        ))}
      </>
    );
  };

  const renderOverview = () => {
    if (floorSel === 'all') {
      const flDesc = [...floors].sort((a, b) => b - a); // 5층 위 4층 아래
      return (
        <div>
          {flDesc.map((fl) => {
            const rms = roomsOnFloor(fl);
            if (!rms.length) return null;
            return (
              <div key={fl} style={{ marginBottom: 34 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 30, justifyContent: 'center', alignItems: 'flex-start' }}>
                  {rms.map((r) => ovRoom(r))}
                </div>
              </div>
            );
          })}
        </div>
      );
    }
    const rms = roomsOnFloor(floorSel as number);
    // 저장된 배치(pos)가 있으면 실제 위치대로 절대 배치, 없으면 자동 배열
    const positioned = rms.some((r) => r.pos_x || r.pos_y);
    if (positioned) {
      const W = Math.max(...rms.map((r) => r.pos_x + roomBW(r)), 400) + 50;
      const H = Math.max(...rms.map((r) => r.pos_y + roomBH(r) + 34), 300) + 50;
      return (
        <div style={{ position: 'relative', width: W, height: H, margin: '0 auto' }}>
          {rms.map((r) => (
            <div key={r.id} style={{ position: 'absolute', left: r.pos_x, top: r.pos_y }}>{ovRoom(r)}</div>
          ))}
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 30, justifyContent: 'center', alignItems: 'flex-start' }}>
        {rms.map((r) => ovRoom(r))}
      </div>
    );
  };

  // 전체 배치 편집 캔버스 — 방 블록을 드래그해 배치
  const renderArrange = () => {
    if (typeof floorSel !== 'number') return null;
    const rms = roomsOnFloor(floorSel);
    const W = Math.max(...rms.map((r) => (roomPos[r.id]?.x ?? 0) + roomBW(r)), 520) + 70;
    const H = Math.max(...rms.map((r) => (roomPos[r.id]?.y ?? 0) + roomBH(r) + 34), 360) + 70;
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 12.5, color: 'var(--dim)', marginBottom: 12 }}>
          방을 드래그해 실제 건물처럼 배치하세요 · <Ic d={I_EDIT} size={12} /> 로 이름·층·삭제
        </div>
        <div
          ref={arrangeRef}
          style={{
            position: 'relative', width: W, height: H, margin: '0 auto',
            border: '1px dashed var(--accent)', borderRadius: 16, background: 'var(--panel)',
            backgroundImage: 'radial-gradient(rgba(0,0,0,.06) 1.2px, transparent 1.2px)',
            backgroundSize: '20px 20px', backgroundPosition: '10px 10px',
          }}
        >
          {rms.map((r) => {
            const p = roomPos[r.id] ?? { x: 0, y: 0 };
            const rs = seatsByRoom.get(r.id) ?? [];
            const bb = bounds(rs.map((s, i) => seatXY(s, i)));
            return (
              <div key={r.id} onPointerDown={(e) => onRoomDown(e, r.id)} style={{ position: 'absolute', left: p.x, top: p.y, cursor: 'grab', userSelect: 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
                  {r.name} · {r.floor}층
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); setRoomSettings(r.id); }}
                    style={{ border: '1px solid var(--line)', background: 'var(--panel2)', borderRadius: 7, width: 24, height: 24, display: 'grid', placeItems: 'center', cursor: 'pointer' }}
                  >
                    <Ic d={I_EDIT} size={12} />
                  </button>
                </div>
                <div style={{ position: 'relative', width: bb.w, height: bb.h, borderRadius: 12, border: '1.5px solid var(--accent)', background: 'rgba(91,141,239,.06)' }}>
                  {rs.map((s, i) => staticSeat(s, i, false))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ---------------- drawer ----------------
  const [assignPick, setAssignPick] = useState('');
  const [typeVal, setTypeVal] = useState('');
  const numRef = useRef<HTMLInputElement>(null);
  const openStudent = selSeat?.current_student_id ? stuById.get(selSeat.current_student_id) ?? null : null;

  const rotateFacing = (s: Seat) => {
    const cur = s.facing || 'down';
    const next = FACINGS[(FACINGS.indexOf(cur) + 1) % 4];
    call(updateSeat, { seatId: s.id, facing: next });
  };

  // ---------------- render ----------------
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 툴바 */}
      <div className="flex items-center gap-3 px-5" style={{ height: 56, borderBottom: '1px solid var(--line)', flex: 'none' }}>
        {/* 층 선택은 왼쪽 세로 레일로 이동. 편집 중엔 방 이름 표시 */}
        <div className="flex items-center" style={{ flex: 1, minWidth: 0, paddingLeft: 6, gap: 10 }}>
          {mode === 'edit' && selRoom && (
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>
              {selRoom.name} <span style={{ color: 'var(--dim)', fontWeight: 500 }}>· 좌석 편집 중</span>
            </span>
          )}
          {mode === 'view' && attentionSummary > 0 && (
            <span
              title="스케쥴상 지금 원 안에 있어야 하는데 오늘 출결·순찰 기록이 없는 학생"
              style={{ fontSize: 12, fontWeight: 700, color: 'var(--warn)' }}
            >
              확인 필요 {attentionSummary}명
            </span>
          )}
        </div>

        {/* 우측 액션 */}
        <div className="flex items-center gap-2" style={{ flex: 'none', position: 'relative' }}>
          {!arrange && mode === 'view' && floorSel !== 'all' && canPatrol && (
            <button
              className="btn"
              onClick={() => setPatrolConfirm(patrolMode ? 'end' : (resume ? 'resume' : 'start'))}
              title="순찰 모드"
              style={{ height: 36, padding: '0 14px', fontSize: 13, ...(patrolMode ? { background: '#e5484d', borderColor: '#e5484d', color: '#fff' } : {}) }}
            >
              <Ic d={I_PATROL} /> {patrolMode ? '순찰 종료' : resume ? '이어하기' : '순찰'}
            </button>
          )}
          {!arrange && mode === 'view' && canPatrol && (
            <button type="button" onClick={() => {}} className="btn" title="순찰 기록(데모 범위 밖)" style={{ height: 36, padding: '0 12px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
              <Ic d={I_CLOCK} /> 기록
            </button>
          )}
          {!arrange && mode === 'view' && floorSel !== 'all' && (
            <div className="flex items-center" style={{ border: '1px solid var(--line)', borderRadius: 9, overflow: 'hidden', height: 36 }}>
              <button onClick={() => zoomBy(-0.15)} title="축소" style={{ border: 'none', background: 'var(--panel)', width: 32, height: 34, cursor: 'pointer', fontSize: 17, color: 'var(--dim)' }}>−</button>
              <button onClick={() => setZoom(1.15)} title="기본 크기" style={{ border: 'none', borderLeft: '1px solid var(--line)', borderRight: '1px solid var(--line)', background: 'var(--panel)', height: 34, padding: '0 8px', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--dim)', minWidth: 50 }}>{Math.round(zoom * 100)}%</button>
              <button onClick={() => zoomBy(0.15)} title="확대" style={{ border: 'none', background: 'var(--panel)', width: 32, height: 34, cursor: 'pointer', fontSize: 16, color: 'var(--dim)' }}>+</button>
            </div>
          )}
          {canManage && (
            numberEditMode ? (
              <button className="btn btn-accent" onClick={() => setNumberEditMode(false)} style={{ height: 36, padding: '0 14px', fontSize: 13 }}>
                <Ic d={I_CHECK} /> 번호 수정 완료
              </button>
            ) : (
              <div style={{ position: 'relative' }}>
                <button className="btn" onClick={(e) => { e.stopPropagation(); setSettingsMenuOpen((v) => !v); }} title="설정" style={{ height: 36, padding: '0 12px', fontSize: 13 }}>
                  <Ic d={I_GEAR} /> 설정
                </button>
                {settingsMenuOpen && (
                  <>
                    <div onClick={() => setSettingsMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
                    <div style={{
                      position: 'absolute', top: 44, right: 0, background: 'var(--panel)', border: '1px solid var(--line)',
                      borderRadius: 12, boxShadow: '0 8px 24px rgba(20,22,30,.18)', padding: 6, zIndex: 40, minWidth: 190,
                    }}>
                      <button className="menuitem" style={menuItemStyle} onClick={() => { setSettingsMenuOpen(false); setNumberEditMode(true); }}>좌석 번호 재지정</button>
                      <div style={{ padding: '6px 11px 2px', fontSize: 11, color: 'var(--faint)' }}>다른 설정은 추후 추가</div>
                    </div>
                  </>
                )}
              </div>
            )
          )}
        </div>
      </div>

      {movingStudentId && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '9px 20px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--line)', flex: 'none' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>{stuById.get(movingStudentId)?.name ?? '학생'} 이동 — 옮길 빈 자리를 클릭하세요</span>
          <button className="chip" onClick={() => setMovingStudentId(null)} style={{ cursor: 'pointer' }}>취소</button>
        </div>
      )}

      {patrolMode && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '9px 20px', background: 'rgba(229,72,77,.08)', borderBottom: '1px solid var(--line)', flex: 'none', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#e5484d' }}>순찰 중</span>
          <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
            시작 {patrolStartedAt ? new Date(patrolStartedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : ''} · 경과 <PatrolElapsed startedAt={patrolStartedAt} />
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>누적 벌점 <b style={{ color: '#e5484d' }}>{patrolTally}점</b></span>
          {patrolSummary && (
            <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
              점검 {patrolSummary.marked}/{patrolSummary.total}
              {patrolSummary.exempt > 0 && <span style={{ color: 'var(--faint)', fontWeight: 700 }}> · 제외 {patrolSummary.exempt}명</span>}
              {patrolSummary.present > 0 && ` · 예상 재실 ${patrolSummary.present}명`}
              {patrolSummary.brk > 0 && ` · 쉬는시간 ${patrolSummary.brk}명`}
              {patrolSummary.away > 0 && ` · 등원전 ${patrolSummary.away}명`}
              {patrolSummary.unset > 0 && ` · 미설정 ${patrolSummary.unset}명`}
            </span>
          )}
          <button
            onClick={refreshNowMin}
            title="지금 시각으로 갱신"
            className="chip"
            style={{ cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}
          >
            기준 {nowMin != null ? fmtHM(nowMin) : '--:--'}
          </button>
        </div>
      )}

      {/* 본문 — 왼쪽 층 레일(5층 위 → 4층 아래) + 무대 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* 층 선택 레일 (세로, 건물 순서) */}
        <div style={{ flex: 'none', width: 76, borderRight: '1px solid var(--line)', background: 'var(--card)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 0', overflowY: 'auto' }}>
          {[...floors].sort((a, b) => b - a).map((f) => {
            const on = floorSel === f;
            return (
              <button key={f} onClick={() => pickFloor(f)} style={{
                width: 60, padding: '11px 0', borderRadius: 11, cursor: 'pointer', fontSize: 14,
                border: `1px solid ${on ? 'var(--accent)' : 'transparent'}`,
                background: on ? 'var(--accent-soft)' : 'transparent',
                color: on ? 'var(--accent)' : 'var(--dim)', fontWeight: on ? 800 : 600,
              }}>{f}층</button>
            );
          })}
          <div style={{ height: 1, width: 42, background: 'var(--line)', margin: '4px 0' }} />
          <button onClick={() => pickFloor('all')} title="대시보드" style={{
            width: 60, height: 46, borderRadius: 11, cursor: 'pointer', display: 'grid', placeItems: 'center',
            border: `1px solid ${floorSel === 'all' ? 'var(--accent)' : 'transparent'}`,
            background: floorSel === 'all' ? 'var(--accent-soft)' : 'transparent',
            color: floorSel === 'all' ? 'var(--accent)' : 'var(--dim)',
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" />
            </svg>
          </button>
        </div>

        {/* 무대 — 층 스택은 스크롤 스냅(자석), 그 외(대시보드·편집·배치편집)는 일반 */}
      <div
        ref={stageRef}
        style={{
          flex: 1, overflow: 'auto',
          padding: floorStack ? 0 : 28,
          scrollSnapType: floorStack ? 'y mandatory' : undefined,
        }}
      >
        {rooms.length === 0 ? (
          <div className="card p-10 text-center" style={{ color: 'var(--faint)', fontSize: 14, maxWidth: 480, margin: '40px auto' }}>
            아직 방이 없습니다.{canManage && ' 우측 상단 추가 › 방 추가 로 시작하세요.'}
          </div>
        ) : floorStack ? (
          renderFloorsStack()
        ) : (
          <div style={{ zoom: (arrange || mode === 'edit' || floorSel === 'all') ? 1 : zoom }}>
            {arrange
              ? renderArrange()
              : (mode === 'edit' && selRoom)
                ? renderSingleRoom()
                : floorSel === 'all'
                  ? renderDashboard()
                  : renderFloorRooms(floorSel)}
          </div>
        )}
      </div>
      </div>

      {/* 좌석 클릭 → 중앙 팝업 */}
      {selSeat && (
        <>
          <div onClick={closeDrawer} style={{ position: 'fixed', inset: 0, background: 'rgba(20,22,30,.45)', zIndex: 55 }} />
          <div style={{
            position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
            width: openStudent ? 720 : 420, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 60px)', overflowY: 'auto',
            background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 20, boxShadow: '0 24px 70px rgba(20,22,30,.35)', zIndex: 56,
          }}>
            {openStudent ? (
              <StudentPopup
                student={openStudent}
                seatLabel={`${selSeat.number ?? selSeat.label}번`}
                canManage={canManage}
                canAttend={canAttend}
                onClose={closeDrawer}
                onCheckOutRequest={(sid) => { closeDrawer(); openCheckoutConfirm(sid); }}
                actions={<>
                  {canManage && <button className="btn" onClick={() => call(releaseSeat, { seatId: selSeat.id }, closeDrawer)} style={{ height: 40, fontSize: 13, gap: 6 }}><ReleaseSeatIcon /> 자리 비우기</button>}
                  {canManage && <button className="btn" onClick={() => { setMovingStudentId(openStudent.id); closeDrawer(); }} style={{ height: 40, fontSize: 13, gap: 6 }}><MoveSeatIcon /> 자리 이동</button>}
                </>}
              />
            ) : (
              <>
                <div className="flex items-center justify-between" style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ fontSize: 17, fontWeight: 800 }}>{selSeat.number ?? selSeat.label}번 좌석 <span style={{ fontSize: 13, color: 'var(--dim)', fontWeight: 600 }}>· 공석</span></div>
                  <button onClick={closeDrawer} className="chip" style={{ height: 30, width: 30, padding: 0, justifyContent: 'center', cursor: 'pointer' }}><Ic d={I_CLOSE} size={14} /></button>
                </div>
                {canManage && selSeat.status !== 'maintenance' ? (
                  <div style={{ padding: 20 }}>
                    <div className="label">미배정 학생 · 눌러서 배정</div>
                    <div style={{ border: '1px solid var(--line)', borderRadius: 12, maxHeight: 340, overflowY: 'auto' }}>
                      {unseated.length === 0 ? (
                        <div style={{ padding: 18, textAlign: 'center', color: 'var(--faint)', fontSize: 13 }}>미배정 학생이 없습니다.</div>
                      ) : (
                        unseated.map((s, i) => (
                          <button key={s.id} onClick={() => call(assignSeat, { seatId: selSeat.id, studentId: s.id }, closeDrawer)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '11px 14px', border: 'none', borderTop: i ? '1px solid var(--line)' : 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', color: 'inherit' }}>
                            <span style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</span>
                            <span style={{ fontSize: 12, color: 'var(--faint)' }}>{lbl(s) || s.school || ''}</span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: 20, color: 'var(--dim)', fontSize: 14 }}>공석</div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* 좌석 우클릭 컨텍스트 메뉴 */}
      {seatMenu && (
        <ContextMenu
          x={seatMenu.x}
          y={seatMenu.y}
          header={`${seatMenu.seat.number ?? seatMenu.seat.label}번${seatMenu.seat.current_student_id ? ` · ${stuById.get(seatMenu.seat.current_student_id)?.name ?? ''}` : ' · 공석'}`}
          items={seatMenuItems(seatMenu.seat)}
          onClose={() => setSeatMenu(null)}
        />
      )}

      {/* 순찰 상태 선택 메뉴 */}
      {patrolMenu && (
        <ContextMenu
          x={patrolMenu.x}
          y={patrolMenu.y}
          header={`${patrolMenu.seat.number ?? patrolMenu.seat.label}번 · ${patrolMenu.seat.current_student_id ? stuById.get(patrolMenu.seat.current_student_id)?.name ?? '' : ''} — 순찰`}
          items={patrolMenuItems(patrolMenu.seat)}
          onClose={() => setPatrolMenu(null)}
        />
      )}

      {/* 이어하기 확인창 (시작/종료와 버튼 구성이 달라 별도 분기) */}
      {patrolConfirm === 'resume' && resume && (
        <>
          <div onClick={() => setPatrolConfirm(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(20,22,30,.45)', zIndex: 70 }} />
          <div style={{
            position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 360, maxWidth: 'calc(100vw - 32px)',
            background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 20, boxShadow: '0 24px 70px rgba(20,22,30,.35)', zIndex: 71, padding: 24,
          }}>
            <div style={{ width: 46, height: 46, borderRadius: 14, margin: '0 auto 14px', display: 'grid', placeItems: 'center', background: 'rgba(229,72,77,.12)', color: '#e5484d' }}>
              <Ic d={I_PATROL} size={22} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, textAlign: 'center', marginBottom: 8 }}>하던 순찰을 이어할까요?</div>
            <div style={{ fontSize: 12.5, color: 'var(--dim)', marginBottom: 18, lineHeight: 1.6, textAlign: 'center' }}>
              {resume.dayLabel} {resume.timeLabel} 시작 · {resume.startedByName} · {resume.markedCount}명 점검
              {resume.lastLabel ? ` · 마지막 기록 ${resume.lastLabel}` : ''}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-accent" onClick={doResumePatrol} style={{ height: 44, fontWeight: 800 }}>이어하기</button>
              <button className="btn" onClick={doFreshPatrol} style={{ height: 44, color: 'var(--danger)' }}>새로 시작 (기존 기록은 종료 처리)</button>
              <button className="btn" onClick={() => setPatrolConfirm(null)} style={{ height: 44 }}>취소</button>
            </div>
          </div>
        </>
      )}

      {/* 순찰 시작/종료 확인창 */}
      {patrolConfirm && patrolConfirm !== 'resume' && (() => {
        const now = Date.now(); // 확인창은 잠깐 뜨는 모달 — 스냅샷으로 충분(매초 갱신 불필요)
        const fmtClock = (ms: number) => {
          const d = new Date(ms); const h = d.getHours(), m = d.getMinutes();
          return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}시 ${String(m).padStart(2, '0')}분`;
        };
        const isStart = patrolConfirm === 'start';
        let line1 = '';
        if (isStart) {
          if (!lastPatrolAt) line1 = '이전 순찰 기록 없음';
          else {
            const sec = Math.max(0, Math.floor((now - new Date(lastPatrolAt).getTime()) / 1000));
            const min = Math.floor(sec / 60);
            line1 = sec < 60 ? '방금 전 순찰' : min < 60 ? `${min}분 전 순찰` : `${Math.floor(min / 60)}시간 ${min % 60}분 전 순찰`;
          }
        } else {
          const sec = patrolStartedAt ? Math.max(0, Math.floor((now - patrolStartedAt) / 1000)) : 0;
          const m = Math.floor(sec / 60), ss = sec % 60;
          line1 = `이번 순찰에 소요된 시간 ${m > 0 ? `${m}분 ` : ''}${ss}초`;
        }
        const hasWarn = !isStart && uncheckedPatrol.length > 0;
        const shown = uncheckedPatrol.slice(0, 12).map((s) => `${s.number ?? s.label}번 ${s.current_student_id ? stuById.get(s.current_student_id)?.name ?? '' : ''}`);
        const rest = uncheckedPatrol.length - shown.length;
        return (
          <>
            <div onClick={() => setPatrolConfirm(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(20,22,30,.45)', zIndex: 70 }} />
            <div style={{
              position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 340, maxWidth: 'calc(100vw - 32px)',
              background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 20, boxShadow: '0 24px 70px rgba(20,22,30,.35)', zIndex: 71, padding: 24, textAlign: 'center',
            }}>
              <div style={{ width: 46, height: 46, borderRadius: 14, margin: '0 auto 14px', display: 'grid', placeItems: 'center', background: 'rgba(229,72,77,.12)', color: '#e5484d' }}>
                <Ic d={I_PATROL} size={22} />
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--dim)' }}>{line1}</div>
              <div style={{ fontSize: 13, color: 'var(--faint)', marginTop: 4 }}>현재 시각 {fmtClock(now)}</div>
              <div style={{ fontSize: 16, fontWeight: 800, margin: '14px 0 18px' }}>{isStart ? '순찰을 시작하시겠습니까?' : '순찰을 종료하시겠습니까?'}</div>
              {hasWarn && (
                <div style={{ background: 'var(--warn-soft)', border: '1px solid var(--warn)', borderRadius: 12, padding: '10px 12px', margin: '-8px 0 18px', fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.6, textAlign: 'left' }}>
                  <div style={{ fontWeight: 800, marginBottom: 4 }}>미점검 {uncheckedPatrol.length}명</div>
                  {shown.join(', ')}{rest > 0 ? ` 외 ${rest}명` : ''}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button className="btn" onClick={() => setPatrolConfirm(null)} style={{ height: 44 }}>취소</button>
                <button className="btn btn-accent" onClick={isStart ? doStartPatrol : doEndPatrol} style={{ height: 44, ...(isStart ? {} : { background: '#e5484d', borderColor: '#e5484d' }) }}>
                  {isStart ? '시작' : hasWarn ? `미점검 ${uncheckedPatrol.length}명 · 그대로 종료` : '종료'}
                </button>
              </div>
            </div>
          </>
        );
      })()}

      {/* 퇴실 확인창 — checkoutBranchAt() 분류(원 안/밖/스케쥴 없음)에 따라 문구·사유 기본값이 갈린다. */}
      {checkoutConfirm && (() => {
        const cc = checkoutConfirm;
        const branch = cc.branch;
        const name = stuById.get(cc.studentId)?.name ?? '학생';
        const seat = seats.find((s) => s.current_student_id === cc.studentId);
        const occ = occupancy[cc.studentId];
        const close = () => setCheckoutConfirm(null);
        const confirmWith = (note: string | null) => {
          call(checkOut, { studentId: cc.studentId, note: note ?? '' }, close);
        };
        const presetPicker = (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {CHECKOUT_REASON_PRESETS.map((p) => (
                <button
                  key={p}
                  className="btn"
                  onClick={() => (p === CHECKOUT_OTHER_REASON
                    ? setCheckoutConfirm({ ...cc, otherOpen: true })
                    : confirmWith(p))}
                  style={{ height: 40, padding: '0 14px', fontSize: 13, fontWeight: 700, ...checkoutReasonStyle(p, p === CHECKOUT_OTHER_REASON && cc.otherOpen) }}
                >
                  {p}
                </button>
              ))}
            </div>
            {cc.otherOpen && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input
                  className="input"
                  autoFocus
                  placeholder="사유 입력"
                  value={cc.otherText}
                  onChange={(e) => setCheckoutConfirm({ ...cc, otherText: e.target.value })}
                  style={{ height: 40, flex: 1 }}
                />
                <button
                  className="btn btn-accent"
                  disabled={!cc.otherText.trim()}
                  onClick={() => confirmWith(cc.otherText.trim())}
                  style={{ height: 40, padding: '0 16px' }}
                >확인</button>
              </div>
            )}
          </>
        );
        // 문장마다 줄바꿈 — 한 번에 읽기 쉽게(가독성 요건).
        let bodyLines: string[] = [];
        if (branch.kind === 'inside') {
          bodyLines = [`지금은 ${branch.label} 시간입니다.`, '자리에 있어야 하는 시간인데 퇴실 처리할까요?'];
        } else if (branch.kind === 'outside') {
          bodyLines = branch.slot
            ? [`지금은 ${branch.label} 일정입니다 (${fmtHM(branch.slot.start)}–${fmtHM(branch.slot.end)}).`, '퇴실 처리할까요?']
            : [`지금은 ${branch.label} 상태입니다.`, '퇴실 처리할까요?'];
        } else {
          bodyLines = ['이 학생은 시간표가 없습니다.', '퇴실 처리할까요?'];
        }
        return (
          <>
            <div onClick={close} style={{ position: 'fixed', inset: 0, background: 'rgba(20,22,30,.45)', zIndex: 70 }} />
            <div style={{
              position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 380, maxWidth: 'calc(100vw - 32px)',
              background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 20, boxShadow: '0 24px 70px rgba(20,22,30,.35)', zIndex: 71, padding: 24,
            }}>
              <div style={{ width: 46, height: 46, borderRadius: 14, margin: '0 auto 12px', display: 'grid', placeItems: 'center', background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                <Ic d={I_LOGOUT} size={22} />
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, textAlign: 'center' }}>{name}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, margin: '5px 0 16px' }}>
                {seat && <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>{seat.number ?? seat.label}번</span>}
                {occ && (
                  <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 999, backgroundColor: ATT_COLOR[occ.kind].bg, color: occ.kind === 'in' ? ink('present') : 'var(--faint)' }}>
                    {ATT_LABEL[occ.kind]}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, margin: '0 0 18px', textAlign: 'center', lineHeight: 1.65 }}>
                {bodyLines.map((ln, i) => <div key={i}>{ln}</div>)}
              </div>

              {branch.kind === 'inside' && presetPicker}
              {branch.kind === 'none' && (
                <>
                  {presetPicker}
                  <button className="btn btn-accent" onClick={() => confirmWith(null)} style={{ height: 44, width: '100%', marginTop: 12 }}>퇴실 처리</button>
                </>
              )}
              {branch.kind === 'outside' && (
                cc.expanded ? presetPicker : (
                  <>
                    <button className="btn btn-accent" onClick={() => confirmWith(branch.label)} style={{ height: 44, width: '100%' }}>확인</button>
                    <button className="btn" onClick={() => setCheckoutConfirm({ ...cc, expanded: true })} style={{ height: 34, width: '100%', marginTop: 8, fontSize: 12.5 }}>다른 사유 선택</button>
                  </>
                )
              )}

              <button className="btn" onClick={close} style={{ height: 40, width: '100%', marginTop: 14 }}>취소</button>
            </div>
          </>
        );
      })()}

      {/* 순찰 종료 토스트 */}
      {patrolToast && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 90,
          display: 'flex', alignItems: 'center', gap: 9, padding: '11px 18px', borderRadius: 999,
          background: 'var(--ink)', color: 'var(--card)', fontSize: 13.5, fontWeight: 600, boxShadow: '0 10px 30px rgba(20,22,30,.3)',
        }}>
          <svg viewBox="0 0 24 24" style={{ width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d="M20 6L9 17l-5-5" /></svg>
          {patrolToast}
        </div>
      )}

      {/* 모달 */}
      {modal && (
        <>
          <div onClick={() => setModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 60 }} />
          <div style={{
            position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 420, maxWidth: 'calc(100vw - 32px)',
            background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 20, boxShadow: '0 20px 60px rgba(0,0,0,.5)', zIndex: 61,
          }}>
            {modal === 'student' ? (
              <StudentModal onClose={() => setModal(null)} />
            ) : (
              <RoomModal onClose={() => setModal(null)} floors={floors} defaultFloor={floorSel === 'all' ? (floors[0] ?? 4) : (floorSel as number)} />
            )}
          </div>
        </>
      )}

      {/* 방 설정 모달 */}
      {roomSettings && (() => {
        const r = rooms.find((x) => x.id === roomSettings);
        if (!r) return null;
        const floorOpts = Array.from(new Set([...floors, 4, 5, r.floor])).sort((a, b) => a - b);
        return (
          <>
            <div onClick={() => setRoomSettings(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 60 }} />
            <div style={{
              position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 380, maxWidth: 'calc(100vw - 32px)',
              background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 20, boxShadow: '0 20px 60px rgba(0,0,0,.5)', zIndex: 61,
            }}>
              <div style={{ padding: '20px 22px 0', fontSize: 17, fontWeight: 800 }}>방 설정</div>
              <form onSubmit={(e) => { e.preventDefault(); updateRoom(new FormData(e.currentTarget)); setRoomSettings(null); }}>
                <input type="hidden" name="roomId" value={r.id} />
                <div style={{ padding: '16px 22px 0' }}>
                  <div style={{ marginBottom: 12 }}>
                    <div className="label">방 이름</div>
                    <input className="input" name="name" defaultValue={r.name} required style={{ height: 42 }} />
                  </div>
                  <div>
                    <div className="label">층</div>
                    <select className="input" name="floor" defaultValue={String(r.floor)} style={{ height: 42 }}>
                      {floorOpts.map((f) => <option key={f} value={f}>{f}층</option>)}
                    </select>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <div className="label">입구(문) 위치</div>
                    <select className="input" name="door_side" defaultValue={r.door_side ?? ''} style={{ height: 42 }}>
                      <option value="">없음</option>
                      <option value="top">위쪽</option>
                      <option value="bottom">아래쪽</option>
                      <option value="left">왼쪽</option>
                      <option value="right">오른쪽</option>
                    </select>
                  </div>
                  <div className="flex justify-end gap-2" style={{ marginTop: 16 }}>
                    <button type="button" className="btn" onClick={() => setRoomSettings(null)} style={{ height: 40, fontSize: 13 }}>취소</button>
                    <button className="btn btn-accent" style={{ height: 40, fontSize: 13 }}>저장</button>
                  </div>
                </div>
              </form>
              <div style={{ padding: '12px 22px 20px', borderTop: '1px solid var(--line)', marginTop: 14 }}>
                <button
                  className="btn"
                  onClick={() => { if (confirm(`'${r.name}' 방과 그 방의 좌석을 모두 삭제할까요?`)) call(deleteRoom, { roomId: r.id }, () => { setRoomSettings(null); setArrange(false); }); }}
                  style={{ width: '100%', height: 40, fontSize: 13, color: 'var(--danger)' }}
                >이 방 삭제 (좌석 포함)</button>
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}

const menuItemStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, width: '100%', border: 'none', background: 'transparent',
  color: 'var(--txt)', fontSize: 13.5, fontWeight: 600, padding: '9px 11px', borderRadius: 8, textAlign: 'left', cursor: 'pointer',
};

// ---------------- student modal ----------------
function StudentModal({ onClose }: { onClose: () => void }) {
  const [level, setLevel] = useState<'middle' | 'high' | 'adult'>('high');
  return (
    <form onSubmit={(e) => { e.preventDefault(); addStudent(new FormData(e.currentTarget)); onClose(); }}>
      <div style={{ padding: '20px 22px 0', fontSize: 17, fontWeight: 800 }}>학생 추가</div>
      <div style={{ padding: '16px 22px 22px' }}>
        <div style={{ marginBottom: 12 }}>
          <div className="label">이름</div>
          <input className="input" name="name" placeholder="이름" required style={{ height: 42 }} />
        </div>
        <div className="flex gap-2" style={{ marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="label">구분</div>
            <select className="input" name="level" value={level} onChange={(e) => setLevel(e.target.value as 'middle' | 'high' | 'adult')} style={{ height: 42 }}>
              <option value="middle">중학교</option>
              <option value="high">고등학교</option>
              <option value="adult">성인</option>
            </select>
          </div>
          <div style={{ width: 130 }}>
            <div className="label">{level === 'adult' ? 'N수생' : '학년'}</div>
            {level !== 'adult' ? (
              <select className="input" name="grade" defaultValue="1" style={{ height: 42 }}>
                <option value="1">1학년</option>
                <option value="2">2학년</option>
                <option value="3">3학년</option>
              </select>
            ) : (
              <label className="flex items-center gap-2" style={{ height: 42, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel2)', fontSize: 13, color: 'var(--dim)' }}>
                <input type="checkbox" name="is_repeat" value="1" /> N수생
              </label>
            )}
          </div>
        </div>
        <div className="flex gap-2" style={{ marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="label">생년월일</div>
            <input className="input" name="birthdate" type="date" style={{ height: 42 }} />
          </div>
          <div style={{ width: 110 }}>
            <div className="label">성별</div>
            <select className="input" name="gender" defaultValue="" style={{ height: 42 }}>
              <option value="">선택</option>
              <option value="male">남</option>
              <option value="female">여</option>
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div className="label">학교</div>
          <input className="input" name="school" placeholder="학교" style={{ height: 42 }} />
        </div>
        <div className="flex gap-2">
          <div style={{ flex: 1 }}>
            <div className="label">학부모 연락처</div>
            <input className="input" name="guardian_phone" placeholder="010-" style={{ height: 42 }} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="label">학생 연락처</div>
            <input className="input" name="student_phone" placeholder="010-" style={{ height: 42 }} />
          </div>
        </div>
        <div className="flex justify-end gap-2" style={{ marginTop: 18 }}>
          <button type="button" className="btn" onClick={onClose} style={{ height: 40, fontSize: 13 }}>취소</button>
          <button className="btn btn-accent" style={{ height: 40, fontSize: 13 }}>추가</button>
        </div>
      </div>
    </form>
  );
}

// ---------------- room modal ----------------
function RoomModal({ onClose, floors, defaultFloor }: { onClose: () => void; floors: number[]; defaultFloor: number }) {
  const base = floors.length ? floors : [4, 5];
  const floorOpts = Array.from(new Set([...base, 4, 5, defaultFloor])).sort((a, b) => a - b);
  return (
    <form onSubmit={(e) => { e.preventDefault(); createRoom(new FormData(e.currentTarget)); onClose(); }}>
      <div style={{ padding: '20px 22px 0', fontSize: 17, fontWeight: 800 }}>방 추가</div>
      <div style={{ padding: '16px 22px 22px' }}>
        <div style={{ marginBottom: 12 }}>
          <div className="label">방 이름</div>
          <input className="input" name="name" placeholder="예: A실" required style={{ height: 42 }} />
        </div>
        <div>
          <div className="label">층</div>
          <select className="input" name="floor" defaultValue={String(defaultFloor)} style={{ height: 42 }}>
            {floorOpts.map((f) => <option key={f} value={f}>{f}층</option>)}
          </select>
        </div>
        <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 8 }}>빈 방으로 만든 뒤, 편집에서 좌석을 하나씩 추가하세요.</div>
        <div className="flex justify-end gap-2" style={{ marginTop: 18 }}>
          <button type="button" className="btn" onClick={onClose} style={{ height: 40, fontSize: 13 }}>취소</button>
          <button className="btn btn-accent" style={{ height: 40, fontSize: 13 }}>만들기</button>
        </div>
      </div>
    </form>
  );
}
