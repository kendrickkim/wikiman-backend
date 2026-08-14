# Wikiman Backend

개인 위키 API. Node.js + Express + SQLite.

프론트엔드는 별도 저장소입니다.

## 요구 사항

- Node.js 22.22 이상

## 설치·실행

```bash
npm install
copy .env.example .env   # Windows
# cp .env.example .env   # macOS / Linux
npm run dev
```

| 주소 | 역할 |
| --- | --- |
| `http://localhost:85` | API |
| `http://localhost:80` | 프론트 정적 호스팅 (`public/`, `/api`는 API로 프록시) |

운영:

```bash
npm start
```

## 프론트 호스팅 (PWA)

프론트 저장소에서 **PWA**를 빌드해 `public/`에 넣습니다.

```bash
# 프론트 저장소 (권장)
npm run build:backend

# 또는 수동
cd ../frontend
npm run build:pwa
# Windows 예
xcopy /E /I /Y ..\frontend\dist\pwa public
```

그다음 백엔드:

```bash
npm start
```

`FRONTEND_DIST` 환경 변수로 빌드 폴더를 직접 지정할 수도 있습니다.

## 데이터

SQLite와 업로드 파일은 `data/`에 있습니다. 서버를 옮길 때 이 폴더를 함께 복사하세요.

- `data/wiki.db` — 사용자, 카테고리, 글
- `data/uploads/` — 업로드·첨부 파일

`data/`와 `.env`는 커밋하지 마세요.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `API_PORT` / `PORT` | `85` | API 서버 포트 |
| `HOST_PORT` | `80` | 프론트 호스팅 포트. `0`이면 호스팅 안 함 |
| `JWT_SECRET` | (개발용 기본값) | JWT 서명 키. **배포 시 반드시 변경** |
| `PLANTUML_SERVER` | `https://www.plantuml.com/plantuml` | PlantUML 초기값 (이후 사이트 관리에서 변경 가능) |
| `ALLOW_REGISTER` | `true` | 회원가입 허용. 작성자가 생기면 이후 가입은 닫힘 |
| `FRONTEND_DIST` | `public` | 프론트 빌드 폴더 |

운영에서 `JWT_SECRET`이 없거나 `change-me` / `dev-secret-change-me`이면 서버가 기동을 거부합니다.

## 검사

```bash
npm run lint
npm test
npm run check
```

## 기타

- DokuWiki 가져오기: `npm run import:dokuwiki` (안내는 `document/dokuwiki-import.md`)
- Docker 예시는 `document/Dockerfile` 참고

## 동작 개요

- 글은 작성중/발행, 공개/비공개로 구분됩니다
- 글·카테고리·설정 변경은 작성자만 가능합니다 (첫 가입 계정이 작성자)
- 휴지통: soft delete → 복원 / 완전 삭제 / 휴지통 비우기
