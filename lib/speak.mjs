// 화면 글 -> 읽을 글. 기기 음성(브라우저)과 미리 만든 소리(CosyVoice)가 같은 문장을 읽어야 하므로
// 규칙을 여기 한 곳에 둔다. 파이썬 쪽(tts_units.py)은 units.json 의 say 값을 그대로 쓴다.
const SYMBOLS = [
  ['—', ', '], ['–', ', '], ['→', ', '], ['⇒', ', '], ['↔', ', 반대로 '],
  ['≠', ' 은 다르다 '], ['=', ' 은 '], ['·', ', '], ['/', ', '], ['~', '에서 '],
  ['%', ' 퍼센트'], ['&', ' 그리고 '], ['vs.', ' 대 '], ['vs', ' 대 '],
];

export function speakText(input) {
  let t = String(input ?? '');
  t = t.replace(/⟨불명:[^⟩]*⟩/g, '');
  t = t.replace(/[`*_#>[\]]/g, '');
  t = t.replace(/§\s*(\d+)(?:의\s*(\d+))?/g, (m, a, b) => `제${a}조` + (b ? `의 ${b}` : ''));
  t = t.replace(/조으로/g, '조로');
  t = t.replace(/(\d+)\s*p\b/g, '$1쪽');
  t = t.replace(/[一-鿿㐀-䶿]+/g, '');   // 한자는 읽지 않는다(한글이 옆에 있다)
  t = t.replace(/\(\s*\)/g, '');
  // 괄호 뒤에 조사가 붙어 있으면 조사를 앞말에 돌려준다: 하느냐(§4)와 -> 하느냐와, 제4조,
  t = t.replace(/\(([^)]{0,40})\)([가-힣]{1,2})(?=[\s.,]|$)/g, '$2, $1, ');
  t = t.replace(/\(([^)]{0,40})\)/g, ', $1, ');
  for (const [a, b] of SYMBOLS) t = t.split(a).join(b);
  t = t.replace(/\s*,\s*(,\s*)+/g, ', ');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\s+,/g, ',');
  t = t.replace(/,\s*([.!?])/g, '$1').replace(/^[\s,]+|[\s,]+$/g, '');
  if (t && !'.!?'.includes(t[t.length - 1])) t += '.';
  return t;
}
