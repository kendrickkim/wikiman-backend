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
| `PUBLIC_URL` | 요청 주소 | 외부 공개 주소(예: `https://wiki.example.com`). 링크 미리보기의 canonical·이미지 절대 URL에 사용 |

운영에서 `JWT_SECRET`이 없거나 `change-me` / `dev-secret-change-me`이면 서버가 기동을 거부합니다.

백엔드가 호스팅하는 각 SPA URL은 Open Graph/Twitter 메타 정보를 포함합니다. 공개 포스트 URL은 제목·본문 요약과 본문의 첫 이미지(없으면 Wikiman 아이콘)를 사용하며, 비공개·작성중 글의 정보는 노출하지 않습니다. 제목이 비어 있으면 사이트 제목을 씁니다.

## Nginx 프록시 (공유 메타 / Open Graph)

카카오·페이스북 등 크롤러는 JavaScript를 실행하지 않습니다. 글 URL(`/posts/123`)의 `og:*`는 **호스트(`HOST_PORT`, 기본 `:80`)** 가 `index.html`에 넣어 줍니다. 프록시는 이 HTML을 정적 파일로 주지 말고 호스트로 넘겨야 합니다.

### Nginx Proxy Manager

1. **Proxy Hosts → Details**
   - Forward Hostname / IP: 백엔드가 돌아가는 호스트
   - Forward Port: **`80`** (`HOST_PORT`. API만 `:85`로 두면 OG가 바뀌지 않음)
   - Cache Assets: 끔 권장
2. **(선택) Custom Locations**
   - `/api`만 API 포트(`85`)로 보낼 수 있음. 그 외(`/`, `/posts/...`)는 Details의 `:80`으로 유지
3. **Advanced → Custom Nginx Configuration**에 아래를 추가합니다.

```nginx
# HTML·글 URL은 캐시하지 않음 (크롤러가 낡은 OG를 받지 않게)
proxy_cache_bypass $http_upgrade;
proxy_no_cache 1;

# 절대 URL(og:url, og:image)용
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header Host $host;
```

하지 말 것:

- `try_files … /index.html`로 SPA 폴백을 프록시에서 처리하기
- `root` / `alias`로 `public/`(프론트 빌드)을 OpenResty가 직접 서빙하기

`.env`에 `PUBLIC_URL=https://your.domain`을 두면 canonical·이미지 절대 URL이 안정적입니다.

확인:

```bash
curl -sI https://your.domain/posts/123
# X-Powered-By: Express → Node 호스트까지 도달

curl -s https://your.domain/posts/123 | findstr /i "og:title"
# 글 제목 한 줄만 (사이트 기본 제목과 중복되면 안 됨)
```

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

- 글은 초안/발행, 공개/비공개로 구분됩니다
- 글·카테고리·설정 변경은 작성자만 가능합니다 (첫 가입 계정이 작성자)
- 블로그 모드·페이지당 글 수·홈페이지 글 선표시 등 사이트 설정을 API로 관리합니다
- 휴지통: soft delete → 복원 / 완전 삭제 / 휴지통 비우기
