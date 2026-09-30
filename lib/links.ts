// 서랍 웹 링크 — 웹 주소 모양은 여기 한 곳에서. MCP 는 결과에 링크를 싣고, 링크로 가리킨 것도 받아들인다.
// 보고서 /drawer/r/<id> · 폴더 /drawer/f/<id> · 맨 위 /drawer · 휴지통 /drawer/trash

export const DEFAULT_WEB_URL = "http://localhost:3200";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 웹 안 경로. id 가 null 이면 맨 위 */
export function drawerPath(kind: "folder" | "report", id: string | null): string {
  if (id === null) return "/drawer";
  return kind === "report" ? `/drawer/r/${id}` : `/drawer/f/${id}`;
}

export const TRASH_PATH = "/drawer/trash";

/** 끝 슬래시를 뗀 웹 주소 */
export function webBase(url: string | undefined | null): string {
  const u = (url ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/]/i.test(u) ? u : DEFAULT_WEB_URL;
}

export type LinkTarget = { kind: "report" | "folder"; id: string } | { kind: "root" };

/**
 * http(s) 주소가 서랍 링크면 가리키는 것, 아니면 null. 주소의 호스트는 보지 않는다(로컬·배포 어느 쪽 링크든).
 * ?demo=1 같은 뒤쪽은 무시한다.
 */
export function parseDrawerLink(s: string): LinkTarget | null {
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = u.pathname.replace(/\/+$/, "");
  if (path === "/drawer") return { kind: "root" };
  const m = /^\/drawer\/(r|f)\/([^/]+)$/.exec(path);
  if (!m || !UUID.test(m[2]!)) return null;
  return { kind: m[1] === "r" ? "report" : "folder", id: m[2]!.toLowerCase() };
}

/** 주소처럼 생겼는지 (경로 /… 와 구별) */
export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}
