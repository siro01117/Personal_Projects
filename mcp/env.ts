// .env.local 읽기 (dotenv 없이). 키 값은 어디에도 출력하지 않는다.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { webBase } from "../lib/links";

export const ENV_FILE = fileURLToPath(new URL("../.env.local", import.meta.url));

export const REQUIRED_ENV = ["EZ_SUPABASE_URL", "EZ_SUPABASE_SERVICE_ROLE_KEY", "EZ_OWNER_ID", "EZ_AGENT_NAME"] as const;
/** EZ_WEB_URL 은 없어도 된다 — 결과에 싣는 웹 링크의 앞부분 (기본 http://localhost:3200) */
export type Env = Record<(typeof REQUIRED_ENV)[number], string> & { EZ_WEB_URL: string };

/** KEY=VALUE 줄만 읽는다. # 주석·빈 줄 무시, 값의 앞뒤 따옴표 제거 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** 프로세스 환경(우선)과 .env.local 을 합쳐 필요한 값을 꺼낸다. 없으면 무엇이 없는지 한국어로 */
export function loadEnv(
  processEnv: Record<string, string | undefined> = process.env,
  fileText: string | null = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : null,
): { env: Env } | { error: string } {
  const file = fileText === null ? {} : parseEnvFile(fileText);
  const get = (k: string) => processEnv[k]?.trim() || file[k]?.trim() || "";
  const missing = REQUIRED_ENV.filter((k) => !get(k));
  if (missing.length > 0) {
    const where = fileText === null ? `${ENV_FILE} (파일이 없습니다)` : ENV_FILE;
    return { error: `보고서 서랍 MCP: 환경변수가 없습니다 — ${missing.join(", ")}. ${where} 에 KEY=값 으로 넣으세요` };
  }
  const env = { ...Object.fromEntries(REQUIRED_ENV.map((k) => [k, get(k)])), EZ_WEB_URL: webBase(get("EZ_WEB_URL")) } as Env;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.EZ_OWNER_ID)) {
    return { error: "보고서 서랍 MCP: EZ_OWNER_ID 는 Supabase 사용자 id(uuid)여야 합니다" };
  }
  if (!/^https?:\/\//.test(env.EZ_SUPABASE_URL)) {
    return { error: "보고서 서랍 MCP: EZ_SUPABASE_URL 은 https:// 로 시작하는 Supabase 주소여야 합니다" };
  }
  return { env };
}
