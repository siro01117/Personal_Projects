// DB·네트워크 오류 → 에이전트가 읽을 한국어. 규칙 자체는 DB 가 지키고, 여기서는 말만 바꾼다.

/** Store 구현이 던지는 오류. code 는 SQLSTATE(23505 …) 또는 PostgREST 코드 */
export class DbError extends Error {
  override name = "DbError";
  constructor(
    message: string,
    readonly code: string,
    readonly details?: string,
  ) {
    super(message);
  }
}

export type KoreanError = { message: string; code: string };

const EZ = /^\[(EZ_[A-Z_]+)\]\s*(.*)$/s;

const NETWORK = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR|network|socket hang up/i;

function field(e: unknown, k: string): string {
  if (typeof e !== "object" || e === null) return "";
  const v = (e as Record<string, unknown>)[k];
  return typeof v === "string" ? v : "";
}

export function toKorean(err: unknown): KoreanError {
  const code = field(err, "code");
  const message = field(err, "message") || (typeof err === "string" ? err : "");
  const all = `${message} ${field(err, "details")} ${field(err, "constraint")}`;

  const ez = EZ.exec(message);
  if (ez) return { code: ez[1]!, message: ez[2]!.trim() };

  if (code === "23505") return { code: "NAME_TAKEN", message: "같은 폴더에 같은 이름이 이미 있습니다 (대소문자 무시)" };
  if (code === "23514") {
    if (all.includes("ez_items_blocks_size_check")) {
      return { code: "TOO_LARGE", message: "보고서가 너무 큽니다 — 블록을 나눠 두 보고서로 넣으세요" };
    }
    if (all.includes("ez_items_name_check")) {
      return {
        code: "BAD_NAME",
        message: "이름 규칙에 어긋납니다 — 앞뒤 공백 없이 1~100자, / · 줄바꿈 · 제어 문자 · . · .. 는 쓸 수 없습니다",
      };
    }
    if (all.includes("ez_items_not_self_parent")) {
      return { code: "EZ_CYCLE", message: "폴더를 자기 자신 안으로 옮길 수 없습니다" };
    }
    const c = /constraint "([^"]+)"/.exec(all)?.[1];
    return { code: "CHECK", message: `저장 규칙에 어긋납니다${c ? ` (${c})` : ""}` };
  }
  if (code === "23503") return { code: "EZ_PARENT", message: "넣을 폴더가 없습니다" };
  if (code === "22P02") return { code: "BAD_INPUT", message: "id 형식이 맞지 않습니다 (uuid)" };
  if (code === "PGRST301" || code === "401" || /invalid api key|jwt/i.test(message)) {
    return { code: "AUTH", message: "Supabase 가 키를 거절했습니다 — .env.local 의 EZ_SUPABASE_SERVICE_ROLE_KEY 를 확인하세요" };
  }
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  if ((err instanceof TypeError && !code) || NETWORK.test(all) || NETWORK.test(`${field(cause, "code")} ${field(cause, "message")}`)) {
    return { code: "NETWORK", message: "Supabase 에 연결하지 못했습니다 (네트워크). 잠시 뒤 다시 하세요" };
  }
  return { code: code || "DB", message: `DB 오류: ${message || String(err)}` };
}
