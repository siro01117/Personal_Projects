-- 역할 — 누구로서 하는 일인가 (docs/플래너.md 7-11). 행 모양의 기준은 lib/schedule/types.ts (Role · DEFAULT_ROLES).
-- 0007 위에 더한다. 오류 · p_as · soft delete · 권한 관례는 0006 과 같다.
--
-- 테이블: ez_roles (사람마다 역할 목록)
-- 더하는 열: ez_tasks.role_id · ez_task_rules.role_id
-- 함수:   ez_roles_seed (처음 한 번 기본 셋) · ez_tasks_roll (고침: 규칙의 역할을 새 할 일로 옮긴다)
-- 트리거: ez_roles_guard(12개 상한) · ez_roles_after(지우면 걸린 것을 비움) · ez_role_guard(지운 역할은 못 건다)

-- ---------------------------------------------------------------------------
-- ez_roles
-- ---------------------------------------------------------------------------

create table public.ez_roles (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null default auth.uid(),
  name       text not null,
  -- 이 지점 역할(ez_places.role)의 지점을 고르면 이 역할이 기본으로 들어간다
  from_place text,
  sort       double precision not null default 0,
  version    int not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 할 일 · 규칙이 (owner, 역할) 로 걸어 같은 주인의 역할만 가리키게 한다
  constraint ez_roles_owner_id_key unique (owner, id),
  constraint ez_roles_name_check check (name = public.ez_trim(name) and char_length(name) between 1 and 20),
  constraint ez_roles_from_place_check check (from_place is null or from_place in ('home', 'work', 'school')),
  constraint ez_roles_sort_check check (sort > '-Infinity'::float8 and sort < 'Infinity'::float8),
  constraint ez_roles_version_check check (version >= 1)
);

-- 살아 있는 역할끼리 이름 겹침 금지 (대소문자 무시, 이름은 이미 trim). 지점 역할 하나에 역할 하나
create unique index ez_roles_name_unique on public.ez_roles (owner, lower(name)) where deleted_at is null;
create unique index ez_roles_from_place_unique on public.ez_roles (owner, from_place)
  where from_place is not null and deleted_at is null;

-- 살아 있는 역할 12개 상한 (넣을 때 · 되살릴 때)
create function public.ez_roles_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    perform pg_advisory_xact_lock(hashtextextended('ez_roles:' || new.owner::text, 0));
    if (select count(*) from public.ez_roles r
         where r.owner = new.owner and r.deleted_at is null and r.id <> new.id) >= 12 then
      raise exception using errcode = 'P0001', message = '[EZ_LIMIT] 역할은 12개까지 둘 수 있습니다. 안 쓰는 역할을 지우고 다시 하세요';
    end if;
  end if;
  return new;
end;
$$;

-- 역할을 지우면(deleted_at) 그 역할을 가리키는 살아 있는 할 일 · 규칙은 역할 없음이 된다. 되돌리기는 클라이언트가 다시 건다
create function public.ez_roles_after() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.ez_tasks t set role_id = null
     where t.owner = new.owner and t.role_id = new.id and t.deleted_at is null;
    update public.ez_task_rules r set role_id = null
     where r.owner = new.owner and r.role_id = new.id and r.deleted_at is null;
  end if;
  return null;
end;
$$;

create trigger ez_roles_guard before insert or update on public.ez_roles
  for each row execute function public.ez_roles_guard();
create trigger ez_roles_stamp before insert or update on public.ez_roles
  for each row execute function public.ez_stamp();

-- ---------------------------------------------------------------------------
-- 할 일 · 규칙의 역할
-- ---------------------------------------------------------------------------

alter table public.ez_tasks
  add column role_id uuid,
  -- 같은 주인의 역할만. 역할 행이 정말 지워지면 그 칸만 null
  add constraint ez_tasks_role_fk foreign key (owner, role_id) references public.ez_roles (owner, id) on delete set null (role_id);

alter table public.ez_task_rules
  add column role_id uuid,
  add constraint ez_task_rules_role_fk foreign key (owner, role_id) references public.ez_roles (owner, id) on delete set null (role_id);

create index ez_tasks_role_idx on public.ez_tasks (owner, role_id) where role_id is not null;
create index ez_task_rules_role_idx on public.ez_task_rules (owner, role_id) where role_id is not null;

-- 지운(deleted_at) 역할은 새로 걸 수 없다 (넣을 때 · 역할을 바꿀 때). 할 일 · 규칙이 같이 쓴다.
-- 지워 둔 할 일 · 멈춘 규칙을 되살릴 때 그 사이 역할이 지워졌으면 역할 없음으로 되살린다
create function public.ez_role_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role_id is null then
    return new;
  end if;
  if tg_op = 'INSERT' or new.role_id is distinct from old.role_id then
    if exists (select 1 from public.ez_roles r
                where r.id = new.role_id and r.owner = new.owner and r.deleted_at is not null) then
      raise exception using errcode = 'P0001', message = '[EZ_ROLE] 지운 역할입니다';
    end if; -- 없는 역할 · 남의 역할은 외래키가 거절한다
  elsif old.deleted_at is not null and new.deleted_at is null then
    if exists (select 1 from public.ez_roles r
                where r.id = new.role_id and r.owner = new.owner and r.deleted_at is not null) then
      new.role_id := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger ez_roles_after after update on public.ez_roles
  for each row execute function public.ez_roles_after();
-- 이름순으로 ez_*_stamp 보다 먼저 돈다
create trigger ez_tasks_role_guard before insert or update on public.ez_tasks
  for each row execute function public.ez_role_guard();
create trigger ez_task_rules_role_guard before insert or update on public.ez_task_rules
  for each row execute function public.ez_role_guard();

-- ---------------------------------------------------------------------------
-- RLS · 권한 (ez_places 와 같다: 지우기도 soft — authenticated 에 delete 를 주지 않는다)
-- ---------------------------------------------------------------------------

alter table public.ez_roles enable row level security;

create policy ez_roles_select on public.ez_roles for select to authenticated using (owner = (select auth.uid()));
create policy ez_roles_insert on public.ez_roles for insert to authenticated with check (owner = (select auth.uid()));
create policy ez_roles_update on public.ez_roles for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

revoke all on table public.ez_roles from public, anon, authenticated;
grant select, insert, update on table public.ez_roles to authenticated;
grant select, insert, update, delete on table public.ez_roles to service_role;

-- ---------------------------------------------------------------------------
-- 처음 넣는 역할 (lib/schedule/types.ts 의 DEFAULT_ROLES 와 같아야 한다)
-- ---------------------------------------------------------------------------

create function public.ez_roles_defaults() returns table (name text, from_place text, sort double precision)
language sql immutable
set search_path = ''
as $$
  values ('대학'::text, 'school'::text, 0::double precision), ('강사', 'work', 1), ('개인', 'home', 2)
$$;

-- 그 주인에게 역할 행이 하나도 없을 때만(지운 것 포함) 기본 셋을 넣는다. 넣은 개수 반환.
-- 화면을 열 때와 MCP 가 부른다. 다 지운 사람에게 다시 넣지 않는다
create function public.ez_roles_seed(p_as uuid default null) returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := public.ez_actor(p_as);
  v_n   int;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = '[EZ_AUTH] 누구의 역할인지 모릅니다 (로그인하거나 service_role 이면 p_as)';
  end if;

  -- 같은 주인의 seed 는 줄 세운다 (ez_roles_guard 와 같은 잠금)
  perform pg_advisory_xact_lock(hashtextextended('ez_roles:' || v_uid::text, 0));
  if exists (select 1 from public.ez_roles r where r.owner = v_uid) then
    return 0;
  end if;

  insert into public.ez_roles (owner, name, from_place, sort)
  select v_uid, d.name, d.from_place, d.sort from public.ez_roles_defaults() d order by d.sort;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 이미 쓰던 사람(할 일이나 지점이 있는 주인)에게 기본 셋을 넣는다 (역할 행이 하나도 없을 때만)
insert into public.ez_roles (owner, name, from_place, sort)
select o.owner, d.name, d.from_place, d.sort
  from (select t.owner from public.ez_tasks t union select p.owner from public.ez_places p) o
 cross join public.ez_roles_defaults() d
 where not exists (select 1 from public.ez_roles r where r.owner = o.owner)
 order by o.owner, d.sort;

-- ---------------------------------------------------------------------------
-- 규칙 굴리기 (0007 을 고친다): 새 할 일에 규칙의 역할을 옮긴다. 규칙의 역할이 지워졌으면 역할 없음.
-- 나머지는 0007 과 같다.
-- ---------------------------------------------------------------------------

create or replace function public.ez_tasks_roll(p_today date, p_now_min int, p_as uuid default null) returns int
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

    insert into public.ez_tasks (owner, title, note, est_min, place_id, role_id, checklist, due, rule_id, rule_date, sort)
    values (
      v_uid, r.title, r.note, r.est_min, r.place_id,
      (select ro.id from public.ez_roles ro where ro.id = r.role_id and ro.owner = v_uid and ro.deleted_at is null),
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

-- ---------------------------------------------------------------------------
-- 함수 권한: 기본(public) 회수 후 필요한 역할에만. anon 은 아무것도 없다
-- ---------------------------------------------------------------------------

revoke all on function public.ez_roles_guard() from public, anon, authenticated;
revoke all on function public.ez_roles_after() from public, anon, authenticated;
revoke all on function public.ez_role_guard() from public, anon, authenticated;
revoke all on function public.ez_roles_defaults() from public, anon, authenticated;
revoke all on function public.ez_roles_seed(uuid) from public, anon, authenticated;
revoke all on function public.ez_tasks_roll(date, int, uuid) from public, anon, authenticated;

-- ez_roles_seed(security invoker) 가 부르는 도우미는 부르는 역할이 실행할 수 있어야 한다
grant execute on function public.ez_roles_defaults() to authenticated, service_role;
grant execute on function public.ez_roles_seed(uuid) to authenticated, service_role;
grant execute on function public.ez_tasks_roll(date, int, uuid) to authenticated, service_role;
