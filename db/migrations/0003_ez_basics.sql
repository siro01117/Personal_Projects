-- 탐색기 기본기 (설계서 7-1장): 복사 · 여러 개 지우기 · 폴더 안 읽음 · 휴지통 목록 · 공개 중 표시.
-- 0001·0002 위에 더한다. 오류는 0001 과 같이 errcode P0001, message '[EZ_코드] 한국어 설명'.
-- p_as 는 0001 ez_actor 와 같다 (로그인한 사람이면 그 사람, service_role 이면 p_as 대리).

-- ---------------------------------------------------------------------------
-- 도우미
-- ---------------------------------------------------------------------------

-- 복사본 이름 (lib/names.ts copyName 과 같은 규칙).
-- 겹치지 않으면 그대로, 겹치면 '이름 - 복사본', 그것도 겹치면 '이름 - 복사본 (2)', (3) …
-- 100자를 넘으면 원래 이름 앞부분을 잘라 접미사 자리를 만든다
create function public.ez_copy_name(p_owner uuid, p_parent uuid, p_name text)
returns text
language plpgsql stable
set search_path = public
as $$
declare
  v_name text := public.ez_trim(p_name);
  v_n    int := 2;
  v_suf  text := ' - 복사본';
  v_cand text;
begin
  v_cand := v_name;
  loop
    if not exists (
      select 1 from public.ez_items i
      where i.owner = p_owner and i.parent_id is not distinct from p_parent and i.deleted_at is null
        and lower(i.name) = lower(v_cand)
    ) then
      return v_cand;
    end if;
    v_cand := left(v_name, 100 - char_length(v_suf)) || v_suf;
    v_suf := format(' - 복사본 (%s)', v_n);
    v_n := v_n + 1;
  end loop;
end;
$$;

-- p_id 의 조상(자기 자신 제외) 중에 p_ids 가 하나라도 있는지
create function public.ez_is_under(p_id uuid, p_ids uuid[]) returns boolean
language sql stable
set search_path = public
as $$
  with recursive anc(id, d) as (
    select i.parent_id, 1 from public.ez_items i where i.id = p_id and i.parent_id is not null
    union all
    select p.parent_id, a.d + 1 from public.ez_items p join anc a on p.id = a.id
    where p.parent_id is not null and a.d < 64
  )
  select exists (select 1 from anc where anc.id = any (p_ids))
$$;

-- 서로 겹치지 않는 맨 위 항목들: 중복을 빼고, 이미 다른 선택 항목의 자손인 것은 뺀다 (순서 유지)
create function public.ez_top_ids(p_ids uuid[]) returns uuid[]
language sql stable
set search_path = public
as $$
  select coalesce(array_agg(u.id order by u.ord), '{}')
    from (
      select x.id, min(x.ord) as ord
        from unnest(p_ids) with ordinality as x(id, ord)
       where x.id is not null
       group by x.id
    ) u
   where not public.ez_is_under(u.id, p_ids)
$$;

-- ---------------------------------------------------------------------------
-- 복사: 여러 항목을 p_to(null = 맨 위) 아래로. 폴더는 자손까지 통째로. 한 트랜잭션 — 하나라도 실패하면 전부 취소
-- 돌려주는 것: 맨 위 항목마다 (원본 id, 복사본 id, 복사본 이름)
-- ---------------------------------------------------------------------------

create function public.ez_copy(p_ids uuid[], p_to uuid, p_as uuid default null)
returns table (src uuid, id uuid, name text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid  uuid := public.ez_actor(p_as);
  v_tops uuid[];
  v_src  uuid;
  v_top  public.ez_items%rowtype;
  v_new  uuid;
  v_name text;
  v_map  jsonb;
  v_now  timestamptz := now();
  r      record;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 복사할 항목이 없습니다';
  end if;
  v_tops := public.ez_top_ids(p_ids);
  if cardinality(v_tops) = 0 then
    raise exception using errcode = 'P0001', message = '[EZ_EMPTY] 복사할 항목이 없습니다';
  end if;
  -- 전부 살아 있는 내 것이어야 한다 (남의 것·지운 것은 없는 것과 같은 문구)
  if (select count(*) from public.ez_items i
       where i.id = any (v_tops) and i.owner = v_uid and i.deleted_at is null) <> cardinality(v_tops) then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 복사할 항목이 없습니다';
  end if;
  -- 폴더를 자기 자신이나 자기 안으로 (새 행은 새 id 라 트리거가 못 잡는다)
  if p_to is not null and (p_to = any (v_tops) or public.ez_is_under(p_to, v_tops)) then
    raise exception using errcode = 'P0001', message = '[EZ_CYCLE] 폴더를 자기 자신이나 자기 안의 폴더로 복사할 수 없습니다';
  end if;

  foreach v_src in array v_tops loop
    select * into v_top from public.ez_items i where i.id = v_src;
    v_name := public.ez_copy_name(v_uid, p_to, v_top.name);
    -- 부모·깊이·이름 규칙은 트리거·CHECK·인덱스가 막는다. 실패하면 이 함수 전체가 취소된다
    insert into public.ez_items (owner, parent_id, kind, name, report_kind, blocks, schema_version, agent,
                                 agent_updated_at, read_at, share_token)
    values (v_uid, p_to, v_top.kind, v_name, v_top.report_kind, v_top.blocks, v_top.schema_version, v_top.agent,
            null, v_now, null)
    returning public.ez_items.id into v_new;

    src := v_top.id;
    id := v_new;
    name := v_name;
    return next;

    if v_top.kind = 'folder' then
      v_map := jsonb_build_object(v_top.id::text, v_new::text);
      -- 얕은 것부터: 부모의 복사본이 먼저 있어야 한다. 새 폴더 안이라 이름은 원래대로 겹치지 않는다
      for r in
        with recursive t(id, d) as (
          select c.id, 1 from public.ez_items c
           where c.parent_id = v_top.id and c.owner = v_uid and c.deleted_at is null
          union all
          select c.id, t.d + 1 from public.ez_items c join t on c.parent_id = t.id
           where c.owner = v_uid and c.deleted_at is null and t.d < 64
        )
        select i.id, i.parent_id, i.kind, i.name, i.report_kind, i.blocks, i.schema_version, i.agent
          from t join public.ez_items i on i.id = t.id
         order by t.d, i.name
      loop
        insert into public.ez_items (owner, parent_id, kind, name, report_kind, blocks, schema_version, agent,
                                     agent_updated_at, read_at, share_token)
        values (v_uid, (v_map ->> r.parent_id::text)::uuid, r.kind, r.name, r.report_kind, r.blocks,
                r.schema_version, r.agent, null, v_now, null)
        returning public.ez_items.id into v_new;
        v_map := v_map || jsonb_build_object(r.id::text, v_new::text);
      end loop;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 여러 개를 한 묶음으로 휴지통에 (자손 포함). 묶음 id
-- ---------------------------------------------------------------------------

create function public.ez_delete_many(p_ids uuid[], p_as uuid default null) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid   uuid := public.ez_actor(p_as);
  v_tops  uuid[];
  v_batch uuid := gen_random_uuid();
  v_now   timestamptz := now();
  r       record;
begin
  v_tops := public.ez_top_ids(p_ids);
  if v_uid is null or cardinality(v_tops) = 0
     or (select count(*) from public.ez_items i
          where i.id = any (v_tops) and i.owner = v_uid and i.deleted_at is null) <> cardinality(v_tops) then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 지울 항목이 없습니다';
  end if;

  -- 깊은 것부터 (0001 ez_delete 와 같은 이유). 맨 위 항목끼리는 서로의 자손이 아니라 겹치지 않는다
  for r in
    with recursive t(id, d) as (
      select x.id, 0 from unnest(v_tops) as x(id)
      union all
      select c.id, t.d + 1 from public.ez_items c join t on c.parent_id = t.id
      where c.owner = v_uid and c.deleted_at is null and t.d < 64
    )
    select t.id from t order by t.d desc
  loop
    update public.ez_items i set deleted_at = v_now, deleted_batch = v_batch where i.id = r.id;
  end loop;

  return v_batch;
end;
$$;

-- ---------------------------------------------------------------------------
-- 안(자손 어디든)에 안 읽은 보고서가 있는 살아 있는 폴더들
-- ---------------------------------------------------------------------------

create function public.ez_unread_folders(p_as uuid default null) returns setof uuid
language sql
stable
security invoker
set search_path = public
as $$
  with recursive up(id) as (
    select i.parent_id from public.ez_items i
     where i.owner = public.ez_actor(p_as) and i.deleted_at is null and i.kind = 'report'
       and i.parent_id is not null
       and i.agent_updated_at is not null and (i.read_at is null or i.agent_updated_at > i.read_at)
    union
    select f.parent_id from public.ez_items f join up on f.id = up.id
     where f.parent_id is not null
  )
  select f.id from up join public.ez_items f on f.id = up.id
   where f.owner = public.ez_actor(p_as) and f.deleted_at is null and f.kind = 'folder'
$$;

-- ---------------------------------------------------------------------------
-- 휴지통 묶음 목록: 묶음마다 맨 위 항목들(묶음 안에 부모가 없는 것)과 묶음 안 항목 수. 최근 지운 묶음 먼저
-- ---------------------------------------------------------------------------

create function public.ez_trash(p_as uuid default null)
returns table (batch uuid, deleted_at timestamptz, id uuid, kind text, name text, count int)
language sql
stable
security invoker
set search_path = public
as $$
  with b as (
    select i.id, i.parent_id, i.kind, i.name, i.deleted_batch,
           max(i.deleted_at) over (partition by i.deleted_batch) as del_at,
           (count(*) over (partition by i.deleted_batch))::int as n
      from public.ez_items i
     where i.owner = public.ez_actor(p_as) and i.deleted_at is not null
  )
  select b.deleted_batch, b.del_at, b.id, b.kind, b.name, b.n
    from b
   where not exists (select 1 from b p where p.id = b.parent_id and p.deleted_batch = b.deleted_batch)
   order by b.del_at desc, b.deleted_batch, b.name
$$;

-- ---------------------------------------------------------------------------
-- 공개 중 표시: 목록에는 열쇠 값 대신 켜졌는지만 싣는다 (PostgREST 계산 칸 select=…,shared:ez_is_shared)
-- ---------------------------------------------------------------------------

create function public.ez_is_shared(p_row public.ez_items) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_row.share_token is not null
$$;

-- ---------------------------------------------------------------------------
-- 함수 실행 권한: 0001 과 같이 기본(public) 회수 후 필요한 역할에만
-- ---------------------------------------------------------------------------

revoke all on function public.ez_copy_name(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ez_is_under(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.ez_top_ids(uuid[]) from public, anon, authenticated;
revoke all on function public.ez_copy(uuid[], uuid, uuid) from public, anon, authenticated;
revoke all on function public.ez_delete_many(uuid[], uuid) from public, anon, authenticated;
revoke all on function public.ez_unread_folders(uuid) from public, anon, authenticated;
revoke all on function public.ez_trash(uuid) from public, anon, authenticated;
revoke all on function public.ez_is_shared(public.ez_items) from public, anon, authenticated;

grant execute on function public.ez_copy_name(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.ez_is_under(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.ez_top_ids(uuid[]) to authenticated, service_role;
grant execute on function public.ez_copy(uuid[], uuid, uuid) to authenticated, service_role;
grant execute on function public.ez_delete_many(uuid[], uuid) to authenticated, service_role;
grant execute on function public.ez_unread_folders(uuid) to authenticated, service_role;
grant execute on function public.ez_trash(uuid) to authenticated, service_role;
grant execute on function public.ez_is_shared(public.ez_items) to authenticated, service_role;
