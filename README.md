# 전략지도 데이터 검토 창구 — 웹앱

검토자(claude.ai 계정 없음)가 **웹 주소 + 본인 검토자 코드**로 들어와 검토 의견을 저장하는 Next.js 앱입니다.
화면은 검토 창구(아티팩트)와 같고, 검토 기록은 Supabase `nigt-data-review`에 저장됩니다.

- 화면 파일(`public/review.html`, 검토 자료 포함)은 **저장소에 없습니다.** Vercel 빌드 때 Supabase에서 받아 옵니다(`scripts/fetch_page.mjs`, sha256 확인 · APP_SECRET 필요).
- 비밀값 · 검토 자료 · 검토자 명단은 저장소에 없습니다. 비밀값은 Vercel 환경변수로만 넣습니다.

## 로그인 코드
| 코드 | 할 수 있는 것 |
|---|---|
| 검토자 코드(8자리 숫자 + 이니셜 소문자) | 이름 고정 · **담당 데이터 요소만** 입력·저장(서버도 403으로 막음) |
| 관리자 코드(`ADMIN_CODE`) | 전체 입력 · 요소 판정 · 「관리」 탭(담당 배정 변경 · 검토자 코드 목록) |
| 공용 접속 코드(`ACCESS_CODE`) | 보기 전용(저장 불가) |

- 숫자 8자리는 서버 비밀값으로 검토자마다 계산하며 어디에도 저장하지 않습니다(`lib/auth.js`). 코드를 모두 바꾸려면 Supabase settings의 `code_ver`를 올립니다(재배포 필요 없음).
- 담당 배정 변경(`config` 문서)은 관리자 세션만 저장할 수 있습니다(`app/api/docs`).

## Vercel 환경변수 (Production)
| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | `https://woveorpjtpfgnhrtgmwn.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase → nigt-data-review → Project Settings → API Keys → Publishable key |
| `APP_SECRET` | Supabase SQL Editor: `select value from nr_review.settings where key = 'app_secret';` 결과(64자) |
| `ACCESS_CODE` | 공용 접속 코드 — 보기 전용(12자 이상) |
| `ADMIN_CODE` | 관리자 코드(검토자 코드와 다르게) |
| `AUTH_SECRET` | (선택) 쿠키 서명 · 검토자 코드 계산용. 없으면 `APP_SECRET`에서 파생 |

환경변수를 넣은 뒤 **Redeploy**해야 반영됩니다. 값이 없으면 「검토 창구 준비 중」 안내 페이지가 나옵니다.

## 구조
| 경로 | 하는 일 |
|---|---|
| `middleware.js` | 세션 쿠키 확인 → `/`에 검토 화면, 아니면 `/login` |
| `app/api/login` · `logout` · `session` | 로그인(검토자 · 관리자 · 공용 코드) · 로그아웃 · 이름 · 권한 |
| `app/api/docs` | 검토 문서 읽기/쓰기 — 보기 전용은 403, 검토자는 담당 요소만, `config`는 관리자만. **고친 칸만 합치는 저장**(`paths` → DB 문서를 잠그고 그 칸만 바꿈 — 관리자 판정과 검토자 입력이 서로 덮어쓰지 않음, 검토자는 관리 칸을 못 바꿈) · **검토 시간**(`time` — 관리자 전체 · 검토자 자기 문서만) |
| `app/api/codes` | 검토자 코드 목록(관리자 세션만) |
| `lib/auth.js` | 세션 쿠키 · 검토자 코드 계산 |
| `lib/store.js` | Supabase RPC(`nr_list_docs` · `nr_set_doc` · `nr_patch_doc` · `nr_get_setting`) |
| `public/shim.js` | 아티팩트 저장 API(`window.claude`) 대역 |
| `scripts/fetch_page.mjs` | 빌드 때 화면 파일 받기(sha256 확인) |
| `scripts/build_page.mjs` | 새 판 본문 → `public/review.html`(새 판을 만들 때 씀) |
| `supabase/*.sql` | DB 공간 · 화면 파일 · 검토자 코드 설정 · 검토 시간 · 고친 칸만 합치는 저장(`migration_time.sql`) 만들기, 지우기(모두 적용됨) |

## 화면 판
화면 파일은 Supabase에 올리고 settings `asset_sha256:review.html`에 sha256을 적은 뒤 재배포합니다. 서버 코드가 그대로면 이 저장소는 바뀌지 않습니다.

| 날짜(KST) | 화면 sha256 | 바뀐 것 |
|---|---|---|
| 2026-09-29 16:00 | `a29288e7…` | 기준 3 「수정 후 비교 가능」 + 수정 방향(필수 · 제출본 요청 내용) · 속성명 「」 · 요소명 제안 · 9개국 현지조사 7개 요소 · 「로그아웃」 버튼 · 상단 · 목록 접기 · 검토 시간 일시정지 · 「관리」 탭 일별 검토 시간 · 고친 칸만 저장(동시 저장 보호) · 수합본 왕복 손실 없음 · 한국 날짜 · 제출본은 「수정 요청」 요소만 |
| 2026-09-29 13:49 | `734efa5c…` | 「관리」 탭(관리자만 — 담당 배정 변경 · 검토자 코드 목록) · 요소 「저장」(필수 항목 확인 → 비어 있으면 알림 창, 다 차면 입력 잠금 = 검토 완료) · 「수정」(잠금 풀기) · 저장 즉시 진행률 반영 · 5단계 판단 필요 질문 · 메모 · 관리 요소 판정(접이식) · 결측코드 설명보기 · 「내 담당만 보기」 위치 |
| 2026-09-29 12:00 | `7d3a2d38…` | 검토자별 코드 · 검토자별 진행률 바 · 요소 · 전체 저장 · 시계 · 축하 팝업 |
