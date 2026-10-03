-- 읽은 사람 — 기록 층 (docs/보고서-서랍.md 7-4장). 0012 위에 더한다. 라이브(지금 어디를 보나)는 Realtime presence 라 DB 를 거치지 않는다.
--
-- 테이블:            ez_views — 보고서 × 기기마다 한 줄 (게스트 번호 · 이름 · 처음 · 마지막 · 횟수 · 읽은 초 · 기기 힌트)
--                    ez_view_seq — 보고서마다 마지막 게스트 번호 (안에서만 쓴다, 아무에게도 안 연다)
-- 남(anon)이 부르는 함수: ez_view_open (들어옴 → 게스트 번호 · 이름) · ez_view_ping (살아 있음 + 읽은 초) · ez_view_name (이름 적기 · 바꾸기)
-- 도우미:            ez_view_target (열쇠 → 공유가 켜진 살아 있는 보고서. 주인 본인이면 null) — 아무에게도 안 연다
--
-- 주인은 RLS 아래 자기 보고서의 줄만 select 한다. insert · update · delete 는 함수로만 (테이블에는 권한이 없다).
-- 열쇠 → 보고서 찾기는 ez_shared 와 같다 (22자 모양 · share_token · kind = report · deleted_at is null).
-- 없는 열쇠 · 꺼진 링크 · 지운 보고서 · 주인 본인(auth.uid() = owner)은 아무것도 안 하고 빈 결과 — 있었는지 드러내지 않는다.
-- 게스트 번호는 보고서마다 1부터, 그 보고서에 처음 온 기기 순서. 번호는 ez_view_seq 가 센다 — 줄이 지워져도 번호를 다시 쓰지 않는다.
-- 보고서당 500줄까지. 넘으면 가장 오래된 last_at 줄을 지운다. ez_items 가 cascade 라 영구 삭제하면 같이 지워진다.
-- security definer 함수는 search_path 를 고정한다 (public, pg_temp).

-- ---------------------------------------------------------------------------
-- 테이블
-- ---------------------------------------------------------------------------

create table public.ez_views (
  id        uuid primary key default gen_random_uuid(),
  item_id   uuid not null references public.ez_items (id) on delete cascade,
  device    text not null,
  guest_no  int not null,
  name      text,
  first_at  timestamptz not null default now(),
  last_at   timestamptz not null default now(),
  hits      int not null default 1,
  seconds   int not null default 0,
  ua        text,

  -- 기기 열쇠: 공개 페이지가 만든 22자 (base64url 모양)
  constraint ez_views_device_check check (device ~ '^[A-Za-z0-9_-]{22}$'),
  constraint ez_views_guest_no_check check (guest_no >= 1),
  -- 이름: 없거나(게스트 n) 앞뒤 공백 없는 1~20자 · 줄바꿈 · 제어문자 금지
  constraint ez_views_name_check check (
    name is null
    or (name = public.ez_trim(name) and char_length(name) between 1 and 20 and name !~ '[\x01-\x1f\x7f-\x9f  ]')
  ),
  constraint ez_views_hits_check check (hits >= 1),
  constraint ez_views_seconds_check check (seconds >= 0),
  constraint ez_views_ua_check check (ua is null or char_length(ua) between 1 and 80),
  constraint ez_views_at_check check (last_at >= first_at),
  constraint ez_views_item_device_unique unique (item_id, device),
  constraint ez_views_item_guest_unique unique (item_id, guest_no)
);

create index ez_views_item_last_idx on public.ez_views (item_id, last_at desc);

-- 보고서마다 마지막으로 매긴 게스트 번호. 함수 안에서만 쓴다 (RLS 켜 두고 정책 없음 · 권한 없음)
create table public.ez_view_seq (
  item_id uuid primary key references public.ez_items (id) on delete cascade,
  last    int not null default 0
);
alter table public.ez_view_seq enable row level security;

alter table public.ez_views enable row level security;

-- 주인만 읽는다 (보고서가 휴지통에 있어도 — 복원하면 그대로 보인다)
create policy ez_views_select on public.ez_views for select to authenticated
  using (exists (select 1 from public.ez_items i where i.id = item_id and i.owner = (select auth.uid())));

grant select on table public.ez_views to authenticated;

-- ---------------------------------------------------------------------------
-- 안에서만 쓰는 도우미 (누구에게도 실행 권한을 주지 않는다)
-- ---------------------------------------------------------------------------

-- 열쇠 → 공유가 켜진 살아 있는 보고서의 id. 없거나 꺼진 링크 · 지운 보고서 · 부른 사람이 그 주인이면 null
create function public.ez_view_target(p_token text) returns uuid
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select i.id from public.ez_items i
   where p_token is not null
     and p_token ~ '^[A-Za-z0-9_-]{22}$'
     and i.share_token = p_token
     and i.kind = 'report'
     and i.deleted_at is null
     and i.owner is distinct from auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- 남(anon)이 부르는 함수
-- ---------------------------------------------------------------------------

-- 들어옴. 줄이 없으면 만들고(게스트 번호 매김 · hits = 1), 있으면 ua · last_at 갱신 + hits + 1. 돌려주는 것: guest_no · name (한 줄).
-- 기기 열쇠가 규칙 밖이면 [EZ_VALUE]. ua 는 80자로 잘라 넣는다(비면 null). 보고서를 못 찾으면(주인 본인 포함) 빈 결과
create function public.ez_view_open(p_token text, p_device text, p_ua text default null)
returns table (guest_no int, name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item uuid := public.ez_view_target(p_token);
  v_ua   text := nullif(left(public.ez_trim(coalesce(p_ua, '')), 80), '');
  v_no   int;
begin
  if p_device is null or p_device !~ '^[A-Za-z0-9_-]{22}$' then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 기기 열쇠 모양이 맞지 않습니다';
  end if;
  if v_item is null then
    return;
  end if;

  update public.ez_views v
     set ua = v_ua, last_at = now(), hits = v.hits + 1
   where v.item_id = v_item and v.device = p_device;
  if not found then
    -- 번호는 한 줄 upsert 로 매긴다 — 동시에 처음 오는 두 기기도 줄 잠금으로 다른 번호를 받는다
    insert into public.ez_view_seq (item_id, last) values (v_item, 1)
    on conflict (item_id) do update set last = public.ez_view_seq.last + 1
    returning last into v_no;
    insert into public.ez_views (item_id, device, guest_no, ua) values (v_item, p_device, v_no, v_ua);

    -- 보고서당 500줄: 넘치면 가장 오래 전에 살아 있던 줄부터 지운다 (방금 넣은 줄은 last_at 이 now() 라 안 지워진다)
    delete from public.ez_views v
     where v.id in (
       select x.id from public.ez_views x
        where x.item_id = v_item
        order by x.last_at desc, x.id
        offset 500
     );
  end if;

  return query select v.guest_no, v.name from public.ez_views v where v.item_id = v_item and v.device = p_device;
end;
$$;

-- 살아 있음. 그 기기 줄이 있을 때만 last_at = now(), seconds += 보인 초(0~60 으로 자른다). hits 는 올리지 않는다.
-- 없으면(주인 본인 · 모르는 기기 · 꺼진 링크) 아무것도 안 한다
create function public.ez_view_ping(p_token text, p_device text, p_seen_sec int default 0) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item uuid := public.ez_view_target(p_token);
begin
  if v_item is null or p_device is null or p_device !~ '^[A-Za-z0-9_-]{22}$' then
    return;
  end if;
  update public.ez_views v
     set last_at = now(), seconds = v.seconds + least(greatest(coalesce(p_seen_sec, 0), 0), 60)
   where v.item_id = v_item and v.device = p_device;
end;
$$;

-- 이름 적기 · 바꾸기. 비우면 다시 게스트 n. 1~20자 밖이면 [EZ_VALUE]. 그 기기 줄이 없으면 아무것도 안 한다
create function public.ez_view_name(p_token text, p_device text, p_name text) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item uuid := public.ez_view_target(p_token);
  v_name text := nullif(public.ez_trim(coalesce(p_name, '')), '');
begin
  if v_name is not null and (char_length(v_name) > 20 or v_name ~ '[\x01-\x1f\x7f-\x9f  ]') then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 이름은 20자까지, 한 줄로 씁니다';
  end if;
  if v_item is null or p_device is null or p_device !~ '^[A-Za-z0-9_-]{22}$' then
    return;
  end if;
  update public.ez_views v set name = v_name where v.item_id = v_item and v.device = p_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- 권한: 기본(public) 회수 후 필요한 역할에만. anon 에게 여는 것은 open · ping · name 셋뿐.
-- 도우미 ez_view_target 은 아무에게도 안 연다 — 직접 부를 수 있으면 열쇠로 보고서 id 를 알아낼 수 있다
-- ---------------------------------------------------------------------------

revoke all on function public.ez_view_target(text) from public, anon, authenticated;
revoke all on function public.ez_view_open(text, text, text) from public, anon, authenticated;
revoke all on function public.ez_view_ping(text, text, int) from public, anon, authenticated;
revoke all on function public.ez_view_name(text, text, text) from public, anon, authenticated;

-- Supabase 는 public 스키마의 새 함수를 service_role 에도 기본으로 연다 — 도우미는 거기서도 닫는다. 기록은 MCP 가 읽을 수 있게 둔다
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.ez_view_target(text) from service_role;
    grant select on table public.ez_views to service_role;
  end if;
end;
$$;

grant execute on function public.ez_view_open(text, text, text) to anon, authenticated;
grant execute on function public.ez_view_ping(text, text, int) to anon, authenticated;
grant execute on function public.ez_view_name(text, text, text) to anon, authenticated;
