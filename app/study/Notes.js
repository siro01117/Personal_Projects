'use client';

// 내 정리 — 질문 하나씩 넘기며 채우고, 채운 것은 교재처럼 읽는다.
//
// 화면 셋: 목록 / 채우기(스테이지) / 읽기(교재).
// 읽기는 강의본과 같은 컴포넌트를 쓴다 — 다 채우면 내가 쓴 강의본과 같은 모양이 되고 듣기도 붙는다.
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, BookOpen, Check, NotebookPen, Plus, SkipForward, Trash2, X,
} from 'lucide-react';
import { GROUPS, STAGES, emptyAnswers, groupProgress, noteToUnit, normNote, progress } from '../../lib/stages.mjs';
import { LectureView } from './Lecture';

const newId = () => `n_${Date.now().toString(36)}`;
const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------ 입력 위젯 */

// 줄 목록 — 마지막 칸에 쓰면 아래 칸이 하나 더 생긴다. 추가 버튼을 누를 일이 없다.
function Lines({ value, onChange, ph }) {
  const rows = [...value, ''];
  const set = (i, v) => {
    const next = [...value];
    if (i < next.length) next[i] = v; else next.push(v);
    onChange(next.filter((x, j) => x.trim() || j < next.length - 1));
  };
  return (
    <div className="rk-st-lines">
      {rows.map((v, i) => (
        <div key={i} className="rk-st-line">
          <span className="rk-st-bul" aria-hidden="true" />
          <textarea className="rk-st-in" rows={1} value={v} placeholder={i === 0 ? ph : ''}
            onChange={(e) => set(i, e.target.value)}
            onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }} />
          {i < value.length && (
            <button type="button" className="rk-st-del" aria-label="줄 지우기"
              onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// 짝 — 왼쪽 말, 오른쪽 뜻
function Pairs({ value, onChange, ph, labels }) {
  const rows = [...value, { k: '', v: '' }];
  const set = (i, key, v) => {
    const next = value.map((x) => ({ ...x }));
    if (i < next.length) next[i][key] = v; else next.push({ k: '', v: '', [key]: v });
    onChange(next.filter((x, j) => x.k.trim() || x.v.trim() || j < next.length - 1));
  };
  return (
    <div className="rk-st-pairs">
      {rows.map((p, i) => (
        <div key={i} className="rk-st-pair">
          <input className="rk-st-in rk-st-k" value={p.k} placeholder={i === 0 ? ph[0] : labels[0]}
            onChange={(e) => set(i, 'k', e.target.value)} />
          <textarea className="rk-st-in rk-st-v" rows={1} value={p.v} placeholder={i === 0 ? ph[1] : labels[1]}
            onChange={(e) => set(i, 'v', e.target.value)}
            onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }} />
          {i < value.length && (
            <button type="button" className="rk-st-del" aria-label="줄 지우기"
              onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// 질문과 답 — 답은 비워 둬도 된다. 나중에 덮고 답하는 데 쓰니까
function QA({ value, onChange, ph }) {
  const rows = [...value, { q: '', a: '' }];
  const set = (i, key, v) => {
    const next = value.map((x) => ({ ...x }));
    if (i < next.length) next[i][key] = v; else next.push({ q: '', a: '', [key]: v });
    onChange(next.filter((x, j) => x.q.trim() || x.a.trim() || j < next.length - 1));
  };
  return (
    <div className="rk-st-qa">
      {rows.map((x, i) => (
        <div key={i} className="rk-st-qarow">
          <textarea className="rk-st-in rk-st-q" rows={1} value={x.q} placeholder={i === 0 ? ph[0] : '질문'}
            onChange={(e) => set(i, 'q', e.target.value)}
            onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }} />
          <textarea className="rk-st-in rk-st-a" rows={1} value={x.a} placeholder={i === 0 ? ph[1] : '답 (나중에 채워도 됨)'}
            onChange={(e) => set(i, 'a', e.target.value)}
            onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }} />
          {i < value.length && (
            <button type="button" className="rk-st-del" aria-label="줄 지우기"
              onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ 채우기 */

function Stage({ note, onPatch, onDone }) {
  const [i, setI] = useState(() => {
    const first = STAGES.findIndex((s) => !(note.a[s.key] || []).length && !note.seen.includes(s.key));
    return first < 0 ? 0 : first;
  });
  const s = STAGES[i];
  const group = GROUPS.find((g) => g.key === s.group) || GROUPS[0];
  const value = note.a[s.key] || [];
  const filled = value.length > 0;
  const topRef = useRef(null);

  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); }, [i]);

  const setValue = (v) => onPatch({ a: { ...note.a, [s.key]: v } });
  const markSeen = () => {
    if (!note.seen.includes(s.key)) onPatch({ seen: [...note.seen, s.key] });
  };
  const next = () => {
    markSeen();
    if (i < STAGES.length - 1) setI(i + 1); else onDone();
  };

  return (
    <div className="rk-st" ref={topRef}>
      <div className="rk-st-top">
        <button type="button" className="rk-back" onClick={onDone}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />그만 채우기
        </button>
        <span className="rk-st-count rk-num">{i + 1} / {STAGES.length}</span>
      </div>

      <div className="rk-st-bars">
        {GROUPS.map((g) => {
          const items = STAGES.filter((x) => x.group === g.key);
          const done = items.filter((x) => STAGES.indexOf(x) <= i).length;
          return (
            <span key={g.key} className={'rk-st-seg' + (g.key === s.group ? ' is-on' : '')}
              style={{ flexGrow: items.length }}>
              <span style={{ width: `${(done / items.length) * 100}%` }} />
            </span>
          );
        })}
      </div>

      <div className="rk-st-body">
        {/* 층위가 바뀌는 자리를 알려 준다 — 결이 달라지는 게 방해가 아니라 신호가 되게 */}
        <div className="rk-st-group">
          <span className="rk-st-gl">{group.label}</span>
          <span className="rk-st-gh">{group.hint}</span>
        </div>
        <h2 className="rk-st-q2">{s.title}</h2>
        <p className="rk-st-help">{s.help}</p>

        {s.kind === 'lines' && <Lines value={value} onChange={setValue} ph={s.ph} />}
        {s.kind === 'pairs' && <Pairs value={value} onChange={setValue} ph={s.ph} labels={s.th || ['', '']} />}
        {s.kind === 'qa' && <QA value={value} onChange={setValue} ph={s.ph} />}
      </div>

      <div className="rk-st-nav">
        <button type="button" className="rk-st-prev" disabled={i === 0} onClick={() => setI(i - 1)}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />이전
        </button>
        <button type="button" className="rk-st-skip" onClick={next}>
          <SkipForward size={15} strokeWidth={1.5} aria-hidden="true" />건너뛰기
        </button>
        <button type="button" className={'rk-st-next' + (filled ? ' is-on' : '')} onClick={next}>
          {i === STAGES.length - 1 ? '끝내기' : '다음'}
          {i === STAGES.length - 1
            ? <Check size={16} strokeWidth={1.75} aria-hidden="true" />
            : <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 목록 */

export default function Notes({ course, onPatchCourse }) {
  const notes = (course.notes || []).map(normNote);
  const [openId, setOpenId] = useState(null);
  const [mode, setMode] = useState('read');       // read | fill

  const save = (list) => onPatchCourse(course.id, { notes: list });

  const add = () => {
    const n = { id: newId(), title: '', at: today(), pages: '', seen: [], a: emptyAnswers() };
    save([...notes, n]);
    setOpenId(n.id);
    setMode('fill');
  };

  const patch = (id, p) => save(notes.map((n) => (n.id === id ? { ...n, ...p } : n)));
  const remove = (id) => {
    save(notes.filter((n) => n.id !== id));
    setOpenId(null);
  };

  const cur = notes.find((n) => n.id === openId);

  if (cur && mode === 'fill') {
    return (
      <>
        <div className="rk-st-title">
          <input className="rk-st-in rk-st-t" value={cur.title} placeholder="무엇을 정리하나 (예: 상인과 상인자격)"
            onChange={(e) => patch(cur.id, { title: e.target.value })} />
          <input className="rk-st-in rk-st-pg" value={cur.pages} placeholder="교재 쪽 (선택)"
            onChange={(e) => patch(cur.id, { pages: e.target.value })} />
        </div>
        <Stage note={cur} onPatch={(p) => patch(cur.id, p)} onDone={() => setMode('read')} />
      </>
    );
  }

  if (cur) {
    const { filled, total } = progress(cur);
    return (
      <>
        <LectureView unit={noteToUnit(cur)} onBack={() => setOpenId(null)} backLabel="내 정리" />
        <div className="rk-st-foot">
          <button type="button" className="rk-st-next is-on" onClick={() => setMode('fill')}>
            <NotebookPen size={15} strokeWidth={1.5} aria-hidden="true" />이어서 채우기 ({filled}/{total})
          </button>
          <button type="button" className="rk-st-rm" onClick={() => { if (window.confirm('이 정리를 지울까요?')) remove(cur.id); }}>
            <Trash2 size={15} strokeWidth={1.5} aria-hidden="true" />지우기
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <button type="button" className="rk-st-add" onClick={add}>
        <Plus size={16} strokeWidth={1.75} aria-hidden="true" />새로 정리하기
      </button>

      {notes.length === 0 ? (
        <p className="rk-st-none">
          질문이 하나씩 나옵니다. 답할 수 있는 것만 답하고 나머지는 건너뛰면 됩니다.
          채운 것이 쌓이면 교재처럼 읽을 수 있습니다.
        </p>
      ) : (
        <ul className="rk-st-list">
          {[...notes].reverse().map((n) => {
            const { filled, total } = progress(n);
            return (
              <li key={n.id}>
                <button type="button" className="rk-st-card" onClick={() => { setOpenId(n.id); setMode('read'); }}>
                  <BookOpen size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span className="rk-st-card-b">
                    <span className="rk-st-card-t">{n.title || '제목 없음'}</span>
                    <span className="rk-st-card-s rk-num">
                      {[n.at, n.pages && `${n.pages}쪽`, `${filled}/${total}`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="rk-st-dots" aria-hidden="true">
                    {groupProgress(n).map((g) => (
                      <span key={g.key} className="rk-st-dot" title={g.label}
                        style={{ '--p': `${(g.filled / g.total) * 100}%` }} />
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
