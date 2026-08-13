# Wikiman Backend

Node.js 22+ · Express 5 · SQLite(`better-sqlite3`) · ESM (`"type": "module"`).

진입점: `src/index.js` (`loadEnv.js`를 먼저 import). 개발: `npm run dev` (`node --watch`). 포트 `3001`.

## 구조

- `src/routes/` — `/api/auth`, `/posts`, `/categories`, `/uploads`, `/plantuml`, `/settings`, `/backup`
- `src/db.js` — 스키마·시드. WAL. 데이터는 `data/` (git 제외)
- `src/middleware/auth.js` — JWT, `optionalAuth` / `requireAuth` / `requireWriter`
- `src/settings.js` — `settings` 키/값. `favicon`은 사이트 아이콘. 홈페이지 글은 `homepage_posts` 테이블.

에러 응답: `{ error: '한국어 메시지' }`. HTTP 상태 코드를 맞춥니다.

## 권한

- 첫 가입 계정이 `role=writer`. 이후 가입은 닫힙니다.
- 변경 API(글·카테고리·업로드·설정)는 `requireWriter`.
- 목록/상세: 발행+공개 글은 누구나. 작성중·비공개 글은 작성자만. 비공개 카테고리(및 그 하위)의 글은 로그인한 사용자만. 휴지통(`deleted_at`) 글은 일반 조회에서 제외.

## 글

- 상태 `draft` | `published`, 공개 `public` | `private`.
- 제목 빈 값 허용. 키워드는 `post_keywords`.
- 삭제: `DELETE /posts/:id`는 soft delete. 복원 `POST /:id/restore`. 완전 삭제 `DELETE /:id/permanent`.
- 완전 삭제 시 `post_attachments`와 본문(`/api/files/...`)에서 쓰인 업로드 파일을 함께 지웁니다. 다른 글·파비콘이 쓰는 파일은 남깁니다.
- 홈페이지: `isHomepage`로 여러 글 지정. `homepage_posts`에 순서 저장. `GET /posts/homepage`, 순서 변경 `PUT /posts/homepage/order`. 휴지통으로내면 홈에서 제거.
- 에디터: `ckeditor`(기본) | `editorjs` | `markdown` | `html`. 본문은 문자열.
- 첨부 파일: 글당 여러 개. 파일당 최대 용량은 설정 `max_attachment_mb`(기본 20, 1~200). `post_attachments`. 업로드는 `POST /uploads/files`.
- 첨부파일 정리: `GET /uploads/orphans`로 미연결 파일 검사, `POST /uploads/orphans/cleanup`으로 삭제. 글 첨부·본문·파비콘에 쓰인 파일은 남깁니다.
- 백업/복구: `.wkmbak` 커스텀 포맷(헤더 매직 `WIKIMNBK` + 형식 버전 + 스키마 메타 + gzip 본문). `GET /backup/download`, `POST /backup/inspect`, `POST /backup/restore`. 복구 전 헤더·버전·필수 테이블/컬럼·DB 무결성을 검사합니다.

## 하지 말 것

- TypeScript 도입, ORM 도입, 다중 작성자 모델로 바꾸기.
- `data/wiki.db`, `data/uploads/`, `.env` 커밋.
- 사용자가 요청하지 않은 커밋·푸시.
