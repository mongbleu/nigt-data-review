# 전략지도 데이터 검토 창구 — 웹앱

검토자(claude.ai 계정 없음)가 **웹 주소 + 접속 코드**로 들어와 검토 의견을 저장하는 Next.js 앱입니다.
화면은 검토 창구(아티팩트)와 같고, 검토 기록은 Supabase `nigt-data-review`에 저장됩니다.

- 화면 파일(`public/review.html`, 검토 자료 포함)은 **저장소에 없습니다.** Vercel 빌드 때 Supabase에서 받아 옵니다(`scripts/fetch_page.mjs`, APP_SECRET 필요).
- 비밀값은 코드에 없습니다. 모두 Vercel 환경변수로만 넣습니다.

## Vercel 환경변수 (Production)
| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | `https://woveorpjtpfgnhrtgmwn.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase → nigt-data-review → Project Settings → API Keys → Publishable key |
| `APP_SECRET` | Supabase SQL Editor: `select value from nr_review.settings where key = 'app_secret';` 결과(64자) |
| `ACCESS_CODE` | 검토자 공용 접속 코드(12자 이상) |
| `ADMIN_CODE` | 관리자 코드(검토자 코드와 다르게) |

환경변수를 넣은 뒤 **Redeploy**해야 반영됩니다. 값이 없으면 「검토 창구 준비 중」 안내 페이지가 나옵니다.

## 구조
| 경로 | 하는 일 |
|---|---|
| `middleware.js` | 접속 코드 쿠키 확인 → `/`에 검토 화면, 아니면 `/login` |
| `app/api/*` | 로그인·로그아웃·세션·검토 문서 읽기/쓰기 |
| `lib/store.js` | Supabase RPC(`nr_list_docs`·`nr_set_doc`) |
| `public/shim.js` | 아티팩트 저장 API(`window.claude`) 대역 |
| `scripts/fetch_page.mjs` | 빌드 때 화면 파일 받기(sha256 확인) |
| `scripts/build_page.mjs` | 새 판 본문 → `public/review.html`(Claude가 새 판을 만들 때 씀) |
| `supabase/*.sql` | DB 공간 만들기·지우기(이미 적용됨) |
