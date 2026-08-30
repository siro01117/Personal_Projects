// 코어 스키마 + 시드 (로컬 개발용, 멱등 — 여러 번 돌려도 안전).
// 배포 때는 같은 내용을 Supabase 마이그레이션 SQL로 옮김.
import { db } from "./db";
import { hashPin } from "./hash";
import { PERMISSIONS } from "./perms";
import { MODULES } from "./modules";
import { MODULE_SQL } from "./schema.modules";
import { seedDemo, seedDemoExpansion } from "./seed-demo"; // 브라우저 데모 전용 — 좌석·학생 표본 데이터(별도 파일로 분리)

const CORE_SQL = `
-- gen_random_uuid() 는 Postgres 13+ 코어 내장 (pgcrypto 불필요)

-- 지점
create table if not exists branch(
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text unique,
  is_hq boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 사람 = 직원 로그인 계정 (학생은 여기 없음)
create table if not exists person(
  id uuid primary key default gen_random_uuid(),
  login_id text unique not null,
  name text not null,
  pin_hash text not null,
  is_cto boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 역할 (앱에서 자유롭게 생성). branch_id null이면 전역 역할
create table if not exists role(
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branch(id) on delete cascade,
  key text not null,
  label text not null,
  created_at timestamptz not null default now()
);

-- 권한 카탈로그 (고정 키)
create table if not exists permission(
  key text primary key,
  label text not null,
  category text
);

-- 역할 ↔ 권한 (여기가 "누가 뭘 할 수 있나"의 정답, 앱에서 조정)
create table if not exists role_permission(
  role_id uuid references role(id) on delete cascade,
  permission_key text references permission(key) on delete cascade,
  primary key(role_id, permission_key)
);

-- 사람 ↔ 지점 ↔ 역할 (한 사람이 여러 지점·역할 가능)
create table if not exists person_role(
  id uuid primary key default gen_random_uuid(),
  person_id uuid references person(id) on delete cascade,
  branch_id uuid references branch(id) on delete cascade,
  role_id uuid references role(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(person_id, branch_id, role_id)
);

-- 모듈 카탈로그
create table if not exists module(
  key text primary key,
  label text not null,
  icon text,
  requires text[] not null default '{}',
  ord int not null default 100
);

-- 지점별 모듈 on/off
create table if not exists branch_module(
  branch_id uuid references branch(id) on delete cascade,
  module_key text references module(key) on delete cascade,
  enabled boolean not null default true,
  primary key(branch_id, module_key)
);

create index if not exists idx_person_role_person on person_role(person_id);
create index if not exists idx_person_role_branch on person_role(branch_id);

-- 앱 메타(스키마 버전 등). 이게 있어야 부팅을 건너뛸 수 있는지 판정한다.
create table if not exists app_meta(
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
`;

let booted: Promise<void> | null = null;

/** 코어 스키마·시드를 한 번만 실행하고, 이후엔 즉시 반환.
 *  실패는 절대 캐시하지 않는다 — 캐시하면 서버 인스턴스 하나가 살아있는 내내
 *  같은 옛 에러만 계속 던져서 "고쳤는데도 안 되는" 상태가 된다. */
export function ready(): Promise<void> {
  if (!booted) {
    const p: Promise<void> = (booted = boot().catch((e) => {
      if (booted === p) booted = null; // 다음 요청에서 재시도 (boot()은 멱등)
      throw e;
    }));
  }
  return booted;
}

// 여러 서버 인스턴스가 동시에 부팅하면 create table/index 가 서로 충돌한다.
// 같은 multi-statement 안에서 트랜잭션 락을 먼저 잡아 한 번에 하나만 실행되게 한다.
// (별도 문장으로 분리하면 pooler가 다른 커넥션에 배정해서 의미가 없다)
// 로컬 PGlite 는 단일 프로세스라 경합이 없고, advisory lock 을 만나면 WASM 이 죽는다 → 배포에서만 건다.
const BOOT_LOCK =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL
    ? `select pg_advisory_xact_lock(918273645);\n`
    : "";

// 스키마·시드 내용이 바뀌면 이 값을 올린다. 그때만 DDL 이 다시 돈다.
// (schema.modules.ts / CORE_SQL / PERMISSIONS / MODULES 를 수정하면 반드시 갱신)
const SCHEMA_VERSION = "2026-08-22.2"; // schedule_grant 를 1회용 활성화로 교체(consumed_at 추가, 기간 개념 폐지 — schedule_window 는 더 이상 참조하지 않음)

/** 이미 이 버전으로 부팅된 DB인지 한 번의 쿼리로 판정 */
async function alreadyBooted(): Promise<boolean> {
  try {
    const r = await db.query<{ value: string }>(
      `select value from app_meta where key='schema_version'`,
    );
    return r.rows[0]?.value === SCHEMA_VERSION;
  } catch {
    return false; // app_meta 자체가 없음 = 최초 부팅
  }
}

async function boot() {
  // 콜드 스타트마다 DDL 전체(70여 회 왕복)를 돌리면 요청이 수십 초씩 걸리고,
  // 동시에 뜬 인스턴스들이 advisory lock 뒤에 줄을 선다. 이미 최신이면 스키마·권한·모듈 카탈로그는
  // 건너뛰되, 시드(seedDemo/seedDemoExpansion)는 각자 자체 플래그로 게이트돼 있어 항상 호출한다 —
  // 그래야 이미 schema_version 이 맞는(=1단계에서 부팅된) 브라우저에서도 2단계 확장 시드가 돈다.
  if (await alreadyBooted()) {
    await seedDemo();
    await seedDemoExpansion();
    return;
  }
  console.log(`[bootstrap] 스키마·시드 실행 (${SCHEMA_VERSION})`); // 실제로 돌 때만 찍힌다

  await db.exec(BOOT_LOCK + CORE_SQL);
  await db.exec(BOOT_LOCK + MODULE_SQL); // 이식된 모듈 테이블
  // 상태 모델 변경(2026-07-20): 퇴원(withdrawn) 폐지 → 휴원(leave)로 통합
  await db.query(`update student set status='leave' where status='withdrawn'`);
  // 도시락 신청 파일럿(2026-07-24): 기존 지점의 lunch 모듈을 켠다(신규는 아래 mvp 시드가 처리).
  await db.query(`update branch_module set enabled=true where module_key='lunch'`);
  // 자습은 더 이상 블록으로 저장하지 않는다(등하원 시각 + statusAt 파생 판정으로 대체). 구방식 잔여 행 정리.
  await db.query(`delete from schedule_rule where kind='study'`);
  // schedule_exception.skip_rule_id 는 "이 날만 정기 규칙을 대체" 마커로 쓰인다(위에서 study 규칙을 지우면
  // 그 규칙을 가리키던 skip_rule_id 는 FK(on delete set null)로 이미 null 처리됨).
  // skip_rule_id 가 아직 남아있는 study 예외는 다른(academy 등) 살아있는 정기 규칙을 이 날만 대체하는 마커일 수 있어
  // 지우면 그 규칙이 해당 날짜에 되살아나 버린다 — 그래서 대체 대상이 없는(skip_rule_id 없는) 구방식 study 예외만 지운다.
  await db.query(`delete from schedule_exception where kind='study' and skip_rule_id is null`);
  // 스케쥴 입력 기간(2026-08-20): 기존 제출 행은 first_submitted_at 이 없다 — created_at 을 최초
  // 제출 시각으로 간주해 채운다(그 순간부터는 actions.ts submitForm 이 insert 시에만 채우고 보존).
  await db.query(`update submission set first_submitted_at = coalesce(first_submitted_at, created_at) where first_submitted_at is null`);

  // 권한 카탈로그
  for (const p of PERMISSIONS) {
    await db.query(
      `insert into permission(key,label,category) values ($1,$2,$3)
       on conflict (key) do update set label=excluded.label, category=excluded.category`,
      [p.key, p.label, p.category],
    );
  }

  // 모듈 카탈로그
  for (const m of MODULES) {
    const arr = `{${m.requires.join(",")}}`;
    await db.query(
      `insert into module(key,label,requires,ord) values ($1,$2,$3::text[],$4)
       on conflict (key) do update set label=excluded.label, requires=excluded.requires, ord=excluded.ord`,
      [m.key, m.label, arr, m.ord],
    );
  }

  // 본점 1개 (동시 부팅 시 중복키 나지 않게 on conflict)
  await db.query(
    `insert into branch(name,code,is_hq) values ('본점','HQ',true)
     on conflict (code) do nothing`,
  );
  const hq = await db.query<{ id: string }>(`select id from branch where code='HQ' limit 1`);
  const hqId = hq.rows[0]?.id;
  if (!hqId) throw new Error("본점(HQ) 생성에 실패했습니다.");

  // 본점 모듈 on/off — MVP만 켬
  for (const m of MODULES) {
    await db.query(
      `insert into branch_module(branch_id,module_key,enabled) values ($1,$2,$3)
       on conflict (branch_id,module_key) do nothing`,
      [hqId, m.key, !!m.mvp],
    );
  }

  // 마스터 계정. 없을 때만 생성(있으면 PIN 을 덮어쓰지 않는다).
  // irium = 관리자용 별도 계정 — 지금은 권한 동일, 추후 역할 구분용.
  const MASTERS: [login: string, name: string, pin: string][] = [
    ["나한결", "나한결", "365785"],
    ["irium", "관리자", "140988"],
  ];
  for (const [login, name, pin] of MASTERS) {
    const exists = await db.query(`select 1 from person where login_id=$1`, [login]);
    if (exists.rows.length === 0) {
      await db.query(
        `insert into person(login_id,name,pin_hash,is_cto) values ($1,$2,$3,true)`,
        [login, name, hashPin(pin)],
      );
    }
  }

  // 여기까지 왔으면 이 버전으로 완료. 다음 부팅부터는 판정 쿼리 한 번으로 끝난다.
  await db.query(
    `insert into app_meta(key,value) values ('schema_version',$1)
     on conflict (key) do update set value=excluded.value, updated_at=now()`,
    [SCHEMA_VERSION],
  );

  await seedDemo(); // 데모 표본 데이터(방·좌석·학생) — 멱등, 자체 플래그로 1회만 실행
  await seedDemoExpansion(); // 2단계 확장(출결 4주·순찰·벌점·스케쥴·도시락·접수함) — 멱등, 별도 플래그
}
