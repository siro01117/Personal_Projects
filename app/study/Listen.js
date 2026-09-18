'use client';

// 듣기 — 수업 정리를 소리로 읽어주고, 읽는 줄을 화면에서 따라가며 강조한다.
//
// 소리는 미리 만들어 둔 파일이다(로컬 CosyVoice → scripts/study-tts.mjs 가 올림). 브라우저 내장 음성은
// 기기마다 목소리·속도가 다르고 한국어는 단어 경계 이벤트가 안 와서 자막을 맞출 수 없다.
//   lesson.tts = { path, dur, cues: [{ k, i, s, e }] }
//   k/i 는 화면 줄의 주소다 — 'flow':2 는 '내 생각 흐름' 세 번째 줄, 'h-flow':0 은 그 소제목.
// 화면 쪽은 같은 주소를 data-say="flow:2" 로 달아 두기만 하면 된다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Headphones, Loader, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';

const BUCKET = 'study-audio';
const RATES = [1, 1.25, 1.5, 2];
const RATE_KEY = 'rakan.study.listenRate';

const blobCache = new Map();      // path -> object URL (탭이 살아 있는 동안)
let stopCurrent = null;           // 한 번에 하나만 읽는다

const fmt = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const readRate = () => {
  try { const r = Number(localStorage.getItem(RATE_KEY)); return RATES.includes(r) ? r : 1; } catch { return 1; }
};

async function audioUrl(path) {
  if (blobCache.has(path)) return blobCache.get(path);
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  const url = URL.createObjectURL(data);
  blobCache.set(path, url);
  return url;
}

// 지금 시각에 해당하는 줄. 줄 사이 쉼에서는 앞줄을 그대로 잡고 있는다(깜빡이지 않게).
function cueAt(cues, t) {
  let hit = -1;
  for (let n = 0; n < cues.length; n += 1) {
    if (cues[n].s <= t + 0.02) hit = n; else break;
  }
  return hit;
}

export function useListen(tts, title) {
  const cues = tts?.cues || [];
  const [phase, setPhase] = useState('idle');       // idle | loading | ready | error
  const [playing, setPlaying] = useState(false);
  const [idx, setIdx] = useState(-1);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  const audioRef = useRef(null);
  const rafRef = useRef(0);

  const close = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const a = audioRef.current;
    if (a) { a.pause(); a.removeAttribute('src'); audioRef.current = null; }
    if (stopCurrent === close) stopCurrent = null;
    setPhase('idle'); setPlaying(false); setIdx(-1); setTime(0);
  }, []);

  useEffect(() => close, [close]);

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    setTime(a.currentTime);
    setIdx(cueAt(cues, a.currentTime));
    if (!a.paused) rafRef.current = requestAnimationFrame(tick);
  }, [cues]);

  const open = useCallback(async () => {
    if (!tts?.path) return;
    if (stopCurrent && stopCurrent !== close) stopCurrent();
    stopCurrent = close;
    setPhase('loading');
    try {
      const url = await audioUrl(tts.path);
      const a = new Audio(url);
      const r = readRate();
      a.preload = 'auto';
      a.playbackRate = r;
      setRate(r);
      a.addEventListener('play', () => { setPlaying(true); rafRef.current = requestAnimationFrame(tick); });
      a.addEventListener('pause', () => { setPlaying(false); tick(); });
      a.addEventListener('ended', () => { setPlaying(false); setIdx(-1); });
      audioRef.current = a;
      setPhase('ready');
      if ('mediaSession' in navigator && window.MediaMetadata) {
        navigator.mediaSession.metadata = new window.MediaMetadata({ title: title || '수업 정리', artist: 'RA-KAN 학습' });
      }
      // iOS 는 불러오는 동안 사용자 동작이 끊겨 자동 재생을 막을 수 있다 — 그러면 멈춘 채로 열어 둔다.
      a.play().catch(() => {});
    } catch {
      setPhase('error');
    }
  }, [tts, title, close, tick]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  }, []);

  const seek = useCallback((t) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(t, (tts?.dur || a.duration || 0) - 0.05));
    tick();
  }, [tts, tick]);

  const seekCue = useCallback((n) => {
    const c = cues[Math.max(0, Math.min(n, cues.length - 1))];
    if (c) seek(c.s);
  }, [cues, seek]);

  const seekAddr = useCallback((addr) => {
    const n = cues.findIndex((c) => `${c.k}:${c.i}` === addr);
    if (n < 0) return;
    seek(cues[n].s);
    const a = audioRef.current;
    if (a?.paused) a.play().catch(() => {});
  }, [cues, seek]);

  const cycleRate = useCallback(() => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
    try { localStorage.setItem(RATE_KEY, String(next)); } catch {}
  }, [rate]);

  const cur = idx >= 0 ? cues[idx] : null;
  return {
    available: Boolean(tts?.path && cues.length),
    phase, playing, time, rate, idx,
    dur: tts?.dur || 0,
    addr: cur ? `${cur.k}:${cur.i}` : '',
    isOpen: phase !== 'idle',
    open, close, toggle, seek, seekCue, seekAddr, cycleRate,
  };
}

// 읽는 줄이 바뀌면 화면 가운데 띠 안으로 데려온다. 이미 잘 보이는 자리면 건드리지 않는다.
export function useFollow(rootRef, addr) {
  useEffect(() => {
    if (!addr || !rootRef.current) return;
    const el = rootRef.current.querySelector(`[data-say="${addr}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    if (r.top < vh * 0.18 || r.bottom > vh * 0.62) {
      const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    }
  }, [rootRef, addr]);
}

export function ListenButton({ listen }) {
  if (!listen.available) return null;
  const busy = listen.phase === 'loading';
  return (
    <button type="button" className={'rk-say-b' + (listen.isOpen ? ' is-on' : '')}
      onClick={listen.isOpen ? listen.close : listen.open} aria-pressed={listen.isOpen}>
      {busy
        ? <Loader size={14} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />
        : <Headphones size={14} strokeWidth={1.5} aria-hidden="true" />}
      {listen.isOpen ? '듣기 닫기' : `듣기 ${fmt(listen.dur)}`}
    </button>
  );
}

export function ListenBar({ listen, title }) {
  if (!listen.isOpen) return null;
  const pct = listen.dur ? Math.min(100, (listen.time / listen.dur) * 100) : 0;
  const onTrack = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    listen.seek(((e.clientX - r.left) / r.width) * listen.dur);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); listen.seek(listen.time + 5); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); listen.seek(listen.time - 5); }
  };
  return (
    <div className="rk-say" role="region" aria-label="듣기">
      <div className="rk-say-track" onClick={onTrack} onKeyDown={onKey} role="slider" tabIndex={0}
        aria-label="재생 위치" aria-valuemin={0} aria-valuemax={Math.round(listen.dur)}
        aria-valuenow={Math.round(listen.time)} aria-valuetext={`${fmt(listen.time)} / ${fmt(listen.dur)}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="rk-say-row">
        <div className="rk-say-meta">
          <span className="rk-say-t">{listen.phase === 'error' ? '소리를 불러오지 못했다' : title}</span>
          <span className="rk-say-c rk-num">{fmt(listen.time)} / {fmt(listen.dur)}</span>
        </div>
        <div className="rk-say-ctl">
          <button type="button" onClick={() => listen.seekCue(listen.idx - 1)} aria-label="앞줄">
            <SkipBack size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="rk-say-play" onClick={listen.toggle}
            aria-label={listen.playing ? '멈춤' : '재생'} disabled={listen.phase !== 'ready'}>
            {listen.phase === 'loading'
              ? <Loader size={20} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />
              : listen.playing
                ? <Pause size={20} strokeWidth={1.5} aria-hidden="true" />
                : <Play size={20} strokeWidth={1.5} aria-hidden="true" />}
          </button>
          <button type="button" onClick={() => listen.seekCue(listen.idx + 1)} aria-label="다음 줄">
            <SkipForward size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="rk-say-rate rk-num" onClick={listen.cycleRate} aria-label="빠르기">
            {listen.rate}×
          </button>
          <button type="button" onClick={listen.close} aria-label="닫기">
            <X size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
