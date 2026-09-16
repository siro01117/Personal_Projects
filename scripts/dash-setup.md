# /dash 현황 대시보드 — 설치

대시보드는 **읽기만** 한다. 쓰는 쪽은 둘뿐이고, 토큰이 드는 건 두 번째뿐이다.

| | 무엇을 | 언제 | 비용 |
|---|---|---|---|
| `dash-collect.mjs` | 깃(브랜치·미푸시·미커밋·마지막 커밋) + 볼트(미결 헤딩·데일리·수정시각) | 작업 스케줄러 10분 | 0 |
| `dash-say.mjs` | 작업 축의 서술 — 지금 뭘 붙잡았나, 막힌 것, 답 대기 | "일단 여기까지" 시점에만 | 호출 1회 |
| `lib/dash-rules.js` | "놓치고 있던 것" — 방치 기간·상태·마감으로 계산 | 화면을 열 때마다 | 0 |

규칙은 화면에서 돈다. 기준을 바꿔도 수집기를 다시 돌릴 필요가 없다 (`lib/dash-rules.js` 의 `T`).

## 1. 자격증명

`.env.local` (레포 루트, `.gitignore` 의 `.env*.local` 에 걸려 커밋되지 않음):

```
SUPABASE_SERVICE_ROLE_KEY=<Supabase 대시보드 → Project Settings → API → service_role>
```

service_role 은 RLS 를 통과하는 키다. **이 파일 밖으로 나가면 안 된다** — 커밋 금지, 브라우저 코드 금지.
키 없이 수집 내용만 확인하려면 `node scripts/dash-collect.mjs --dry`.

## 2. 스케줄러 등록

관리자 권한 없이 사용자 작업으로 등록된다.

```
schtasks /create /tn "RaKan 현황 수집" /tr "\"%USERPROFILE%\Documents\GitHub\Personal_Projects\scripts\dash-collect.cmd\"" /sc minute /mo 10 /f
```

확인·해제:

```
schtasks /run /tn "RaKan 현황 수집"
schtasks /query /tn "RaKan 현황 수집"
schtasks /delete /tn "RaKan 현황 수집" /f
```

로그는 `%TEMP%\dash-collect.log`.

## 3. 수집 범위 바꾸기

환경변수로 덮어쓴다 (없으면 기본값 — 깃 레포 3개 + 볼트).

- `DASH_REPOS` — `;` 로 구분한 레포 경로 목록
- `DASH_VAULT` — 옵시디언 볼트 경로

볼트 미결은 `## 미결` · `## 할 일` · `## 남은 것` · `## 다음 단계` · `## TODO` 아래의 **최상위 불릿**만 긁는다.
나이 기준은 파일 수정시각이다 (볼트가 git 이 아니라 다른 기준이 없다).

## 4. 작업 축 기록

```
node scripts/dash-say.mjs --id plan --title "일정 모듈 /plan" --status active \
  --note "여백·정렬 정리 끝" --next "scorer 구현" --awaiting "이동시간 기준"
node scripts/dash-say.mjs --id plan --status done
node scripts/dash-say.mjs --list
```

`--id` 가 같으면 덮어쓴다(누적 X). 병렬 세션은 서로 다른 `--id` 를 쓰면 안 섞인다.
준 필드만 갱신되고 안 준 필드는 유지된다.

## 5. 검증

```
node scripts/dash-selftest.mjs     # 규칙 23건
node scripts/dash-collect.mjs --dry
npx next build
```

로그인 없이 화면만 보기: dev 서버에서 `/dash?fixture=1` (`NODE_ENV=development` 일 때만).
