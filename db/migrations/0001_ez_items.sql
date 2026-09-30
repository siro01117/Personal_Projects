-- 보고서 서랍: 폴더와 보고서를 한 테이블에 (설계서 2장).
-- 모든 이름은 ez_ 로 시작한다. 다른 테이블(kv 등)은 건드리지 않는다.
-- 오류는 errcode P0001, message '[EZ_코드] 한국어 설명'.

-- ---------------------------------------------------------------------------
-- 도우미 (CHECK 에서도 쓰므로 테이블보다 먼저)
-- ---------------------------------------------------------------------------

-- JS String.prototype.trim 과 같은 문자 집합(WhiteSpace + LineTerminator)을 앞뒤에서 지운다
create function public.ez_trim(p text) returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select btrim(p, E'\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
$$;

-- ---------------------------------------------------------------------------
-- 테이블
-- ---------------------------------------------------------------------------

create table public.ez_items (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null default auth.uid(),
  parent_id        uuid references public.ez_items (id) on delete restrict,
  kind             text not null,
  name             text not null,
  report_kind      text,
  blocks           jsonb,
  schema_version   int not null default 1,
  agent            text,
  version          int not null default 1,
  agent_updated_at timestamptz,
  read_at          timestamptz,
  share_token      text,
  deleted_at       timestamptz,
  deleted_batch    uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint ez_items_kind_check check (kind in ('folder', 'report')),
  -- 이름: 앞뒤 공백 없음 · 1~100자 · / 금지 · 줄바꿈·제어문자 금지 · . 과 .. 금지 (lib/names.ts 와 같음)
  constraint ez_items_name_check check (
    name = public.ez_trim(name)
    and char_length(name) between 1 and 100
    and name !~ '[/\x01-\x1f\x7f-\x9f\u2028\u2029]'
    and name not in ('.', '..')
  ),
  constraint ez_items_fields_check check (
    (kind = 'folder' and blocks is null and report_kind is null)
    -- NULL 이 끼면 CHECK 가 통과해 버리므로 is not null 을 먼저
    or (kind = 'report' and blocks is not null and jsonb_typeof(blocks) = 'array'
        and report_kind is not null and report_kind in ('method', 'data', 'reference'))
  ),
  constraint ez_items_blocks_size_check check (blocks is null or pg_column_size(blocks) < 600000),
  constraint ez_items_schema_version_check check (schema_version >= 1),
  constraint ez_items_version_check check (version >= 1),
  constraint ez_items_agent_check check (agent is null or char_length(agent) between 1 and 100),
  constraint ez_items_share_check check (
    share_token is null or (kind = 'report' and share_token ~ '^[A-Za-z0-9_-]{22}$')
  ),
  constraint ez_items_deleted_check check ((deleted_at is null) = (deleted_batch is null)),
  constraint ez_items_not_self_parent check (parent_id is distinct from id)
);

-- 같은 폴더 안 같은 이름 금지 (대소문자 무시, 지운 것 제외). 이름은 이미 trim 되어 있다
create unique index ez_items_name_unique on public.ez_items
  (owner, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  where deleted_at is null;

create index ez_items_parent_idx on public.ez_items (parent_id);
create index ez_items_owner_idx on public.ez_items (owner);
create index ez_items_deleted_batch_idx on public.ez_items (deleted_batch) where deleted_batch is not null;
create unique index ez_items_share_token_unique on public.ez_items (share_token) where share_token is not null;

-- ---------------------------------------------------------------------------
-- 트리거: 부모·순환·깊이·버전
-- ---------------------------------------------------------------------------

create function public.ez_items_guard() returns trigger
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
    -- 버전은 내용(이름·블록·종류)이 바뀔 때만 오른다. 읽음·공유·옮기기·삭제는 동시 수정 충돌이 아니다
    if new.name is distinct from old.name
       or new.blocks is distinct from old.blocks
       or new.report_kind is distinct from old.report_kind
       or new.schema_version is distinct from old.schema_version then
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

create trigger ez_items_guard
  before insert or update on public.ez_items
  for each row execute function public.ez_items_guard();

-- ---------------------------------------------------------------------------
-- RLS: 내 것만
-- ---------------------------------------------------------------------------

alter table public.ez_items enable row level security;

create policy ez_items_select on public.ez_items for select to authenticated
  using (owner = (select auth.uid()));
create policy ez_items_insert on public.ez_items for insert to authenticated
  with check (owner = (select auth.uid()));
create policy ez_items_update on public.ez_items for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy ez_items_delete on public.ez_items for delete to authenticated
  using (owner = (select auth.uid()));

revoke all on table public.ez_items from public, anon, authenticated;
grant select, insert, update, delete on table public.ez_items to authenticated;

-- ---------------------------------------------------------------------------
-- 사람이 고칠 수 있는 칸 (lib/blocks.ts editRule 과 같은 규칙)
-- p_path 는 blocks 기준: {2,body}, {3,rows,1,0}. 고칠 수 없으면 max_length = null
-- ---------------------------------------------------------------------------

create function public.ez_edit_rule(p_blocks jsonb, p_path text[], out max_length int, out one_line boolean)
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
-- 이름 겹치면 ' (2)' 류 접미사 (lib/names.ts uniqueName 과 같은 규칙)
-- ---------------------------------------------------------------------------

create function public.ez_unique_name(p_owner uuid, p_parent uuid, p_name text, p_self uuid default null)
returns text
language plpgsql stable
set search_path = public
as $$
declare
  v_name text := public.ez_trim(p_name);
  v_stem text := v_name;
  v_n    int := 2;
  v_m    text[];
  v_suf  text;
  v_cand text;
begin
  if not exists (
    select 1 from public.ez_items i
    where i.owner = p_owner and i.parent_id is not distinct from p_parent and i.deleted_at is null
      and lower(i.name) = lower(v_name) and i.id is distinct from p_self
  ) then
    return v_name;
  end if;

  v_m := regexp_match(v_name, '^(.*) \((\d{1,6})\)$');
  if v_m is not null and v_m[1] <> '' then
    v_stem := v_m[1];
    v_n := greatest(2, v_m[2]::int + 1);
  end if;

  loop
    v_suf := format(' (%s)', v_n);
    v_cand := left(v_stem, 100 - char_length(v_suf)) || v_suf;
    if not exists (
      select 1 from public.ez_items i
      where i.owner = p_owner and i.parent_id is not distinct from p_parent and i.deleted_at is null
        and lower(i.name) = lower(v_cand) and i.id is distinct from p_self
    ) then
      return v_cand;
    end if;
    v_n := v_n + 1;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 휴지통: 지우기 · 묶음 복원
-- ---------------------------------------------------------------------------

-- 누구로서 하는가: 로그인한 사람이면 그 사람, service_role(MCP)이면 p_as 대리, 그 외 null
create function public.ez_actor(p_as uuid) returns uuid
language sql stable
security invoker
set search_path = ''
as $$
  select coalesce(auth.uid(), case when current_user = 'service_role' then p_as end)
$$;

-- 대상과 살아 있는 모든 자손을 같은 묶음으로 지운다. 묶음 id 반환
-- p_as 는 service_role 만 쓸 수 있다 (로그인한 사람이 넣으면 무시되고 자기 자신으로)
create function public.ez_delete(p_id uuid, p_as uuid default null) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch uuid := gen_random_uuid();
  v_now   timestamptz := now();
  v_uid   uuid := public.ez_actor(p_as);
  r       record;
begin
  if v_uid is null or not exists (
    select 1 from public.ez_items i where i.id = p_id and i.owner = v_uid and i.deleted_at is null
  ) then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 지울 항목이 없습니다';
  end if;

  -- 깊은 것부터 지워야 트리거의 "안에 살아 있는 것이 남은 폴더" 검사를 통과한다
  for r in
    with recursive t(id, d) as (
      select p_id, 0
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

-- 묶음을 얕은 것부터 복원. 부모가 살아 있지 않으면 맨 위로, 이름이 겹치면 ' (2)' 류를 붙인다
-- p_as 는 ez_delete 와 같다
create function public.ez_restore(p_batch uuid, p_as uuid default null)
returns table (id uuid, name text, to_root boolean, renamed boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid    uuid := public.ez_actor(p_as);
  r        record;
  v_parent uuid;
  v_name   text;
  v_any    boolean := false;
begin
  if v_uid is null then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 복원할 묶음이 없습니다';
  end if;

  for r in
    with recursive b as (
      select i.id, i.parent_id, i.name from public.ez_items i
      where i.deleted_batch = p_batch and i.owner = v_uid
    ), t(id, parent_id, name, d) as (
      select b.id, b.parent_id, b.name, 0 from b
      where b.parent_id is null or b.parent_id not in (select b2.id from b b2)
      union all
      select b.id, b.parent_id, b.name, t.d + 1 from b join t on b.parent_id = t.id where t.d < 64
    )
    select t.id, t.parent_id, t.name from t order by t.d, t.name
  loop
    v_any := true;
    v_parent := r.parent_id;
    to_root := false;
    if v_parent is not null and not exists (
      select 1 from public.ez_items p
      where p.id = v_parent and p.owner = v_uid and p.deleted_at is null and p.kind = 'folder'
    ) then
      v_parent := null;
      to_root := true;
    end if;

    v_name := public.ez_unique_name(v_uid, v_parent, r.name, r.id);
    begin
      update public.ez_items i
         set parent_id = v_parent, name = v_name, deleted_at = null, deleted_batch = null
       where i.id = r.id;
    exception when raise_exception then
      -- 그 사이 부모가 깊어져 8단을 넘으면 맨 위로. 다른 오류는 그대로 올린다
      if v_parent is null or sqlerrm not like '[EZ_DEPTH]%' then
        raise;
      end if;
      v_parent := null;
      to_root := true;
      v_name := public.ez_unique_name(v_uid, null, r.name, r.id);
      update public.ez_items i
         set parent_id = null, name = v_name, deleted_at = null, deleted_batch = null
       where i.id = r.id;
    end;

    id := r.id;
    name := v_name;
    renamed := v_name <> r.name;
    return next;
  end loop;

  if not v_any then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 복원할 묶음이 없습니다';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 글자 고치기
-- ---------------------------------------------------------------------------

-- p_path = {title} 이면 이름 바꾸기, 그 외에는 blocks 안의 허용된 문자열 칸. 새 version 반환
create function public.ez_edit_text(p_id uuid, p_base_version int, p_path text[], p_value text) returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row   public.ez_items%rowtype;
  v_value text := public.ez_trim(p_value);
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
    if v_value is null or v_value = '' then
      raise exception using errcode = 'P0001', message = '[EZ_EMPTY] 이름이 비어 있습니다';
    end if;
    update public.ez_items i set name = v_value where i.id = p_id returning i.version into v_ver;
    return v_ver;
  end if;

  select * into v_rule from public.ez_edit_rule(v_row.blocks, p_path);
  if v_row.kind <> 'report' or v_rule.max_length is null then
    raise exception using errcode = 'P0001', message = '[EZ_PATH] 이 칸은 고칠 수 없습니다';
  end if;

  if v_value is null or v_value = '' then
    raise exception using errcode = 'P0001', message = '[EZ_EMPTY] 빈 칸으로 둘 수 없습니다';
  end if;
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
-- 읽음 · 공유
-- ---------------------------------------------------------------------------

create function public.ez_mark_read(p_id uuid) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.ez_items i set read_at = now()
   where i.id = p_id and i.owner = auth.uid() and i.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 항목이 없습니다';
  end if;
end;
$$;

-- 새 공유 열쇠(22자, base64url) 발급. 이전 열쇠는 무효
create function public.ez_share(p_id uuid) returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_token text := translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/=', '-_');
begin
  update public.ez_items i set share_token = v_token
   where i.id = p_id and i.owner = auth.uid() and i.deleted_at is null and i.kind = 'report';
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 공유할 보고서가 없습니다';
  end if;
  return v_token;
end;
$$;

create function public.ez_unshare(p_id uuid) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.ez_items i set share_token = null
   where i.id = p_id and i.owner = auth.uid() and i.deleted_at is null and i.kind = 'report';
  if not found then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 공유를 끌 보고서가 없습니다';
  end if;
end;
$$;

-- 로그인 없이 공유 링크로 읽기. 없거나 꺼졌거나 지웠으면 빈 결과 (있었는지 드러내지 않는다)
create function public.ez_shared(p_token text)
returns table (name text, report_kind text, blocks jsonb, schema_version int, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select i.name, i.report_kind, i.blocks, i.schema_version, i.updated_at
    from public.ez_items i
   where p_token is not null
     and p_token ~ '^[A-Za-z0-9_-]{22}$'
     and i.share_token = p_token
     and i.kind = 'report'
     and i.deleted_at is null
$$;

-- ---------------------------------------------------------------------------
-- 함수 실행 권한: 기본(public) 회수 후 필요한 역할에만
-- ---------------------------------------------------------------------------

revoke all on function public.ez_trim(text) from public, anon, authenticated;
revoke all on function public.ez_items_guard() from public, anon, authenticated;
revoke all on function public.ez_edit_rule(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.ez_unique_name(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.ez_actor(uuid) from public, anon, authenticated;
revoke all on function public.ez_delete(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ez_restore(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ez_edit_text(uuid, int, text[], text) from public, anon, authenticated;
revoke all on function public.ez_mark_read(uuid) from public, anon, authenticated;
revoke all on function public.ez_share(uuid) from public, anon, authenticated;
revoke all on function public.ez_unshare(uuid) from public, anon, authenticated;
revoke all on function public.ez_shared(text) from public, anon, authenticated;

-- ez_trim 은 CHECK 가 쓰므로 테이블을 쓰는 역할이 실행할 수 있어야 한다
grant execute on function public.ez_trim(text) to authenticated;
grant execute on function public.ez_edit_rule(jsonb, text[]) to authenticated;
grant execute on function public.ez_unique_name(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.ez_actor(uuid) to authenticated;
grant execute on function public.ez_delete(uuid, uuid) to authenticated;
grant execute on function public.ez_restore(uuid, uuid) to authenticated;
grant execute on function public.ez_edit_text(uuid, int, text[], text) to authenticated;
grant execute on function public.ez_mark_read(uuid) to authenticated;
grant execute on function public.ez_share(uuid) to authenticated;
grant execute on function public.ez_unshare(uuid) to authenticated;
grant execute on function public.ez_shared(text) to anon, authenticated;

-- MCP(service_role): RLS 를 우회해 테이블에 직접 쓰고 owner 를 명시한다. 규칙은 트리거·CHECK·인덱스가 그대로 지킨다.
-- Supabase 기본 권한에 기대지 않고 명시한다
grant select, insert, update, delete on table public.ez_items to service_role;
grant execute on function public.ez_trim(text) to service_role;
grant execute on function public.ez_edit_rule(jsonb, text[]) to service_role;
grant execute on function public.ez_unique_name(uuid, uuid, text, uuid) to service_role;
grant execute on function public.ez_actor(uuid) to service_role;
grant execute on function public.ez_delete(uuid, uuid) to service_role;
grant execute on function public.ez_restore(uuid, uuid) to service_role;
