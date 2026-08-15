[한국어](README-kr.md)

# Wikiman Backend

Personal wiki API. Node.js + Express + SQLite.

The frontend lives in a separate repository.

## Requirements

- Node.js 22.22 or newer

## Install & run

```bash
npm install
copy .env.example .env   # Windows
# cp .env.example .env   # macOS / Linux
npm run dev
```

| URL | Role |
| --- | --- |
| `http://localhost:85` | API |
| `http://localhost:80` | Frontend static hosting (`public/`, `/api` proxied to the API) |

Production:

```bash
npm start
```

## Frontend hosting (PWA)

Build the **PWA** from the frontend repo into `public/`:

```bash
# From the frontend repo (recommended)
npm run build:backend

# Or manually
cd ../frontend
npm run build:pwa
# Windows example
xcopy /E /I /Y ..\frontend\dist\pwa public
```

Then start the backend:

```bash
npm start
```

You can also point `FRONTEND_DIST` at a build folder.

## Data

SQLite and uploads live under `data/`. Copy this folder when moving servers.

- `data/wiki.db` — users, categories, posts
- `data/uploads/` — uploaded attachments

Do not commit `data/` or `.env`.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `API_PORT` / `PORT` | `85` | API port |
| `HOST_PORT` | `80` | Frontend host port (`0` disables hosting) |
| `JWT_SECRET` | (dev default) | JWT signing key. **Change in production** |
| `PLANTUML_SERVER` | `https://www.plantuml.com/plantuml` | Initial PlantUML server (editable in site admin) |
| `ALLOW_REGISTER` | `true` | Allow registration until a writer exists |
| `FRONTEND_DIST` | `public` | Frontend build folder |
| `PUBLIC_URL` | request origin | Public base URL for canonical/OG image URLs |

If `JWT_SECRET` is missing or still `change-me` / `dev-secret-change-me` in production, the server refuses to start.

Hosted SPA URLs include Open Graph / Twitter meta. Public posts expose title, description, and the first body image (or the Wikiman icon). Private and draft posts are not exposed. Empty titles fall back to the site title. HTML `lang` and `og:locale` follow the site language setting.

## Nginx proxy (Open Graph)

Crawlers such as Kakao or Facebook do not run JavaScript. `og:*` for `/posts/123` is injected by the **host (`HOST_PORT`, default `:80`)**. Proxy that HTML to Node; do not serve a static `index.html` for those routes.

### Nginx Proxy Manager

1. **Proxy Hosts → Details**
   - Forward Hostname / IP: machine running the backend
   - Forward Port: **`80`** (`HOST_PORT`. Forwarding only `:85` breaks OG)
   - Cache Assets: preferably off
2. **(Optional) Custom Locations**
   - Send `/api` to port `85`; keep `/` and `/posts/...` on Details `:80`
3. Add this under **Advanced → Custom Nginx Configuration**:

```nginx
# Do not cache HTML / post URLs (stale OG)
proxy_cache_bypass $http_upgrade;
proxy_no_cache 1;

# Absolute URLs for og:url / og:image
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header Host $host;
```

Do not:

- Handle SPA fallback with `try_files … /index.html` in the proxy
- Serve `public/` directly with `root` / `alias` in OpenResty

Set `PUBLIC_URL=https://your.domain` in `.env` for stable canonical and image URLs.

Verify:

```bash
curl -sI https://your.domain/posts/123
# X-Powered-By: Express → reached the Node host

curl -s https://your.domain/posts/123 | findstr /i "og:title"
# One post title line (must not duplicate the site default title)
```

## Checks

```bash
npm run lint
npm test
npm run check
```

## Other

- DokuWiki import: `npm run import:dokuwiki` (see `document/dokuwiki-import.md`)
- Docker example: `document/Dockerfile`

## Feature overview

- Site language (`siteLanguage`: `ko-KR` | `en-US`) drives HTML `lang` and `og:locale` metadata
- API failures use stable error codes; the frontend translates them for the selected language
- Posts are draft/published and public/private
- Posts, categories, and settings require a writer (first registered account)
- Blog mode, posts per page, and homepage pinning are managed via the settings API
- Trash: soft delete → restore / hard delete / empty trash
