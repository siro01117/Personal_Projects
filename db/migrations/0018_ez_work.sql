-- 작업대 v2 — 시간 기록 · 단계 안 단계 · 회차 보호 (docs/플래너.md 7-16). 행 모양의 기준은 lib/schedule/types.ts (WorkSpan · CheckItem · TaskRule.bench).
-- 0017 위에 더한다. 오류 · p_as · 권한 관례는 0016 · 0017 과 같다.
-- 원격에 넣는 도구가 지우기 · 버리기 문을 거절하므로 이 파일에는 그런 문이 없다(바꾸는 것은 create or replace 로).
-- ez_tasks.bench_at(앉은 것)은 더 쓰지 않는다 — 열과 0016 · 0017 의 함수는 그대로 둔다.
--
-- 테이블:   ez_work_log (시작 ~ 중지 구간. 읽기는 주인, 쓰기는 함수만. 열린 구간은 사람당 하나)
-- 함수:     ez_work_start · ez_work_stop (쓰기) · ez_work_sum · ez_work_week · ez_work_list (읽기)
-- 트리거:   ez_tasks_work (할 일을 끝내거나 지우면 그 할 일의 열린 구간을 닫는다)
-- 더하는 열: ez_task_rules.bench (회차가 생기면 작업대에 올리기) · paused (잠깐 멈춤)
-- 고침:     ez_checklist_ok · ez_check_texts_ok (단계 안 단계 한 단 · 단계별 걸릴 시간) · ez_tasks_roll (작업대 · 기록이 있는 지난 회차는 남긴다)
--
-- 날짜는 Asia/Seoul 기준(lib/schedule 과 같다). 열린 구간의 끝은 "지금", 24시간 넘게 열려 있으면 시작 + 24시간(깜빡 잊은 것).

-- ---------------------------------------------------------------------------
-- 체크 항목(단계) 새 모양: {t, done, est?, sub?: [{t, done, est?}]} — 옛 모양 {t, done} 도 그대로 통과
-- ---------------------------------------------------------------------------

-- 한 줄 검사. p_done: done 이 있어야 하나(할 일) / 없어야 하나(규칙 틀). p_sub: sub 를 가질 수 있나(윗단만)
create function public.ez_check_item_ok(v jsonb, p_done boolean, p_sub boolean) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  t text;
begin
  if v is null or jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 't') is distinct from 'string' then
    return false;
  end if;
  if exists (
    select 1 from jsonb_object_keys(v) k
     where k not in ('t', 'est') and not (p_done and k = 'done') and not (p_sub and k = 'sub')
  ) then
    return false;
  end if;
  if p_done and jsonb_typeof(v -> 'done') is distinct from 'boolean' then
    return false;
  end if;
  t := v ->> 't';
  if t <> public.ez_trim(t) or char_length(t) not between 1 and 100 then
    return false;
  end if;
  -- 걸릴 시간(분): 1~600 정수
  if v ? 'est' then
    if jsonb_typeof(v -> 'est') <> 'number' or (v ->> 'est') !~ '^[0-9]{1,3}$' or (v ->> 'est')::int not between 1 and 600 then
      return false;
    end if;
  end if;
  if v ? 'sub' and jsonb_typeof(v -> 'sub') <> 'array' then
    return false;
  end if;
  return true;
end;
$$;

-- 할 일의 체크 항목: 윗단 + 아랫단 합쳐 0~50개. 아랫단은 더 못 들어간다
create or replace function public.ez_checklist_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v jsonb;
  s jsonb;
  n int := 0;
begin
  if p is null or jsonb_typeof(p) <> 'array' then
    return false;
  end if;
  for v in select e.value from jsonb_array_elements(p) e loop
    n := n + 1;
    if not public.ez_check_item_ok(v, true, true) then
      return false;
    end if;
    if v ? 'sub' then
      for s in select e.value from jsonb_array_elements(v -> 'sub') e loop
        n := n + 1;
        if not public.ez_check_item_ok(s, true, false) then
          return false;
        end if;
      end loop;
    end if;
  end loop;
  return n <= 50;
end;
$$;

-- 규칙의 단계 틀: 글자(옛 모양) 또는 {t, est?, sub?: [글자 | {t, est?}]}. 합쳐 0~50개
create or replace function public.ez_check_texts_ok(p jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v jsonb;
  s jsonb;
  n int := 0;
begin
  if p is null or jsonb_typeof(p) <> 'array' then
    return false;
  end if;
  for v in select e.value from jsonb_array_elements(p) e loop
    n := n + 1;
    if jsonb_typeof(v) = 'string' then
      v := jsonb_build_object('t', v);
    end if;
    if not public.ez_check_item_ok(v, false, true) then
      return false;
    end if;
    if v ? 'sub' then
      for s in select e.value from jsonb_array_elements(v -> 'sub') e loop
        n := n + 1;
        if jsonb_typeof(s) = 'string' then
          s := jsonb_build_object('t', s);
        end if;
        if not public.ez_check_item_ok(s, false, false) then
          return false;
        end if;
      end loop;
    end if;
  end loop;
  return n <= 50;
end;
$$;

-- 규칙의 단계 틀 → 새 회차의 체크 항목 (전부 done = false, 순서 그대로)
create function public.ez_check_from_texts(p jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
           case
             when jsonb_typeof(c.value) = 'string' then jsonb_build_object('t', c.value, 'done', false)
             else (c.value - 'sub') || jsonb_build_object('done', false)
                  || case
                       when jsonb_typeof(c.value -> 'sub') = 'array' and jsonb_array_length(c.value -> 'sub') > 0 then
                         jsonb_build_object('sub', (
                           select jsonb_agg(
                                    case when jsonb_typeof(s.value) = 'string' then jsonb_build_object('t', s.value, 'done', false)
                                         else s.value || jsonb_build_object('done', false) end
                                    order by s.n)
                             from jsonb_array_elements(c.value -> 'sub') with ordinality as s(value, n)))
                       else '{}'::jsonb
                     end
           end
           order by c.n), '[]'::jsonb)
    from jsonb_array_elements(p) with ordinality as c(value, n)
$$;

-- ---------------------------------------------------------------------------
-- ez_work_log 시간 기록 — 시작을 누른 때부터 중지(또는 끝냄)까지 한 구간
-- ---------------------------------------------------------------------------

create table public.ez_work_log (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null,
  task_id    uuid not null,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  created_at timestamptz not null default now(),

  constraint ez_work_log_span_check check (ended_at is null or ended_at >= started_at),
  -- 같은 주인의 할 일만. 할 일 행이 정말 지워지면 기록도 같이
  constraint ez_work_log_task_fk foreign key (owner, task_id) references public.ez_tasks (owner, id) on delete cascade
);

-- 열린 구간은 사람당 하나
create unique index ez_work_log_open_one on public.ez_work_log (owner) where ended_at is null;
create index ez_work_log_task_idx on public.ez_work_log (task_id);
create index ez_work_log_owner_idx on public.ez_work_log (owner, started_at);

alter table public.ez_work_log enable row level security;
-- 읽기만. 쓰기 정책은 없다 — ez_work_start · ez_work_stop · 트리거(security definer)만 쓴다
create policy ez_work_log_select on public.ez_work_log for select to authenticated using (owner = (select auth.uid()));

revoke all on table public.ez_work_log from public, anon, authenticated;
grant select on table public.ez_work_log to authenticated;
grant select, insert, update on table public.ez_work_log to service_role;

-- 구간의 끝: 닫혔으면 그 시각, 열려 있으면 지금 — 시작 + 24시간을 넘지 않는다
create function public.ez_work_end(p_started timestamptz, p_ended timestamptz) returns timestamptz
language sql stable
set search_path = ''
as $$
  select least(coalesce(p_ended, now()), p_started + interval '24 hours')
$$;

-- security definer 안에서는 current_user 가 함수 주인이라 ez_actor 를 못 쓴다. 부른 쪽의 역할은 role 설정에 남는다
create function public.ez_work_actor(p_as uuid) returns uuid
language sql stable
set search_path = ''
as $$
  select coalesce(auth.uid(), case when current_setting('role', true) = 'service_role' then p_as end)
$$;

-- ---------------------------------------------------------------------------
-- 시작 — 그 사람의 열린 구간을 전부 닫고(24시간 넘은 것은 24시간으로 잘라) 이 할 일에 새 구간을 연다.
-- 이미 이 할 일에서 돌고 있으면 그대로. 끝낸 것은 [EZ_VALUE], 없거나 지운 것은 [EZ_NOT_FOUND].
-- ---------------------------------------------------------------------------

create function public.ez_work_start(task_id uuid, p_as uuid default null) returns public.ez_work_log
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := public.ez_work_actor(p_as);
  v_id   uuid := ez_work_start.task_id;
  v_task public.ez_tasks%rowtype;
  v_row  public.ez_work_log%rowtype;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = '[EZ_AUTH] 누구의 기록인지 모릅니다 (로그인하거나 service_role 이면 p_as)';
  end if;

  -- 같은 주인의 시작 · 중지는 줄 세운다 (그래도 겹치면 ez_work_log_open_one 이 막는다)
  perform pg_advisory_xact_lock(hashtextextended('ez_work:' || v_uid::text, 0));

  select * into v_task from public.ez_tasks t where t.id = v_id and t.owner = v_uid and t.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 할 일이 없습니다';
  end if;
  if v_task.done_at is not null then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 끝낸 할 일은 시작할 수 없습니다. 끝냄을 풀고 다시 하세요';
  end if;

  select * into v_row from public.ez_work_log w
   where w.owner = v_uid and w.ended_at is null and w.task_id = v_id and w.started_at + interval '24 hours' > now();
  if found then
    return v_row;
  end if;

  update public.ez_work_log w set ended_at = public.ez_work_end(w.started_at, null)
   where w.owner = v_uid and w.ended_at is null;
  insert into public.ez_work_log (owner, task_id) values (v_uid, v_id) returning * into v_row;
  return v_row;
end;
$$;

-- 중지 — 그 사람의 열린 구간을 닫는다. 닫은 개수(0 또는 1)
create function public.ez_work_stop(p_as uuid default null) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.ez_work_actor(p_as);
  v_n   int;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = '[EZ_AUTH] 누구의 기록인지 모릅니다 (로그인하거나 service_role 이면 p_as)';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ez_work:' || v_uid::text, 0));
  update public.ez_work_log w set ended_at = public.ez_work_end(w.started_at, null)
   where w.owner = v_uid and w.ended_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 할 일을 끝내거나 지우면 그 할 일의 열린 구간을 닫는다 (기록은 남는다)
create function public.ez_tasks_work() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.done_at is not null and old.done_at is null) or (new.deleted_at is not null and old.deleted_at is null) then
    update public.ez_work_log w set ended_at = public.ez_work_end(w.started_at, null)
     where w.task_id = new.id and w.ended_at is null;
  end if;
  return null;
end;
$$;

create trigger ez_tasks_work after update on public.ez_tasks
  for each row execute function public.ez_tasks_work();

-- ---------------------------------------------------------------------------
-- 읽기 (security invoker — 로그인한 사람은 RLS 로 자기 것만, service_role 은 p_as 의 것만)
-- ---------------------------------------------------------------------------

-- 할 일별 합: 오늘(Asia/Seoul) · 누적 · 지금 돌고 있나(돌고 있으면 그 구간의 시작). 살아 있는 할 일만
create function public.ez_work_sum(p_as uuid default null)
returns table (task_id uuid, today_sec int, total_sec int, running boolean, started_at timestamptz)
language sql stable
security invoker
set search_path = public
as $$
  with me as (select public.ez_actor(p_as) as uid),
       day as (
         select ((now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul') as lo
       )
  select w.task_id,
         coalesce(sum(greatest(extract(epoch from (public.ez_work_end(w.started_at, w.ended_at) - greatest(w.started_at, day.lo))), 0)), 0)::int,
         coalesce(sum(extract(epoch from (public.ez_work_end(w.started_at, w.ended_at) - w.started_at))), 0)::int,
         coalesce(bool_or(w.ended_at is null and w.started_at + interval '24 hours' > now()), false),
         max(w.started_at) filter (where w.ended_at is null and w.started_at + interval '24 hours' > now())
    from public.ez_work_log w
    join public.ez_tasks t on t.id = w.task_id and t.deleted_at is null
    cross join me
    cross join day
   where w.owner = me.uid
   group by w.task_id
$$;

-- 한 주(p_week_start 부터 7일)의 할 일 × 날짜 합. 자정(Asia/Seoul)을 넘는 구간은 날짜별로 나눈다. 살아 있는 할 일만
create function public.ez_work_week(p_week_start date, p_as uuid default null)
returns table (task_id uuid, day date, seconds int)
language sql stable
security invoker
set search_path = public
as $$
  with me as (select public.ez_actor(p_as) as uid),
       days as (
         select (p_week_start + k) as day,
                ((p_week_start + k)::timestamp at time zone 'Asia/Seoul') as lo,
                ((p_week_start + k + 1)::timestamp at time zone 'Asia/Seoul') as hi
           from generate_series(0, 6) k
       )
  select w.task_id, d.day,
         sum(extract(epoch from (least(public.ez_work_end(w.started_at, w.ended_at), d.hi) - greatest(w.started_at, d.lo))))::int
    from public.ez_work_log w
    join public.ez_tasks t on t.id = w.task_id and t.deleted_at is null
    cross join me
    join days d on w.started_at < d.hi and public.ez_work_end(w.started_at, w.ended_at) > d.lo
   where w.owner = me.uid
   group by w.task_id, d.day
   order by d.day, w.task_id
$$;

-- 기간(p_from ~ p_to, 그날 포함, Asia/Seoul)에 걸친 원 구간. ended_at 은 계산한 끝(열려 있으면 지금). 살아 있는 할 일만
create function public.ez_work_list(p_from date, p_to date, p_as uuid default null)
returns table (id uuid, task_id uuid, started_at timestamptz, ended_at timestamptz, running boolean)
language sql stable
security invoker
set search_path = public
as $$
  with me as (select public.ez_actor(p_as) as uid)
  select w.id, w.task_id, w.started_at, public.ez_work_end(w.started_at, w.ended_at),
         w.ended_at is null and w.started_at + interval '24 hours' > now()
    from public.ez_work_log w
    join public.ez_tasks t on t.id = w.task_id and t.deleted_at is null
    cross join me
   where w.owner = me.uid
     and w.started_at < ((p_to + 1)::timestamp at time zone 'Asia/Seoul')
     and public.ez_work_end(w.started_at, w.ended_at) > (p_from::timestamp at time zone 'Asia/Seoul')
   order by w.started_at, w.id
$$;

-- ---------------------------------------------------------------------------
-- 규칙: 회차가 생기면 작업대에 올리기 · 잠깐 멈춤(목록에는 남고 회차를 만들지 않는다 — deleted_at 은 "지우기")
-- ---------------------------------------------------------------------------

alter table public.ez_task_rules add column bench boolean not null default false;
alter table public.ez_task_rules add column paused boolean not null default false;

-- ---------------------------------------------------------------------------
-- 규칙 굴리기 (0008 을 고친다)
--   · 새 회차의 단계는 규칙의 단계 틀에서 (아랫단 · 걸릴 시간 포함)
--   · 규칙의 bench 가 켜져 있으면 새 회차를 작업대 맨 뒤에 올린다
--   · 밀린 지난 회차 중 작업대에 올라가 있거나 시간 기록이 있는 것은 남긴다 (사람이 손댄 것 — "지남" 에 보인다)
--   · 멈춘(paused) 규칙은 건너뛴다. 다시 켜면 그때 가장 최근 회차 하나를 만든다
-- 나머지는 0008 과 같다.
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
    select * from public.ez_task_rules t
     where t.owner = v_uid and t.deleted_at is null and not t.paused
     order by t.created_at, t.id
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

    -- 밀리면 한 건만: 안 끝낸 지난 회차는 지운다. 작업대에 올라가 있거나 시간 기록이 있는 것은 남긴다
    update public.ez_tasks t set deleted_at = now()
     where t.owner = v_uid and t.rule_id = r.id and t.rule_date < v_d and t.done_at is null and t.deleted_at is null
       and t.bench_order is null
       and not exists (select 1 from public.ez_work_log w where w.task_id = t.id);

    if r.bench then
      -- 작업대 번호는 올리기와 같은 잠금으로 줄 세운다
      perform pg_advisory_xact_lock(hashtextextended('ez_task_bench:' || v_uid::text, 0));
    end if;

    insert into public.ez_tasks (owner, title, note, est_min, place_id, role_id, checklist, due, rule_id, rule_date, sort, bench_order)
    values (
      v_uid, r.title, r.note, r.est_min, r.place_id,
      (select ro.id from public.ez_roles ro where ro.id = r.role_id and ro.owner = v_uid and ro.deleted_at is null),
      public.ez_check_from_texts(r.checklist),
      case when r.due_after is not null then v_d + r.due_after end,
      r.id, v_d,
      -- 맨 위
      coalesce((select min(t.sort) - 1 from public.ez_tasks t where t.owner = v_uid and t.deleted_at is null), 0),
      case when r.bench then
        (select coalesce(max(o.bench_order), 0) + 1 from public.ez_tasks o where o.owner = v_uid and o.deleted_at is null)
      end
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

revoke all on function public.ez_check_item_ok(jsonb, boolean, boolean) from public, anon, authenticated;
revoke all on function public.ez_checklist_ok(jsonb) from public, anon, authenticated;
revoke all on function public.ez_check_texts_ok(jsonb) from public, anon, authenticated;
revoke all on function public.ez_check_from_texts(jsonb) from public, anon, authenticated;
revoke all on function public.ez_work_end(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.ez_work_actor(uuid) from public, anon, authenticated;
revoke all on function public.ez_work_start(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ez_work_stop(uuid) from public, anon, authenticated;
revoke all on function public.ez_tasks_work() from public, anon, authenticated;
revoke all on function public.ez_work_sum(uuid) from public, anon, authenticated;
revoke all on function public.ez_work_week(date, uuid) from public, anon, authenticated;
revoke all on function public.ez_work_list(date, date, uuid) from public, anon, authenticated;
revoke all on function public.ez_tasks_roll(date, int, uuid) from public, anon, authenticated;

-- CHECK · security invoker 함수가 부르는 도우미는 부르는 역할이 실행할 수 있어야 한다
grant execute on function public.ez_check_item_ok(jsonb, boolean, boolean) to authenticated, service_role;
grant execute on function public.ez_checklist_ok(jsonb) to authenticated, service_role;
grant execute on function public.ez_check_texts_ok(jsonb) to authenticated, service_role;
grant execute on function public.ez_check_from_texts(jsonb) to authenticated, service_role;
grant execute on function public.ez_work_end(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.ez_work_start(uuid, uuid) to authenticated, service_role;
grant execute on function public.ez_work_stop(uuid) to authenticated, service_role;
grant execute on function public.ez_work_sum(uuid) to authenticated, service_role;
grant execute on function public.ez_work_week(date, uuid) to authenticated, service_role;
grant execute on function public.ez_work_list(date, date, uuid) to authenticated, service_role;
grant execute on function public.ez_tasks_roll(date, int, uuid) to authenticated, service_role;
