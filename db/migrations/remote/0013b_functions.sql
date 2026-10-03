-- 원격 적용용 — 0013_ez_views.sql 의 뒷부분 (2/2): anon 함수 셋 + 그 권한.
-- 앞부분(테이블 · RLS · ez_view_target · 그 권한 · service_role 의 ez_views select)은 원격에 ez_views_0013a_tables 로 이미 들어가 있다.
-- 본문은 0013_ez_views.sql 과 같다. 이 다음에 0014_remote.sql 을 넣는다 (open · ping 을 다시 고친다).

-- ---------------------------------------------------------------------------
-- 남(anon)이 부르는 함수
-- ---------------------------------------------------------------------------

-- 들어옴. 줄이 없으면 만들고(게스트 번호 매김 · hits = 1), 있으면 ua · last_at 갱신 + hits + 1. 돌려주는 것: guest_no · name (한 줄).
-- 기기 열쇠가 규칙 밖이면 [EZ_VALUE]. ua 는 80자로 잘라 넣는다(비면 null). 보고서를 못 찾으면(주인 본인 포함) 빈 결과.
-- 그 보고서의 줄이 이미 500개면 새 기기는 줄을 만들지 않고(번호도 안 매김) 빈 결과
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
    -- 보고서당 500줄: 다 찼으면 새 기기는 적지 않는다
    if (select count(*) from public.ez_views x where x.item_id = v_item) >= 500 then
      return;
    end if;
    -- 번호는 한 줄 upsert 로 매긴다 — 동시에 처음 오는 두 기기도 줄 잠금으로 다른 번호를 받는다
    insert into public.ez_view_seq (item_id, last) values (v_item, 1)
    on conflict (item_id) do update set last = public.ez_view_seq.last + 1
    returning last into v_no;
    insert into public.ez_views (item_id, device, guest_no, ua) values (v_item, p_device, v_no, v_ua);
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
-- 권한: 기본(public) 회수 후 anon · authenticated 에만
-- ---------------------------------------------------------------------------

revoke all on function public.ez_view_open(text, text, text) from public, anon, authenticated;
revoke all on function public.ez_view_ping(text, text, int) from public, anon, authenticated;
revoke all on function public.ez_view_name(text, text, text) from public, anon, authenticated;

grant execute on function public.ez_view_open(text, text, text) to anon, authenticated;
grant execute on function public.ez_view_ping(text, text, int) to anon, authenticated;
grant execute on function public.ez_view_name(text, text, text) to anon, authenticated;
