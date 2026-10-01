-- 10/1 AI 자동 답변 · 관리자 휴대폰 알림 — 서버 전용 키-값 표 nr_review.kv
--   key(영소문자 · 숫자 · _ : . - 120자까지) → value(jsonb 64KB까지). 서버(lib/store.js kvGet · kvSet · kvClaim · kvDel)만 쓴다.
--     ai_cfg                      AI 자동 답변 설정 {away, fallback, min}
--     push_vapid                  휴대폰 알림 서명 키 {publicKey, privateKey, subject} — 비밀(비공개 키). 처음 쓸 때 서버가 만들어 넣음
--     push_subs                   알림 받는 관리자 기기(최대 10대) [{endpoint, keys:{p256dh, auth}, name, at}]
--     ai_done:<질문 id>           같은 질문에 두 번 답하지 않게 먼저 차지하는 표시(nr_kv_claim — 먼저 넣은 쪽만 true)
--     ai_fail:<질문 id>           자동 답변 실패 횟수 · ai_count:<한국 시각 YYYYMMDDHH> 시간당 AI 호출 수 · ai_capnote:<시각> 한도 알림 1번만
--   config 컬렉션은 로그인한 사람이면 모두 읽으므로(화면 /api/docs) 비밀값 · 설정은 여기에 둔다.
--   표는 API 비노출 스키마 nr_review · RLS 켬(정책 없음) · anon · authenticated 권한 없음 — 아래 함수 4개만 통과.
--   함수는 다른 nr_ 함수처럼 security definer · search_path '' · 첫 줄에서 APP_SECRET 검사(nr_review.assert_secret) · anon에만 실행 권한.
-- 적용: Supabase SQL Editor(nigt-data-review)에서 한 번. 여러 번 실행해도 된다(migration_shared.sql 다음). 되돌리기는 맨 아래.

create table if not exists nr_review.kv (
  key         text primary key check (key ~ '^[a-z0-9_:.-]{1,120}$'),
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table nr_review.kv enable row level security;
revoke all on table nr_review.kv from public, anon, authenticated;

-- 값(없으면 null)
create or replace function public.nr_kv_get(p_secret text, p_key text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  perform nr_review.assert_secret(p_secret);
  if p_key is null or p_key !~ '^[a-z0-9_:.-]{1,120}$' then
    raise exception 'invalid key' using errcode = '22023';
  end if;
  return (select k.value from nr_review.kv k where k.key = p_key);
end;
$function$;

-- 넣기(있으면 바꿈) → {ok:true, at}
create or replace function public.nr_kv_set(p_secret text, p_key text, p_value jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_at timestamptz;
begin
  perform nr_review.assert_secret(p_secret);
  if p_key is null or p_key !~ '^[a-z0-9_:.-]{1,120}$' then
    raise exception 'invalid key' using errcode = '22023';
  end if;
  if p_value is null then
    raise exception 'value required' using errcode = '22023';
  end if;
  if octet_length(p_value::text) > 65536 then
    raise exception 'value too large' using errcode = '54000';
  end if;
  insert into nr_review.kv as k (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at
  returning k.updated_at into v_at;
  return jsonb_build_object('ok', true, 'at', v_at);
end;
$function$;

-- 없을 때만 넣기 → 넣었으면 true(먼저 차지함) · 이미 있으면 false. 동시에 불러도 한 쪽만 true(기본 키 충돌은 do nothing)
create or replace function public.nr_kv_claim(p_secret text, p_key text, p_value jsonb)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_n integer;
begin
  perform nr_review.assert_secret(p_secret);
  if p_key is null or p_key !~ '^[a-z0-9_:.-]{1,120}$' then
    raise exception 'invalid key' using errcode = '22023';
  end if;
  if p_value is null then
    raise exception 'value required' using errcode = '22023';
  end if;
  if octet_length(p_value::text) > 65536 then
    raise exception 'value too large' using errcode = '54000';
  end if;
  insert into nr_review.kv (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$function$;

-- 지우기 → 지웠으면 true
create or replace function public.nr_kv_del(p_secret text, p_key text)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_n integer;
begin
  perform nr_review.assert_secret(p_secret);
  if p_key is null or p_key !~ '^[a-z0-9_:.-]{1,120}$' then
    raise exception 'invalid key' using errcode = '22023';
  end if;
  delete from nr_review.kv k where k.key = p_key;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$function$;

revoke all on function public.nr_kv_get(text, text) from public, anon, authenticated;
revoke all on function public.nr_kv_set(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.nr_kv_claim(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.nr_kv_del(text, text) from public, anon, authenticated;
grant execute on function public.nr_kv_get(text, text) to anon;
grant execute on function public.nr_kv_set(text, text, jsonb) to anon;
grant execute on function public.nr_kv_claim(text, text, jsonb) to anon;
grant execute on function public.nr_kv_del(text, text) to anon;

-- PostgREST가 새 함수를 바로 알도록
notify pgrst, 'reload schema';

-- 확인: select key, left(value::text, 80) as value, updated_at from nr_review.kv where key not like 'push_vapid%' order by updated_at desc limit 20;
--       select p.proname, array_to_string(p.proacl, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'nr\_kv\_%';
-- 자동 답변 설정 보기: select value from nr_review.kv where key = 'ai_cfg';
-- 쌓인 표시 정리(선택 — 30일 지난 것): delete from nr_review.kv where key ~ '^ai_(done|fail|count|capnote):' and updated_at < now() - interval '30 days';
-- 알림 서명 키를 새로 만들게 하려면(모든 기기가 알림을 다시 켜야 함): delete from nr_review.kv where key in ('push_vapid', 'push_subs');

-- 되돌리기(필요할 때만 — 설정 · 알림 기기 · 서명 키도 사라진다):
-- drop function if exists public.nr_kv_get(text, text);
-- drop function if exists public.nr_kv_set(text, text, jsonb);
-- drop function if exists public.nr_kv_claim(text, text, jsonb);
-- drop function if exists public.nr_kv_del(text, text);
-- drop table if exists nr_review.kv;
-- notify pgrst, 'reload schema';
