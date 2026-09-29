-- =====================================================================
-- 전략지도 데이터 검토 창구 — Supabase에서 검토 공간 지우기 (migration_shared.sql을 되돌림)
-- 지우는 것: 함수 public.nr_list_docs · nr_set_doc · nr_put_asset_part · nr_asset_info · nr_get_asset, 스키마 nr_review(표 4개와 그 안의 모든 검토 기록·화면 파일).
-- 다른 표·함수는 건드리지 않는다. 되살릴 수 없으니 먼저 화면의 「수합본 내려받기」로 받아 둘 것.
-- =====================================================================

begin;

drop function if exists public.nr_list_docs(text, text, timestamptz);
drop function if exists public.nr_set_doc(text, text, text, jsonb, text);
drop function if exists public.nr_put_asset_part(text, int, int, text);
drop function if exists public.nr_asset_info(text, text);
drop function if exists public.nr_get_asset(text, text, int);
drop schema if exists nr_review cascade;   -- settings · docs · doc_history · assert_secret

commit;

notify pgrst, 'reload schema';
