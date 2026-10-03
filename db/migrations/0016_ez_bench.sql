-- 작업대 — 지금 하는 일 하나 (docs/플래너.md 7-13). 행 모양의 기준은 lib/schedule/types.ts (TaskRow.bench_at · CHECKLIST_MAX).
-- 0008 위에 더한다. 오류 · p_as · 권한 관례는 0006 · 0007 · 0008 과 같다.
-- 원격에 넣는 도구가 지우기 · 버리기 문을 거절하므로 이 파일에는 그런 문이 없다(바꾸는 것은 create or replace 로).
--
-- 더하는 열: ez_tasks.bench_at (작업대에 올린 때. null 이면 안 올라감)
-- 함수:     ez_task_bench (올리기 · 내려놓기 — 사람당 하나, 한 트랜잭션)
-- 트리거:   ez_tasks_bench (끝내거나 지우면 내려놓는다)
-- 고침:     ez_checklist_ok · ez_check_texts_ok 상한 20 → 50 (단계로 쓰면 20 은 모자란다)

-- ---------------------------------------------------------------------------
-- 열 · 사람당 하나
-- ---------------------------------------------------------------------------

alter table public.ez_tasks add column bench_at timestamptz;

-- 작업대에는 한 사람에 할 일 하나 (지운 것 · 끝낸 것은 트리거가 이미 비운다)
create unique index ez_tasks_bench_one on public.ez_tasks (owner) where bench_at is not null;

-- 끝내거나(done_at) 지우면(deleted_at) 작업대에서 내려온다. 이름순으로 ez_tasks_guard · ez_tasks_stamp 보다 먼저 돈다
create function public.ez_tasks_bench() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.bench_at is not null and (new.done_at is not null or new.deleted_at is not null) then
    new.bench_at := null;
  end if;
  return new;
end;
$$;

create trigger ez_tasks_bench before insert or update on public.ez_tasks
  for each row execute function public.ez_tasks_bench();

-- ---------------------------------------------------------------------------
-- 올리기 · 내려놓기. p_on = true 면 그 사람의 다른 할 일을 내려놓고 이것을 올린다(이미 올라가 있으면 그대로),
-- false 면 이것을 내려놓는다. 고친 할 일을 돌려준다. 끝낸 · 지운 할 일은 올릴 수 없다.
-- ---------------------------------------------------------------------------

create function public.ez_task_bench(id uuid, p_on boolean, p_as uuid default null) returns public.ez_tasks
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := public.ez_actor(p_as);
  v_id  uuid := ez_task_bench.id;
  v_row public.ez_tasks%rowtype;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = '[EZ_AUTH] 누구의 할 일인지 모릅니다 (로그인하거나 service_role 이면 p_as)';
  end if;
  if p_on is null then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 올릴지(true) 내려놓을지(false) 정해 주세요';
  end if;

  -- 같은 주인의 올리기는 줄 세운다 (그래도 겹치면 ez_tasks_bench_one 이 막는다)
  perform pg_advisory_xact_lock(hashtextextended('ez_task_bench:' || v_uid::text, 0));

  select * into v_row from public.ez_tasks t where t.id = v_id and t.owner = v_uid and t.deleted_at is null for update;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 할 일이 없습니다';
  end if;

  if not p_on then
    if v_row.bench_at is null then
      return v_row;
    end if;
    update public.ez_tasks t set bench_at = null where t.id = v_id returning * into v_row;
    return v_row;
  end if;

  if v_row.done_at is not null then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 끝낸 할 일은 작업대에 올릴 수 없습니다. 끝냄을 풀고 다시 하세요';
  end if;
  if v_row.bench_at is not null then
    return v_row;
  end if;
  update public.ez_tasks t set bench_at = null where t.owner = v_uid and t.bench_at is not null and t.id <> v_id;
  update public.ez_tasks t set bench_at = now() where t.id = v_id returning * into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 체크 항목 상한 20 → 50 (할 일 · 규칙 같이. 나머지는 0007 과 같다)
-- ---------------------------------------------------------------------------

create or replace function public.ez_checklist_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v jsonb;
  t text;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 50 then
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

create or replace function public.ez_check_texts_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v jsonb;
  t text;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 50 then
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
-- 함수 권한: 기본(public) 회수 후 필요한 역할에만. anon 은 아무것도 없다
-- ---------------------------------------------------------------------------

revoke all on function public.ez_tasks_bench() from public, anon, authenticated;
revoke all on function public.ez_task_bench(uuid, boolean, uuid) from public, anon, authenticated;
revoke all on function public.ez_checklist_ok(jsonb) from public, anon, authenticated;
revoke all on function public.ez_check_texts_ok(jsonb) from public, anon, authenticated;

grant execute on function public.ez_task_bench(uuid, boolean, uuid) to authenticated, service_role;
grant execute on function public.ez_checklist_ok(jsonb) to authenticated, service_role;
grant execute on function public.ez_check_texts_ok(jsonb) to authenticated, service_role;
