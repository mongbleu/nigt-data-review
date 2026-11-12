-- 미니게임(베타) game 컬렉션 — 검토자끼리 오목 · 가위바위보 · 반응속도 · 데이터 요소 퀴즈
--   판마다 문서 1개: id = g_<시각 36진수>_<무작위 4~8자> · body 모양과 규칙은 lib/minigame.js 머리 주석
--   읽기 = 검토자 · 관리자만(서버 app/api/docs가 거름 — 보기 전용은 빈 목록 · 가위바위보는 상대가 아직 안 낸 판을 '?'로 가림)
--   쓰기 = 서버가 행동(act)을 검사해 바꿀 칸만 nr_patch_doc으로 합침(새 판만 nr_set_doc)
--   doc_history에는 남기지 않는다(수마다 저장되므로 · time · profile · chat과 같게). 매일 자동 백업(take_backup)은 컬렉션을 가리지 않으므로 그대로 들어간다(바꾸지 않음).
-- 적용: Supabase SQL Editor(nigt-data-review)에서 한 번. 여러 번 실행해도 된다. 되돌리기는 맨 아래.
--   아래 세 함수는 지금 운영 정의(= migration_chat.sql)에서 컬렉션 목록에 'game'을 더하고 이력 제외를 ('time', 'profile', 'chat', 'game')로 바꾼 것뿐이다.

begin;

alter table nr_review.docs drop constraint if exists docs_coll_check;
alter table nr_review.docs add constraint docs_coll_check check (coll = any (array['reviews'::text, 'answers'::text, 'config'::text, 'time'::text, 'profile'::text, 'chat'::text, 'game'::text]));

CREATE OR REPLACE FUNCTION public.nr_set_doc(p_secret text, p_coll text, p_id text, p_body jsonb, p_by text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_at timestamptz;
begin
  perform nr_review.assert_secret(p_secret);
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config', 'time', 'profile', 'chat', 'game') then
    raise exception 'invalid collection' using errcode = '22023';
  end if;
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,80}$' then
    raise exception 'invalid id' using errcode = '22023';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'body must be a JSON object' using errcode = '22023';
  end if;
  if octet_length(p_body::text) > 131072 then
    raise exception 'body too large' using errcode = '54000';
  end if;

  insert into nr_review.docs as d (coll, id, body, by_name, updated_at)
  values (p_coll, p_id, p_body, left(p_by, 80), now())
  on conflict (coll, id) do update
    set body = excluded.body, by_name = excluded.by_name, updated_at = excluded.updated_at
  returning d.updated_at into v_at;

  if p_coll not in ('time', 'profile', 'chat', 'game') then
    insert into nr_review.doc_history (coll, id, body, by_name, at)
    values (p_coll, p_id, p_body, left(p_by, 80), v_at);
  end if;

  return jsonb_build_object('ok', true, 'at', v_at);
end;
$function$;

CREATE OR REPLACE FUNCTION public.nr_patch_doc(p_secret text, p_coll text, p_id text, p_body jsonb, p_paths text[], p_by text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_cur jsonb;
  v_new jsonb;
  v_at timestamptz;
  v_p text;
  v_k text[];
  v_v jsonb;
begin
  perform nr_review.assert_secret(p_secret);
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config', 'time', 'profile', 'chat', 'game') then
    raise exception 'invalid collection' using errcode = '22023';
  end if;
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,80}$' then
    raise exception 'invalid id' using errcode = '22023';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'body must be a JSON object' using errcode = '22023';
  end if;
  if octet_length(p_body::text) > 131072 then
    raise exception 'body too large' using errcode = '54000';
  end if;
  if p_paths is null or cardinality(p_paths) > 600 then
    raise exception 'invalid paths' using errcode = '22023';
  end if;

  select d.body into v_cur from nr_review.docs d where d.coll = p_coll and d.id = p_id for update;
  if v_cur is null then
    v_new := p_body;
  else
    v_new := v_cur;
    foreach v_p in array p_paths loop
      if v_p is null or v_p !~ '^[A-Za-z0-9_-]{1,40}([.][A-Za-z0-9_-]{1,80})?$' then
        continue;
      end if;
      v_k := string_to_array(v_p, '.');
      v_v := p_body #> v_k;
      if cardinality(v_k) = 2 and jsonb_typeof(v_new -> v_k[1]) is distinct from 'object' then
        if v_v is null then
          continue;
        end if;
        v_new := jsonb_set(v_new, v_k[1:1], '{}'::jsonb, true);
      end if;
      if v_v is null then
        v_new := v_new #- v_k;
      else
        v_new := jsonb_set(v_new, v_k, v_v, true);
      end if;
    end loop;
    foreach v_p in array array['by_name', 'by', 'at', 'src', 'imported_by', 'rv_name'] loop
      if p_body ? v_p then
        v_new := jsonb_set(v_new, array[v_p], p_body -> v_p, true);
      end if;
    end loop;
  end if;
  if octet_length(v_new::text) > 131072 then
    raise exception 'body too large' using errcode = '54000';
  end if;

  insert into nr_review.docs as d (coll, id, body, by_name, updated_at)
  values (p_coll, p_id, v_new, left(p_by, 80), now())
  on conflict (coll, id) do update
    set body = excluded.body, by_name = excluded.by_name, updated_at = excluded.updated_at
  returning d.updated_at into v_at;

  if p_coll not in ('time', 'profile', 'chat', 'game') then
    insert into nr_review.doc_history (coll, id, body, by_name, at)
    values (p_coll, p_id, v_new, left(p_by, 80), v_at);
  end if;

  return jsonb_build_object('ok', true, 'at', v_at, 'body', v_new);
end;
$function$;

CREATE OR REPLACE FUNCTION public.nr_list_docs(p_secret text, p_coll text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
begin
  perform nr_review.assert_secret(p_secret);
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config', 'time', 'profile', 'chat', 'game') then
    raise exception 'invalid collection' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'body', d.body, 'by_name', d.by_name, 'updated_at', d.updated_at) order by d.id)
    from nr_review.docs d
    where d.coll = p_coll
      and (p_since is null or d.updated_at > p_since)
  ), '[]'::jsonb);
end;
$function$;

commit;

notify pgrst, 'reload schema';

-- 권한은 create or replace가 그대로 둔다(nr_list_docs · nr_set_doc · nr_patch_doc — anon · service_role만). 확인:
--   select p.proname, array_to_string(p.proacl, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('nr_list_docs', 'nr_set_doc', 'nr_patch_doc');
--   select id, body->>'g' as g, body->>'mode' as mode, body->>'st' as st, updated_at from nr_review.docs where coll = 'game' order by updated_at desc limit 20;

-- 되돌리기(필요할 때만): 게임 문서를 보관 표로 옮긴 뒤 제약 · 함수를 여섯 컬렉션으로 되돌린다.
--   (문서를 바로 지우지 않고 nr_review.game_archive로 옮김 — 필요 없으면 나중에 그 표만 지우면 됨)
-- begin;
-- create table if not exists nr_review.game_archive as select * from nr_review.docs where false;
-- insert into nr_review.game_archive select * from nr_review.docs where coll = 'game';
-- delete from nr_review.docs where coll = 'game';
-- alter table nr_review.docs drop constraint docs_coll_check;
-- alter table nr_review.docs add constraint docs_coll_check check (coll = any (array['reviews'::text, 'answers'::text, 'config'::text, 'time'::text, 'profile'::text, 'chat'::text]));
-- commit;
-- (그다음 함수 세 개는 migration_chat.sql 정의로 다시 create or replace — migration_chat.sql을 통째로 다시 실행해도 됨. 서버 코드도 'game' 이전 판으로 되돌릴 것)
