-- 사람이 고치는 칸 규칙 바꿈 (설계서 3장 "사람이 고칠 수 있는 칸", 2026-10-02). 0001 · 0004 위에 더한다.
--  1) 빈칸 허용: 블록 칸은 빈 값('')으로 둘 수 있다. 보고서 제목만 [EZ_EMPTY]
--  2) 줄바꿈: 되는 칸 = 문단 · 판정 풀이 · 목록 항목 · 표 칸(머리 제외) · 근거 글. 나머지(소제목 · 판정 한 줄 · 표 머리 · 출처 제목 · 사진 설명·캡션)는 한 줄
--  3) 작성자: path {agent} 로 보고서의 agent 를 고친다(1~100자 한 줄, 비우면 null). agent_updated_at 은 그대로 — 안 읽음 점이 생기지 않는다
-- 오류는 0001 과 같이 errcode P0001, message '[EZ_코드] 한국어 설명'.

-- ---------------------------------------------------------------------------
-- 트리거: 작성자(agent)가 바뀌어도 version 이 오른다 (0001 과 그 한 줄만 다르다)
-- ---------------------------------------------------------------------------

create or replace function public.ez_items_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent   public.ez_items%rowtype;
  v_depth    int;
  v_height   int;
  v_restored boolean := tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null;
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := now();
    new.updated_at := now();
  else
    if new.kind is distinct from old.kind or new.owner is distinct from old.owner or new.id is distinct from old.id then
      raise exception using errcode = 'P0001', message = '[EZ_FIXED] 종류·주인·id 는 바꿀 수 없습니다';
    end if;
    -- 버전은 내용(이름·블록·종류·작성자)이 바뀔 때만 오른다. 읽음·공유·옮기기·삭제는 동시 수정 충돌이 아니다
    if new.name is distinct from old.name
       or new.blocks is distinct from old.blocks
       or new.report_kind is distinct from old.report_kind
       or new.schema_version is distinct from old.schema_version
       or new.agent is distinct from old.agent then
      new.version := old.version + 1;
      new.updated_at := now();
    else
      new.version := old.version;
      new.updated_at := old.updated_at;
    end if;
    new.created_at := old.created_at;
  end if;

  -- 폴더를 휴지통으로 보낼 때 안에 살아 있는 것이 남으면 안 된다 (ez_delete 는 깊은 것부터 지운다)
  if tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null and new.kind = 'folder'
     and exists (select 1 from public.ez_items c where c.parent_id = new.id and c.deleted_at is null) then
    raise exception using errcode = 'P0001',
      message = '[EZ_PARENT] 안에 지우지 않은 항목이 있는 폴더입니다. ez_delete 로 묶음째 지우세요';
  end if;

  -- 새 자리에 놓일 때만 부모를 검사한다 (새로 만들기 · 옮기기 · 복원). 휴지통으로 보낼 때는 안 한다
  if not (tg_op = 'INSERT' or v_restored or new.parent_id is distinct from old.parent_id) then
    return new;
  end if;

  -- 같은 주인의 구조 변경을 줄 세운다 (동시에 서로를 옮겨 순환이 생기는 것 방지)
  perform pg_advisory_xact_lock(hashtextextended('ez_items:' || new.owner::text, 0));

  if new.parent_id is not null then
    select * into v_parent from public.ez_items p where p.id = new.parent_id;
    if not found or v_parent.owner <> new.owner then
      raise exception using errcode = 'P0001', message = '[EZ_PARENT] 넣을 폴더가 없습니다';
    elsif v_parent.deleted_at is not null then
      raise exception using errcode = 'P0001', message = '[EZ_PARENT] 지워진 폴더에는 넣을 수 없습니다';
    elsif v_parent.kind <> 'folder' then
      raise exception using errcode = 'P0001', message = '[EZ_PARENT] 폴더가 아닌 곳에는 넣을 수 없습니다';
    end if;
  end if;

  if new.kind <> 'folder' then
    return new;
  end if;

  -- 새 부모의 조상 사슬: 순환과 깊이
  if new.parent_id is null then
    v_depth := 0;
  else
    if exists (
      with recursive anc(id, parent_id, d) as (
        select p.id, p.parent_id, 1 from public.ez_items p where p.id = new.parent_id
        union all
        select p.id, p.parent_id, a.d + 1 from public.ez_items p join anc a on p.id = a.parent_id where a.d < 64
      )
      select 1 from anc where anc.id = new.id
    ) then
      raise exception using errcode = 'P0001', message = '[EZ_CYCLE] 폴더를 자기 자신이나 자기 안의 폴더로 옮길 수 없습니다';
    end if;

    with recursive anc(id, parent_id, d) as (
      select p.id, p.parent_id, 1 from public.ez_items p where p.id = new.parent_id
      union all
      select p.id, p.parent_id, a.d + 1 from public.ez_items p join anc a on p.id = a.parent_id where a.d < 64
    )
    select max(d) into v_depth from anc;
  end if;

  -- 옮기는 폴더 아래 살아 있는 폴더 높이 (자기 포함)
  if tg_op = 'INSERT' then
    v_height := 1;
  else
    with recursive sub(id, h) as (
      select new.id, 1
      union all
      select c.id, s.h + 1 from public.ez_items c join sub s on c.parent_id = s.id
      where c.kind = 'folder' and c.deleted_at is null and s.h < 64
    )
    select max(h) into v_height from sub;
  end if;

  if v_depth + v_height > 8 then
    raise exception using errcode = 'P0001',
      message = format('[EZ_DEPTH] 폴더는 8단까지만 넣을 수 있습니다 (옮기면 %s단)', v_depth + v_height);
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 사람이 고칠 수 있는 칸 (lib/blocks.ts editRule 과 같은 규칙) — 0004 에서 한 줄 규칙만 바뀜:
-- 소제목 h · 표 머리 cols · 출처 제목 title 이 한 줄이 된다
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
    elsif v_type in ('text', 'list', 'table', 'claims', 'sources') and a = 'h' then max_length := 200; one_line := true;
    -- 사진: 설명·캡션 글자만. src·배치·크기·출처 번호·경로는 못 고친다
    elsif v_type = 'image' and a in ('alt', 'caption') then max_length := 300; one_line := true;
    end if;
  elsif v_len = 2 and b ~ v_idx then
    if v_type = 'list' and a = 'items' then max_length := 600;
    elsif v_type = 'table' and a = 'cols' then max_length := 300; one_line := true;
    end if;
  elsif v_len = 3 and b ~ v_idx then
    if v_type = 'table' and a = 'rows' and c ~ v_idx then max_length := 300;
    elsif v_type = 'claims' and a = 'items' and c = 'text' then max_length := 600;
    elsif v_type = 'sources' and a = 'items' and c = 'title' then max_length := 300; one_line := true;
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
-- 글자 고치기
-- p_path = {title} 이름 바꾸기(비울 수 없다) · {agent} 작성자(보고서만, 비우면 null) · 그 외에는 blocks 안의 허용된 문자열 칸(비울 수 있다).
-- 새 version 반환. 값이 그대로면 version 도 그대로
-- ---------------------------------------------------------------------------

create or replace function public.ez_edit_text(p_id uuid, p_base_version int, p_path text[], p_value text) returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row   public.ez_items%rowtype;
  v_value text := coalesce(public.ez_trim(p_value), '');
  v_rule  record;
  v_ver   int;
begin
  select * into v_row from public.ez_items i
   where i.id = p_id and i.owner = auth.uid() and i.deleted_at is null
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 고칠 항목이 없습니다';
  end if;

  if p_base_version is distinct from v_row.version then
    raise exception using errcode = 'P0001',
      message = format('[EZ_VERSION] 그 사이 다른 곳에서 고쳤습니다. 새로 불러오세요 (지금 버전 %s)', v_row.version);
  end if;

  if p_path = array['title'] then
    if v_value = '' then
      raise exception using errcode = 'P0001', message = '[EZ_EMPTY] 이름이 비어 있습니다';
    end if;
    update public.ez_items i set name = v_value where i.id = p_id returning i.version into v_ver;
    return v_ver;
  end if;

  -- 작성자: 사람이 고친 것이라 agent_updated_at 은 건드리지 않는다
  if p_path = array['agent'] then
    if v_row.kind <> 'report' then
      raise exception using errcode = 'P0001', message = '[EZ_PATH] 이 칸은 고칠 수 없습니다';
    end if;
    if char_length(v_value) > 100 then
      raise exception using errcode = 'P0001',
        message = format('[EZ_VALUE] %s자까지 쓸 수 있습니다 (지금 %s자)', 100, char_length(v_value));
    end if;
    if v_value ~ E'[\n\r\u2028\u2029]' then
      raise exception using errcode = 'P0001', message = '[EZ_VALUE] 한 줄로 써야 합니다 (줄바꿈 없이)';
    end if;
    update public.ez_items i set agent = nullif(v_value, '') where i.id = p_id returning i.version into v_ver;
    return v_ver;
  end if;

  select * into v_rule from public.ez_edit_rule(v_row.blocks, p_path);
  if v_row.kind <> 'report' or v_rule.max_length is null then
    raise exception using errcode = 'P0001', message = '[EZ_PATH] 이 칸은 고칠 수 없습니다';
  end if;

  -- 다듬기 (lib/blocks.ts tidyText 와 같다): 줄 끝 공백을 지우고 연속 빈 줄은 하나로. 가운데 줄바꿈은 지킨다
  v_value := regexp_replace(v_value, E'\r\n?', E'\n', 'g');
  v_value := regexp_replace(v_value, E'[ \t\u00a0\u3000]+\n', E'\n', 'g');
  v_value := regexp_replace(v_value, E'\n{3,}', E'\n\n', 'g');

  if char_length(v_value) > v_rule.max_length then
    raise exception using errcode = 'P0001',
      message = format('[EZ_VALUE] %s자까지 쓸 수 있습니다 (지금 %s자)', v_rule.max_length, char_length(v_value));
  end if;
  if v_rule.one_line and v_value ~ E'[\n\r\u2028\u2029]' then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 한 줄로 써야 합니다 (줄바꿈 없이)';
  end if;

  update public.ez_items i
     set blocks = jsonb_set(i.blocks, p_path, to_jsonb(v_value), false)
   where i.id = p_id
  returning i.version into v_ver;
  return v_ver;
end;
$$;

-- ---------------------------------------------------------------------------
-- 함수 실행 권한: 0001 · 0004 와 같게 다시 준다
-- ---------------------------------------------------------------------------

revoke all on function public.ez_items_guard() from public, anon, authenticated;
revoke all on function public.ez_edit_rule(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.ez_edit_text(uuid, int, text[], text) from public, anon, authenticated;
grant execute on function public.ez_edit_rule(jsonb, text[]) to authenticated, service_role;
grant execute on function public.ez_edit_text(uuid, int, text[], text) to authenticated;
