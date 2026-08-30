// 학생 공개 폼(sch9m2vt.tsx)이 제출한 정기 스케쥴(submission.payload, {hours,restDays,academies,note}
// 모양)을 src/lib/schedule-import.ts 의 검증·비교 로직에 그대로 태우기 위한 얇은 어댑터.
// payload 자체엔 이름·좌석이 없다(학생은 submission.student_id FK 로 이미 확정돼 있음) — 표시용으로
// 이미 알고 있는 학생 이름·좌석을 채워 넣어 validateStudent() 를 그대로 통과시킨다.
// 순수 함수만 — DOM·DB 의존 없음(관리자 화면의 클라이언트 컴포넌트에서도 그대로 import 해서 쓴다).
import { validateStudent, type StudentResult } from "./schedule-import";
import { asJsonObject } from "./jsonb";

/** submission.payload(unknown, jsonb) → schedule-import.ts 검증기 입력 모양으로 감싼다.
 *  payload 형식 자체가 틀렸으면(객체가 아님 등) 그 자리에서 실패로 반환 — 호출부는 이 결과 하나로
 *  그 제출 건만 오류 처리하면 되고, 나머지 제출 건에는 영향이 없다. */
export function adaptSubmissionPayload(
  payload: unknown,
  displayName: string,
  seat: number | null,
  index: number,
): StudentResult {
  // 운영(postgres.js + fetch_types:false)은 jsonb 를 문자열로 돌려준다 — asJsonObject 가 그 차이를 흡수한다.
  const p = asJsonObject(payload);
  if (p === null) {
    return { ok: false, index, name: displayName || null, error: "제출 내용 형식이 올바르지 않습니다" };
  }
  return validateStudent(
    { name: displayName, seat, hours: p.hours, restDays: p.restDays, academies: p.academies },
    index,
  );
}
