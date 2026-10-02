-- 모임 — 시간 맞추기의 공개 쪽 (docs/모임.md 2장 'DB 함수', 9장 '나'). 0011 위에 더한다.
--
-- 남(anon)이 부르는 함수 4개: ez_meet_public (읽기) · ez_meet_enter (들어오기 · 핀) · ez_meet_answer (되는 칸) · ez_meet_rsvp (온다 / 못 온다)
-- 주최자가 부르는 함수 2개:   ez_meet_link (공개 링크 켜기 · 끄기) · ez_meet_pin_clear (그 사람의 핀 지우기)
-- 더하는 열:                  ez_meet_people.has_pin (핀이 있는지 여부만 — 주최자가 읽는다)
-- 더하는 검사 · 트리거:        ez_cells_ok (칸의 생김새) · ez_meets_poll_after (맞추기를 켜면 내 줄이 자동 채움 상태가 된다)
--
-- anon 은 테이블에 권한이 하나도 없다. 위 4개만 security definer 로 열고, 그 안에서 열쇠(22자) → 모임을 찾는다.
-- 핀은 sha256(salt ‖ pin) 으로만 두고 어떤 함수도 그 값을 밖으로 안 준다. 5번 틀리면 10분 잠근다.
-- 틀린 핀 · 잠김은 예외를 던지지 않고 {"error": {code, message}} 를 돌려준다 — 예외를 던지면 틀린 횟수를 올린 것까지 되돌아가기 때문이다.
-- security definer 함수는 search_path 를 고정한다 (public, pg_temp — 임시 스키마를 맨 뒤로).

-- ---------------------------------------------------------------------------
-- 핀이 있는지 여부 (주최자가 읽는다 — 핀 칸 자체는 읽을 권한이 없다)
-- ---------------------------------------------------------------------------

alter table public.ez_meet_people
  add column has_pin boolean generated always as (pin_hash is not null) stored;

grant select (has_pin) on table public.ez_meet_people to authenticated;

-- ---------------------------------------------------------------------------
-- 칸의 생김새: {"YYYY-MM-DD": [시작 분, …]} — 날짜 100개까지, 날짜마다 48칸까지, 30분 단위 0~1410, 이른 순 · 겹침 없음.
-- 후보 날짜 · 하루 범위 안인지는 설정에 달린 것이라 여기서 안 본다 (남의 칸은 ez_meet_answer 가 본다.
-- 설정을 줄여 밖으로 나간 칸은 지우지 않으므로 날짜가 후보보다 많을 수 있다)
-- ---------------------------------------------------------------------------

create function public.ez_cells_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  r      record;
  v_prev int;
  v_x    jsonb;
  v_n    int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(p)) > 100 then
    return false;
  end if;
  for r in select e.key, e.value from jsonb_each(p) e loop
    if not public.ez_is_date(r.key) or jsonb_typeof(r.value) <> 'array' or jsonb_array_length(r.value) > 48 then
      return false;
    end if;
    v_prev := -1;
    for v_x in select a.value from jsonb_array_elements(r.value) with ordinality as a(value, n) order by a.n loop
      if jsonb_typeof(v_x) <> 'number' or v_x::text !~ '^[0-9]{1,4}$' then
        return false;
      end if;
      v_n := (v_x #>> '{}')::int;
      if v_n % 30 <> 0 or v_n > 1410 or v_n <= v_prev then
        return false;
      end if;
      v_prev := v_n;
    end loop;
  end loop;
  return true;
end;
$$;

alter table public.ez_meet_people
  add constraint ez_meet_people_cells_shape_check check (cells is null or public.ez_cells_ok(cells));

-- ---------------------------------------------------------------------------
-- 맞추기를 켜면(만들 때 · 나중에) 아직 안 칠한 내 줄이 자동 채움 상태가 된다 (docs/모임.md 3장).
-- 칸은 화면 · MCP 가 일정에서 계산해 넣는다 — DB 는 일정을 계산하지 않는다.
-- 이름순으로 ez_meets_after(내 줄을 만든다) 다음에 돈다
-- ---------------------------------------------------------------------------

create function public.ez_meets_poll_after() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.poll is not null and (tg_op = 'INSERT' or old.poll is null) then
    update public.ez_meet_people p set auto = true
     where p.meet_id = new.id and p.is_owner and p.cells is null and not p.auto;
  end if;
  return null;
end;
$$;

create trigger ez_meets_poll_after after insert or update on public.ez_meets
  for each row execute function public.ez_meets_poll_after();

-- ---------------------------------------------------------------------------
-- 안에서만 쓰는 도우미 (누구에게도 실행 권한을 주지 않는다 — security definer 함수 안에서만 불린다)
-- ---------------------------------------------------------------------------

-- 열쇠 → 살아 있는 모임의 id. 없거나 끈 링크 · 지운 모임이면 null
create function public.ez_meet_id(p_token text) returns uuid
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select m.id from public.ez_meets m
   where p_token is not null
     and p_token ~ '^[A-Za-z0-9_-]{22}$'
     and m.token = p_token
     and m.deleted_at is null
$$;

-- 공개 페이지가 읽는 모양. 나가는 것은 여기 적힌 것이 전부다:
--   제목 · 지점 이름 · 장소 글 · 정해진 시간 · 맞추기 설정 · 사람들(이름 · 내 줄 여부 · 칸 · 참석 · 핀이 있는지)
-- id · owner · 메모 · 일정 · 묶음 · 열쇠 · 핀 값 · 틀린 횟수 · 잠긴 시각은 싣지 않는다
create function public.ez_meet_snapshot(p_meet uuid) returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'title', m.title,
    'place', (select pl.name from public.ez_places pl where pl.id = m.place_id and pl.owner = m.owner),
    'where', m.place_text,
    'meet_date', m.meet_date,
    'start_min', m.start_min,
    'end_min', m.end_min,
    'poll', m.poll,
    'people', coalesce((
      select jsonb_agg(
               jsonb_build_object('name', p.name, 'is_owner', p.is_owner, 'cells', p.cells, 'attend', p.attend, 'has_pin', p.pin_hash is not null)
               order by p.is_owner desc, p.created_at, p.id)
        from public.ez_meet_people p where p.meet_id = m.id
    ), '[]'::jsonb)
  )
  from public.ez_meets m where m.id = p_meet
$$;

create function public.ez_pin_hash(p_salt text, p_pin text) returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_salt || p_pin, 'UTF8')), 'hex')
$$;

-- 이름 + 핀 확인. 결과: person(통과한 사람 줄) 또는 error({code, message}) 중 하나.
--   p_set = true (들어오기): 그 이름이 없으면 새 줄 + 핀 설정, 있는데 핀이 없으면(미리 넣어 둔 사람 · 지워 준 사람) 핀 설정
--   p_set = false (칠하기 · 참석): 핀이 있는 사람만
-- 틀리면 횟수를 올리고 5번째에 10분 잠근다. 잠긴 동안에는 맞는 핀도 안 받는다.
-- 내 줄(주최자)은 이 길로 못 들어온다. 입력이 규칙 밖이면(이름 길이 · 핀 모양) 예외
create function public.ez_meet_pin_check(p_meet uuid, p_name text, p_pin text, p_set boolean, out person uuid, out error jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name  text := public.ez_trim(coalesce(p_name, ''));
  v_p     public.ez_meet_people%rowtype;
  v_salt  text;
  v_fails int;
begin
  if char_length(v_name) not between 1 and 20 then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 이름은 1~20자입니다';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 핀번호는 숫자 4~6자리입니다';
  end if;

  select * into v_p from public.ez_meet_people p
   where p.meet_id = p_meet and public.ez_name_key(p.name) = public.ez_name_key(v_name)
   for update;

  if not found then
    if not p_set then
      error := jsonb_build_object('code', 'EZ_PIN', 'message', '그 이름으로 들어온 적이 없습니다. 다시 들어와 주세요');
      return;
    end if;
    v_salt := encode(uuid_send(gen_random_uuid()), 'hex');
    -- 50명 상한 · 이름 겹침(동시에 같은 이름)은 0011 의 트리거 · 인덱스가 거절한다
    insert into public.ez_meet_people (meet_id, name, pin_salt, pin_hash)
    values (p_meet, v_name, v_salt, public.ez_pin_hash(v_salt, p_pin))
    returning id into person;
    return;
  end if;

  if v_p.is_owner then
    raise exception using errcode = 'P0001', message = '[EZ_OWNER] 주최자의 이름입니다. 다른 이름을 적어 주세요';
  end if;

  if v_p.pin_hash is null then
    if not p_set then
      error := jsonb_build_object('code', 'EZ_PIN', 'message', '핀번호가 지워졌습니다. 다시 들어와 새로 정해 주세요');
      return;
    end if;
    v_salt := encode(uuid_send(gen_random_uuid()), 'hex');
    update public.ez_meet_people p
       set pin_salt = v_salt, pin_hash = public.ez_pin_hash(v_salt, p_pin), pin_fails = 0, pin_locked_until = null
     where p.id = v_p.id;
    person := v_p.id;
    return;
  end if;

  if v_p.pin_locked_until is not null and v_p.pin_locked_until > now() then
    error := jsonb_build_object('code', 'EZ_LOCKED', 'message', '핀번호를 5번 틀렸습니다. 10분 뒤에 다시 해 주세요');
    return;
  end if;

  if v_p.pin_hash = public.ez_pin_hash(v_p.pin_salt, p_pin) then
    if v_p.pin_fails <> 0 or v_p.pin_locked_until is not null then
      update public.ez_meet_people p set pin_fails = 0, pin_locked_until = null where p.id = v_p.id;
    end if;
    person := v_p.id;
    return;
  end if;

  -- 틀림. 잠금이 풀린 뒤라면 처음부터 다시 센다
  v_fails := (case when v_p.pin_locked_until is not null then 0 else v_p.pin_fails end) + 1;
  if v_fails >= 5 then
    update public.ez_meet_people p set pin_fails = 0, pin_locked_until = now() + interval '10 minutes' where p.id = v_p.id;
    error := jsonb_build_object('code', 'EZ_LOCKED', 'message', '핀번호를 5번 틀렸습니다. 10분 뒤에 다시 해 주세요');
  else
    update public.ez_meet_people p set pin_fails = v_fails, pin_locked_until = null where p.id = v_p.id;
    error := jsonb_build_object('code', 'EZ_PIN', 'message', '핀번호가 다릅니다. 잊었으면 주최자에게 지워 달라고 하세요');
  end if;
end;
$$;

-- 보낸 칸(p_new — 이미 검사를 거친 것)에, 지금 설정 밖으로 나가 있는 옛 칸을 더한다 (설정을 다시 넓히면 살아나게 — 7장).
-- 날짜순 · 이른 순 · 겹침 없이. 빈 날짜는 뺀다
create function public.ez_cells_merge(p_old jsonb, p_new jsonb, p_poll jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  with cell as (
    select e.key as d, (a.value #>> '{}')::int as v
      from jsonb_each(coalesce(p_old, '{}'::jsonb)) e, jsonb_array_elements(e.value) a
     where not ((p_poll -> 'dates') ? e.key)
        or (a.value #>> '{}')::int < (p_poll ->> 'day_from')::int
        or (a.value #>> '{}')::int > (p_poll ->> 'day_to')::int - 30
    union
    select e.key, (a.value #>> '{}')::int
      from jsonb_each(p_new) e, jsonb_array_elements(e.value) a
  ), per as (
    select d, jsonb_agg(v order by v) as arr from cell group by d
  )
  select coalesce(jsonb_object_agg(d, arr), '{}'::jsonb) from per
$$;

-- ---------------------------------------------------------------------------
-- 남(anon)이 부르는 함수
-- ---------------------------------------------------------------------------

-- 공개 페이지가 읽는 것. 없는 열쇠 · 끈 링크 · 지운 모임은 null (있었는지 드러내지 않는다)
create function public.ez_meet_public(p_token text) returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select public.ez_meet_snapshot(public.ez_meet_id(p_token))
$$;

-- 들어오기. 결과: {"me": 이름, "meet": 공개 모양} 또는 {"error": {code, message}} (EZ_PIN · EZ_LOCKED)
create function public.ez_meet_enter(p_token text, p_name text, p_pin text) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.ez_meet_id(p_token);
  v_r  record;
begin
  if v_id is null then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 없는 링크입니다';
  end if;
  select * into v_r from public.ez_meet_pin_check(v_id, p_name, p_pin, true);
  if v_r.error is not null then
    return jsonb_build_object('error', v_r.error);
  end if;
  return jsonb_build_object(
    'me', (select p.name from public.ez_meet_people p where p.id = v_r.person),
    'meet', public.ez_meet_snapshot(v_id));
end;
$$;

-- 되는 칸 저장: 핀 확인 → 맞추는 중인지 → 칸이 30분 단위이고 후보 날짜 · 하루 범위 안인지. 결과로 전체를 다시 준다.
-- 보낸 칸이 그 사람의 (지금 설정 안의) 칸을 통째로 갈아끼운다. 크기: 글자 2만 자 · 날짜 31 × 하루 48칸
create function public.ez_meet_answer(p_token text, p_name text, p_pin text, p_cells jsonb) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id    uuid := public.ez_meet_id(p_token);
  v_m     public.ez_meets%rowtype;
  v_r     record;
  v_e     record;
  v_x     jsonb;
  v_n     int;
  v_from  int;
  v_to    int;
  v_old   jsonb;
  v_cells jsonb;
begin
  if v_id is null then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 없는 링크입니다';
  end if;
  if p_cells is null or jsonb_typeof(p_cells) <> 'object' or length(p_cells::text) > 20000 then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 칸은 {"날짜": [시작 분, …]} 으로 보냅니다';
  end if;

  select * into v_r from public.ez_meet_pin_check(v_id, p_name, p_pin, false);
  if v_r.error is not null then
    return jsonb_build_object('error', v_r.error);
  end if;

  select * into v_m from public.ez_meets m where m.id = v_id;
  if v_m.meet_date is not null then
    raise exception using errcode = 'P0001', message = '[EZ_CLOSED] 이미 시간이 정해졌습니다';
  end if;
  if v_m.poll is null then
    raise exception using errcode = 'P0001', message = '[EZ_CLOSED] 시간을 맞추는 모임이 아닙니다';
  end if;
  v_from := (v_m.poll ->> 'day_from')::int;
  v_to := (v_m.poll ->> 'day_to')::int;

  for v_e in select e.key, e.value from jsonb_each(p_cells) e loop
    if not ((v_m.poll -> 'dates') ? v_e.key) then
      raise exception using errcode = 'P0001', message = format('[EZ_VALUE] 후보 날짜가 아닙니다: %s', left(v_e.key, 20));
    end if;
    if jsonb_typeof(v_e.value) <> 'array' or jsonb_array_length(v_e.value) > 48 then
      raise exception using errcode = 'P0001', message = '[EZ_VALUE] 날짜마다 칸의 시작 분을 배열로 보냅니다 (48칸까지)';
    end if;
    for v_x in select a.value from jsonb_array_elements(v_e.value) a loop
      if jsonb_typeof(v_x) <> 'number' or v_x::text !~ '^[0-9]{1,4}$' then
        raise exception using errcode = 'P0001', message = '[EZ_VALUE] 칸은 0시부터 센 분(정수)입니다';
      end if;
      v_n := (v_x #>> '{}')::int;
      if v_n % 30 <> 0 then
        raise exception using errcode = 'P0001', message = '[EZ_VALUE] 칸은 30분 단위입니다';
      end if;
      if v_n < v_from or v_n > v_to - 30 then
        raise exception using errcode = 'P0001', message = '[EZ_VALUE] 하루 범위 밖의 칸입니다';
      end if;
    end loop;
  end loop;

  select p.cells into v_old from public.ez_meet_people p where p.id = v_r.person;
  v_cells := public.ez_cells_merge(v_old, p_cells, v_m.poll);
  -- 밖으로 나가 있던 옛 칸까지 합쳐 너무 많아지면 옛 칸은 버린다
  if not public.ez_cells_ok(v_cells) then
    v_cells := public.ez_cells_merge(null, p_cells, v_m.poll);
  end if;
  update public.ez_meet_people p set cells = v_cells where p.id = v_r.person;

  return jsonb_build_object(
    'me', (select p.name from public.ez_meet_people p where p.id = v_r.person),
    'meet', public.ez_meet_snapshot(v_id));
end;
$$;

-- 정해진 모임에 온다 / 못 온다 (p_attend: 'yes' · 'no' · null = 비움)
create function public.ez_meet_rsvp(p_token text, p_name text, p_pin text, p_attend text) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.ez_meet_id(p_token);
  v_r  record;
begin
  if v_id is null then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 없는 링크입니다';
  end if;
  if p_attend is not null and p_attend not in ('yes', 'no') then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 참석은 yes · no 로 보냅니다';
  end if;

  select * into v_r from public.ez_meet_pin_check(v_id, p_name, p_pin, false);
  if v_r.error is not null then
    return jsonb_build_object('error', v_r.error);
  end if;

  if not exists (select 1 from public.ez_meets m where m.id = v_id and m.meet_date is not null) then
    raise exception using errcode = 'P0001', message = '[EZ_OPEN] 아직 시간이 정해지지 않았습니다';
  end if;
  update public.ez_meet_people p set attend = p_attend where p.id = v_r.person;

  return jsonb_build_object(
    'me', (select p.name from public.ez_meet_people p where p.id = v_r.person),
    'meet', public.ez_meet_snapshot(v_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 주최자가 부르는 함수 (로그인한 사람 자신의 모임만 — 열쇠 칸 · 핀 칸은 직접 쓸 권한이 없다)
-- ---------------------------------------------------------------------------

-- 공개 링크 켜기 · 끄기. 켜면 새 열쇠(22자, base64url)를 주고, 이미 켜져 있으면 그 열쇠를 그대로 준다.
-- 끄면 열쇠가 지워진다 — 다시 켜면 새 열쇠라 옛 링크는 죽는다 (보고서 공유와 같다). 반환: 열쇠 또는 null
create function public.ez_meet_link(p_id uuid, p_on boolean) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_token text;
begin
  select m.token into v_token from public.ez_meets m
   where m.id = p_id and m.owner = v_uid and v_uid is not null and m.deleted_at is null
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 모임이 없습니다';
  end if;
  if p_on is not true then
    update public.ez_meets m set token = null where m.id = p_id and m.token is not null;
    return null;
  end if;
  if v_token is not null then
    return v_token;
  end if;
  v_token := translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/=', '-_');
  update public.ez_meets m set token = v_token where m.id = p_id;
  return v_token;
end;
$$;

-- 그 사람의 핀을 지운다 (핀을 잊었을 때). 칠한 것 · 참석은 그대로. 그 이름으로 다시 들어오며 새 핀을 정한다
create function public.ez_meet_pin_clear(p_person uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  update public.ez_meet_people p
     set pin_hash = null, pin_salt = null, pin_fails = 0, pin_locked_until = null
    from public.ez_meets m
   where p.id = p_person and m.id = p.meet_id and m.owner = v_uid and v_uid is not null and m.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 그 사람이 없습니다';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 권한: 기본(public) 회수 후 필요한 역할에만.
-- anon 에게 여는 것은 아래 넷뿐이다. 도우미(ez_meet_id · ez_meet_snapshot · ez_meet_pin_check)는 아무에게도 안 연다 —
-- 직접 부를 수 있으면 열쇠 없이 모임 id 만으로 읽거나 핀을 시도할 수 있다
-- ---------------------------------------------------------------------------

revoke all on function public.ez_cells_ok(jsonb) from public, anon, authenticated;
revoke all on function public.ez_cells_merge(jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.ez_pin_hash(text, text) from public, anon, authenticated;
revoke all on function public.ez_meets_poll_after() from public, anon, authenticated;
revoke all on function public.ez_meet_id(text) from public, anon, authenticated;
revoke all on function public.ez_meet_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.ez_meet_pin_check(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.ez_meet_public(text) from public, anon, authenticated;
revoke all on function public.ez_meet_enter(text, text, text) from public, anon, authenticated;
revoke all on function public.ez_meet_answer(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.ez_meet_rsvp(text, text, text, text) from public, anon, authenticated;
revoke all on function public.ez_meet_link(uuid, boolean) from public, anon, authenticated;
revoke all on function public.ez_meet_pin_clear(uuid) from public, anon, authenticated;

-- Supabase 는 public 스키마의 새 함수를 service_role 에도 기본으로 연다 — 도우미는 거기서도 닫는다 (MCP 는 핀을 다루지 않는다)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.ez_meet_id(text) from service_role;
    revoke all on function public.ez_meet_snapshot(uuid) from service_role;
    revoke all on function public.ez_meet_pin_check(uuid, text, text, boolean) from service_role;
    revoke all on function public.ez_pin_hash(text, text) from service_role;
    revoke all on function public.ez_meet_pin_clear(uuid) from service_role;
    revoke all on function public.ez_meet_link(uuid, boolean) from service_role;
  end if;
end;
$$;

-- CHECK 가 부르는 도우미는 테이블을 쓰는 역할이 실행할 수 있어야 한다
grant execute on function public.ez_cells_ok(jsonb) to authenticated, service_role;

grant execute on function public.ez_meet_public(text) to anon, authenticated;
grant execute on function public.ez_meet_enter(text, text, text) to anon, authenticated;
grant execute on function public.ez_meet_answer(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.ez_meet_rsvp(text, text, text, text) to anon, authenticated;
grant execute on function public.ez_meet_link(uuid, boolean) to authenticated;
grant execute on function public.ez_meet_pin_clear(uuid) to authenticated;
