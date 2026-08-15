# Wikiman Backend

Node.js 22+ · Express 5 · SQLite(`better-sqlite3`) · ESM (`"type": "module"`).

진입점: `src/index.js` (`loadEnv.js`를 먼저 import). 개발: `npm run dev` (`node --watch`). API 포트 `85`, 호스팅 포트 `80`.

## 구조

- `src/routes/` — `/api/auth`, `/posts`, `/quick-posts`, `/categories`, `/uploads`, `/plantuml`, `/link-preview`, `/settings`, `/backup`
- `src/db.js` — 스키마·시드. WAL. 데이터는 `data/` (git 제외)
- `src/middleware/auth.js` — JWT, `optionalAuth` / `requireAuth` / `requireWriter`
- `src/settings.js` — `settings` 키/값. `favicon`은 사이트 아이콘. 홈페이지 글은 `homepage_posts` 테이블. 카테고리 트리 기본 펼침은 `category_tree_expand`(`expanded`|`collapsed`|`root`). 카테고리 트리 위치는 `category_tree_side`(`left`|`right`). 오른쪽 메뉴 기본 열림은 `right_menu_default_open`. 글자 스케일은 `font_scale`(60~120, 기본 100). 기본 에디터는 `default_editor`(데스크톱)·`default_editor_mobile`(모바일). 모바일 간단 화면은 `mobile_quick_post_enabled`, 간단 포스트 작성 에디터는 `quick_post_editor`, 일반 포스트 이동 시 에디터는 `quick_post_promote_editor`(`ask`|에디터 종류), 이동 후 원본 처리는 `quick_post_promote_source_mode`(`ask`|`delete`|`keep`). 블로그 모드는 `blog_mode`, 블로그 한 페이지 글 수는 `blog_posts_per_page`(1~100, 기본 10). Markdown 코드 블록 라인 번호는 `code_line_numbers`. 링크 캐시 TTL은 `link_preview_cache_ttl_days`, 만료 후 조회 실패 시 연장 TTL은 `link_preview_failure_ttl_days`.
- `src/db.js` — 스키마는 정수 `schema_version`(settings). 파일 참조는 `upload_refs`. 간단 포스트는 `quick_posts`. 링크 미리보기 캐시는 `link_preview_cache`.

에러 응답: `{ error: '한국어 메시지' }`. HTTP 상태 코드를 맞춥니다.

## 권한

- 첫 가입 계정이 `role=writer`. 이후 가입은 닫힙니다.
- 변경 API(글·카테고리·업로드·설정)는 `requireWriter`.
- 카테고리: CRUD는 `/api/categories`. `GET /:id/post-stats`는 글 수(직접/하위 포함), `POST /:id/reassign-posts`는 해당(또는 하위 포함) 카테고리의 글을 다른 카테고리·미분류로 옮깁니다.
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
- 에디터: `textarea` | `ckeditor`(기본) | `summernote` | `tui` | `editorjs` | `markdown` | `html`. 본문은 문자열. `tui`는 Markdown으로 저장. `textarea`는 일반 텍스트.
- 간단 포스트: `quick_posts` 별도 테이블. CRUD는 `/api/quick-posts`. `POST /:id/promote`로 선택한 에디터의 제목 없는 미분류·공개·작성중 포스트를 만들며, 설정과 `keepSource`에 따라 원본을 유지하거나 삭제한다.
- 첨부 파일: 글당 여러 개. 파일당 최대 용량은 설정 `max_attachment_mb`(기본 20, 1~200). `post_attachments`. 업로드는 `POST /uploads/files`.
- 파일 URL: 글에 묶인 파일은 `/api/posts/:id/files/:name`. 미저장 업로드·파비콘은 `/api/files/:name`. 둘 다 글 권한과 같은 접근 검사를 합니다. HTML/SVG는 다운로드 강제.
- 첨부파일 정리: `GET /uploads/orphans`로 미연결 파일 검사, `POST /uploads/orphans/cleanup`으로 삭제. `upload_refs`·첨부·파비콘 기준.
- 백업/복구: `.wkmbak` 커스텀 포맷(헤더 매직 `WIKIMNBK` + 형식 버전 + 스키마 메타 + gzip 본문). `GET /backup/download`, `POST /backup/inspect`, `POST /backup/restore`. 복구는 스트리밍·원자 교체. 복구 전 헤더·버전·필수 테이블/컬럼·DB 무결성·외래 키를 검사합니다.
- 프론트 호스팅 HTML은 URL별 Open Graph/Twitter 메타를 주입합니다. 공개 포스트만 제목·요약·첫 이미지를 노출하며, 이미지가 없으면 Wikiman 아이콘을 사용합니다. 외부 공개 주소는 `PUBLIC_URL`.
- 링크 미리보기: `/api/link-preview`. 외부 HTML 메타는 SQLite `link_preview_cache`에 설정된 기간 동안 캐시. 만료 후 재조회 실패 시 기존 캐시를 설정된 기간만큼 연장합니다. 미리보기 조회는 누구나(요청 제한), 캐시 삭제는 작성자만(`GET|DELETE /api/link-preview/cache`).
- DokuWiki 가져오기: `npm run import:dokuwiki` (`scripts/import-dokuwiki.mjs`). 실행 시 경로·API·계정을 입력받음. 안내는 `document/dokuwiki-import.md`.

## 하지 말 것

- TypeScript 도입, ORM 도입, 다중 작성자 모델로 바꾸기.
- `data/wiki.db`, `data/uploads/`, `.env` 커밋.
- 사용자가 요청하지 않은 커밋·푸시.
