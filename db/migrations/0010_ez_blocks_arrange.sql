-- 사람이 블록을 지우고 옮기기 (설계서 3장 "사람이 블록을 고르고 · 지우고 · 옮기기", 2026-10-02). 0001 · 0009 위에 더한다.
-- p_order = 새 순서로 늘어놓은 옛 블록 번호(0부터). 빠진 번호 = 지움.
-- 블록 안의 내용은 받지 않으므로 "블록 안은 손으로 안 바뀐다" 가 그대로다 — 딱 하나, 출처 블록이 하나도 안 남으면
-- 근거 블록의 출처 번호(refs)를 비우고 사진 블록의 ref 를 뺀다(가리킬 곳이 없어지므로. lib/blocks.ts arrangeBlocks 와 같은 규칙).
-- 사람이 고친 것이라 agent_updated_at 은 그대로 — 안 읽음 점이 생기지 않는다. version 은 트리거(0009 ez_items_guard)가 올린다.
-- 사진 블록이 빠져도 파일은 여기서 지우지 않는다: 어느 보고서도 안 쓰게 된 사진은 MCP 의 purgeImages 가 치운다(0004 머리말).
-- 오류는 0001 과 같이 errcode P0001, message '[EZ_코드] 한국어 설명'.

create function public.ez_blocks_arrange(p_id uuid, p_base_version int, p_order int[]) returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row    public.ez_items%rowtype;
  v_n      int;
  v_len    int := coalesce(cardinality(p_order), 0);
  v_blocks jsonb;
  v_ver    int;
begin
  select * into v_row from public.ez_items i
   where i.id = p_id and i.owner = auth.uid() and i.deleted_at is null and i.kind = 'report'
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 고칠 보고서가 없습니다';
  end if;

  if p_base_version is distinct from v_row.version then
    raise exception using errcode = 'P0001',
      message = format('[EZ_VERSION] 그 사이 다른 곳에서 고쳤습니다. 새로 불러오세요 (지금 버전 %s)', v_row.version);
  end if;

  v_n := jsonb_array_length(v_row.blocks);

  if v_len = 0 then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 블록이 하나는 남아야 합니다';
  end if;
  if array_ndims(p_order) <> 1
     or exists (select 1 from unnest(p_order) as o(x) where o.x is null or o.x < 0 or o.x >= v_n) then
    raise exception using errcode = 'P0001',
      message = format('[EZ_VALUE] 없는 블록 번호가 있습니다 (블록은 0~%s번)', v_n - 1);
  end if;
  if (select count(distinct o.x) from unnest(p_order) as o(x)) <> v_len then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 같은 블록 번호가 두 번 들어 있습니다';
  end if;

  -- 순서도 그대로, 지운 것도 없음: 아무것도 안 바꾼다
  if v_len = v_n and not exists (select 1 from unnest(p_order) with ordinality as o(x, k) where o.x <> o.k - 1) then
    return v_row.version;
  end if;

  select jsonb_agg(v_row.blocks -> o.x order by o.k) into v_blocks
    from unnest(p_order) with ordinality as o(x, k);

  -- 출처 블록이 하나도 안 남았으면 근거의 출처 번호를 비운다
  if not exists (select 1 from jsonb_array_elements(v_blocks) as e(b)
                  where jsonb_typeof(e.b) = 'object' and e.b ->> 'type' = 'sources') then
    select jsonb_agg(
             case
               when jsonb_typeof(e.b) = 'object' and e.b ->> 'type' = 'claims' and jsonb_typeof(e.b -> 'items') = 'array' then
                 jsonb_set(e.b, '{items}', (
                   select coalesce(jsonb_agg(
                            case when jsonb_typeof(t.it) = 'object' and t.it ? 'refs' then jsonb_set(t.it, '{refs}', '[]'::jsonb) else t.it end
                            order by t.k), '[]'::jsonb)
                     from jsonb_array_elements(e.b -> 'items') with ordinality as t(it, k)))
               when jsonb_typeof(e.b) = 'object' and e.b ->> 'type' = 'image' then e.b - 'ref'
               else e.b
             end
             order by e.k)
      into v_blocks
      from jsonb_array_elements(v_blocks) with ordinality as e(b, k);
  end if;

  update public.ez_items i set blocks = v_blocks where i.id = p_id returning i.version into v_ver;
  return v_ver;
end;
$$;

revoke all on function public.ez_blocks_arrange(uuid, int, int[]) from public, anon, authenticated;
grant execute on function public.ez_blocks_arrange(uuid, int, int[]) to authenticated;
