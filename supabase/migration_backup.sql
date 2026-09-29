-- 9/29 저녁 DB 매일 자동 백업 — Supabase Cron(pg_cron)이 매일 23:55(한국 시각)에 검토 문서 전체를 그날 날짜로 떠 둔다(30일 보관).
--   nr_review.backup_daily: day(한국 날짜) · taken_at · counts(컬렉션별 문서 수) · bytes · docs([{coll, id, body, by_name, updated_at}])
--   관리 탭(정유정)이 서버 /api/backups를 거쳐 목록 · 날짜별 내려받기(JSON — 화면 백업과 같은 모양이라 「가져오기」로 되올림).
--   함수 public.nr_list_backups · nr_get_backup은 다른 nr_ 함수처럼 APP_SECRET 검사(anon · service_role만 실행).
-- 적용: Supabase SQL Editor(nigt-data-review)에서 한 번. 여러 번 실행해도 된다. 되돌리기는 맨 아래.

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create table if not exists nr_review.backup_daily (
  day date primary key,
  taken_at timestamptz not null default now(),
  counts jsonb not null default '{}'::jsonb,
  bytes integer not null default 0,
  docs jsonb not null default '[]'::jsonb
);
alter table nr_review.backup_daily enable row level security;
revoke all on table nr_review.backup_daily from public, anon, authenticated;

-- 백업 뜨기(같은 날 다시 뜨면 덮어씀) · 30일 넘은 것 지움. 예약 작업(postgres)만 부름.
create or replace function nr_review.take_backup()
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_docs jsonb;
  v_counts jsonb;
  v_bytes integer;
begin
  select coalesce(jsonb_agg(jsonb_build_object('coll', d.coll, 'id', d.id, 'body', d.body, 'by_name', d.by_name, 'updated_at', d.updated_at) order by d.coll, d.id), '[]'::jsonb)
    into v_docs
    from nr_review.docs d;
  select coalesce(jsonb_object_agg(x.coll, x.n), '{}'::jsonb)
    into v_counts
    from (select d.coll, count(*) as n from nr_review.docs d group by d.coll) x;
  v_bytes := octet_length(v_docs::text);
  insert into nr_review.backup_daily as b (day, taken_at, counts, bytes, docs)
  values (v_day, now(), v_counts, v_bytes, v_docs)
  on conflict (day) do update
    set taken_at = excluded.taken_at, counts = excluded.counts, bytes = excluded.bytes, docs = excluded.docs;
  delete from nr_review.backup_daily b where b.day < v_day - 30;
  return jsonb_build_object('day', v_day, 'counts', v_counts, 'bytes', v_bytes);
end;
$function$;
revoke all on function nr_review.take_backup() from public, anon, authenticated;

-- 목록(최근 날짜부터) — 내용(docs)은 빼고
create or replace function public.nr_list_backups(p_secret text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  perform nr_review.assert_secret(p_secret);
  return coalesce((
    select jsonb_agg(jsonb_build_object('day', b.day, 'taken_at', b.taken_at, 'counts', b.counts, 'bytes', b.bytes) order by b.day desc)
    from nr_review.backup_daily b
  ), '[]'::jsonb);
end;
$function$;

-- 한 날짜(없으면 null)
create or replace function public.nr_get_backup(p_secret text, p_day date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  perform nr_review.assert_secret(p_secret);
  return (
    select jsonb_build_object('day', b.day, 'taken_at', b.taken_at, 'counts', b.counts, 'bytes', b.bytes, 'docs', b.docs)
    from nr_review.backup_daily b
    where b.day = p_day
  );
end;
$function$;
revoke all on function public.nr_list_backups(text) from public, authenticated;
revoke all on function public.nr_get_backup(text, date) from public, authenticated;
grant execute on function public.nr_list_backups(text) to anon, service_role;
grant execute on function public.nr_get_backup(text, date) to anon, service_role;

-- 매일 23:55 한국 시각(= 14:55 UTC — pg_cron은 UTC). 같은 이름이면 고쳐 씀.
select cron.schedule('nr_backup_daily', '55 14 * * *', $$select nr_review.take_backup()$$);

-- 확인: select jobid, schedule, command, active from cron.job where jobname = 'nr_backup_daily';
--       select day, taken_at, counts, bytes from nr_review.backup_daily order by day desc;
--       select status, start_time, return_message from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'nr_backup_daily') order by start_time desc limit 5;
-- 지금 한 번 뜨기: select nr_review.take_backup();
-- 되살리기(그날 23:55 상태로 — 되돌린 것도 저장 이력에 남김):
--   with b as (select x.coll, x.id, x.body, x.by_name from nr_review.backup_daily d, jsonb_to_recordset(d.docs) as x(coll text, id text, body jsonb, by_name text)
--              where d.day = date '2026-09-30' and x.coll = 'reviews' /* and x.id = 'e_B-002' 한 문서만 */),
--   up as (insert into nr_review.docs as d (coll, id, body, by_name, updated_at) select coll, id, body, left('복원 ' || coalesce(by_name, ''), 80), now() from b
--          on conflict (coll, id) do update set body = excluded.body, by_name = excluded.by_name, updated_at = excluded.updated_at
--          returning d.coll, d.id, d.body, d.by_name, d.updated_at)
--   insert into nr_review.doc_history (coll, id, body, by_name, at) select coll, id, body, by_name, updated_at from up;
--   (화면으로: 관리 탭에서 그날 백업을 내려받아 「내보내기 · 가져오기」 가져오기 → 「덮어쓰기」 → 「백업 되올리기」)
-- 되돌리기(예약 · 표 · 함수 지움 — 백업 내용도 사라짐):
--   select cron.unschedule('nr_backup_daily');
--   drop function if exists public.nr_get_backup(text, date); drop function if exists public.nr_list_backups(text); drop function if exists nr_review.take_backup();
--   drop table if exists nr_review.backup_daily;
