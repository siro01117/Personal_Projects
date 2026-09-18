'use client';

// 듣기 — 글을 소리로 읽어주고, 읽는 줄을 화면에서 강조하며 따라간다. 두 가지 소리가 있다.
//
//   기기 음성 : 브라우저 내장(Web Speech). 만들어 둘 게 없어 글을 쓰자마자 바로 들린다. 소리는 투박하다.
//   녹음      : 로컬 CosyVoice 로 미리 만든 파일. 훨씬 자연스럽지만 합성·업로드가 필요하다.
//
// 둘 다 단위가 '한 줄'이라 강조 방식이 같다. 기기 음성은 줄마다 따로 읽히므로 시작·끝 신호가 정확히 오고,
// 녹음은 줄마다 따로 합성해 둔 시각(cues)을 쓴다. 한국어는 단어 단위 신호가 안 오지만 줄 단위면 문제없다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Headphones, Loader, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { speakText } from '../../lib/speak.mjs';

const BUCKET = 'study-audio';
const RATES = [1, 1.25, 1.5, 2];
const RATE_KEY = 'rakan.study.listenRate';
const ENGINE_KEY = 'rakan.study.listenEngine';

const blobCache = new Map();      // path -> object URL (탭이 살아 있는 동안)
let stopCurrent = null;           // 한 번에 하나만 읽는다

const fmt = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const readLS = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch { return fallback; }
};
const writeLS = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };
const readRate = () => { const r = Number(readLS(RATE_KEY, '1')); return RATES.includes(r) ? r : 1; };

const hasSpeech = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

async function audioUrl(path) {
  if (blobCache.has(path)) return blobCache.get(path);
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  const url = URL.createObjectURL(data);
  blobCache.set(path, url);
  return url;
}

// 지금 시각에 해당하는 줄. 줄 사이 쉼에서는 앞줄을 잡고 있는다(깜빡이지 않게).
function cueAt(cues, t) {
  let hit = -1;
  for (let n = 0; n < cues.length; n += 1) {
    if (cues[n].s <= t + 0.02) hit = n; else break;
  }
  return hit;
}

// 한국어 목소리를 고른다. 목록은 크롬에서 늦게 채워지므로 voiceschanged 를 기다린다.
function useKoVoice() {
  const [voice, setVoice] = useState(null);
  useEffect(() => {
    if (!hasSpeech()) return undefined;
    const pick = () => {
      const all = window.speechSynthesis.getVoices() || [];
      const ko = all.filter((v) => (v.lang || '').toLowerCase().startsWith('ko'));
      if (ko.length) setVoice(ko.find((v) => v.localService) || ko[0]);
    };
    pick();
    window.speechSynthesis.addEventListener('voiceschanged', pick);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pick);
  }, []);
  return voice;
}

export function useListen({ tts, title, units }) {
  const lines = units || [];
  const cues = tts?.cues || [];
  const canFile = Boolean(tts?.path && cues.length);
  const canVoice = hasSpeech() && lines.length > 0;
  const voice = useKoVoice();

  const [engine, setEngine] = useState('file');
  const [phase, setPhase] = useState('idle');       // idle | loading | ready | error
  const [playing, setPlaying] = useState(false);
  const [idx, setIdx] = useState(-1);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);

  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const posRef = useRef(0);        // 기기 음성이 읽고 있는 줄
  const runRef = useRef(0);        // 취소된 낭독의 뒤늦은 onend 를 걸러낸다
  const rateRef = useRef(1);
  const voiceRef = useRef(null);
  voiceRef.current = voice;

  const stopVoice = useCallback(() => {
    runRef.current += 1;
    if (hasSpeech()) window.speechSynthesis.cancel();
  }, []);

  const close = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const a = audioRef.current;
    if (a) { a.pause(); a.removeAttribute('src'); audioRef.current = null; }
    stopVoice();
    if (stopCurrent === close) stopCurrent = null;
    setPhase('idle'); setPlaying(false); setIdx(-1); setTime(0);
  }, [stopVoice]);

  useEffect(() => close, [close]);

  /* ------------------------------------------------------------ 녹음 파일 */

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    setTime(a.currentTime);
    setIdx(cueAt(cues, a.currentTime));
    if (!a.paused) rafRef.current = requestAnimationFrame(tick);
  }, [cues]);

  const openFile = useCallback(async () => {
    setPhase('loading');
    try {
      const url = await audioUrl(tts.path);
      const a = new Audio(url);
      a.preload = 'auto';
      a.playbackRate = rateRef.current;
      a.addEventListener('play', () => { setPlaying(true); rafRef.current = requestAnimationFrame(tick); });
      a.addEventListener('pause', () => { setPlaying(false); tick(); });
      a.addEventListener('ended', () => { setPlaying(false); setIdx(-1); });
      audioRef.current = a;
      setPhase('ready');
      a.play().catch(() => {});      // iOS 는 자동 재생을 막을 수 있다 — 멈춘 채로 열어 둔다
    } catch {
      setPhase('error');
    }
  }, [tts, tick]);

  /* ----------------------------------------------------------- 기기 음성 */

  const speakFrom = useCallback((from) => {
    if (!hasSpeech()) return;
    runRef.current += 1;
    const run = runRef.current;
    window.speechSynthesis.cancel();

    const step = (n) => {
      if (run !== runRef.current) return;
      if (n >= lines.length) { setPlaying(false); setIdx(-1); return; }
      const text = speakText(lines[n].text);
      if (!text) { step(n + 1); return; }
      const u = new window.SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = rateRef.current;
      if (voiceRef.current) u.voice = voiceRef.current;
      u.onstart = () => { if (run === runRef.current) { posRef.current = n; setIdx(n); setPlaying(true); } };
      // 한 줄을 못 읽어도 멈추지 않는다 — 다음 줄로 넘어간다.
      u.onend = () => { if (run === runRef.current) step(n + 1); };
      u.onerror = () => { if (run === runRef.current) step(n + 1); };
      window.speechSynthesis.speak(u);
    };
    posRef.current = from;
    setIdx(from);
    step(from);
  }, [lines]);

  /* ------------------------------------------------------------------ 공통 */

  const open = useCallback(async () => {
    if (stopCurrent && stopCurrent !== close) stopCurrent();
    stopCurrent = close;
    const saved = readLS(ENGINE_KEY, '');
    const use = canFile && (saved !== 'voice' || !canVoice) ? 'file' : 'voice';
    const r = readRate();
    rateRef.current = r; setRate(r); setEngine(use);
    if (use === 'file') { await openFile(); return; }
    setPhase('ready');
    speakFrom(0);
  }, [canFile, canVoice, close, openFile, speakFrom]);

  const toggle = useCallback(() => {
    if (engine === 'file') {
      const a = audioRef.current;
      if (!a) return;
      if (a.paused) a.play().catch(() => {}); else a.pause();
      return;
    }
    if (!hasSpeech()) return;
    if (playing) { stopVoice(); setPlaying(false); } else speakFrom(Math.max(0, posRef.current));
  }, [engine, playing, speakFrom, stopVoice]);

  const seek = useCallback((t) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(t, (tts?.dur || a.duration || 0) - 0.05));
    tick();
  }, [tts, tick]);

  const seekCue = useCallback((n) => {
    if (engine === 'voice') {
      speakFrom(Math.max(0, Math.min(n, lines.length - 1)));
      return;
    }
    const c = cues[Math.max(0, Math.min(n, cues.length - 1))];
    if (c) seek(c.s);
  }, [engine, cues, lines.length, seek, speakFrom]);

  const seekAddr = useCallback((addr) => {
    if (engine === 'voice') {
      const n = lines.findIndex((l) => `${l.k}:${l.i}` === addr);
      if (n >= 0) speakFrom(n);
      return;
    }
    const n = cues.findIndex((c) => `${c.k}:${c.i}` === addr);
    if (n < 0) return;
    seek(cues[n].s);
    const a = audioRef.current;
    if (a?.paused) a.play().catch(() => {});
  }, [engine, cues, lines, seek, speakFrom]);

  const cycleRate = useCallback(() => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next); rateRef.current = next; writeLS(RATE_KEY, next);
    if (engine === 'file') { if (audioRef.current) audioRef.current.playbackRate = next; return; }
    // 기기 음성은 읽는 중에 빠르기를 못 바꾼다 — 그 줄부터 다시 읽는다.
    if (playing) speakFrom(Math.max(0, posRef.current));
  }, [rate, engine, playing, speakFrom]);

  const switchEngine = useCallback(async () => {
    const next = engine === 'file' ? 'voice' : 'file';
    if (next === 'file' && !canFile) return;
    if (next === 'voice' && !canVoice) return;
    const at = idx < 0 ? 0 : idx;
    writeLS(ENGINE_KEY, next);
    if (engine === 'file') {
      const a = audioRef.current;
      if (a) { a.pause(); a.removeAttribute('src'); audioRef.current = null; }
      cancelAnimationFrame(rafRef.current);
      setEngine('voice'); setTime(0); setPhase('ready');
      speakFrom(at);
      return;
    }
    stopVoice(); setPlaying(false); setEngine('file');
    await openFile();
    const c = cues[Math.min(at, cues.length - 1)];
    if (c) setTimeout(() => seek(c.s), 0);
  }, [engine, canFile, canVoice, idx, openFile, seek, speakFrom, stopVoice, cues]);

  const cur = engine === 'voice' ? (idx >= 0 ? lines[idx] : null) : (idx >= 0 ? cues[idx] : null);
  const total = engine === 'voice' ? lines.length : cues.length;
  return {
    available: canFile || canVoice,
    canFile, canVoice, engine, phase, playing, time, rate, idx, total,
    dur: tts?.dur || 0,
    addr: cur ? `${cur.k}:${cur.i}` : '',
    isOpen: phase !== 'idle',
    // 기기 음성은 전체 길이를 미리 알 수 없다 — 읽은 줄 수로 대신 보여준다.
    label: engine === 'voice'
      ? `${Math.max(0, idx + 1)} / ${total}줄`
      : `${fmt(time)} / ${fmt(tts?.dur || 0)}`,
    progress: engine === 'voice'
      ? (total ? ((idx + 1) / total) * 100 : 0)
      : (tts?.dur ? Math.min(100, (time / tts.dur) * 100) : 0),
    open, close, toggle, seek, seekCue, seekAddr, cycleRate, switchEngine,
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
  const mins = listen.dur ? `${Math.max(1, Math.round(listen.dur / 60))}분` : `${listen.total}줄`;
  return (
    <button type="button" className={'rk-say-b' + (listen.isOpen ? ' is-on' : '')}
      onClick={listen.isOpen ? listen.close : listen.open} aria-pressed={listen.isOpen}>
      {busy
        ? <Loader size={14} strokeWidth={1.5} className="rk-spin" aria-hidden="true" />
        : <Headphones size={14} strokeWidth={1.5} aria-hidden="true" />}
      {listen.isOpen ? '듣기 닫기' : `듣기 ${listen.canFile ? mins : ''}`.trim()}
    </button>
  );
}

export function ListenBar({ listen, title }) {
  if (!listen.isOpen) return null;
  const voiceMode = listen.engine === 'voice';
  const onTrack = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    if (voiceMode) listen.seekCue(Math.floor(f * listen.total));
    else listen.seek(f * listen.dur);
  };
  const onKey = (e) => {
    const back = e.key === 'ArrowLeft';
    if (!back && e.key !== 'ArrowRight') return;
    e.preventDefault();
    if (voiceMode) listen.seekCue(listen.idx + (back ? -1 : 1));
    else listen.seek(listen.time + (back ? -5 : 5));
  };
  return (
    <div className="rk-say" role="region" aria-label="듣기">
      <div className="rk-say-track" onClick={onTrack} onKeyDown={onKey} role="slider" tabIndex={0}
        aria-label="재생 위치" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(listen.progress)} aria-valuetext={listen.label}>
        <span style={{ width: `${listen.progress}%` }} />
      </div>
      <div className="rk-say-row">
        <div className="rk-say-meta">
          <span className="rk-say-t">{listen.phase === 'error' ? '소리를 불러오지 못했다' : title}</span>
          <span className="rk-say-c rk-num">{listen.label}</span>
        </div>
        <div className="rk-say-ctl">
          {listen.canFile && listen.canVoice && (
            <button type="button" className={'rk-say-eng' + (voiceMode ? ' is-voice' : '')}
              onClick={listen.switchEngine} aria-label="소리 바꾸기"
              title={voiceMode ? '기기 음성 — 녹음으로 바꾸기' : '녹음 — 기기 음성으로 바꾸기'}>
              <AudioLines size={16} strokeWidth={1.5} aria-hidden="true" />
              <span>{voiceMode ? '기기' : '녹음'}</span>
            </button>
          )}
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
