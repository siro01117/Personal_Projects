# Ra_Kan — Personal Projects

직접 만들어 쓰는 것들을 한 곳에 모은 개인 포털. 배포 주소는 [ra-kan.cloud](https://ra-kan.cloud).

Next.js 16 · React 19 · Supabase · Vercel. 서버 없이 **정적으로 굽는다**(`output: 'export'`).

---

## 실행

```bash
npm run dev       # 개발 서버 :3100
npm run build     # 데모 DB 생성 + 정적 추출 → out/
npm run preview   # 빌드 후 out/ 을 :3200 으로 띄워 확인
```

`main` 에 푸시하면 Vercel 이 받아서 배포한다.

---

## 화면

| 주소 | 무엇 | 로그인 |
|---|---|---|
| `/` | 포털 홈. 일정·학습·헤리티지 | 필요 |
| `/plan` | 일정. 오늘 · 이번 주 · 할 일 · 이동시간 · 피로도 | 필요 |
| `/study` | 학습. 과목별 진도·자료·시험대비 | 필요 |
| `/dash` | 현황 대시보드. **2026-09-16 멈춤**, 수집도 꺼둠 | 필요 |
| `/m/*` | 스터디큐브 운영 모듈 (학생·좌석·순찰·벌점·스케줄·급식 등) | 필요 |
| `/studycube-demo` | PGlite 로 도는 데모 | 필요 |
| **`/open`** | **비회원 둘러보기.** 게이트 밖 | 불필요 |

---

## 인증과 경계

사이트 전체가 `app/_ui/AuthGate.js` 뒤에 있다. Supabase Auth 가 유일한 판정자이고, 코드에는 비밀번호도 해시도 없다.

정적 추출이라 서버에서 나눌 수가 없다. 그래서 **공개와 비공개는 클라이언트에서 갈린다.**

### `/open` 이 지키는 선

`/open` 은 게이트 밖에 있는 유일한 화면이다. 여기서 지키는 규칙 세 가지.

1. **포털 컴포넌트를 쓰지 않는다.** `Shell`·`AuthGate`·`supabase` 어느 것도 import 하지 않는다. 한 번 끌어오면 게이트 안쪽 모듈과 개인 데이터가 딸려 나올 길이 생긴다.
2. **내용은 `public/open/*.html` 에 통째로 둔다.** `/open` 은 목록과 액자 역할만 한다.
3. **iframe 은 `sandbox="allow-scripts"`.** 같은 출처 접근을 끊어서 시안이 포털 저장소나 쿠키를 못 건드리게 한다.

포털에는 스터디큐브 학생·좌석 같은 개인정보가 있다. 공개 화면이 그쪽에 닿지 않는 구조를 유지할 것.

### 시안 하나 더 넣기

```
public/open/<이름>.html          # 파일을 넣고
app/open/OpenClient.js  → DEMOS  # 배열에 한 줄 추가
```

---

## 폴더

```
app/
  page.js · PortalClient.js     홈
  plan/ · study/ · dash/ · m/   모듈 (전부 게이트 안)
  open/                         비회원 둘러보기 (게이트 밖)
  _ui/                          AuthGate · Shell 등 공용 껍데기
  globals.css                   토큰과 컴포넌트 스타일 전부
lib/                            도메인 로직. 화면과 분리해 둔다
public/
  projects/                     빌드 때 lib/scan.js 가 훑는다
  open/                         비회원 공개 시안
  demo-db/                      PGlite 데모 데이터
scripts/                        빌드 보조 · 수집기
out/                            빌드 결과 (커밋 안 함)
```

---

## 디자인

`app/globals.css` 상단 토큰이 전부다. 라이트·다크 두 벌.

```
--bg #f5f5f3   --panel #ffffff   --fg #191b20   --mut #5a5e69
--line rgba(20,22,28,.11)        --r 14px
--s1..--s7                        과목·카테고리 색 7종
```

**색은 점·선·막대에만 쓰고 배경은 칠하지 않는다.** 이 규칙 하나가 화면 전체의 인상을 잡는다.

글꼴은 Pretendard, 제목은 800 에 자간 -.02em, 숫자는 `font-variant-numeric: tabular-nums`. 아이콘은 lucide, `strokeWidth={1.5}`.

---

## 빌드에서 걸리는 것

- **`next build --webpack` 고정.** Turbopack 프로덕션 빌드가 PGlite 의 네임스페이스 export 를 잘라내서 런타임에 `instantiateWasm is not a function` 으로 죽는다. dev 는 트리셰이킹을 안 해 통과하므로 **배포에서만 재현된다.**
- `output: 'export'` 라 서버 함수가 없다. 데이터는 전부 클라이언트에서 Supabase 로 가져온다.
- `lib/scan.js` 는 빌드 시점에 `public/projects/*` 를 훑는다. 프로젝트를 추가하면 푸시만으로 반영된다.

---

## 손볼 것

- `RENEWAL.md` 에 **계정 비밀번호가 평문으로 적혀 있다.** 공개 저장소라면 지우고 비밀번호도 바꿀 것.
- `robots.txt` · `sitemap.xml` 이 없다. `/open` 을 검색에 태울 생각이면 같이 넣고, 게이트 안쪽에는 `noindex` 를 명시하는 편이 안전하다.
- `ra-kan.cloud` → `www` 가 **307(임시)** 로 넘어간다. 영구(308)로 바꾸면 대표 주소가 분명해진다.
- 로그인한 뒤에는 `/open` 으로 갈 길이 없다. 들어가려면 주소를 직접 쳐야 한다.
