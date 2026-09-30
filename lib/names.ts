// 폴더 이름·보고서 제목 규칙. DB 의 CHECK(ez_items_name_check)·ez_unique_name 과 같은 규칙이어야 한다.

export const NAME_MAX = 100;

/** 줄바꿈·제어 문자(C0, DEL, C1)와 줄/문단 구분자. `/` 는 따로 검사한다 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/** 글자 수는 코드 포인트로 센다 (Postgres char_length 와 같게) */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** 앞에서부터 코드 포인트 n 개 */
export function takeChars(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/** 앞뒤 공백 제거. JS trim 과 DB ez_trim 은 같은 문자 집합을 지운다 */
export function normalizeName(name: string): string {
  return name.trim();
}

/** 앞뒤 공백을 지운 뒤 규칙을 검사한다. 맞으면 null, 아니면 한국어 오류 */
export function validateName(name: string): string | null {
  const n = normalizeName(name);
  if (n.length === 0) return "이름이 비어 있습니다";
  if (n === "." || n === "..") return "이름으로 . 이나 .. 는 쓸 수 없습니다";
  const len = charCount(n);
  if (len > NAME_MAX) return `이름은 ${NAME_MAX}자까지 쓸 수 있습니다 (지금 ${len}자)`;
  if (n.includes("/")) return "이름에 / 는 쓸 수 없습니다";
  if (CONTROL.test(n)) return "이름에 줄바꿈이나 제어 문자는 쓸 수 없습니다";
  return null;
}

function nameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

/** 대소문자·앞뒤 공백을 무시하고 같은 이름인지 */
export function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

const SUFFIX = /^(.*) \((\d{1,6})\)$/su;

/**
 * 겹치지 않는 이름. 안 겹치면 그대로, 겹치면 `이름 (2)`, `(3)` …
 * 이미 `이름 (2)` 꼴이면 `이름 (3)` 부터 이어간다. 100자를 넘으면 앞부분을 잘라 접미사 자리를 만든다.
 */
export function uniqueName(base: string, existingNames: Iterable<string>): string {
  const name = normalizeName(base);
  const taken = new Set<string>();
  for (const e of existingNames) taken.add(nameKey(e));
  if (!taken.has(nameKey(name))) return name;

  let stem = name;
  let n = 2;
  const m = SUFFIX.exec(name);
  if (m && m[1]) {
    stem = m[1];
    n = Math.max(2, Number(m[2]) + 1);
  }
  for (;;) {
    const suffix = ` (${n})`;
    const candidate = takeChars(stem, NAME_MAX - suffix.length) + suffix;
    if (!taken.has(nameKey(candidate))) return candidate;
    n++;
  }
}
