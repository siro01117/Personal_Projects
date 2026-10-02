-- 모임 — 약속 관리 (docs/모임.md 2 · 4장, 9장 '가'). 행 모양의 기준은 lib/meet/types.ts (Circle · MeetRow · MeetPerson).
-- 0010 위에 더한다. 오류 · p_as · soft delete · 권한 관례는 0006 과 같다.
--
-- 테이블: ez_circles (묶음) · ez_meets (만남 한 번) · ez_meet_people (모임마다 사람 한 줄)
-- 더하는 열: ez_schedule_settings.my_name (내 이름 — 모임의 내 줄에 적힌다)
-- 함수:   ez_meet_decide (시간 정하기 + 일정) · ez_meet_reopen (시간 비우기 + 일정 지우기)
-- 트리거: ez_meets_guard · ez_meets_after (모임의 시간 ↔ 일정) · ez_events_after (고침: 일정을 지우면 모임의 event_id 만 빈다)
--
-- 시간 맞추기(poll · token · cells · auto · pin_*)는 칸만 만들어 둔다. 남(anon)이 드나드는 함수 4개는 0012 에서.

-- ---------------------------------------------------------------------------
-- 검사 도우미 (CHECK 가 쓰므로 테이블보다 먼저)
-- ---------------------------------------------------------------------------

-- 이름 겹침을 볼 때의 열쇠: 대소문자 · 공백 무시
create function public.ez_name_key(p text) returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select lower(regexp_replace(p, '\s', '', 'g'))
$$;

-- 묶음의 사람 이름들: 0~50개, 각 앞뒤 공백 없는 1~20자, 겹침 없음(대소문자 · 공백 무시)
create function public.ez_members_ok(p text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p is not null
     and coalesce(array_ndims(p), 1) = 1
     and cardinality(p) <= 50
     and not exists (
       select 1 from unnest(p) m
        where m is null or m <> public.ez_trim(m) or char_length(m) not between 1 and 20
     )
     and (select count(distinct public.ez_name_key(m)) from unnest(p) m) = cardinality(p)
$$;

-- 시간 맞추기 설정 {dates, day_from, day_to, duration_min}:
--   dates 는 후보 날짜 1~31개(겹침 없음 · 오름차순), 하루 범위는 30분 단위 0 ≤ from < to ≤ 1440, 길이 30~480(30분 단위)
create function public.ez_poll_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_from int;
  v_to   int;
  v_len  int;
  v_prev text := '';
  v_d    jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from array['dates', 'day_from', 'day_to', 'duration_min'] then
    return false;
  end if;
  if jsonb_typeof(p -> 'dates') <> 'array' or jsonb_array_length(p -> 'dates') not between 1 and 31 then
    return false;
  end if;
  for v_d in select e.value from jsonb_array_elements(p -> 'dates') with ordinality as e(value, n) order by e.n loop
    if jsonb_typeof(v_d) <> 'string' or not public.ez_is_date(v_d #>> '{}') or (v_d #>> '{}') <= v_prev then
      return false;
    end if;
    v_prev := v_d #>> '{}';
  end loop;
  if exists (select 1 from jsonb_each(p - 'dates') e where jsonb_typeof(e.value) <> 'number' or e.value::text !~ '^[0-9]{1,4}$') then
    return false;
  end if;
  v_from := (p ->> 'day_from')::int;
  v_to := (p ->> 'day_to')::int;
  v_len := (p ->> 'duration_min')::int;
  return v_from % 30 = 0 and v_to % 30 = 0 and v_from < v_to and v_to <= 1440
     and v_len % 30 = 0 and v_len between 30 and 480;
end;
$$;

-- ---------------------------------------------------------------------------
-- 내 이름 (설정 한 칸). 모임을 만들 때 내 줄(is_owner)의 이름이 된다
-- ---------------------------------------------------------------------------

alter table public.ez_schedule_settings
  add column my_name text,
  add constraint ez_schedule_settings_my_name_check check (
    my_name is null or (my_name = public.ez_trim(my_name) and char_length(my_name) between 1 and 20)
  );

-- ---------------------------------------------------------------------------
-- ez_circles 묶음 — 같은 사람들과 또 만날 때. 고르면 사람들이 채워지고 지난 만남이 쌓인다
-- ---------------------------------------------------------------------------

create table public.ez_circles (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid(),
  name        text not null,
  -- 플래너의 역할. 묶음의 모임 · 거기서 나온 할 일이 물려받는다
  role_id     uuid,
  -- 늘 오는 사람 이름들 (나는 안 적는다)
  members     text[] not null default '{}',
  origin_kind text,
  origin_id   uuid,
  version     int not null default 1,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- 모임이 (owner, 묶음) 으로 걸어 같은 주인의 묶음만 가리키게 한다
  constraint ez_circles_owner_id_key unique (owner, id),
  constraint ez_circles_name_check check (name = public.ez_trim(name) and char_length(name) between 1 and 30),
  constraint ez_circles_members_check check (public.ez_members_ok(members)),
  constraint ez_circles_origin_check check ((origin_kind is null) = (origin_id is null)),
  constraint ez_circles_origin_kind_check check (origin_kind is null or origin_kind in ('project')),
  constraint ez_circles_version_check check (version >= 1),
  -- 같은 주인의 역할만. 지운(deleted_at) 역할은 그대로 가리킨다 — 화면은 없는 것으로 읽고, 역할을 되돌리면 다시 보인다
  constraint ez_circles_role_fk foreign key (owner, role_id) references public.ez_roles (owner, id) on delete set null (role_id)
);

-- 살아 있는 묶음끼리 이름 겹침 금지 (대소문자 무시, 이름은 이미 trim)
create unique index ez_circles_name_unique on public.ez_circles (owner, lower(name)) where deleted_at is null;
create index ez_circles_role_idx on public.ez_circles (owner, role_id) where role_id is not null;

-- 살아 있는 묶음 30개 상한 (넣을 때 · 되살릴 때)
create function public.ez_circles_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    perform pg_advisory_xact_lock(hashtextextended('ez_circles:' || new.owner::text, 0));
    if (select count(*) from public.ez_circles c
         where c.owner = new.owner and c.deleted_at is null and c.id <> new.id) >= 30 then
      raise exception using errcode = 'P0001', message = '[EZ_LIMIT] 묶음은 30개까지 둘 수 있습니다. 안 쓰는 묶음을 지우고 다시 하세요';
    end if;
  end if;
  return new;
end;
$$;

create trigger ez_circles_guard before insert or update on public.ez_circles
  for each row execute function public.ez_circles_guard();
-- 지운 역할은 새로 걸 수 없다 (0008 과 같은 검사). 이름순으로 ez_circles_stamp 보다 먼저 돈다
create trigger ez_circles_role_guard before insert or update on public.ez_circles
  for each row execute function public.ez_role_guard();
create trigger ez_circles_stamp before insert or update on public.ez_circles
  for each row execute function public.ez_stamp();

-- ---------------------------------------------------------------------------
-- ez_meets 모임 (만남 한 번)
-- 상태는 칸에서 읽는다: 시간 없음 + poll = 맞추는 중 · 시간 없음 = 미정 · 시간 있고 안 지남 = 다가옴 · 지남 = 지난 모임
-- ---------------------------------------------------------------------------

create table public.ez_meets (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid(),
  title       text not null,
  note        text,
  circle_id   uuid,
  place_id    uuid,
  place_text  text,
  -- 정해진 시간. 셋 다 있거나 셋 다 없음(= 아직 안 정함). 자정을 넘기지 않는다
  meet_date   date,
  start_min   int,
  end_min     int,
  -- 정하면서 만든 일정. ez_meets_guard 가 채우고 비운다
  event_id    uuid,
  poll        jsonb,
  token       text,
  origin_kind text,
  origin_id   uuid,
  version     int not null default 1,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint ez_meets_owner_id_key unique (owner, id),
  constraint ez_meets_title_check check (title = public.ez_trim(title) and char_length(title) between 1 and 60),
  constraint ez_meets_note_check check (note is null or char_length(note) <= 2000),
  constraint ez_meets_place_text_check check (
    place_text is null or (place_text = public.ez_trim(place_text) and char_length(place_text) between 1 and 60)
  ),
  -- 트리거(ez_meets_guard)가 먼저 한국어 이유로 거절한다
  constraint ez_meets_time_check check (
    (meet_date is null and start_min is null and end_min is null)
    or (meet_date is not null and start_min is not null and end_min is not null
        and start_min between 0 and 1439 and end_min > start_min and end_min <= 1440)
  ),
  constraint ez_meets_poll_check check (poll is null or public.ez_poll_ok(poll)),
  constraint ez_meets_token_check check (token is null or token ~ '^[A-Za-z0-9_-]{22}$'),
  constraint ez_meets_origin_check check ((origin_kind is null) = (origin_id is null)),
  constraint ez_meets_origin_kind_check check (origin_kind is null or origin_kind in ('project')),
  constraint ez_meets_version_check check (version >= 1),
  -- 같은 주인의 묶음 · 지점 · 일정만. 행이 정말 지워지면 그 칸만 null.
  -- 지운(deleted_at) 묶음 · 지점은 그대로 가리킨다 — 묶음은 화면이 없는 것으로 읽고(되돌리면 다시 붙는다), 지점은 이름이 남는다
  constraint ez_meets_circle_fk foreign key (owner, circle_id) references public.ez_circles (owner, id) on delete set null (circle_id),
  constraint ez_meets_place_fk foreign key (owner, place_id) references public.ez_places (owner, id) on delete set null (place_id),
  constraint ez_meets_event_fk foreign key (owner, event_id) references public.ez_events (owner, id) on delete set null (event_id)
);

create unique index ez_meets_token_unique on public.ez_meets (token) where token is not null;
create index ez_meets_owner_idx on public.ez_meets (owner) where deleted_at is null;
create index ez_meets_circle_idx on public.ez_meets (owner, circle_id) where circle_id is not null;
create index ez_meets_place_idx on public.ez_meets (owner, place_id) where place_id is not null;
create index ez_meets_event_idx on public.ez_meets (owner, event_id) where event_id is not null;
-- 모임 화면이 그 모임에서 나온 할 일을 찾는다 (origin_kind = 'meet')
create index ez_tasks_origin_idx on public.ez_tasks (owner, origin_id) where origin_id is not null;

-- 모임의 시간 ↔ 일정 (docs/모임.md 4장). 어느 길로 고치든(화면의 직접 쓰기 · MCP · 함수) 여기서 맞춘다.
--   시간이 생기면(넣을 때 · 비어 있다가 적을 때) 일정 한 건(origin_kind = 'meet')을 만들고 event_id 를 적는다
--   시간을 비우면 event_id 를 비운다 (딸린 일정은 ez_meets_after 가 지운다)
--   일정 화면에서 그 일정을 지워 event_id 만 빈 모임은 여기서 다시 만들지 않는다 — ez_meet_decide('일정에 넣기')가
--   트랜잭션 안에서만 사는 설정 ez.meet_event = 모임 id 를 켰을 때만 다시 만든다 (PostgREST 로는 못 켠다)
create function public.ez_meets_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 지운 묶음은 새로 걸 수 없다 (없는 묶음 · 남의 묶음은 외래키가 거절한다)
  if new.circle_id is not null and (tg_op = 'INSERT' or new.circle_id is distinct from old.circle_id)
     and exists (select 1 from public.ez_circles c
                  where c.id = new.circle_id and c.owner = new.owner and c.deleted_at is not null) then
    raise exception using errcode = 'P0001', message = '[EZ_CIRCLE] 지운 묶음입니다';
  end if;

  -- 시간: CHECK 와 같은 규칙을 먼저 한국어 이유로 거절한다 (일정을 만들기 전에)
  if not ((new.meet_date is null and new.start_min is null and new.end_min is null)
          or (new.meet_date is not null and new.start_min is not null and new.end_min is not null)) then
    raise exception using errcode = 'P0001',
      message = '[EZ_VALUE] 시간을 정했으면 날짜 · 시작 · 끝을 모두 채우고, 안 정했으면 모두 비웁니다';
  end if;
  if new.meet_date is not null and (new.start_min not between 0 and 1439 or new.end_min <= new.start_min or new.end_min > 1440) then
    raise exception using errcode = 'P0001',
      message = '[EZ_VALUE] 시작은 00:00~23:59, 끝은 시작보다 늦고 24:00 까지입니다 (모임은 자정을 넘기지 않습니다)';
  end if;

  if new.deleted_at is not null then
    return new;
  end if;
  if new.meet_date is null then
    if tg_op = 'UPDATE' then
      new.event_id := null;
    end if;
  elsif new.event_id is null
        and (tg_op = 'INSERT' or old.meet_date is null or coalesce(current_setting('ez.meet_event', true), '') = new.id::text) then
    insert into public.ez_events (owner, title, date, start_min, end_min, place_id, where_text, origin_kind, origin_id)
    values (new.owner, new.title, new.meet_date, new.start_min, new.end_min, new.place_id, new.place_text, 'meet', new.id)
    returning id into new.event_id;
  end if;
  return new;
end;
$$;

-- 모임을 만들면 내 줄(is_owner)이 같이 생긴다. 이름은 설정의 내 이름, 없으면 '나'.
-- 모임 쪽에서 시간 · 제목 · 장소를 바꾸면 딸린 일정이 따라간다 (바뀐 칸만 — 일정 화면에서 따로 고친 칸은 건드리지 않는다).
-- 시간을 비우면 딸린 일정을 지운다. 모임을 지울 때는 일정을 남긴다
create function public.ez_meets_after() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.ez_meet_people (meet_id, name, is_owner, user_id)
    values (
      new.id,
      coalesce((select s.my_name from public.ez_schedule_settings s where s.owner = new.owner), '나'),
      true, new.owner
    );
    return null;
  end if;

  if new.deleted_at is not null then
    return null;
  end if;
  if new.meet_date is null then
    if old.event_id is not null then
      update public.ez_events e set deleted_at = now()
       where e.id = old.event_id and e.owner = new.owner and e.deleted_at is null;
    end if;
    return null;
  end if;
  if new.event_id is not null and new.event_id is not distinct from old.event_id then
    if (new.meet_date, new.start_min, new.end_min) is distinct from (old.meet_date, old.start_min, old.end_min) then
      update public.ez_events e set date = new.meet_date, start_min = new.start_min, end_min = new.end_min
       where e.id = new.event_id and e.owner = new.owner and e.deleted_at is null;
    end if;
    if new.title is distinct from old.title then
      update public.ez_events e set title = new.title
       where e.id = new.event_id and e.owner = new.owner and e.deleted_at is null;
    end if;
    if new.place_id is distinct from old.place_id or new.place_text is distinct from old.place_text then
      update public.ez_events e set place_id = new.place_id, where_text = new.place_text
       where e.id = new.event_id and e.owner = new.owner and e.deleted_at is null;
    end if;
  end if;
  return null;
end;
$$;

create trigger ez_meets_guard before insert or update on public.ez_meets
  for each row execute function public.ez_meets_guard();
create trigger ez_meets_stamp before insert or update on public.ez_meets
  for each row execute function public.ez_stamp();

-- ---------------------------------------------------------------------------
-- ez_meet_people 사람 — 모임마다 한 줄. 주최자가 미리 넣은 사람도, 링크로 들어온 사람(0012)도 같은 줄이다
-- ---------------------------------------------------------------------------

create table public.ez_meet_people (
  id               uuid primary key default gen_random_uuid(),
  meet_id          uuid not null references public.ez_meets (id) on delete cascade,
  name             text not null,
  -- 내 줄. 모임당 하나, 모임을 만들 때 같이 생긴다
  is_owner         boolean not null default false,
  -- 가입자 구멍 (지금은 내 줄만 채워진다)
  user_id          uuid,
  -- 핀번호의 sha256(salt ‖ pin). 없으면 아직 안 들어온 사람. 어떤 함수도 이 값을 밖으로 안 준다 (0012)
  pin_hash         text,
  pin_salt         text,
  pin_fails        int not null default 0,
  pin_locked_until timestamptz,
  -- {"2026-10-05":[540,570], …} 날짜별 되는 칸의 시작 분. 없으면 아직 안 칠함. 칸 검사는 0012 의 함수가 한다
  cells            jsonb,
  -- 내 줄만: 일정에서 자동으로 채운 상태인지
  auto             boolean not null default false,
  -- 정해진 뒤 온다 / 못 온다, 지난 뒤 왔다 / 안 왔다 — 같은 칸
  attend           text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint ez_meet_people_name_check check (name = public.ez_trim(name) and char_length(name) between 1 and 20),
  constraint ez_meet_people_pin_check check ((pin_hash is null) = (pin_salt is null)),
  constraint ez_meet_people_pin_fails_check check (pin_fails >= 0),
  constraint ez_meet_people_cells_check check (cells is null or jsonb_typeof(cells) = 'object'),
  constraint ez_meet_people_auto_check check (not auto or is_owner),
  constraint ez_meet_people_attend_check check (attend is null or attend in ('yes', 'no'))
);

-- 한 모임 안에서 이름 겹침 금지 (대소문자 · 공백 무시). 내 줄은 모임당 하나
create unique index ez_meet_people_name_unique on public.ez_meet_people (meet_id, public.ez_name_key(name));
create unique index ez_meet_people_owner_unique on public.ez_meet_people (meet_id) where is_owner;

-- 한 모임에 50명까지. 내 줄은 못 지우고(모임이 지워질 때만 같이), 내 줄 여부 · 모임은 못 바꾼다.
-- 넣은 순서가 남게 created_at 은 그 모임의 마지막 줄보다 늘 1ms 이상 뒤다 (한 문장으로 여럿을 넣어도 차례대로. JS 의 시각은 ms 까지다)
create function public.ez_meet_people_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n    int;
  v_last timestamptz;
begin
  if tg_op = 'DELETE' then
    if old.is_owner and exists (select 1 from public.ez_meets m where m.id = old.meet_id) then
      raise exception using errcode = 'P0001', message = '[EZ_FIXED] 내 줄은 뺄 수 없습니다';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.meet_id is distinct from old.meet_id or new.is_owner is distinct from old.is_owner then
      raise exception using errcode = 'P0001', message = '[EZ_FIXED] 사람 줄의 id · 모임 · 내 줄 여부는 바꿀 수 없습니다';
    end if;
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ez_meet_people:' || new.meet_id::text, 0));
  select count(*), max(p.created_at) into v_n, v_last from public.ez_meet_people p where p.meet_id = new.meet_id;
  if v_n >= 50 then
    raise exception using errcode = 'P0001', message = '[EZ_LIMIT] 한 모임에 50명까지입니다. 더는 받을 수 없습니다';
  end if;
  new.created_at := greatest(now(), coalesce(v_last, now()) + interval '1 millisecond');
  new.updated_at := new.created_at;
  return new;
end;
$$;

create trigger ez_meet_people_guard before insert or update or delete on public.ez_meet_people
  for each row execute function public.ez_meet_people_guard();
create trigger ez_meet_people_touch before update on public.ez_meet_people
  for each row execute function public.ez_touch();
create trigger ez_meets_after after insert or update on public.ez_meets
  for each row execute function public.ez_meets_after();

-- ---------------------------------------------------------------------------
-- 일정을 지우면 모임은 시간이 정해진 채 event_id 만 빈다 → 모임 화면의 '일정에 넣기'. 되돌리면 다시 붙는다.
-- 일정에서 시각을 바꿔도 모임의 시간은 안 따라간다 (남에게 알린 시간은 모임 쪽이 기준).
-- 0007 ez_events_after 를 고친다. 나머지는 0007 과 같다
-- ---------------------------------------------------------------------------

create or replace function public.ez_events_after() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 반복 규칙이나 시작 날짜가 바뀌면 더는 회차가 아닌 날의 예외를 지운다 ('반복 규칙을 바꾸면 이번만은 없다')
  if new.repeat is distinct from old.repeat or new.date is distinct from old.date then
    delete from public.ez_event_exceptions x
     where x.event_id = new.id
       and (new.repeat is null or not public.ez_occurs_on(new.repeat, new.date, x.on_date));
  end if;

  -- 일정을 지우면: 딸린 마감은 연결만 끊기고(날짜는 남는다), 딸린 규칙은 멈추고, 모임은 event_id 만 빈다
  if new.deleted_at is not null and old.deleted_at is null then
    update public.ez_tasks t set due_event_id = null where t.due_event_id = new.id and t.owner = new.owner;
    update public.ez_task_rules r set deleted_at = now()
     where r.event_id = new.id and r.owner = new.owner and r.deleted_at is null;
    update public.ez_meets m set event_id = null where m.event_id = new.id and m.owner = new.owner;
    return null;
  end if;

  -- 모임에서 온 일정을 되돌리면: 그 모임이 아직 시간이 정해진 채 일정이 비어 있을 때만 다시 붙는다
  if new.deleted_at is null and old.deleted_at is not null and new.origin_kind = 'meet' then
    update public.ez_meets m set event_id = new.id
     where m.id = new.origin_id and m.owner = new.owner and m.deleted_at is null
       and m.event_id is null and m.meet_date is not null;
  end if;

  -- 반복이 아니게 되면 딸린 규칙을 멈춘다
  if new.repeat is null and old.repeat is not null then
    update public.ez_task_rules r set deleted_at = now()
     where r.event_id = new.id and r.owner = new.owner and r.deleted_at is null;
  end if;

  -- 반복 아닌 일정의 날짜가 바뀌면 딸린 마감도 따라간다
  if new.repeat is null and new.deleted_at is null and new.date is distinct from old.date then
    update public.ez_tasks t set due = new.date
     where t.due_event_id = new.id and t.owner = new.owner and t.deleted_at is null and t.due is distinct from new.date;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 정하기 · 다시 열기 (일정과 한 묶음). 주최자 · MCP(p_as) 가 부른다
-- ---------------------------------------------------------------------------

-- 고칠 모임을 잠그고 검사: 살아 있는 내 모임 · 버전
create function public.ez_meet_lock(p_id uuid, p_base int, p_uid uuid) returns public.ez_meets
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.ez_meets%rowtype;
begin
  select * into v_row from public.ez_meets m
   where m.id = p_id and m.owner = p_uid and p_uid is not null and m.deleted_at is null
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 모임이 없습니다';
  end if;
  if p_base is distinct from v_row.version then
    raise exception using errcode = 'P0001',
      message = format('[EZ_VERSION] 그 사이 다른 곳에서 이 모임을 고쳤습니다. 새로 불러오세요 (지금 버전 %s)', v_row.version);
  end if;
  return v_row;
end;
$$;

-- 한 번에: 모임에 시간을 적고 일정 한 건을 만든다. 이미 일정이 있으면 그 일정을 옮긴다(ez_meets_after).
-- 시간이 그대로인데 일정만 비어 있으면(일정 화면에서 지움) 다시 넣는다 — '일정에 넣기'. 반환: 고친 모임
create function public.ez_meet_decide(id uuid, base_version int, date date, start_min int, end_min int, p_as uuid default null)
returns public.ez_meets
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id   uuid := ez_meet_decide.id;
  v_date date := ez_meet_decide.date;
  v_s    int := ez_meet_decide.start_min;
  v_e    int := ez_meet_decide.end_min;
  v_row  public.ez_meets%rowtype;
begin
  v_row := public.ez_meet_lock(v_id, ez_meet_decide.base_version, public.ez_actor(p_as));
  if v_date is null or v_s is null or v_e is null then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 날짜 · 시작 · 끝을 모두 써 주세요';
  end if;
  if v_s not between 0 and 1439 or v_e <= v_s or v_e > 1440 then
    raise exception using errcode = 'P0001',
      message = '[EZ_VALUE] 시작은 00:00~23:59, 끝은 시작보다 늦고 24:00 까지입니다 (모임은 자정을 넘기지 않습니다)';
  end if;

  -- 일정이 비어 있으면 다시 만들게 한다 (ez_meets_guard)
  perform set_config('ez.meet_event', v_id::text, true);
  update public.ez_meets m set meet_date = v_date, start_min = v_s, end_min = v_e
   where m.id = v_id
  returning m.* into v_row;
  perform set_config('ez.meet_event', '', true);
  return v_row;
end;
$$;

-- 정한 시간을 비우고 딸린 일정을 지운다. 칠한 것 · 참석 표시는 남는다. 반환: 고친 모임
create function public.ez_meet_reopen(id uuid, base_version int, p_as uuid default null) returns public.ez_meets
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id  uuid := ez_meet_reopen.id;
  v_row public.ez_meets%rowtype;
begin
  v_row := public.ez_meet_lock(v_id, ez_meet_reopen.base_version, public.ez_actor(p_as));
  update public.ez_meets m set meet_date = null, start_min = null, end_min = null
   where m.id = v_id
  returning m.* into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: 주인만. 사람 줄은 부모 모임의 주인
-- ---------------------------------------------------------------------------

alter table public.ez_circles enable row level security;
alter table public.ez_meets enable row level security;
alter table public.ez_meet_people enable row level security;

create policy ez_circles_select on public.ez_circles for select to authenticated using (owner = (select auth.uid()));
create policy ez_circles_insert on public.ez_circles for insert to authenticated with check (owner = (select auth.uid()));
create policy ez_circles_update on public.ez_circles for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

create policy ez_meets_select on public.ez_meets for select to authenticated using (owner = (select auth.uid()));
create policy ez_meets_insert on public.ez_meets for insert to authenticated with check (owner = (select auth.uid()));
create policy ez_meets_update on public.ez_meets for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

create policy ez_meet_people_select on public.ez_meet_people for select to authenticated
  using (exists (select 1 from public.ez_meets m where m.id = meet_id and m.owner = (select auth.uid())));
create policy ez_meet_people_insert on public.ez_meet_people for insert to authenticated
  with check (exists (select 1 from public.ez_meets m where m.id = meet_id and m.owner = (select auth.uid())));
create policy ez_meet_people_update on public.ez_meet_people for update to authenticated
  using (exists (select 1 from public.ez_meets m where m.id = meet_id and m.owner = (select auth.uid())))
  with check (exists (select 1 from public.ez_meets m where m.id = meet_id and m.owner = (select auth.uid())));
create policy ez_meet_people_delete on public.ez_meet_people for delete to authenticated
  using (exists (select 1 from public.ez_meets m where m.id = meet_id and m.owner = (select auth.uid())));

-- ---------------------------------------------------------------------------
-- 권한: 기본(public) 회수 후 필요한 역할에만. anon 은 아무것도 없다 (남이 드나드는 함수는 0012).
-- 묶음 · 모임은 지우기도 soft(deleted_at) — authenticated 에 delete 를 주지 않는다. 사람 줄은 정말 지운다.
-- 모임: event_id(트리거가 쓴다) · token(0012 의 함수가 쓴다)은 직접 못 쓴다.
-- 사람: 핀 칸은 읽지도 쓰지도 못하고(0012 의 함수로만), 내 줄 여부는 못 넣는다
-- ---------------------------------------------------------------------------

revoke all on table public.ez_circles from public, anon, authenticated;
revoke all on table public.ez_meets from public, anon, authenticated;
revoke all on table public.ez_meet_people from public, anon, authenticated;

grant select, insert, update on table public.ez_circles to authenticated;

grant select on table public.ez_meets to authenticated;
grant insert (id, owner, title, note, circle_id, place_id, place_text, meet_date, start_min, end_min, poll, origin_kind, origin_id)
  on table public.ez_meets to authenticated;
grant update (title, note, circle_id, place_id, place_text, meet_date, start_min, end_min, poll, deleted_at)
  on table public.ez_meets to authenticated;

grant select (id, meet_id, name, is_owner, user_id, cells, auto, attend, created_at, updated_at)
  on table public.ez_meet_people to authenticated;
grant insert (id, meet_id, name, cells, auto, attend) on table public.ez_meet_people to authenticated;
grant update (name, cells, auto, attend) on table public.ez_meet_people to authenticated;
grant delete on table public.ez_meet_people to authenticated;

grant select, insert, update, delete on table public.ez_circles to service_role;
grant select, insert, update, delete on table public.ez_meets to service_role;
grant select, insert, update, delete on table public.ez_meet_people to service_role;

revoke all on function public.ez_name_key(text) from public, anon, authenticated;
revoke all on function public.ez_members_ok(text[]) from public, anon, authenticated;
revoke all on function public.ez_poll_ok(jsonb) from public, anon, authenticated;
revoke all on function public.ez_circles_guard() from public, anon, authenticated;
revoke all on function public.ez_meets_guard() from public, anon, authenticated;
revoke all on function public.ez_meets_after() from public, anon, authenticated;
revoke all on function public.ez_meet_people_guard() from public, anon, authenticated;
revoke all on function public.ez_events_after() from public, anon, authenticated;
revoke all on function public.ez_meet_lock(uuid, int, uuid) from public, anon, authenticated;
revoke all on function public.ez_meet_decide(uuid, int, date, int, int, uuid) from public, anon, authenticated;
revoke all on function public.ez_meet_reopen(uuid, int, uuid) from public, anon, authenticated;

-- CHECK · 인덱스 · 함수 안에서 부르는 도우미는 테이블을 쓰는 역할이 실행할 수 있어야 한다
grant execute on function public.ez_name_key(text) to authenticated, service_role;
grant execute on function public.ez_members_ok(text[]) to authenticated, service_role;
grant execute on function public.ez_poll_ok(jsonb) to authenticated, service_role;
grant execute on function public.ez_meet_lock(uuid, int, uuid) to authenticated, service_role;
grant execute on function public.ez_meet_decide(uuid, int, date, int, int, uuid) to authenticated, service_role;
grant execute on function public.ez_meet_reopen(uuid, int, uuid) to authenticated, service_role;
