// 모듈 테이블 스키마 (A 레포 supabase/*.sql 에서 이식). 멱등 — bootstrap 이 CORE_SQL 뒤에 exec.
// PGlite = Postgres 라 A 의 DDL 이 거의 그대로. 단 RLS 는 없음(로컬) → 접근제어는 앱단 can()/guard 로.
// 모듈 하나씩 이식할 때마다 이 파일에 섹션 추가.

export const MODULE_SQL = `
-- ================= 학생 (모든 학습 모듈의 뿌리) =================
create table if not exists student(
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branch(id) on delete cascade,
  name           text not null,
  level          text,                              -- middle | high | adult
  grade          text,                              -- 학년(중1..고3) 또는 null
  school         text,
  is_repeat      boolean not null default false,    -- 성인=N수생
  status         text not null default 'enrolled',  -- enrolled | leave (퇴원 폐지)
  guardian_phone text,
  student_phone  text,
  birthdate      date,
  gender         text,                              -- male | female
  enrolled_at    date,
  created_at     timestamptz not null default now(),
  created_by     uuid references person(id) on delete set null
);
create index if not exists idx_student_branch on student(branch_id);
create index if not exists idx_student_status on student(branch_id, status);
-- 공개 폼(studycube.co.kr) 학생 로그인용 전용 코드(이름+코드). 지점 내 유일.
alter table student add column if not exists access_code text;
create unique index if not exists uq_student_access_code on student(branch_id, access_code) where access_code is not null;

-- ================= 좌석 배치도 (방 도면 + 좌석) =================
create table if not exists room(
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branch(id) on delete cascade,
  floor      int  not null default 4,      -- 층 (예: 4, 5)
  name       text not null,
  pos_x      int  not null default 0,      -- 층 도면에서 방 위치(미사용시 0)
  pos_y      int  not null default 0,
  cols       int  not null default 8,      -- 방 그리드 크기
  rows       int  not null default 6,
  created_at timestamptz not null default now()
);
create index if not exists idx_room_branch on room(branch_id);
alter table room add column if not exists door_side text;  -- 입구(문) 위치: top | bottom | left | right

create table if not exists seat(
  id                 uuid primary key default gen_random_uuid(),
  branch_id          uuid not null references branch(id) on delete cascade,
  room_id            uuid references room(id) on delete set null,
  zone               text,
  label              text not null,
  grid_x             int,                  -- 도면 픽셀 좌표(드래그 배치)
  grid_y             int,
  number             int,                  -- 자동 부여(수정 가능)
  facing             text,                 -- up | down | left | right
  seat_type          text,
  pos_x              int not null default 0,   -- 레거시 좌표(미사용)
  pos_y              int not null default 0,
  status             text not null default 'empty',   -- empty | occupied | maintenance
  current_student_id uuid references student(id) on delete set null,
  assigned_at        timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists idx_seat_branch on seat(branch_id);
create index if not exists idx_seat_room on seat(room_id);

-- ================= 출결 (등하원) — 학생 1명 × 하루 1행 =================
create table if not exists attendance(
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branch(id) on delete cascade,
  student_id   uuid not null references student(id) on delete cascade,
  date         date not null,
  status       text not null default 'present',   -- present | late | absent | left_early
  check_in_at  timestamptz,
  check_out_at timestamptz,
  reason       text,
  created_by   uuid references person(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique(student_id, date)
);
create index if not exists idx_attendance_bd on attendance(branch_id, date);

-- ================= 입·퇴실 이벤트 로그 (불변 기록, 하루 여러 번 가능) =================
create table if not exists attendance_event(
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branch(id) on delete cascade,
  student_id uuid not null references student(id) on delete cascade,
  kind       text not null,                  -- in | out
  auto       boolean not null default false, -- 자동 처리(마감 자동 퇴실 등) 여부
  at         timestamptz not null default now(),
  date       date not null,
  created_by uuid references person(id) on delete set null
);
create index if not exists idx_att_event_sd on attendance_event(student_id, date);
create index if not exists idx_att_event_bd on attendance_event(branch_id, date);
alter table attendance_event add column if not exists note text;

-- ================= 순찰 이벤트 로그 (불변 기록) — 순찰 중 좌석 원탭 상태 =================
-- state = 프리셋 키(seated|away|academy|counsel|sleep|distract). points = 그 상태 벌점(프리셋 스냅샷).
create table if not exists patrol_event(
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branch(id) on delete cascade,
  student_id uuid not null references student(id) on delete cascade,
  state      text not null,
  points     int  not null default 0,
  source     text not null default 'patrol',   -- patrol | manual (수동 벌점 대비)
  note       text,
  at         timestamptz not null default now(),
  date       date not null,
  created_by uuid references person(id) on delete set null
);
create index if not exists idx_patrol_sd on patrol_event(student_id, date);
create index if not exists idx_patrol_bd on patrol_event(branch_id, date);
-- 순찰 세션: 한 번의 순찰(토글 ON~OFF) 안에서는 학생당 상태 1개 → 재탭하면 교체
alter table patrol_event add column if not exists session_id uuid;
-- 기록 당시 좌석 스냅샷 → 이력 재현 시 "그때 그 자리"에 표시(학생이 자리 옮겨도 충실)
alter table patrol_event add column if not exists seat_id uuid;

-- ================= 순찰 세션 (한 번의 순찰 = 시작~종료 시각 기록) =================
-- id 는 클라가 생성해 patrol_event.session_id 와 매칭. "언제 순찰했나" 이력용.
create table if not exists patrol_session(
  id         uuid primary key,
  branch_id  uuid not null references branch(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  date       date not null,
  created_by uuid references person(id) on delete set null
);
create index if not exists idx_patrol_session_bd on patrol_session(branch_id, started_at);

-- ================= 벌점 이벤트 (수동 부여, append-only) =================
-- 순찰 벌점(patrol_event.points)과 합산해 "이번 주 누적" 산출. reason=프리셋 키, points=부여(정정=음수).
create table if not exists penalty_event(
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branch(id) on delete cascade,
  student_id uuid not null references student(id) on delete cascade,
  reason     text not null,
  points     int  not null,
  note       text,
  at         timestamptz not null default now(),
  date       date not null,
  created_by uuid references person(id) on delete set null
);
create index if not exists idx_penalty_sd on penalty_event(student_id, date);
create index if not exists idx_penalty_bd on penalty_event(branch_id, date);

-- ================= 신청·설문 접수 (공개 폼 studycube.co.kr → 여기로 적재) =================
-- 도시락·컨텐츠·상담·스케쥴 등 모든 유형을 한 테이블로. payload=폼 답변(jsonb, 유형별 자유).
-- 관리쪽(studycube.cloud)에서 type 으로 필터해 인사이트·처리.
create table if not exists submission(
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branch(id) on delete cascade,
  type           text not null,                       -- lunch | content | counsel | schedule
  student_id     uuid references student(id) on delete set null,  -- 매칭되면 연결
  submitter_name  text,
  submitter_phone text,
  payload        jsonb not null default '{}',
  status         text not null default 'pending',     -- pending | done | rejected
  note           text,
  created_at     timestamptz not null default now(),
  processed_by   uuid references person(id) on delete set null,
  processed_at   timestamptz
);
create index if not exists idx_submission_btc on submission(branch_id, type, created_at);
create index if not exists idx_submission_student on submission(student_id);
-- 재제출 시 created_at 을 now() 로 덮어써 "마지막 제출"로 쓰기 때문에(actions.ts submitForm), 최초
-- 제출 시각은 따로 보존해야 한다 — 스케쥴 입력 기간(schedule_window/schedule_grant) 판정의
-- "첫 제출 시각으로부터 24시간" 기준이 여기서 나온다(src/lib/schedule-window.ts). insert 시 1회만
-- 채우고 update 에서는 절대 건드리지 않는다.
alter table submission add column if not exists first_submitted_at timestamptz;

-- 공개 폼 본인확인(이름+access_code) 무차별 대입 방어: (지점,이름)별 실패 카운트·잠금.
-- 서버리스라 인메모리 불가 → DB에 둔다. 성공 시 행 삭제, 실패 누적 시 일시 잠금.
create table if not exists access_attempt(
  branch_id    uuid not null references branch(id) on delete cascade,
  name         text not null,
  fails        int  not null default 0,
  first_fail   timestamptz not null default now(),
  locked_until timestamptz,
  primary key(branch_id, name)
);

-- ================= 도시락 (월 단위 선신청제) — 기존 도시락앱 체계 이식 =================
-- 월별 설정(중/석식 라벨·가격·공지) + 휴무일 + 학생 주문(끼니 날짜들) + 선불 결제.
create table if not exists lunch_month(
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branch(id) on delete cascade,
  year         int  not null,
  month        int  not null check (month between 1 and 12),
  lunch_label  text not null default '중식',
  lunch_price  int  not null default 0,
  dinner_label text not null default '석식',
  dinner_price int  not null default 0,
  notice       text,
  created_at   timestamptz not null default now(),
  unique(branch_id, year, month)
);

-- 휴무일: 그날 중/석식 신청 차단(공휴일은 코드 상수로 자동, 이건 수동 지정분).
create table if not exists lunch_closure(
  month_id     uuid not null references lunch_month(id) on delete cascade,
  date         date not null,
  lunch_closed  boolean not null default true,
  dinner_closed boolean not null default true,
  label        text,
  primary key(month_id, date)
);

-- 학생 주문(월×학생 1행) — 선불 결제 추적 포함.
create table if not exists lunch_order(
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branch(id) on delete cascade,
  month_id    uuid not null references lunch_month(id) on delete cascade,
  student_id  uuid not null references student(id) on delete cascade,
  paid        boolean not null default false,
  paid_amount int not null default 0,
  paid_date   date,
  memo        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(month_id, student_id)
);
create index if not exists idx_lunch_order_month on lunch_order(month_id);

-- 주문한 끼니(날짜×중/석식). 발주 집계는 여기서.
create table if not exists lunch_meal(
  order_id   uuid not null references lunch_order(id) on delete cascade,
  date       date not null,
  meal_type  text not null check (meal_type in ('lunch','dinner')),
  primary key(order_id, date, meal_type)
);
create index if not exists idx_lunch_meal_date on lunch_meal(date);

-- ================= 학생 스케쥴러 (원 운영 시간표 + 학생별 정기·예외 일정) =================
-- 원 운영 시간표(교시) — 지점 단위. 학생 화면의 배경 음영 + 자습 일괄생성의 소스.
create table if not exists schedule_period(
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branch(id) on delete cascade,
  label      text not null,
  start_min  int  not null,
  end_min    int  not null,
  ord        int  not null default 0,
  check (start_min >= 0 and end_min > start_min)
);
create index if not exists idx_schedule_period_branch on schedule_period(branch_id);

-- 학생별 정기(매주 반복) 규칙. days=CSV "1,3,5"(1=월..7=일). 자정 넘김은 end_min>=1440(예: 1500=익일 01:00).
create table if not exists schedule_rule(
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branch(id) on delete cascade,
  student_id uuid not null references student(id) on delete cascade,
  reason     text not null,
  kind       text not null check (kind in ('study','academy','counsel','absent')),
  title      text not null default '',
  start_min  int  not null,
  end_min    int  not null,
  days       text not null default '',
  created_at timestamptz not null default now(),
  check (start_min >= 0 and end_min > start_min)
);
create index if not exists idx_schedule_rule_bs on schedule_rule(branch_id, student_id);

-- 예외(1회성). skip_rule_id 가 있으면 그 날만 해당 정기 규칙을 대체.
create table if not exists schedule_exception(
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branch(id) on delete cascade,
  student_id   uuid not null references student(id) on delete cascade,
  reason       text not null,
  kind         text not null check (kind in ('study','academy','counsel','absent')),
  title        text not null default '',
  start_min    int  not null,
  end_min      int  not null,
  date         date not null,
  skip_rule_id uuid references schedule_rule(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (start_min >= 0 and end_min > start_min)
);
create index if not exists idx_schedule_exception_bs on schedule_exception(branch_id, student_id);
create index if not exists idx_schedule_exception_bd on schedule_exception(branch_id, date);

-- 학생×요일 등원/하원 시각(자습 블록 폐지, 등하원만 저장). 자습은 "다른 일정이 없고 등원~하원 사이"로 파생 판정(src/lib/schedule.ts statusAt).
-- 자정 넘김은 leave_min>1440 으로 저장(예: 익일 00:30 = 1470).
create table if not exists schedule_hours(
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branch(id) on delete cascade,
  student_id uuid not null references student(id) on delete cascade,
  day        int  not null check (day between 1 and 7),
  arrive_min int  not null,
  leave_min  int  not null,
  created_at timestamptz not null default now(),
  check (leave_min > arrive_min),
  unique(student_id, day)
);
create index if not exists idx_schedule_hours_bs on schedule_hours(branch_id, student_id);

-- ================= 학생 스케쥴 입력 기간 =================
-- (2026-08-22 폐지) 지점 전체 입력 기간(schedule_window)·기간제 개별 개방은 "한 번도 제출한 적 없으면
-- 언제나 열림 / 제출하는 순간 잠김 / 관리자가 활성화하면 1회용으로 다시 열림"으로 완전히 교체됐다.
-- schedule_window 테이블은 더 이상 코드에서 참조하지 않는다 — 운영 데이터를 보존하려고(되돌릴 여지를
-- 남기려고) drop 하지 않고 테이블만 남겨둔다. 새로 생기는 행도 없다.
create table if not exists schedule_window(
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branch(id) on delete cascade,
  label      text,
  opens_at   timestamptz not null,
  closes_at  timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid references person(id) on delete set null,
  check (closes_at > opens_at)
);
create index if not exists idx_schedule_window_bo on schedule_window(branch_id, opens_at);

-- 관리자가 학생을 골라 1회용으로 여는 개별 활성화(2026-08-22, 기간제 폐지). opens_at/closes_at 은
-- NOT NULL·check 제약 때문에 남겨두되 판정에 쓰지 않는다(activateStudents 가 now()~+100년으로 채움).
-- consumed_at 이 null 이면 아직 유효(=열려 있음), 학생이 제출하면 그 순간 now() 로 채워 소진된다
-- (f/actions.ts submitForm). label/note/created_by/created_at 은 그대로 활용(관리 화면 표시용).
create table if not exists schedule_grant(
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branch(id) on delete cascade,
  student_id   uuid not null references student(id) on delete cascade,
  opens_at     timestamptz not null,
  closes_at    timestamptz not null,
  note         text,
  created_at   timestamptz not null default now(),
  created_by   uuid references person(id) on delete set null,
  check (closes_at > opens_at)
);
create index if not exists idx_schedule_grant_bs on schedule_grant(branch_id, student_id);
-- 입력 기간(전체) + 개별 개방을 관리 화면에서 하나의 폼(대상: 전체/특정 학생)으로 합치면서(2026-08-22)
-- 라벨(이름)을 두 종류 모두 공통 입력으로 받는다 — schedule_window 는 이미 label 이 있었고, grant 에는
-- 없었으므로 추가한다. 기존 행은 label=null(화면에서는 "(라벨 없음)"으로 표시, schedule_window 와 동일).
alter table schedule_grant add column if not exists label text;
-- 1회용 활성화(2026-08-22): 학생이 제출하면 소진되는 시각. null=아직 유효(열려 있음).
alter table schedule_grant add column if not exists consumed_at timestamptz;
-- 기간제였던 기존 행(과거 opens_at/closes_at 기준)은 새 규칙에서 아무 의미가 없다 — 유니크 인덱스를
-- 만들기 전에 무효화(소진 처리)한다.
-- 반드시 cutover 시점 이전에 만들어진 행만 건드린다: 이 블록은 SCHEMA_VERSION 이 바뀔 때마다 다시
-- 도는 자리라, 조건 없이 쓰면 앞으로 스키마를 올릴 때마다 그때 살아있던 활성화가 전부 취소된다.
update schedule_grant set consumed_at = now()
 where consumed_at is null and created_at < timestamptz '2026-08-22 00:00+09';
-- 학생당 "아직 소진되지 않은" 활성화는 최대 1개만 — 활성화 insert 를 on conflict do nothing 으로
-- 멱등하게 만들고(이미 열려 있는 학생을 다시 활성화해도 중복행이 안 생긴다), 판정 쿼리도 항상
-- 최대 1행만 보면 되게 한다.
create unique index if not exists uq_schedule_grant_active on schedule_grant(branch_id, student_id) where consumed_at is null;

-- ================= 학생 일회성 일정 변경 신청 (관리자 승인 필요) =================
-- 정기 스케쥴(schedule_rule/schedule_hours)과 별개로 "이 날만" 바뀌는 요청. 입력 기간과 무관하게
-- 언제나 신청 가능(신청일 뿐 정기 수정이 아니다). 승인되면 schedule_exception 을 만들어 exception_id
-- 로 연결한다. skip_rule_id 는 스키마 설계서에는 없던 컬럼이지만, "대체"로 낸 신청(겹치는 정기 규칙을
-- 그 날만 건너뜀)을 승인 시점까지 기억해둘 곳이 필요해 schedule_exception 과 같은 패턴으로 추가했다
-- (신청 시점에 학생이 고른 값을 그대로 승인 시 schedule_exception.skip_rule_id 에 옮겨 담는다).
create table if not exists schedule_request(
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branch(id) on delete cascade,
  student_id   uuid not null references student(id) on delete cascade,
  date         date not null,
  kind         text not null check (kind in ('study','academy','counsel','absent')),
  reason       text not null,
  title        text,
  start_min    int  not null,
  end_min      int  not null,
  skip_rule_id uuid references schedule_rule(id) on delete set null,
  status       text not null default 'pending',    -- pending | approved | rejected
  note         text,
  exception_id uuid references schedule_exception(id) on delete set null,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references person(id) on delete set null,
  check (end_min > start_min)
);
create index if not exists idx_schedule_request_bsd on schedule_request(branch_id, status, date);
create index if not exists idx_schedule_request_sd on schedule_request(student_id, date);
-- 신청 유형(absent|late|early|out|custom) — src/lib/schedule.ts REQUEST_TYPES 가 단일 출처.
-- start_min/end_min 은 이미 그 유형에 맞게 환산된 값(schedule-request-actions.ts resolveRequestRange)이고,
-- req_type 은 표시(칩·시간 라벨 읽기 방식)에만 쓰인다 — schedule_exception 승인 로직은 지금처럼 start/end/kind/reason 만 본다.
alter table schedule_request add column if not exists req_type text not null default 'custom';

-- 신청 갈래(temp|rule_edit|rule_delete) — src/lib/schedule.ts REQUEST_KINDS 가 단일 출처.
-- temp(기존): 특정 날짜 하루만 바뀌는 신청. 기존 컬럼(date/kind/reason/title/start_min/end_min) 그대로 쓰고
-- target_rule_id/days 는 null.
-- rule_edit: 기존 정기 규칙(target_rule_id) 하나의 요일/시간/사유/제목을 바꾸는 신청. "새 값"을 기존 컬럼
-- (kind/reason/title/start_min/end_min)에 재사용하고, 요일은 days(schedule_rule.days 와 같은 CSV 형식)에 담는다.
-- date 는 특정 날짜가 없으므로 null.
-- rule_delete: 기존 정기 규칙(target_rule_id) 하나를 영구 삭제하는 신청. kind/reason/title/start_min/end_min/
-- days 는 신청 시점의 "현재 값" 스냅샷(표시용 — 승인 뒤 규칙이 지워져도 무엇을 지웠는지 보여줄 수 있게).
-- date 는 null.
-- target_rule_id 는 "on delete set null"(cascade 아님) — 그 규칙이 다른 경로로 지워져도 이 신청 행 자체는
-- 남아 있어야 승인 시점에 "대상이 사라졌다"고 판단해 반려 사유를 남길 수 있고(schedule-request.ts),
-- rule_delete 승인 자체가 그 규칙을 지울 때도(같은 트랜잭션 안) 방금 승인 처리한 이 행이 cascade 로
-- 함께 지워지는 걸 막아 prev_snapshot(되돌리기용)이 살아남는다.
alter table schedule_request add column if not exists req_kind text not null default 'temp';
alter table schedule_request add column if not exists target_rule_id uuid references schedule_rule(id) on delete set null;
alter table schedule_request add column if not exists days text;
alter table schedule_request alter column date drop not null;
-- 승인 시점의 이전 값 스냅샷(되돌리기용, jsonb). rule_edit=수정 전 규칙 전체 행, rule_delete=삭제 전 규칙
-- 전체 행({id,reason,kind,title,start_min,end_min,days}) — 되돌릴 때 rule_delete 는 이 스냅샷으로
-- (가능하면 같은 id로) schedule_rule 행을 재생성한다. temp 는 지금처럼 exception_id 를 지우는 것만으로
-- 충분해 prev_snapshot 을 쓰지 않는다.
alter table schedule_request add column if not exists prev_snapshot jsonb;

-- ================= 지점별 설정 (키-값) =================
-- 예: schedule_auto_approve='1' → 변경 신청을 접수 즉시 자동 승인.
create table if not exists branch_setting(
  branch_id  uuid not null references branch(id) on delete cascade,
  key        text not null,
  value      text not null,
  updated_at timestamptz not null default now(),
  primary key(branch_id, key)
);
`;
