-- 9/29 밤 검토자 캐릭터(profile) — 「🏆 검토자 현황」 · 상단 순위에 보이는 캐릭터(그린이 · 곰곰이 · 본부장님 × 테두리 6색)
--   검토자마다 문서 1개: id = p_<로그인 이름 UTF-8 hex>, body = {kind:'profile', name, char:'greenie'|'gomgom'|'boss', color:'c1'…'c6', at, by_name}
--   읽기 = 모두(순위에 보임) · 쓰기 = 자기 문서만(서버 app/api/docs가 캐릭터 · 색만 받아 다시 만듦).
--   꾸밈이라 doc_history에는 남기지 않는다(time과 같게). 매일 자동 백업(take_backup)에는 다른 문서와 함께 들어간다.
-- 적용: Supabase SQL Editor(nigt-data-review)에서 한 번. 여러 번 실행해도 된다. 되돌리기는 맨 아래.
--   아래 세 함수는 migration_time.sql 정의에서 컬렉션 목록에 'profile'을 더하고 이력 제외를 ('time', 'profile')로 바꾼 것뿐이다.

alter table nr_review.docs drop constraint if exists docs_coll_check;
alter table nr_review.docs add constraint docs_coll_check check (coll = any (array['reviews'::text, 'answers'::text, 'config'::text, 'time'::text, 'profile'::text]));

create or replace function public.nr_list_docs(p_secret text, p_coll text, p_since timestamp with time zone default null::timestamp with time zone)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  perform nr_review.assert_secret(p_secret);
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config', 'time', 'profile') then
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

create or replace function public.nr_set_doc(p_secret text, p_coll text, p_id text, p_body jsonb, p_by text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_at timestamptz;
begin
  perform nr_review.assert_secret(p_secret);
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config', 'time', 'profile') then
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

  if p_coll not in ('time', 'profile') then
    insert into nr_review.doc_history (coll, id, body, by_name, at)
    values (p_coll, p_id, p_body, left(p_by, 80), v_at);
  end if;

  return jsonb_build_object('ok', true, 'at', v_at);
end;
$function$;

create or replace function public.nr_patch_doc(p_secret text, p_coll text, p_id text, p_body jsonb, p_paths text[], p_by text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_cur jsonb;
  v_new jsonb;
  v_at timestamptz;
  v_p text;
  v_k text[];
  v_v jsonb;
begin
  perform nr_review.assert_secret(p_secret);
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config', 'time', 'profile') then
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

  if p_coll not in ('time', 'profile') then
    insert into nr_review.doc_history (coll, id, body, by_name, at)
    values (p_coll, p_id, v_new, left(p_by, 80), v_at);
  end if;

  return jsonb_build_object('ok', true, 'at', v_at, 'body', v_new);
end;
$function$;
-- 권한은 create or replace가 그대로 둔다(nr_list_docs · nr_set_doc · nr_patch_doc — anon · service_role만). 확인:
--   select p.proname, array_to_string(p.proacl, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('nr_list_docs', 'nr_set_doc', 'nr_patch_doc');
--   select id, body->>'name' as name, body->>'char' as char, body->>'color' as color, updated_at from nr_review.docs where coll = 'profile' order by updated_at desc;

-- 되돌리기(필요할 때만): 캐릭터 문서를 보관 표로 옮긴 뒤 제약 · 함수를 네 컬렉션으로 되돌린다.
--   (문서를 바로 지우지 않고 nr_review.profile_archive로 옮김 — 필요 없으면 나중에 그 표만 지우면 됨)
-- create table if not exists nr_review.profile_archive as select * from nr_review.docs where false;
-- insert into nr_review.profile_archive select * from nr_review.docs where coll = 'profile';
-- delete from nr_review.docs where coll = 'profile';
-- alter table nr_review.docs drop constraint docs_coll_check;
-- alter table nr_review.docs add constraint docs_coll_check check (coll = any (array['reviews'::text, 'answers'::text, 'config'::text, 'time'::text]));
-- (함수 세 개는 migration_time.sql 정의로 다시 create or replace)
