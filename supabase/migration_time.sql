-- 9/29 검토 시간(일별) — time 컬렉션 + 바뀐 칸만 합치는 저장(nr_patch_doc)
--   검토자마다 문서 1개: id = t_<로그인 이름 UTF-8 hex>, body = {kind:'time', name, dev:{<기기>:{days:{'YYYY-MM-DD': 초}, at, paused}}, at}
--   화면이 5분마다 · 일시정지 · 창을 닫을 때 저장한다. 읽기·쓰기 권한(관리자 전체 · 검토자 자기 문서만 · 보기 전용 없음)은 app/api/docs가 거른다.
--   저장이 잦아 doc_history에는 남기지 않는다(나머지 컬렉션은 그대로 남김).
-- 적용: Supabase SQL Editor(nigt-data-review)에서 한 번. 되돌리기는 맨 아래.

alter table nr_review.docs drop constraint if exists docs_coll_check;
alter table nr_review.docs add constraint docs_coll_check check (coll = any (array['reviews'::text, 'answers'::text, 'config'::text, 'time'::text]));

create or replace function public.nr_list_docs(p_secret text, p_coll text, p_since timestamp with time zone default null::timestamp with time zone)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  perform nr_review.assert_secret(p_secret);
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config', 'time') then
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
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config', 'time') then
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

  if p_coll <> 'time' then
    insert into nr_review.doc_history (coll, id, body, by_name, at)
    values (p_coll, p_id, p_body, left(p_by, 80), v_at);
  end if;

  return jsonb_build_object('ok', true, 'at', v_at);
end;
$function$;

-- 9/29 동시 저장 보호: 바뀐 칸만 합치는 저장(patch). 화면이 「이 사람이 고친 칸」 목록(paths)을 보내면
--   서버가 그 순간의 DB 문서를 잠그고(for update) 그 칸만 바꾼다 → 관리자 판정과 검토자 입력이 서로를 덮어쓰지 않음.
--   paths: 'verdict' 같은 맨 위 칸 또는 'a.h4' · 'nt.h4x'처럼 한 단계 아래 칸. 저장자 · 시각 칸(by_name · by · at · src · imported_by · rv_name)은 보낸 값으로.
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
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config', 'time') then
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

  if p_coll <> 'time' then
    insert into nr_review.doc_history (coll, id, body, by_name, at)
    values (p_coll, p_id, v_new, left(p_by, 80), v_at);
  end if;

  return jsonb_build_object('ok', true, 'at', v_at, 'body', v_new);
end;
$function$;
revoke all on function public.nr_patch_doc(text, text, text, jsonb, text[], text) from public;
grant execute on function public.nr_patch_doc(text, text, text, jsonb, text[], text) to anon, service_role;
revoke execute on function public.nr_patch_doc(text, text, text, jsonb, text[], text) from authenticated;   -- Supabase 기본 권한(authenticated)도 뺌 — 다른 nr_ 함수와 같게

-- 되돌리기(필요할 때만): time 문서를 지우고 제약·함수를 세 컬렉션으로 되돌린다.
-- delete from nr_review.docs where coll = 'time';
-- alter table nr_review.docs drop constraint docs_coll_check;
-- alter table nr_review.docs add constraint docs_coll_check check (coll = any (array['reviews'::text, 'answers'::text, 'config'::text]));
-- (함수 두 개는 위 정의에서 'time'을 빼고 다시 create or replace) · drop function public.nr_patch_doc(text, text, text, jsonb, text[], text);
