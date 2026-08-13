# Wikiman Backend

Node.js 22+ · Express 5 · SQLite(`better-sqlite3`) · ESM (`"type": "module"`).

진입점: `src/index.js` (`loadEnv.js`를 먼저 import). 개발: `npm run dev` (`node --watch`). 포트 `3001`.

## 구조

- `src/routes/` — `/api/auth`, `/posts`, `/categories`, `/uploads`, `/plantuml`, `/settings`
- `src/db.js` — 스키마·시드. WAL. 데이터는 `data/` (git 제외)
- `src/middleware/auth.js` — JWT, `optionalAuth` / `requireAuth` / `requireWriter`
- `src/settings.js` — `settings` 키/값. `home_post_id`는 홈페이지 글

에러 응답: `{ error: '한국어 메시지' }`. HTTP 상태 코드를 맞춥니다.

## 권한

- 첫 가입 계정이 `role=writer`. 이후 가입은 닫힙니다.
- 변경 API(글·카테고리·업로드·설정)는 `requireWriter`.
- 목록/상세: 발행+공개는 누구나. 작성중·비공개는 작성자만. 휴지통(`deleted_at`) 글은 일반 조회에서 제외.

## 글

- 상태 `draft` | `published`, 공개 `public` | `private`.
- 제목 빈 값 허용. 키워드는 `post_keywords`.
- 삭제: `DELETE /posts/:id`는 soft delete. 복원 `POST /:id/restore`. 완전 삭제 `DELETE /:id/permanent`.
- 홈페이지: `isHomepage`로 지정. 하나만. 완전 삭제 시 `home_post_id` 해제.
- 에디터: `editorjs` | `markdown` | `html`. 본문은 문자열.

## 하지 말 것

- TypeScript 도입, ORM 도입, 다중 작성자 모델로 바꾸기.
- `data/wiki.db`, `data/uploads/`, `.env` 커밋.
- 사용자가 요청하지 않은 커밋·푸시.
