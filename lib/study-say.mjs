// 듣기에서 읽는 줄의 목록과 주소. 화면(CourseView)과 소리 만드는 스크립트(scripts/study-tts.mjs)가
// 같은 순서·같은 주소를 써야 자막이 맞는다 — 그래서 한 곳에 둔다. 의존성 없는 순수 함수만.
//
// 읽는 것: 네 블록(내 생각 흐름 / 배경과 목적 / 핵심 원리 / 주요 개념)과 그 소제목.
// 안 읽는 것: 확인 필요(메모), 시험 대비 문답(답을 먼저 들으면 안 된다), 질문 기록(대조용).

export const SAY_PARTS = [
  { k: 'flow', title: '내 생각 흐름' },
  { k: 'context', title: '배경과 목적' },
  { k: 'principles', title: '핵심 원리' },
  { k: 'keyTerms', title: '주요 개념' },
];

export function sayUnits(lesson) {
  const out = [];
  for (const part of SAY_PARTS) {
    const items = Array.isArray(lesson?.[part.k]) ? lesson[part.k] : [];
    if (!items.length) continue;
    out.push({ k: `h-${part.k}`, i: 0, text: part.title });
    items.forEach((x, i) => {
      const text = part.k === 'keyTerms'
        ? `${x?.term || ''}. ${x?.def || x?.line || ''}`
        : String(x ?? '');
      if (text.trim()) out.push({ k: part.k, i, text });
    });
  }
  return out;
}

// 글이 바뀌면 소리도 다시 만들어야 한다 — 만든 시점의 글 지문을 tts.sig 로 남겨 비교한다.
export function saySig(lesson) {
  const s = sayUnits(lesson).map((u) => `${u.k}:${u.i}:${u.text}`).join('\n');
  let h = 5381;
  for (let n = 0; n < s.length; n += 1) h = ((h * 33) ^ s.charCodeAt(n)) >>> 0;
  return h.toString(36);
}
