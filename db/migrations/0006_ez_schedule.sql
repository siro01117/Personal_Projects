-- 일정 · 플래너 (docs/일정.md 2·4·5장, docs/플래너.md 2장). 행 모양의 기준은 lib/schedule/types.ts.
-- 0001~0005 위에 더한다. 오류는 0001 과 같이 errcode P0001, message '[EZ_코드] 한국어 설명'.
-- p_as 는 0001 ez_actor 와 같다 (로그인한 사람이면 그 사람, service_role 이면 p_as 대리).
--
-- 테이블: ez_places · ez_travel · ez_tasks · ez_events · ez_event_exceptions · ez_schedule_settings · ez_sources
-- 함수:   ez_schedule_sync · ez_event_split · ez_event_cut (+ 검사 도우미 ez_occurs_on 등)
--
-- 바깥 일정(source 있는 일정)은 ez_schedule_sync 안에서만 바뀐다. sync 가 트랜잭션 안에서만 사는 설정
-- ez.schedule_sync = 'on' 을 켜고, 일정·예외 트리거가 그 설정이 없으면 source 있는 행의 넣기·고치기·지우기를 거절한다.
-- 이 설정은 SQL 을 직접 실행해야 켤 수 있다 — PostgREST(anon·authenticated)로는 못 켠다.

-- ---------------------------------------------------------------------------
-- 검사 도우미 (CHECK 가 쓰므로 테이블보다 먼저)
-- ---------------------------------------------------------------------------

-- 'YYYY-MM-DD' 꼴이고 실제 있는 날짜인가
create function public.ez_is_date(p text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return false;
  end if;
  perform p::date;
  return true;
exception when others then
  return false;
end;
$$;

-- 반복 규칙 검사. 문제가 없으면 null, 있으면 한국어 이유.
-- null | {freq:'daily', until?} | {freq:'weekly', days:[1..7], until?}. days 1=월 … 7=일, 비거나 겹치면 안 됨. until 은 그날 포함, 시작 날짜 이후
create function public.ez_repeat_problem(p_repeat jsonb, p_date date) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_freq  text;
  v_days  jsonb;
  v_until date;
begin
  if p_repeat is null then
    return null;
  end if;
  if jsonb_typeof(p_repeat) <> 'object' then
    return '반복(repeat)은 null 또는 {freq, …} 로 써 주세요';
  end if;
  if jsonb_typeof(p_repeat -> 'freq') is distinct from 'string' then
    return '반복 freq 는 daily 또는 weekly 입니다';
  end if;
  v_freq := p_repeat ->> 'freq';
  if v_freq = 'daily' then
    if exists (select 1 from jsonb_object_keys(p_repeat) k where k not in ('freq', 'until')) then
      return '매일 반복에는 freq · until 만 씁니다';
    end if;
  elsif v_freq = 'weekly' then
    if exists (select 1 from jsonb_object_keys(p_repeat) k where k not in ('freq', 'days', 'until')) then
      return '매주 반복에는 freq · days · until 만 씁니다';
    end if;
    v_days := p_repeat -> 'days';
    if jsonb_typeof(v_days) is distinct from 'array' or jsonb_array_length(v_days) = 0 then
      return '매주 반복에는 요일(days)이 하나 이상 있어야 합니다 (1=월 … 7=일)';
    end if;
    if exists (select 1 from jsonb_array_elements(v_days) d where jsonb_typeof(d) <> 'number' or d::text !~ '^[1-7]$') then
      return '요일(days)은 1(월)~7(일) 정수로 써 주세요';
    end if;
    if (select count(distinct d::text) from jsonb_array_elements(v_days) d) <> jsonb_array_length(v_days) then
      return '요일(days)이 겹칩니다';
    end if;
  else
    return '반복 freq 는 daily 또는 weekly 입니다';
  end if;

  if jsonb_typeof(p_repeat -> 'until') in ('string', 'number', 'boolean', 'object', 'array') then
    if jsonb_typeof(p_repeat -> 'until') <> 'string' or not public.ez_is_date(p_repeat ->> 'until') then
      return '끝나는 날(until)은 YYYY-MM-DD 로 써 주세요';
    end if;
    v_until := (p_repeat ->> 'until')::date;
    if p_date is not null and v_until < p_date then
      return '끝나는 날(until)이 시작 날짜보다 이릅니다';
    end if;
    if v_freq = 'weekly' and p_date is not null and not exists (
      select 1 from generate_series(0, 6) k
       where p_date + k <= v_until and v_days @> to_jsonb(extract(isodow from p_date + k)::int)
    ) then
      return '끝나는 날(until)까지 반복되는 날이 없습니다';
    end if;
  end if;
  return null;
end;
$$;

-- p_d 가 (p_repeat, 시작 p_start) 일정의 회차인가. 반복이 아니면 시작 날짜 하루만. until 은 그날 포함
create function public.ez_occurs_on(p_repeat jsonb, p_start date, p_d date) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_start is null or p_d is null then false
    when p_repeat is null or jsonb_typeof(p_repeat) = 'null' then p_d = p_start
    when p_d < p_start then false
    when jsonb_typeof(p_repeat -> 'until') = 'string' and p_d > (p_repeat ->> 'until')::date then false
    when p_repeat ->> 'freq' = 'daily' then true
    when p_repeat ->> 'freq' = 'weekly' then coalesce((p_repeat -> 'days') @> to_jsonb(extract(isodow from p_d)::int), false)
    else false
  end
$$;

-- 첫 회차 날짜 (weekly 는 시작 날짜 요일이 days 에 없을 수 있다)
create function public.ez_first_on(p_repeat jsonb, p_start date) returns date
language sql immutable
set search_path = ''
as $$
  select min(p_start + k) from generate_series(0, 6) k where public.ez_occurs_on(p_repeat, p_start, p_start + k)
$$;

-- 일정 한 줄(또는 예외를 얹은 회차)의 칸 검사. 문제가 없으면 null, 있으면 한국어 이유.
-- 테이블 CHECK · 트리거 · sync · 예외가 모두 이것 하나를 쓴다
create function public.ez_event_problem(
  p_title text, p_date date, p_start int, p_end int, p_travel int, p_note text, p_where text, p_repeat jsonb
) returns text
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_title is null or p_title <> public.ez_trim(p_title) or char_length(p_title) not between 1 and 100 then
    return '제목은 앞뒤 공백 없이 1~100자로 써 주세요';
  end if;
  if p_date is null then
    return '날짜가 없습니다';
  end if;
  if (p_start is null) <> (p_end is null) then
    return '시작과 끝은 둘 다 쓰거나(시간 일정) 둘 다 비워야(종일) 합니다';
  end if;
  if p_start is not null then
    if p_start not between 0 and 1439 then
      return '시작은 0~1439분(00:00~23:59)이어야 합니다';
    end if;
    if p_end <= p_start or p_end > p_start + 1440 then
      return '끝은 시작보다 늦고, 길어도 24시간까지입니다';
    end if;
  end if;
  if p_travel is not null and p_travel not between 0 and 600 then
    return '이동시간(travel_min)은 0~600분입니다';
  end if;
  if p_note is not null and char_length(p_note) > 2000 then
    return format('메모는 2000자까지입니다 (지금 %s자)', char_length(p_note));
  end if;
  if p_where is not null and char_length(p_where) > 100 then
    return format('상세 장소(where_text)는 100자까지입니다 (지금 %s자)', char_length(p_where));
  end if;
  return public.ez_repeat_problem(p_repeat, p_date);
end;
$$;

-- 일정 칸을 담은 객체(예외 patch · split patch · sync 한 건)의 키와 값 모양 검사. 값의 범위는 ez_event_problem 이 본다.
-- start_min · end_min 은 같이 써야 한다 (한쪽만 바꾸면 원래 일정의 다른 쪽과 어긋날 수 있다)
create function public.ez_patch_problem(p jsonb, p_keys text[]) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_k text;
  v_v jsonb;
  v_t text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return '{칸: 값} 객체로 써 주세요';
  end if;
  for v_k, v_v in select e.key, e.value from jsonb_each(p) e loop
    if not (v_k = any (p_keys)) then
      return format('쓸 수 없는 칸입니다: %s (쓸 수 있는 칸: %s)', v_k, array_to_string(p_keys, ', '));
    end if;
    v_t := jsonb_typeof(v_v);
    if v_k = 'date' then
      if v_t <> 'string' or not public.ez_is_date(v_v #>> '{}') then
        return 'date 는 YYYY-MM-DD 로 써 주세요';
      end if;
    elsif v_k in ('start_min', 'end_min', 'travel_min') then
      if v_t <> 'null' and (v_t <> 'number' or v_v::text !~ '^-?[0-9]{1,9}$') then
        return format('%s 는 분 단위 정수로 써 주세요', v_k);
      end if;
    elsif v_k in ('title', 'external_id') then
      if v_t <> 'string' then
        return format('%s 는 글자로 써 주세요', v_k);
      end if;
    elsif v_k in ('where_text', 'note') then
      if v_t not in ('string', 'null') then
        return format('%s 는 글자 또는 null 로 써 주세요', v_k);
      end if;
    elsif v_k = 'place_id' then
      if v_t <> 'null' and (v_t <> 'string'
          or (v_v #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
        return 'place_id 는 지점 id(uuid) 또는 null 로 써 주세요';
      end if;
    elsif v_k = 'repeat' then
      if v_t not in ('object', 'null') then
        return 'repeat 는 null 또는 {freq, …} 로 써 주세요';
      end if;
    end if;
  end loop;
  if (p ? 'start_min') <> (p ? 'end_min') then
    return 'start_min 과 end_min 은 같이 써 주세요';
  end if;
  return null;
end;
$$;

-- 식사 창 {from, to, prefer}: 0 ≤ from < to ≤ 1440, from ≤ prefer ≤ to, 정수
create function public.ez_meal_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_from int;
  v_to   int;
  v_pref int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from array['from', 'prefer', 'to']
     or exists (select 1 from jsonb_each(p) e where jsonb_typeof(e.value) <> 'number' or e.value::text !~ '^[0-9]{1,4}$') then
    return false;
  end if;
  v_from := (p ->> 'from')::int;
  v_to := (p ->> 'to')::int;
  v_pref := (p ->> 'prefer')::int;
  return v_from < v_to and v_to <= 1440 and v_pref between v_from and v_to;
end;
$$;

-- sync 안인가 (ez_schedule_sync 가 트랜잭션 안에서만 켠다)
create function public.ez_in_sync() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(current_setting('ez.schedule_sync', true), '') = 'on'
$$;

-- 넣을 때 version 1, 고칠 때 무언가 바뀌었으면 version +1 · updated_at. id · 주인은 못 바꾼다 (지점 · 할 일 · 일정 공통)
create function public.ez_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if new.id is distinct from old.id or new.owner is distinct from old.owner then
    raise exception using errcode = 'P0001', message = '[EZ_FIXED] id · 주인은 바꿀 수 없습니다';
  end if;
  new.created_at := old.created_at;
  if (to_jsonb(new) - array['version', 'updated_at', 'created_at'])
     is distinct from (to_jsonb(old) - array['version', 'updated_at', 'created_at']) then
    new.version := old.version + 1;
    new.updated_at := now();
  else
    new.version := old.version;
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

create function public.ez_touch() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- ez_places 지점
-- ---------------------------------------------------------------------------

create table public.ez_places (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null default auth.uid(),
  name       text not null,
  role       text,
  symbol     text not null,
  color      text not null,
  sort       double precision not null default 0,
  version    int not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 일정 · 이동시간이 (owner, place) 로 걸어 같은 주인의 지점만 가리키게 한다
  constraint ez_places_owner_id_key unique (owner, id),
  constraint ez_places_name_check check (name = public.ez_trim(name) and char_length(name) between 1 and 30),
  constraint ez_places_role_check check (role is null or role in ('home', 'work', 'school')),
  constraint ez_places_symbol_check check (symbol in ('home', 'school', 'work', 'cafe', 'book', 'gym', 'hospital', 'cart', 'people', 'building', 'tree', 'pin')),
  constraint ez_places_color_check check (color in ('sky', 'violet', 'peach', 'sand', 'mint', 'pink', 'teal', 'yellow')),
  constraint ez_places_sort_check check (sort > '-Infinity'::float8 and sort < 'Infinity'::float8),
  constraint ez_places_version_check check (version >= 1)
);

-- 살아 있는 지점끼리 이름 겹침 금지 (대소문자 무시, 이름은 이미 trim). 집은 한 사람에 하나
create unique index ez_places_name_unique on public.ez_places (owner, lower(name)) where deleted_at is null;
create unique index ez_places_home_unique on public.ez_places (owner) where role = 'home' and deleted_at is null;

-- 심볼 · 색 기본값, 살아 있는 지점 12개 상한
create function public.ez_places_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.symbol := coalesce(new.symbol, case new.role when 'home' then 'home' when 'school' then 'school' when 'work' then 'work' else 'pin' end);
    if new.color is null then
      -- 살아 있는 지점이 덜 쓴 색부터, 같으면 정해진 순서
      select c.color into new.color
        from unnest(array['sky', 'violet', 'peach', 'sand', 'mint', 'pink', 'teal', 'yellow']) with ordinality as c(color, n)
       order by (select count(*) from public.ez_places p where p.owner = new.owner and p.deleted_at is null and p.color = c.color), c.n
       limit 1;
    end if;
  end if;

  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    perform pg_advisory_xact_lock(hashtextextended('ez_places:' || new.owner::text, 0));
    if (select count(*) from public.ez_places p
         where p.owner = new.owner and p.deleted_at is null and p.id <> new.id) >= 12 then
      raise exception using errcode = 'P0001', message = '[EZ_LIMIT] 지점은 12개까지 둘 수 있습니다. 안 쓰는 지점을 지우고 다시 하세요';
    end if;
  end if;
  return new;
end;
$$;

-- 지점을 지우면(deleted_at) 그 지점이 낀 이동시간도 지운다. 일정의 place_id 는 그대로 둔다(이름은 남는다)
create function public.ez_places_after() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from public.ez_travel t where t.owner = new.owner and (t.a = new.id or t.b = new.id);
  end if;
  return null;
end;
$$;

create trigger ez_places_guard before insert or update on public.ez_places
  for each row execute function public.ez_places_guard();
create trigger ez_places_stamp before insert or update on public.ez_places
  for each row execute function public.ez_stamp();

-- ---------------------------------------------------------------------------
-- ez_travel 이동시간 (방향 없음, a < b)
-- ---------------------------------------------------------------------------

create table public.ez_travel (
  owner   uuid not null default auth.uid(),
  a       uuid not null,
  b       uuid not null,
  minutes int not null,

  constraint ez_travel_pkey primary key (owner, a, b),
  constraint ez_travel_order_check check (a < b),
  constraint ez_travel_minutes_check check (minutes between 1 and 600),
  constraint ez_travel_a_fk foreign key (owner, a) references public.ez_places (owner, id) on delete cascade,
  constraint ez_travel_b_fk foreign key (owner, b) references public.ez_places (owner, id) on delete cascade
);

create index ez_travel_b_idx on public.ez_travel (owner, b);

create function public.ez_travel_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.ez_places p
              where p.owner = new.owner and p.id in (new.a, new.b) and p.deleted_at is not null) then
    raise exception using errcode = 'P0001', message = '[EZ_PLACE] 지운 지점에는 이동시간을 둘 수 없습니다';
  end if;
  return new;
end;
$$;

create trigger ez_places_after after update on public.ez_places
  for each row execute function public.ez_places_after();
create trigger ez_travel_guard before insert or update on public.ez_travel
  for each row execute function public.ez_travel_guard();

-- ---------------------------------------------------------------------------
-- ez_tasks 할 일 (플래너)
-- ---------------------------------------------------------------------------

create table public.ez_tasks (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid(),
  title       text not null,
  note        text,
  due         date,
  est_min     int,
  sort        double precision not null default 0,
  done_at     timestamptz,
  origin_kind text,
  origin_id   uuid,
  version     int not null default 1,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint ez_tasks_owner_id_key unique (owner, id),
  constraint ez_tasks_title_check check (title = public.ez_trim(title) and char_length(title) between 1 and 200),
  constraint ez_tasks_note_check check (note is null or char_length(note) <= 2000),
  constraint ez_tasks_est_check check (est_min is null or est_min between 5 and 600),
  constraint ez_tasks_sort_check check (sort > '-Infinity'::float8 and sort < 'Infinity'::float8),
  constraint ez_tasks_origin_check check ((origin_kind is null) = (origin_id is null)),
  constraint ez_tasks_origin_kind_check check (origin_kind is null or origin_kind in ('project', 'meet')),
  constraint ez_tasks_version_check check (version >= 1)
);

create index ez_tasks_owner_idx on public.ez_tasks (owner) where deleted_at is null;

create trigger ez_tasks_stamp before insert or update on public.ez_tasks
  for each row execute function public.ez_stamp();

-- ---------------------------------------------------------------------------
-- ez_events 일정
-- ---------------------------------------------------------------------------

create table public.ez_events (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid(),
  title       text not null,
  date        date not null,
  start_min   int,
  end_min     int,
  place_id    uuid,
  where_text  text,
  travel_min  int,
  note        text,
  repeat      jsonb,
  source      text,
  external_id text,
  task_id     uuid,
  origin_kind text,
  origin_id   uuid,
  version     int not null default 1,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- 제목 · 시각 · 이동 · 메모 · 상세 장소 · 반복: 규칙은 ez_event_problem 하나 (트리거가 먼저 한국어 이유로 거절한다)
  constraint ez_events_fields_check check (
    public.ez_event_problem(title, date, start_min, end_min, travel_min, note, where_text, repeat) is null
  ),
  constraint ez_events_source_check check ((source is null) = (external_id is null)),
  constraint ez_events_source_format_check check (source is null or source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  constraint ez_events_external_id_check check (external_id is null or char_length(external_id) between 1 and 200),
  constraint ez_events_origin_check check ((origin_kind is null) = (origin_id is null)),
  constraint ez_events_origin_kind_check check (origin_kind is null or origin_kind in ('project', 'meet')),
  constraint ez_events_version_check check (version >= 1),
  -- 같은 주인의 지점 · 할 일만. 지운(deleted_at) 지점도 가리킬 수 있다. 행이 정말 지워지면 그 칸만 null
  constraint ez_events_place_fk foreign key (owner, place_id) references public.ez_places (owner, id) on delete set null (place_id),
  constraint ez_events_task_fk foreign key (owner, task_id) references public.ez_tasks (owner, id) on delete set null (task_id)
);

create unique index ez_events_external_unique on public.ez_events (owner, source, external_id)
  where deleted_at is null and source is not null;
-- 할 일 하나에 살아 있는 일정은 하나
create unique index ez_events_task_unique on public.ez_events (task_id) where deleted_at is null and task_id is not null;
create index ez_events_owner_date_idx on public.ez_events (owner, date) where deleted_at is null;
create index ez_events_place_idx on public.ez_events (owner, place_id) where place_id is not null;
create index ez_events_task_idx on public.ez_events (owner, task_id) where task_id is not null;

create function public.ez_events_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_why text;
begin
  -- 바깥 일정: 넣기 · 고치기 · 지우기 모두 sync 안에서만. 내 일정을 바깥 일정으로 바꾸는 것도 마찬가지
  if (tg_op <> 'INSERT' and old.source is not null) or (tg_op <> 'DELETE' and new.source is not null) then
    if not public.ez_in_sync() then
      raise exception using errcode = 'P0001',
        message = format('[EZ_EXTERNAL] 바깥 일정(%s)은 여기서 고칠 수 없습니다. 출처에서 바꾼 뒤 ez_schedule_sync 로 맞추세요',
                         case when tg_op = 'INSERT' then new.source else old.source end);
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.task_id is not null and (tg_op = 'INSERT' or new.task_id is distinct from old.task_id)
     and exists (select 1 from public.ez_tasks t where t.id = new.task_id and t.owner = new.owner and t.deleted_at is not null) then
    raise exception using errcode = 'P0001', message = '[EZ_TASK] 지운 할 일에는 일정을 이을 수 없습니다';
  end if;

  v_why := public.ez_event_problem(new.title, new.date, new.start_min, new.end_min, new.travel_min, new.note, new.where_text, new.repeat);
  if v_why is not null then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] ' || v_why;
  end if;
  return new;
end;
$$;

-- 반복 규칙이나 시작 날짜가 바뀌면 더는 회차가 아닌 날의 예외를 지운다 ('반복 규칙을 바꾸면 이번만은 없다')
create function public.ez_events_after() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.repeat is distinct from old.repeat or new.date is distinct from old.date then
    delete from public.ez_event_exceptions x
     where x.event_id = new.id
       and (new.repeat is null or not public.ez_occurs_on(new.repeat, new.date, x.on_date));
  end if;
  return null;
end;
$$;

create trigger ez_events_guard before insert or update or delete on public.ez_events
  for each row execute function public.ez_events_guard();
create trigger ez_events_stamp before insert or update on public.ez_events
  for each row execute function public.ez_stamp();

-- ---------------------------------------------------------------------------
-- ez_event_exceptions 반복의 '이번만'
-- ---------------------------------------------------------------------------

create table public.ez_event_exceptions (
  event_id uuid not null references public.ez_events (id) on delete cascade,
  on_date  date not null,
  skip     boolean not null default false,
  patch    jsonb,

  constraint ez_event_exceptions_pkey primary key (event_id, on_date),
  -- 건너뛰기면 patch 없음, 아니면 patch 있음
  constraint ez_event_exceptions_kind_check check (skip = (patch is null))
);

create trigger ez_events_after after update on public.ez_events
  for each row execute function public.ez_events_after();

create function public.ez_event_exceptions_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev  public.ez_events%rowtype;
  v_m   public.ez_events%rowtype;
  v_why text;
begin
  if tg_op <> 'INSERT' then
    select * into v_ev from public.ez_events e where e.id = old.event_id;
    if found and v_ev.source is not null and not public.ez_in_sync() then
      raise exception using errcode = 'P0001', message = '[EZ_EXTERNAL] 바깥 일정의 회차는 따로 바꿀 수 없습니다';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  select * into v_ev from public.ez_events e where e.id = new.event_id;
  if not found then
    return new; -- 외래키가 거절한다
  end if;
  if v_ev.source is not null and not public.ez_in_sync() then
    raise exception using errcode = 'P0001', message = '[EZ_EXTERNAL] 바깥 일정의 회차는 따로 바꿀 수 없습니다';
  end if;
  if v_ev.deleted_at is not null then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 지운 일정입니다';
  end if;
  if v_ev.repeat is null then
    raise exception using errcode = 'P0001', message = '[EZ_REPEAT] 반복 일정이 아니라 회차를 따로 바꿀 수 없습니다. 일정을 직접 고치세요';
  end if;
  if not public.ez_occurs_on(v_ev.repeat, v_ev.date, new.on_date) then
    raise exception using errcode = 'P0001',
      message = format('[EZ_DATE] %s 는 이 일정이 반복되는 날이 아닙니다', new.on_date);
  end if;
  if new.skip then
    return new;
  end if;

  if new.patch is null or new.patch = '{}'::jsonb then
    raise exception using errcode = 'P0001', message = '[EZ_PATCH] 바꿀 칸이 없습니다 (건너뛰려면 skip)';
  end if;
  v_why := public.ez_patch_problem(new.patch,
    array['date', 'start_min', 'end_min', 'title', 'place_id', 'where_text', 'travel_min', 'note']);
  if v_why is not null then
    raise exception using errcode = 'P0001', message = '[EZ_PATCH] ' || v_why;
  end if;
  v_m := jsonb_populate_record(v_ev, new.patch);
  v_why := public.ez_event_problem(v_m.title, v_m.date, v_m.start_min, v_m.end_min, v_m.travel_min, v_m.note, v_m.where_text, null);
  if v_why is not null then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] ' || v_why;
  end if;
  if v_m.place_id is not null and new.patch ? 'place_id'
     and not exists (select 1 from public.ez_places p where p.id = v_m.place_id and p.owner = v_ev.owner) then
    raise exception using errcode = 'P0001', message = '[EZ_PLACE] 없는 지점입니다';
  end if;
  return new;
end;
$$;

create trigger ez_event_exceptions_guard before insert or update or delete on public.ez_event_exceptions
  for each row execute function public.ez_event_exceptions_guard();

-- ---------------------------------------------------------------------------
-- ez_schedule_settings 사람당 한 줄 · ez_sources 바깥 일정 출처
-- ---------------------------------------------------------------------------

create table public.ez_schedule_settings (
  owner      uuid primary key default auth.uid(),
  prep_first int not null default 35,
  prep_again int not null default 10,
  home_stay  int not null default 50,
  meal_min   int not null default 40,
  lunch      jsonb not null default '{"from": 660, "to": 840, "prefer": 720}',
  dinner     jsonb not null default '{"from": 1020, "to": 1230, "prefer": 1080}',
  tz         text not null default 'Asia/Seoul',
  updated_at timestamptz not null default now(),

  constraint ez_schedule_settings_prep_first_check check (prep_first between 0 and 120),
  constraint ez_schedule_settings_prep_again_check check (prep_again between 0 and 120),
  constraint ez_schedule_settings_home_stay_check check (home_stay between 0 and 600),
  constraint ez_schedule_settings_meal_min_check check (meal_min between 0 and 120),
  constraint ez_schedule_settings_lunch_check check (public.ez_meal_ok(lunch)),
  constraint ez_schedule_settings_dinner_check check (public.ez_meal_ok(dinner)),
  constraint ez_schedule_settings_tz_check check (tz ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$' and char_length(tz) <= 64)
);

create trigger ez_schedule_settings_touch before update on public.ez_schedule_settings
  for each row execute function public.ez_touch();

create table public.ez_sources (
  owner     uuid not null default auth.uid(),
  source    text not null,
  label     text,
  synced_at timestamptz,

  constraint ez_sources_pkey primary key (owner, source),
  constraint ez_sources_source_check check (source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  constraint ez_sources_label_check check (label is null or (label = public.ez_trim(label) and char_length(label) between 1 and 30))
);

-- ---------------------------------------------------------------------------
-- RLS: 내 것만. 예외는 부모 일정의 주인
-- ---------------------------------------------------------------------------

alter table public.ez_places enable row level security;
alter table public.ez_travel enable row level security;
alter table public.ez_tasks enable row level security;
alter table public.ez_events enable row level security;
alter table public.ez_event_exceptions enable row level security;
alter table public.ez_schedule_settings enable row level security;
alter table public.ez_sources enable row level security;

create policy ez_places_select on public.ez_places for select to authenticated using (owner = (select auth.uid()));
create policy ez_places_insert on public.ez_places for insert to authenticated with check (owner = (select auth.uid()));
create policy ez_places_update on public.ez_places for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

create policy ez_travel_select on public.ez_travel for select to authenticated using (owner = (select auth.uid()));
create policy ez_travel_insert on public.ez_travel for insert to authenticated with check (owner = (select auth.uid()));
create policy ez_travel_update on public.ez_travel for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy ez_travel_delete on public.ez_travel for delete to authenticated using (owner = (select auth.uid()));

create policy ez_tasks_select on public.ez_tasks for select to authenticated using (owner = (select auth.uid()));
create policy ez_tasks_insert on public.ez_tasks for insert to authenticated with check (owner = (select auth.uid()));
create policy ez_tasks_update on public.ez_tasks for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

create policy ez_events_select on public.ez_events for select to authenticated using (owner = (select auth.uid()));
create policy ez_events_insert on public.ez_events for insert to authenticated with check (owner = (select auth.uid()));
create policy ez_events_update on public.ez_events for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

create policy ez_event_exceptions_select on public.ez_event_exceptions for select to authenticated
  using (exists (select 1 from public.ez_events e where e.id = event_id and e.owner = (select auth.uid())));
create policy ez_event_exceptions_insert on public.ez_event_exceptions for insert to authenticated
  with check (exists (select 1 from public.ez_events e where e.id = event_id and e.owner = (select auth.uid())));
create policy ez_event_exceptions_update on public.ez_event_exceptions for update to authenticated
  using (exists (select 1 from public.ez_events e where e.id = event_id and e.owner = (select auth.uid())))
  with check (exists (select 1 from public.ez_events e where e.id = event_id and e.owner = (select auth.uid())));
create policy ez_event_exceptions_delete on public.ez_event_exceptions for delete to authenticated
  using (exists (select 1 from public.ez_events e where e.id = event_id and e.owner = (select auth.uid())));

create policy ez_schedule_settings_select on public.ez_schedule_settings for select to authenticated
  using (owner = (select auth.uid()));
create policy ez_schedule_settings_insert on public.ez_schedule_settings for insert to authenticated
  with check (owner = (select auth.uid()));
create policy ez_schedule_settings_update on public.ez_schedule_settings for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

create policy ez_sources_select on public.ez_sources for select to authenticated using (owner = (select auth.uid()));
create policy ez_sources_insert on public.ez_sources for insert to authenticated with check (owner = (select auth.uid()));
create policy ez_sources_update on public.ez_sources for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 바깥 일정 갈아끼우기
-- 그 주인 · 출처에서 date 가 [p_from, p_to] 인 살아 있는 일정을 events 로 갈아끼운다. 한 트랜잭션.
-- external_id 가 같으면 고치고(바뀐 게 있을 때만 updated), 목록에 없으면 지우고(soft), 새 것은 넣는다. 기간 밖은 그대로.
-- 한 건이라도 잘못되면 아무것도 바꾸지 않고 '[EZ_SYNC] …' (detail 에 [{index, external_id, reason}] JSON)
-- ---------------------------------------------------------------------------

-- sync 한 건의 문제. 없으면 null
create function public.ez_sync_problem(e jsonb, p_from date, p_to date, p_owner uuid) returns text
language plpgsql stable
set search_path = public
as $$
declare
  v_why text;
  v_r   public.ez_events%rowtype;
begin
  if jsonb_typeof(e) is distinct from 'object' then
    return '일정 하나는 {external_id, title, date, …} 객체여야 합니다';
  end if;
  v_why := public.ez_patch_problem(e,
    array['external_id', 'title', 'date', 'start_min', 'end_min', 'place_id', 'where_text', 'travel_min', 'note', 'repeat']);
  if v_why is not null then
    return v_why;
  end if;
  if not (e ? 'external_id') or char_length(e ->> 'external_id') not between 1 and 200 then
    return 'external_id(바깥 쪽 id)를 1~200자로 써 주세요';
  end if;
  if not (e ? 'title') then
    return '제목(title)이 없습니다';
  end if;
  if not (e ? 'date') then
    return '날짜(date)가 없습니다';
  end if;
  v_r := jsonb_populate_record(null::public.ez_events, e);
  if v_r.date not between p_from and p_to then
    return format('날짜 %s 가 맞출 기간(%s ~ %s) 밖입니다', v_r.date, p_from, p_to);
  end if;
  v_why := public.ez_event_problem(v_r.title, v_r.date, v_r.start_min, v_r.end_min, v_r.travel_min, v_r.note, v_r.where_text, v_r.repeat);
  if v_why is not null then
    return v_why;
  end if;
  if v_r.place_id is not null and not exists (
    select 1 from public.ez_places p where p.id = v_r.place_id and p.owner = p_owner and p.deleted_at is null
  ) then
    return '없는 지점입니다 (place_id)';
  end if;
  return null;
end;
$$;

create function public.ez_schedule_sync(
  source text, p_from date, p_to date, events jsonb, p_label text default null, p_as uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid    uuid := public.ez_actor(p_as);
  v_src    text := ez_schedule_sync.source;
  v_events jsonb := ez_schedule_sync.events;
  v_label  text := public.ez_trim(p_label);
  v_bad    jsonb := '[]'::jsonb;
  v_seen   text[] := '{}';
  v_e      jsonb;
  v_i      int;
  v_why    text;
  v_r      public.ez_events%rowtype;
  v_ins    int := 0;
  v_upd    int := 0;
  v_del    int := 0;
  v_n      int;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = '[EZ_AUTH] 누구의 일정인지 모릅니다 (로그인하거나 service_role 이면 p_as)';
  end if;
  if v_src is null or v_src !~ '^[a-z0-9][a-z0-9_-]{0,39}$' then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 출처(source)는 영문 소문자 · 숫자 · _ · - 로 1~40자입니다 (예: studycube)';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using errcode = 'P0001', message = '[EZ_RANGE] 기간이 잘못됐습니다 (p_from ≤ p_to)';
  end if;
  if p_to - p_from + 1 > 200 then
    raise exception using errcode = 'P0001',
      message = format('[EZ_RANGE] 한 번에 200일까지 맞출 수 있습니다 (지금 %s일). 나눠서 부르세요', p_to - p_from + 1);
  end if;
  if v_events is null or jsonb_typeof(v_events) <> 'array' then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] events 는 배열이어야 합니다';
  end if;
  if jsonb_array_length(v_events) > 500 then
    raise exception using errcode = 'P0001',
      message = format('[EZ_LIMIT] 한 번에 500개까지 맞출 수 있습니다 (지금 %s개). 기간을 나눠 부르세요', jsonb_array_length(v_events));
  end if;
  if p_label is not null and (v_label = '' or char_length(v_label) > 30) then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 출처 이름(p_label)은 1~30자입니다';
  end if;

  -- 먼저 전부 검사. 하나라도 틀리면 아무것도 안 바꾼다
  for v_e, v_i in select x.value, (x.n - 1)::int from jsonb_array_elements(v_events) with ordinality as x(value, n) loop
    v_why := public.ez_sync_problem(v_e, p_from, p_to, v_uid);
    if v_why is null then
      if (v_e ->> 'external_id') = any (v_seen) then
        v_why := format('external_id %s 가 목록에 두 번 있습니다', v_e ->> 'external_id');
      end if;
      v_seen := v_seen || (v_e ->> 'external_id');
    end if;
    if v_why is not null then
      v_bad := v_bad || jsonb_build_array(jsonb_build_object('index', v_i, 'external_id', v_e -> 'external_id', 'reason', v_why));
    end if;
  end loop;
  if jsonb_array_length(v_bad) > 0 then
    raise exception using errcode = 'P0001',
      message = format('[EZ_SYNC] %s건이 잘못돼 아무것도 바꾸지 않았습니다. %s', jsonb_array_length(v_bad),
        (select string_agg(format('events[%s]: %s', b ->> 'index', b ->> 'reason'), ' / ' order by n)
           from jsonb_array_elements(v_bad) with ordinality as y(b, n) where n <= 10)
        || case when jsonb_array_length(v_bad) > 10 then ' / …' else '' end),
      detail = v_bad::text;
  end if;

  -- 같은 주인 · 출처의 sync 는 줄 세운다
  perform pg_advisory_xact_lock(hashtextextended('ez_schedule_sync:' || v_uid::text || ':' || v_src, 0));
  perform set_config('ez.schedule_sync', 'on', true);

  update public.ez_events e set deleted_at = now()
   where e.owner = v_uid and e.source = v_src and e.deleted_at is null
     and e.date between p_from and p_to
     and not (e.external_id = any (v_seen));
  get diagnostics v_del = row_count;

  for v_e in select x.value from jsonb_array_elements(v_events) as x(value) loop
    v_r := jsonb_populate_record(null::public.ez_events, v_e);
    -- 같은 external_id 의 살아 있는 일정이 있으면 (기간 밖에 있었어도) 고친다
    update public.ez_events e
       set title = v_r.title, date = v_r.date, start_min = v_r.start_min, end_min = v_r.end_min,
           place_id = v_r.place_id, where_text = v_r.where_text, travel_min = v_r.travel_min,
           note = v_r.note, repeat = v_r.repeat
     where e.owner = v_uid and e.source = v_src and e.external_id = v_r.external_id and e.deleted_at is null
       and (e.title, e.date, e.start_min, e.end_min, e.place_id, e.where_text, e.travel_min, e.note, e.repeat)
           is distinct from
           (v_r.title, v_r.date, v_r.start_min, v_r.end_min, v_r.place_id, v_r.where_text, v_r.travel_min, v_r.note, v_r.repeat);
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_upd := v_upd + 1;
    elsif not exists (
      select 1 from public.ez_events e
       where e.owner = v_uid and e.source = v_src and e.external_id = v_r.external_id and e.deleted_at is null
    ) then
      insert into public.ez_events (owner, title, date, start_min, end_min, place_id, where_text, travel_min, note, repeat,
                                    source, external_id)
      values (v_uid, v_r.title, v_r.date, v_r.start_min, v_r.end_min, v_r.place_id, v_r.where_text, v_r.travel_min,
              v_r.note, v_r.repeat, v_src, v_r.external_id);
      v_ins := v_ins + 1;
    end if;
  end loop;

  insert into public.ez_sources as s (owner, source, label, synced_at)
  values (v_uid, v_src, v_label, now())
  on conflict on constraint ez_sources_pkey
  do update set synced_at = excluded.synced_at, label = coalesce(excluded.label, s.label);

  perform set_config('ez.schedule_sync', '', true);
  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'deleted', v_del);
end;
$$;

-- ---------------------------------------------------------------------------
-- 반복 일정 '이후 모두'
-- ---------------------------------------------------------------------------

-- 고칠 일정을 잠그고 검사: 살아 있는 내 일정 · 바깥 일정 아님 · 버전 · on_date 가 회차
create function public.ez_event_lock(p_id uuid, p_base int, p_on date, p_uid uuid) returns public.ez_events
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.ez_events%rowtype;
begin
  select * into v_row from public.ez_events e
   where e.id = p_id and e.owner = p_uid and p_uid is not null and e.deleted_at is null
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 고칠 일정이 없습니다';
  end if;
  if v_row.source is not null then
    raise exception using errcode = 'P0001',
      message = format('[EZ_EXTERNAL] 바깥 일정(%s)은 여기서 고칠 수 없습니다. 출처에서 바꾼 뒤 ez_schedule_sync 로 맞추세요', v_row.source);
  end if;
  if p_base is distinct from v_row.version then
    raise exception using errcode = 'P0001',
      message = format('[EZ_VERSION] 그 사이 다른 곳에서 이 일정을 고쳤습니다. 새로 불러오세요 (지금 버전 %s)', v_row.version);
  end if;
  if not public.ez_occurs_on(v_row.repeat, v_row.date, p_on) then
    raise exception using errcode = 'P0001', message = format('[EZ_DATE] %s 는 이 일정의 회차가 아닙니다', p_on);
  end if;
  return v_row;
end;
$$;

-- on_date 회차부터 patch 를 얹어 새 일정으로 나눈다. 원래 일정은 on_date 전날까지.
-- patch 키: date · start_min · end_min · title · place_id · where_text · travel_min · note · repeat
--   repeat 이 있으면 새 일정의 반복, 없으면 원래 반복(until 포함). date 가 없으면 on_date 부터.
-- on_date 이후 예외는 새 일정으로 옮긴다(새 반복의 회차가 아닌 것은 지운다). 할 일 연결(task_id)은 원래 일정에 남는다.
-- on_date 가 첫 회차면 나누지 않고 원래 일정을 고친다. 반환: 새(또는 고친) 일정
create function public.ez_event_split(id uuid, base_version int, on_date date, patch jsonb, p_as uuid default null)
returns public.ez_events
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id    uuid := ez_event_split.id;
  v_on    date := ez_event_split.on_date;
  v_patch jsonb := ez_event_split.patch;
  v_old   public.ez_events%rowtype;
  v_new   public.ez_events%rowtype;
  v_why   text;
begin
  v_old := public.ez_event_lock(v_id, ez_event_split.base_version, v_on, public.ez_actor(p_as));
  if v_patch is null or jsonb_typeof(v_patch) = 'null' then
    v_patch := '{}'::jsonb;
  end if;
  v_why := public.ez_patch_problem(v_patch,
    array['date', 'start_min', 'end_min', 'title', 'place_id', 'where_text', 'travel_min', 'note', 'repeat']);
  if v_why is not null then
    raise exception using errcode = 'P0001', message = '[EZ_PATCH] ' || v_why;
  end if;

  if v_on = public.ez_first_on(v_old.repeat, v_old.date) then
    v_new := jsonb_populate_record(v_old, v_patch);
    update public.ez_events e
       set title = v_new.title, date = v_new.date, start_min = v_new.start_min, end_min = v_new.end_min,
           place_id = v_new.place_id, where_text = v_new.where_text, travel_min = v_new.travel_min,
           note = v_new.note, repeat = v_new.repeat
     where e.id = v_id
    returning e.* into v_new;
    return v_new;
  end if;

  v_new := jsonb_populate_record(v_old, jsonb_build_object('date', v_on) || v_patch);
  insert into public.ez_events (owner, title, date, start_min, end_min, place_id, where_text, travel_min, note, repeat,
                                origin_kind, origin_id)
  values (v_old.owner, v_new.title, v_new.date, v_new.start_min, v_new.end_min, v_new.place_id, v_new.where_text,
          v_new.travel_min, v_new.note, v_new.repeat, v_old.origin_kind, v_old.origin_id)
  returning * into v_new;

  update public.ez_event_exceptions x set event_id = v_new.id
   where x.event_id = v_id and x.on_date >= v_on
     and v_new.repeat is not null and public.ez_occurs_on(v_new.repeat, v_new.date, x.on_date);
  delete from public.ez_event_exceptions x where x.event_id = v_id and x.on_date >= v_on;

  update public.ez_events e
     set repeat = jsonb_set(e.repeat, '{until}', to_jsonb((v_on - 1)::text))
   where e.id = v_id;
  return v_new;
end;
$$;

-- on_date 회차부터 모두 지우기: 원래 일정은 on_date 전날까지, on_date 이후 예외는 지운다.
-- on_date 가 첫 회차면 일정을 지운다(soft). 반환: 고친(또는 지운) 일정
create function public.ez_event_cut(id uuid, base_version int, on_date date, p_as uuid default null)
returns public.ez_events
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id  uuid := ez_event_cut.id;
  v_on  date := ez_event_cut.on_date;
  v_row public.ez_events%rowtype;
begin
  v_row := public.ez_event_lock(v_id, ez_event_cut.base_version, v_on, public.ez_actor(p_as));

  if v_on = public.ez_first_on(v_row.repeat, v_row.date) then
    update public.ez_events e set deleted_at = now() where e.id = v_id returning e.* into v_row;
    return v_row;
  end if;

  delete from public.ez_event_exceptions x where x.event_id = v_id and x.on_date >= v_on;
  update public.ez_events e
     set repeat = jsonb_set(e.repeat, '{until}', to_jsonb((v_on - 1)::text))
   where e.id = v_id
  returning e.* into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 권한: 0001 과 같이 기본(public) 회수 후 필요한 역할에만. anon 은 아무것도 없다
-- 지점 · 할 일 · 일정은 지우기도 soft(deleted_at) — authenticated 에 delete 를 주지 않는다
-- ---------------------------------------------------------------------------

revoke all on table public.ez_places from public, anon, authenticated;
revoke all on table public.ez_travel from public, anon, authenticated;
revoke all on table public.ez_tasks from public, anon, authenticated;
revoke all on table public.ez_events from public, anon, authenticated;
revoke all on table public.ez_event_exceptions from public, anon, authenticated;
revoke all on table public.ez_schedule_settings from public, anon, authenticated;
revoke all on table public.ez_sources from public, anon, authenticated;

grant select, insert, update on table public.ez_places to authenticated;
grant select, insert, update, delete on table public.ez_travel to authenticated;
grant select, insert, update on table public.ez_tasks to authenticated;
grant select, insert, update on table public.ez_events to authenticated;
grant select, insert, update, delete on table public.ez_event_exceptions to authenticated;
grant select, insert, update on table public.ez_schedule_settings to authenticated;
grant select, insert, update on table public.ez_sources to authenticated;

-- MCP(service_role): RLS 를 우회해 직접 쓰고 owner 를 명시한다. 규칙은 트리거 · CHECK · 인덱스가 그대로 지킨다
grant select, insert, update, delete on table public.ez_places to service_role;
grant select, insert, update, delete on table public.ez_travel to service_role;
grant select, insert, update, delete on table public.ez_tasks to service_role;
grant select, insert, update, delete on table public.ez_events to service_role;
grant select, insert, update, delete on table public.ez_event_exceptions to service_role;
grant select, insert, update, delete on table public.ez_schedule_settings to service_role;
grant select, insert, update, delete on table public.ez_sources to service_role;

revoke all on function public.ez_is_date(text) from public, anon, authenticated;
revoke all on function public.ez_repeat_problem(jsonb, date) from public, anon, authenticated;
revoke all on function public.ez_occurs_on(jsonb, date, date) from public, anon, authenticated;
revoke all on function public.ez_first_on(jsonb, date) from public, anon, authenticated;
revoke all on function public.ez_event_problem(text, date, int, int, int, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.ez_patch_problem(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.ez_meal_ok(jsonb) from public, anon, authenticated;
revoke all on function public.ez_in_sync() from public, anon, authenticated;
revoke all on function public.ez_stamp() from public, anon, authenticated;
revoke all on function public.ez_touch() from public, anon, authenticated;
revoke all on function public.ez_places_guard() from public, anon, authenticated;
revoke all on function public.ez_places_after() from public, anon, authenticated;
revoke all on function public.ez_travel_guard() from public, anon, authenticated;
revoke all on function public.ez_events_guard() from public, anon, authenticated;
revoke all on function public.ez_events_after() from public, anon, authenticated;
revoke all on function public.ez_event_exceptions_guard() from public, anon, authenticated;
revoke all on function public.ez_sync_problem(jsonb, date, date, uuid) from public, anon, authenticated;
revoke all on function public.ez_schedule_sync(text, date, date, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.ez_event_lock(uuid, int, date, uuid) from public, anon, authenticated;
revoke all on function public.ez_event_split(uuid, int, date, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.ez_event_cut(uuid, int, date, uuid) from public, anon, authenticated;

-- CHECK · 함수 안에서 부르는 검사 도우미는 테이블을 쓰는 역할이 실행할 수 있어야 한다
grant execute on function public.ez_is_date(text) to authenticated, service_role;
grant execute on function public.ez_repeat_problem(jsonb, date) to authenticated, service_role;
grant execute on function public.ez_occurs_on(jsonb, date, date) to authenticated, service_role;
grant execute on function public.ez_first_on(jsonb, date) to authenticated, service_role;
grant execute on function public.ez_event_problem(text, date, int, int, int, text, text, jsonb) to authenticated, service_role;
grant execute on function public.ez_patch_problem(jsonb, text[]) to authenticated, service_role;
grant execute on function public.ez_meal_ok(jsonb) to authenticated, service_role;
grant execute on function public.ez_sync_problem(jsonb, date, date, uuid) to authenticated, service_role;
grant execute on function public.ez_schedule_sync(text, date, date, jsonb, text, uuid) to authenticated, service_role;
grant execute on function public.ez_event_lock(uuid, int, date, uuid) to authenticated, service_role;
grant execute on function public.ez_event_split(uuid, int, date, jsonb, uuid) to authenticated, service_role;
grant execute on function public.ez_event_cut(uuid, int, date, uuid) to authenticated, service_role;
