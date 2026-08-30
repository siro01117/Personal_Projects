// PIN 해시 (브라우저 데모판) — 원본은 node:crypto(scryptSync)를 쓰지만 브라우저 번들엔 없다.
// 데모에서는 auth.ts가 로그인을 항상 우회(데모 관리자 고정)하므로 이 해시가 실제로
// 검증되는 경로가 없다 — bootstrap.ts의 시드 insert가 깨지지 않도록 동기 동작만 유지한다.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function hashPin(pin: string): string {
  const salt = Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16);
  return `${salt}:${fnv1a(salt + pin)}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, h] = stored.split(":");
  if (!salt || !h) return false;
  return fnv1a(salt + pin) === h;
}

// 6자리 숫자 PIN 자동 생성
export function genPin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
