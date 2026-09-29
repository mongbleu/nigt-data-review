-- =====================================================================
-- 검토자별 접속 코드 · 담당 요소만 저장 (2026-09-29) — migration_shared.sql 다음에 한 번 실행. 여러 번 실행해도 된다.
--   * 함수 1개 추가: public.nr_get_setting(p_secret, p_key) — 비밀값 검사 뒤 허용된 설정만 돌려준다
--       reviewers : 검토자 명단 JSON  [{"n":"이름","i":"이니셜","r":"rv|adm|view"}]
--       alloc     : 기본 배정 JSON    {"A-001":"이름", …}  (화면의 담당 변경 config/assign이 있으면 그쪽이 먼저)
--       code_ver  : 코드 판(기본 '1') — 바꾸면 모든 검토자 코드가 새로 바뀐다
--   * 명단·배정 넣기(비밀값 아님):
--       insert into nr_review.settings(key, value) values ('reviewers', '[…]') on conflict (key) do update set value = excluded.value;
-- =====================================================================
begin;

create or replace function public.nr_get_setting(p_secret text, p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  perform nr_review.assert_secret(p_secret);
  if p_key is null or p_key not in ('reviewers', 'alloc', 'code_ver') then
    raise exception 'forbidden' using errcode = 'PT403';
  end if;
  select s.value into v from nr_review.settings s where s.key = p_key;
  return v;
end;
$$;

revoke all on function public.nr_get_setting(text, text) from public, anon, authenticated;
grant execute on function public.nr_get_setting(text, text) to anon;

commit;
