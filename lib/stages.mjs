// 스테이지 — 빈 화면 대신 질문 하나씩 띄우고, 답한 것을 모아 교재처럼 보여준다.
//
// 왜 질문으로 받나: 빈 칸은 무엇을 쓸지 정하는 데 힘을 쓰게 한다. 질문이 있으면 떠올리기만 하면 된다.
// 왜 하나씩인가: 한 화면에 열 칸이 있으면 어디부터 할지 또 정해야 한다.
//
// 예시(ph)는 과목을 타지 않게 비워 둔다. 한 과목 예시를 넣으면 다른 과목에서는
// 길잡이가 아니라 방해가 된다. 형태만 보여 주고 내용은 사용자가 채운다.
//
// 채운 답은 lib/lecture.mjs 의 블록으로 바뀌어 같은 화면(LectureView)에서 읽힌다.
// 그래서 다 채우면 내가 쓴 강의본과 같은 모양이 되고, 듣기도 그대로 붙는다.

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const lines = (v) => arr(v).map(str).map((s) => s.trim()).filter(Boolean);
const pairs = (v) => arr(v)
  .map((p) => ({ k: str(p?.k).trim(), v: str(p?.v).trim() }))
  .filter((p) => p.k || p.v);
const qas = (v) => arr(v)
  .map((p) => ({ q: str(p?.q).trim(), a: str(p?.a).trim() }))
  .filter((p) => p.q);

// 층위는 셋이다. 큰 것 -> 안의 것 -> 내 것. 바뀌는 자리를 화면에 보여 줘야
// 결이 달라지는 게 방해가 아니라 신호가 된다.
export const GROUPS = [
  { key: 'big', label: '큰 것', hint: '이 단원이 어디에 있는지' },
  { key: 'in', label: '안의 것', hint: '안에 무엇이 들었는지' },
  { key: 'mine', label: '내 것', hint: '내가 쓸 수 있게' },
];

// 순서가 곧 교재의 순서다. 위에서 아래로 갈수록 좁아진다.
export const STAGES = [
  {
    key: 'problem', group: 'big', title: '이게 없으면 무슨 일이 생기나',
    help: '이 단원이 왜 있는지를 한두 줄로. 정의 말고 목적.',
    kind: 'lines', ph: '예) 앞의 방법으로는 다루지 못하는 경우가 생겨서',
    head: '이 단원이 푸는 문제',
  },
  {
    key: 'prior', group: 'big', title: '이걸 읽으려면 뭘 알고 있어야 하나',
    help: '앞에서 배운 것 중 없으면 막히는 것. 두세 개.',
    kind: 'lines', ph: '예) 지난주에 나온 정의 하나',
    head: '앞에서 가져오는 것',
  },
  {
    key: 'skeleton', group: 'big', title: '큰 덩어리만 순서대로',
    help: '다섯 줄 안. 세부는 넣지 않는다. 이게 나중에 길 잃었을 때 돌아올 자리다.',
    kind: 'lines', ph: '예) 1. 기준 두 가지',
    head: '뼈대',
  },
  {
    key: 'rules', group: 'in', title: '왜 그렇게 되나',
    help: '규칙을 한 줄씩. "무엇이다"가 아니라 "왜 그렇게 되나"로 쓴다.',
    kind: 'lines', ph: '예) 조건이 겹치면 좁은 쪽이 이긴다',
    head: '핵심 원리',
  },
  {
    key: 'terms', group: 'in', title: '새로 나온 말과 뜻',
    help: '말 한쪽, 뜻 한 줄. 교재 문장을 옮기지 말고 네 말로.',
    kind: 'pairs', ph: ['용어', '교재 문장 말고 내 말로 한 줄'],
    head: '주요 개념', th: ['말', '뜻'],
  },
  {
    key: 'naming', group: 'in', title: '이 말은 왜 이 이름인가',
    help: '이름을 풀면 외울 게 준다. 다 안 해도 된다. 헷갈리는 것만.',
    kind: 'pairs', ph: ['용어', '이 이름이 붙은 이유'],
    head: '이름 풀이', th: ['말', '이름의 뜻'],
  },
  {
    key: 'contrast', group: 'in', title: '헷갈리는 짝. 무엇이 갈랐나',
    help: '둘을 나란히 놓고 갈린 지점 하나만. 따로 보는 것보다 이쪽이 훨씬 잘 남는다.',
    kind: 'pairs', ph: ['헷갈리는 둘', '무엇이 갈랐는지 한 줄'],
    head: '헷갈리는 짝', th: ['짝', '갈린 지점'],
  },
  {
    key: 'asks', group: 'mine', title: '시험에 나온다면 어떻게 물을까',
    help: '질문을 먼저 쓰고 답은 나중에 채워도 된다. 나중에 덮고 답하는 데 쓴다.',
    kind: 'qa', ph: ['이렇게 물을 것 같다', '답 — 나중에 채워도 된다'],
    head: '', // 질문 블록으로 들어간다
  },
  {
    key: 'stuck', group: 'mine', title: '지금 안 보이는 것',
    help: '못 푼 채로 둬도 된다. 대신 무엇이 안 보이는지는 적어 둔다.',
    kind: 'lines', ph: '예) 두 경우를 왜 다르게 처리하는지',
    head: '막힌 것',
  },
];

export const STAGE_KEYS = STAGES.map((s) => s.key);

export function emptyAnswers() {
  const a = {};
  for (const s of STAGES) a[s.key] = [];
  return a;
}

export function normNote(n, i = 0) {
  const o = n && typeof n === 'object' ? n : {};
  const src = o.a && typeof o.a === 'object' ? o.a : {};
  const a = {};
  for (const s of STAGES) {
    if (s.kind === 'pairs') a[s.key] = pairs(src[s.key]);
    else if (s.kind === 'qa') a[s.key] = qas(src[s.key]);
    else a[s.key] = lines(src[s.key]);
  }
  return {
    id: str(o.id, `n${i}`) || `n${i}`,
    title: str(o.title),
    at: str(o.at),
    pages: str(o.pages),
    seen: lines(o.seen).filter((k) => STAGE_KEYS.includes(k)),
    a,
  };
}

// 채운 칸 수 / 전체
// 층위마다 몇 칸을 채웠나 — 진행 막대를 층위별로 나눠 그리는 데 쓴다.
export function groupProgress(note) {
  return GROUPS.map((g) => {
    const items = STAGES.filter((s) => s.group === g.key);
    return {
      ...g,
      total: items.length,
      filled: items.filter((s) => (note.a[s.key] || []).length > 0).length,
    };
  });
}

export function progress(note) {
  const filled = STAGES.filter((s) => (note.a[s.key] || []).length > 0).length;
  return { filled, total: STAGES.length };
}

// 답 -> 교재 블록 (lib/lecture.mjs 가 그리는 모양)
export function noteToUnit(note) {
  const blocks = [];
  for (const s of STAGES) {
    const v = note.a[s.key] || [];
    if (!v.length) continue;
    if (s.kind === 'qa') {
      blocks.push({ t: 'h', text: '스스로 묻기' });
      for (const x of v) blocks.push({ t: 'q', q: x.q, a: x.a });
      continue;
    }
    blocks.push({ t: 'h', text: s.head });
    if (s.kind === 'pairs') {
      blocks.push({ t: 'table', head: s.th || ['', ''], rows: v.map((p) => [p.k, p.v]) });
    } else if (v.length === 1) {
      blocks.push({ t: 'p', text: v[0] });
    } else {
      blocks.push({ t: 'ul', items: v });
    }
  }
  return { id: note.id, title: note.title || '제목 없음', pages: note.pages, frame: '', lead: '', blocks, tts: null };
}
