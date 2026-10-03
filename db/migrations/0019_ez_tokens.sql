-- 에이전트 연결 — 개인 토큰 (docs/에이전트-연결.md 1장). 0018 위에 더한다.
--
-- 테이블: ez_tokens — 토큰 하나에 한 줄. 원문은 저장하지 않는다 (sha256 hex 만). 폐기는 revoked_at 을 적는다 (줄은 남긴다)
-- 함수:   ez_token_new(이름, 범위)  로그인한 사람(관리자 · 켜진 회원)이 부른다. 무작위를 DB 가 만들고 원문을 한 번 돌려준다
--         ez_token_check(원문)      서버 라우트(/api/mcp, service_role)만 부른다. {id, owner, scope} 또는 null
-- 도우미: ez_token_owner_ok · ez_token_random — 아무에게도 안 연다
--
-- 주인은 자기 줄을 읽고(해시 칸 빼고) revoked_at 만 적는다. 관리자는 모든 줄을 읽고 폐기한다 (회원이 PC 를 잃어버렸을 때).
-- 줄을 넣는 길은 ez_token_new 뿐이다. 줄을 없애는 길은 없다.
-- 이 파일에는 줄 · 객체를 없애는 문장을 쓰지 않는다 (원격 적용 도구가 거절한다).

-- ---------------------------------------------------------------------------
-- 테이블
-- ---------------------------------------------------------------------------

create table public.ez_tokens (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid(),
  -- 어디서 쓰는지 ("집 노트북")
  name         text not null,
  -- 토큰 원문의 sha256 (hex 64자)
  hash         text not null,
  -- 원문 끝 4자 (목록에서 알아보게)
  tail         text not null,
  -- rw 읽고 쓰기 · ro 읽기만
  scope        text not null default 'rw',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),

  constraint ez_tokens_name_check check (
    name = public.ez_trim(name) and char_length(name) between 1 and 30 and name !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
  ),
  constraint ez_tokens_hash_check check (hash ~ '^[0-9a-f]{64}$'),
  constraint ez_tokens_tail_check check (tail ~ '^[0-9A-Za-z]{4}$'),
  constraint ez_tokens_scope_check check (scope in ('rw', 'ro'))
);

create unique index ez_tokens_hash_unique on public.ez_tokens (hash);
create index ez_tokens_owner_idx on public.ez_tokens (owner) where revoked_at is null;

-- 고칠 수 있는 것은 revoked_at(비어 있을 때 한 번 — 시각은 DB 가 적는다)과 last_used_at 뿐
create function public.ez_tokens_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.owner, new.name, new.hash, new.tail, new.scope, new.created_at)
     is distinct from (old.id, old.owner, old.name, old.hash, old.tail, old.scope, old.created_at) then
    raise exception using errcode = 'P0001', message = '[EZ_FIXED] 토큰은 폐기만 할 수 있습니다';
  end if;
  if old.revoked_at is not null then
    if new.revoked_at is distinct from old.revoked_at then
      raise exception using errcode = 'P0001', message = '[EZ_FIXED] 폐기한 토큰은 되살릴 수 없습니다';
    end if;
  elsif new.revoked_at is not null then
    new.revoked_at := now();
  end if;
  return new;
end;
$$;

create trigger ez_tokens_guard before update on public.ez_tokens
  for each row execute function public.ez_tokens_guard();

-- ---------------------------------------------------------------------------
-- 도우미
-- ---------------------------------------------------------------------------

-- 토큰을 가질 수 있는 계정: 관리자 또는 켜진 회원 (docs/회원.md 1장)
create function public.ez_token_owner_ok(p_uid uuid) returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select p_uid is not null and (
    exists (select 1 from public.ez_admins a where a.user_id = p_uid)
    or exists (select 1 from public.ez_members m where m.user_id = p_uid and m.active)
  )
$$;

-- 무작위 base62 글자 p_len 개. gen_random_uuid 의 무작위 바이트만 쓴다 (버전 · 변형 비트가 박힌 6 · 8번째 바이트는 뺀다).
-- 248(= 62 × 4) 이상인 바이트는 버려 글자마다 확률이 같다
create function public.ez_token_random(p_len int) returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  c_abc constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  v_out text := '';
  v_raw bytea;
  v_b   int;
begin
  while char_length(v_out) < p_len loop
    v_raw := uuid_send(gen_random_uuid());
    for i in 0..15 loop
      continue when i in (6, 8);
      v_b := get_byte(v_raw, i);
      continue when v_b >= 248;
      v_out := v_out || substr(c_abc, v_b % 62 + 1, 1);
      exit when char_length(v_out) >= p_len;
    end loop;
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 만들기 — {id, token, name, tail, scope, created_at}. token(원문)은 여기서만 나온다
--   이름은 앞뒤 공백을 지운 뒤 1~30자. 범위는 rw(기본) · ro. 살아 있는 토큰은 사람당 10개까지
-- ---------------------------------------------------------------------------

create function public.ez_token_new(p_name text, p_scope text default 'rw') returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := public.ez_trim(coalesce(p_name, ''));
  v_scope text := coalesce(p_scope, 'rw');
  v_token text;
  v_row   public.ez_tokens;
begin
  if not public.ez_token_owner_ok(v_uid) then
    raise exception using errcode = 'P0001', message = '[EZ_FORBIDDEN] 이 계정은 토큰을 만들 수 없습니다';
  end if;
  if char_length(v_name) not between 1 and 30 or v_name ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]' then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 이름은 1~30자입니다';
  end if;
  if v_scope not in ('rw', 'ro') then
    raise exception using errcode = 'P0001', message = '[EZ_VALUE] 범위는 rw(읽고 쓰기) · ro(읽기만) 중 하나입니다';
  end if;

  -- 같은 사람의 만들기는 줄 세운다 (동시에 눌러 10개를 넘기지 않게)
  perform pg_advisory_xact_lock(hashtextextended('ez_tokens:' || v_uid::text, 0));
  if (select count(*) from public.ez_tokens t where t.owner = v_uid and t.revoked_at is null) >= 10 then
    raise exception using errcode = 'P0001', message = '[EZ_LIMIT] 토큰은 10개까지입니다. 안 쓰는 것을 폐기한 뒤 만드세요';
  end if;

  v_token := 'ezt_' || public.ez_token_random(40);
  insert into public.ez_tokens (owner, name, hash, tail, scope)
  values (v_uid, v_name, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), right(v_token, 4), v_scope)
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id, 'token', v_token, 'name', v_row.name, 'tail', v_row.tail, 'scope', v_row.scope, 'created_at', v_row.created_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 확인 — 서버 라우트만. 통과하면 {id, owner, scope}, 아니면 null
--   null: 모양이 다름 · 없는 토큰 · 폐기됨 · 주인이 꺼진 회원 · 주인이 관리자도 회원도 아님
--   통과하면 last_used_at 을 적는다 — 1분에 한 번만 (요청마다 쓰지 않게)
-- ---------------------------------------------------------------------------

create function public.ez_token_check(p_token text) returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v public.ez_tokens;
begin
  if p_token is null or p_token !~ '^ezt_[0-9A-Za-z]{40}$' then
    return null;
  end if;
  select * into v from public.ez_tokens t
   where t.hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null;
  if not found or not public.ez_token_owner_ok(v.owner) then
    return null;
  end if;
  update public.ez_tokens t set last_used_at = now()
   where t.id = v.id and (t.last_used_at is null or t.last_used_at < now() - interval '1 minute');
  return jsonb_build_object('id', v.id, 'owner', v.owner, 'scope', v.scope);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: 자기 줄 또는 관리자. 넣기 정책은 없다 (ez_token_new 로만)
-- ---------------------------------------------------------------------------

alter table public.ez_tokens enable row level security;

create policy ez_tokens_select on public.ez_tokens for select to authenticated
  using (owner = (select auth.uid()) or (select public.ez_is_admin()));
create policy ez_tokens_update on public.ez_tokens for update to authenticated
  using (owner = (select auth.uid()) or (select public.ez_is_admin()))
  with check (owner = (select auth.uid()) or (select public.ez_is_admin()));

-- ---------------------------------------------------------------------------
-- 권한: 기본(public) 회수 후 필요한 역할에만. anon 은 아무것도 없다.
-- authenticated: 해시 칸은 읽지 못하고, revoked_at 만 적는다.
-- service_role: 테이블은 직접 만지지 않는다 — ez_token_check 하나만 부른다
-- ---------------------------------------------------------------------------

revoke all on table public.ez_tokens from public, anon, authenticated;
grant select (id, owner, name, tail, scope, last_used_at, revoked_at, created_at) on table public.ez_tokens to authenticated;
grant update (revoked_at) on table public.ez_tokens to authenticated;

revoke all on function public.ez_tokens_guard() from public, anon, authenticated;
revoke all on function public.ez_token_owner_ok(uuid) from public, anon, authenticated;
revoke all on function public.ez_token_random(int) from public, anon, authenticated;
revoke all on function public.ez_token_new(text, text) from public, anon, authenticated;
revoke all on function public.ez_token_check(text) from public, anon, authenticated;

-- Supabase 는 public 스키마의 새 테이블 · 함수를 service_role 에도 기본으로 연다 — 여기서 닫는다
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.ez_tokens from service_role;
    revoke all on function public.ez_tokens_guard() from service_role;
    revoke all on function public.ez_token_owner_ok(uuid) from service_role;
    revoke all on function public.ez_token_random(int) from service_role;
    revoke all on function public.ez_token_new(text, text) from service_role;
    revoke all on function public.ez_token_check(text) from service_role;
  end if;
end;
$$;

grant execute on function public.ez_token_new(text, text) to authenticated;
grant execute on function public.ez_token_check(text) to service_role;
