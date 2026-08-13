import './loadEnv.js'
import express from 'express'
import cors from 'cors'
import { uploadsDir } from './db.js'
import { optionalAuth } from './middleware/auth.js'
import { mountFrontend, createHostApp } from './static.js'
import authRoutes from './routes/auth.js'
import categoryRoutes from './routes/categories.js'
import postRoutes from './routes/posts.js'
import uploadRoutes from './routes/uploads.js'
import plantumlRoutes from './routes/plantuml.js'
import settingsRoutes from './routes/settings.js'
import backupRoutes from './routes/backup.js'

const apiPort = Number(process.env.API_PORT || process.env.PORT || 85)
const hostPort = Number(process.env.HOST_PORT || 80)

const app = express()

app.use(cors())
app.use(express.json({ limit: '4mb' }))

app.use('/api', optionalAuth)
app.use('/api/auth', authRoutes)
app.use('/api/categories', categoryRoutes)
app.use('/api/posts', postRoutes)
app.use('/api/uploads', uploadRoutes)
app.use('/api/files', express.static(uploadsDir))
app.use('/api/plantuml', plantumlRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/backup', backupRoutes)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API를 찾을 수 없습니다.' })
})

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: '서버 오류가 발생했습니다.' })
})

app.listen(apiPort, () => {
  console.log(`Wikiman API on http://localhost:${apiPort}`)
})

// 호스팅 포트: 정적 프론트 + /api 를 API 포트로 프록시
if (Number.isFinite(hostPort) && hostPort > 0 && hostPort !== apiPort) {
  const hostApp = createHostApp({ apiPort })
  const frontendDir = mountFrontend(hostApp)
  hostApp.listen(hostPort, () => {
    console.log(`Wikiman host on http://localhost:${hostPort}`)
    if (frontendDir) {
      console.log(`Frontend hosted from ${frontendDir}`)
    } else {
      console.log('Frontend build not found. Copy frontend dist/spa into public/')
    }
  })
} else if (hostPort === apiPort) {
  // 같은 포트면 API 앱에 프론트도 붙입니다.
  const frontendDir = mountFrontend(app)
  if (frontendDir) {
    console.log(`Frontend hosted from ${frontendDir} (same port as API)`)
  }
}
