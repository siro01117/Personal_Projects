// 에이전트 연결 — 개인 토큰의 규칙 (docs/에이전트-연결.md 1 · 3장). 웹 화면과 메모리 구현이 같이 쓴다. 무결성은 DB(0019)가 막고 여기는 먼저 알려 주는 쪽.

export const TOKEN_NAME_MAX = 30;
/** 사람당 살아 있는 토큰 수 */
export const TOKENS_MAX = 10;
/** 설정 화면 */
export const AGENT_PATH = "/settings/agent";
/** 원격 MCP 주소의 경로 */
export const MCP_PATH = "/api/mcp";
/** claude mcp add 에 넣는 서버 이름 */
export const MCP_NAME = "ezwork";
export const TOKEN_SHAPE = /^ezt_[0-9A-Za-z]{40}$/;

export type TokenScope = "rw" | "ro";
export const SCOPE_LABEL: Record<TokenScope, string> = { rw: "읽고 쓰기", ro: "읽기만" };

/** 목록의 한 줄 (살아 있는 것만 보인다). 원문 · 해시는 없다 */
export type TokenRow = { id: string; name: string; tail: string; scope: TokenScope; last_used_at: string | null; created_at: string };
/** 만든 직후 한 번 — token 이 원문 */
export type MadeToken = TokenRow & { token: string };

const trim = (s: string) => s.replace(/^\s+|\s+$/g, "");

/** 이름 검사 — 잘못이면 한국어 문구, 맞으면 null (앞뒤 공백은 지운 뒤에 센다) */
export function tokenNameError(name: string): string | null {
  const v = trim(name);
  return v.length >= 1 && [...v].length <= TOKEN_NAME_MAX && !/[\u0001-\u001f\u007f-\u009f\u2028\u2029]/.test(v) ? null : `이름은 1~${TOKEN_NAME_MAX}자입니다`;
}

/** 원격 MCP 주소 (origin 은 지금 사이트 — 배포에서는 https://ra-kan.cloud) */
export function mcpUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${MCP_PATH}`;
}

/** 터미널에 붙여 넣을 한 줄 (Claude Code) */
export function connectCommand(origin: string, token: string): string {
  return `claude mcp add --transport http ${MCP_NAME} ${mcpUrl(origin)} --header "Authorization: Bearer ${token}"`;
}

/** 목록에서 알아보는 끝 4자: …a1b2 */
export const tailLabel = (tail: string) => `…${tail}`;
