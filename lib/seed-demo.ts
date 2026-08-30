// 최소 데모 시드 — bootstrap.ts(코어 스키마 + 권한/모듈 카탈로그 + 마스터 계정)와 별개로,
// 좌석·학생 화면이 빈 화면이 아니라 실제로 채워진 상태로 보이도록 표본 데이터를 넣는다.
// 함수를 분리해두는 이유: 다음 단계에서 시드 규모를 크게 늘릴 때 이 파일만 갈아끼우면 되게.
import { db } from "./db";
import { todayKey, addDays, weekStartKey, weekdayOf } from "./date";
import { PATROL_STATES } from "./patrol";
import { PENALTY_REASONS } from "./penalty";

const LEVELS = ["middle", "high", "adult"] as const;
const GRADES: Record<(typeof LEVELS)[number], string[]> = {
  middle: ["중1", "중2", "중3"],
  high: ["고1", "고2", "고3"],
  adult: ["N수"],
};
const SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임"];
const GIVEN = ["민준", "서연", "지호", "하은", "도윤", "지우", "예준", "수아", "시우", "채원", "은우", "다은"];

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length];
}

async function alreadySeeded(): Promise<boolean> {
  const r = await db.query<{ value: string }>(`select value from app_meta where key='demo_seeded'`);
  return r.rows[0]?.value === "1";
}

/** 지점 1개(bootstrap이 만든 본점) 위에 방 4개·좌석 60개·학생 48명(전원 배정)·오늘 출결 일부를 얹는다.
 *  멱등 — app_meta.demo_seeded 플래그로 한 번만 실행. */
export async function seedDemo(): Promise<void> {
  if (await alreadySeeded()) return;

  const hq = await db.query<{ id: string }>(`select id from branch where code='HQ' limit 1`);
  const branchId = hq.rows[0]?.id;
  if (!branchId) return; // bootstrap 이 먼저 돌아야 한다(호출부가 순서를 보장)

  // 이미 방/학생이 있으면(재실행 등) 건드리지 않고 플래그만 세운다.
  const existing = await db.query<{ n: string }>(`select count(*)::text as n from room where branch_id=$1`, [branchId]);
  if (Number(existing.rows[0]?.n ?? 0) > 0) {
    await db.query(
      `insert into app_meta(key,value) values ('demo_seeded','1')
       on conflict (key) do update set value=excluded.value, updated_at=now()`,
    );
    return;
  }

  // ── 방 4개 ──────────────────────────────────────────────
  const ROOM_DEFS = [
    { name: "1열람실", floor: 4, cols: 8, rows: 6 },
    { name: "2열람실", floor: 4, cols: 8, rows: 6 },
    { name: "집중실", floor: 5, cols: 6, rows: 4 },
    { name: "그룹스터디실", floor: 5, cols: 6, rows: 4 },
  ];
  const roomIds: string[] = [];
  for (const r of ROOM_DEFS) {
    const ins = await db.query<{ id: string }>(
      `insert into room(branch_id, name, floor, cols, rows) values ($1,$2,$3,$4,$5) returning id`,
      [branchId, r.name, r.floor, r.cols, r.rows],
    );
    roomIds.push(ins.rows[0].id);
  }

  // ── 학생 48명 ───────────────────────────────────────────
  const studentIds: string[] = [];
  for (let i = 0; i < 48; i++) {
    const level = pick(LEVELS, i);
    const grade = level === "adult" ? null : pick(GRADES[level], i);
    const name = `${pick(SURNAMES, i)}${pick(GIVEN, i * 7)}`;
    const ins = await db.query<{ id: string }>(
      `insert into student(branch_id, name, level, grade, is_repeat, school, guardian_phone, student_phone, status, enrolled_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'enrolled', now()::date) returning id`,
      [
        branchId,
        name,
        level,
        grade,
        level === "adult" && i % 5 === 0,
        level === "adult" ? null : `${pick(GIVEN, i)}${level === "middle" ? "중" : "고"}등학교`,
        `010-${String(2000 + i).padStart(4, "0")}-${String(1000 + i).padStart(4, "0")}`,
        `010-${String(3000 + i).padStart(4, "0")}-${String(1000 + i).padStart(4, "0")}`,
      ],
    );
    studentIds.push(ins.rows[0].id);
  }

  // ── 좌석 60개(방마다 그리드 채우기) + 48명 배정 ────────────
  const GAP_X = 100, GAP_Y = 80, ORIGIN_X = 40, ORIGIN_Y = 40, PER_ROW = 6;
  const seatIds: string[] = [];
  const perRoom = [20, 20, 10, 10]; // 합계 60
  let studentCursor = 0;
  for (let r = 0; r < ROOM_DEFS.length; r++) {
    for (let i = 0; i < perRoom[r]; i++) {
      const col = i % PER_ROW, row = Math.floor(i / PER_ROW);
      const assign = studentCursor < studentIds.length && Math.random() < 0.8; // 대략 80% 착석
      const sid = assign ? studentIds[studentCursor++] : null;
      const ins = await db.query<{ id: string }>(
        `insert into seat(branch_id, room_id, grid_x, grid_y, number, label, status, facing, current_student_id, assigned_at)
         values ($1,$2,$3,$4,$5,$6,$7,'down',$8,$9) returning id`,
        [
          branchId, roomIds[r], ORIGIN_X + col * GAP_X, ORIGIN_Y + row * GAP_Y, i + 1, String(i + 1),
          sid ? "occupied" : "empty", sid, sid ? new Date().toISOString() : null,
        ],
      );
      seatIds.push(ins.rows[0].id);
    }
  }

  // ── 오늘 출결 일부 — 착석 배정된 학생은 오늘 입실 기록을 남긴다(좌석맵 재실 판정용) ──
  // date 컬럼은 앱 전체가 쓰는 KST 기준 todayKey() 로 맞춘다 — UTC toISOString() 은 자정 근처
  // (KST 00~09시)에 하루 전 날짜로 어긋나 좌석맵·휴대폰 보관함의 "오늘" 판정이 깨진다.
  const todayStr = todayKey();
  for (let i = 0; i < studentCursor; i++) {
    const hoursAgo = 0.5 + Math.random() * 3;
    const at = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
    await db.query(
      `insert into attendance_event(branch_id, student_id, kind, auto, at, date) values ($1,$2,'in',false,$3,$4)`,
      [branchId, studentIds[i], at, todayStr],
    );
  }
  // 미배정 학생 몇 명은 이미 등원 후 하원 처리된 것으로(입/퇴실 쌍) — 출결 화면이 비지 않도록.
  for (let i = studentCursor; i < Math.min(studentCursor + 6, studentIds.length); i++) {
    const inAt = new Date(Date.now() - 5 * 3600_000).toISOString();
    const outAt = new Date(Date.now() - 1 * 3600_000).toISOString();
    await db.query(
      `insert into attendance_event(branch_id, student_id, kind, auto, at, date) values ($1,$2,'in',false,$3,$4)`,
      [branchId, studentIds[i], inAt, todayStr],
    );
    await db.query(
      `insert into attendance_event(branch_id, student_id, kind, auto, at, date) values ($1,$2,'out',false,$3,$4)`,
      [branchId, studentIds[i], outAt, todayStr],
    );
  }

  await db.query(
    `insert into app_meta(key,value) values ('demo_seeded','1')
     on conflict (key) do update set value=excluded.value, updated_at=now()`,
  );
}

// ════════════════════════════════════════════════════════════════════════
// 2단계 시드 확장 — 순찰·벌점·스케쥴·도시락·접수함 등 나머지 모듈이 빈 화면이 아니라 몇 주치
// 실사용 흔적이 쌓인 것처럼 보이도록 데이터를 왕창 채운다. seedDemo() 와 별도 플래그
// (demo_seeded_v2)로 게이트 — 이미 seedDemo() 가 끝난 브라우저(demo_seeded='1')에 대해서도
// 이 확장만 추가로 한 번 더 돌 수 있게 분리했다. 고정 시드 PRNG로 결정적(매 실행 동일 결과).
// 날짜는 전부 실행 시점(todayKey()) 기준 상대 계산 — 언제 시드해도 "최근 몇 주"가 항상 맞다.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rand(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function bulkInsert(table: string, columns: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const valuesSql = rows
    .map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`)
    .join(",");
  await db.query(`insert into ${table}(${columns.join(",")}) values ${valuesSql}`, params);
}

async function alreadySeededV2(): Promise<boolean> {
  const r = await db.query<{ value: string }>(`select value from app_meta where key='demo_seeded_v2'`);
  return r.rows[0]?.value === "1";
}

/** 지난 4주 출결·순찰 6세션·이번주+지난주 벌점·학생 30명 스케쥴·도시락 이번달+다음달·접수함 10여건.
 *  전부 고정 시드 PRNG로 결정적. app_meta.demo_seeded_v2 로 게이트(멱등 — 한 번만 실행). */
export async function seedDemoExpansion(): Promise<void> {
  if (await alreadySeededV2()) return;

  const hq = await db.query<{ id: string }>(`select id from branch where code='HQ' limit 1`);
  const branchId = hq.rows[0]?.id;
  if (!branchId) return;

  const studentsR = await db.query<{ id: string; name: string }>(
    `select id, name from student where branch_id=$1 order by name`,
    [branchId],
  );
  const students = studentsR.rows;
  if (students.length === 0) return; // seedDemo() 가 먼저 돌아야 한다

  // 시드 도중 페이지 이탈로 반쯤 심긴 채 플래그가 안 찍힌 경우, 재실행 시 unique 충돌로
  // 부팅이 죽는다(예: schedule_hours(student_id,day)). 이 확장이 채우는 테이블은 확장 완료
  // 전까지 사용자 데이터가 있을 수 없으므로, 비우고 처음부터 다시 심는 게 안전하다.
  // attendance_event 는 오늘분(seedDemo 몫)만 남기고 과거분(이 확장 몫)만 지운다.
  for (const t of [
    "patrol_event", "patrol_session", "penalty_event",
    "schedule_hours", "schedule_rule",
    "lunch_meal", "lunch_order", "lunch_closure", "lunch_month",
    "submission",
  ]) {
    await db.query(`delete from ${t}`);
  }
  await db.query(`delete from attendance_event where date < $1`, [todayKey()]);

  const seatR = await db.query<{ current_student_id: string; id: string }>(
    `select current_student_id, id from seat where branch_id=$1 and current_student_id is not null`,
    [branchId],
  );
  const seatOfStudent = new Map(seatR.rows.map((r) => [r.current_student_id, r.id]));

  const personR = await db.query<{ id: string }>(`select id from person where login_id='나한결' limit 1`);
  const staffId = personR.rows[0]?.id ?? null;

  const rand = mulberry32(20260831); // 고정 시드 — 오늘 날짜 상수(실행 시점과 무관하게 항상 같은 배치)
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const chance = (p: number) => rand() < p;
  const shuffledStudents = () => [...students].sort(() => rand() - 0.5);

  const today = todayKey();

  // ── ① 지난 4주 출결(평일 위주, 현실적 시간 분포) ──────────────────────────
  // 최근 20영업일(오늘 제외, 오늘분은 seedDemo() 가 이미 채움) — 주말은 건너뛴다.
  {
    const attDates: string[] = [];
    for (let back = 1; attDates.length < 20 && back < 45; back++) {
      const d = addDays(today, -back);
      const dow = weekdayOf(d);
      if (dow !== 0 && dow !== 6) attDates.push(d);
    }
    for (const date of attDates) {
      const rows: unknown[][] = [];
      for (const st of students) {
        if (!chance(0.78)) continue; // 결석·통원 등으로 그날 출결 없는 학생
        const arriveMin = 14 * 60 + Math.floor(rand() * 6 * 60); // 14:00~20:00
        const stayMin = 120 + Math.floor(rand() * 240); // 2~6시간
        const inAt = `${date}T${pad2(Math.floor(arriveMin / 60))}:${pad2(arriveMin % 60)}:00+09:00`;
        const leaveMin = Math.min(arriveMin + stayMin, 23 * 60 + 30);
        const outAt = `${date}T${pad2(Math.floor(leaveMin / 60))}:${pad2(leaveMin % 60)}:00+09:00`;
        rows.push([branchId, st.id, "in", false, inAt, date, staffId]);
        rows.push([branchId, st.id, "out", false, outAt, date, staffId]);
      }
      await bulkInsert("attendance_event", ["branch_id", "student_id", "kind", "auto", "at", "date", "created_by"], rows);
    }
  }

  // ── ② 순찰 세션 6개(각 15~25마킹, 상태 다양) ──────────────────────────────
  {
    const sessionDates = [1, 3, 5, 8, 10, 13].map((back) => addDays(today, -back));
    // 상태 가중치 — 입석이 압도적으로 흔하고 나머지는 드물게.
    const weighted: string[] = [];
    for (const st of PATROL_STATES) {
      const w = st.key === "seated" ? 50 : st.key === "sleep" || st.key === "distract" ? 8 : st.key === "late" || st.key === "away" ? 7 : 6;
      for (let i = 0; i < w; i++) weighted.push(st.key);
    }
    for (const date of sessionDates) {
      const sessionId = crypto.randomUUID();
      const startMin = 15 * 60 + Math.floor(rand() * 6 * 60); // 15:00~21:00
      const startAt = `${date}T${pad2(Math.floor(startMin / 60))}:${pad2(startMin % 60)}:00+09:00`;
      const durMin = 10 + Math.floor(rand() * 20);
      const endAt = `${date}T${pad2(Math.floor((startMin + durMin) / 60) % 24)}:${pad2((startMin + durMin) % 60)}:00+09:00`;
      await db.query(
        `insert into patrol_session(id, branch_id, started_at, ended_at, date, created_by) values ($1,$2,$3,$4,$5,$6)`,
        [sessionId, branchId, startAt, endAt, date, staffId],
      );
      const markCount = 15 + Math.floor(rand() * 11); // 15~25
      const marked = shuffledStudents().slice(0, markCount);
      const rows: unknown[][] = [];
      for (const st of marked) {
        const stateKey = pick(weighted);
        const points = PATROL_STATES.find((s) => s.key === stateKey)?.points ?? 0;
        const atMin = startMin + Math.floor(rand() * Math.max(1, durMin));
        const at = `${date}T${pad2(Math.floor(atMin / 60) % 24)}:${pad2(atMin % 60)}:00+09:00`;
        rows.push([branchId, st.id, stateKey, points, sessionId, seatOfStudent.get(st.id) ?? null, date, staffId, at]);
      }
      await bulkInsert(
        "patrol_event",
        ["branch_id", "student_id", "state", "points", "session_id", "seat_id", "date", "created_by", "at"],
        rows,
      );
    }
  }

  // ── ③ 이번 주 + 지난주 벌점(순찰 유래는 위에서 이미 생김 — 여기는 수동 부여만, 학생 25명 분포) ──
  {
    const thisWs = weekStartKey(new Date(`${today}T12:00:00Z`));
    const lastWs = addDays(thisWs, -7);
    // 이번 주 최대 오프셋(오늘까지만) — 월요일부터 오늘까지 며칠째인지.
    const thisWeekMaxOffset = (() => {
      let n = 0;
      while (addDays(thisWs, n) < today) n++;
      return n;
    })();
    const penaltyStudents = shuffledStudents().slice(0, 25);
    const weekRanges: [string, number][] = [
      [thisWs, thisWeekMaxOffset], // 이번 주는 오늘까지만
      [lastWs, 6], // 지난주는 월~일 전체
    ];
    const rows: unknown[][] = [];
    for (const st of penaltyStudents) {
      const eventsForStudent = 1 + Math.floor(rand() * 3); // 1~3건
      for (let i = 0; i < eventsForStudent; i++) {
        const [rs, maxOffset] = pick(weekRanges);
        const date = addDays(rs, Math.floor(rand() * (maxOffset + 1)));
        if (date > today) continue; // 미래 날짜 방지
        const reason = pick(PENALTY_REASONS);
        const hour = 15 + Math.floor(rand() * 7);
        const min = Math.floor(rand() * 60);
        const at = `${date}T${pad2(hour)}:${pad2(min)}:00+09:00`;
        rows.push([branchId, st.id, reason.key, reason.points, null, date, staffId, at]);
      }
    }
    await bulkInsert("penalty_event", ["branch_id", "student_id", "reason", "points", "note", "date", "created_by", "at"], rows);
  }

  // ── ④ 운영 시간표(교시) 5개 — 스케쥴러 배경 음영용 ─────────────────────────
  {
    const periods = [
      ["1교시", 9 * 60, 10 * 60 + 50],
      ["2교시", 11 * 60, 12 * 60 + 50],
      ["3교시", 14 * 60, 15 * 60 + 50],
      ["4교시", 16 * 60, 17 * 60 + 50],
      ["5교시", 19 * 60, 21 * 60 + 30],
    ];
    await bulkInsert(
      "schedule_period",
      ["branch_id", "label", "start_min", "end_min", "ord"],
      periods.map((p, i) => [branchId, p[0], p[1], p[2], i]),
    );
  }

  // ── ⑤ 학생 스케쥴 30명분(주간 등하원 + 일부 외부학원/상담 정기 일정) ─────────
  {
    const scheduleStudents = shuffledStudents().slice(0, 30);
    const hoursRows: unknown[][] = [];
    const ruleRows: unknown[][] = [];
    for (const st of scheduleStudents) {
      const days = [1, 2, 3, 4, 5, 6].filter(() => chance(0.82)); // 요일마다 82% 확률로 등원
      const arrive = 15 * 60 + Math.floor(rand() * 4) * 30; // 15:00~16:30, 30분 단위
      const leave = 21 * 60 + Math.floor(rand() * 5) * 30; // 21:00~23:00
      for (const day of days.length ? days : [1, 3, 5]) {
        // 학생별로 요일마다 등하원 시각을 살짝 흔들어(± 30분) 획일적으로 보이지 않게.
        const jitter = (Math.floor(rand() * 3) - 1) * 30;
        hoursRows.push([branchId, st.id, day, Math.max(0, arrive + jitter), Math.min(1560, leave + jitter)]);
      }
      if (chance(0.35)) {
        const day = pick(days.length ? days : [2, 4]);
        const start = 18 * 60, end = 19 * 60 + 30;
        ruleRows.push([branchId, st.id, "academy_out", "academy", pick(["수학학원", "영어학원", "과학학원", "논술학원"]), start, end, String(day)]);
      } else if (chance(0.15)) {
        ruleRows.push([branchId, st.id, "counsel", "counsel", "주간 상담", 20 * 60, 20 * 60 + 30, String(pick(days.length ? days : [3]))]);
      }
    }
    await bulkInsert("schedule_hours", ["branch_id", "student_id", "day", "arrive_min", "leave_min"], hoursRows);
    await bulkInsert("schedule_rule", ["branch_id", "student_id", "reason", "kind", "title", "start_min", "end_min", "days"], ruleRows);
  }

  // ── ⑥ 도시락 이번 달 + 다음 달(월 설정·휴무·주문 20명·중/석식 선택) ─────────
  {
    const [ty, tm] = today.split("-").map(Number);
    const months = [{ y: ty, m: tm }, tm === 12 ? { y: ty + 1, m: 1 } : { y: ty, m: tm + 1 }];
    for (const { y, m } of months) {
      const monthR = await db.query<{ id: string }>(
        `insert into lunch_month(branch_id, year, month, lunch_label, lunch_price, dinner_label, dinner_price, notice)
         values ($1,$2,$3,'중식',6000,'석식',7000,$4)
         on conflict (branch_id, year, month) do update set lunch_label=excluded.lunch_label
         returning id`,
        [branchId, y, m, "도시락은 완전 신청제로 운영되며 당일 신청은 불가합니다.\n결제는 선불입니다."],
      );
      const monthId = monthR.rows[0].id;

      // 이 달 평일 날짜 목록(최대 10개) — 주문·발주 계산의 소스.
      const dim = new Date(y, m, 0).getDate();
      const weekdays: string[] = [];
      for (let d = 1; d <= dim && weekdays.length < 10; d++) {
        const iso = `${y}-${pad2(m)}-${pad2(d)}`;
        const dow = weekdayOf(iso);
        if (dow !== 0) weekdays.push(iso); // 토요일은 석식만 휴무지만 신청 자체는 가능
      }
      if (weekdays.length === 0) continue;

      // 특정 하루 임시 휴무(행사 등) — 자동(주말·공휴일) 외에 수동 오버라이드 예시로 하나.
      const eventDay = weekdays[Math.min(3, weekdays.length - 1)];
      await db.query(
        `insert into lunch_closure(month_id, date, lunch_closed, dinner_closed, label)
         values ($1,$2,true,true,'행사로 인한 휴무')
         on conflict (month_id, date) do nothing`,
        [monthId, eventDay],
      );

      const orderStudents = shuffledStudents().slice(0, 20);
      const mealRows: unknown[][] = [];
      for (const st of orderStudents) {
        const paid = chance(0.6);
        const wantsLunch = chance(0.7);
        const wantsDinner = chance(0.5);
        const days = weekdays.filter((d) => d !== eventDay && chance(0.6));
        const lunchCnt = wantsLunch ? days.length : 0;
        const dinnerCnt = wantsDinner ? days.length : 0;
        if (lunchCnt === 0 && dinnerCnt === 0) continue;
        const due = lunchCnt * 6000 + dinnerCnt * 7000;
        const orderR = await db.query<{ id: string }>(
          `insert into lunch_order(branch_id, month_id, student_id, paid, paid_amount, paid_date, memo)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (month_id, student_id) do update set paid=excluded.paid
           returning id`,
          [branchId, monthId, st.id, paid, paid ? due : 0, paid ? today : null, paid ? pick(["카드", "현금", null]) : null],
        );
        const orderId = orderR.rows[0].id;
        for (const d of days) {
          if (wantsLunch) mealRows.push([orderId, d, "lunch"]);
          if (wantsDinner) mealRows.push([orderId, d, "dinner"]);
        }
      }
      await bulkInsert("lunch_meal", ["order_id", "date", "meal_type"], mealRows);
    }
  }

  // ── ⑦ 접수함 submission 10여 건(타입 섞어서) ────────────────────────────
  {
    const subStudents = shuffledStudents().slice(0, 8);
    const rows: unknown[][] = [];
    const mk = (
      type: string,
      studentId: string | null,
      submitterName: string | null,
      submitterPhone: string | null,
      payload: Record<string, unknown>,
      status: "pending" | "done" | "rejected",
      daysAgo: number,
    ) => {
      const at = `${addDays(today, -daysAgo)}T${pad2(10 + Math.floor(rand() * 9))}:${pad2(Math.floor(rand() * 60))}:00+09:00`;
      rows.push([branchId, type, studentId, submitterName, submitterPhone, JSON.stringify(payload), status, at, at]);
    };

    mk("schedule", subStudents[0].id, null, null, { hours: [{ day: 1, arrive: 900, leave: 1320 }, { day: 3, arrive: 900, leave: 1320 }], restDays: [7], academies: [] }, "done", 12);
    mk("schedule", subStudents[1].id, null, null, { hours: [{ day: 2, arrive: 930, leave: 1350 }], restDays: [6, 7], academies: [{ name: "영어학원", days: [4], start: 1080, end: 1170 }] }, "pending", 1);
    mk("schedule", subStudents[2].id, null, null, { hours: [], restDays: [1, 2, 3, 4, 5], academies: [] }, "rejected", 6);
    mk("lunch", subStudents[3].id, null, null, { "이름": subStudents[3].name, "중식": true, "석식": false, "특이사항": "" }, "done", 20);
    mk("lunch", subStudents[4].id, null, null, { "이름": subStudents[4].name, "중식": true, "석식": true, "특이사항": "알레르기 없음" }, "pending", 2);
    mk("lunch", null, "학부모(김OO)", "010-4455-6677", { "이름": "비회원 문의", "중식": true, "석식": false }, "pending", 0);
    mk("content", subStudents[5].id, null, null, { "제목": "자습실 소음 관련 건의", "내용": "저녁 시간대 3열람실이 다소 소란스럽습니다." }, "pending", 4);
    mk("content", null, "익명 학생", null, { "제목": "정수기 위치 문의", "내용": "5층에도 정수기가 있으면 좋겠습니다." }, "done", 15);
    mk("counsel", subStudents[6].id, null, null, { "상담희망일": addDays(today, 3), "사유": "진로 상담 요청" }, "pending", 3);
    mk("counsel", subStudents[7].id, null, null, { "상담희망일": addDays(today, -2), "사유": "성적 관련 상담" }, "done", 9);
    mk("counsel", null, "학부모(이OO)", "010-1234-5678", { "상담희망일": addDays(today, 5), "사유": "출결 문의" }, "rejected", 7);

    // payload 는 jsonb 컬럼 — bulkInsert(캐스트 없는 범용 헬퍼) 대신 명시적으로 ::jsonb 캐스팅한다
    // (f/actions.ts submitForm 과 동일한 패턴 — 캐스트 없이 문자열을 넘기면 타입 불일치로 실패한다).
    for (const r of rows) {
      await db.query(
        `insert into submission(branch_id, type, student_id, submitter_name, submitter_phone, payload, status, created_at, first_submitted_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        r,
      );
    }
  }

  await db.query(
    `insert into app_meta(key,value) values ('demo_seeded_v2','1')
     on conflict (key) do update set value=excluded.value, updated_at=now()`,
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");
