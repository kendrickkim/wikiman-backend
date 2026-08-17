[English](README.md)

# Wikiman Backend

[Wikiman](https://github.com/kendrickkim/wikiman)의 기준 API이자 웹 호스트입니다.
Node.js, Express, SQLite로 구성됩니다.

Node.js를 실행할 수 있는 환경에서 사용하세요. Apache 또는 Nginx + PHP 호스팅에는
[wikiman-backend-php](https://github.com/kendrickkim/wikiman-backend-php)가
더 적합합니다.

## 로컬 실행

필요한 환경:

- Node.js 22 이상

```bash
npm install
cp .env.example .env       # macOS / Linux
# copy .env.example .env   # Windows
npm run dev
```

API는 `http://localhost:85`에서 시작합니다. 개발 중에는
[wikiman-frontend](https://github.com/kendrickkim/wikiman-frontend)를 별도로
실행해 `http://localhost:9000`으로 접속하세요.

## 전체 사이트 호스팅

프론트엔드 PWA를 이 저장소로 빌드한 뒤 운영 서버를 시작합니다.

```bash
# wikiman-frontend에서
npm run build:backend

# 이 저장소에서
npm start
```

기본 웹 주소는 `http://localhost:80`입니다. `public/`의 프론트엔드를 제공하고,
`/api`를 API로 연결하며, 공개 글에 Open Graph 정보를 추가합니다.

## 설정

`.env.example`을 `.env`로 복사한 뒤 다음 값을 확인하세요.

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `API_PORT` / `PORT` | `85` | API 포트 |
| `HOST_PORT` | `80` | 웹 호스트 포트. `0`이면 프론트 호스팅 안 함 |
| `JWT_SECRET` | 개발용 값 | JWT 서명 키. 운영에서는 반드시 변경 |
| `FRONTEND_DIST` | `public` | 프론트엔드 빌드 폴더 |
| `PUBLIC_URL` | 요청 주소 | canonical·Open Graph에 사용할 공개 주소 |
| `ALLOW_REGISTER` | `true` | 작성자 계정이 생길 때까지 가입 허용 |
| `PLANTUML_SERVER` | 공개 PlantUML 서버 | 초기 PlantUML 주소 |

운영 환경에서 `JWT_SECRET`이 없거나 알려진 개발용 값이면 서버가 시작되지 않습니다.

## 데이터와 백업

실행 중 생성되는 데이터는 한곳에 모입니다.

- `data/wiki.db` — 사용자, 카테고리, 글, 설정
- `data/uploads/` — 업로드 파일

서버를 옮길 때 `data/` 전체를 백업하세요. `data/`와 `.env`는 커밋하면 안 됩니다.

## 리버스 프록시와 공유 미리보기

SNS 크롤러는 JavaScript를 실행하지 않습니다. `/posts/123` 같은 페이지 요청은
`HOST_PORT`의 Node 웹 호스트까지 도달해야 글별 Open Graph와 Twitter 정보가
추가됩니다.

Nginx 또는 Nginx Proxy Manager를 사용할 때:

- 메인 사이트를 API 포트가 아닌 `HOST_PORT`(기본값 `80`)로 전달
- `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` 헤더 유지
- `public/index.html`을 직접 제공하거나 프록시에서 SPA fallback 처리하지 않기
- 외부 주소를 추론할 수 없다면 `PUBLIC_URL=https://your.domain` 지정

헤더 예:

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header Host $host;
```

## 검사

```bash
npm run lint
npm test
npm run check
```

## 추가 도구

- DokuWiki 가져오기: `npm run import:dokuwiki`
  ([안내](document/dokuwiki-import.md))

## 관련 저장소

- [Wikiman 허브](https://github.com/kendrickkim/wikiman)
- [프론트엔드](https://github.com/kendrickkim/wikiman-frontend)
- [PHP 백엔드](https://github.com/kendrickkim/wikiman-backend-php)
- [Android·iOS 앱](https://github.com/kendrickkim/wikiman-flutter)
