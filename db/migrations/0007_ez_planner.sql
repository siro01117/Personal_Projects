-- 플래너 v2 (docs/플래너.md 7장). 행 모양의 기준은 lib/schedule/types.ts (TaskRow · CheckItem · TaskRule).
-- 0006 위에 더한다. 오류 · p_as · soft delete · 권한 관례는 0006 과 같다.
--
-- ez_tasks 에 더하는 열: place_id · due_event_id · checklist · rule_id · rule_date
-- 테이블: ez_task_rules (반복 규칙 — 때가 되면 할 일을 만든다)
-- 함수:   ez_tasks_roll (열 때 부른다. 규칙마다 가장 최근 회차 하나를 만든다)
-- 트리거: ez_tasks_guard(일정에 딸린 마감) · ez_task_rules_guard · ez_task_rules_gone · ez_events_after(고침)

-- ---------------------------------------------------------------------------
-- 검사 도우미
-- ---------------------------------------------------------------------------

-- 할 일의 체크 항목: [{t, done}] 0~20개. t 는 앞뒤 공백 없는 1~100자, done 은 boolean, 다른 키 없음
create function public.ez_checklist_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v jsonb;
  t text;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 20 then
    return false;
  end if;
  for v in select e.value from jsonb_array_elements(p) e loop
    if jsonb_typeof(v) <> 'object'
       or jsonb_typeof(v -> 't') is distinct from 'string'
       or jsonb_typeof(v -> 'done') is distinct from 'boolean'
       or (select count(*) from jsonb_object_keys(v)) <> 2 then
      return false;
    end if;
    t := v ->> 't';
    if t <> public.ez_trim(t) or char_length(t) not between 1 and 100 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- 규칙의 체크 항목: 글자 배열 0~20개, 각 앞뒤 공백 없는 1~100자
create function public.ez_check_texts_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v jsonb;
  t text;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 20 then
    return false;
  end if;
  for v in select e.value from jsonb_array_elements(p) e loop
    if jsonb_typeof(v) <> 'string' then
      return false;
    end if;
    t := v #>> '{}';
    if t <> public.ez_trim(t) or char_length(t) not between 1 and 100 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- ez_task_rules 반복 규칙
-- ---------------------------------------------------------------------------

-- 할 일 · 규칙이 (owner, 일정) 으로 걸어 같은 주인의 일정만 가리키게 한다
alter table public.ez_events add constraint ez_events_owner_id_key unique (owner, id);

create table public.ez_task_rules (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null default auth.uid(),
  kind       text not null,
  title      text not null,
  note       text,
  est_min    int,
  place_id   uuid,
  checklist  jsonb not null default '[]',
  repeat     jsonb,
  start      date,
  event_id   uuid,
  due_after  int,
  last_made  date,
  version    int not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ez_task_rules_owner_id_key unique (owner, id),
  constraint ez_task_rules_title_check check (title = public.ez_trim(title) and char_length(title) between 1 and 200),
  constraint ez_task_rules_note_check check (note is null or char_length(note) <= 2000),
  constraint ez_task_rules_est_check check (est_min is null or est_min between 5 and 600),
  constraint ez_task_rules_checklist_check check (public.ez_check_texts_ok(checklist)),
  constraint ez_task_rules_due_after_check check (due_after is null or due_after between 0 and 60),
  -- cycle: 반복 · 시작만. event: 일정만
  constraint ez_task_rules_kind_check check (
    (kind = 'cycle' and repeat is not null and start is not null and event_id is null)
    or (kind = 'event' and event_id is not null and repeat is null and start is null)
  ),
  -- 일정과 같은 반복 모양(매일 / 매주 요일). until 은 쓰지 않는다 (트리거가 먼저 한국어 이유로 거절한다)
  constraint ez_task_rules_repeat_check check (
    repeat is null
    or (jsonb_typeof(repeat) = 'object' and not (repeat ? 'until') and public.ez_repeat_problem(repeat, start) is null)
  ),
  constraint ez_task_rules_version_check check (version >= 1),
  -- 같은 주인의 지점 · 일정만. 지운(deleted_at) 지점도 가리킬 수 있다. 일정 행이 정말 지워지면 규칙도 지운다
  constraint ez_task_rules_place_fk foreign key (owner, place_id) references public.ez_places (owner, id) on delete set null (place_id),
  constraint ez_task_rules_event_fk foreign key (owner, event_id) references public.ez_events (owner, id) on delete cascade
);

create index ez_task_rules_owner_idx on public.ez_task_rules (owner) where deleted_at is null;
create index ez_task_rules_event_idx on public.ez_task_rules (owner, event_id) where event_id is not null;
create index ez_task_rules_place_idx on public.ez_task_rules (owner, place_id) where place_id is not null;

create function public.ez_task_rules_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev  public.ez_events%rowtype;
  v_why text;
begin
  if new.kind = 'cycle' and new.repeat is not null then
    if jsonb_typeof(new.repeat) = 'object' and new.repeat ? 'until' then
      raise exception using errcode = 'P0001',
        message = '[EZ_VALUE] 반복 할 일에는 끝나는 날(until)을 쓰지 않습니다. 그만하려면 규칙을 멈추세요';
    end if;
    v_why := public.ez_repeat_problem(new.repeat, new.start);
    if v_why is not null then
      raise exception using errcode = 'P0001', message = '[EZ_VALUE] ' || v_why;
    end if;
  end if;

  -- 일정에 딸린 규칙: 넣을 때 · 일정을 바꿀 때 · 멈춘 규칙을 되살릴 때 그 일정이 살아 있는 반복 일정이어야 한다
  if new.kind = 'event' and new.event_id is not null and new.deleted_at is null
     and (tg_op = 'INSERT' or new.event_id is distinct from old.event_id or old.deleted_at is not null
          or new.kind is distinct from old.kind) then
    select * into v_ev from public.ez_events e where e.id = new.event_id and e.owner = new.owner;
    if found then -- 없으면 외래키가 거절한다
      if v_ev.deleted_at is not null then
        raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 지운 일정에는 반복 할 일을 걸 수 없습니다';
      end if;
      if v_ev.repeat is null then
        raise exception using errcode = 'P0001',
          message = '[EZ_REPEAT] 반복 일정이 아니라 끝날 때마다 할 일을 만들 수 없습니다. 반복 일정을 고르세요';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- 규칙 행이 정말 지워지면 그 규칙에서 생긴 할 일은 남고 연결(rule_id · rule_date)만 끊긴다
create function public.ez_task_rules_gone() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ez_tasks t set rule_id = null, rule_date = null where t.rule_id = old.id;
  return old;
end;
$$;

create trigger ez_task_rules_guard before insert or update on public.ez_task_rules
  for each row execute function public.ez_task_rules_guard();
create trigger ez_task_rules_stamp before insert or update on public.ez_task_rules
  for each row execute function public.ez_stamp();
create trigger ez_task_rules_gone before delete on public.ez_task_rules
  for each row execute function public.ez_task_rules_gone();

-- ---------------------------------------------------------------------------
-- ez_tasks 에 더하는 열
-- ---------------------------------------------------------------------------

alter table public.ez_tasks
  add column place_id     uuid,
  add column due_event_id uuid,
  add column checklist    jsonb not null default '[]',
  add column rule_id      uuid,
  add column rule_date    date,
  add constraint ez_tasks_checklist_check check (public.ez_checklist_ok(checklist)),
  -- 규칙과 회차 날짜는 둘 다 있거나 둘 다 없거나. rule_date 는 회차가 아니어도 된다(첫 회차는 규칙을 만든 날일 수 있다)
  add constraint ez_tasks_rule_check check ((rule_id is null) = (rule_date is null)),
  -- 같은 (규칙, 회차)는 하나 — 지운 것까지 쳐서. 같은 회차를 두 번 만들지 않는다
  add constraint ez_tasks_rule_once unique (rule_id, rule_date),
  -- 같은 주인의 지점 · 일정 · 규칙만. 지운(deleted_at) 지점도 가리킬 수 있다. 행이 정말 지워지면 그 칸만 null
  add constraint ez_tasks_place_fk foreign key (owner, place_id) references public.ez_places (owner, id) on delete set null (place_id),
  add constraint ez_tasks_due_event_fk foreign key (owner, due_event_id) references public.ez_events (owner, id) on delete set null (due_event_id),
  -- 규칙 행이 지워질 때는 ez_task_rules_gone 이 rule_id · rule_date 를 같이 비운다
  add constraint ez_tasks_rule_fk foreign key (owner, rule_id) references public.ez_task_rules (owner, id) on delete set null (rule_id);

create index ez_tasks_place_idx on public.ez_tasks (owner, place_id) where place_id is not null;
create index ez_tasks_due_event_idx on public.ez_tasks (owner, due_event_id) where due_event_id is not null;

-- 일정에 딸린 마감 (7-3). due 는 그 회차 날짜의 사본이다.
--   반복 아닌 일정: 걸 때 due 를 일정 날짜로 맞춘다. 걸어 둔 채 due 만 다른 날로 바꿀 수 없다(연결을 비우고 바꾼다)
--   반복 일정: due 가 있어야 하고 그 일정의 회차여야 한다
create function public.ez_tasks_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev   public.ez_events%rowtype;
  v_link boolean;
begin
  if new.due_event_id is null then
    return new;
  end if;
  v_link := tg_op = 'INSERT' or new.due_event_id is distinct from old.due_event_id;
  if not v_link and new.due is not distinct from old.due then
    return new;
  end if;

  select * into v_ev from public.ez_events e where e.id = new.due_event_id and e.owner = new.owner;
  if not found then
    return new; -- 외래키가 거절한다
  end if;
  if v_ev.deleted_at is not null then
    raise exception using errcode = 'P0001', message = '[EZ_EVENT] 지운 일정에는 마감을 걸 수 없습니다';
  end if;

  if v_ev.repeat is null then
    if v_link then
      new.due := v_ev.date;
    elsif new.due is distinct from v_ev.date then
      raise exception using errcode = 'P0001',
        message = '[EZ_VALUE] 일정에 딸린 마감은 일정 날짜를 따라갑니다. 날짜를 따로 정하려면 일정 연결(due_event_id)을 비우세요';
    end if;
  else
    if new.due is null then
      raise exception using errcode = 'P0001',
        message = '[EZ_VALUE] 반복 일정에 마감을 걸 때는 어느 회차인지 날짜(due)를 같이 써 주세요';
    end if;
    if not public.ez_occurs_on(v_ev.repeat, v_ev.date, new.due) then
      raise exception using errcode = 'P0001',
        message = format('[EZ_DATE] %s 는 이 일정이 반복되는 날이 아닙니다', new.due);
    end if;
  end if;
  return new;
end;
$$;

-- 이름순으로 ez_tasks_stamp 보다 먼저 돈다 (due 를 채운 뒤 버전을 매긴다)
create trigger ez_tasks_guard before insert or update on public.ez_tasks
  for each row execute function public.ez_tasks_guard();

-- ---------------------------------------------------------------------------
-- 일정이 바뀌면 딸린 마감 · 규칙이 따라간다 (0006 ez_events_after 를 고친다. 트리거는 그대로)
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

  -- 일정을 지우면: 딸린 마감은 연결만 끊기고(날짜는 남는다), 딸린 규칙은 멈춘다
  if new.deleted_at is not null and old.deleted_at is null then
    update public.ez_tasks t set due_event_id = null where t.due_event_id = new.id and t.owner = new.owner;
    update public.ez_task_rules r set deleted_at = now()
     where r.event_id = new.id and r.owner = new.owner and r.deleted_at is null;
    return null;
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
-- RLS · 권한
-- ---------------------------------------------------------------------------

alter table public.ez_task_rules enable row level security;

create policy ez_task_rules_select on public.ez_task_rules for select to authenticated using (owner = (select auth.uid()));
create policy ez_task_rules_insert on public.ez_task_rules for insert to authenticated with check (owner = (select auth.uid()));
create policy ez_task_rules_update on public.ez_task_rules for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 규칙 굴리기: 주인의 살아 있는 규칙마다 가장 최근 회차 하나를 할 일로 만든다. 만든 개수 반환.
-- 플래너 · 일정 화면을 열 때와 todo_list 가 부른다. p_today · p_now_min 은 부르는 쪽의 현지 날짜와 0시부터 센 분.
--   볼 범위: greatest(last_made + 1 (없으면 시작), p_today - 60) ~ p_today. 그 안의 가장 늦은 회차 하나만.
--     cycle 의 시작은 start, event 의 시작은 일정의 date.
--   event 규칙의 회차는 끝나야 만든다: 건너뜀(skip)이 아니고, 끝 시각(이번만 바꾼 end_min 이 있으면 그것)이 지났을 것.
--     종일 회차는 다음 날부터. 예외로 날짜를 옮긴 회차도 원래 on_date 기준으로 본다.
--   새 회차를 만들 때 그 규칙의 안 끝낸 지난 회차는 지운다(밀리면 한 건만). 끝낸 것은 남는다.
--   같은 (규칙, 회차)가 이미 있으면(지운 것 포함) 만들지 않는다.
-- ---------------------------------------------------------------------------

create function public.ez_tasks_roll(p_today date, p_now_min int, p_as uuid default null) returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid  uuid := public.ez_actor(p_as);
  v_made int := 0;
  v_n    int;
  r      public.ez_task_rules%rowtype;
  v_ev   public.ez_events%rowtype;
  v_from date;
  v_d    date;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = '[EZ_AUTH] 누구의 할 일인지 모릅니다 (로그인하거나 service_role 이면 p_as)';
  end if;
  if p_today is null then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 오늘 날짜(p_today)가 없습니다';
  end if;
  if p_now_min is null or p_now_min not between 0 and 1439 then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 지금 시각(p_now_min)은 0~1439분(00:00~23:59)이어야 합니다';
  end if;

  -- 같은 주인의 굴리기는 줄 세운다 (그래도 겹치면 (rule_id, rule_date) 유일 제약이 막는다)
  perform pg_advisory_xact_lock(hashtextextended('ez_tasks_roll:' || v_uid::text, 0));

  for r in
    select * from public.ez_task_rules t where t.owner = v_uid and t.deleted_at is null order by t.created_at, t.id
  loop
    v_d := null;
    if r.kind = 'cycle' then
      v_from := greatest(coalesce(r.last_made + 1, r.start), p_today - 60);
      select max(v_from + k) into v_d
        from generate_series(0, p_today - v_from) k
       where public.ez_occurs_on(r.repeat, r.start, v_from + k);
    else
      select * into v_ev from public.ez_events e
       where e.id = r.event_id and e.owner = v_uid and e.deleted_at is null and e.repeat is not null;
      if found then
        v_from := greatest(coalesce(r.last_made + 1, v_ev.date), p_today - 60);
        select max(v_from + k) into v_d
          from generate_series(0, p_today - v_from) k
         where public.ez_occurs_on(v_ev.repeat, v_ev.date, v_from + k)
           and not exists (
             select 1 from public.ez_event_exceptions x
              where x.event_id = v_ev.id and x.on_date = v_from + k and x.skip
           )
           and (
             -- 그 회차의 끝 시각(회차 날짜 0시부터 센 분)이 지났어야 한다. 이번만 바꾼 end_min 이 있으면 그것,
             -- 종일(null)이면 1440 — 그날이 다 가야 끝난다
             select coalesce(case when x.patch ? 'end_min' then (x.patch ->> 'end_min')::int else v_ev.end_min end, 1440)
               from (select 1) one
               left join public.ez_event_exceptions x
                 on x.event_id = v_ev.id and x.on_date = v_from + k and not x.skip
           ) <= (p_today - (v_from + k)) * 1440 + p_now_min;
      end if;
    end if;

    if v_d is null then
      continue;
    end if;

    -- 밀리면 한 건만: 안 끝낸 지난 회차는 지운다
    update public.ez_tasks t set deleted_at = now()
     where t.owner = v_uid and t.rule_id = r.id and t.rule_date < v_d and t.done_at is null and t.deleted_at is null;

    insert into public.ez_tasks (owner, title, note, est_min, place_id, checklist, due, rule_id, rule_date, sort)
    values (
      v_uid, r.title, r.note, r.est_min, r.place_id,
      coalesce((select jsonb_agg(jsonb_build_object('t', c.value, 'done', false) order by c.n)
                  from jsonb_array_elements(r.checklist) with ordinality as c(value, n)), '[]'::jsonb),
      case when r.due_after is not null then v_d + r.due_after end,
      r.id, v_d,
      -- 맨 위
      coalesce((select min(t.sort) - 1 from public.ez_tasks t where t.owner = v_uid and t.deleted_at is null), 0)
    )
    on conflict on constraint ez_tasks_rule_once do nothing;
    get diagnostics v_n = row_count;
    v_made := v_made + v_n;

    update public.ez_task_rules t set last_made = v_d where t.id = r.id;
  end loop;
  return v_made;
end;
$$;

revoke all on table public.ez_task_rules from public, anon, authenticated;
grant select, insert, update on table public.ez_task_rules to authenticated;
grant select, insert, update, delete on table public.ez_task_rules to service_role;

revoke all on function public.ez_checklist_ok(jsonb) from public, anon, authenticated;
revoke all on function public.ez_check_texts_ok(jsonb) from public, anon, authenticated;
revoke all on function public.ez_task_rules_guard() from public, anon, authenticated;
revoke all on function public.ez_task_rules_gone() from public, anon, authenticated;
revoke all on function public.ez_tasks_guard() from public, anon, authenticated;
revoke all on function public.ez_events_after() from public, anon, authenticated;
revoke all on function public.ez_tasks_roll(date, int, uuid) from public, anon, authenticated;

-- CHECK 가 쓰는 검사 도우미는 테이블을 쓰는 역할이 실행할 수 있어야 한다
grant execute on function public.ez_checklist_ok(jsonb) to authenticated, service_role;
grant execute on function public.ez_check_texts_ok(jsonb) to authenticated, service_role;
grant execute on function public.ez_tasks_roll(date, int, uuid) to authenticated, service_role;
