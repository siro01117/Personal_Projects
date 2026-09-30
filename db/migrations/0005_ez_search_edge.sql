-- 찾기: 사진의 edge(밝은/어두운 가장자리 표시 — 사용자 글자가 아님)도 뺀다. 0004 에서 제외 키 하나만 더함.

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
           and coalesce(w.k, '') not in ('type', 'tag', 'url', 'src', 'place', 'size', 'local_path', 'edge')
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

revoke all on function public.ez_search(text, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.ez_search(text, uuid, uuid, int) to authenticated, service_role;
