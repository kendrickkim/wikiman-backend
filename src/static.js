import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveFrontendDir() {
  const candidates = [
    process.env.FRONTEND_DIST,
    path.resolve(__dirname, '../public'),
    path.resolve(__dirname, '../../frontend/dist/pwa'),
    path.resolve(__dirname, '../../frontend/dist/spa')
  ].filter(Boolean)

  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || null
}

function proxyToApi(apiPort) {
  return (req, res) => {
    const headers = { ...req.headers, host: `127.0.0.1:${apiPort}` }

    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: apiPort,
      path: req.originalUrl || req.url,
      method: req.method,
      headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (err) => {
      console.error(err)
      if (!res.headersSent) {
        res.status(502).json({ error: 'API 서버에 연결할 수 없습니다.' })
      } else {
        res.end()
      }
    })

    req.pipe(proxyReq)
  }
}

/** 호스팅 전용 앱: /api 프록시 + 정적 파일 */
export function createHostApp({ apiPort }) {
  const hostApp = express()
  hostApp.use('/api', proxyToApi(apiPort))
  return hostApp
}

export function mountFrontend(app) {
  const frontendDir = resolveFrontendDir()
  if (!frontendDir) {
    app.get('/', (_req, res) => {
      res.status(503).type('text/plain').send(
        '프론트엔드 빌드가 없습니다.\n프론트 저장소에서 npm run build 한 뒤 dist/pwa 내용을 backend/public 에 복사하세요.'
      )
    })
    return null
  }

  app.use(express.static(frontendDir, {
    index: 'index.html',
    fallthrough: true,
    setHeaders (res, filePath) {
      if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
        res.setHeader('Cache-Control', 'no-cache')
      }
    }
  }))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api')) return next()
    return res.sendFile(path.join(frontendDir, 'index.html'))
  })
  return frontendDir
}
