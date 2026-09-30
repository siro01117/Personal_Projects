// 글 안 강조 `==강조==` (설계서 7-3장 — 화면은 굵게). 웹·Markdown 이 같이 쓰는 순수 함수 — HTML 해석은 없고 구분자만 나눈다.
// - 여는 == 뒤 가장 가까운 == 가 짝. 짝이 없거나 줄을 넘어가면 그 == 는 글자 그대로
// - 빈 강조(==== · == ==)는 강조하지 않고 글자 그대로. 중첩 없음

export type Piece = { text: string; mark: boolean };

// U+2028·U+2029 는 코드로 만든다 (markdown.ts 와 같은 이유)
const LINE_BREAK = new RegExp(`[\n\r${String.fromCharCode(0x2028, 0x2029)}]`);

export function splitMarks(s: string): Piece[] {
  const out: Piece[] = [];
  const plain = (t: string) => {
    if (t === "") return;
    const last = out[out.length - 1];
    if (last && !last.mark) last.text += t;
    else out.push({ text: t, mark: false });
  };
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("==", i);
    if (open < 0) break;
    const close = s.indexOf("==", open + 2);
    if (close < 0) break;
    const inner = s.slice(open + 2, close);
    if (LINE_BREAK.test(inner)) {
      // 줄을 넘는 짝은 없다 — 여는 쪽만 글자로 두고, 닫는 쪽은 다음 강조의 여는 쪽이 될 수 있다
      plain(s.slice(i, open + 2));
      i = open + 2;
      continue;
    }
    if (inner.trim() === "") {
      plain(s.slice(i, close + 2));
      i = close + 2;
      continue;
    }
    plain(s.slice(i, open));
    out.push({ text: inner, mark: true });
    i = close + 2;
  }
  plain(s.slice(i));
  return out;
}

/** 강조 표시를 빼고 글자만 (차례·미리보기 등) */
export function stripMarks(s: string): string {
  return splitMarks(s)
    .map((p) => p.text)
    .join("");
}

/** Markdown 복사: ==강조== → **강조**. 앞뒤 공백은 ** 바깥으로 (** a ** 는 굵게가 안 되므로) */
export function marksToMarkdown(s: string): string {
  return splitMarks(s)
    .map((p) => {
      if (!p.mark) return p.text;
      const m = /^(\s*)(.*?)(\s*)$/.exec(p.text)!;
      return `${m[1]}**${m[2]}**${m[3]}`;
    })
    .join("");
}
