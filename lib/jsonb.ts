// jsonb 컬럼을 읽을 때 쓰는 정규화 헬퍼.
//
// 왜 필요한가: 운영은 postgres.js 를 fetch_types:false 로 쓴다(db.ts 참고 — 서버리스에서 접속마다
// pg_type 조회가 한 번씩 더 붙는 걸 피하려고). 그런데 이 옵션을 끄면 드라이버가 타입 OID 를 모르는
// 컬럼을 전부 "문자열 그대로" 돌려준다. jsonb 도 여기 해당해서 운영에서는 payload 가 객체가 아니라
// JSON 문자열로 들어온다. 반면 로컬 PGlite 는 파싱된 객체를 준다.
//
// 그래서 로컬에서는 멀쩡하고 배포에서만 "형식이 올바르지 않습니다"로 실패하는 차이가 생겼다.
// jsonb 를 읽는 코드는 값을 쓰기 전에 반드시 이 함수를 통과시킨다.
export function asJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null; // 파싱 불가 = 진짜 형식 오류. 호출부가 각자 방식으로 처리한다.
  }
}

/** asJson 결과가 평범한 객체일 때만 돌려준다(배열·null·원시값은 null). */
export function asJsonObject(value: unknown): Record<string, unknown> | null {
  const v = asJson(value);
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
