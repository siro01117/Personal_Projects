// 단원 강의 한 편의 뼈대. 화면(app/study/Lecture.js)과 소리 만드는 스크립트가 같은 함수를 쓴다 —
// 읽는 줄과 화면의 줄이 어긋나지 않으려면 순서와 주소가 한 곳에서 나와야 한다.
//
// 블록 종류:
//   h   소제목            pre  먼저 생각해보기(선질문)     q  멈춰서 답해보기 + 접힌 답
//   p   문단              ul   목록                        map 오늘 갈 길(차례)
//   table 표              hint 여기서 막히면              note 곁가지(접어둠)
//
// 읽는 것: h · p · ul · map · pre(질문) · q(질문만).
// 안 읽는 것: q 의 답(먼저 들으면 인출이 안 된다) · hint(막혔을 때만 보는 것) · note(곁가지) · table(소리로 표는 안 들린다).

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);

export function normLecture(doc) {
  const o = doc && typeof doc === 'object' ? doc : {};
  return {
    id: str(o.id, 'u1') || 'u1',
    title: str(o.title, '단원') || '단원',
    pages: str(o.pages),
    frame: str(o.frame),
    lead: str(o.lead),
    blocks: arr(o.blocks).map((b) => (b && typeof b === 'object' ? b : { t: 'p', text: str(b) })),
    tts: o.tts && typeof o.tts === 'object' ? o.tts : null,
  };
}

// 화면에 그릴 줄 목록. key 가 곧 듣기 주소다.
export function lectureRows(doc) {
  const l = normLecture(doc);
  const rows = [];
  l.blocks.forEach((b, n) => {
    const t = str(b.t, 'p') || 'p';
    if (t === 'ul') {
      const items = arr(b.items).map(str).filter(Boolean);
      if (items.length) rows.push({ key: `${n}`, t: 'ul', items, says: items.map((x, j) => ({ key: `${n}.${j}`, text: x })) });
      return;
    }
    if (t === 'map') {
      const items = arr(b.items).map(str).filter(Boolean);
      if (items.length) rows.push({ key: `${n}`, t: 'map', items, says: [{ key: `${n}`, text: `오늘 갈 길. ${items.join('. ')}` }] });
      return;
    }
    if (t === 'table') {
      const head = arr(b.head).map(str);
      const body = arr(b.rows).map((r) => arr(r).map(str));
      if (body.length) rows.push({ key: `${n}`, t: 'table', head, rows: body, caption: str(b.caption), says: [] });
      return;
    }
    if (t === 'q') {
      const q = str(b.q);
      if (q) rows.push({ key: `${n}`, t: 'q', q, a: str(b.a), says: [{ key: `${n}`, text: q }] });
      return;
    }
    if (t === 'pre') {
      const q = str(b.q || b.text);
      if (q) rows.push({ key: `${n}`, t: 'pre', q, says: [{ key: `${n}`, text: q }] });
      return;
    }
    if (t === 'hint') {
      const text = str(b.text);
      if (text) rows.push({ key: `${n}`, t: 'hint', text, says: [] });
      return;
    }
    if (t === 'note') {
      const text = str(b.text);
      if (text) rows.push({ key: `${n}`, t: 'note', title: str(b.title, '곁가지'), text, says: [] });
      return;
    }
    const text = str(b.text);
    if (!text) return;
    rows.push({ key: `${n}`, t: t === 'h' ? 'h' : 'p', text, says: [{ key: `${n}`, text }] });
  });
  return rows;
}

export function sayUnits(doc) {
  const out = [];
  for (const r of lectureRows(doc)) {
    for (const s of r.says || []) out.push({ k: 'r', i: s.key, text: s.text });
  }
  return out;
}

// 글이 바뀌면 소리도 다시 만들어야 한다 — 만든 시점의 지문을 tts.sig 로 남겨 비교한다.
export function saySig(doc) {
  const s = sayUnits(doc).map((u) => `${u.i}:${u.text}`).join('\n');
  let h = 5381;
  for (let n = 0; n < s.length; n += 1) h = ((h * 33) ^ s.charCodeAt(n)) >>> 0;
  return h.toString(36);
}
