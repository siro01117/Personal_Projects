'use client';

/* ---------------------------------------------------------------------------
   필기 캔버스 — 아이패드 + 애플펜슬 기준.

   설계 요점 네 가지:
   1) 손바닥 거치 방지. 펜이 한 번이라도 감지되면 그 뒤로 touch 입력은 그리기에서 무시한다.
      손가락은 스크롤·확대만 하게 둔다. 이게 없으면 손을 올린 순간 화면이 낙서로 덮인다.
   2) 압력. pressure 를 굵기 0.5~2.0배로 반영하고, getCoalescedEvents() 로 한 프레임에
      묶여 들어온 중간점까지 모두 찍어 선을 매끄럽게 만든다.
   3) 벡터로 저장. 점 좌표 + 압력 배열이다. PNG 로 굽지 않는다 — 용량도 문제지만
      확대하면 뭉개지고, 다른 기기에서 폭이 달라지면 다시 못 쓴다.
   4) 좌표 정규화. x 는 0~1(폭 기준), y 도 0~1(높이 기준)로 저장한다. 폰에서 적고
      아이패드에서 열어도 같은 그림이 나온다.

   touch-action:none 은 이 캔버스에만 준다. 페이지 전체에 주면 스크롤이 죽는다.
--------------------------------------------------------------------------- */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Highlighter, Pen, Trash2, Undo2 } from 'lucide-react';

const ASPECT = 0.58;           // 높이 = 폭 * ASPECT. 가로로 긴 메모지 비율.
const MAX_H = 440;             // 다만 넓은 화면에서 화면을 다 잡아먹지 않게 높이는 여기서 끊는다.
const BASE_W = 1000;           // 굵기 기준 폭 — 실제 폭이 이보다 좁으면 비례해 가늘어진다.
const TOOLS = [
  { key: 'pen', label: '펜', icon: Pen, size: 2.6 },
  { key: 'hl', label: '형광펜', icon: Highlighter, size: 16 },
  { key: 'eraser', label: '지우개', icon: Eraser, size: 0 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 압력 → 굵기 배율. 마우스는 pressure 를 0 이나 0.5 로 주므로 그때는 1배로 둔다.
function widthFactor(pressure, isPen) {
  if (!isPen || !pressure) return 1;
  return clamp(0.5 + pressure * 1.5, 0.5, 2);
}

export default function InkCanvas({ value, onChange, label = '필기' }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);          // 확정된 스트로크
  const liveRef = useRef(null);           // 그리는 중인 스트로크
  const penSeenRef = useRef(false);
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef(0);
  const colorsRef = useRef({ ink: '#000', hl: '#cc0' });

  const [tool, setTool] = useState('pen');
  const [penMode, setPenMode] = useState(false);   // 화면 안내용 (펜 감지 여부)
  const [count, setCount] = useState(0);

  // 바깥에서 들어온 값이 바뀌면(다른 과목으로 이동 등) 통째로 갈아끼운다.
  useEffect(() => {
    strokesRef.current = Array.isArray(value) ? value : [];
    setCount(strokesRef.current.length);
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  /* ----------------------------------------------------------- 그리기 */

  const drawStroke = useCallback((ctx, st, w, h) => {
    const pts = st?.points;
    if (!Array.isArray(pts) || pts.length === 0) return;
    const hl = st.tool === 'hl';
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = hl ? colorsRef.current.hl : colorsRef.current.ink;
    if (hl) {
      // 곱하기 합성 + 반투명 — 밑줄 친 글자가 비쳐 보여야 형광펜이다.
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.32;
    }
    const scale = w / BASE_W;
    const base = (st.size || 2.6) * scale;

    if (pts.length === 1) {
      const [x, y, p] = pts[0];
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(x * w, y * h, Math.max(0.4, (base * widthFactor(p, st.pen)) / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    // 굵기가 점마다 달라지므로 한 번에 긋지 않고 구간별로 나눠 긋는다.
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0, p0] = pts[i - 1];
      const [x1, y1, p1] = pts[i];
      ctx.beginPath();
      ctx.lineWidth = Math.max(0.4, base * widthFactor((p0 + p1) / 2, st.pen));
      ctx.moveTo(x0 * w, y0 * h);
      ctx.lineTo(x1 * w, y1 * h);
      ctx.stroke();
    }
    ctx.restore();
  }, []);

  const render = useCallback(() => {
    rafRef.current = 0;
    const cv = canvasRef.current;
    if (!cv) return;
    const { w, h } = sizeRef.current;
    if (!w || !h) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    for (const st of strokesRef.current) drawStroke(ctx, st, w, h);
    if (liveRef.current) drawStroke(ctx, liveRef.current, w, h);
  }, [drawStroke]);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(render);
  }, [render]);

  /* --------------------------------------------------------- 크기 조정 */

  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;

    const resize = () => {
      const w = Math.max(1, Math.round(wrap.clientWidth));
      const h = Math.max(1, Math.min(MAX_H, Math.round(w * ASPECT)));
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.height = `${h}px`;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w, h };
      // 테마가 바뀌면 잉크 색도 따라가야 한다 — 리사이즈 때마다 다시 읽는다.
      const cs = getComputedStyle(document.documentElement);
      colorsRef.current = {
        ink: cs.getPropertyValue('--fg').trim() || '#000',
        hl: cs.getPropertyValue('--s2').trim() || '#c8a000',
      };
      schedule();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const mo = new MutationObserver(resize);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(rafRef.current); };
  }, [schedule]);

  /* ------------------------------------------------------- 포인터 처리 */

  const toLocal = useCallback((e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [
      clamp((e.clientX - r.left) / (r.width || 1), 0, 1),
      clamp((e.clientY - r.top) / (r.height || 1), 0, 1),
    ];
  }, []);

  // 이 이벤트로 그려도 되는가. 펜을 본 적 있으면 touch 는 스크롤 전용이 된다.
  const accepts = useCallback((e) => {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'touch') return !penSeenRef.current;
    return e.button === 0 || e.buttons === 1;   // 마우스는 왼쪽 버튼만
  }, []);

  const eraseAt = useCallback((x, y) => {
    const { w, h } = sizeRef.current;
    const rx = 14 / (w || 1);
    const ry = 14 / (h || 1);
    const before = strokesRef.current.length;
    strokesRef.current = strokesRef.current.filter(
      (st) => !(st.points || []).some(([px, py]) => Math.abs(px - x) < rx && Math.abs(py - y) < ry),
    );
    if (strokesRef.current.length !== before) {
      setCount(strokesRef.current.length);
      onChange?.(strokesRef.current);
      schedule();
    }
  }, [onChange, schedule]);

  const onDown = useCallback((e) => {
    if (e.pointerType === 'pen' && !penSeenRef.current) {
      penSeenRef.current = true;
      setPenMode(true);
    }
    if (!accepts(e)) return;
    e.preventDefault();
    canvasRef.current.setPointerCapture?.(e.pointerId);
    const [x, y] = toLocal(e);

    if (tool === 'eraser') { eraseAt(x, y); return; }

    const def = TOOLS.find((t) => t.key === tool) || TOOLS[0];
    liveRef.current = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      tool,
      size: def.size,
      pen: e.pointerType === 'pen',
      points: [[x, y, e.pressure || 0.5]],
    };
    schedule();
  }, [accepts, eraseAt, schedule, tool, toLocal]);

  const onMove = useCallback((e) => {
    if (tool === 'eraser') {
      if (!accepts(e) || !(e.buttons || e.pressure)) return;
      const [x, y] = toLocal(e);
      eraseAt(x, y);
      return;
    }
    if (!liveRef.current || !accepts(e)) return;
    e.preventDefault();
    // 한 프레임에 여러 점이 묶여 들어온다. 다 쓰면 선이 각지지 않는다.
    // 빈 배열을 돌려주는 경우가 있어(합성 이벤트 등) 그때는 이벤트 자체를 쓴다 —
    // 없다고 그냥 넘기면 점이 전부 버려져 획이 점 하나로 남는다.
    const coalesced = e.nativeEvent.getCoalescedEvents?.() || [];
    const events = coalesced.length ? coalesced : [e.nativeEvent];
    const pts = liveRef.current.points;
    for (const ev of events) {
      const [x, y] = toLocal(ev);
      const last = pts[pts.length - 1];
      // 같은 자리에 점을 쌓지 않는다 — 저장 용량만 늘고 그림은 안 달라진다.
      if (last && Math.abs(last[0] - x) < 0.0006 && Math.abs(last[1] - y) < 0.0006) continue;
      pts.push([x, y, ev.pressure || 0.5]);
    }
    schedule();
  }, [accepts, eraseAt, schedule, tool, toLocal]);

  const onUp = useCallback((e) => {
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
    const live = liveRef.current;
    liveRef.current = null;
    if (!live) return;
    // 좌표는 소수 4자리면 충분하다. 그대로 두면 JSON 이 몇 배로 부푼다.
    live.points = live.points.map(([x, y, p]) => [
      Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4, Math.round(p * 100) / 100,
    ]);
    strokesRef.current = [...strokesRef.current, live];
    setCount(strokesRef.current.length);
    onChange?.(strokesRef.current);
    schedule();
  }, [onChange, schedule]);

  const undo = useCallback(() => {
    if (!strokesRef.current.length) return;
    strokesRef.current = strokesRef.current.slice(0, -1);
    setCount(strokesRef.current.length);
    onChange?.(strokesRef.current);
    schedule();
  }, [onChange, schedule]);

  const clearAll = useCallback(() => {
    if (!strokesRef.current.length) return;
    strokesRef.current = [];
    setCount(0);
    onChange?.([]);
    schedule();
  }, [onChange, schedule]);

  return (
    <div className="rk-ink">
      <div className="rk-ink-bar">
        {TOOLS.map((t) => (
          <button
            key={t.key} type="button" className={'rk-ink-btn' + (tool === t.key ? ' is-on' : '')}
            onClick={() => setTool(t.key)} aria-pressed={tool === t.key} title={t.label}
          >
            <t.icon size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>{t.label}</span>
          </button>
        ))}
        <span className="rk-ink-gap" />
        <button type="button" className="rk-ink-btn" onClick={undo} disabled={!count} title="실행취소">
          <Undo2 size={16} strokeWidth={1.5} aria-hidden="true" /><span>되돌리기</span>
        </button>
        <button type="button" className="rk-ink-btn" onClick={clearAll} disabled={!count} title="전체 지우기">
          <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" /><span>전체 지우기</span>
        </button>
      </div>

      <div className="rk-ink-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="rk-ink-cv"
          aria-label={label}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onUp}
        />
      </div>

      <p className="rk-ink-hint">
        {penMode
          ? '펜을 감지했습니다 — 손가락은 스크롤만 하고 그림에는 반영되지 않습니다.'
          : '펜슬·손가락·마우스로 쓸 수 있습니다. 펜이 감지되면 손바닥 거치 방지가 켜집니다.'}
      </p>
    </div>
  );
}
