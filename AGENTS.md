# Wikiman Backend

Node.js 22+ · Express 5 · SQLite(`better-sqlite3`) · ESM (`"type": "module"`).

진입점: `src/index.js` (`loadEnv.js`를 먼저 import). 개발: `npm run dev` (`node --watch`). API 포트 `85`, 호스팅 포트 `80`.

## 구조

- `src/routes/` — `/api/auth`, `/posts`, `/categories`, `/uploads`, `/plantuml`, `/settings`, `/backup`
- `src/db.js` — 스키마·시드. WAL. 데이터는 `data/` (git 제외)
- `src/middleware/auth.js` — JWT, `optionalAuth` / `requireAuth` / `requireWriter`
- `src/settings.js` — `settings` 키/값. `favicon`은 사이트 아이콘. 홈페이지 글은 `homepage_posts` 테이블. 카테고리 트리 기본 펼침은 `category_tree_expand`(`expanded`|`collapsed`|`root`). 글자 스케일은 `font_scale`(60~120, 기본 100).
- `src/db.js` — 스키마는 정수 `schema_version`(settings). 파일 참조는 `upload_refs`.

에러 응답: `{ error: '한국어 메시지' }`. HTTP 상태 코드를 맞춥니다.

## 권한

- 첫 가입 계정이 `role=writer`. 이후 가입은 닫힙니다.
- 변경 API(글·카테고리·업로드·설정)는 `requireWriter`.
- 목록/상세: 발행+공개 글은 누구나. 작성중·비공개 글은 작성자만. 비공개 카테고리(및 그 하위)의 글은 로그인한 사용자만. 휴지통(`deleted_at`) 글은 일반 조회에서 제외. 휴지통 API는 작성자만.
- `GET /posts` 목록은 `page`(1부터), `pageSize`(10/20/50/100, 기본 10). 응답에 `total`, `page`, `pageSize`.
- `GET /posts?keyword=`는 키워드 정확히 일치 필터. `GET /posts/keywords`는 `{ keywords: [{ name, count }] }`.
- 운영에서 `JWT_SECRET`이 없거나 `change-me` / `dev-secret-change-me`이면 기동을 거부합니다.

## 글

- 상태 `draft` | `published`, 공개 `public` | `private`.
- 제목 빈 값 허용. 키워드는 `post_keywords`.
- 삭제: `DELETE /posts/:id`는 soft delete. 복원 `POST /:id/restore`. 완전 삭제 `DELETE /:id/permanent`.
- 완전 삭제 시 `post_attachments`와 본문(`/api/files/...`)에서 쓰인 업로드 파일을 함께 지웁니다. 다른 글·파비콘이 쓰는 파일은 남깁니다.
- 홈페이지: `isHomepage`로 여러 글 지정. `homepage_posts`에 순서 저장. `GET /posts/homepage`, 순서 변경 `PUT /posts/homepage/order`. 휴지통으로내면 홈에서 제거.
- 에디터: `ckeditor`(기본) | `editorjs` | `markdown` | `html`. 본문은 문자열.
- 첨부 파일: 글당 여러 개. 파일당 최대 용량은 설정 `max_attachment_mb`(기본 20, 1~200). `post_attachments`. 업로드는 `POST /uploads/files`.
- 파일 URL: 글에 묶인 파일은 `/api/posts/:id/files/:name`. 미저장 업로드·파비콘은 `/api/files/:name`. 둘 다 글 권한과 같은 접근 검사를 합니다. HTML/SVG는 다운로드 강제.
- 첨부파일 정리: `GET /uploads/orphans`로 미연결 파일 검사, `POST /uploads/orphans/cleanup`으로 삭제. `upload_refs`·첨부·파비콘 기준.
- 백업/복구: `.wkmbak` 커스텀 포맷(헤더 매직 `WIKIMNBK` + 형식 버전 + 스키마 메타 + gzip 본문). `GET /backup/download`, `POST /backup/inspect`, `POST /backup/restore`. 복구는 스트리밍·원자 교체. 복구 전 헤더·버전·필수 테이블/컬럼·DB 무결성·외래 키를 검사합니다.
- DokuWiki 가져오기: `npm run import:dokuwiki` (`scripts/import-dokuwiki.mjs`). 실행 시 경로·API·계정을 입력받음. 안내는 `document/dokuwiki-import.md`.

## 하지 말 것

- TypeScript 도입, ORM 도입, 다중 작성자 모델로 바꾸기.
- `data/wiki.db`, `data/uploads/`, `.env` 커밋.
- 사용자가 요청하지 않은 커밋·푸시.
