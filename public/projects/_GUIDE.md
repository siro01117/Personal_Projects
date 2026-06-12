# 프로젝트 추가법 (포털 코드 안 건드림)

새 프로젝트를 포털에 띄우려면 **이 폴더(`public/projects/`) 안에 폴더 하나만 추가**하면 됨.
`git push` → Vercel 자동 재배포 → 포털에 카드 자동 생성.

## 방법

1. `public/projects/<프로젝트id>/` 폴더 생성 (id = 영문·소문자·하이픈)
2. 그 안에:
   - `index.html` — 프로젝트 화면 (또는 manifest의 `embedUrl`로 외부 URL)
   - `manifest.json` — 아래 형식
3. `git push`

## manifest.json 형식

```json
{
  "name": "프로젝트 이름",
  "desc": "한 줄 설명",
  "stack": ["기술1", "기술2"],
  "public": true,
  "order": 2
}
```

| 키 | 뜻 |
|---|---|
| name | 카드에 뜨는 이름 (없으면 폴더명) |
| desc | 한 줄 설명 |
| stack | 기술 태그 (배열) |
| public | true=게스트에게 공개 / false=Admin만 |
| order | 표시 순서 (작을수록 위) |
| embedUrl | (선택) index.html 대신 외부 배포 URL |

## 규칙

- `_`로 시작하는 폴더는 무시됨 (이 가이드, 견본 등)
- `index.html`이 있으면 자동으로 그게 화면이 됨
- 외부에 따로 배포한 앱이면 `embedUrl`에 그 URL 넣기

## 예시

```
public/projects/
 ├─ sisa/
 │   ├─ index.html
 │   └─ manifest.json   ← {"name":"오늘의 시사", "public":true, ...}
 └─ menu-pick/
     └─ manifest.json   ← {"name":"menu-pick", "embedUrl":"https://menu-pick.vercel.app", ...}
```
