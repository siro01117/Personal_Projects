-- 원격 적용용 — 0014_ez_notes.sql 전체 (0013b_functions.sql 다음에 넣는다). 본문은 0014_ez_notes.sql 과 같다.

-- 방명록 · 댓글 · 방문 기록 (docs/보고서-서랍.md 7-5장). 0013 위에 더한다.
--
-- 테이블:            ez_visits — 방문 하나하나 (어느 기기 · 들어왔을 때 버전 · 시작 · 마지막 · 읽은 초). ez_views 는 기기 요약, 이것은 낱낱
--                    ez_notes  — 방명록(block 없음) · 댓글(block + anchor). 주인의 답글은 view_id null + by_owner. 지우기는 soft (deleted_at)
-- 고치는 함수:        ez_view_open · ez_view_ping (0013) — 방문 줄을 만들고 현재 방문에 초를 더한다. ez_views.seconds 는 그대로 방문들의 합
-- 남(anon)이 부르는 함수: ez_notes_list (전부 + 쓴 사람 라벨) · ez_note_write (쓰기) · ez_note_edit (같은 기기가 쓴 것만 고치기 · 지우기)
-- 주인:              RLS 아래 직접 — ez_notes select · 답글 insert(by_owner) · 아무 글이나 숨기기(update deleted_at 만). ez_visits select
--
-- "현재 방문" = 그 기기의 마지막 방문이 30분 안에 살아 있으면 그것, 아니면 새 방문. 기기당 200줄 (넘으면 더 적지 않는다 — 새 방문을 안 만든다).
-- 보고서당 500줄(0013)도 그대로 — 다 차면 새 기기는 줄도 방문도 안 만든다.
-- ez_notes.version 은 트리거가 ez_items.version 의 지금 값을 적는다 (함수든 주인이든). 보고서당 1,000줄 (넘으면 [EZ_LIMIT]). 한 기기는 10초에 하나 ([EZ_RATE]).
-- 공유 페이지 읽기는 ez_shared_doc (ez_shared 에 version 을 더한 새 함수. 옛 ez_shared 는 그대로).
-- 열쇠 → 보고서는 ez_view_target (0013) — 없는 열쇠 · 꺼진 링크 · 지운 보고서 · 주인 본인이면 빈 결과.
-- security definer 함수는 search_path 를 고정한다 (public, pg_temp).

-- ---------------------------------------------------------------------------
-- 테이블
-- ---------------------------------------------------------------------------

create table public.ez_visits (
  id         uuid primary key default gen_random_uuid(),
  view_id    uuid not null references public.ez_views (id) on delete cascade,
  version    int not null,
  started_at timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  seconds    int not null default 0,

  constraint ez_visits_version_check check (version >= 1),
  constraint ez_visits_seconds_check check (seconds >= 0),
  constraint ez_visits_at_check check (last_at >= started_at)
);

create index ez_visits_view_last_idx on public.ez_visits (view_id, last_at desc);

alter table public.ez_visits enable row level security;

-- 주인만 읽는다 (자기 보고서의 기기들의 방문)
create policy ez_visits_select on public.ez_visits for select to authenticated
  using (exists (
    select 1 from public.ez_views v join public.ez_items i on i.id = v.item_id
     where v.id = view_id and i.owner = (select auth.uid())
  ));

grant select on table public.ez_visits to authenticated;

create table public.ez_notes (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.ez_items (id) on delete cascade,
  -- 쓴 사람의 기기 줄. 그 줄이 없어져도(관리자가 손으로) 글은 남는다 — 라벨만 없어진다
  view_id    uuid references public.ez_views (id) on delete set null,
  by_owner   boolean not null default false,
  body       text not null,
  version    int not null,
  block      int,
  anchor     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  -- 글: 앞뒤 공백 없는 1~1,000자, 줄바꿈 · 탭 말고는 제어문자 금지. 텍스트로만 그린다
  constraint ez_notes_body_check check (body = public.ez_trim(body) and char_length(body) between 1 and 1000 and body !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  constraint ez_notes_version_check check (version >= 1),
  constraint ez_notes_block_check check (block is null or block >= 0),
  -- anchor 는 댓글(block)에만. 200자까지
  constraint ez_notes_anchor_check check (anchor is null or (block is not null and char_length(anchor) between 1 and 200)),
  -- 주인의 글은 기기 줄이 없다
  constraint ez_notes_owner_check check (not by_owner or view_id is null),
  constraint ez_notes_at_check check (updated_at >= created_at)
);

create index ez_notes_item_created_idx on public.ez_notes (item_id, created_at);
create index ez_notes_view_created_idx on public.ez_notes (view_id, created_at desc);

alter table public.ez_notes enable row level security;

-- 주인: 자기 보고서의 글을 읽는다. 지운 것(deleted_at)은 화면 · MCP 가 뺀다 — 정책에 deleted_at is null 을 넣으면
-- where 가 있는 update 의 새 줄에도 select 정책이 걸려(Postgres 규칙) 숨기기(update deleted_at) 자체가 거절된다
create policy ez_notes_select on public.ez_notes for select to authenticated
  using (exists (select 1 from public.ez_items i where i.id = item_id and i.owner = (select auth.uid())));

-- 주인: 답글 — 살아 있는 자기 보고서에 by_owner 로만
create policy ez_notes_insert on public.ez_notes for insert to authenticated
  with check (
    by_owner and view_id is null and deleted_at is null
    and exists (select 1 from public.ez_items i where i.id = item_id and i.owner = (select auth.uid()) and i.deleted_at is null)
  );

-- 주인: 아무 글이나 지우기 (열 권한이 deleted_at 뿐이라 그 밖은 못 바꾼다)
create policy ez_notes_update on public.ez_notes for update to authenticated
  using (deleted_at is null and exists (select 1 from public.ez_items i where i.id = item_id and i.owner = (select auth.uid())))
  with check (exists (select 1 from public.ez_items i where i.id = item_id and i.owner = (select auth.uid())));

grant select on table public.ez_notes to authenticated;
grant insert (item_id, by_owner, body, block, anchor) on table public.ez_notes to authenticated;
grant update (deleted_at) on table public.ez_notes to authenticated;

-- ---------------------------------------------------------------------------
-- 트리거 (insert 만): version 은 늘 보고서의 지금 값 · 시각은 서버가 · 보고서당 1,000줄 (지운 것 포함 — 저장 상한이다).
-- update 는 주인은 deleted_at 열 권한만, 남은 ez_note_edit 만 거치므로 트리거로 더 막을 것이 없다
-- ---------------------------------------------------------------------------

create function public.ez_notes_before_insert() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select i.version into new.version from public.ez_items i where i.id = new.item_id;
  if new.version is null then
    raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 보고서가 없습니다';
  end if;
  if (select count(*) from public.ez_notes n where n.item_id = new.item_id) >= 1000 then
    raise exception using errcode = 'P0001', message = '[EZ_LIMIT] 이 보고서에는 더 남길 수 없습니다 (1,000개까지)';
  end if;
  new.created_at := now();
  new.updated_at := now();
  new.deleted_at := null;
  return new;
end;
$$;

create trigger ez_notes_before_insert before insert on public.ez_notes
  for each row execute function public.ez_notes_before_insert();

-- ---------------------------------------------------------------------------
-- 방문: 0013 의 open · ping 을 고친다 (create or replace — 권한은 그대로)
-- ---------------------------------------------------------------------------

-- 그 기기의 현재 방문(30분 안에 살아 있는 마지막 방문)에 초를 더한다. 없으면 새 방문 (들어왔을 때 버전 = 보고서의 지금 버전).
-- 기기당 200줄: 이미 200줄이면 새 방문을 만들지 않는다 (그 초는 방문에 안 더해진다. ez_views.seconds 에는 더해진다)
create function public.ez_visit_touch(p_view uuid, p_item uuid, p_seen_sec int) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sec int := least(greatest(coalesce(p_seen_sec, 0), 0), 60);
begin
  update public.ez_visits x
     set last_at = now(), seconds = x.seconds + v_sec
   where x.id = (
     select y.id from public.ez_visits y
      where y.view_id = p_view and y.last_at >= now() - interval '30 minutes'
      order by y.last_at desc, y.id
      limit 1
   );
  if not found then
    if (select count(*) from public.ez_visits y where y.view_id = p_view) >= 200 then
      return;
    end if;
    insert into public.ez_visits (view_id, version, seconds)
    select p_view, i.version, v_sec from public.ez_items i where i.id = p_item;
  end if;
end;
$$;

-- 들어옴 (0013 과 같다 — 500줄이 차면 새 기기는 빈 결과) + 현재 방문에 닿는다
create or replace function public.ez_view_open(p_token text, p_device text, p_ua text default null)
returns table (guest_no int, name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item uuid := public.ez_view_target(p_token);
  v_ua   text := nullif(left(public.ez_trim(coalesce(p_ua, '')), 80), '');
  v_no   int;
  v_view uuid;
begin
  if p_device is null or p_device !~ '^[A-Za-z0-9_-]{22}$' then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 기기 열쇠 모양이 맞지 않습니다';
  end if;
  if v_item is null then
    return;
  end if;

  update public.ez_views v
     set ua = v_ua, last_at = now(), hits = v.hits + 1
   where v.item_id = v_item and v.device = p_device
   returning v.id into v_view;
  if v_view is null then
    if (select count(*) from public.ez_views x where x.item_id = v_item) >= 500 then
      return;
    end if;
    insert into public.ez_view_seq (item_id, last) values (v_item, 1)
    on conflict (item_id) do update set last = public.ez_view_seq.last + 1
    returning last into v_no;
    insert into public.ez_views (item_id, device, guest_no, ua) values (v_item, p_device, v_no, v_ua)
    returning id into v_view;
  end if;

  perform public.ez_visit_touch(v_view, v_item, 0);

  return query select v.guest_no, v.name from public.ez_views v where v.item_id = v_item and v.device = p_device;
end;
$$;

-- 살아 있음 (0013 과 같다) + 현재 방문에도 같은 초를 더한다
create or replace function public.ez_view_ping(p_token text, p_device text, p_seen_sec int default 0) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item uuid := public.ez_view_target(p_token);
  v_view uuid;
begin
  if v_item is null or p_device is null or p_device !~ '^[A-Za-z0-9_-]{22}$' then
    return;
  end if;
  update public.ez_views v
     set last_at = now(), seconds = v.seconds + least(greatest(coalesce(p_seen_sec, 0), 0), 60)
   where v.item_id = v_item and v.device = p_device
   returning v.id into v_view;
  if v_view is not null then
    perform public.ez_visit_touch(v_view, v_item, p_seen_sec);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 공유 페이지 읽기: ez_shared(0004)와 같고 version 을 더한 새 함수 ez_shared_doc — 글마다 붙은 버전과 지금 버전이
-- 다른지 공개 페이지도 알아야 한다. 돌려주는 모양이 달라 ez_shared 를 바꾸지 않고 새 이름으로 만든다. 옛 ez_shared 는 그대로 둔다
-- ---------------------------------------------------------------------------

create function public.ez_shared_doc(p_token text)
returns table (name text, report_kind text, blocks jsonb, schema_version int, version int, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select i.name,
         i.report_kind,
         (select coalesce(jsonb_agg(
                   case when jsonb_typeof(e.b) = 'object' and e.b ->> 'type' = 'image' then e.b - 'local_path' else e.b end
                   order by e.n), '[]'::jsonb)
            from jsonb_array_elements(i.blocks) with ordinality as e(b, n)),
         i.schema_version,
         i.version,
         i.updated_at
    from public.ez_items i
   where p_token is not null
     and p_token ~ '^[A-Za-z0-9_-]{22}$'
     and i.share_token = p_token
     and i.kind = 'report'
     and i.deleted_at is null
$$;
revoke all on function public.ez_shared_doc(text) from public, anon, authenticated;
grant execute on function public.ez_shared_doc(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 남(anon)이 부르는 함수
-- ---------------------------------------------------------------------------

-- 그 보고서의 글 전부 (지운 것 빼고, 오래된 것부터). 라벨 = 이름 또는 "게스트 n", 주인 글은 null. guest_no 로 자기 것을 안다
create function public.ez_notes_list(p_token text)
returns table (id uuid, guest_no int, label text, by_owner boolean, body text, version int, block int, anchor text, created_at timestamptz, updated_at timestamptz)
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select n.id, v.guest_no, coalesce(v.name, '게스트 ' || v.guest_no), n.by_owner, n.body, n.version, n.block, n.anchor, n.created_at, n.updated_at
    from public.ez_notes n
    left join public.ez_views v on v.id = n.view_id
   where n.item_id = public.ez_view_target(p_token)
     and n.deleted_at is null
   order by n.created_at, n.id
$$;

-- 쓰기. 그 기기의 ez_views 줄이 있어야 한다 (없으면 빈 결과 — 먼저 ez_view_open). 글은 1~1,000자, 10초에 하나. 쓴 줄을 돌려준다
create function public.ez_note_write(p_token text, p_device text, p_body text, p_block int default null, p_anchor text default null)
returns table (id uuid, guest_no int, label text, by_owner boolean, body text, version int, block int, anchor text, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item   uuid := public.ez_view_target(p_token);
  v_body   text := public.ez_trim(coalesce(p_body, ''));
  v_anchor text := nullif(left(public.ez_trim(coalesce(p_anchor, '')), 200), '');
  v_view   uuid;
  v_id     uuid;
begin
  if v_body = '' or char_length(v_body) > 1000 or v_body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 글은 1~1,000자로 씁니다';
  end if;
  if p_block is not null and p_block < 0 then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 블록 번호가 맞지 않습니다';
  end if;
  if v_item is null or p_device is null or p_device !~ '^[A-Za-z0-9_-]{22}$' then
    return;
  end if;
  select v.id into v_view from public.ez_views v where v.item_id = v_item and v.device = p_device;
  if v_view is null then
    return;
  end if;
  if exists (select 1 from public.ez_notes n where n.view_id = v_view and n.created_at > now() - interval '10 seconds') then
    raise exception using errcode = 'P0001', message = '[EZ_RATE] 10초에 하나만 남길 수 있습니다';
  end if;

  insert into public.ez_notes (item_id, view_id, body, block, anchor)
  values (v_item, v_view, v_body, p_block, case when p_block is null then null else v_anchor end)
  returning public.ez_notes.id into v_id;

  return query
    select n.id, v.guest_no, coalesce(v.name, '게스트 ' || v.guest_no), n.by_owner, n.body, n.version, n.block, n.anchor, n.created_at, n.updated_at
      from public.ez_notes n join public.ez_views v on v.id = n.view_id
     where n.id = v_id;
end;
$$;

-- 고치기 (p_body) · 지우기 (p_body 없음). 같은 기기가 쓴 지우지 않은 글만. 아니면 아무것도 안 한다
create function public.ez_note_edit(p_token text, p_device text, p_id uuid, p_body text default null) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item uuid := public.ez_view_target(p_token);
  v_body text := nullif(public.ez_trim(coalesce(p_body, '')), '');
begin
  if v_body is not null and (char_length(v_body) > 1000 or v_body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 글은 1~1,000자로 씁니다';
  end if;
  if v_item is null or p_id is null or p_device is null or p_device !~ '^[A-Za-z0-9_-]{22}$' then
    return;
  end if;
  update public.ez_notes n
     set body = coalesce(v_body, n.body),
         updated_at = case when v_body is not null and v_body is distinct from n.body then now() else n.updated_at end,
         deleted_at = case when v_body is null then now() else n.deleted_at end
   where n.id = p_id
     and n.item_id = v_item
     and n.deleted_at is null
     and n.view_id = (select v.id from public.ez_views v where v.item_id = v_item and v.device = p_device);
end;
$$;

-- ---------------------------------------------------------------------------
-- 권한: 기본(public) 회수 후 필요한 역할에만. anon 에게 여는 것은 list · write · edit 셋 (+ 위의 ez_shared_doc. open · ping · name 은 0013 그대로).
-- 도우미 ez_visit_touch · 트리거 함수는 아무에게도 안 연다. 기록 · 글은 MCP(service_role)가 읽을 수 있게 둔다
-- ---------------------------------------------------------------------------

revoke all on function public.ez_notes_before_insert() from public, anon, authenticated;
revoke all on function public.ez_visit_touch(uuid, uuid, int) from public, anon, authenticated;
revoke all on function public.ez_notes_list(text) from public, anon, authenticated;
revoke all on function public.ez_note_write(text, text, text, int, text) from public, anon, authenticated;
revoke all on function public.ez_note_edit(text, text, uuid, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.ez_notes_before_insert() from service_role;
    revoke all on function public.ez_visit_touch(uuid, uuid, int) from service_role;
    grant select on table public.ez_visits to service_role;
    grant select on table public.ez_notes to service_role;
  end if;
end;
$$;

grant execute on function public.ez_notes_list(text) to anon, authenticated;
grant execute on function public.ez_note_write(text, text, text, int, text) to anon, authenticated;
grant execute on function public.ez_note_edit(text, text, uuid, text) to anon, authenticated;
