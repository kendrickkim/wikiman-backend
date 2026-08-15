import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { injectSocialMeta, socialMetaForPath } from './socialMeta.js'
import { apiError, sendError } from './errors.js'

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
        sendError(res, apiError('API_UNREACHABLE', 502))
      } else {
        res.end()
      }
    })

    req.pipe(proxyReq)
  }
}

function publicOrigin(req) {
  const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/$/, '')
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // 잘못된 PUBLIC_URL은 요청 주소로 대체합니다.
    }
  }
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const protocol = forwardedProto === 'https' ? 'https' : 'http'
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
    .split(',')[0]
    .trim()
  try {
    return new URL(`${protocol}://${host}`).origin
  } catch {
    return `${protocol}://localhost`
  }
}

function isHtmlNavigation(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (req.path.startsWith('/api')) return false
  const lastPart = req.path.split('/').pop() || ''
  if (lastPart.includes('.')) return false
  const accept = String(req.headers.accept || '')
  return !accept || accept.includes('text/html') || accept.includes('*/*')
}

function serveFrontendHtml(frontendDir) {
  const indexPath = path.join(frontendDir, 'index.html')
  return (req, res, next) => {
    if (!isHtmlNavigation(req)) return next()
    try {
      const origin = publicOrigin(req)
      const meta = socialMetaForPath(req.path, origin)
      const html = injectSocialMeta(fs.readFileSync(indexPath, 'utf8'), meta)
      res.type('html').setHeader('Cache-Control', 'no-cache')
      return res.send(html)
    } catch (err) {
      console.error(err)
      return next()
    }
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
      res.status(503).type('text/plain').send('Frontend is not built.')
    })
    return null
  }

  const indexPath = path.join(frontendDir, 'index.html')
  app.use(serveFrontendHtml(frontendDir))
  app.use(express.static(frontendDir, {
    index: false,
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
    try {
      const origin = publicOrigin(req)
      const meta = socialMetaForPath(req.path, origin)
      const html = injectSocialMeta(fs.readFileSync(indexPath, 'utf8'), meta)
      res.type('html').setHeader('Cache-Control', 'no-cache')
      return res.send(html)
    } catch (err) {
      console.error(err)
      return res.sendFile(indexPath)
    }
  })
  return frontendDir
}
