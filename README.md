[한국어](README-kr.md)

# Wikiman Backend

The reference API and web host for [Wikiman](https://github.com/kendrickkim/wikiman),
built with Node.js, Express, and SQLite.

Use this backend when you can run Node.js. For Apache or Nginx with PHP hosting, use
[wikiman-backend-php](https://github.com/kendrickkim/wikiman-backend-php).

## Start locally

Requirements:

- Node.js 22 or newer

```bash
npm install
cp .env.example .env       # macOS / Linux
# copy .env.example .env   # Windows
npm run dev
```

The API starts at `http://localhost:85`. Run
[wikiman-frontend](https://github.com/kendrickkim/wikiman-frontend) separately
at `http://localhost:9000` during development.

## Host the complete site

Build the frontend PWA into this repository, then start the production server:

```bash
# in wikiman-frontend
npm run build:backend

# in this repository
npm start
```

The default web address is `http://localhost:80`. It serves the frontend from
`public/`, routes `/api` to the API, and adds Open Graph metadata to public post
pages.

## Configuration

Copy `.env.example` to `.env` and review these values:

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_PORT` / `PORT` | `85` | API port |
| `HOST_PORT` | `80` | Web host port; `0` disables frontend hosting |
| `JWT_SECRET` | development value | JWT signing key; replace in production |
| `FRONTEND_DIST` | `public` | Frontend build directory |
| `PUBLIC_URL` | request origin | Public URL used for canonical and OG links |
| `ALLOW_REGISTER` | `true` | Allow signup until the writer account exists |
| `PLANTUML_SERVER` | public PlantUML server | Initial PlantUML endpoint |

Production startup fails when `JWT_SECRET` is missing or still uses a known
development value.

## Data and backup

Runtime data is kept together:

- `data/wiki.db` — users, categories, posts, and settings
- `data/uploads/` — uploaded files

Back up the entire `data/` directory when moving servers. Never commit `data/`
or `.env`.

## Reverse proxy and social previews

Social crawlers do not run JavaScript. Requests for pages such as `/posts/123`
must reach the Node web host on `HOST_PORT`, where post-specific Open Graph and
Twitter metadata is added.

With Nginx or Nginx Proxy Manager:

- Forward the main site to `HOST_PORT` (default `80`), not only the API port
- Preserve `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`
- Do not serve `public/index.html` directly or add a proxy-level SPA fallback
- Set `PUBLIC_URL=https://your.domain` when the external URL cannot be inferred

Example headers:

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header Host $host;
```

## Checks

```bash
npm run lint
npm test
npm run check
```

## Additional tools

- DokuWiki import: `npm run import:dokuwiki`
  ([guide](document/dokuwiki-import.md))

## Related repositories

- [Wikiman hub](https://github.com/kendrickkim/wikiman)
- [Frontend](https://github.com/kendrickkim/wikiman-frontend)
- [PHP backend](https://github.com/kendrickkim/wikiman-backend-php)
- [Android·iOS app](https://github.com/kendrickkim/wikiman-flutter)
