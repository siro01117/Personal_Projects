'use client';

// 단원 강의 — 읽기도 되고 듣기도 된다. 읽는 줄이 강조되고 화면이 따라간다.
// 줄 목록과 듣기 주소는 lib/lecture.mjs 한 곳에서 나온다(화면과 소리가 어긋나지 않게).
import { useRef, useState } from 'react';
import { ArrowLeft, BookOpen, ChevronDown, Lightbulb } from 'lucide-react';
import { lectureRows, saySig } from '../../lib/lecture.mjs';
import { ListenBar, ListenButton, useFollow, useListen } from './Listen';

const sayProps = (say, key) => {
  const addr = `r:${key}`;
  return {
    'data-say': addr,
    className: say?.addr === addr ? 'is-say' : undefined,
    onClick: say?.isOpen ? () => say.seekAddr(addr) : undefined,
  };
};

function Row({ row, say }) {
  const p = (key) => sayProps(say, key);

  if (row.t === 'h') {
    const a = p(row.key);
    return <h3 {...a} className={'rk-lec-h' + (a.className ? ` ${a.className}` : '')}>{row.text}</h3>;
  }
  if (row.t === 'p') {
    const a = p(row.key);
    return <p {...a} className={'rk-lec-p' + (a.className ? ` ${a.className}` : '')}>{row.text}</p>;
  }
  if (row.t === 'ul') {
    return (
      <ul className="rk-lec-ul">
        {row.items.map((x, j) => <li key={j} {...p(`${row.key}.${j}`)}>{x}</li>)}
      </ul>
    );
  }
  if (row.t === 'map') {
    const a = p(row.key);
    return (
      <div {...a} className={'rk-lec-map' + (a.className ? ` ${a.className}` : '')}>
        <div className="rk-lec-map-h">오늘 갈 길</div>
        <ol>{row.items.map((x, j) => <li key={j}>{x}</li>)}</ol>
      </div>
    );
  }
  if (row.t === 'table') {
    return (
      <div className="rk-lec-tw">
        <table className="rk-lec-t">
          {row.head.length > 0 && (
            <thead><tr>{row.head.map((h, j) => <th key={j}>{h}</th>)}</tr></thead>
          )}
          <tbody>
            {row.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    );
  }
  if (row.t === 'pre') {
    const a = p(row.key);
    return (
      <div {...a} className={'rk-lec-pre' + (a.className ? ` ${a.className}` : '')}>
        <span className="rk-lec-tag">먼저 생각해보기</span>
        <p>{row.q}</p>
      </div>
    );
  }
  if (row.t === 'q') return <Question row={row} say={say} />;
  if (row.t === 'hint') {
    return (
      <p className="rk-lec-hint">
        <Lightbulb size={13} strokeWidth={1.5} aria-hidden="true" />{row.text}
      </p>
    );
  }
  if (row.t === 'note') return <Note row={row} />;
  return null;
}

// 답은 눌러야 나온다. 먼저 보이면 읽고 넘어가게 되고, 그러면 인출이 아니라 재독이 된다.
function Question({ row, say }) {
  const [open, setOpen] = useState(false);
  const a = sayProps(say, row.key);
  return (
    <div className={'rk-lec-q' + (a.className ? ' is-say' : '')}>
      <div {...a} className="rk-lec-q-b">
        <span className="rk-lec-tag">멈춰서 답해보기</span>
        <p>{row.q}</p>
      </div>
      {row.a && (
        <>
          <button type="button" className="rk-lec-q-t" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? '답 접기' : '답 확인'}
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          {open && <p className="rk-lec-q-a">{row.a}</p>}
        </>
      )}
    </div>
  );
}

function Note({ row }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rk-lec-note">
      <button type="button" className="rk-lec-note-t" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {row.title}
        <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open && <p className="rk-lec-note-b">{row.text}</p>}
    </div>
  );
}

export function LectureView({ unit, onBack }) {
  const rootRef = useRef(null);
  const fresh = unit.tts && unit.tts.sig === saySig(unit) ? unit.tts : null;
  const say = useListen(fresh, unit.title);
  useFollow(rootRef, say.addr);
  const rows = lectureRows(unit);

  return (
    <div className={'rk-lec' + (say.isOpen ? ' is-listening' : '')} ref={rootRef}>
      <button type="button" className="rk-back" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />강의 목록
      </button>

      <header className="rk-lec-head">
        <h2 className="rk-lec-t">{unit.title}</h2>
        <p className="rk-lec-s">{[unit.pages && `교재 ${unit.pages}쪽`, unit.frame].filter(Boolean).join(' · ')}</p>
        {unit.lead && <p className="rk-lec-lead">{unit.lead}</p>}
        {say.available && <ListenButton listen={say} />}
      </header>

      <article className="rk-lec-body">
        {rows.map((r) => <Row key={r.key} row={r} say={say} />)}
      </article>

      <ListenBar listen={say} title={unit.title} />
    </div>
  );
}

export default function Lectures({ course }) {
  const [open, setOpen] = useState(null);
  const units = course.units || [];

  if (!units.length) {
    return (
      <div className="rk-empty">
        <p className="rk-empty-t">아직 만든 강의가 없습니다</p>
        <p className="rk-empty-h">교재 단원을 강의로 정리하면 여기에 쌓입니다.</p>
      </div>
    );
  }

  const cur = units.find((u) => u.id === open);
  if (cur) return <LectureView unit={cur} onBack={() => setOpen(null)} />;

  return (
    <ul className="rk-lec-list">
      {units.map((u) => {
        const mins = u.tts?.dur ? Math.max(1, Math.round(u.tts.dur / 60)) : null;
        return (
          <li key={u.id}>
            <button type="button" className="rk-lec-card" onClick={() => setOpen(u.id)}>
              <BookOpen size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className="rk-lec-card-b">
                <span className="rk-lec-card-t">{u.title}</span>
                <span className="rk-lec-card-s">
                  {[u.pages && `교재 ${u.pages}쪽`, mins && `듣기 ${mins}분`].filter(Boolean).join(' · ')}
                </span>
              </span>
              <ChevronDown size={16} strokeWidth={1.5} className="rk-lec-card-c" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
