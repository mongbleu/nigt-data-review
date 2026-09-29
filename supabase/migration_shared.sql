-- =====================================================================
-- 전략지도 데이터 검토 창구 — Supabase 저장 공간 (이미 있는 프로젝트 · 새 프로젝트 공용)
-- Supabase 대시보드 → SQL Editor에 이 파일 전체를 붙여 넣고 한 번 실행한다. 여러 번 실행해도 된다.
--
-- 이미 있는 프로젝트에 넣어도 부딪히지 않게
--   * 표 3개는 전용 스키마 nr_review 안에만 만든다: settings(비밀값) · docs(검토 문서) · doc_history(저장 이력)
--     nr_review는 API(PostgREST) 노출 스키마 목록에 넣지 않는다 → 표를 인터넷에서 직접 읽거나 쓸 수 없다.
--   * 인터넷에서 부를 수 있는 것은 함수 2개뿐: public.nr_list_docs · public.nr_set_doc
--     security definer · search_path = '' · 첫 줄에서 비밀값(APP_SECRET) 검사 · anon에만 실행 권한.
--   * 기존 표·함수·정책·확장은 건드리지 않는다. 지우려면 rollback.sql.
--
-- 실행 뒤 비밀값 넣기 (Vercel 환경변수 APP_SECRET과 같은 값):
--   insert into nr_review.settings (key, value) values ('app_secret', '여기에-APP_SECRET')
--     on conflict (key) do update set value = excluded.value;
-- 확인 (빈 배열 [] 이 나오면 끝):
--   select public.nr_list_docs('여기에-APP_SECRET', 'reviews');
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 전용 스키마 (API 비노출)
-- ---------------------------------------------------------------------
create schema if not exists nr_review;
revoke all on schema nr_review from public;
revoke all on schema nr_review from anon, authenticated;

-- 비밀값 (key = 'app_secret')
create table if not exists nr_review.settings (
  key    text primary key,
  value  text not null
);

-- 검토 문서 — 화면의 db 컬렉션 reviews · answers · config 와 같다
create table if not exists nr_review.docs (
  coll        text not null check (coll in ('reviews', 'answers', 'config')),
  id          text not null check (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  body        jsonb not null check (jsonb_typeof(body) = 'object'),
  by_name     text,
  updated_at  timestamptz not null default now(),
  primary key (coll, id)
);
create index if not exists nr_docs_coll_updated on nr_review.docs (coll, updated_at);

-- 모든 저장 이력 (누가 언제 무엇을 저장했나 — 되돌릴 때 쓴다)
create table if not exists nr_review.doc_history (
  hid      bigint generated always as identity primary key,
  coll     text not null,
  id       text not null,
  body     jsonb not null,
  by_name  text,
  at       timestamptz not null default now()
);
create index if not exists nr_doc_history_doc on nr_review.doc_history (coll, id, at desc);

-- 이중 잠금: RLS 켜고 정책 없음 + anon · authenticated 권한 없음 (함수만 통과)
alter table nr_review.settings    enable row level security;
alter table nr_review.docs        enable row level security;
alter table nr_review.doc_history enable row level security;
revoke all on all tables    in schema nr_review from public, anon, authenticated;
revoke all on all sequences in schema nr_review from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 비밀값 확인 (nr_review 안 — 아래 두 함수의 첫 줄에서만 부른다)
-- ---------------------------------------------------------------------
create or replace function nr_review.assert_secret(p_secret text)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_expected text;
begin
  select s.value into v_expected from nr_review.settings s where s.key = 'app_secret';
  if v_expected is null or length(v_expected) < 16 or p_secret is null or p_secret <> v_expected then
    raise exception 'forbidden' using errcode = 'PT403';  -- PostgREST: HTTP 403
  end if;
end;
$$;
revoke all on function nr_review.assert_secret(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- public.nr_list_docs: [{id, body, by_name, updated_at}] (id 순)
--   p_since(선택)를 주면 그 뒤에 바뀐 문서만 — 화면의 15초 폴링이 쓴다
-- ---------------------------------------------------------------------
create or replace function public.nr_list_docs(p_secret text, p_coll text, p_since timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform nr_review.assert_secret(p_secret);
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config') then
    raise exception 'invalid collection' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'body', d.body, 'by_name', d.by_name, 'updated_at', d.updated_at) order by d.id)
    from nr_review.docs d
    where d.coll = p_coll
      and (p_since is null or d.updated_at > p_since)
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- public.nr_set_doc: 문서 저장(있으면 바꿈) + 이력 한 줄 → {ok:true, at}
-- ---------------------------------------------------------------------
create or replace function public.nr_set_doc(p_secret text, p_coll text, p_id text, p_body jsonb, p_by text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  perform nr_review.assert_secret(p_secret);
  if p_coll is null or p_coll not in ('reviews', 'answers', 'config') then
    raise exception 'invalid collection' using errcode = '22023';
  end if;
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,80}$' then
    raise exception 'invalid id' using errcode = '22023';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'body must be a JSON object' using errcode = '22023';
  end if;
  if octet_length(p_body::text) > 131072 then  -- 앱은 64KB에서 먼저 막는다. 여기는 안전장치
    raise exception 'body too large' using errcode = '54000';
  end if;

  insert into nr_review.docs as d (coll, id, body, by_name, updated_at)
  values (p_coll, p_id, p_body, left(p_by, 80), now())
  on conflict (coll, id) do update
    set body = excluded.body, by_name = excluded.by_name, updated_at = excluded.updated_at
  returning d.updated_at into v_at;

  insert into nr_review.doc_history (coll, id, body, by_name, at)
  values (p_coll, p_id, p_body, left(p_by, 80), v_at);

  return jsonb_build_object('ok', true, 'at', v_at);
end;
$$;

-- ---------------------------------------------------------------------
-- 실행 권한: PUBLIC · authenticated에서 걷고 anon에만 준다
-- ---------------------------------------------------------------------
revoke all on function public.nr_list_docs(text, text, timestamptz)   from public, anon, authenticated;
revoke all on function public.nr_set_doc(text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.nr_list_docs(text, text, timestamptz)   to anon;
grant execute on function public.nr_set_doc(text, text, text, jsonb, text) to anon;

commit;

-- PostgREST가 새 함수를 바로 알도록
notify pgrst, 'reload schema';
