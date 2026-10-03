-- 회원 · 추가 모듈 (docs/회원.md 2장). 0014 위에 더한다.
--
-- 테이블: ez_admins (관리자 — 아무도 직접 못 읽는다) · ez_members (회원 — Auth 사용자와 한 줄씩) · ez_modules (추가 모듈)
-- 함수:   ez_is_admin · ez_me (역할 · 이름 · 켬 · 허용 · 켠 것 · 보이는 모듈을 한 번에) · ez_set_picked (켠 추가 모듈 저장)
--
-- 회원 줄을 넣고 지우는 것은 서버 라우트(service_role)만 — Auth 사용자와 같이 만들고 지워야 해서.
-- 회원 본인은 자기 줄을 읽고 picked 만 고친다. 관리자는 모든 줄을 읽고 name · active · allowed 를 고친다.
-- 열 권한은 역할(authenticated) 단위라 누가 어느 열을 고치는지는 ez_members_guard 가 가른다.
-- 관리자도 추가 모듈을 켠다 — 관리자는 회원 줄이 없으므로 켠 것은 ez_admins.picked 에 둔다.

-- ---------------------------------------------------------------------------
-- 추가 모듈 키 목록: 1차원 · 50개까지 · 키 모양(영문 소문자 · 숫자 · -, 2~30자) · 겹침 없음
-- ---------------------------------------------------------------------------

create function public.ez_module_keys_ok(p text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p is not null
     and coalesce(array_ndims(p), 1) = 1
     and cardinality(p) <= 50
     and not exists (select 1 from unnest(p) k where k is null or k !~ '^[a-z0-9-]{2,30}$')
     and (select count(distinct k) from unnest(p) k) = cardinality(p)
$$;

-- ---------------------------------------------------------------------------
-- ez_admins 관리자 (EZ_OWNER_ID 한 줄)
-- ---------------------------------------------------------------------------

create table public.ez_admins (
  user_id uuid primary key,
  -- 관리자가 켠 추가 모듈 (회원의 ez_members.picked 와 같은 뜻)
  picked  text[] not null default '{}',
  constraint ez_admins_picked_check check (public.ez_module_keys_ok(picked))
);

insert into public.ez_admins (user_id) values ('00263c79-cc44-4b7a-a846-ab9d43f4e718');

create function public.ez_is_admin() returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.ez_admins a where a.user_id = (select auth.uid()))
$$;

-- ---------------------------------------------------------------------------
-- ez_members 회원
-- ---------------------------------------------------------------------------

create table public.ez_members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  login_id   text not null,
  name       text not null,
  active     boolean not null default true,
  -- 관리자가 열어 준 추가 모듈 키
  allowed    text[] not null default '{}',
  -- 회원이 켠 것 (allowed 밖의 키는 화면이 무시한다)
  picked     text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ez_members_login_id_check check (login_id ~ '^[a-z0-9._-]{3,20}$'),
  constraint ez_members_name_check check (name = public.ez_trim(name) and char_length(name) between 1 and 20),
  constraint ez_members_allowed_check check (public.ez_module_keys_ok(allowed)),
  constraint ez_members_picked_check check (public.ez_module_keys_ok(picked))
);

create unique index ez_members_login_id_unique on public.ez_members (lower(login_id));

-- 누가 어느 칸을 고치는지. service_role(서버 라우트 — auth.uid() 없음)과 다른 트리거가 고치는 것(모듈 지우기)은 그대로 둔다.
-- 관리자: 이름 · 켬 · 허용 (남의 켠 것은 못 고친다). 회원 본인: 켠 것만
create function public.ez_members_guard() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if public.ez_is_admin() then
    if new.picked is distinct from old.picked and old.user_id <> v_uid then
      raise exception using errcode = 'P0001', message = '[EZ_FORBIDDEN] 켠 모듈은 회원 본인만 바꿀 수 있습니다';
    end if;
  elsif (new.name, new.active, new.allowed) is distinct from (old.name, old.active, old.allowed) then
    raise exception using errcode = 'P0001', message = '[EZ_FORBIDDEN] 이름 · 켬 · 허용 모듈은 관리자만 바꿀 수 있습니다';
  end if;
  return new;
end;
$$;

create trigger ez_members_guard before update on public.ez_members
  for each row execute function public.ez_members_guard();
create trigger ez_members_touch before update on public.ez_members
  for each row execute function public.ez_touch();

-- ---------------------------------------------------------------------------
-- ez_modules 추가 모듈 (관리자가 등록). 지금은 link 만 쓰인다 — builtin 은 앱 안 경로용 구멍
-- ---------------------------------------------------------------------------

create table public.ez_modules (
  key        text primary key,
  name       text not null,
  kind       text not null default 'link',
  href       text not null,
  sort       int not null default 0,
  created_at timestamptz not null default now(),

  constraint ez_modules_key_check check (key ~ '^[a-z0-9-]{2,30}$'),
  constraint ez_modules_name_check check (name = public.ez_trim(name) and char_length(name) between 1 and 20),
  constraint ez_modules_kind_check check (kind in ('builtin', 'link')),
  -- builtin 은 / 로 시작하는 앱 안 경로(// 는 바깥이라 안 된다), link 는 https 주소만. 공백 · 500자 넘음 안 됨
  constraint ez_modules_href_check check (
    char_length(href) <= 500
    and href !~ '\s'
    and case kind
          when 'builtin' then href ~ '^/([^/\\].*)?$'
          else href ~ '^https://[^/?#@]+([/?#].*)?$'
        end
  )
);

-- 모듈을 지우면 회원 · 관리자의 허용 · 켠 것에서도 그 키를 뺀다
create function public.ez_modules_after() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.ez_members m
     set allowed = array_remove(m.allowed, old.key), picked = array_remove(m.picked, old.key)
   where old.key = any (m.allowed) or old.key = any (m.picked);
  update public.ez_admins a set picked = array_remove(a.picked, old.key) where old.key = any (a.picked);
  return null;
end;
$$;

create trigger ez_modules_after after delete on public.ez_modules
  for each row execute function public.ez_modules_after();

-- ---------------------------------------------------------------------------
-- ez_me — 로그인 뒤 한 번. {role, name, active, allowed, picked, modules}
--   admin:  allowed = 모든 모듈 키, modules = 모든 모듈
--   member: allowed · picked 는 자기 줄 그대로, modules = 허용된 모듈 (꺼진 회원은 빈 목록)
--   none:   관리자도 회원도 아님 (옛 계정 등)
-- modules 는 sort · key 순 [{key, name, kind, href, sort}]
-- ---------------------------------------------------------------------------

create function public.ez_me() returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_picked text[];
  v_m      public.ez_members;
  v_mods   jsonb;
begin
  if v_uid is not null then
    select a.picked into v_picked from public.ez_admins a where a.user_id = v_uid;
    if found then
      select coalesce(jsonb_agg(jsonb_build_object('key', d.key, 'name', d.name, 'kind', d.kind, 'href', d.href, 'sort', d.sort) order by d.sort, d.key), '[]'::jsonb)
        into v_mods from public.ez_modules d;
      return jsonb_build_object(
        'role', 'admin', 'name', null, 'active', true,
        'allowed', coalesce((select jsonb_agg(d.key order by d.sort, d.key) from public.ez_modules d), '[]'::jsonb),
        'picked', to_jsonb(v_picked),
        'modules', v_mods
      );
    end if;
    select * into v_m from public.ez_members m where m.user_id = v_uid;
    if found then
      select coalesce(jsonb_agg(jsonb_build_object('key', d.key, 'name', d.name, 'kind', d.kind, 'href', d.href, 'sort', d.sort) order by d.sort, d.key), '[]'::jsonb)
        into v_mods from public.ez_modules d where v_m.active and d.key = any (v_m.allowed);
      return jsonb_build_object(
        'role', 'member', 'name', v_m.name, 'active', v_m.active,
        'allowed', to_jsonb(v_m.allowed), 'picked', to_jsonb(v_m.picked), 'modules', v_mods
      );
    end if;
  end if;
  return jsonb_build_object('role', 'none', 'name', null, 'active', false, 'allowed', '[]'::jsonb, 'picked', '[]'::jsonb, 'modules', '[]'::jsonb);
end;
$$;

-- 켠 추가 모듈 저장 (선택창의 켜기 · 끄기). 회원은 자기 줄, 관리자는 ez_admins 의 자기 줄. 저장된 값을 돌려준다
create function public.ez_set_picked(p_picked text[]) returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_out text[];
begin
  if not public.ez_module_keys_ok(p_picked) then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 모듈 키가 맞지 않습니다';
  end if;
  update public.ez_members m set picked = p_picked where m.user_id = v_uid returning m.picked into v_out;
  if found then
    return v_out;
  end if;
  update public.ez_admins a set picked = p_picked where a.user_id = v_uid returning a.picked into v_out;
  if found then
    return v_out;
  end if;
  raise exception using errcode = 'P0001', message = '[EZ_NOT_FOUND] 이 계정은 쓸 수 없습니다';
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
--   ez_admins:  정책 없음 — authenticated 는 권한도 없다 (함수로만)
--   ez_members: 자기 줄 또는 관리자
--   ez_modules: 읽기는 로그인한 누구나, 쓰기는 관리자
-- ---------------------------------------------------------------------------

alter table public.ez_admins enable row level security;
alter table public.ez_members enable row level security;
alter table public.ez_modules enable row level security;

create policy ez_members_select on public.ez_members for select to authenticated
  using (user_id = (select auth.uid()) or (select public.ez_is_admin()));
create policy ez_members_update on public.ez_members for update to authenticated
  using (user_id = (select auth.uid()) or (select public.ez_is_admin()))
  with check (user_id = (select auth.uid()) or (select public.ez_is_admin()));

create policy ez_modules_select on public.ez_modules for select to authenticated using (true);
create policy ez_modules_insert on public.ez_modules for insert to authenticated with check ((select public.ez_is_admin()));
create policy ez_modules_update on public.ez_modules for update to authenticated
  using ((select public.ez_is_admin())) with check ((select public.ez_is_admin()));
create policy ez_modules_delete on public.ez_modules for delete to authenticated using ((select public.ez_is_admin()));

-- ---------------------------------------------------------------------------
-- 권한: 기본(public) 회수 후 필요한 역할에만. anon 은 아무것도 없다.
-- 회원 줄 insert · delete 는 service_role 만. 모듈 키 · 회원 아이디는 못 바꾼다
-- ---------------------------------------------------------------------------

revoke all on table public.ez_admins from public, anon, authenticated;
revoke all on table public.ez_members from public, anon, authenticated;
revoke all on table public.ez_modules from public, anon, authenticated;

grant select on table public.ez_members to authenticated;
grant update (name, active, allowed, picked) on table public.ez_members to authenticated;

grant select, insert, delete on table public.ez_modules to authenticated;
grant update (name, kind, href, sort) on table public.ez_modules to authenticated;

grant select, insert, update, delete on table public.ez_admins to service_role;
grant select, insert, update, delete on table public.ez_members to service_role;
grant select, insert, update, delete on table public.ez_modules to service_role;

revoke all on function public.ez_module_keys_ok(text[]) from public, anon, authenticated;
revoke all on function public.ez_is_admin() from public, anon, authenticated;
revoke all on function public.ez_members_guard() from public, anon, authenticated;
revoke all on function public.ez_modules_after() from public, anon, authenticated;
revoke all on function public.ez_me() from public, anon, authenticated;
revoke all on function public.ez_set_picked(text[]) from public, anon, authenticated;

-- CHECK · 정책 안에서 부르는 도우미는 테이블을 쓰는 역할이 실행할 수 있어야 한다
grant execute on function public.ez_module_keys_ok(text[]) to authenticated, service_role;
grant execute on function public.ez_is_admin() to authenticated, service_role;
grant execute on function public.ez_me() to authenticated;
grant execute on function public.ez_set_picked(text[]) to authenticated;
