# EZ.WORK

개인 작업 웹앱. 첫 기능은 보고서 서랍 — 설계는 `docs/보고서-서랍.md` 가 기준이다. 설계와 다르게 만들어야 하면 먼저 설계서를 고친다.

## 규칙

- **규칙은 한 곳에서만.** 블록 어휘·이름 규칙·경로 해석은 `lib/` 에만 두고 웹과 MCP 가 가져다 쓴다. 데이터 무결성(이름 겹침·순환·깊이·죽은 부모·권한)은 DB 가 막는다
- **미니멀 1차.** 화면에 설명 문구·분류 라벨·상태 칩·중복 정보를 넣지 않는다. 없으면 쓰는 데 막힐 때만 더한다
- 사용자에게 보이는 글과 오류 문구는 한국어. 짧고 직접적으로, 무엇이 잘못됐고 어떻게 고치는지
- 보고서 문자열은 **텍스트로만** 그린다. HTML 로 해석하지 않는다. URL 은 http/https 만
- 라칸(`Personal_Projects`) 코드를 가져오지 않는다. 가져갈 것이 있으면 사용자가 말한다
- 데이터: RA-KAN Supabase 의 `ez_` 접두 테이블만 쓴다. `kv` 등 다른 테이블은 읽지도 쓰지도 않는다
- 비밀 키는 `.env.local` 에만. 커밋 금지
- 배포: GitHub `siro01117/Personal_Projects` 의 `main` 에 푸시하면 Vercel(`multiverse-time-grid`)이 **ra-kan.cloud** 로 바로 배포한다. 푸시는 사용자가 배포하라고 할 때만
- 옛 라칸 코드는 같은 저장소의 `rakan-archive` 브랜치 · `rakan-final-2026-10-01` 태그에 남아 있다. `Documents/GitHub/Personal_Projects` 폴더는 옛 라칸 — 거기서 main 에 푸시하지 않는다

## 명령

- `npm test` — vitest (lib + PGlite DB 테스트)
- `npm run typecheck` — 라우트 타입 생성(next typegen) 후 tsc
- `npm run dev` — 웹 http://localhost:3200. 개발 모드에서만 주소에 `?demo=1` 을 붙이면 로그인 없이 메모리 저장소로 확인
- `npm run build`
