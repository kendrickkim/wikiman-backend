import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveFrontendDir() {
  const candidates = [
    process.env.FRONTEND_DIST,
    path.resolve(__dirname, '../public'),
    path.resolve(__dirname, '../../frontend/dist/spa')
  ].filter(Boolean)

  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || null
}

export function mountFrontend(app) {
  const frontendDir = resolveFrontendDir()
  if (!frontendDir) {
    app.get('/', (_req, res) => {
      res.status(503).type('text/plain').send(
        '프론트엔드 빌드가 없습니다.\n프론트 저장소에서 npm run build 한 뒤 dist/spa 내용을 backend/public 에 복사하세요.'
      )
    })
    return null
  }

  app.use(express.static(frontendDir, {
    index: 'index.html',
    fallthrough: true
  }))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api')) return next()
    return res.sendFile(path.join(frontendDir, 'index.html'))
  })
  return frontendDir
}
