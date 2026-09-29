-- =====================================================================
-- 검토 화면 파일(review.html) 보관 — Vercel 빌드가 여기서 받아 정적 파일로 만든다.
--   * nr_review.assets: 파일 조각(name, part). API 비노출 스키마.
--   * public.nr_put_asset_part: 에지 함수(nr-upload, 서비스 역할)만 부름. settings.upload_open(만료 시각)이 지나면 거절.
--   * public.nr_asset_info · nr_get_asset: 빌드가 APP_SECRET으로 부름(anon).
-- 여러 번 실행해도 된다. 지우려면 rollback.sql.
-- =====================================================================
create table if not exists nr_review.assets (
  name        text not null check (name ~ '^[a-z0-9_.-]{1,40}$'),
  part        int  not null check (part >= 0 and part < 1000),
  data        text not null,
  updated_at  timestamptz not null default now(),
  primary key (name, part)
);
alter table nr_review.assets enable row level security;
revoke all on nr_review.assets from public, anon, authenticated;

create or replace function public.nr_put_asset_part(p_name text, p_part int, p_total int, p_data text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  select s.value::timestamptz into v_until from nr_review.settings s where s.key = 'upload_open';
  if v_until is null or v_until < now() then
    raise exception 'upload closed' using errcode = 'PT403';
  end if;
  if p_name is null or p_name !~ '^[a-z0-9_.-]{1,40}$' or p_total is null or p_total < 1 or p_total > 1000
     or p_part is null or p_part < 0 or p_part >= p_total or p_data is null then
    raise exception 'invalid' using errcode = '22023';
  end if;
  if octet_length(p_data) > 3000000 then
    raise exception 'part too large' using errcode = '54000';
  end if;
  if p_part = 0 then
    delete from nr_review.assets a where a.name = p_name;      -- 새 판을 올리기 시작하면 옛 조각을 지움(조각은 0번부터 차례로 올림)
  end if;
  insert into nr_review.assets (name, part, data) values (p_name, p_part, p_data)
    on conflict (name, part) do update set data = excluded.data, updated_at = now();
  return jsonb_build_object('ok', true, 'part', p_part);
end;
$$;
revoke all on function public.nr_put_asset_part(text, int, int, text) from public, anon, authenticated;
grant execute on function public.nr_put_asset_part(text, int, int, text) to service_role;

create or replace function public.nr_asset_info(p_secret text, p_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform nr_review.assert_secret(p_secret);
  return jsonb_build_object(
    'parts', (select count(*) from nr_review.assets a where a.name = p_name),
    'sha256', (select s.value from nr_review.settings s where s.key = 'asset_sha256:' || p_name),
    'updated_at', (select max(a.updated_at) from nr_review.assets a where a.name = p_name));
end;
$$;
revoke all on function public.nr_asset_info(text, text) from public, anon, authenticated;
grant execute on function public.nr_asset_info(text, text) to anon;

create or replace function public.nr_get_asset(p_secret text, p_name text, p_part int)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform nr_review.assert_secret(p_secret);
  return (select a.data from nr_review.assets a where a.name = p_name and a.part = p_part);
end;
$$;
revoke all on function public.nr_get_asset(text, text, int) from public, anon, authenticated;
grant execute on function public.nr_get_asset(text, text, int) to anon;

notify pgrst, 'reload schema';
