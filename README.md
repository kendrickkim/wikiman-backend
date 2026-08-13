# Wikiman Backend

개인 위키 API. Node.js + Express + SQLite.

프론트엔드는 별도 저장소입니다.

## 요구 사항

- Node.js 22.22 이상

## 실행

```bash
npm install
copy .env.example .env
npm run dev
```

기본 주소는 `http://localhost:3001` 입니다.

## 프론트 호스팅

프론트 저장소에서 빌드한 `dist/spa` 내용을 `public/` 에 복사하면 백엔드가 사이트까지 같이 서빙합니다.

```bash
# 프론트 저장소
npm run build

# 이 저장소
xcopy /E /I /Y ..\frontend\dist\spa public
npm start
```

`FRONTEND_DIST` 환경 변수로 빌드 폴더를 직접 지정할 수도 있습니다.

## 데이터

SQLite와 업로드 이미지는 `data/` 에 있습니다. 서버를 옮길 때 이 폴더만 복사하면 됩니다.

- `data/wiki.db` — 사용자, 카테고리, 글
- `data/uploads/` — 붙여넣기/업로드 이미지

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3001` | 서버 포트 |
| `JWT_SECRET` | (개발용 기본값) | JWT 서명 키. 배포 시 반드시 변경 |
| `PLANTUML_SERVER` | `https://www.plantuml.com/plantuml` | PlantUML 렌더 서버 |
| `ALLOW_REGISTER` | `true` | 회원가입 허용. 작성자가 생기면 이후 가입은 닫힘 |
| `FRONTEND_DIST` | `public` | 프론트 빌드 폴더 |

## 동작

- 글은 작성중/발행으로 구분됩니다. 작성중 글은 작성자만 볼 수 있습니다.
- 발행된 공개 글은 누구나, 비공개 글은 작성자만 볼 수 있습니다.
- 글 작성·수정·삭제와 카테고리 관리는 작성자 한 명만 할 수 있습니다. 처음 가입한 계정이 작성자입니다.
