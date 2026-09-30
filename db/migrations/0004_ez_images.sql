-- 5단계 (설계서 7-2장 · 8-1장): 사진 블록 · 사진 저장소 · 휴지통 자동 비우기(14일).
-- 0001~0003 위에 더한다. 오류는 0001 과 같이 errcode P0001, message '[EZ_코드] 한국어 설명'.
--
-- 사진 파일은 Storage 버킷 ez-images 에 <주인 uuid>/<sha256 hex>.webp 로 둔다. 블록(blocks)에는 경로·크기·설명·출처만.
-- Supabase 에서는 storage.objects 를 SQL 로 직접 지우면 안 된다(파일이 남는다) — 파일 지우기는 Storage API 로만
-- (MCP 서버 시작 때 · npm run purge-images). 그래서 여기 휴지통 비우기는 행만 지우고, 주인 없는 사진은 MCP 가 치운다.
--
-- PGlite 시험은 '-- pg_cron:시작' ~ '-- pg_cron:끝' 사이를 건너뛴다 (PGlite 에 pg_cron 이 없다).

-- ---------------------------------------------------------------------------
-- 사람이 고칠 수 있는 칸: image 의 alt · caption 을 더한다 (lib/blocks.ts editRule 과 같은 규칙)
-- ---------------------------------------------------------------------------

create or replace function public.ez_edit_rule(p_blocks jsonb, p_path text[], out max_length int, out one_line boolean)
language plpgsql immutable parallel safe
set search_path = ''
as $$
declare
  v_idx  constant text := '^(0|[1-9][0-9]{0,5})$';
  v_len  int := coalesce(array_length(p_path, 1), 0) - 1;
  v_type text;
  a text := p_path[2];
  b text := p_path[3];
  c text := p_path[4];
begin
  max_length := null;
  one_line := false;
  if p_blocks is null or jsonb_typeof(p_blocks) <> 'array' or v_len < 1 or v_len > 3 then
    return;
  end if;
  -- #> 는 음수 번호를 뒤에서부터 센다. 번호 자리는 모두 0 이상 정수 꼴(v_idx)만 받는다
  if p_path[1] !~ v_idx then
    return;
  end if;
  if jsonb_typeof(p_blocks -> (p_path[1]::int)) is distinct from 'object' then
    return;
  end if;
  v_type := p_blocks -> (p_path[1]::int) ->> 'type';

  if v_len = 1 then
    if v_type = 'verdict' and a = 'v' then max_length := 300; one_line := true;
    elsif v_type = 'verdict' and a = 'w' then max_length := 2000;
    elsif v_type = 'text' and a = 'body' then max_length := 4000;
    elsif v_type in ('text', 'list', 'table', 'claims', 'sources') and a = 'h' then max_length := 200;
    -- 사진: 설명·캡션 글자만. src·배치·크기·출처 번호·경로는 못 고친다
    elsif v_type = 'image' and a in ('alt', 'caption') then max_length := 300; one_line := true;
    end if;
  elsif v_len = 2 and b ~ v_idx then
    if v_type = 'list' and a = 'items' then max_length := 600;
    elsif v_type = 'table' and a = 'cols' then max_length := 300;
    end if;
  elsif v_len = 3 and b ~ v_idx then
    if v_type = 'table' and a = 'rows' and c ~ v_idx then max_length := 300;
    elsif v_type = 'claims' and a = 'items' and c = 'text' then max_length := 600;
    elsif v_type = 'sources' and a = 'items' and c = 'title' then max_length := 300;
    end if;
  end if;

  -- 그 자리에 원래 문자열이 있어야 한다
  if max_length is not null and jsonb_typeof(p_blocks #> p_path) is distinct from 'string' then
    max_length := null;
    one_line := false;
  end if;
  if max_length is null then
    one_line := false;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 공유 페이지: 사진의 local_path(내 PC 경로 — 사용자 이름·폴더 구조가 드러난다)를 빼고 돌려준다
-- (lib/blocks.ts withoutLocalPaths 와 같은 규칙). 돌려주는 모양은 0001 그대로
-- ---------------------------------------------------------------------------

create or replace function public.ez_shared(p_token text)
returns table (name text, report_kind text, blocks jsonb, schema_version int, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select i.name,
         i.report_kind,
         (select coalesce(jsonb_agg(
                   case when jsonb_typeof(e.b) = 'object' and e.b ->> 'type' = 'image' then e.b - 'local_path' else e.b end
                   order by e.n), '[]'::jsonb)
            from jsonb_array_elements(i.blocks) with ordinality as e(b, n)),
         i.schema_version,
         i.updated_at
    from public.ez_items i
   where p_token is not null
     and p_token ~ '^[A-Za-z0-9_-]{22}$'
     and i.share_token = p_token
     and i.kind = 'report'
     and i.deleted_at is null
$$;

-- ---------------------------------------------------------------------------
-- 찾기: 사진의 src · place · size · local_path 는 사용자 글자가 아니므로 뺀다 (0002 에서 키 조건만 바뀜)
-- ---------------------------------------------------------------------------

create or replace function public.ez_search(p_query text, p_as uuid default null, p_under uuid default null, p_limit int default 20)
returns table (
  id          uuid,
  kind        text,
  name        text,
  parent_id   uuid,
  report_kind text,
  match       text,
  snippet     text,
  updated_at  timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid   uuid := public.ez_actor(p_as);
  v_q     text := public.ez_trim(p_query);
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_pat   text;
begin
  if v_q is null or v_q = '' then
    raise exception using errcode = 'P0001', message = '[EZ_EMPTY] 찾을 글자가 비어 있습니다';
  end if;
  if v_uid is null then
    return;
  end if;
  if p_under is not null and not exists (
    select 1 from public.ez_items f
    where f.id = p_under and f.owner = v_uid and f.deleted_at is null and f.kind = 'folder'
  ) then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 찾을 폴더가 없습니다';
  end if;

  -- 사용자 입력의 \ % _ 는 글자 그대로
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  with recursive sub(id, d) as (
    select p_under, 0 where p_under is not null
    union all
    select c.id, u.d + 1 from public.ez_items c join sub u on c.parent_id = u.id
    where c.owner = v_uid and c.deleted_at is null and c.kind = 'folder' and u.d < 64
  ),
  scope as (
    select i.* from public.ez_items i
    where i.owner = v_uid and i.deleted_at is null
      and (p_under is null or i.parent_id in (select u.id from sub u))
  ),
  hits as (
    select s.id, s.kind, s.name, s.parent_id, s.report_kind, 'name'::text as match, null::text as hit, s.updated_at, 0 as ord
      from scope s
     where s.name ilike v_pat escape '\'
    union all
    select s.id, s.kind, s.name, s.parent_id, s.report_kind, 'body'::text, b.txt, s.updated_at, 1
      from scope s
      cross join lateral (
        -- blocks 안의 문자열 값만. 배열 원소는 부모 키를 물려받는다. 사용자 글자가 아닌 키의 값은 뺀다
        with recursive walk(k, v) as (
          select null::text, s.blocks
          union all
          select coalesce(e.k, w.k), e.v
            from walk w
            cross join lateral (
              select o.key as k, o.value as v
                from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) o
              union all
              select null, a.value
                from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) a
            ) e
        )
        select w.v #>> '{}' as txt
          from walk w
         where jsonb_typeof(w.v) = 'string'
           and coalesce(w.k, '') not in ('type', 'tag', 'url', 'src', 'place', 'size', 'local_path')
           and (w.v #>> '{}') ilike v_pat escape '\'
         limit 1
      ) b
     where s.kind = 'report' and not (s.name ilike v_pat escape '\')
  )
  select h.id, h.kind, h.name, h.parent_id, h.report_kind, h.match,
         case when h.hit is null then null else (
           select (case when x.st > 1 then '…' else '' end)
                  || regexp_replace(substr(h.hit, x.st, x.en - x.st), '\s+', ' ', 'g')
                  || (case when x.en <= char_length(h.hit) then '…' else '' end)
             from (
               select greatest(1, p.pos - 40) as st,
                      least(char_length(h.hit) + 1, p.pos + char_length(v_q) + 40) as en
                 from (select greatest(strpos(lower(h.hit), lower(v_q)), 1) as pos) p
             ) x
         ) end,
         h.updated_at
    from hits h
   order by h.ord, h.updated_at desc, h.id
   limit v_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 사진 도우미
-- ---------------------------------------------------------------------------

-- 이 경로의 사진을 쓰는, 공유 켜진 살아 있는 보고서가 있는가 (anon 읽기 정책용).
-- 경로의 첫 폴더(주인)와 보고서 주인이 같아야 한다 — 남의 사진 경로를 내 공유 보고서에 적어 꺼내 보지 못하게
create function public.ez_image_is_shared(p_name text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.ez_items i
     where i.kind = 'report'
       and i.deleted_at is null
       and i.share_token is not null
       and i.owner::text = split_part(p_name, '/', 1)
       and i.blocks @> jsonb_build_array(jsonb_build_object('type', 'image', 'src', p_name))
  )
$$;

-- 주인의 보고서(살아 있든 휴지통이든)가 쓰는 사진 경로 전부 — MCP 가 주인 없는 사진을 치울 때 쓴다
create function public.ez_image_srcs(p_as uuid default null) returns setof text
language sql
stable
security invoker
set search_path = public
as $$
  select distinct e.b ->> 'src'
    from public.ez_items i
   cross join lateral jsonb_array_elements(i.blocks) as e(b)
   where i.owner = public.ez_actor(p_as)
     and i.kind = 'report'
     and jsonb_typeof(e.b) = 'object'
     and e.b ->> 'type' = 'image'
     and jsonb_typeof(e.b -> 'src') = 'string'
$$;

-- ---------------------------------------------------------------------------
-- 사진 저장소: 비공개 버킷. 형식은 WebP 만, 한 장 500KB(512,000바이트)까지 — 에이전트가 실수해도 저장소가 거절한다
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ez-images', 'ez-images', false, 512000, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 로그인한 사람: 첫 폴더가 자기 uid 인 것만 읽기·올리기·지우기 (덮어쓰기 없음 — 같은 내용은 같은 경로라 필요 없다)
drop policy if exists ez_images_select_own on storage.objects;
create policy ez_images_select_own on storage.objects for select to authenticated
  using (bucket_id = 'ez-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists ez_images_insert_own on storage.objects;
create policy ez_images_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'ez-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists ez_images_delete_own on storage.objects;
create policy ez_images_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'ez-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 로그인 없이(공유 페이지): 공유 켜진 살아 있는 보고서가 쓰는 사진만 읽기. 목록·올리기·지우기는 없음
drop policy if exists ez_images_select_shared on storage.objects;
create policy ez_images_select_shared on storage.objects for select to anon
  using (bucket_id = 'ez-images' and public.ez_image_is_shared(name));

-- ---------------------------------------------------------------------------
-- 휴지통 자동 비우기: 지운 지 p_days 일 지난 묶음의 행을 영구 삭제. 지운 행 수를 돌려준다.
-- 자기참조 외래키(parent_id → id, on delete restrict) 때문에 깊은 것부터: 안에 남은 행이 없는 것부터 한 겹씩 지운다.
-- 그래서 다른(아직 안 지난) 묶음이나 살아 있는 행이 안에 남은 폴더는 이번에는 남는다 — 다음에 지워진다.
-- 사진 파일은 여기서 못 지운다(Storage API 만) — MCP 가 주인 없는 사진을 치운다
-- ---------------------------------------------------------------------------

create function public.ez_purge_trash(p_days int default 14) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batches uuid[];
  v_total   int := 0;
  v_n       int;
begin
  if p_days is null or p_days < 0 then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 며칠 지난 것을 지울지 0 이상으로 주세요';
  end if;

  -- 묶음의 지운 때 = 그 묶음에서 가장 늦은 deleted_at (ez_trash 와 같다)
  select coalesce(array_agg(x.batch), '{}') into v_batches
    from (
      select i.deleted_batch as batch from public.ez_items i
       where i.deleted_batch is not null
       group by i.deleted_batch
      having max(i.deleted_at) <= now() - make_interval(days => p_days)
    ) x;
  if cardinality(v_batches) = 0 then
    return 0;
  end if;

  for guard in 1..64 loop
    delete from public.ez_items i
     where i.deleted_batch = any (v_batches)
       and not exists (select 1 from public.ez_items c where c.parent_id = i.id);
    get diagnostics v_n = row_count;
    exit when v_n = 0;
    v_total := v_total + v_n;
  end loop;

  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 함수 실행 권한: 0001 과 같이 기본(public) 회수 후 필요한 역할에만.
-- create or replace 는 권한을 그대로 두지만 한 번 더 적어 둔다
-- ---------------------------------------------------------------------------

revoke all on function public.ez_edit_rule(jsonb, text[]) from public, anon, authenticated;
grant execute on function public.ez_edit_rule(jsonb, text[]) to authenticated, service_role;

revoke all on function public.ez_shared(text) from public, anon, authenticated;
grant execute on function public.ez_shared(text) to anon, authenticated;

revoke all on function public.ez_search(text, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.ez_search(text, uuid, uuid, int) to authenticated, service_role;

-- 정책 안에서 부르므로 anon·authenticated 가 실행할 수 있어야 한다 (security definer — 결과는 참/거짓뿐)
revoke all on function public.ez_image_is_shared(text) from public, anon, authenticated;
grant execute on function public.ez_image_is_shared(text) to anon, authenticated, service_role;

revoke all on function public.ez_image_srcs(uuid) from public, anon, authenticated;
grant execute on function public.ez_image_srcs(uuid) to service_role;

-- 영구 삭제는 postgres(주인 — pg_cron 이 이 역할로 돈다)와 service_role 만
revoke all on function public.ez_purge_trash(int) from public, anon, authenticated;
grant execute on function public.ez_purge_trash(int) to service_role;

-- pg_cron:시작 ------------------------------------------------------------------
-- Supabase 권장 방식 (docs/guides/cron/install). 매일 03:17(UTC) 한 번.
-- cron.schedule 은 같은 이름의 일이 있으면 새로 만들지 않고 고친다 — 이 파일을 다시 돌려도 한 개만 남는다
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
select cron.schedule('ez-purge-trash', '17 3 * * *', 'select public.ez_purge_trash(14)');
-- pg_cron:끝 --------------------------------------------------------------------
