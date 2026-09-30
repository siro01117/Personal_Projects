// PGlite 시험용 Supabase 흉내 — auth.uid() · 역할 · storage 스키마(버킷·objects·foldername 만).
// 진짜 Storage 서버(파일 내용·용량·형식 검사)는 흉내 내지 않는다. 여기서는 정책(RLS)만 시험한다.

import { readdirSync, readFileSync } from "node:fs";

export const SUPABASE_STUB = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[],
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id), name text, owner uuid,
    created_at timestamptz default now(), updated_at timestamptz default now(), metadata jsonb,
    unique (bucket_id, name)
  );
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
  grant select on storage.buckets to anon, authenticated, service_role;
`;

const CRON = /-- pg_cron:시작[\s\S]*?-- pg_cron:끝[^\n]*/g;

/** PGlite 에 없는 pg_cron 부분(-- pg_cron:시작 ~ -- pg_cron:끝)을 뺀다 */
export function forPglite(sql: string): string {
  return sql.replace(CRON, "");
}

const DIR = new URL("./migrations/", import.meta.url);

/** db/migrations 의 .sql 을 파일 이름 순서대로 (pg_cron 부분은 뺀 것) */
export function migrations(until?: string): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && (until === undefined || f <= until))
    .sort()
    .map((f) => forPglite(readFileSync(new URL(f, DIR), "utf8")));
}
