-- 10/1 AI 사용량(토큰) 기록 — Claude 호출마다 한 줄(추가만). 관리 탭 「🤖 AI 크레딧」이 요약을 읽어 충전한 5달러에서 줄어드는 막대로 보여 준다.
--   서버(lib/ai.js generate → lib/store.js aiUsageAdd)만 쓴다. 요금 · 잔액 계산은 lib/usage.js(달러 = 요금표 × 토큰).
--   거의 다 쓰면(기준의 20% 아래 · 0) 관리자 폰 알림은 기준마다 한 번 — 표시는 kv ai_credit:<기준 열쇠>:low|empty(nr_kv_claim · 이 파일에 새 표 없음).
--   글 내용 · 이름은 남기지 않는다: 시각 · 방식(auto 자동 답변 | draft 초안) · 성공 여부 · 답 종류 · 오류 코드 · 모델 · 토큰 4가지 · 걸린 시간만.
--   표는 API 비노출 스키마 nr_review · RLS 켬(정책 없음) · anon · authenticated 권한 없음 — 아래 함수 2개만 통과.
--   함수는 다른 nr_ 함수처럼 security definer · search_path '' · 첫 줄에서 APP_SECRET 검사(nr_review.assert_secret) · anon에만 실행 권한.
-- 적용: Supabase SQL Editor(nigt-data-review)에서 한 번(migration_ai.sql 다음). 여러 번 실행해도 된다. 되돌리기는 맨 아래.

create table if not exists nr_review.ai_usage (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  mode     text not null check (mode in ('auto', 'draft')),
  ok       boolean not null,
  kind     text check (kind is null or kind in ('answer', 'hold', 'skip')),
  err      text check (err is null or err ~ '^[a-z0-9_]{1,60}$'),
  model    text not null check (model ~ '^[a-z0-9._-]{1,80}$'),
  in_tok   integer not null default 0 check (in_tok between 0 and 10000000),
  out_tok  integer not null default 0 check (out_tok between 0 and 10000000),
  cw_tok   integer not null default 0 check (cw_tok between 0 and 10000000),
  cr_tok   integer not null default 0 check (cr_tok between 0 and 10000000),
  ms       integer check (ms is null or ms between 0 and 600000)
);
create index if not exists ai_usage_at_idx on nr_review.ai_usage (at);
alter table nr_review.ai_usage enable row level security;
revoke all on table nr_review.ai_usage from public, anon, authenticated;

-- 한 줄 넣기 → true. p_row = {mode, ok, kind, err, model, in, out, cw, cr, ms}(서버가 정리해 보냄 — 틀린 값은 제약에 걸려 오류)
create or replace function public.nr_ai_usage_add(p_secret text, p_row jsonb)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  perform nr_review.assert_secret(p_secret);
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'invalid row' using errcode = '22023';
  end if;
  insert into nr_review.ai_usage (mode, ok, kind, err, model, in_tok, out_tok, cw_tok, cr_tok, ms)
  values (
    p_row->>'mode',
    coalesce((p_row->>'ok')::boolean, false),
    nullif(p_row->>'kind', ''),
    nullif(p_row->>'err', ''),
    p_row->>'model',
    coalesce((p_row->>'in')::integer, 0),
    coalesce((p_row->>'out')::integer, 0),
    coalesce((p_row->>'cw')::integer, 0),
    coalesce((p_row->>'cr')::integer, 0),
    nullif(p_row->>'ms', '')::integer
  );
  return true;
end;
$function$;

-- 요약 → {rows:[{day(한국 날짜), model, mode, after(p_since 뒤인가 — 없으면 모두 true), calls, ok, fail, answer, hold, skip, in, out, cw, cr}], now}
create or replace function public.nr_ai_usage_summary(p_secret text, p_since timestamptz)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_rows jsonb;
begin
  perform nr_review.assert_secret(p_secret);
  select coalesce(jsonb_agg(x.j order by x.day, x.model, x.mode, x.after), '[]'::jsonb)
    into v_rows
  from (
    select s.day, s.model, s.mode, s.after,
      jsonb_build_object(
        'day', to_char(s.day, 'YYYY-MM-DD'), 'model', s.model, 'mode', s.mode, 'after', s.after,
        'calls', count(*), 'ok', count(*) filter (where s.ok), 'fail', count(*) filter (where not s.ok),
        'answer', count(*) filter (where s.kind = 'answer'), 'hold', count(*) filter (where s.kind = 'hold'), 'skip', count(*) filter (where s.kind = 'skip'),
        'in', coalesce(sum(s.in_tok), 0), 'out', coalesce(sum(s.out_tok), 0), 'cw', coalesce(sum(s.cw_tok), 0), 'cr', coalesce(sum(s.cr_tok), 0)
      ) as j
    from (
      select (u.at at time zone 'Asia/Seoul')::date as day, u.model, u.mode,
             (p_since is null or u.at >= p_since) as after,
             u.ok, u.kind, u.in_tok, u.out_tok, u.cw_tok, u.cr_tok
      from nr_review.ai_usage u
    ) s
    group by s.day, s.model, s.mode, s.after
  ) x;
  return jsonb_build_object('rows', v_rows, 'now', now());
end;
$function$;

revoke all on function public.nr_ai_usage_add(text, jsonb) from public, anon, authenticated;
revoke all on function public.nr_ai_usage_summary(text, timestamptz) from public, anon, authenticated;
grant execute on function public.nr_ai_usage_add(text, jsonb) to anon;
grant execute on function public.nr_ai_usage_summary(text, timestamptz) to anon;

-- PostgREST가 새 함수를 바로 알도록
notify pgrst, 'reload schema';

-- 확인: select at, mode, ok, kind, err, model, in_tok, out_tok, cw_tok, cr_tok, ms from nr_review.ai_usage order by at desc limit 20;
--       하루별: select (at at time zone 'Asia/Seoul')::date as day, count(*), sum(in_tok), sum(out_tok), sum(cw_tok), sum(cr_tok) from nr_review.ai_usage group by 1 order by 1 desc;
-- 잔액 기준(관리 탭 「충전했어요」 = 5달러 · 그 시각부터): select value from nr_review.kv where key = 'ai_budget';
-- 크레딧 알림 표시: select key, value, updated_at from nr_review.kv where key like 'ai_credit:%' order by updated_at desc;

-- 되돌리기(필요할 때만 — 사용량 기록이 사라진다):
-- drop function if exists public.nr_ai_usage_add(text, jsonb);
-- drop function if exists public.nr_ai_usage_summary(text, timestamptz);
-- drop table if exists nr_review.ai_usage;
-- notify pgrst, 'reload schema';
