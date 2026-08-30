// 비형식 스케줄 파일(엑셀 등)을 정제한 "표준 JSON" 스펙 + 검증.
// 목표: 어떤 소스(엑셀·수기 입력 등)든 이 JSON 형태로만 정제하면 src/app/m/schedule/import/** 화면에서
// 미리보기·부분 적용할 수 있다. 기존 schedule_hours/schedule_rule 스키마와 SCHEDULE_VERSION 은 건드리지
// 않는다(그 값들로 매핑만 한다) — src/app/m/schedule/import/actions.ts 가 이 타입을 DB 행으로 옮긴다.
// 순수 함수만 — DOM·DB 의존 없음(브라우저에서 업로드 즉시 파싱·검증하기 위해).
//
// 검증 실패는 파일 전체를 거부하지 않는다: 학생 배열을 순회하며 학생별로 성공/실패를 따로 기록한다
// (부분 적용이 목적 — 한 학생의 오타 때문에 나머지 전원을 못 올리면 안 된다).

export type ImportHours = { day: number; arrive: number; leave: number };
export type ImportAcademy = { name: string; days: number[]; start: number; end: number };

/** 원본(느슨한) 학생 항목 모양 — JSON.parse 직후의 unknown 을 이 모양으로 가정하고 검증한다. */
export type ImportStudentInput = {
  name?: unknown;
  seat?: unknown;
  hours?: unknown;
  restDays?: unknown;
  academies?: unknown;
  warnings?: unknown;
};

export type ImportFileInput = {
  version?: unknown;
  label?: unknown;
  students?: unknown;
};

/** 검증을 통과한 학생 한 명 — 화면·서버액션이 그대로 쓰는 정규화된 모양. */
export type ValidStudent = {
  name: string;
  seat: number | null;
  hours: ImportHours[];
  restDays: number[];
  academies: ImportAcademy[];
  warnings: string[];
};

/** 학생별 검증 결과 — 실패해도 파일 전체를 버리지 않고 이 배열의 한 항목으로만 남는다. */
export type StudentResult =
  | { ok: true; index: number; student: ValidStudent }
  | { ok: false; index: number; name: string | null; error: string };

export type ParsedImportFile = {
  version: number;
  label: string | null;
  results: StudentResult[];
};

export type ParseFileResult = { ok: true; file: ParsedImportFile } | { ok: false; error: string };

const MAX_STUDENTS = 500;
const MAX_HOURS_PER_STUDENT = 7;
const MAX_ACADEMIES_PER_STUDENT = 30;
// 분 값 상한/하한 — 제출 폼(f/actions.ts validateSchedulePayload)·이 파일(validHours/validAcademies)·
// 학생 위저드(f/[slug]/forms/sch9m2vt.tsx)가 전부 이 두 값을 "단일 출처"로 가져다 쓴다(과거엔 세 곳에
// 리터럴 1560 이 따로 박혀 있어서 위저드가 서버보다 넓은 범위를 허용 — 학생이 3단계 검토 화면까지
// 문제없이 진행한 뒤 제출에서만 "하원 시간이 올바르지 않습니다"로 막히는 원인이었다). MAX=1560(=26:00,
// 자정 넘김 최대 새벽 2시)까지만 자정 넘김 하원/종료를 허용한다.
export const SCHEDULE_MIN_MIN = 0;
export const SCHEDULE_MAX_MIN = 1560;
const MIN_MIN = SCHEDULE_MIN_MIN;
const MAX_MIN = SCHEDULE_MAX_MIN;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function validHours(raw: unknown): { ok: true; value: ImportHours[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "hours 는 배열이어야 합니다" };
  if (raw.length > MAX_HOURS_PER_STUDENT) return { ok: false, error: `hours 는 최대 ${MAX_HOURS_PER_STUDENT}개까지입니다` };
  const seenDays = new Set<number>();
  const out: ImportHours[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) return { ok: false, error: "hours 항목 형식이 올바르지 않습니다" };
    const day = Number(item.day);
    const arrive = Number(item.arrive);
    const leave = Number(item.leave);
    if (!Number.isInteger(day) || day < 1 || day > 7) return { ok: false, error: `hours.day 값이 올바르지 않습니다(1~7): ${String(item.day)}` };
    if (!Number.isInteger(arrive) || arrive < MIN_MIN || arrive > MAX_MIN) return { ok: false, error: `hours.arrive 값이 올바르지 않습니다: ${String(item.arrive)}` };
    if (!Number.isInteger(leave) || leave < MIN_MIN || leave > MAX_MIN) return { ok: false, error: `hours.leave 값이 올바르지 않습니다: ${String(item.leave)}` };
    if (leave <= arrive) return { ok: false, error: `${day}요일 등원(${arrive})이 하원(${leave})보다 늦거나 같습니다` };
    if (seenDays.has(day)) return { ok: false, error: `hours 에 ${day}요일이 중복됩니다` };
    seenDays.add(day);
    out.push({ day, arrive, leave });
  }
  return { ok: true, value: out };
}

function validRestDays(raw: unknown): { ok: true; value: number[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "restDays 는 배열이어야 합니다" };
  const out: number[] = [];
  for (const item of raw) {
    const day = Number(item);
    if (!Number.isInteger(day) || day < 1 || day > 7) return { ok: false, error: `restDays 값이 올바르지 않습니다(1~7): ${String(item)}` };
    out.push(day);
  }
  return { ok: true, value: [...new Set(out)] };
}

function validAcademies(raw: unknown): { ok: true; value: ImportAcademy[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "academies 는 배열이어야 합니다" };
  if (raw.length > MAX_ACADEMIES_PER_STUDENT) return { ok: false, error: `academies 는 최대 ${MAX_ACADEMIES_PER_STUDENT}개까지입니다` };
  const out: ImportAcademy[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) return { ok: false, error: "academies 항목 형식이 올바르지 않습니다" };
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Array.isArray(item.days) || item.days.length === 0) return { ok: false, error: "academies.days 가 비어 있습니다" };
    const days: number[] = [];
    for (const d of item.days) {
      const day = Number(d);
      if (!Number.isInteger(day) || day < 1 || day > 7) return { ok: false, error: `academies.days 값이 올바르지 않습니다(1~7): ${String(d)}` };
      days.push(day);
    }
    if (!Number.isInteger(start) || start < MIN_MIN || start > MAX_MIN) return { ok: false, error: `academies.start 값이 올바르지 않습니다: ${String(item.start)}` };
    if (!Number.isInteger(end) || end < MIN_MIN || end > MAX_MIN) return { ok: false, error: `academies.end 값이 올바르지 않습니다: ${String(item.end)}` };
    if (end <= start) return { ok: false, error: `academies 시간이 올바르지 않습니다(start<end): ${start}~${end}` };
    out.push({ name: name || "외부 학원", days: [...new Set(days)], start, end });
  }
  return { ok: true, value: out };
}

/** 학생 한 명을 검증·정규화. 실패해도 예외를 던지지 않고 결과로 돌려준다(호출부가 이어서 다음 학생을 처리). */
export function validateStudent(raw: unknown, index: number): StudentResult {
  if (!isPlainObject(raw)) return { ok: false, index, name: null, error: "학생 항목 형식이 올바르지 않습니다" };
  const nameRaw = raw.name;
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name) return { ok: false, index, name: null, error: "이름이 없습니다" };

  let seat: number | null = null;
  if (raw.seat !== undefined && raw.seat !== null) {
    const n = Number(raw.seat);
    if (!Number.isInteger(n)) return { ok: false, index, name, error: "seat 값이 올바르지 않습니다" };
    seat = n;
  }

  const hoursR = validHours(raw.hours);
  if (hoursR.ok === false) return { ok: false, index, name, error: hoursR.error };
  const restR = validRestDays(raw.restDays);
  if (restR.ok === false) return { ok: false, index, name, error: restR.error };
  const acadR = validAcademies(raw.academies);
  if (acadR.ok === false) return { ok: false, index, name, error: acadR.error };

  const hoursDays = new Set(hoursR.value.map((h) => h.day));
  const overlap = restR.value.filter((d) => hoursDays.has(d));
  if (overlap.length > 0) return { ok: false, index, name, error: `hours 와 restDays 가 겹칩니다: ${overlap.join(",")}요일` };

  let warnings: string[] = [];
  if (raw.warnings !== undefined) {
    if (!Array.isArray(raw.warnings)) return { ok: false, index, name, error: "warnings 는 배열이어야 합니다" };
    warnings = raw.warnings.map((w) => String(w));
  }

  return {
    ok: true,
    index,
    student: { name, seat, hours: hoursR.value, restDays: restR.value, academies: acadR.value, warnings },
  };
}

/** 파일 전체 파싱 — 파일 레벨(형식 자체가 틀림)만 거부하고, 학생별 오류는 results 안에 개별로 담는다. */
export function parseScheduleImportFile(raw: unknown): ParseFileResult {
  if (!isPlainObject(raw)) return { ok: false, error: "JSON 형식이 올바르지 않습니다" };
  const version = Number(raw.version);
  if (version !== 1) return { ok: false, error: `지원하지 않는 version 입니다: ${String(raw.version)} (1만 지원)` };
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null;
  if (!Array.isArray(raw.students)) return { ok: false, error: "students 가 배열이 아닙니다" };
  if (raw.students.length === 0) return { ok: false, error: "students 가 비어 있습니다" };
  if (raw.students.length > MAX_STUDENTS) return { ok: false, error: `students 는 최대 ${MAX_STUDENTS}명까지입니다` };

  const results = raw.students.map((s, i) => validateStudent(s, i));
  return { ok: true, file: { version, label, results } };
}

/** JSON 텍스트(파일 업로드·붙여넣기 공용 입력)를 파싱 → 검증까지 한 번에. */
export function parseScheduleImportText(text: string): ParseFileResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "JSON 파싱에 실패했습니다(문법 오류)" };
  }
  return parseScheduleImportFile(raw);
}

// ---------------- schedule_rule(kind='academy') 매핑 + 미리보기 비교 ----------------
// academies[].name 은 사람이 알아보는 학원 이름(선택) — schedule_rule 에는 그런 필드가 따로 없어
// title 에 옮겨 담는다(비어있거나 파서가 채운 기본값 "외부 학원"이면 title 은 그냥 빈 문자열로 둔다 —
// reason 자체가 이미 "외부 학원"이라 중복 표시하지 않기 위해). kind 는 늘 'academy'.
export type DbAcademy = { reason: string; title: string; days: number[]; start: number; end: number };

const GENERIC_ACADEMY_NAME = "외부 학원";

export function academyToDbFields(item: ImportAcademy): DbAcademy {
  const name = item.name?.trim();
  const title = name && name !== GENERIC_ACADEMY_NAME ? name : "";
  return { reason: GENERIC_ACADEMY_NAME, title, days: [...new Set(item.days)].sort((a, b) => a - b), start: item.start, end: item.end };
}

const hourKey = (day: number, arrive: number, leave: number) => `${day}:${arrive}:${leave}`;
const acadKey = (a: { reason: string; title: string; days: number[]; start: number; end: number }) =>
  `${a.reason}|${a.title}|${[...a.days].sort((x, y) => x - y).join(",")}|${a.start}|${a.end}`;

/** 두 hours 집합이 같은지(순서 무관) — 미리보기 "변경 없음" 판정용. */
export function hoursSetEqual(a: ImportHours[], b: ImportHours[]): boolean {
  if (a.length !== b.length) return false;
  const ak = new Set(a.map((h) => hourKey(h.day, h.arrive, h.leave)));
  for (const h of b) if (!ak.has(hourKey(h.day, h.arrive, h.leave))) return false;
  return true;
}

/** 두 academy(schedule_rule kind='academy') 집합이 같은지(순서 무관). */
export function academySetEqual(a: DbAcademy[], b: DbAcademy[]): boolean {
  if (a.length !== b.length) return false;
  const ak = new Set(a.map(acadKey));
  for (const item of b) if (!ak.has(acadKey(item))) return false;
  return true;
}

export type DiffStatus = "same" | "new" | "changed";
export type Diff = { status: DiffStatus; detail: string };

/** 새 학생 데이터 vs 그 학생의 기존 schedule_hours/schedule_rule(kind='academy') 비교. */
export function diffAgainstExisting(
  newHours: ImportHours[],
  newAcademies: DbAcademy[],
  existingHours: ImportHours[],
  existingAcademies: DbAcademy[],
): Diff {
  const hoursSame = hoursSetEqual(newHours, existingHours);
  const acadSame = academySetEqual(newAcademies, existingAcademies);
  if (hoursSame && acadSame) return { status: "same", detail: "변경 없음" };
  if (existingHours.length === 0 && existingAcademies.length === 0) return { status: "new", detail: "새로 등록" };
  const parts: string[] = [];
  if (!hoursSame) parts.push("등하원 변경");
  if (!acadSame) parts.push("학원 변경");
  return { status: "changed", detail: parts.join(", ") || "변경" };
}
