import './loadEnv.js'
import express from 'express'
import cors from 'cors'
import { uploadsDir } from './db.js'
import { optionalAuth } from './middleware/auth.js'
import { mountFrontend } from './static.js'
import authRoutes from './routes/auth.js'
import categoryRoutes from './routes/categories.js'
import postRoutes from './routes/posts.js'
import uploadRoutes from './routes/uploads.js'
import plantumlRoutes from './routes/plantuml.js'
import settingsRoutes from './routes/settings.js'

const app = express()
const port = Number(process.env.PORT || 3001)

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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API를 찾을 수 없습니다.' })
})

const frontendDir = mountFrontend(app)

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: '서버 오류가 발생했습니다.' })
})

app.listen(port, () => {
  console.log(`Wikiman listening on http://localhost:${port}`)
  if (frontendDir) {
    console.log(`Frontend hosted from ${frontendDir}`)
  } else {
    console.log('Frontend build not found. Copy frontend dist/spa into public/')
  }
})
