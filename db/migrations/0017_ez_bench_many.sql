-- 작업대 여러 개 · 앉은 것 하나 (docs/플래너.md 7-15). 행 모양의 기준은 lib/schedule/types.ts (TaskRow.bench_order · bench_at).
-- 0016 위에 더한다. 오류 · p_as · 권한 관례는 0016 과 같다.
-- 원격에 넣는 도구가 지우기 · 버리기 문을 거절하므로 이 파일에는 그런 문이 없다(바꾸는 것은 create or replace 로).
-- 0016 의 부분 유일 색인 ez_tasks_bench_one(owner where bench_at is not null)은 그대로 두고, bench_at 을 "지금 앉은 것" 하나로만 쓴다.
--
-- 더하는 열: ez_tasks.bench_order (작업대에 올린 순서. null 이면 안 올라감. 작은 것이 앞)
-- 고침:     ez_task_bench (올리기 = 다음 번호, 내리기 = 순서 · 앉음 둘 다 비움) · 트리거 ez_tasks_bench (bench_order 도 비움)
-- 함수:     ez_task_sit (앉기 — 그 사람의 다른 앉음을 비우고 이것에. 안 올라가 있으면 먼저 올린다)
-- 순서 바꾸기는 bench_order 를 바로 고친다(0006 의 authenticated 표 update 권한, 주인 행만 — RLS)

-- ---------------------------------------------------------------------------
-- 열
-- ---------------------------------------------------------------------------

alter table public.ez_tasks add column bench_order int;

-- 0016 에서 올라가 있던 것은 첫 번째로 (사람당 하나였다)
update public.ez_tasks set bench_order = 1 where bench_at is not null and bench_order is null;

alter table public.ez_tasks add constraint ez_tasks_bench_order_check check (bench_order is null or bench_order >= 1);
-- 앉은 것은 올라가 있는 것이다
alter table public.ez_tasks add constraint ez_tasks_bench_sit_check check (bench_at is null or bench_order is not null);

-- ---------------------------------------------------------------------------
-- 끝내거나 지우면 둘 다 비운다. 순서가 비면 앉음도 비운다(내리기를 update 로 해도 맞게)
-- ---------------------------------------------------------------------------

create or replace function public.ez_tasks_bench() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.done_at is not null or new.deleted_at is not null then
    new.bench_at := null;
    new.bench_order := null;
  elsif new.bench_order is null then
    new.bench_at := null;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 올리기 · 내리기. p_on = true 면 맨 뒤 번호로 올린다(이미 올라가 있으면 그대로),
-- false 면 내린다(앉아 있었으면 앉음도 비운다). 고친 할 일을 돌려준다. 끝낸 · 지운 할 일은 올릴 수 없다.
-- ---------------------------------------------------------------------------

create or replace function public.ez_task_bench(id uuid, p_on boolean, p_as uuid default null) returns public.ez_tasks
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
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 올릴지(true) 내릴지(false) 정해 주세요';
  end if;

  -- 같은 주인의 올리기 · 앉기는 줄 세운다 (번호가 겹치지 않게)
  perform pg_advisory_xact_lock(hashtextextended('ez_task_bench:' || v_uid::text, 0));

  select * into v_row from public.ez_tasks t where t.id = v_id and t.owner = v_uid and t.deleted_at is null for update;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 할 일이 없습니다';
  end if;

  if not p_on then
    if v_row.bench_order is null and v_row.bench_at is null then
      return v_row;
    end if;
    update public.ez_tasks t set bench_order = null, bench_at = null where t.id = v_id returning * into v_row;
    return v_row;
  end if;

  if v_row.done_at is not null then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 끝낸 할 일은 작업대에 올릴 수 없습니다. 끝냄을 풀고 다시 하세요';
  end if;
  if v_row.bench_order is not null then
    return v_row;
  end if;
  update public.ez_tasks t
     set bench_order = (select coalesce(max(o.bench_order), 0) + 1 from public.ez_tasks o where o.owner = v_uid and o.deleted_at is null)
   where t.id = v_id
  returning * into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 앉기 — 집중 화면을 열 때. 그 사람의 다른 앉음을 비우고 이것에 now (이미 앉아 있으면 그대로).
-- 안 올라가 있으면 맨 뒤 번호로 먼저 올린다. 끝낸 것은 [EZ_VALUE], 없거나 지운 것은 [EZ_NOT_FOUND].
-- ---------------------------------------------------------------------------

create function public.ez_task_sit(id uuid, p_as uuid default null) returns public.ez_tasks
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := public.ez_actor(p_as);
  v_id  uuid := ez_task_sit.id;
  v_row public.ez_tasks%rowtype;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = '[EZ_AUTH] 누구의 할 일인지 모릅니다 (로그인하거나 service_role 이면 p_as)';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ez_task_bench:' || v_uid::text, 0));

  select * into v_row from public.ez_tasks t where t.id = v_id and t.owner = v_uid and t.deleted_at is null for update;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 할 일이 없습니다';
  end if;
  if v_row.done_at is not null then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 끝낸 할 일에는 앉을 수 없습니다. 끝냄을 풀고 다시 하세요';
  end if;
  if v_row.bench_at is not null then
    return v_row;
  end if;

  update public.ez_tasks t set bench_at = null where t.owner = v_uid and t.bench_at is not null and t.id <> v_id;
  update public.ez_tasks t
     set bench_at = now(),
         bench_order = coalesce(
           t.bench_order,
           (select coalesce(max(o.bench_order), 0) + 1 from public.ez_tasks o where o.owner = v_uid and o.deleted_at is null)
         )
   where t.id = v_id
  returning * into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 함수 권한: 기본(public) 회수 후 필요한 역할에만. anon 은 아무것도 없다
-- ---------------------------------------------------------------------------

revoke all on function public.ez_tasks_bench() from public, anon, authenticated;
revoke all on function public.ez_task_bench(uuid, boolean, uuid) from public, anon, authenticated;
revoke all on function public.ez_task_sit(uuid, uuid) from public, anon, authenticated;

grant execute on function public.ez_task_bench(uuid, boolean, uuid) to authenticated, service_role;
grant execute on function public.ez_task_sit(uuid, uuid) to authenticated, service_role;
