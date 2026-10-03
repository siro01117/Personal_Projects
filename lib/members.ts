// 회원 · 추가 모듈의 규칙 (docs/회원.md). 웹 화면 · 서버 라우트가 같이 쓴다. 무결성은 DB(0015)가 막고 여기는 먼저 알려 주는 쪽.

/** 회원 아이디가 Supabase 이메일이 될 때 붙는 곳 (실제 메일은 안 간다) */
export const MEMBER_DOMAIN = "members.ra-kan.cloud";
/** 관리 화면 (관리자만) */
export const ADMIN_PATH = "/admin";
export const LOGIN_ID = /^[a-z0-9._-]{3,20}$/;
export const MODULE_KEY = /^[a-z0-9-]{2,30}$/;
export const MEMBER_NAME_MAX = 20;
export const MODULE_NAME_MAX = 20;
export const PASSWORD_MIN = 8;
/** Supabase Auth 의 비밀번호 상한 (bcrypt 72바이트) */
export const PASSWORD_MAX = 72;
export const HREF_MAX = 500;

export type MeRole = "admin" | "member" | "none";
export type ModuleKind = "builtin" | "link";

/** ez_modules 한 줄 */
export type ModuleRow = { key: string; name: string; kind: ModuleKind; href: string; sort: number };

/** ez_me 가 주는 것. modules = 이 사람에게 보이는 모듈(관리자 전부 · 회원은 허용된 것), sort 순 */
export type Me = { role: MeRole; name: string | null; active: boolean; allowed: string[]; picked: string[]; modules: ModuleRow[] };

/** 관리 화면의 회원 한 줄 (ez_members + auth.users.last_sign_in_at) */
export type MemberRow = {
  user_id: string;
  login_id: string;
  name: string;
  active: boolean;
  allowed: string[];
  created_at: string;
  last_sign_in_at: string | null;
};

export type NewMember = { login_id: string; password: string; name: string; allowed: string[] };
export type MemberPatch = { password?: string; name?: string; active?: boolean; allowed?: string[] };
export type NewModule = { name: string; href: string };

/** 로그인 칸: @ 가 없으면 아이디로 보고 <아이디>@members.ra-kan.cloud 로 */
export function loginEmail(input: string): string {
  const v = input.trim();
  return v.includes("@") ? v : `${v.toLowerCase()}@${MEMBER_DOMAIN}`;
}

/** 이 앱의 회원 이메일이면 아이디, 아니면 null */
export function loginIdOf(email: string | null | undefined): string | null {
  const suffix = `@${MEMBER_DOMAIN}`;
  return email && email.toLowerCase().endsWith(suffix) ? email.slice(0, -suffix.length).toLowerCase() : null;
}

/** 쓸 수 있는 계정인지 — 관리자 또는 켜진 회원 */
export function usable(me: Me): boolean {
  return me.role === "admin" || (me.role === "member" && me.active);
}

/** 사이드바 · 홈에 보일 추가 모듈: 켠 것 ∩ 허용된 것, sort 순 (modules 가 이미 sort 순) */
export function shownModules(me: Me | null): ModuleRow[] {
  if (!me || !usable(me)) return [];
  const allowed = new Set(me.allowed);
  const picked = new Set(me.picked);
  return me.modules.filter((m) => allowed.has(m.key) && picked.has(m.key));
}

/** 선택창에 보일 것: 허용된 모듈, sort 순 */
export function pickable(me: Me | null): ModuleRow[] {
  if (!me || !usable(me)) return [];
  const allowed = new Set(me.allowed);
  return me.modules.filter((m) => allowed.has(m.key));
}

/** 켜기 · 끄기 뒤의 picked. 허용 밖의 키는 이참에 뺀다 */
export function togglePicked(me: Me, key: string, on: boolean): string[] {
  const allowed = new Set(me.allowed);
  const rest = me.picked.filter((k) => k !== key && allowed.has(k));
  return on ? [...rest, key] : rest;
}

const trim = (s: string) => s.replace(/^\s+|\s+$/g, "");

/** 회원 추가 칸 검사 — 잘못이면 한국어 문구, 맞으면 null */
export function newMemberError(m: NewMember): string | null {
  if (!LOGIN_ID.test(m.login_id)) return "아이디는 영문 소문자 · 숫자 · . _ - 3~20자입니다";
  return nameError(m.name) ?? passwordError(m.password) ?? keysError(m.allowed);
}

export function nameError(name: string): string | null {
  return name === trim(name) && name.length >= 1 && [...name].length <= MEMBER_NAME_MAX ? null : "이름은 앞뒤 공백 없이 1~20자입니다";
}

export function passwordError(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return "비밀번호는 8자 이상입니다";
  if (new TextEncoder().encode(pw).length > PASSWORD_MAX) return "비밀번호가 너무 깁니다 (72바이트까지)";
  return null;
}

export function keysError(keys: unknown): string | null {
  if (!Array.isArray(keys) || keys.length > 50 || keys.some((k) => typeof k !== "string" || !MODULE_KEY.test(k)) || new Set(keys).size !== keys.length) {
    return "허용 모듈 키가 맞지 않습니다";
  }
  return null;
}

/** 링크 모듈 주소: https 만, 공백 없음, 500자까지. 맞으면 null */
export function linkError(href: string): string | null {
  if (href.length > HREF_MAX || /\s/.test(href) || !/^https:\/\/[^/?#@]+([/?#].*)?$/.test(href)) return "주소는 https:// 로 시작해야 합니다";
  try {
    new URL(href);
  } catch {
    return "주소가 맞지 않습니다";
  }
  return null;
}

export function moduleNameError(name: string): string | null {
  return name === trim(name) && name.length >= 1 && [...name].length <= MODULE_NAME_MAX ? null : "이름은 앞뒤 공백 없이 1~20자입니다";
}

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function random6(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => ALNUM[x % ALNUM.length]).join("");
}

/**
 * 이름에서 모듈 키: 영문 · 숫자(· 공백 · -)로만 된 이름이면 소문자로 줄여 '-' 로 잇는다. 아니면 'm-' + 무작위 6자.
 * taken 에 있으면 끝에 -2, -3 …
 */
export function moduleKeyFrom(name: string, taken: readonly string[] = [], rand: () => string = random6): string {
  const v = trim(name);
  let base = /^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(v)
    ? v
        .toLowerCase()
        .replace(/[\s-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 26)
        .replace(/-+$/, "")
    : "";
  if (!MODULE_KEY.test(base)) base = `m-${rand()}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}
