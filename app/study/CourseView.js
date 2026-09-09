'use client';

// 과목 상세 — 개요 / 진도 / 자료 / 시험대비.
// 탭은 배열로 둔다. 새 탭이 필요하면 TABS 에 한 줄 넣고 아래 render 만 붙이면 된다.
//
// 용어가 헷갈리기 쉬워 한 번 적어 둔다:
//   meetings = 매주 반복되는 시간표 칸 (화 13:30–14:45)
//   progress = 16주 강의계획 (주차별 주제)
//   lessons  = 실제로 열린 차시 (2026-09-03, 1주차, 녹음 있음, 정리 여부)
// 진도 탭은 progress 를 뼈대로 두고 그 주차의 lessons 를 붙여 보여준다.
import { useState } from 'react';
import {
  ArrowLeft, BookOpen, ChevronDown, ExternalLink, FileText, Info, Mic, Target, TriangleAlert, HelpCircle, X,
} from 'lucide-react';
import { dayName, fmtTime } from '../../lib/study';
import { Dot, Empty, Tag, WeightBar } from './parts';

const TABS = [
  { key: 'overview', label: '개요', icon: Info },
  { key: 'progress', label: '진도', icon: BookOpen },
  { key: 'materials', label: '자료', icon: FileText },
  { key: 'exam', label: '시험대비', icon: Target },
];

function Field({ label, children }) {
  if (children == null || children === '') return null;
  return <div className="rk-field"><dt>{label}</dt><dd>{children}</dd></div>;
}

const meetingText = (m) =>
  `${dayName(m.day)} ${fmtTime(m.start)}${m.end != null ? `–${fmtTime(m.end)}` : ''}`.trim();

/* ------------------------------------------------------------------ 개요 */

function Overview({ course }) {
  const times = (course.meetings || []).filter((m) => m.day != null);
  const hasAny = course.professor || times.length || course.textbook || course.style
    || course.strategy || course.cautions.length || course.grading.length;

  if (!hasAny) {
    return <Empty title="아직 정리한 정보가 없습니다" hint="교수·시간·평가 비중이 등록되면 여기에 표시됩니다." />;
  }

  return (
    <>
      <dl className="rk-fields">
        <Field label="교수">{course.professor}</Field>
        <Field label="분류">{course.category}</Field>
        <Field label="시간">{times.length ? times.map(meetingText).join(', ') : null}</Field>
        <Field label="강의실">{times.map((m) => m.room).find(Boolean) || course.room}</Field>
        <Field label="학점">{course.credits ? `${course.credits}학점` : null}</Field>
        <Field label="교재">{course.textbook}</Field>
      </dl>

      {course.grading.length > 0 && (
        <section className="rk-sub">
          <h3 className="rk-h3">평가 비중</h3>
          <WeightBar items={course.grading} />
        </section>
      )}

      {course.style && (
        <section className="rk-sub">
          <h3 className="rk-h3">교수 스타일</h3>
          <p className="rk-para">{course.style}</p>
        </section>
      )}

      {course.cautions.length > 0 && (
        <section className="rk-sub">
          <h3 className="rk-h3"><TriangleAlert size={15} strokeWidth={1.5} aria-hidden="true" />주의사항</h3>
          <ul className="rk-bullets">{course.cautions.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      )}

      {course.strategy && (
        <section className="rk-sub">
          <h3 className="rk-h3">전략</h3>
          <p className="rk-para">{course.strategy}</p>
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------- 수업 중 의문 (내 질문)

   수업을 들으며 자연히 드는 의문을 그 자리에서 한 줄씩 적는다. 이 질문들이
   나중에 복기 카드가 된다 — 남이 만든 질문보다 자기 질문이 인출 자극이 세다.
   답은 나중에 채워도 되고, 비워두면 "아직 답 못 찾음"으로 남는다.            */

function Asks({ lesson: l }) {
  if (!l.asks.length) return null;
  const open = l.asks.filter((x) => !x.a.trim()).length;
  return (
    <div className="rk-asks">
      <div className="rk-asks-h">
        <HelpCircle size={14} strokeWidth={1.5} aria-hidden="true" />
        그날 내가 물어본 것
        <span className="rk-asks-n2">{l.asks.length}</span>
        {open > 0 && <span className="rk-asks-n">답 없음 {open}</span>}
      </div>
      <ol className="rk-asks-l">
        {l.asks.map((x) => (
          <li key={x.id} className={x.a.trim() ? '' : 'is-open'}>
            <p className="rk-asks-q">{x.q}</p>
            {x.a.trim() ? <p className="rk-asks-a">{x.a}</p>
              : <p className="rk-asks-a is-none">아직 답을 못 찾음</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* --------------------------------------------------- 요약·복기 (인출 중심)

   답을 먼저 펼쳐 주면 읽고 넘어가게 된다. 질문만 보이고 답은 눌러야 나온다.
   순서도 의도적이다: 스스로 답해보기 → 한 줄 압축 → 비교·대조 → (접힌) 요약.
   한 번에 보이는 양을 줄여야 작업기억에 여유가 생긴다.                           */

function Retrieval({ items }) {
  const [open, setOpen] = useState({});
  return (
    <ol className="rk-rt">
      {items.map((it) => (
        <li key={it.id} className={open[it.id] ? 'is-open' : ''}>
          <button type="button" className="rk-rt-q" onClick={() => setOpen((o) => ({ ...o, [it.id]: !o[it.id] }))}
            aria-expanded={!!open[it.id]}>
            <span>{it.q}</span>
            <ChevronDown size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
          {open[it.id] && it.a && <p className="rk-rt-a">{it.a}</p>}
        </li>
      ))}
    </ol>
  );
}

function Bullets({ items }) {
  return <ul className="rk-bul">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

function Recap({ lesson: l }) {
  const [showRt, setShowRt] = useState(false);
  const [showAsk, setShowAsk] = useState(false);
  const has = l.flow.length || l.context.length || l.principles.length || l.keyTerms.length
    || l.retrieval.length || l.asks.length || l.needsCheck.length;
  if (!has) return null;

  return (
    <div className="rk-recap">
      {l.flow.length > 0 && (
        <><div className="rk-recap-h">내 생각 흐름</div><Bullets items={l.flow} /></>
      )}
      {l.context.length > 0 && (
        <><div className="rk-recap-k">배경과 목적</div><Bullets items={l.context} /></>
      )}
      {l.principles.length > 0 && (
        <><div className="rk-recap-k">핵심 원리</div><Bullets items={l.principles} /></>
      )}
      {l.keyTerms.length > 0 && (
        <>
          <div className="rk-recap-k">주요 개념</div>
          <dl className="rk-cmp">
            {l.keyTerms.map((t) => (<div key={t.id}><dt>{t.term}</dt><dd>{t.def}</dd></div>))}
          </dl>
        </>
      )}
      {l.needsCheck.length > 0 && (
        <>
          <div className="rk-recap-k rk-recap-w">확인 필요</div>
          <ul className="rk-recap-l">{l.needsCheck.map((k, i) => <li key={i}>{k}</li>)}</ul>
        </>
      )}

      {l.retrieval.length > 0 && (
        <div className="rk-more">
          <button type="button" className="rk-more-b" onClick={() => setShowRt((v) => !v)} aria-expanded={showRt}>
            {showRt ? '접기' : `시험 대비 문답 ${l.retrieval.length}`}
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          {showRt && <Retrieval items={l.retrieval} />}
        </div>
      )}

      {/* 대화 기록은 대조용이다 — 읽는 내용이 아니라 근거. 접어둔다. */}
      {l.asks.length > 0 && (
        <div className="rk-more">
          <button type="button" className="rk-more-b" onClick={() => setShowAsk((v) => !v)} aria-expanded={showAsk}>
            {showAsk ? '접기' : `그날 질문 기록 ${l.asks.length} · 대조용`}
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          {showAsk && (
            <ol className="rk-asks-l">
              {l.asks.map((x) => (
                <li key={x.id}>
                  <p className="rk-asks-q">{x.q}</p>
                  {x.a.trim() && <p className="rk-asks-a">{x.a}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 진도 */

function Progress({ course, week }) {
  const [open, setOpen] = useState(null);
  const total = Math.max(course.progress.length, 16);
  // 계획에 빠진 주차가 있어도 표는 끝까지 채운다 — 빈 칸이 곧 "아직 안 채운 곳"이다.
  const rows = Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    return course.progress.find((w) => w.week === n) || { week: n, topic: '', note: '', done: false, ink: [] };
  });


  return (
    <div className="rk-weeks">
      {rows.map((r) => {
        const isNow = week === r.week;
        const isOpen = open === r.week;
        const lessons = course.lessons.filter((l) => l.week === r.week);
        // 배지는 '내가 아직 안 적은 차시' 를 가리킨다 (정리 결과 유무가 아니다).
        const undone = lessons.filter((l) => !l.note.trim()).length;
        return (
          <div key={r.week} className={'rk-wrow' + (isNow ? ' is-now' : '') + (isOpen ? ' is-open' : '')}>
            <button type="button" className="rk-wrow-h" onClick={() => setOpen(isOpen ? null : r.week)}
              aria-expanded={isOpen}>
              <span className="rk-wrow-n rk-num">{r.week}</span>
              <span className="rk-wrow-t">{r.topic || <i className="rk-faint">주제 미정</i>}</span>
              {isNow && <Tag tone="now">이번 주</Tag>}
              {undone > 0 && <Tag tone="warn">노트 없음 {undone}</Tag>}
              <ChevronDown size={16} strokeWidth={1.5} className="rk-wrow-c" aria-hidden="true" />
            </button>

            {isOpen && (
              <div className="rk-wrow-b">
                {lessons.length === 0 && (
                  <p className="rk-faint rk-empty-line">아직 이 주차의 차시가 없습니다.</p>
                )}

                {lessons.map((l) => (
                  <section key={l.id} className="rk-lesson">
                    <header className="rk-lesson-h">
                      <span className="rk-num rk-lesson-d">{l.date || '-'}</span>
                      <span className="rk-lesson-t">{l.topic || '주제 미정'}</span>
                      <span className={'rk-mic' + (l.hasAudio ? ' on' : '')}
                        title={l.hasAudio ? '녹음 있음' : '녹음 없음'}>
                        <Mic size={13} strokeWidth={1.5} aria-hidden="true" />
                        {l.hasAudio ? '녹음' : '녹음 없음'}
                      </span>
                    </header>

                    <Recap lesson={l} />
                  </section>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ 자료 */

function Materials({ course }) {
  if (!course.materials.length) {
    return <Empty title="등록된 자료가 없습니다" hint="강의자료·링크가 추가되면 그룹별로 정리되어 나타납니다." />;
  }
  return course.materials.map((g) => (
    <section className="rk-sub" key={g.id}>
      <h3 className="rk-h3">{g.group}<span className="rk-h2-note rk-num">{g.items.length}</span></h3>
      <ul className="rk-mats">
        {g.items.map((it) => (
          <li key={it.id}>
            {it.url ? (
              <a href={it.url} target="_blank" rel="noreferrer">
                <FileText size={15} strokeWidth={1.5} aria-hidden="true" />
                <span>{it.title}</span>
                <ExternalLink size={13} strokeWidth={1.5} aria-hidden="true" />
              </a>
            ) : (
              <span><FileText size={15} strokeWidth={1.5} aria-hidden="true" /><span>{it.title}</span></span>
            )}
            {it.note && <p className="rk-mat-n">{it.note}</p>}
          </li>
        ))}
      </ul>
    </section>
  ));
}

/* -------------------------------------------------------------- 시험대비 */

function Exam({ course }) {
  const [open, setOpen] = useState(() => new Set());
  const e = course.exam || {};
  const hasFields = e.type || e.scope || e.difficulty || e.date;

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <>
      <section className="rk-sub">
        <h3 className="rk-h3">시험 정보</h3>
        {hasFields && (
          <dl className="rk-fields">
            <Field label="유형">{e.type}</Field>
            <Field label="범위">{e.scope}</Field>
            <Field label="난이도">{e.difficulty}</Field>
            <Field label="일시">{e.date}</Field>
          </dl>
        )}
        {e.text && <p className={'rk-para' + (hasFields ? ' rk-mt' : '')}>{e.text}</p>}
        {!hasFields && !e.text && (
          <Empty title="시험 정보가 없습니다" hint="유형·범위·난이도가 정해지면 여기에 표시됩니다." />
        )}
      </section>

      <section className="rk-sub">
        <h3 className="rk-h3">요약 카드<span className="rk-h2-note rk-num">{course.summaries.length}</span></h3>
        {course.summaries.length === 0 ? (
          <Empty
            title="아직 정리한 내용이 없습니다"
            hint="강의대 앱에서 정리하면 여기에 나타납니다. 진도 탭의 차시에 적어도 올라옵니다."
          />
        ) : (
          <div className="rk-cards">
            {course.summaries.map((s) => {
              const isOpen = open.has(s.id);
              return (
                <div key={s.id} className={'rk-sumcard' + (isOpen ? ' is-open' : '')}>
                  <button type="button" className="rk-sumcard-h" onClick={() => toggle(s.id)} aria-expanded={isOpen}>
                    {s.week != null && <span className="rk-wrow-n rk-num">{s.week}</span>}
                    <span className="rk-sumcard-t">{s.title}</span>
                    <ChevronDown size={16} strokeWidth={1.5} className="rk-wrow-c" aria-hidden="true" />
                  </button>
                  {isOpen && <div className="rk-sumcard-b">{s.body || <i className="rk-faint">내용 없음</i>}</div>}
                </div>
              );
            })}
          </div>
        )}
      </section>

    </>
  );
}

/* ------------------------------------------------------------------ 본체 */

export default function CourseView({ course, week, tab, onTab, onBack }) {
  const active = TABS.some((t) => t.key === tab) ? tab : 'overview';
  const times = (course.meetings || []).filter((m) => m.day != null);

  return (
    <div className="rk-course" style={{ '--c': `var(--s${((course.colorIndex || 0) % 7) + 1})` }}>
      <button type="button" className="rk-back" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />대시보드
      </button>

      <header className="rk-course-h">
        <h1 className="rk-course-t"><Dot course={course} size={11} />{course.name}</h1>
        <p className="rk-course-s">
          {[course.professor, times.map(meetingText).join(', ')].filter(Boolean).join(' · ') || '정보 미정'}
        </p>
        {!course.confirmed && <Tag tone="warn">확인 필요</Tag>}
      </header>

      <div className="rk-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key} type="button" role="tab" aria-selected={active === t.key}
            className={'rk-tab' + (active === t.key ? ' is-on' : '')}
            onClick={() => onTab(t.key)}
          >
            <t.icon size={15} strokeWidth={1.5} aria-hidden="true" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="rk-tabpanel" role="tabpanel">
        {active === 'overview' && <Overview course={course} />}
        {active === 'progress' && <Progress course={course} week={week} />}
        {active === 'materials' && <Materials course={course} />}
        {active === 'exam' && <Exam course={course} />}
      </div>
    </div>
  );
}
